import { readFileSync } from "node:fs";
import { Monitor, Group } from "./models.js";

// Bildirim — eski uptime uygulamasının web/lib bildirim deseni birebir:
//   conf biçimi panel/uptime-ozel uptime-notify.conf.json ile AYNEN:
//   { whatsapp: { apiUrl, apiKey, session, chatId } }
//   gönderim: POST apiUrl, X-API-Key başlığı, {session, chatId, text} gövdesi,
//   15 sn zaman aşımı, hatalar BASTIRILIR (bildirim ölçümü bloklamaz).
// Gruplama (Faz 2a brief'i): aynı grupta 5 dk penceresine düşen olaylar TEK
// mesajda gider; grupsuz monitör olayları ve SSL uyarıları bekletmeden gider.
// Mesaj biçimleri panel olay_metinleri ile bayt bayt aynıdır (ÜRÜN DİLİ: Türkçe).

export const NOTIFY_WINDOW_MS = 5 * 60_000;

export function loadConf(path) {
  const file = path || process.env.MOON_NOTIFY_CONF || "/data/bildirim.conf.json";
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { whatsapp: null };
  }
}

/**
 * Köprüye gönderir; { sent, status } döner (status = HTTP kodu, gidemediyse 0).
 * Başarıda teslim kodu loglanır (canlı kanıt: 202). Hatalar BASTIRILIR.
 */
export async function postWhatsapp(text, conf) {
  const wa = (conf || {}).whatsapp;
  if (!wa || !wa.apiUrl) return { sent: false, status: 0 };
  try {
    const res = await fetch(wa.apiUrl, {
      method: "POST",
      // UA şart: köprü Cloudflare arkasında — python-urllib/undici imzası 1010 ile reddediliyor
      headers: { "Content-Type": "application/json", "X-API-Key": wa.apiKey, "User-Agent": "HermesPanel-Uptime/1.0" },
      body: JSON.stringify({ session: wa.session || "default", chatId: wa.chatId, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`[notify] WhatsApp delivered (HTTP ${res.status})`);
    return { sent: true, status: res.status };
  } catch (e) {
    console.error(`[notify] WhatsApp send failed: ${e?.message || e}`);
    return { sent: false, status: 0 };
  }
}

export async function sendWhatsapp(text, conf) {
  return (await postWhatsapp(text, conf)).sent;
}

// ——— olay metinleri (panel olay_metinleri birebir: gruplu bildirim kuralları) ———
// olaylar/events: ["ssl", metin] | ["down", {name, group, reason, ts}] | ["up", {name, group, ts, ms}]
export function eventTexts(events, sizeByGroup, downByGroup) {
  const count = {};
  for (const [kind, o] of events) {
    if ((kind === "down" || kind === "up") && o?.group) count[`${kind}|${o.group}`] = (count[`${kind}|${o.group}`] || 0) + 1;
  }
  const written = new Set();
  const out = [];
  for (const [kind, o] of events) {
    if (kind === "ssl") {
      out.push(o);
      continue;
    }
    const g = o?.group;
    if (g && (count[`${kind}|${g}`] || 0) >= 2) {
      const key = `${kind}|${g}`;
      if (written.has(key)) continue;
      written.add(key);
      const n = sizeByGroup.get(g) || count[key];
      if (kind === "down") {
        const down = downByGroup.get(g) || [];
        if (n && down.length >= n) out.push(`🔴 ${g} grubu: ${n}/${n} site kapalı (ortak uygulama) — ${o.reason} (${o.ts})`);
        else out.push(`🔴 ${g} grubu: ${down.length}/${n} site kapalı: ${down.join(", ")} — ${o.reason} (${o.ts})`);
      } else {
        const k = count[key];
        const names = events.filter(([t2, x]) => t2 === "up" && x?.group === g).map(([, x]) => x.name);
        if (n && k >= n) out.push(`🟢 ${g} grubu: ${k}/${n} site tekrar çalışıyor (${o.ts})`);
        else out.push(`🟢 ${g} grubu: ${k}/${n} site tekrar çalışıyor: ${names.join(", ")} (${o.ts})`);
      }
    } else if (kind === "down") {
      out.push(`🔴 DOWN: ${o.name} — ${o.reason} (${o.ts})`);
    } else {
      out.push(`🟢 UP: ${o.name} tekrar çalışıyor (${o.ts}, ${o.ms} ms)`);
    }
  }
  return out;
}

// ——— grup istatistikleri (panel sweep sonundaki grup_boyut/grup_kapali) ———
export async function groupStats() {
  const groups = await Group.find().lean();
  const names = new Map(groups.map((g) => [String(g._id), g.name]));
  const size = new Map();
  const down = new Map();
  for (const m of await Monitor.find({ enabled: { $ne: false } }).lean()) {
    if (!m.group) continue;
    const name = names.get(String(m.group));
    if (!name) continue;
    size.set(name, (size.get(name) || 0) + 1);
    if (m.status === "down") {
      if (!down.has(name)) down.set(name, []);
      down.get(name).push(m.name);
    }
  }
  return { size, down };
}

// ——— 5 dk gruplama kuyruğu ———
// Aynı grubun olayları ilk olaydan itibaren `windowMs` içinde toplanır; pencere
// kapanınca TEK mesaj (eventTexts ile) gönderilir. Grupsuz/SSL olayları hemen gider.
// `send` ve `stats` enjekte edilebilir (test). `timer` testlerde kısa
// pencere içindir; üretimde setTimeout kullanılır.
export class NotifyQueue {
  constructor({ windowMs = NOTIFY_WINDOW_MS, send = null, stats = null } = {}) {
    this.windowMs = windowMs;
    this.send =
      send ||
      (async (text) => {
        console.log(text);
        await sendWhatsapp(text, loadConf());
      });
    this.stats = stats || groupStats;
    this.pending = new Map(); // grup adı → { events, timer }
    this.timers = new Set(); // timer'ları iptal için
  }

  async add(event) {
    const [kind, o] = event;
    if (kind === "ssl" || !(kind === "down" || kind === "up") || !o?.group) {
      const [text] = eventTexts([event], new Map(), new Map());
      if (text) await this.send(text);
      return;
    }
    const g = o.group;
    let bucket = this.pending.get(g);
    if (!bucket) {
      bucket = { events: [], timer: null };
      this.pending.set(g, bucket);
      bucket.timer = setTimeout(() => this.flush(g), this.windowMs);
      if (bucket.timer.unref) bucket.timer.unref();
    }
    bucket.events.push(event);
  }

  async flush(g) {
    const bucket = this.pending.get(g);
    if (!bucket) return;
    this.pending.delete(g);
    try {
      const { size, down } = await this.stats();
      for (const text of eventTexts(bucket.events, size, down)) await this.send(text);
    } catch (e) {
      console.error(`[notify] group message send failed (${g}):`, e?.message || e);
    }
  }

  // test/bitiş yardımı: bekleyen kovaları bekletmeden boşalt
  async flushAll() {
    for (const g of [...this.pending.keys()]) await this.flush(g);
  }
}
