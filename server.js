import { createServer } from "node:http";
import next from "next";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { MONGODB_URI, PORT, warnLegacyEnv } from "./lib/config.js";
import { Monitor, Check, Group } from "./lib/models.js";
import { startChecker, checkOne, toWire, certWire } from "./lib/checker.js";
import { externalEndpoint } from "./lib/external.js";
import { routeGate } from "./lib/routes.js";
import { RECENT, RANGES, INTERVAL_MS } from "./lib/stats.js";
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

function parseUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {}
  return undefined;
}

function parseRequest({ method, headers, body }) {
  const verb = method === "POST" ? "POST" : "GET";
  const pairs = (Array.isArray(headers) ? headers : [])
    .map((h) => ({ key: String(h?.key || "").trim(), value: String(h?.value || "").trim() }))
    .filter((h) => h.key);
  try {
    new Headers(pairs.map((h) => [h.key, h.value]));
  } catch {
    return { error: "One of the headers is not valid." };
  }
  const text = verb === "POST" ? String(body || "").trim() : "";
  if (!text) return { method: verb, headers: pairs, body: "" };
  try {
    JSON.parse(text);
  } catch {
    return { error: "Request body must be valid JSON." };
  }
  return { method: verb, headers: pairs, body: text };
}

function parseMonitor({ name, group, url, ...request }) {
  const parsed = parseUrl(url);
  if (!parsed) return { error: "Enter a valid http(s) URL." };
  const req = parseRequest(request);
  if (req.error) return req;
  return {
    name: String(name || "").trim().slice(0, 60) || parsed.host,
    group: mongoose.isValidObjectId(group) ? group : null,
    url: parsed.href,
    ...req,
  };
}

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

const DAY_MS = 86_400_000;
const STATUS_DAYS = 30; // checks expire after 30 days
let statusCache;

// Herkese açık durum sayfası verisi. Gizlilik: URL/origin, hata metni, IP ve
// faz süreleri panele özeldir — buraya yalnız ad + günlük özet + son durum
// (at/ms/status/ok) çıkar; URL hiçbir şekilde sızmaz.
async function statusData() {
  if (statusCache && Date.now() - statusCache.at < INTERVAL_MS) return statusCache.data;
  const since = new Date().setUTCHours(0, 0, 0, 0) - (STATUS_DAYS - 1) * DAY_MS;
  const [groups, monitors, days] = await Promise.all([
    groupList(),
    Monitor.find().sort(ORDER).lean(),
    Check.aggregate([
      { $match: { at: { $gte: new Date(since) } } },
      {
        $group: {
          // UTC midnight in ms; $dateTrunc would need MongoDB 5
          _id: { monitor: "$monitor", day: { $subtract: [{ $toLong: "$at" }, { $mod: [{ $toLong: "$at" }, DAY_MS] }] } },
          count: { $sum: 1 },
          ok: { $sum: { $cond: ["$ok", 1, 0] } },
        },
      },
    ]),
  ]);
  const byKey = new Map(days.map((d) => [`${d._id.monitor}:${d._id.day}`, d]));
  const services = await Promise.all(
    monitors.map(async (m) => {
      const last = await Check.findOne({ monitor: m._id }).sort({ at: -1 }).lean();
      const wire = last && toWire(last);
      return {
        id: String(m._id),
        name: m.name,
        group: m.group ? String(m.group) : "",
        last: wire ? { at: wire.at, ms: wire.ms, status: wire.status, ok: wire.ok } : null,
        days: Array.from({ length: STATUS_DAYS }, (_, i) => {
          const day = since + i * DAY_MS;
          const d = byKey.get(`${m._id}:${day}`);
          return { day, count: d?.count || 0, ok: d?.ok || 0 };
        }),
      };
    }),
  );
  const data = { groups, services };
  statusCache = { at: Date.now(), data };
  return data;
}

function wire(io) {
  const broadcast = async () => {
    statusCache = undefined;
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
    socket.on("groups", async (ack) => {
      if (!authed()) return ack?.(AUTH_ERROR);
      ack(await groupList());
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
      const fields = parseMonitor({ ...data, ...withStored(data, monitor) });
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
await app.prepare();

const server = createServer((req, res) => {
  gate(req, res, app.getRequestHandler()).catch((err) => {
    console.error("gate error", err);
    res.writeHead(500);
    res.end();
  });
});
const io = new Server(server);
wire(io);

// Kontrolcü (dakikalık denetim turu) varsayılan DURUR: mevcut uptime uygulamamız
// ölçmeye devam ediyor, çift kontrolcülük olmasın. Açmak için MOON_CHECKER=1.
if (process.env.MOON_CHECKER === "1") {
  startChecker(io);
} else {
  console.log("[moon] checker disabled — set MOON_CHECKER=1 to enable");
}

server.listen(PORT, "0.0.0.0", () => console.log(`moon ready on :${PORT}`));
