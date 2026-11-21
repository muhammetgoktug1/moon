import { createServer } from "node:http";
import next from "next";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { MONGODB_URI, PORT, warnLegacyEnv } from "./lib/config.js";
import { Monitor, Check, Group, HostReport, HostServiceSetting } from "./lib/models.js";
import { startChecker, checkOne, toWire, certWire } from "./lib/checker.js";
import { externalEndpoint } from "./lib/external.js";
import { hostReportEndpoint, hostsWire } from "./lib/hostReport.js";
import { dispatchReportAlerts, startHostReportWatch } from "./lib/hostAlerts.js";
import { parseMonitor } from "./lib/monitorInput.js";
import { monitorNotificationsWire, saveHostServiceNotifications } from "./lib/notifyStore.js";
import { settingsEndpoint } from "./lib/settingsApi.js";
import { statusData, resetStatusCache } from "./lib/statusPage.js";
import { routeGate } from "./lib/routes.js";
import { RECENT, RANGES } from "./lib/stats.js";
import {
  authBootstrap,
  setupOpen,
  openFirstAccount,
  login,
  verifySession,
  logout,
  cookieValue,
  cookieHeader,
  rateLimit,
  originAllowed,
} from "./lib/auth.js";

const dev = process.argv.includes("--dev");
const app = next({ dev });

const ORDER = { order: 1, createdAt: 1 };

async function snapshot() {
  const monitors = await Monitor.find().sort(ORDER).lean();
  return Promise.all(
    monitors.map(async (m) => {
      const checks = await Check.find({ monitor: m._id }).sort({ at: -1 }).limit(RECENT).lean();
      return {
        id: String(m._id),
        name: m.name,
        group: m.group ? String(m.group) : "",
        url: m.url,
        method: m.method || "GET",
        // header values and body can hold secrets; only their shape leaves the server
        headerNames: (m.headers || []).map((h) => h.key),
        bodySize: (m.body || "").length,
        // complete notification settings (defaults filled); records without the field read as all-on
        notifications: monitorNotificationsWire(m),
        cert: certWire(m.cert),
        checks: checks.reverse().map(toWire),
      };
    }),
  );
}

async function groupList() {
  const groups = await Group.find().sort(ORDER).lean();
  return groups.map((g) => ({ id: String(g._id), name: g.name }));
}

const groupName = (name) => String(name || "").trim().slice(0, 40);

// The browser never sees header values or the body, so on edit a blank
// header value or an empty body means "keep what is stored".
function withStored({ headers, body }, monitor) {
  const stored = new Map((monitor.headers || []).map((h) => [h.key, h.value]));
  return {
    headers: (Array.isArray(headers) ? headers : []).map((h) => ({
      key: h?.key,
      value: h?.value || stored.get(String(h?.key || "").trim()) || "",
    })),
    body: body || monitor.body,
  };
}

// /status sayfasının verisi lib/statusPage.js'te (test edilen gizlilik garantisiyle).

function wire(io) {
  const broadcast = async () => {
    resetStatusCache();
    io.to("auth").emit("monitors", await snapshot());
    io.to("auth").emit("groups", await groupList());
  };

  io.use(async (socket, next) => {
    const token = cookieValue(socket.handshake.headers.cookie);
    socket.data.session = token ? await verifySession(token).catch(() => null) : null;
    next();
  });

  io.on("connection", (socket) => {
    // panel tam veriyi 'auth' odasında; herkese açık /status yalnız 'public' odasında
    socket.join(socket.data.session ? "auth" : "public");
    const authed = () => !!socket.data.session;
    const AUTH_ERROR = { error: "unauthorized" };
    const ORIGIN_ERROR = { error: "origin" };
    // yazma uçlarında Origin kontrolü: tarayıcıdan geliyorsa aynı sunucu olmalı
    const writeOriginOk = () => originAllowed(socket.handshake.headers);

    socket.on("list", async (ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      ack(await snapshot());
    });
    socket.on("status", async (ack) => ack(await statusData()));
    // Faz A: host kaynak raporları — yalnız oturumlu panel (/status'a ÇIKMAZ).
    socket.on("hosts", async (ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      ack(await hostsWire());
    });
    socket.on("groups", async (ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      ack(await groupList());
    });

    // Host services come from the host-agent config; their notification settings are
    // panel-editable and stored per (host, service). Same validation as the HTTP API.
    socket.on("hostService:notifications", async (data, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      const result = await saveHostServiceNotifications(data?.host, data?.service, data?.notifications);
      if (result.error) return ack({ error: result.error });
      ack({ notifications: result.notifications });
      await hostsBroadcast();
    });

    socket.on("group:add", async (name, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      if (!groupName(name)) return ack({ error: "Give the tab a name." });
      const group = await Group.create({ name: groupName(name), order: await Group.countDocuments() });
      ack({ id: String(group._id) });
      await broadcast();
    });

    // monitors: every monitor id that belongs in the tab; a monitor is in one tab at most
    socket.on("group:save", async ({ id, name, monitors }, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      if (!mongoose.isValidObjectId(id)) return ack({ error: "This tab no longer exists." });
      if (!groupName(name)) return ack({ error: "Give the tab a name." });
      const ids = (Array.isArray(monitors) ? monitors : []).filter((m) => mongoose.isValidObjectId(m));
      const { matchedCount } = await Group.updateOne({ _id: id }, { name: groupName(name) });
      if (!matchedCount) return ack({ error: "This tab no longer exists." });
      await Monitor.updateMany({ group: id, _id: { $nin: ids } }, { group: null });
      await Monitor.updateMany({ _id: { $in: ids } }, { group: id });
      ack({});
      await broadcast();
    });

    // the monitors stay, they just leave the tab
    socket.on("group:remove", async (id, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      if (!mongoose.isValidObjectId(id)) return ack();
      await Promise.all([Group.deleteOne({ _id: id }), Monitor.updateMany({ group: id }, { group: null })]);
      ack();
      await broadcast();
    });

    socket.on("history", async ({ id, range }, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!mongoose.isValidObjectId(id) || !RANGES[range]) return ack([]);
      const since = new Date(Date.now() - RANGES[range]);
      const checks = await Check.find({ monitor: id, at: { $gte: since } }).sort({ at: 1 }).lean();
      ack(checks.map(toWire));
    });

    socket.on("add", async (data, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      const fields = parseMonitor(data);
      if (fields.error) return ack(fields);
      // new monitors go to the end of the custom order
      const monitor = await Monitor.create({ ...fields, order: await Monitor.countDocuments() });
      ack({ id: String(monitor._id) });
      await broadcast();
      checkOne(monitor, io);
    });

    // Checks stay attached to the monitor id, so editing keeps the history.
    socket.on("edit", async (data, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      const monitor = mongoose.isValidObjectId(data?.id) && (await Monitor.findById(data.id).lean());
      if (!monitor) return ack({ error: "This monitor no longer exists." });
      const fields = parseMonitor({ ...data, ...withStored(data, monitor) }, monitor.notifications);
      if (fields.error) return ack(fields);
      // a different host serves a different certificate; the next check reads it
      const sameHost = new URL(fields.url).host === new URL(monitor.url).host;
      await Monitor.updateOne({ _id: monitor._id }, sameHost ? fields : { ...fields, $unset: { cert: 1 } });
      ack({ id: data.id });
      await broadcast();
      checkOne({ ...monitor, ...fields }, io);
    });

    // ids: every monitor id in the new custom order
    socket.on("reorder", async (ids, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      if (!Array.isArray(ids) || !ids.every((id) => mongoose.isValidObjectId(id))) return ack();
      await Monitor.bulkWrite(ids.map((id, order) => ({ updateOne: { filter: { _id: id }, update: { order } } })));
      await broadcast();
      ack();
    });

    socket.on("remove", async (id, ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      if (!writeOriginOk()) return ack?.(ORIGIN_ERROR);
      if (!mongoose.isValidObjectId(id)) return ack();
      await Promise.all([Monitor.deleteOne({ _id: id }), Check.deleteMany({ monitor: id })]);
      ack();
      await broadcast();
    });
  });
}

// --- HTTP: page gate + auth endpoints --------------------------------------
// Panel (`/`, `/m/...`) oturum ister; `/status` herkese açıktır.
// `/login` oturumluyken panele, `/setup` kayıt kapatıldıysa girişe döner.
// Eski yollar (/giris, /kurulum, /api/… Türkçe adları) 307 ile yenilere yönlenir.

const json = (res, code, body, extraHeaders = []) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...Object.fromEntries(extraHeaders) });
  res.end(text);
};

async function readBody(req, limit = 8192) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const ipFrom = (req) => req.socket.remoteAddress || "";

async function authEndpoints(req, res) {
  const path = req.url.split("?")[0];
  if (req.method !== "POST" || !["/api/login", "/api/setup", "/api/logout"].includes(path)) return false;

  if (!originAllowed(req.headers)) return json(res, 403, { error: "Origin reddedildi." }), true;

  const secure = req.headers["x-forwarded-proto"] === "https";
  const token = cookieValue(req.headers.cookie);

  try {
    if (path === "/api/logout") {
      await logout(token);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": cookieHeader("", { secure, clear: true }) });
      res.end('{"ok":true}');
      return true;
    }

    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const digest = String(body.digest || "");

    if (path === "/api/setup") {
      if (rateLimit(`setup:${ipFrom(req)}`, 10, 15 * 60_000)) return json(res, 429, { error: "Çok fazla deneme." }), true;
      const result = await openFirstAccount(email, digest);
      if (result.error) return json(res, result.code || 400, { error: result.error }), true;
      const loginResult = await login(email, digest, ipFrom(req), "setup");
      if (!loginResult.token) return json(res, 500, { error: "Oturum açılamadı." }), true;
      return json(res, 200, { ok: true }, [["set-cookie", cookieHeader(loginResult.token, { secure })]]), true;
    }

    // /api/login
    const loginResult = await login(email, digest, ipFrom(req));
    if (loginResult.error) return json(res, loginResult.code || 401, { error: loginResult.error }), true;
    return json(res, 200, { ok: true }, [["set-cookie", cookieHeader(loginResult.token, { secure })]]), true;
  } catch {
    return json(res, 400, { error: "İstek anlaşılamadı." }), true;
  }
}

function redirect(res, location) {
  res.writeHead(307, { location });
  res.end();
}

async function gate(req, res, handle) {
  // dış özet ucu (servis token'lı; 2b köprüsü için) — kimlik uçlarından önce
  if (await externalEndpoint(req, res)) return;
  // iç host rapor ucu (host-agent.py; aynı servis token'ı) — kimlik uçlarından önce
  // Faz 2b: kabul edilen raporun servis geçişleri anında WhatsApp'a gider.
  if (await hostReportEndpoint(req, res, { onStored: () => hostsBroadcast(), onReport: dispatchReportAlerts })) return;
  // bildirim ayarları HTTP ucu (oturum çerezi; panel formları socket kullanır, mantık ortak)
  if (
    await settingsEndpoint(req, res, {
      verify: (r) => verifySession(cookieValue(r.headers.cookie)),
      onChange: (kind) => (kind === "monitor" ? broadcastMonitors() : hostsBroadcast()),
    })
  )
    return;
  if (await authEndpoints(req, res)) return;

  const path = req.url.split("?")[0];
  const token = cookieValue(req.headers.cookie);
  const session = token ? await verifySession(token) : null;

  // kayar çerez: geçerli oturumla panel sayfaları çerezin ömrünü tazeler
  // (writeHead, önceden setHeader ile konan başlıklarla birleşir)
  if (session && (path === "/" || path.startsWith("/m/")) && req.headers["x-forwarded-proto"]) {
    res.setHeader("set-cookie", cookieHeader(token, { secure: req.headers["x-forwarded-proto"] === "https" }));
  }

  const decision = routeGate(path, { session, setupOpen: await setupOpen() });
  if (decision.redirect) return redirect(res, decision.redirect);
  return handle(req, res);
}

await mongoose.connect(MONGODB_URI);
await authBootstrap();
warnLegacyEnv();
// check TTL 30g → 90g (panel kuralı): mevcut indeks seçenekleri farklıysa yeniden kurar.
await Check.syncIndexes().catch((err) => console.error("check index sync", err));
// Faz A: hostReports TTL (30g) + host adına unique indeks açılışta kesin kurulsun.
await HostReport.syncIndexes().catch((err) => console.error("hostReport index sync", err));
await HostServiceSetting.syncIndexes().catch((err) => console.error("hostServiceSetting index sync", err));
await app.prepare();

const server = createServer((req, res) => {
  gate(req, res, app.getRequestHandler()).catch((err) => {
    console.error("gate error", err);
    res.writeHead(500);
    res.end();
  });
});
const io = new Server(server);
// Faz A: yeni host raporu yazılınca panele canlı itilir (yalnız 'auth' odası).
const hostsBroadcast = async () => io.to("auth").emit("hosts", await hostsWire());
// a monitor's notification settings changed over HTTP: refresh the open panels
const broadcastMonitors = async () => io.to("auth").emit("monitors", await snapshot());
wire(io);

// Kontrolcü (dakikalık denetim turu) varsayılan DURUR: mevcut uptime uygulamamız
// ölçmeye devam ediyor, çift kontrolcülük olmasın. Açmak için MOON_CHECKER=1.
if (process.env.MOON_CHECKER === "1") {
  startChecker(io);
} else {
  console.log("[moon] checker disabled — set MOON_CHECKER=1 to enable");
}

server.listen(PORT, "0.0.0.0", () => console.log(`moon ready on :${PORT}`));

// Faz 2b: raporu kesilen hostları dakikada bir tara — 3 eksik raporda (15 dk)
// TEK "rapor yok" uyarısı; rapor dönünce toparlanma (lib/hostAlerts.js).
startHostReportWatch();
