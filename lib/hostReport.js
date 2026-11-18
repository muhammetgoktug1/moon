import { HostReport, HOST_TTL_DAYS } from "./models.js";

// POST /api/internal/host-report — host-agent.py'nin kaynak raporu yazdığı iç uç.
// Doğrulama: `Authorization: Bearer <MOON_SERVICE_TOKEN>` (dış özet ucuyla aynı token;
// token env'de yoksa uç KAPALI → 404). Gövde: { host: {...}, services: [...] }.
//
// Yazma kuralı (basit tutuldu): bir host adına tek belge (unique indeks + upsert).
// Aynı host adına <30 sn arayla gelen rapor YAZILMAZ (eski rapor kalır) ama istek
// yine 200 döner — ajan hata saymasın, 429/geri basamak yok.
//
// GİZLİLİK: belgeye yalnız doğrulanmış alanlar yazılır (beyaz liste); token, URL,
// IP, kullanıcı adı asla depolanmaz. `at` sunucu saatidir (istemci saatine güvenilmez).

export const HOST_REPORT_PATH = "/api/internal/host-report";
export const HOST_MIN_INTERVAL_S = 30; // aynı host adına minimum rapor aralığı
const BODY_LIMIT = 16_384;

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > limit) throw new Error("body too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const num = (v, { min = -Infinity, max = Infinity } = {}) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/** "var ama geçersiz"i sessiz düşürmeden 400'le: alan tanımlıysa num() sağlamalı. */
function strictNum(value, field, range) {
  if (value === undefined || value === null) return undefined;
  const parsed = num(value, range);
  if (parsed === undefined) throw new ValidationError(`${field} must be a number${range ? ` between ${range.min} and ${range.max}` : ""}.`);
  return parsed;
}

class ValidationError extends Error {}

/**
 * Rapor gövdesini doğrular ve depolanacak belgeyi üretir.
 * Dönüş: { error } (400) | { report }.
 */
export function parseHostReport(body) {
  try {
    return { report: parseOrThrow(body) };
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    throw e;
  }
}

function parseOrThrow(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Body must be a JSON object.");
  const rawHost = body.host;
  if (!rawHost || typeof rawHost !== "object") throw new ValidationError("host object is required.");

  const name = String(rawHost.name || "").trim();
  if (!name) throw new ValidationError("host.name is required.");
  if (name.length > 60) throw new ValidationError("host.name is too long (max 60).");

  const host = {
    name,
    cpuPct: strictNum(rawHost.cpuPct, "host.cpuPct", { min: 0, max: 100 }),
    memPct: strictNum(rawHost.memPct, "host.memPct", { min: 0, max: 100 }),
    memMB: strictNum(rawHost.memMB, "host.memMB", { min: 0 }),
    diskPct: strictNum(rawHost.diskPct, "host.diskPct", { min: 0, max: 100 }),
    diskGB: strictNum(rawHost.diskGB, "host.diskGB", { min: 0 }),
    uptimeH: strictNum(rawHost.uptimeH, "host.uptimeH", { min: 0 }),
    load: Array.isArray(rawHost.load)
      ? rawHost.load.slice(0, 3).map((n, i) => strictNum(n, `host.load[${i}]`, { min: 0 })).filter((n) => n !== undefined)
      : [],
  };

  let services = [];
  if (body.services !== undefined) {
    if (!Array.isArray(body.services)) throw new ValidationError("services must be an array.");
    if (body.services.length > 50) throw new ValidationError("too many services (max 50).");
    for (const s of body.services) {
      if (!s || typeof s !== "object") throw new ValidationError("each service must be an object.");
      const sname = String(s.name || "").trim();
      if (!sname) throw new ValidationError("service name is required.");
      if (sname.length > 60) throw new ValidationError("service name is too long (max 60).");
      if (s.status !== "up" && s.status !== "down") throw new ValidationError('service status must be "up" or "down".');
      services.push({
        name: sname,
        status: s.status,
        ms: strictNum(s.ms, "service ms", { min: 0 }),
        code: strictNum(s.code, "service code", { min: 0 }),
        detail: s.detail ? String(s.detail).slice(0, 300) : undefined,
      });
    }
  }

  return { at: new Date(), host, services };
}

/**
 * Raporu depolar. Aynı host adına son yazımdan <30 sn geçtiyse yazmaz
 * (stored:false). Dönüş: { stored, prev } — prev = değişen önceki belge
 * (Faz 2b: servis geçiş bildirimi bununla hesaplanır; ilk raporda null).
 */
export async function storeHostReport(report) {
  const existing = await HostReport.findOne({ "host.name": report.host.name }).lean();
  if (existing && Date.now() - new Date(existing.at).getTime() < HOST_MIN_INTERVAL_S * 1000) {
    return { stored: false, prev: existing };
  }
  await HostReport.updateOne(
    { "host.name": report.host.name },
    { $set: { at: report.at, host: report.host, services: report.services } },
    { upsert: true },
  );
  return { stored: true, prev: existing || null };
}

/** Panel (oturumlu) socket verisi — tam rapor, ad + sayılar. */
export async function hostsWire() {
  const docs = await HostReport.find().sort({ "host.name": 1 }).lean();
  return docs.map((d) => ({
    name: d.host.name,
    cpuPct: d.host.cpuPct ?? null,
    memPct: d.host.memPct ?? null,
    memMB: d.host.memMB ?? null,
    diskPct: d.host.diskPct ?? null,
    diskGB: d.host.diskGB ?? null,
    uptimeH: d.host.uptimeH ?? null,
    load: d.host.load || [],
    services: (d.services || []).map((s) => ({ name: s.name, status: s.status, ms: s.ms ?? null, code: s.code ?? null })),
    lastAlert: d.lastAlert ? { text: d.lastAlert.text, at: new Date(d.lastAlert.at).getTime() } : null,
    at: new Date(d.at).getTime(),
  }));
}

/** /api/external/summary hosts satırı — en küçük biçim (URL/port yok). Rapor yoksa null. */
export function hostSummaryRow(doc) {
  return {
    name: doc.host.name,
    cpuPct: doc.host.cpuPct ?? null,
    memPct: doc.host.memPct ?? null,
    diskPct: doc.host.diskPct ?? null,
    services: (doc.services || []).map((s) => ({ name: s.name, status: s.status })),
    at: new Date(doc.at).getTime(),
  };
}

export async function hostsSummary() {
  const docs = await HostReport.find().sort({ "host.name": 1 }).lean();
  return docs.length ? docs.map(hostSummaryRow) : null;
}

/**
 * HTTP uç işleyicisi. true = istek bu uca ait ve yanıtlandı.
 * onStored: yazma gerçekleştiğinde (panel yayını için) çağrılır.
 * onReport: yazma gerçekleştiğinde (prev, report) ile çağrılır — Faz 2b
 * servis geçiş bildirimi; hata bastırılır, rapor kabulünü bozmaz.
 */
export async function hostReportEndpoint(req, res, { onStored, onReport } = {}) {
  if (req.url.split("?")[0] !== HOST_REPORT_PATH || req.method !== "POST") return false;

  const token = process.env.MOON_SERVICE_TOKEN || "";
  if (!token) {
    json(res, 404, { error: "service endpoint disabled (MOON_SERVICE_TOKEN missing)" });
    return true;
  }
  if (String(req.headers.authorization || "") !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    json(res, 400, { error: "Body must be valid JSON." });
    return true;
  }

  const parsed = parseHostReport(body);
  if (parsed.error) {
    json(res, 400, { error: parsed.error });
    return true;
  }

  let stored = false;
  let prev = null;
  try {
    ({ stored, prev } = await storeHostReport(parsed.report));
  } catch (e) {
    console.error("[host-report] store error:", e?.message || e);
    json(res, 500, { error: "internal error" });
    return true;
  }
  if (stored && onReport) {
    // Faz 2b: servis geçiş bildirimi — hata rapor kabulünü bozmaz
    try {
      await onReport(prev, parsed.report);
    } catch (e) {
      console.error("[host-report] alert dispatch error:", e?.message || e);
    }
  }
  if (stored && onStored) await onStored();
  json(res, 200, { ok: true, stored });
  return true;
}

export { HOST_TTL_DAYS };
