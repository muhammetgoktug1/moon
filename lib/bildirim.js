import { readFileSync } from "node:fs";
import { Monitor, Group } from "./models.js";

// Bildirim — eski uptime uygulamasının web/lib bildirim deseni birebir:
//   conf biçimi panel/uptime-ozel uptime-notify.conf.json ile AYNEN:
//   { whatsapp: { apiUrl, apiKey, session, chatId } }
//   gönderim: POST apiUrl, X-API-Key başlığı, {session, chatId, text} gövdesi,
//   15 sn zaman aşımı, hatalar BASTIRILIR (bildirim ölçümü bloklamaz).
// Gruplama (Faz 2a brief'i): aynı grupta 5 dk penceresine düşen olaylar TEK
// mesajda gider; grupsuz monitör olayları ve SSL uyarıları bekletmeden gider.
// Mesaj biçimleri panel olay_metinleri ile bayt bayt aynıdır.

export const BILDIRIM_PENCERE_MS = 5 * 60_000;

export function confYukle(yol) {
  const dosya = yol || process.env.MOON_BILDIRIM_CONF || "/data/bildirim.conf.json";
  try {
    return JSON.parse(readFileSync(dosya, "utf8"));
  } catch {
    return { whatsapp: null };
  }
}

export async function whatsappGonder(metin, conf) {
  const wa = (conf || {}).whatsapp;
  if (!wa || !wa.apiUrl) return false;
  try {
    const res = await fetch(wa.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": wa.apiKey },
      body: JSON.stringify({ session: wa.session || "default", chatId: wa.chatId, text: metin }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (e) {
    console.error(`[bildirim] WhatsApp gönderilemedi: ${e?.message || e}`);
    return false;
  }
}

// ——— olay metinleri (panel olay_metinleri birebir: gruplu bildirim kuralları) ———
// olaylar: ["ssl", metin] | ["down", {name, grup, reason, ts}] | ["up", {name, grup, ts, ms}]
export function olayMetinleri(olaylar, grupBoyut, grupKapali) {
  const sayac = {};
  for (const [tur, o] of olaylar) {
    if ((tur === "down" || tur === "up") && o?.grup) sayac[`${tur}|${o.grup}`] = (sayac[`${tur}|${o.grup}`] || 0) + 1;
  }
  const yazildi = new Set();
  const cikti = [];
  for (const [tur, o] of olaylar) {
    if (tur === "ssl") {
      cikti.push(o);
      continue;
    }
    const g = o?.grup;
    if (g && (sayac[`${tur}|${g}`] || 0) >= 2) {
      const anahtar = `${tur}|${g}`;
      if (yazildi.has(anahtar)) continue;
      yazildi.add(anahtar);
      const n = grupBoyut.get(g) || sayac[anahtar];
      if (tur === "down") {
        const kapali = grupKapali.get(g) || [];
        if (n && kapali.length >= n) cikti.push(`🔴 ${g} grubu: ${n}/${n} site kapalı (ortak uygulama) — ${o.reason} (${o.ts})`);
        else cikti.push(`🔴 ${g} grubu: ${kapali.length}/${n} site kapalı: ${kapali.join(", ")} — ${o.reason} (${o.ts})`);
      } else {
        const k = sayac[anahtar];
        const adlar = olaylar.filter(([t2, x]) => t2 === "up" && x?.grup === g).map(([, x]) => x.name);
        if (n && k >= n) cikti.push(`🟢 ${g} grubu: ${k}/${n} site tekrar çalışıyor (${o.ts})`);
        else cikti.push(`🟢 ${g} grubu: ${k}/${n} site tekrar çalışıyor: ${adlar.join(", ")} (${o.ts})`);
      }
    } else if (tur === "down") {
      cikti.push(`🔴 DOWN: ${o.name} — ${o.reason} (${o.ts})`);
    } else {
      cikti.push(`🟢 UP: ${o.name} tekrar çalışıyor (${o.ts}, ${o.ms} ms)`);
    }
  }
  return cikti;
}

// ——— grup istatistikleri (panel sweep sonundaki grup_boyut/grup_kapali) ———
export async function grupBilgisi() {
  const gruplar = await Group.find().lean();
  const adlar = new Map(gruplar.map((g) => [String(g._id), g.name]));
  const boyut = new Map();
  const kapali = new Map();
  for (const m of await Monitor.find({ enabled: { $ne: false } }).lean()) {
    if (!m.group) continue;
    const ad = adlar.get(String(m.group));
    if (!ad) continue;
    boyut.set(ad, (boyut.get(ad) || 0) + 1);
    if (m.status === "down") {
      if (!kapali.has(ad)) kapali.set(ad, []);
      kapali.get(ad).push(m.name);
    }
  }
  return { boyut, kapali };
}

// ——— 5 dk gruplama kuyruğu ———
// Aynı grubun olayları ilk olaydan itibaren `pencereMs` içinde toplanır; pencere
// kapanınca TEK mesaj (olayMetinleri ile) gönderilir. Grupsuz/SSL olayları hemen gider.
// `gonder` ve `bilgilendir` enjekte edilebilir (test). `zamanlayici` testlerde kısa
// pencere içindir; üretimde setTimeout kullanılır.
export class BildirimKuyrugu {
  constructor({ pencereMs = BILDIRIM_PENCERE_MS, gonder = null, bilgilendir = null } = {}) {
    this.pencereMs = pencereMs;
    this.gonder =
      gonder ||
      (async (metin) => {
        console.log(metin);
        await whatsappGonder(metin, confYukle());
      });
    this.bilgilendir = bilgilendir || grupBilgisi;
    this.bekleyen = new Map(); // grup adı → { olaylar, zamanlayici }
    this.kapali = new Set(); // setimeleri iptal için
  }

  async ekle(olay) {
    const [tur, o] = olay;
    if (tur === "ssl" || !(tur === "down" || tur === "up") || !o?.grup) {
      const [metin] = olayMetinleri([olay], new Map(), new Map());
      if (metin) await this.gonder(metin);
      return;
    }
    const g = o.grup;
    let kova = this.bekleyen.get(g);
    if (!kova) {
      kova = { olaylar: [], zamanlayici: null };
      this.bekleyen.set(g, kova);
      kova.zamanlayici = setTimeout(() => this.bosalt(g), this.pencereMs);
      if (kova.zamanlayici.unref) kova.zamanlayici.unref();
    }
    kova.olaylar.push(olay);
  }

  async bosalt(g) {
    const kova = this.bekleyen.get(g);
    if (!kova) return;
    this.bekleyen.delete(g);
    try {
      const { boyut, kapali } = await this.bilgilendir();
      for (const metin of olayMetinleri(kova.olaylar, boyut, kapali)) await this.gonder(metin);
    } catch (e) {
      console.error(`[bildirim] grup mesajı gönderilemedi (${g}):`, e?.message || e);
    }
  }

  // test/bitiş yardımı: bekleyen kovaları bekletmeden boşalt
  async hepsiniBosalt() {
    for (const g of [...this.bekleyen.keys()]) await this.bosalt(g);
  }
}
