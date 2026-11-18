import { Monitor, Check, Group } from "./models.js";

// /api/external/summary — eski uptime uygulamasının /api/disis/ozet ucunun eşleniği.
// GET + `Authorization: Bearer <MOON_...N>`; token env'de yoksa uç kapalıdır.
// Yanıt: total/up/down/stale sayıları + monitör özet listesi (name + group + status +
// son ölçüm). Gizlilik: URL, hata metni, IP, faz süreleri ve kimlik ALINMAZ.
//
// stale: son ölçüm yok YA DA now - lastCheckedAt > interval + 5 dk (kontrolcü
// durduğunda/fena gecikince dış izleyici bunu görüp haber verir).

export const STALE_TOLERANCE_S = 300;

/** true = istek bu uca ait ve işlendi (yanıt verildi). */
export async function externalEndpoint(req, res) {
  const path = req.url.split("?")[0];
  if (path !== "/api/external/summary" || req.method !== "GET") return false;
  const token = process.env.MOON_SERVICE_TOKEN || "";
  if (!token) {
    json(res, 404, { error: "service endpoint disabled (MOON_SERVICE_TOKEN missing)" });
    return true;
  }
  const header = String(req.headers.authorization || "");
  if (header !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  try {
    json(res, 200, await externalSummary());
  } catch (e) {
    json(res, 500, { error: "internal error" });
    console.error("[external] summary error:", e?.message || e);
  }
  return true;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function externalSummary() {
  const [monitors, groups] = await Promise.all([Monitor.find().sort({ order: 1 }).lean(), Group.find().lean()]);
  const groupName = new Map(groups.map((g) => [String(g._id), g.name]));
  const now = Date.now();

  const list = [];
  let up = 0;
  let down = 0;
  let stale = 0;
  for (const m of monitors) {
    const last = await Check.findOne({ monitor: m._id }).sort({ at: -1 }).lean();
    const lastCheck = last
      ? { at: new Date(last.at).getTime(), ms: last.ms ?? null, ok: !!last.ok, status: last.ok ? "up" : "down" }
      : null;
    const interval = Number(m.interval) > 0 ? Number(m.interval) : 900;
    const elapsedMs = m.lastCheckedAt ? now - new Date(m.lastCheckedAt).getTime() : Infinity;
    // kapalı (enabled=false) monitör ölçülmediği için stale sayılmaz — bilinçli olarak kapalı.
    const isStale = m.enabled === false ? false : !lastCheck || elapsedMs > (interval + STALE_TOLERANCE_S) * 1000;
    if (m.status === "up") up++;
    else if (m.status === "down") down++;
    if (isStale) stale++;
    list.push({
      name: m.name,
      group: m.group ? groupName.get(String(m.group)) || "" : "",
      status: m.enabled === false ? "disabled" : m.status || "pending",
      stale: isStale, // Faz 2b: panel köprüsü bayat İSİMLERİ bu bayraktan türetir (sayı tek başına yetmez)
      lastCheck,
    });
  }

  return { total: monitors.length, up, down, stale, monitors: list };
}
