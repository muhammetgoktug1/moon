import { HostReport } from "./models.js";
import { loadConf, postWhatsapp } from "./notify.js";
import { shouldNotify } from "./notifySettings.js";
import { hostServiceSettings } from "./notifyStore.js";

// Faz 2b: host-servis WhatsApp bildirimleri — host-agent raporlarındaki servis
// DURUM DEĞİŞİMLERİ (up→down = DÜŞTÜ, down→up = TOPARLANDI) ve rapor kesilmesi.
// Kurallar (brief 18.11):
//   • yeni eklenen servis İLK raporda down ise → DÜŞTÜ sayılır (uyarı gider)
//   • rapordan ÇIKAN servis için mesaj YOK (sessiz kural)
//   • aynı raporda çoklu düşüş TEK mesajda toplanır ("2 servis düştü: a, b")
//   • geçişler SSL gibi ANINDA gönderilir — 5 dk gruplama penceresine girmez
//   • host rapor göndermezse: 3 ardışık eksik rapor (15 dk) sonunda TEK
//     "rapor yok" uyarısı (tekrar etmez); rapor dönünce toparlanma mesajı
//   • servis başına susturma: host-agent `alerts: false` VEYA panelden kapatılan
//     bildirim ayarı (hostServiceSettings; kanal + düştü/toparlandı olayı) →
//     o servis için mesaj yok; durum yine kaydedilir/gösterilir
// Mesaj dili TÜRKÇE (ürün dili); host/servis adları VERİDEN (hostReports) —
// repoda asla geçmez. Gönderim lib/notify köprüsüyle (hatalar bastırılır).

export const HOST_REPORT_INTERVAL_MS = 5 * 60_000; // host-agent cron */5
export const MISSING_REPORTS = 3; // 3 ardışık eksik rapor = uyarı eşiği
export const MISSING_ALERT_AFTER_MS = MISSING_REPORTS * HOST_REPORT_INTERVAL_MS; // 15 dk

const isoPanel = (d) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
const shortDetail = (d) => String(d || "").replace(/\s+/g, " ").trim().slice(0, 80).trim();

/**
 * Önceki ve yeni raporun servis listelerinden durum geçişleri (SAF fonksiyon).
 * prev/next: [{ name, status, ms?, detail? }]
 * Dönüş: { downs: [{name, detail}], ups: [{name, ms}], removed: [name] }
 *   • önceki raporda olmayan down servis → DÜŞTÜ (yeni servis kuralı)
 *   • rapordan çıkan servis (`removed`) mesaj ÜRETMEZ — yalnız bilgidir.
 * settings: servis adı → panelde kaydedilmiş bildirim ayarı (yoksa açık). Etkin karar:
 * host-agent `alerts:false` VEYA panel ayarı (kanal/olay) kapalı → o servis sessiz.
 */
export function serviceTransitions(prevServices, nextServices, settings = new Map(), channel = "whatsapp") {
  const prev = new Map((Array.isArray(prevServices) ? prevServices : []).map((s) => [s.name, s]));
  const next = Array.isArray(nextServices) ? nextServices : [];
  const downs = [];
  const ups = [];
  for (const s of next) {
    if (s.alerts === false) continue; // muted in the host-agent config: state is stored, no notifications
    const panel = settings.get(s.name); // panel-editable setting (absent = on)
    const before = prev.get(s.name);
    if (s.status === "down") {
      if ((!before || before.status === "up") && shouldNotify(panel, channel, "down")) downs.push({ name: s.name, detail: s.detail || "" });
    } else if (before && before.status === "down" && shouldNotify(panel, channel, "recovery")) {
      ups.push({ name: s.name, ms: Number.isFinite(s.ms) ? s.ms : null });
    }
  }
  const nextNames = new Set(next.map((s) => s.name));
  const removed = [...prev.keys()].filter((n) => !nextNames.has(n));
  return { downs, ups, removed };
}

/**
 * Geçişlerden WhatsApp metinleri (TÜRKÇE — ürün dili). Aynı raporun çoklu
 * düşüşü/kalkışı TEK satırda toplanır; adlar veriden gelir. 1 down + 1 up
 * aynı raporda → 2 satır (down önce).
 */
export function transitionTexts(hostName, { downs, ups }, ts) {
  const texts = [];
  if (downs.length >= 2) {
    texts.push(`🔴 ${hostName}: ${downs.length} servis düştü: ${downs.map((d) => d.name).join(", ")} (${ts})`);
  } else if (downs.length === 1) {
    const d = downs[0];
    texts.push(d.detail ? `🔴 ${hostName}: ${d.name} düştü — ${shortDetail(d.detail)} (${ts})` : `🔴 ${hostName}: ${d.name} düştü (${ts})`);
  }
  if (ups.length >= 2) {
    texts.push(`🟢 ${hostName}: ${ups.length} servis toparlandı: ${ups.map((u) => u.name).join(", ")} (${ts})`);
  } else if (ups.length === 1) {
    const u = ups[0];
    texts.push(Number.isFinite(u.ms) && u.ms != null ? `🟢 ${hostName}: ${u.name} toparlandı (${ts}, ${u.ms} ms)` : `🟢 ${hostName}: ${u.name} toparlandı (${ts})`);
  }
  return texts;
}

export const missingText = (hostName, ts) =>
  `⚠️ ${hostName}: ${MISSING_ALERT_AFTER_MS / 60_000} dakikadır rapor yok (${MISSING_REPORTS} eksik rapor) (${ts})`;

export const recoveredText = (hostName, ts) => `🟢 ${hostName}: rapor geri geldi (${ts})`;

// üretim gönderimi: lib/notify köprüsü (hata bastırılır; teslim HTTP kodu loglanır)
async function defaultSend(text) {
  console.log(text);
  await postWhatsapp(text, loadConf());
}

/**
 * Kabul edilen raporun olaylarını ANINDA gönderir (pencere yok) ve belgeye son
 * olayı yazar. prev = önceki belge (hostun İLK raporunda null). Gönderim
 * hatası bastırılır — rapor kabul akışını asla bozmaz.
 */
export async function dispatchReportAlerts(prevDoc, report, { send = defaultSend } = {}) {
  const hostName = report.host.name;
  const ts = isoPanel(new Date());
  let settings = new Map();
  try {
    settings = await hostServiceSettings(hostName);
  } catch (e) {
    // fail open: a settings read problem must not swallow real alerts
    console.error("[host-alert] settings read failed:", e?.message || e);
  }
  const texts = transitionTexts(hostName, serviceTransitions(prevDoc?.services, report.services, settings), ts);
  const wasMissing = prevDoc?.missedAlerts === true;
  if (wasMissing) texts.push(recoveredText(hostName, ts));
  for (const text of texts) {
    try {
      await send(text);
    } catch (e) {
      console.error("[host-alert] send failed:", e?.message || e);
    }
  }
  if (texts.length) {
    await HostReport.updateOne({ "host.name": hostName }, { $set: { lastAlert: { text: texts[0], at: new Date() } } }).catch((e) =>
      console.error("[host-alert] lastAlert write failed:", e?.message || e),
    );
  }
  if (wasMissing) {
    await HostReport.updateOne({ "host.name": hostName }, { $set: { missedAlerts: false } }).catch((e) =>
      console.error("[host-alert] missedAlerts reset failed:", e?.message || e),
    );
  }
  return texts;
}

/**
 * Raporu MISSING_ALERT_AFTER_MS süredir gelmeyen hostları tarar; henüz
 * uyarılmamışsa TEK "rapor yok" mesajı gönderir ve belgeye kilidi yazar
 * (ikinci tarama tekrar etmez).
 */
export async function scanMissingReports({ send = defaultSend, now = Date.now } = {}) {
  const alerted = [];
  for (const doc of await HostReport.find({ missedAlerts: { $ne: true } }).lean()) {
    if (now() - new Date(doc.at).getTime() <= MISSING_ALERT_AFTER_MS) continue;
    const text = missingText(doc.host.name, isoPanel(new Date()));
    try {
      await send(text);
    } catch (e) {
      console.error("[host-alert] send failed:", e?.message || e);
    }
    await HostReport.updateOne({ _id: doc._id }, { $set: { missedAlerts: true, lastAlert: { text, at: new Date() } } });
    alerted.push(doc.host.name);
  }
  return alerted;
}

/** Dakikalık eksik-rapor tarayıcısı (server.js). Dönen işlev zamanlayıcıyı durdurur. */
export function startHostReportWatch({ intervalMs = 60_000, send = defaultSend } = {}) {
  const timer = setInterval(
    () => scanMissingReports({ send }).catch((e) => console.error("[host-alert] missing-report scan failed:", e?.message || e)),
    intervalMs,
  );
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
