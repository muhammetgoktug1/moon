import { DatabaseSync } from "node:sqlite";
import mongoose from "mongoose";
import { monitorSchema, checkSchema, groupSchema } from "./models.js";

// Göç: bizim uptime SQLite'ından Moon MongoDB'sine veri ithali.
// KAYNAK daima bir KOPI veritabanıdır; canlı uptime DB'sine asla bağlanılmaz.
// İdempotent: aynı kaynakla ikinci koşu 0 yeni kayıt ekler.
// NOT: SQLite kolon adları (grup, basliklar, govde, ssl_bitis, beklenen_kod…)
// ESKİ UYGULAMANIN veri şemasıdır — değiştirilemez; yalnız bizim JS
// tanımlayıcıları İngilizcedir.

export const DAYS = 30; // Moon check TTL 30 gün — pencere bununla uyumlu

function validUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  return undefined;
}

function toDate(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function errorBrief(v) {
  const s = String(v || "").trim();
  return s ? s.slice(0, 200) : "";
}

// Kaynak SQLite'ı okur. Yalnızca son `days` günün checklog satırları alınır
// (Mongo TTL daha eskisini zaten silerdi).
// Faz 2a ikinci geçiş: keyword, beklenen_kod, enabled, notes,
// consecutive_failures, interval ve durum alanları da okunur ve hedefe yazılır.
export function readSource(file, days = DAYS) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const monitors = db
      .prepare(
        `SELECT id, name, url, method, grup, sira, basliklar, govde, ssl_bitis,
                interval, keyword, beklenen_kod, enabled, notes, status, consecutive_failures
         FROM monitors ORDER BY sira, name`,
      )
      .all();
    const checks = db
      .prepare(
        `SELECT monitor_id, status, error_kind, response_time, status_code, reason, checked_at,
                dns_ms, tcp_ms, tls_ms, ttfb_ms, ip, confirmed
         FROM checklogs WHERE checked_at >= ? ORDER BY checked_at`,
      )
      .all(cutoff);

    const skipped = [];
    const records = [];
    for (const m of monitors) {
      const url = validUrl(m.url);
      if (!url) {
        skipped.push({ name: m.name, url: m.url, reason: "geçersiz URL" });
        continue;
      }
      records.push({
        legacyId: m.id,
        name: String(m.name || "").trim().slice(0, 60) || new URL(url).host,
        url,
        method: m.method === "POST" ? "POST" : "GET",
        group: String(m.grup || "").trim() || null,
        headers: (() => {
          try {
            const d = JSON.parse(m.basliklar || "[]");
            return Array.isArray(d) ? d.filter((h) => h && h.key) : [];
          } catch {
            return [];
          }
        })(),
        body: String(m.govde || ""),
        certExpires: toDate(m.ssl_bitis),
        // --- ikinci geçiş alanları ---
        interval: Number.isFinite(Number(m.interval)) && Number(m.interval) >= 30 ? Math.round(Number(m.interval)) : 900,
        keyword: String(m.keyword || "").slice(0, 200),
        expectedStatus: m.beklenen_kod != null && Number.isFinite(Number(m.beklenen_kod)) ? Number(m.beklenen_kod) : null,
        enabled: m.enabled === 1,
        notes: String(m.notes || "").slice(0, 2000),
        consecutiveFailures: Number.isFinite(Number(m.consecutive_failures)) ? Number(m.consecutive_failures) : 0,
        status: m.status === "up" || m.status === "down" ? m.status : "pending",
      });
    }

    const validIds = new Set(records.map((m) => m.legacyId));
    const rows = checks
      .filter((c) => validIds.has(c.monitor_id))
      .map((c) => {
        const at = toDate(c.checked_at);
        if (!at) return null;
        const dns = Number.isFinite(c.dns_ms) ? c.dns_ms : null;
        const tcp = Number.isFinite(c.tcp_ms) ? c.tcp_ms : null;
        const tls = Number.isFinite(c.tls_ms) ? c.tls_ms : null;
        const ttfb = Number.isFinite(c.ttfb_ms) ? c.ttfb_ms : null;
        const phases =
          ttfb != null && dns != null && tcp != null && tls != null
            ? { redirect: 0, dns: Math.round(dns), tcp: Math.round(tcp), tls: Math.round(tls), server: Math.max(0, Math.round(ttfb - dns - tcp - tls)) }
            : undefined;
        return {
          legacyMonitorId: c.monitor_id,
          at,
          ms: Number.isFinite(c.response_time) ? Math.round(c.response_time) : ttfb != null ? Math.round(ttfb) : 0,
          status: Number.isFinite(c.status_code) ? c.status_code : 0,
          ok: c.status === "up",
          confirmed: c.confirmed !== 0,
          error: errorBrief(c.error_kind) || errorBrief(c.reason),
          ip: String(c.ip || ""),
          phases,
        };
      })
      .filter(Boolean);

    return { monitors: records, checks: rows, skipped };
  } finally {
    db.close();
  }
}

// Moon MongoDB'sine yazar. Kimlik belirleme:
//   monitör → URL eşleşmesi (varsa güncellemez, yalnızca eşler),
//   check   → (monitor, at) ikilisi (yoksa ekler).
// `wipe` true ise Moon'un monitors/checks/groups koleksiyonları önce temizlenir.
// Kendi mongoose bağlantısını açıp kapatır — çağıranın (ör. testlerin)
// varsayılan bağlantısına dokunmaz.
export async function writeToTarget(mongoUri, data, { wipe = false } = {}) {
  const conn = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const Monitor = conn.model("Monitor", monitorSchema);
    const Check = conn.model("Check", checkSchema);
    const Group = conn.model("Group", groupSchema);
    if (wipe) {
      await Promise.all([Monitor.deleteMany({}), Check.deleteMany({}), Group.deleteMany({})]);
    }

    // gruplar (Moon tab'ları) ada göre
    const groups = new Map();
    let groupsNew = 0;
    for (const name of [...new Set(data.monitors.map((m) => m.group).filter(Boolean))]) {
      let g = await Group.findOne({ name }).lean();
      if (!g) {
        g = await Group.create({ name: name.slice(0, 40), order: await Group.countDocuments() });
        groupsNew++;
      }
      groups.set(name, String(g._id));
    }

    // monitörler: URL'e göre eşle, eksikleri sırasıyla ekle; eşleşenlerin
    // ikinci geçiş alanlarını GÜNCELLE (keyword/expectedStatus/enabled/notes/
    // consecutiveFailures/interval/durum) — idempotent, zar vermez.
    const secondPassFields = (m) => ({
      interval: m.interval,
      keyword: m.keyword,
      expectedStatus: m.expectedStatus,
      enabled: m.enabled,
      notes: m.notes,
      consecutiveFailures: m.consecutiveFailures,
      status: m.status,
    });
    const idMap = new Map(); // legacyId -> yeni _id
    let monitorsNew = 0;
    let monitorsUpdated = 0;
    let order = await Monitor.countDocuments();
    for (const m of data.monitors) {
      let doc = await Monitor.findOne({ url: m.url }).lean();
      if (!doc) {
        doc = await Monitor.create({
          name: m.name,
          group: m.group ? groups.get(m.group) || null : null,
          order: order++,
          url: m.url,
          method: m.method,
          headers: m.headers.map((h) => ({ key: String(h.key).slice(0, 120), value: String(h.value || "") })),
          body: m.body,
          ...(m.certExpires ? { cert: { subject: "", issuer: "", issued: m.certExpires, expires: m.certExpires } } : {}),
          ...secondPassFields(m),
        });
        monitorsNew++;
      } else {
        await Monitor.updateOne({ _id: doc._id }, { $set: secondPassFields(m) });
        monitorsUpdated++;
      }
      idMap.set(m.legacyId, String(doc._id));
    }

    // checkler: (monitor, at) anahtarıyla; yalnızca eksikler eklenir
    const monitorIds = [...new Set(idMap.values())];
    const query = monitorIds.length ? { monitor: { $in: monitorIds } } : { monitor: { $exists: true } };
    const existing = new Set();
    for await (const c of Check.find(query, { monitor: 1, at: 1 }).lean()) {
      existing.add(`${c.monitor}:${new Date(c.at).getTime()}`);
    }
    const toInsert = [];
    const seen = new Set();
    for (const c of data.checks) {
      const newId = idMap.get(c.legacyMonitorId);
      if (!newId) continue;
      const key = `${newId}:${c.at.getTime()}`;
      if (existing.has(key) || seen.has(key)) continue; // idempotent + kaynak içi mükerrer
      seen.add(key);
      toInsert.push({ monitor: newId, at: c.at, ms: c.ms, status: c.status, ok: c.ok, confirmed: c.confirmed, error: c.error, ip: c.ip, ...(c.phases ? { phases: c.phases } : {}) });
    }
    const BATCH = 2000;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      await Check.insertMany(toInsert.slice(i, i + BATCH), { ordered: false });
    }

    return {
      monitors: { total: data.monitors.length, new: monitorsNew, updated: monitorsUpdated },
      checks: { total: data.checks.length, new: toInsert.length },
      groups: { new: groupsNew },
      skipped: data.skipped,
    };
  } finally {
    await conn.close();
  }
}
