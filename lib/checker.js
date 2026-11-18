import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { Agent, Headers, fetch } from "undici";
import { Monitor, Check, Group, SslAlert } from "./models.js";
import { INTERVAL_MS } from "./stats.js";
import { NotifyQueue } from "./notify.js";

// Kontrolcü — panel kuralları harfiyen (~/.hermes/scripts/uptime-checker.py ve
// eski uptime uygulaması web/lib/checker.js referansı):
//   20 sn zaman aşımı · istek başına 3 deneme (ilk başarılı = up), denemeler arası 3 sn
//   DOWN ilanı: 3 ardışık başarısız DÖNGÜ (confirmed); onaysızken durum dönmez
//   hata sürerken etkin aralık min(aralık, 60 sn) → down monitör 60 sn'de bir denenir
//   monitör başına interval (tur 60 sn; süresi gelenler ölçülür) · sweep'te ≤8 paralel
//   kanarya https://1.1.1.1 + https://8.8.8.8 (tur başında; ikisi de düşükse tur iptal + log)
//   UA HermesPanel-Uptime/1.0 · IPv4-öncelikli çözümleme (+ MOON_DNS_OVERRIDES sabitleme)
//   başarı: expectedStatus boşsa 200–399, doluysa YALNIZ o kod · keyword ilk 300 KB'da
//   GET/HEAD/POST + özel başlık/gövde · dns/tcp/tls/server faz kırılımı + cevaplayan IP
//   SSL bitiş ≤14 gün → monitör+gün başına günde bir uyarı olayı
//   check TTL'i şemada 90 gün (models.js); Mongo TTL indeksi kendi siler (prune yok)
//   bildirim: gruplu WhatsApp köprüsü (lib/notify.js — 5 dk gruplama penceresi)
// MOON_INSECURE_TLS=1 → izlenen sitelerde self-signed/iç CA da kabul edilir
// (tls internal arkasındaki kendi servislerimizi izlemek için).

export const CONSTANTS = {
  CHECK_TIMEOUT_MS: 20_000,
  MAX_ATTEMPTS: 3,
  RETRY_DELAY_MS: 3_000,
  CONFIRM_CYCLES: 3,
  MAX_PARALLEL: 8,
  CANARY_TIMEOUT_MS: 8_000,
  SSL_DAYS_LIMIT: 14,
  KEYWORD_LIMIT: 300_000,
  ERROR_INTERVAL_S: 60,
};

export const UA = "HermesPanel-Uptime/1.0 (+uptime-monitor)";

const INSECURE_TLS = process.env.MOON_INSECURE_TLS === "1";
const canaries = () =>
  (process.env.MOON_CANARY_URLS || "https://1.1.1.1,https://8.8.8.8")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const dnsOverrides = () =>
  (process.env.MOON_DNS_OVERRIDES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
const staticIp = () => process.env.MOON_STATIC_IP || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// denemeler arası bekleme — üretimde 3 sn (testlerde MOON_RETRY_DELAY_MS ile kısaltılır)
const retryDelayMs = () => Number(process.env.MOON_RETRY_DELAY_MS) > 0 ? Number(process.env.MOON_RETRY_DELAY_MS) : CONSTANTS.RETRY_DELAY_MS;

// Hata sürerken etkin aralık (saniye): down-onay döngüsü ~3 dk'da tamamlanır (panel etkin_aralik).
export function effectiveInterval(m) {
  const interval = Number(m.interval) > 0 ? Number(m.interval) : 900;
  return (m.consecutiveFailures || 0) > 0 ? Math.min(interval, CONSTANTS.ERROR_INTERVAL_S) : interval;
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
// isteğe bağlı alan sabitleme (MOON_DNS_OVERRIDES → MOON_STATIC_IP; eski uygulama
// kendi alan adlarını DNS'e sormadan tek IP'ye sabitliyordu — desen aynı).
export function resolvingLookup(name, options, done) {
  const host = String(name);
  if (net.isIP(host)) return dns.lookup(host, options, done);
  const h = host.toLowerCase();
  const fixed = staticIp();
  if (fixed && dnsOverrides().some((a) => h === a || h.endsWith("." + a))) {
    // DNS atlanır; Host başlığı, SNI ve sertifika doğrulaması URL'den aynen gelir.
    return done(null, fixed, 4);
  }
  dns.lookup(host, { ...options, family: 4 }, (e4, addr4) => {
    if (!e4 && addr4) return done(null, addr4, 4);
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
      resolvingLookup(name, options, (...args) => {
        conn.dns = since();
        done(...args);
      });
    const port = Number(opts.port) || (secure ? 443 : 80);
    const socket = secure
      ? tls.connect({ host, port, lookup, ALPNProtocols: ["http/1.1"], ...(net.isIP(host) ? {} : { servername: host }), ...(INSECURE_TLS ? { rejectUnauthorized: false } : {}) })
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

    socket.setTimeout(CONSTANTS.CHECK_TIMEOUT_MS, () => finish(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })));
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
async function hasKeyword(res, keyword) {
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    while (total < CONSTANTS.KEYWORD_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // gövde okunamadı → kelime yok sayılır
  } finally {
    res.body.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks).subarray(0, CONSTANTS.KEYWORD_LIMIT).toString("utf8").toLowerCase();
  return body.includes(String(keyword).toLowerCase());
}

// Tek deneme: başlıklar gelene kadar ölçer; faz kırılımı + cevaplayan IP + sertifika.
// `timeoutMs` kanarya için 8 sn'ye iner (panel local_net_up).
async function probeOnce(monitor, timeoutMs = CONSTANTS.CHECK_TIMEOUT_MS) {
  const start = performance.now();
  const { agent, conns } = tracingAgent(start);
  const last = () => [...conns.values()].at(-1);
  const answering = (res) => conns.get(new URL(res.url).hostname.replace(/^\[|\]$/g, "")) || last();
  try {
    const res = await fetch(monitor.url, {
      method: monitor.method || "GET",
      headers: requestHeaders(monitor),
      body: monitor.method === "POST" ? monitor.body || undefined : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: agent,
    });
    const ms = Math.round(performance.now() - start);
    const conn = answering(res);
    // Number(null) === 0 olduğu için önce null ayrımı (yoksa 200–399 kuralı bozulur)
    const es = monitor.expectedStatus;
    const expected = es != null && Number.isFinite(Number(es)) ? Number(es) : null;
    const statusOk = expected != null ? res.status === expected : res.status >= 200 && res.status < 400;
    if (!statusOk) {
      res.body?.cancel().catch(() => {});
      return {
        check: {
          ms,
          status: res.status,
          ok: false,
          error: `HTTP ${res.status}` + (expected != null ? ` (beklenen ${expected})` : ""),
          ip: conn?.ip || "",
          phases: conn && phases(conn, ms, res.redirected),
        },
        cert: certInfo(conn?.cert),
      };
    }
    if (monitor.keyword) {
      const found = await hasKeyword(res, monitor.keyword);
      if (!found) {
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
export async function measure(monitor) {
  let s = null;
  for (let i = 0; i < CONSTANTS.MAX_ATTEMPTS; i++) {
    s = await probeOnce(monitor);
    if (s.check.ok) break;
    if (i < CONSTANTS.MAX_ATTEMPTS - 1) await sleep(retryDelayMs());
  }
  return s;
}

/** Kanarya: iki farklı sağlayıcıya da erişilemiyorsa yerel internet kesik (panel local_net_up). */
export async function canaryOk() {
  for (const c of canaries()) {
    const r = await probeOnce({ url: c, method: "GET" }, CONSTANTS.CANARY_TIMEOUT_MS);
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

// SSL uyarısı: monitör+gün başına bir kez (SslAlert kilidi; panel ssl_uyari durumu).
async function sslAlertEvent(monitorId, name, cert) {
  if (!cert?.expires) return null;
  const days = Math.floor((new Date(cert.expires).getTime() - Date.now()) / 86_400_000);
  if (days > CONSTANTS.SSL_DAYS_LIMIT) return null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await SslAlert.create({ key: `${monitorId}:${today}`, at: new Date() });
  } catch {
    return null; // bugün bu monitör için zaten uyarıldı (mükerrer anahtar)
  }
  return `⚠️ SSL: ${name} sertifikası ${days} gün sonra bitiyor`;
}

const isoPanel = (d) => d.toISOString().replace(/\.\d{3}Z$/, "+00:00");

// Ölçüm sonucunu yazar: Check satırı + Monitor durumu (3 onay döngüsü) + olaylar.
async function writeMeasurement(monitor, s, netUp, groupName) {
  const ts = new Date();
  const prev = monitor.status || "pending";
  let next, consec, confirmed;
  let errorText = s.check.error;
  if (s.check.ok) {
    next = "up";
    consec = 0;
    confirmed = true;
  } else if (!netUp) {
    // kanarya düştü — sweep bu yola düşmez (tur iptal); yalnız checkOne için
    next = prev;
    consec = monitor.consecutiveFailures || 0;
    confirmed = false;
    errorText = `yerel ağ sorunu (${String(s.check.error).slice(0, 80)})`;
  } else {
    consec = (monitor.consecutiveFailures || 0) + 1;
    confirmed = consec >= CONSTANTS.CONFIRM_CYCLES;
    next = confirmed ? "down" : prev; // onaysızsa durum dönmesin (panel kuralı)
  }

  const check = await Check.create({
    monitor: monitor._id,
    at: ts,
    ms: s.check.ms,
    status: s.check.ok ? s.check.status : 0,
    ok: s.check.ok,
    confirmed,
    error: s.check.ok ? "" : errorText,
    ip: s.check.ip || "",
    ...(s.check.phases ? { phases: s.check.phases } : {}),
  });
  if (s.check.ok && s.cert) {
    await Monitor.updateOne({ _id: monitor._id }, { cert: s.cert });
  }
  await Monitor.updateOne({ _id: monitor._id }, { status: next, consecutiveFailures: consec, lastCheckedAt: ts });

  const events = [];
  if (s.check.ok && s.cert) {
    const u = await sslAlertEvent(monitor._id, monitor.name, s.cert);
    if (u) events.push(["ssl", u]);
  }
  if (next === "down" && prev !== "down" && confirmed) events.push(["down", { name: monitor.name, group: groupName, reason: errorText, ts: isoPanel(ts) }]);
  else if (next === "up" && prev === "down") events.push(["up", { name: monitor.name, group: groupName, ts: isoPanel(ts), ms: s.check.ms }]);

  return { events, next, check, confirmed };
}

function publishCheck(io, monitorId, check, cert) {
  if (!io) return;
  const wire = toWire(check.toObject ? check.toObject() : check);
  // panel tam kaydı alır; herkese açık /status yalnız zararsız özetini
  io.to("auth").emit("check", { id: String(monitorId), check: wire, cert: certWire(cert) });
  io.to("public").emit("check", { id: String(monitorId), check: { at: wire.at, ms: wire.ms, status: wire.status, ok: wire.ok } });
}

// Bildirim kuyruğu (geç başlatılır — testler kendi kuyruğunu enjekte eder).
let queue = null;
export function notifyQueue() {
  if (!queue) queue = new NotifyQueue();
  return queue;
}

async function groupNames() {
  const map = new Map();
  for (const g of await Group.find().lean()) map.set(String(g._id), g.name);
  return map;
}

async function groupNameOf(monitor) {
  if (!monitor?.group) return null;
  const g = await Group.findById(monitor.group).lean();
  return g?.name || null;
}

/** Tek monitörü aralık beklemeden ölç (panel ekle/düzenle "şimdi kontrol"; panel check_one). */
export async function checkOne(monitor, io, { queue: q = null } = {}) {
  const s = await measure(monitor);
  const netUp = s.check.ok ? true : (await canaryOk()) >= 0;
  const groupName = await groupNameOf(monitor);
  const { events, check } = await writeMeasurement(monitor, s, netUp, groupName);
  publishCheck(io, monitor._id, check, s.cert);
  const sender = q || notifyQueue();
  for (const event of events) await sender.add(event);
  return check;
}

// ≤8 paralel işçi havuzu (panel ThreadPoolExecutor deseni; yazım sırayla).
async function parallel(tasks, n) {
  const results = new Array(tasks.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, async () => {
    while (i < tasks.length) {
      const j = i++;
      results[j] = await tasks[j]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Süresi gelen monitörleri tarar (panel sweep). Kanarya düşükse tur iptal + log. */
export async function sweep({ io = null, queue: q = null } = {}) {
  const startedAt = Date.now();
  const all = await Monitor.find({ enabled: { $ne: false } }).lean();
  const due = all.filter((m) => !m.lastCheckedAt || startedAt - new Date(m.lastCheckedAt).getTime() >= effectiveInterval(m) * 1000);
  if (!due.length) return { measured: 0, events: 0 };

  const canaryMs = await canaryOk();
  if (canaryMs < 0) {
    console.warn(`[checker] canary DOWN (1.1.1.1 + 8.8.8.8 unreachable) — sweep cancelled, ${due.length} monitors not measured (not counted as down, no alert)`);
    return { measured: 0, events: 0, canary: false };
  }

  const names = await groupNames();
  const sender = q || notifyQueue();
  const results = await parallel(
    due.map((m) => () => measure(m)),
    CONSTANTS.MAX_PARALLEL,
  );

  let failed = 0;
  let confirmedDown = 0;
  const events = [];
  for (let i = 0; i < due.length; i++) {
    const m = due[i];
    const s = results[i];
    if (!s.check.ok) failed++;
    const groupName = m.group ? names.get(String(m.group)) || null : null;
    const r = await writeMeasurement(m, s, true, groupName);
    if (r.confirmed && r.next === "down" && m.status !== "down") confirmedDown++;
    events.push(...r.events);
    publishCheck(io, m._id, r.check, s.cert);
  }
  for (const event of events) await sender.add(event);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[checker] sweep: canary OK (${canaryMs} ms), ${due.length} measured, ${failed} failed, ${confirmedDown} confirmed down, ${events.length} events, ${seconds} s`);
  return { measured: due.length, events: events.length, canary: true };
}

let sweepRunning = false;
async function tick(io) {
  if (sweepRunning) return; // uzun tur (3×20 sn denemeler) üst üste binmez
  sweepRunning = true;
  try {
    await sweep({ io });
  } catch (err) {
    console.error("[checker] sweep error:", err?.message || err);
  } finally {
    sweepRunning = false;
  }
}

export function startChecker(io) {
  tick(io);
  const timer = setInterval(() => tick(io), INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`[checker] started (sweep every ${INTERVAL_MS / 1000} s, ≤${CONSTANTS.MAX_PARALLEL} parallel, ${CONSTANTS.CONFIRM_CYCLES} confirm cycles, check TTL 90 days)`);
}
