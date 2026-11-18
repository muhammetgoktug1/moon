import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { Agent, Headers, fetch } from "undici";
import { Monitor, Check, Group, SslUyari } from "./models.js";
import { INTERVAL_MS } from "./stats.js";
import { BildirimKuyrugu } from "./bildirim.js";

// Kontrolcü — panel kuralları harfiyen (~/.hermes/scripts/uptime-checker.py ve
// eski uptime uygulaması web/lib/checker.js referansı):
//   20 sn zaman aşımı · istek başına 3 deneme (ilk başarılı = up), denemeler arası 3 sn
//   DOWN ilanı: 3 ardışık başarısız DÖNGÜ (confirmed); onaysızken durum dönmez
//   hata sürerken etkin aralık min(aralık, 60 sn) → down monitör 60 sn'de bir denenir
//   monitör başına interval (tur 60 sn; süresi gelenler ölçülür) · sweep'te ≤8 paralel
//   kanarya https://1.1.1.1 + https://8.8.8.8 (tur başında; ikisi de düşükse tur iptal + log)
//   UA HermesPanel-Uptime/1.0 · IPv4-öncelikli çözümleme (+ MOON_SABIT_ALANLAR sabitleme)
//   başarı: beklenen_kod boşsa 200–399, doluysa YALNIZ o kod · keyword ilk 300 KB'da
//   GET/HEAD/POST + özel başlık/gövde · dns/tcp/tls/server faz kırılımı + cevaplayan IP
//   SSL bitiş ≤14 gün → monitör+gün başına günde bir uyarı olayı
//   check TTL'i şemada 90 gün (models.js); Mongo TTL indeksi kendi siler (prune yok)
//   bildirim: gruplu WhatsApp köprüsü (lib/bildirim.js — 5 dk gruplama penceresi)
// MOON_GUVENSIZ_TLS=1 → izlenen sitelerde self-signed/iç CA da kabul edilir
// (moon.sistem.com gibi tls internal arkasındaki kendi servislerimizi izlemek için).

export const SABITLER = {
  CHECK_TIMEOUT_MS: 20_000,
  MAX_ATTEMPTS: 3,
  RETRY_DELAY_MS: 3_000,
  CONFIRM_CYCLES: 3,
  MAX_PARALEL: 8,
  KANARYA_TIMEOUT_MS: 8_000,
  SSL_ESIK_GUN: 14,
  KEYWORD_LIMIT: 300_000,
  HATA_ARALIK_SN: 60,
};

export const UA = "HermesPanel-Uptime/1.0 (+uptime-monitor)";

const GUVENSIZ_TLS = process.env.MOON_GUVENSIZ_TLS === "1";
const kanaryalar = () =>
  (process.env.MOON_KANARYA_URLLER || "https://1.1.1.1,https://8.8.8.8")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const sabitAlanlar = () =>
  (process.env.MOON_SABIT_ALANLAR || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const sabitIp = () => process.env.MOON_SABIT_IP || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// denemeler arası bekleme — üretimde 3 sn (testlerde MOON_DENEME_ARALIK_MS ile kısaltılır)
const denemeAralikMs = () => Number(process.env.MOON_DENEME_ARALIK_MS) > 0 ? Number(process.env.MOON_DENEME_ARALIK_MS) : SABITLER.RETRY_DELAY_MS;

// Hata sürerken etkin aralık (saniye): down-onay döngüsü ~3 dk'da tamamlanır (panel etkin_aralik).
export function etkinAralik(m) {
  const aralik = Number(m.interval) > 0 ? Number(m.interval) : 900;
  return (m.consecutiveFailures || 0) > 0 ? Math.min(aralik, SABITLER.HATA_ARALIK_SN) : aralik;
}

function reason(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return err?.cause?.code || err?.message || String(err);
}

function requestHeaders(monitor) {
  const headers = new Headers({ "user-agent": UA });
  for (const h of monitor.headers || []) headers.set(h.key, h.value);
  if (monitor.body && monitor.method === "POST" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

// IPv4 öncelikli ad çözümleme (split-DNS AAAA zaman aşımı vakası, 16.11) +
// isteğe bağlı alan sabitleme (MOON_SABIT_ALANLAR → MOON_SABIT_IP; eski uygulama
// sistem.com adlarını DNS'e sormadan tailnet IP'ye sabitliyordu — desen aynı).
export function cozmeliLookup(name, options, done) {
  const host = String(name);
  if (net.isIP(host)) return dns.lookup(host, options, done);
  const h = host.toLowerCase();
  const sabit = sabitIp();
  if (sabit && sabitAlanlar().some((a) => h === a || h.endsWith("." + a))) {
    // DNS atlanır; Host başlığı, SNI ve sertifika doğrulaması URL'den aynen gelir.
    return done(null, sabit, 4);
  }
  dns.lookup(host, { ...options, family: 4 }, (e4, adr4) => {
    if (!e4 && adr4) return done(null, adr4, 4);
    dns.lookup(host, options, done); // IPv6-only hedef için yedek yol
  });
}

// Her bağlantıyı kendisi açar; DNS, TCP ve TLS ayrı ayrı ölçülür. Zamanlar
// ölçüm başlangıcından itibaren ms; `conns` host'a göre anahtarlanır.
function tracingAgent(start) {
  const conns = new Map();
  const since = () => performance.now() - start;

  function connect(opts, cb) {
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    const secure = opts.protocol === "https:";
    const at = since();
    const conn = { ip: "", start: at, dns: at, tcp: 0, tls: 0, cert: undefined };
    conns.set(host, conn);

    const lookup = (name, options, done) =>
      cozmeliLookup(name, options, (...args) => {
        conn.dns = since();
        done(...args);
      });
    const port = Number(opts.port) || (secure ? 443 : 80);
    const socket = secure
      ? tls.connect({ host, port, lookup, ALPNProtocols: ["http/1.1"], ...(net.isIP(host) ? {} : { servername: host }), ...(GUVENSIZ_TLS ? { rejectUnauthorized: false } : {}) })
      : net.connect({ host, port, lookup });

    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.off("error", finish);
      if (!err) return cb(null, socket);
      socket.destroy();
      cb(err);
    }

    socket.setTimeout(SABITLER.CHECK_TIMEOUT_MS, () => finish(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })));
    socket.once("error", finish);
    socket.once("connect", () => {
      conn.tcp = since();
      conn.ip = socket.remoteAddress;
      if (!secure) finish();
    });
    if (secure) {
      socket.once("secureConnect", () => {
        conn.tls = since();
        conn.cert = socket.getPeerCertificate();
        finish();
      });
    }
  }

  return { agent: new Agent({ connect }), conns };
}

// Yönlendirme olmayan bağlantıda açılışa kadarki birkaç ms DNS sayılır.
function phases(conn, ms, redirected) {
  const ready = conn.tls || conn.tcp;
  const before = redirected ? conn.start : 0;
  return {
    redirect: Math.round(before),
    dns: Math.round(conn.dns - before),
    tcp: Math.round(conn.tcp - conn.dns),
    tls: conn.tls ? Math.round(conn.tls - conn.tcp) : 0,
    server: Math.max(0, Math.round(ms - ready)),
  };
}

function certInfo(cert) {
  if (!cert?.valid_to) return undefined;
  return {
    subject: cert.subject?.CN || "",
    issuer: cert.issuer?.O || cert.issuer?.CN || "",
    issued: new Date(cert.valid_from),
    expires: new Date(cert.valid_to),
  };
}

// keyword'ü gövdenin İLK 300 KB'ında arar (büyük/küçük duyarsız). Eski uygulama
// deseninde: 300 KB okunur, tampon üzerinde includes. Limit dolunca akış iptal edilir.
async function keywordVar(res, keyword) {
  const parcalar = [];
  let toplam = 0;
  const okuyucu = res.body.getReader();
  try {
    while (toplam < SABITLER.KEYWORD_LIMIT) {
      const { done, value } = await okuyucu.read();
      if (done) break;
      parcalar.push(value);
      toplam += value.length;
    }
  } catch {
    // gövde okunamadı → kelime yok sayılır
  } finally {
    res.body.cancel().catch(() => {});
  }
  const govde = Buffer.concat(parcalar).subarray(0, SABITLER.KEYWORD_LIMIT).toString("utf8").toLowerCase();
  return govde.includes(String(keyword).toLowerCase());
}

// Tek deneme: başlıklar gelene kadar ölçer; faz kırılımı + cevaplayan IP + sertifika.
// `zamanAsimiMs` kanarya için 8 sn'ye iner (panel local_net_up).
async function probeOnce(monitor, zamanAsimiMs = SABITLER.CHECK_TIMEOUT_MS) {
  const start = performance.now();
  const { agent, conns } = tracingAgent(start);
  const last = () => [...conns.values()].at(-1);
  const cevaplayan = (res) => conns.get(new URL(res.url).hostname.replace(/^\[|\]$/g, "")) || last();
  try {
    const res = await fetch(monitor.url, {
      method: monitor.method || "GET",
      headers: requestHeaders(monitor),
      body: monitor.method === "POST" ? monitor.body || undefined : undefined,
      signal: AbortSignal.timeout(zamanAsimiMs),
      dispatcher: agent,
    });
    const ms = Math.round(performance.now() - start);
    const conn = cevaplayan(res);
    // Number(null) === 0 olduğu için önce null ayrımı (yoksa 200–399 kuralı bozulur)
    const bk = monitor.beklenenKod;
    const beklenen = bk != null && Number.isFinite(Number(bk)) ? Number(bk) : null;
    const kodOk = beklenen != null ? res.status === beklenen : res.status >= 200 && res.status < 400;
    if (!kodOk) {
      res.body?.cancel().catch(() => {});
      return {
        check: {
          ms,
          status: res.status,
          ok: false,
          error: `HTTP ${res.status}` + (beklenen != null ? ` (beklenen ${beklenen})` : ""),
          ip: conn?.ip || "",
          phases: conn && phases(conn, ms, res.redirected),
        },
        cert: certInfo(conn?.cert),
      };
    }
    if (monitor.keyword) {
      const bulundu = await keywordVar(res, monitor.keyword);
      if (!bulundu) {
        return {
          check: {
            ms,
            status: res.status,
            ok: false,
            error: `anahtar kelime yok: ${String(monitor.keyword).slice(0, 40)} (son adres ${res.url.slice(0, 80)})`,
            ip: conn?.ip || "",
            phases: conn && phases(conn, ms, res.redirected),
          },
          cert: certInfo(conn?.cert),
        };
      }
    } else {
      res.body?.cancel().catch(() => {});
    }
    return {
      check: { ms, status: res.status, ok: true, error: "", ip: conn?.ip || "", phases: conn && phases(conn, ms, res.redirected) },
      cert: certInfo(conn?.cert),
    };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    return { check: { ms, status: 0, ok: false, error: reason(err), ip: last()?.ip || "" } };
  } finally {
    agent.destroy().catch(() => {});
  }
}

/** Tek monitörü ölç: 3 deneme, ilk başarılı = up, denemeler arası 3 sn. DB'ye DOKUNMAZ. */
export async function olcEt(monitor) {
  let s = null;
  for (let i = 0; i < SABITLER.MAX_ATTEMPTS; i++) {
    s = await probeOnce(monitor);
    if (s.check.ok) break;
    if (i < SABITLER.MAX_ATTEMPTS - 1) await sleep(denemeAralikMs());
  }
  return s;
}

/** Kanarya: iki farklı sağlayıcıya da erişilemiyorsa yerel internet kesik (panel local_net_up). */
export async function kanaryaOk() {
  for (const c of kanaryalar()) {
    const r = await probeOnce({ url: c, method: "GET" }, SABITLER.KANARYA_TIMEOUT_MS);
    if (r.check.ok) return r.check.ms;
  }
  return -1;
}

export function toWire(c) {
  return {
    at: new Date(c.at).getTime(),
    ms: c.ms,
    status: c.status,
    ok: c.ok,
    error: c.error,
    ip: c.ip || "",
    confirmed: typeof c.confirmed === "boolean" ? c.confirmed : undefined,
    // checks stored before timing existed have no phases
    phases: c.phases?.server >= 0 ? { ...c.phases } : undefined,
  };
}

export function certWire(cert) {
  if (!cert?.expires) return undefined;
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    issued: cert.issued ? new Date(cert.issued).getTime() : 0,
    expires: new Date(cert.expires).getTime(),
  };
}

// SSL uyarısı: monitör+gün başına bir kez (MoonSslUyari kilidi; panel ssl_uyari durumu).
async function sslUyariOlay(monitorId, ad, cert) {
  if (!cert?.expires) return null;
  const gun = Math.floor((new Date(cert.expires).getTime() - Date.now()) / 86_400_000);
  if (gun > SABITLER.SSL_ESIK_GUN) return null;
  const bugun = new Date().toISOString().slice(0, 10);
  try {
    await SslUyari.create({ anahtar: `${monitorId}:${bugun}`, at: new Date() });
  } catch {
    return null; // bugün bu monitör için zaten uyarıldı (mükerrer anahtar)
  }
  return `⚠️ SSL: ${ad} sertifikası ${gun} gün sonra bitiyor`;
}

const isoPanel = (d) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

// Ölçüm sonucunu yazar: Check satırı + Monitor durumu (3 onay döngüsü) + olaylar.
async function olcumYaz(monitor, s, netUp, grupAdi) {
  const ts = new Date();
  const prev = monitor.status || "pending";
  let yeni, consec, confirmed;
  let hataMetni = s.check.error;
  if (s.check.ok) {
    yeni = "up";
    consec = 0;
    confirmed = true;
  } else if (!netUp) {
    // kanarya düştü — sweep bu yola düşmez (tur iptal); yalnız checkOne için
    yeni = prev;
    consec = monitor.consecutiveFailures || 0;
    confirmed = false;
    hataMetni = `yerel ağ sorunu (${String(s.check.error).slice(0, 80)})`;
  } else {
    consec = (monitor.consecutiveFailures || 0) + 1;
    confirmed = consec >= SABITLER.CONFIRM_CYCLES;
    yeni = confirmed ? "down" : prev; // onaysızsa durum dönmesin (panel kuralı)
  }

  const check = await Check.create({
    monitor: monitor._id,
    at: ts,
    ms: s.check.ms,
    status: s.check.ok ? s.check.status : 0,
    ok: s.check.ok,
    confirmed,
    error: s.check.ok ? "" : hataMetni,
    ip: s.check.ip || "",
    ...(s.check.phases ? { phases: s.check.phases } : {}),
  });
  if (s.check.ok && s.cert) {
    await Monitor.updateOne({ _id: monitor._id }, { cert: s.cert });
  }
  await Monitor.updateOne({ _id: monitor._id }, { status: yeni, consecutiveFailures: consec, lastCheckedAt: ts });

  const olaylar = [];
  if (s.check.ok && s.cert) {
    const u = await sslUyariOlay(monitor._id, monitor.name, s.cert);
    if (u) olaylar.push(["ssl", u]);
  }
  if (yeni === "down" && prev !== "down" && confirmed) olaylar.push(["down", { name: monitor.name, grup: grupAdi, reason: hataMetni, ts: isoPanel(ts) }]);
  else if (yeni === "up" && prev === "down") olaylar.push(["up", { name: monitor.name, grup: grupAdi, ts: isoPanel(ts), ms: s.check.ms }]);

  return { olaylar, yeni, check, confirmed };
}

function checkYayimla(io, monitorId, check, cert) {
  if (!io) return;
  const wire = toWire(check.toObject ? check.toObject() : check);
  // panel tam kaydı alır; herkese açık /status yalnız zararsız özetini
  io.to("auth").emit("check", { id: String(monitorId), check: wire, cert: certWire(cert) });
  io.to("public").emit("check", { id: String(monitorId), check: { at: wire.at, ms: wire.ms, status: wire.status, ok: wire.ok } });
}

// Bildirim kuyruğu (geç başlatılır — testler kendi kuyruğunu enjekte eder).
let kuyruk = null;
export function bildirimKuyrugu() {
  if (!kuyruk) kuyruk = new BildirimKuyrugu();
  return kuyruk;
}

async function grupAdlari() {
  const map = new Map();
  for (const g of await Group.find().lean()) map.set(String(g._id), g.name);
  return map;
}

async function adtanGrupAdi(monitor) {
  if (!monitor?.group) return null;
  const g = await Group.findById(monitor.group).lean();
  return g?.name || null;
}

/** Tek monitörü aralık beklemeden ölç (panel ekle/düzenle "şimdi kontrol"; panel check_one). */
export async function checkOne(monitor, io, { kuyruk: k = null } = {}) {
  const s = await olcEt(monitor);
  const netUp = s.check.ok ? true : (await kanaryaOk()) >= 0;
  const grupAdi = await adtanGrupAdi(monitor);
  const { olaylar, check } = await olcumYaz(monitor, s, netUp, grupAdi);
  checkYayimla(io, monitor._id, check, s.cert);
  const gonderen = k || bildirimKuyrugu();
  for (const olay of olaylar) await gonderen.ekle(olay);
  return check;
}

// ≤8 paralel işçi havuzu (panel ThreadPoolExecutor deseni; yazım sırayla).
async function paralel(isler, n) {
  const sonuclar = new Array(isler.length);
  let i = 0;
  const isciler = Array.from({ length: Math.max(1, Math.min(n, isler.length)) }, async () => {
    while (i < isler.length) {
      const j = i++;
      sonuclar[j] = await isler[j]();
    }
  });
  await Promise.all(isciler);
  return sonuclar;
}

/** Süresi gelen monitörleri tarar (panel sweep). Kanarya düşükse tur iptal + log. */
export async function sweep({ io = null, kuyruk: k = null } = {}) {
  const simdi = Date.now();
  const tumu = await Monitor.find({ enabled: { $ne: false } }).lean();
  const due = tumu.filter((m) => !m.lastCheckedAt || simdi - new Date(m.lastCheckedAt).getTime() >= etkinAralik(m) * 1000);
  if (!due.length) return { olcum: 0, olay: 0 };

  const kanaryaMs = await kanaryaOk();
  if (kanaryaMs < 0) {
    console.warn(`[kontrolcü] kanarya DÜŞÜK (1.1.1.1 + 8.8.8.8 erişilemedi) — tur iptal, ${due.length} monitör ölçülmedi (site düşmüş sayılmaz, alarm yok)`);
    return { olcum: 0, olay: 0, kanarya: false };
  }

  const adlar = await grupAdlari();
  const gonderen = k || bildirimKuyrugu();
  const sonuclar = await paralel(
    due.map((m) => () => olcEt(m)),
    SABITLER.MAX_PARALEL,
  );

  let hata = 0;
  let onayliDown = 0;
  const olaylar = [];
  for (let i = 0; i < due.length; i++) {
    const m = due[i];
    const s = sonuclar[i];
    if (!s.check.ok) hata++;
    const grupAdi = m.group ? adlar.get(String(m.group)) || null : null;
    const r = await olcumYaz(m, s, true, grupAdi);
    if (r.confirmed && r.yeni === "down" && m.status !== "down") onayliDown++;
    olaylar.push(...r.olaylar);
    checkYayimla(io, m._id, r.check, s.cert);
  }
  for (const olay of olaylar) await gonderen.ekle(olay);

  const sureSn = ((Date.now() - simdi) / 1000).toFixed(1);
  console.log(`[kontrolcü] tur: kanarya OK (${kanaryaMs} ms), ${due.length} ölçüm, ${hata} hata, ${onayliDown} onaylı down, ${olaylar.length} olay, ${sureSn} sn`);
  return { olcum: due.length, olay: olaylar.length, kanarya: true };
}

let sweepSuruyor = false;
async function tur(io) {
  if (sweepSuruyor) return; // uzun tur (3×20 sn denemeler) üst üste binmez
  sweepSuruyor = true;
  try {
    await sweep({ io });
  } catch (err) {
    console.error("[kontrolcü] tur hatası:", err?.message || err);
  } finally {
    sweepSuruyor = false;
  }
}

export function startChecker(io) {
  tur(io);
  const timer = setInterval(() => tur(io), INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[kontrolcü] başladı (tur ${INTERVAL_MS / 1000} sn, ≤${SABITLER.MAX_PARALEL} paralel, ${SABITLER.CONFIRM_CYCLES} onay döngüsü, check TTL 90 gün)`);
}
