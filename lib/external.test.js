import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { Monitor, Check, Group } from "./models.js";
import { externalEndpoint, externalSummary } from "./external.js";

// /api/external/summary eşleniği: Bearer token korumalı, 401 davranışı, yanıtta
// URL/IP/hata metni SIZMAZ (yalnız name+group+status+son ölçüm), stale sayımı doğru.

const URI = process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27018/moon_external_test";
const TOKEN = "test-service-token-123";

function fakeEndpoint(path, token = null) {
  const req = { url: path, method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} };
  const parts = [];
  let code = null;
  const res = {
    writeHead: (c) => (code = c),
    end: (b) => parts.push(b),
  };
  return { req, res, result: async () => ({ code, body: parts.length ? JSON.parse(parts[0]) : null }) };
}

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await Check.syncIndexes();
  const group = await Group.create({ name: "yonetim", order: 0 });
  const now = new Date();
  await Monitor.create([
    { name: "canli site", group: group._id, url: "https://gizli-canli-adres.sistem.com/", order: 0, status: "up", interval: 900, lastCheckedAt: now },
    { name: "kopya panel", group: group._id, url: "http://192.168.1.55:40072/gizli", order: 1, status: "down", interval: 900, lastCheckedAt: now, consecutiveFailures: 5 },
    { name: "bayat service", url: "https://baska-gizli.example.net/x", order: 2, status: "up", interval: 900, lastCheckedAt: new Date(now.getTime() - 30 * 60_000) },
    { name: "kapali monitor", url: "https://kapali-gizli.example.net/", order: 3, enabled: false, status: "pending", interval: 900 },
  ]);
  const [live, copy, stale] = await Monitor.find().sort({ order: 1 }).lean();
  await Check.create([
    { monitor: live._id, at: now, ms: 120, status: 200, ok: true, confirmed: true, ip: "10.0.0.1", error: "gizli hata metni" },
    { monitor: copy._id, at: now, ms: 0, status: 0, ok: false, confirmed: true, ip: "10.0.0.2", error: "gizli hata metni" },
    { monitor: stale._id, at: new Date(now.getTime() - 30 * 60_000), ms: 90, status: 200, ok: true, confirmed: true },
  ]);
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("externalSummary: counts and the stale definition", async () => {
  const summary = await externalSummary();
  assert.equal(summary.total, 4);
  assert.equal(summary.up, 2);
  assert.equal(summary.down, 1);
  assert.equal(summary.stale, 1, "yarım saat ölçülmeyen stale olmalı");
  const stale = summary.monitors.find((m) => m.name === "bayat service");
  assert.ok(stale, "stale monitör listede olmalı");
  assert.equal(stale.lastCheck.ok, true);
  assert.equal(stale.stale, true, "stale monitör bayraklı olmalı");
  const fresh = summary.monitors.find((m) => m.name === "canli site");
  assert.equal(fresh.stale, false, "taze monitör bayraksız olmalı");
  const disabled = summary.monitors.find((m) => m.name === "kapali monitor");
  assert.equal(disabled.status, "disabled", "enabled=false monitör 'disabled' görünmeli");
  assert.equal(disabled.stale, false, "kapalı monitör bilinçli olarak kapalı → stale değil");
});

test("externalSummary: response keys are English (bozma-dil)", async () => {
  const summary = await externalSummary();
  assert.deepEqual(Object.keys(summary).sort(), ["down", "monitors", "stale", "total", "up"].sort());
  for (const m of summary.monitors) {
    assert.deepEqual(Object.keys(m).sort(), ["group", "lastCheck", "name", "stale", "status"].sort());
  }
});

test("externalSummary: URL, IP and error text DO NOT LEAK (bozma-privacy)", async () => {
  const text = JSON.stringify(await externalSummary());
  assert.ok(!text.includes("gizli-canli-adres"), "URL sızmamalı");
  assert.ok(!text.includes("192.168.1.55"), "iç IP sızmamalı");
  assert.ok(!text.includes("gizli hata metni"), "hata metni sızmamalı");
  assert.ok(!text.includes("10.0.0."), "cevaplayan IP sızmamalı");
  assert.ok(!/"url"/.test(text), "url alanı hiç olmamalı");
  for (const m of (await externalSummary()).monitors) {
    assert.ok(!("url" in m), "monitör özetinde url alanı olmamalı");
  }
});

test("externalEndpoint: no token → endpoint closed (404)", async () => {
  const old = process.env.MOON_SERVICE_TOKEN;
  delete process.env.MOON_SERVICE_TOKEN;
  try {
    const { req, res, result } = fakeEndpoint("/api/external/summary");
    assert.equal(await externalEndpoint(req, res), true);
    assert.equal((await result()).code, 404);
  } finally {
    process.env.MOON_SERVICE_TOKEN = old;
  }
});

test("externalEndpoint: wrong/missing token → 401 (bozma-token)", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  const { req, res, result } = fakeEndpoint("/api/external/summary", "wrong-token");
  assert.equal(await externalEndpoint(req, res), true);
  assert.equal((await result()).code, 401);

  const headerless = fakeEndpoint("/api/external/summary");
  assert.equal(await externalEndpoint(headerless.req, headerless.res), true);
  assert.equal((await headerless.result()).code, 401);
});

test("externalEndpoint: correct token → 200 + summary body", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  const { req, res, result } = fakeEndpoint("/api/external/summary", TOKEN);
  assert.equal(await externalEndpoint(req, res), true);
  const { code, body } = await result();
  assert.equal(code, 200);
  assert.equal(body.total, 4);
  assert.ok(Array.isArray(body.monitors));
});

test("externalEndpoint: the legacy path /api/disis/ozet no longer belongs to this endpoint", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  const legacy = fakeEndpoint("/api/disis/ozet", TOKEN);
  assert.equal(await externalEndpoint(legacy.req, legacy.res), false, "eski yol uca ait değil (server.js 307 ile yönlenir)");
  const post = { url: "/api/external/summary", method: "POST", headers: {} };
  assert.equal(await externalEndpoint(post, { writeHead() {}, end() {} }), false);
});
