import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import mongoose from "mongoose";
import { Monitor, Check, Group, HostReport, HostServiceSetting, SslAlert } from "./models.js";
import { sweep, sslAlertEvent } from "./checker.js";
import { NotifyQueue } from "./notify.js";
import { dispatchReportAlerts } from "./hostAlerts.js";
import { storeHostReport, parseHostReport, hostsWire } from "./hostReport.js";
import { settingsEndpoint } from "./settingsApi.js";
import { parseMonitor } from "./monitorInput.js";

// Per-monitor / per-host-service notification settings, end to end:
//   • a muted monitor still goes down in the records — only the message is skipped
//   • grouped (5 min) messages leave the muted monitor out
//   • SSL expiry is a separate switch (and does not burn the daily lock when muted)
//   • records without the field keep notifying (no migration)
//   • host services: panel setting OR host-agent alerts:false silences
//   • the HTTP settings API validates strictly (400 on unknown channel/event)
// Fake servers and injected senders only — NO real WhatsApp/network traffic.
// Names are synthetic (the repo is public).

process.env.MOON_RETRY_DELAY_MS = "10";
process.env.MOON_NOTIFY_CONF = "/nonexistent/notify.conf.json"; // belt and braces: the real bridge can never be configured here
const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_notifymute_test`;

let server;
let port;
const URL = (path) => `http://127.0.0.1:${port}${path}`;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200);
      res.end("fine");
    } else {
      res.writeHead(500);
      res.end("boom");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  process.env.MOON_CANARY_URLS = URL("/ok"); // the canary also hits the fake server
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await HostReport.syncIndexes();
  await HostServiceSetting.syncIndexes();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  server.close();
  delete process.env.MOON_RETRY_DELAY_MS;
  delete process.env.MOON_CANARY_URLS;
  delete process.env.MOON_NOTIFY_CONF;
});

test.beforeEach(async () => {
  await Promise.all([Monitor.deleteMany({}), Check.deleteMany({}), Group.deleteMany({}), SslAlert.deleteMany({}), HostReport.deleteMany({}), HostServiceSetting.deleteMany({})]);
});

// a queue that records what WOULD have been sent (real grouping + real group stats from Mongo)
const recordingQueue = () => {
  const sent = [];
  const queue = new NotifyQueue({ windowMs: 50, send: async (text) => sent.push(text) });
  return { queue, sent };
};

// one failure away from "down" (3 confirm cycles), or down and about to recover
const failing = (fields) => ({ url: URL("/fail"), interval: 900, status: "up", consecutiveFailures: 2, ...fields });
const recovering = (fields) => ({ url: URL("/ok"), interval: 900, status: "down", consecutiveFailures: 3, ...fields });

// ——— schema ———

test("schema: the notification path exists for every channel/event (mongoose drops unknown fields silently)", () => {
  for (const p of ["whatsapp.enabled", "whatsapp.events.down", "whatsapp.events.recovery", "whatsapp.events.ssl"]) {
    assert.ok(Monitor.schema.path(`notifications.${p}`), `monitor notifications.${p}`);
  }
  for (const p of ["whatsapp.enabled", "whatsapp.events.down", "whatsapp.events.recovery"]) {
    assert.ok(HostServiceSetting.schema.path(`notifications.${p}`), `host service notifications.${p}`);
  }
  assert.equal(HostServiceSetting.schema.path("notifications.whatsapp.events.ssl"), undefined, "host services have no SSL event");
});

test("schema: settings round-trip, and a record without the field stays without it", async () => {
  const m = await Monitor.create({ name: "svc-a", url: URL("/ok"), notifications: { whatsapp: { enabled: false, events: { ssl: false } } } });
  const stored = await Monitor.findById(m._id).lean();
  assert.equal(stored.notifications.whatsapp.enabled, false);
  assert.equal(stored.notifications.whatsapp.events.ssl, false);

  const plain = await Monitor.create({ name: "svc-b", url: URL("/ok") });
  const raw = await Monitor.collection.findOne({ _id: plain._id });
  assert.equal(raw.notifications, undefined, "no default is written — absent means on");
});

// ——— monitors: send path ———

test("muted monitor goes down: status and check ARE recorded, NO message", async () => {
  const muted = await Monitor.create(failing({ name: "svc-muted", notifications: { whatsapp: { enabled: false } } }));
  const loud = await Monitor.create(failing({ name: "svc-loud" }));
  const { queue, sent } = recordingQueue();

  const r = await sweep({ queue });
  await queue.flushAll();
  assert.equal(r.measured, 2);

  const mutedDoc = await Monitor.findById(muted._id).lean();
  assert.equal(mutedDoc.status, "down", "the state is still recorded");
  const check = await Check.findOne({ monitor: muted._id }).lean();
  assert.equal(check.ok, false);
  assert.equal(check.confirmed, true);
  assert.equal((await Monitor.findById(loud._id).lean()).status, "down");

  assert.equal(sent.length, 1, "only the unmuted monitor is announced");
  assert.match(sent[0], /DOWN: svc-loud/);
  assert.ok(!sent.some((t) => t.includes("svc-muted")));
});

test("record without the notifications field (old monitor) still notifies", async () => {
  const res = await Monitor.collection.insertOne({
    ...failing({ name: "svc-legacy" }),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal((await Monitor.collection.findOne({ _id: res.insertedId })).notifications, undefined);
  const { queue, sent } = recordingQueue();
  await sweep({ queue });
  await queue.flushAll();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /DOWN: svc-legacy/);
});

test("down and recovery are separate switches", async () => {
  const m = await Monitor.create(failing({ name: "svc-event", notifications: { whatsapp: { enabled: true, events: { recovery: false } } } }));
  const { queue, sent } = recordingQueue();

  await sweep({ queue });
  await queue.flushAll();
  assert.equal(sent.length, 1, "down still announced");
  assert.match(sent[0], /DOWN: svc-event/);

  // the URL comes back
  await Monitor.updateOne({ _id: m._id }, { url: URL("/ok"), lastCheckedAt: new Date(Date.now() - 120_000) });
  await sweep({ queue });
  await queue.flushAll();
  assert.equal((await Monitor.findById(m._id).lean()).status, "up", "recovery recorded");
  assert.equal(sent.length, 1, "recovery message muted");
});

test("down muted but recovery on: the recovery message still goes", async () => {
  await Monitor.create(recovering({ name: "svc-up-only", notifications: { whatsapp: { enabled: true, events: { down: false } } } }));
  const { queue, sent } = recordingQueue();
  await sweep({ queue });
  await queue.flushAll();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /UP: svc-up-only/);
});

test("grouped message: the muted monitor leaves the list and the counts", async () => {
  const g = await Group.create({ name: "grp-x" });
  await Monitor.create(failing({ name: "svc-alpha", group: g._id }));
  await Monitor.create(failing({ name: "svc-muted", group: g._id, notifications: { whatsapp: { enabled: false } } }));
  await Monitor.create(failing({ name: "svc-gamma", group: g._id }));
  await Monitor.create({ name: "svc-delta", group: g._id, url: URL("/ok"), status: "up", interval: 900 });
  const { queue, sent } = recordingQueue();

  await sweep({ queue });
  await queue.flushAll();

  assert.equal(sent.length, 1, "one grouped message");
  assert.match(sent[0], /grp-x grubu: 2\/3 site kapalı: svc-alpha, svc-gamma/, "2 of the 3 monitors that notify");
  assert.ok(!sent[0].includes("svc-muted"), "the muted monitor's name never reaches the message");
  assert.ok(!/3\/4/.test(sent[0]));

  // the monitor is still down in the records
  assert.equal((await Monitor.findOne({ name: "svc-muted" }).lean()).status, "down");

  // recovery message is grouped the same way
  await Monitor.updateMany({ name: { $ne: "svc-delta" } }, { url: URL("/ok"), lastCheckedAt: new Date(Date.now() - 120_000) });
  await sweep({ queue });
  await queue.flushAll();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /grp-x grubu: 2\/3 site tekrar çalışıyor: svc-alpha, svc-gamma/);
  assert.ok(!sent[1].includes("svc-muted"));
});

test("a group whose monitors are all muted sends nothing", async () => {
  const g = await Group.create({ name: "grp-y" });
  const off = { whatsapp: { enabled: false } };
  await Monitor.create(failing({ name: "svc-one", group: g._id, notifications: off }));
  await Monitor.create(failing({ name: "svc-two", group: g._id, notifications: off }));
  const { queue, sent } = recordingQueue();
  await sweep({ queue });
  await queue.flushAll();
  assert.deepEqual(sent, []);
  assert.equal(await Monitor.countDocuments({ status: "down" }), 2, "both are down in the records");
});

// ——— SSL ———

const cert = (days) => ({ expires: new Date(Date.now() + days * 86_400_000), issuer: "Example CA", subject: "svc-ssl" });

test("SSL expiry is a separate switch: muted → no message and the daily lock is NOT consumed", async () => {
  const mutedSsl = { whatsapp: { enabled: true, events: { ssl: false } } };
  assert.equal(await sslAlertEvent("m1", "svc-ssl", cert(3), mutedSsl), null);
  assert.equal(await SslAlert.countDocuments(), 0, "muted alert must not burn today's lock");

  // switched back on the same day → the alert still comes
  const text = await sslAlertEvent("m1", "svc-ssl", cert(3), { whatsapp: { enabled: true, events: { ssl: true } } });
  assert.match(text, /SSL: svc-ssl sertifikası 3 gün sonra bitiyor/);
  assert.equal(await SslAlert.countDocuments(), 1);
  assert.equal(await sslAlertEvent("m1", "svc-ssl", cert(3), undefined), null, "second call the same day: locked");
  // and the channel switch silences SSL as well
  assert.equal(await sslAlertEvent("m2", "svc-ssl", cert(3), { whatsapp: { enabled: false } }), null);
  // old record without the field
  assert.ok(await sslAlertEvent("m3", "svc-ssl", cert(3), undefined));
});

test("queue: SSL muted while down/recovery still go (and the reverse)", async () => {
  const sent = [];
  const queue = new NotifyQueue({ windowMs: 50, send: async (t) => sent.push(t), stats: async () => ({ size: new Map(), down: new Map() }) });
  const sslOff = { whatsapp: { enabled: true, events: { ssl: false } } };
  const ts = "2026-11-21T10:00:00+00:00";

  await queue.add(["ssl", "⚠️ SSL: svc-ssl sertifikası 3 gün sonra bitiyor", sslOff]);
  await queue.add(["down", { name: "svc-ssl", group: null, reason: "HTTP 500", ts }, sslOff]);
  await queue.add(["up", { name: "svc-ssl", group: null, ts, ms: 12 }, sslOff]);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /DOWN: svc-ssl/);
  assert.match(sent[1], /UP: svc-ssl/);

  sent.length = 0;
  const downRecoveryOff = { whatsapp: { enabled: true, events: { down: false, recovery: false } } };
  await queue.add(["ssl", "⚠️ SSL: svc-ssl sertifikası 3 gün sonra bitiyor", downRecoveryOff]);
  await queue.add(["down", { name: "svc-ssl", group: null, reason: "HTTP 500", ts }, downRecoveryOff]);
  assert.equal(sent.length, 1, "only the SSL message");
  assert.match(sent[0], /SSL: svc-ssl/);
});

test("queue: events without a settings element (older callers) are sent", async () => {
  const sent = [];
  const queue = new NotifyQueue({ windowMs: 50, send: async (t) => sent.push(t), stats: async () => ({ size: new Map(), down: new Map() }) });
  await queue.add(["ssl", "⚠️ SSL: svc-old sertifikası 1 gün sonra bitiyor"]);
  await queue.add(["down", { name: "svc-old", group: null, reason: "x", ts: "t" }]);
  assert.equal(sent.length, 2);
});

test("queue: a channel the queue does not serve is judged by its own setting", async () => {
  const sent = [];
  const queue = new NotifyQueue({ channel: "whatsapp", windowMs: 50, send: async (t) => sent.push(t), stats: async () => ({ size: new Map(), down: new Map() }) });
  // a setting for some other (future) channel does not mute WhatsApp
  await queue.add(["down", { name: "svc-x", group: null, reason: "x", ts: "t" }, { email: { enabled: false } }]);
  assert.equal(sent.length, 1);
});

// ——— monitor add/edit payload ———

test("parseMonitor: notifications are validated; omitted means 'leave as stored'", () => {
  const base = { url: "https://example.com/health", name: "svc-form" };
  assert.equal(parseMonitor(base).notifications, undefined, "omitted → not touched");
  const ok = parseMonitor({ ...base, notifications: { whatsapp: { enabled: false } } }, { whatsapp: { enabled: true, events: { ssl: false } } });
  assert.deepEqual(ok.notifications, { whatsapp: { enabled: false, events: { down: true, recovery: true, ssl: false } } }, "merged onto the stored settings");
  assert.match(parseMonitor({ ...base, notifications: { telegram: {} } }).error, /Unknown notification channel/);
  assert.match(parseMonitor({ ...base, notifications: { whatsapp: { events: { down: "off" } } } }).error, /must be true or false/);
  assert.match(parseMonitor({ ...base, notifications: "off" }).error, /must be an object/);
});

// ——— host services ———

const reportOf = (services) => parseHostReport({ host: { name: "host-x" }, services }).report;
const svc = (name, status, extra = {}) => ({ name, status, ...(status === "down" ? { detail: "refused" } : { ms: 5 }), ...extra });

async function firstReport(services) {
  const { prev } = await storeHostReport(reportOf(services));
  return prev;
}
async function nextReport(prev, services) {
  const report = reportOf(services);
  const sent = [];
  await dispatchReportAlerts(prev, report, { send: async (t) => sent.push(t) });
  return sent;
}
const setting = (service, notifications, host = "host-x") => HostServiceSetting.create({ host, service, notifications });

test("host service: panel setting off (channel) silences down AND recovery; unmuted siblings still notify", async () => {
  await firstReport([svc("svc-a", "up"), svc("svc-b", "up")]);
  await HostReport.updateOne({ "host.name": "host-x" }, { $set: { at: new Date(0) } }); // allow the next store
  await setting("svc-a", { whatsapp: { enabled: false } });
  const prev = await HostReport.findOne({ "host.name": "host-x" }).lean();

  const down = await nextReport(prev, [svc("svc-a", "down"), svc("svc-b", "down")]);
  assert.equal(down.length, 1);
  assert.match(down[0], /svc-b düştü/);
  assert.ok(!down[0].includes("svc-a"));

  const prevDown = { services: [svc("svc-a", "down"), svc("svc-b", "down")] };
  const up = await nextReport(prevDown, [svc("svc-a", "up"), svc("svc-b", "up")]);
  assert.equal(up.length, 1);
  assert.match(up[0], /svc-b toparlandı/);
});

test("host service: events are separate (down off, recovery on)", async () => {
  await setting("svc-a", { whatsapp: { enabled: true, events: { down: false } } });
  const down = await nextReport({ services: [svc("svc-a", "up")] }, [svc("svc-a", "down")]);
  assert.deepEqual(down, []);
  const up = await nextReport({ services: [svc("svc-a", "down")] }, [svc("svc-a", "up")]);
  assert.equal(up.length, 1);
  assert.match(up[0], /svc-a toparlandı/);
});

test("host service: host-agent alerts:false still silences (backward compatible), with no panel setting", async () => {
  const down = await nextReport({ services: [svc("svc-a", "up")] }, [svc("svc-a", "down", { alerts: false })]);
  assert.deepEqual(down, []);
  const up = await nextReport({ services: [svc("svc-a", "down")] }, [svc("svc-a", "up", { alerts: false })]);
  assert.deepEqual(up, []);
});

test("host service: panel ON but host-agent alerts:false → silent (the agent flag wins)", async () => {
  await setting("svc-a", { whatsapp: { enabled: true, events: { down: true, recovery: true } } });
  const down = await nextReport({ services: [svc("svc-a", "up")] }, [svc("svc-a", "down", { alerts: false })]);
  assert.deepEqual(down, []);
});

test("host service: no setting at all → announced; another host's setting does not leak", async () => {
  await setting("svc-a", { whatsapp: { enabled: false } }, "host-other");
  const down = await nextReport({ services: [svc("svc-a", "up")] }, [svc("svc-a", "down")]);
  assert.equal(down.length, 1);
  assert.match(down[0], /svc-a düştü/);
});

test("host service: muting does not change the stored state or the panel data", async () => {
  await firstReport([svc("svc-a", "up")]);
  await setting("svc-a", { whatsapp: { enabled: false } });
  await HostReport.updateOne({ "host.name": "host-x" }, { $set: { at: new Date(0) } });
  const { stored } = await storeHostReport(reportOf([svc("svc-a", "down", { alerts: false })]));
  assert.equal(stored, true);
  const [host] = await hostsWire();
  const s = host.services[0];
  assert.equal(s.status, "down", "state still reported");
  assert.equal(s.agentMuted, true, "panel can say 'off via host-agent setting'");
  assert.equal(s.notifications.whatsapp.enabled, false, "panel setting is reported too");
});

// ——— HTTP settings API ———

function request(base, method, path, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

async function withApi(run) {
  const changes = [];
  const api = http.createServer(async (req, res) => {
    const handled = await settingsEndpoint(req, res, {
      verify: async (r) => (r.headers["x-test-session"] === "1" ? { email: "someone@example.com" } : null),
      onChange: async (kind) => changes.push(kind),
    });
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${api.address().port}`, changes);
  } finally {
    api.close();
  }
}

const AUTH = { "x-test-session": "1" };

test("API: monitor settings — 200 persists and merges; broadcast fired", async () => {
  const m = await Monitor.create({ name: "svc-api", url: URL("/ok") });
  await withApi(async (base, changes) => {
    let r = await request(base, "PATCH", `/api/monitors/${m._id}/notifications`, { headers: AUTH, body: { whatsapp: { enabled: false } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.notifications.whatsapp.enabled, false);
    assert.equal((await Monitor.findById(m._id).lean()).notifications.whatsapp.enabled, false);

    r = await request(base, "PATCH", `/api/monitors/${m._id}/notifications`, { headers: AUTH, body: { whatsapp: { enabled: true, events: { ssl: false } } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.notifications, { whatsapp: { enabled: true, events: { down: true, recovery: true, ssl: false } } });
    assert.deepEqual(changes, ["monitor", "monitor"]);
  });
});

test("API: invalid keys/values → 400 and nothing is stored", async () => {
  const m = await Monitor.create({ name: "svc-api", url: URL("/ok"), notifications: { whatsapp: { enabled: true, events: { down: true } } } });
  await withApi(async (base, changes) => {
    const bad = [
      [{ telegram: { enabled: false } }, /Unknown notification channel/],
      [{ whatsapp: { events: { sms: false } } }, /Unknown notification event/],
      [{ whatsapp: { enabled: "false" } }, /must be true or false/],
      [{ whatsapp: { events: { down: null } } }, /must be true or false/],
      [{ whatsapp: { loud: true } }, /Unknown setting/],
      [[], /must be an object/],
    ];
    for (const [body, message] of bad) {
      const r = await request(base, "PATCH", `/api/monitors/${m._id}/notifications`, { headers: AUTH, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, message);
    }
    const garbage = await request(base, "PATCH", `/api/monitors/${m._id}/notifications`, { headers: AUTH, raw: "{not json" });
    assert.equal(garbage.status, 400);
    const stored = await Monitor.findById(m._id).lean();
    assert.deepEqual(stored.notifications.whatsapp.enabled, true, "failed requests leave the settings alone");
    assert.deepEqual(changes, []);
  });
});

test("API: 401 without a session, 403 for a foreign Origin, 404 unknown monitor, 405 wrong verb", async () => {
  const m = await Monitor.create({ name: "svc-api", url: URL("/ok") });
  await withApi(async (base) => {
    const body = { whatsapp: { enabled: false } };
    assert.equal((await request(base, "PATCH", `/api/monitors/${m._id}/notifications`, { body })).status, 401);
    const foreign = await request(base, "PATCH", `/api/monitors/${m._id}/notifications`, { body, headers: { ...AUTH, origin: "https://evil.example.com" } });
    assert.equal(foreign.status, 403);
    assert.equal((await request(base, "PATCH", "/api/monitors/64b64b64b64b64b64b64b64b/notifications", { body, headers: AUTH })).status, 404);
    assert.equal((await request(base, "PATCH", "/api/monitors/not-an-id/notifications", { body, headers: AUTH })).status, 404);
    assert.equal((await request(base, "PATCH", "/api/monitors/%E0%A4%A/notifications", { body, headers: AUTH })).status, 404, "malformed escape does not crash");
    assert.equal((await request(base, "GET", `/api/monitors/${m._id}/notifications`, { headers: AUTH })).status, 405);
    assert.equal((await Monitor.findById(m._id).lean()).notifications, undefined, "nothing was written");
  });
});

test("API: host service settings — only a service the host reports; no SSL event; persisted", async () => {
  await firstReport([svc("svc-a", "up")]);
  await withApi(async (base, changes) => {
    const path = "/api/host-services/notifications";
    let r = await request(base, "PATCH", path, { headers: AUTH, body: { host: "host-x", service: "svc-gone", notifications: { whatsapp: { enabled: false } } } });
    assert.equal(r.status, 404);
    r = await request(base, "PATCH", path, { headers: AUTH, body: { host: "host-none", service: "svc-a", notifications: {} } });
    assert.equal(r.status, 404);
    r = await request(base, "PATCH", path, { headers: AUTH, body: { host: "host-x", service: "svc-a", notifications: { whatsapp: { events: { ssl: false } } } } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unknown notification event: ssl/);
    r = await request(base, "PATCH", path, { headers: AUTH, body: { host: "host-x" } });
    assert.equal(r.status, 400, "service name missing");
    assert.equal(await HostServiceSetting.countDocuments(), 0);

    r = await request(base, "PATCH", path, { headers: AUTH, body: { host: "host-x", service: "svc-a", notifications: { whatsapp: { events: { down: false } } } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.notifications, { whatsapp: { enabled: true, events: { down: false, recovery: true } } });
    r = await request(base, "PATCH", path, { headers: AUTH, body: { host: "host-x", service: "svc-a", notifications: { whatsapp: { enabled: false } } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.notifications.whatsapp.events.down, false, "merged onto the previous setting");
    assert.equal(await HostServiceSetting.countDocuments(), 1, "one record per (host, service)");
    assert.deepEqual(changes, ["hostService", "hostService"]);
    assert.equal((await request(base, "PATCH", path, { body: { host: "host-x", service: "svc-a", notifications: {} } })).status, 401);
  });
});
