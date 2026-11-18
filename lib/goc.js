import { DatabaseSync } from "node:sqlite";
import mongoose from "mongoose";
import { monitorSchema, checkSchema, groupSchema } from "./models.js";

// Göç: bizim uptime SQLite'ından Moon MongoDB'sine veri ithali.
// KAYNAK daima bir KOPI veritabanıdır; canlı uptime DB'sine asla bağlanılmaz.
// İdempotent: aynı kaynakla ikinci koşu 0 yeni kayıt ekler.

export const GUN = 30; // Moon check TTL 30 gün — pencere bununla uyumlu

function gecerliUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  return undefined;
}

function tarih(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function ozetHata(v) {
  const s = String(v || "").trim();
  return s ? s.slice(0, 200) : "";
}

// Kaynak SQLite'ı okur. Yalnızca son `gun` günün checklog satırları alınır
// (Mongo TTL daha eskisini zaten silerdi).
export function kaynakOku(dosya, gun = GUN) {
  const db = new DatabaseSync(dosya, { readOnly: true });
  try {
    const sinir = new Date(Date.now() - gun * 86_400_000).toISOString();
    const monitorler = db
      .prepare(
        `SELECT id, name, url, method, grup, sira, basliklar, govde, ssl_bitis
         FROM monitors WHERE enabled = 1 ORDER BY sira, name`,
      )
      .all();
    const checkler = db
      .prepare(
        `SELECT monitor_id, status, error_kind, response_time, status_code, reason, checked_at,
                dns_ms, tcp_ms, tls_ms, ttfb_ms, ip
         FROM checklogs WHERE checked_at >= ? ORDER BY checked_at`,
      )
      .all(sinir);

    const atlanan = [];
    const kayitlar = [];
    for (const m of monitorler) {
      const url = gecerliUrl(m.url);
      if (!url) {
        atlanan.push({ ad: m.name, url: m.url, neden: "geçersiz URL" });
        continue;
      }
      kayitlar.push({
        eskiId: m.id,
        name: String(m.name || "").trim().slice(0, 60) || new URL(url).host,
        url,
        method: m.method === "POST" ? "POST" : "GET",
        grup: String(m.grup || "").trim() || null,
        basliklar: (() => {
          try {
            const d = JSON.parse(m.basliklar || "[]");
            return Array.isArray(d) ? d.filter((h) => h && h.key) : [];
          } catch {
            return [];
          }
        })(),
        govde: String(m.govde || ""),
        certBitis: tarih(m.ssl_bitis),
      });
    }

    const gecerliId = new Set(kayitlar.map((m) => m.eskiId));
    const satirlar = checkler
      .filter((c) => gecerliId.has(c.monitor_id))
      .map((c) => {
        const at = tarih(c.checked_at);
        if (!at) return null;
        const dns = Number.isFinite(c.dns_ms) ? c.dns_ms : null;
        const tcp = Number.isFinite(c.tcp_ms) ? c.tcp_ms : null;
        const tls = Number.isFinite(c.tls_ms) ? c.tls_ms : null;
        const ttfb = Number.isFinite(c.ttfb_ms) ? c.ttfb_ms : null;
        const fazlar =
          ttfb != null && dns != null && tcp != null && tls != null
            ? { redirect: 0, dns: Math.round(dns), tcp: Math.round(tcp), tls: Math.round(tls), server: Math.max(0, Math.round(ttfb - dns - tcp - tls)) }
            : undefined;
        return {
          eskiMonitorId: c.monitor_id,
          at,
          ms: Number.isFinite(c.response_time) ? Math.round(c.response_time) : ttfb != null ? Math.round(ttfb) : 0,
          status: Number.isFinite(c.status_code) ? c.status_code : 0,
          ok: c.status === "up",
          error: ozetHata(c.error_kind) || ozetHata(c.reason),
          ip: String(c.ip || ""),
          phases: fazlar,
        };
      })
      .filter(Boolean);

    return { monitorler: kayitlar, checkler: satirlar, atlanan };
  } finally {
    db.close();
  }
}

// Moon MongoDB'sine yazar. Kimlik belirleme:
//   monitör → URL eşleşmesi (varsa güncellemez, yalnızca eşler),
//   check   → (monitor, at) ikilisi (yoksa ekler).
// `kurut` true ise Moon'un monitors/checks/groups koleksiyonları önce temizlenir.
// Kendi mongoose bağlantısını açıp kapatır — çağıranın (ör. testlerin)
// varsayılan bağlantısına dokunmaz.
export async function hedefeYaz(mongoUri, veri, { kurut = false } = {}) {
  const conn = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const Monitor = conn.model("Monitor", monitorSchema);
    const Check = conn.model("Check", checkSchema);
    const Group = conn.model("Group", groupSchema);
    if (kurut) {
      await Promise.all([Monitor.deleteMany({}), Check.deleteMany({}), Group.deleteMany({})]);
    }

    // gruplar (Moon tab'ları) ada göre
    const gruplar = new Map();
    let grupYeni = 0;
    for (const ad of [...new Set(veri.monitorler.map((m) => m.grup).filter(Boolean))]) {
      let g = await Group.findOne({ name: ad }).lean();
      if (!g) {
        g = await Group.create({ name: ad.slice(0, 40), order: await Group.countDocuments() });
        grupYeni++;
      }
      gruplar.set(ad, String(g._id));
    }

    // monitörler: URL'e göre eşle, eksikleri sırasıyla ekle
    const idEsleme = new Map(); // eskiId -> yeni _id
    let monitorYeni = 0;
    let sira = await Monitor.countDocuments();
    for (const m of veri.monitorler) {
      let doc = await Monitor.findOne({ url: m.url }).lean();
      if (!doc) {
        doc = await Monitor.create({
          name: m.name,
          group: m.grup ? gruplar.get(m.grup) || null : null,
          order: sira++,
          url: m.url,
          method: m.method,
          headers: m.basliklar.map((h) => ({ key: String(h.key).slice(0, 120), value: String(h.value || "") })),
          body: m.govde,
          ...(m.certBitis ? { cert: { subject: "", issuer: "", issued: m.certBitis, expires: m.certBitis } } : {}),
        });
        monitorYeni++;
      }
      idEsleme.set(m.eskiId, String(doc._id));
    }

    // checkler: (monitor, at) anahtarıyla; yalnızca eksikler eklenir
    const monitorIdleri = [...new Set(idEsleme.values())];
    const secim = monitorIdleri.length ? { monitor: { $in: monitorIdleri } } : { monitor: { $exists: true } };
    const mevcut = new Set();
    for await (const c of Check.find(secim, { monitor: 1, at: 1 }).lean()) {
      mevcut.add(`${c.monitor}:${new Date(c.at).getTime()}`);
    }
    const eklenecek = [];
    const gorulen = new Set();
    for (const c of veri.checkler) {
      const yeniId = idEsleme.get(c.eskiMonitorId);
      if (!yeniId) continue;
      const anahtar = `${yeniId}:${c.at.getTime()}`;
      if (mevcut.has(anahtar) || gorulen.has(anahtar)) continue; // idempotent + kaynak içi mükerrer
      gorulen.add(anahtar);
      eklenecek.push({ monitor: yeniId, at: c.at, ms: c.ms, status: c.status, ok: c.ok, error: c.error, ip: c.ip, ...(c.phases ? { phases: c.phases } : {}) });
    }
    const PARTI = 2000;
    for (let i = 0; i < eklenecek.length; i += PARTI) {
      await Check.insertMany(eklenecek.slice(i, i + PARTI), { ordered: false });
    }

    return {
      monitorlar: { toplam: veri.monitorler.length, yeni: monitorYeni },
      checkler: { toplam: veri.checkler.length, yeni: eklenecek.length },
      gruplar: { yeni: grupYeni },
      atlanan: veri.atlanan,
    };
  } finally {
    await conn.close();
  }
}
