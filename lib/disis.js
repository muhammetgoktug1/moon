import { Monitor, Check, Group } from "./models.js";

// /api/disis/ozet — eski uptime uygulamasının /api/disis/ozet ucunun eşleniği.
// GET + `Authorization: Bearer <MOON_SERVIS_TOKEN>`; token env'de yoksa uç kapalıdır.
// Yanıt: toplam/up/down/bayat sayıları + monitör özet listesi (ad + grup + durum +
// son ölçüm). Gizlilik: URL, hata metni, IP, faz süreleri ve kimlik ALINMAZ.
//
// bayat: son ölçüm yok YA DA now - lastCheckedAt > interval + 5 dk (kontrolcü
// durduğunda/fena gecikince dış izleyici bunu görüp haber verir).

export const BAYAT_TOLERANS_SN = 300;

/** true = istek bu uca ait ve işlendi (yanıt verildi). */
export async function disisUcu(req, res) {
  if (req.url.split("?")[0] !== "/api/disis/ozet" || req.method !== "GET") return false;
  const token = process.env.MOON_SERVIS_TOKEN || "";
  if (!token) {
    json(res, 404, { hata: "servis ucu kapalı (MOON_SERVIS_TOKEN yok)" });
    return true;
  }
  const baslik = String(req.headers.authorization || "");
  if (baslik !== `Bearer ${token}`) {
    json(res, 401, { hata: "yetkisiz" });
    return true;
  }
  try {
    json(res, 200, await disisOzet());
  } catch (e) {
    json(res, 500, { hata: "iç hata" });
    console.error("[disis] ozet hatası:", e?.message || e);
  }
  return true;
}

function json(res, kod, govde) {
  res.writeHead(kod, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(govde));
}

export async function disisOzet() {
  const [monitors, groups] = await Promise.all([Monitor.find().sort({ order: 1 }).lean(), Group.find().lean()]);
  const grupAd = new Map(groups.map((g) => [String(g._id), g.name]));
  const simdi = Date.now();

  const liste = [];
  let up = 0;
  let down = 0;
  let bayat = 0;
  for (const m of monitors) {
    const son = await Check.findOne({ monitor: m._id }).sort({ at: -1 }).lean();
    const sonOlcum = son
      ? { at: new Date(son.at).getTime(), ms: son.ms ?? null, ok: !!son.ok, durum: son.ok ? "up" : "down" }
      : null;
    const interval = Number(m.interval) > 0 ? Number(m.interval) : 900;
    const gecMs = m.lastCheckedAt ? simdi - new Date(m.lastCheckedAt).getTime() : Infinity;
    // kapalı (enabled=false) monitör ölçülmediği için bayat sayılmaz — bilinçli olarak kapalı.
    const bayatMi = m.enabled === false ? false : !sonOlcum || gecMs > (interval + BAYAT_TOLERANS_SN) * 1000;
    if (m.status === "up") up++;
    else if (m.status === "down") down++;
    if (bayatMi) bayat++;
    liste.push({
      ad: m.name,
      grup: m.group ? grupAd.get(String(m.group)) || "" : "",
      durum: m.enabled === false ? "kapali" : m.status || "pending",
      bayat: bayatMi, // Faz 2b: panel köprüsü bayat İSİMLERİ bu bayraktan türetir (sayı tek başına yetmez)
      sonOlcum,
    });
  }

  return { toplam: monitors.length, up, down, bayat, monitorler: liste };
}
