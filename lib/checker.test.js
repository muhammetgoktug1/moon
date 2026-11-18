import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import mongoose from "mongoose";
import { Monitor, Check, Group } from "./models.js";
import { measure, sweep, effectiveInterval, CONSTANTS, UA } from "./checker.js";

// Kontrolcü kuralları — SAHTE SUNUCULARLA (canlı ölçüm yok; test/canlı disiplini).
// Kapsam: 3 onay döngüsü, toparlanma, kanarya iptali, monitör başına interval,
// down 60 sn hata aralığı, ≤8 paralel, keyword (ilk 300 KB), expectedStatus,
// GET/HEAD/POST, faz kırılımı + IP, TTL 90 gün, onaysız check confirmed=false.

process.env.MOON_RETRY_DELAY_MS = "10"; // denemeler arası 3 sn → 10 ms (yalnız test)
const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_checker_test`;

// --- sahte sunucu ---
let server;
let port;
const counter = { requests: new Map(), peak: 0, inflight: 0 };

function count(path) {
  counter.requests.set(path, (counter.requests.get(path) || 0) + 1);
  counter.inflight++;
  counter.peak = Math.max(counter.peak, counter.inflight);
  return () => counter.inflight--;
}

const KEYWORD = "MERHABA-DUNYA";
const WALLET = "x".repeat(400 * 1024); // keyword 300 KB sınırının ÖTESİNDE

test.before(async () => {
  server = http.createServer((req, res) => {
    const done = count(req.url);
    res.on("finish", done); // eşzamanlılık: istek yaşam süresi boyunca açık sayılır
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${KEYWORD} canli</body></html>`);
    } else if (req.url === "/fail") {
      res.writeHead(500);
      res.end("boom");
    } else if (req.url === "/no-keyword") {
      res.writeHead(200);
      res.end("baska icerik");
    } else if (req.url === "/keyword-far") {
      res.writeHead(200);
      res.end(WALLET.slice(0, 350 * 1024) + KEYWORD); // kelime 300 KB'dan sonra
    } else if (req.url === "/401") {
      res.writeHead(401);
      res.end("gizli");
    } else if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 250);
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  // kanarya da sahte sunucuya bağlanır — testler dış ağa çıkmasın (test/canlı disiplini)
  process.env.MOON_CANARY_URLS = `http://127.0.0.1:${port}/ok`;

  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await Check.syncIndexes();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  server.close();
  delete process.env.MOON_RETRY_DELAY_MS;
  delete process.env.MOON_CANARY_URLS;
});

const URL = (path) => `http://127.0.0.1:${port}${path}`;
const noSend = { add: async () => {} };

// önceki testlerin monitörlerini due-dışı bırak (monitör başına interval testi için)
const refreshAll = () => Monitor.updateMany({}, { lastCheckedAt: new Date() });

async function createMonitor(fields = {}) {
  return Monitor.create({ name: "test", url: URL("/ok"), interval: 900, ...fields });
}

// --- birim: ölçüm kuralları ---

test("measure: 200 success, phase breakdown and answering IP filled", async () => {
  const m = { url: URL("/ok"), method: "GET" };
  const s = await measure(m);
  assert.equal(s.check.ok, true);
  assert.equal(s.check.status, 200);
  assert.ok(s.check.ip.length > 0, "cevaplayan IP dolmalı");
  assert.ok(s.check.phases, "faz kırılımı dolmalı");
  assert.ok(s.check.phases.dns >= 0 && s.check.phases.tcp >= 0 && s.check.phases.server >= 0);
});

test("measure: UA is the panel value (HermesPanel-Uptime/1.0)", async () => {
  assert.equal(UA, "HermesPanel-Uptime/1.0 (+uptime-monitor)");
  let seen = "";
  const s = http.createServer((req, res) => {
    seen = req.headers["user-agent"];
    res.writeHead(200);
    res.end();
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  await measure({ url: `http://127.0.0.1:${s.address().port}/`, method: "GET" });
  s.close();
  assert.equal(seen, UA);
});

test("measure: keyword present → success; absent → failure + 'anahtar kelime yok' (bozma-keyword)", async () => {
  const present = await measure({ url: URL("/ok"), method: "GET", keyword: KEYWORD });
  assert.equal(present.check.ok, true);
  const absent = await measure({ url: URL("/no-keyword"), method: "GET", keyword: KEYWORD });
  assert.equal(absent.check.ok, false);
  assert.match(absent.check.error, /^anahtar kelime yok: MERHABA-DUNYA/);
  // büyük/küçük duyarsız
  const lower = await measure({ url: URL("/ok"), method: "GET", keyword: KEYWORD.toLowerCase() });
  assert.equal(lower.check.ok, true);
});

test("measure: keyword beyond the 300 KB LIMIT is not found → failure", async () => {
  const s = await measure({ url: URL("/keyword-far"), method: "GET", keyword: KEYWORD });
  assert.equal(s.check.ok, false, "ilk 300 KB'da olmayan kelime başarısız sayılmalı");
  assert.match(s.check.error, /^anahtar kelime yok/);
});

test("measure: expectedStatus set → ONLY that code succeeds (401 → ok)", async () => {
  const withExpected = await measure({ url: URL("/401"), method: "GET", expectedStatus: 401 });
  assert.equal(withExpected.check.ok, true);
  assert.equal(withExpected.check.status, 401);
  const withoutExpected = await measure({ url: URL("/401"), method: "GET" });
  assert.equal(withoutExpected.check.ok, false);
  assert.equal(withoutExpected.check.error, "HTTP 401");
  const wrongExpected = await measure({ url: URL("/ok"), method: "GET", expectedStatus: 401 });
  assert.equal(wrongExpected.check.ok, false);
  assert.match(wrongExpected.check.error, /beklenen 401/);
});

test("measure: HEAD and POST + body supported", async () => {
  const head = await measure({ url: URL("/ok"), method: "HEAD" });
  assert.equal(head.check.ok, true);
  const post = await measure({ url: URL("/ok"), method: "POST", body: '{"a":1}' });
  assert.equal(post.check.ok, true);
});

test("measure: failing request retried 3 times (first success = up)", async () => {
  counter.requests.set("/fail", 0);
  const s = await measure({ url: URL("/fail"), method: "GET" });
  assert.equal(s.check.ok, false);
  assert.equal(counter.requests.get("/fail"), 3, "3 deneme yapılmalı");
});

test("measure: redirect followed, target page content checked", async () => {
  const s = await measure({ url: URL("/redirect"), method: "GET", keyword: KEYWORD });
  assert.equal(s.check.ok, true);
  assert.equal(s.check.error, "");
});

// --- birim: etkin aralık ---

test("effectiveInterval: min(interval, 60) while failing; interval when healthy", () => {
  assert.equal(effectiveInterval({ interval: 900, consecutiveFailures: 0 }), 900);
  assert.equal(effectiveInterval({ interval: 900, consecutiveFailures: 2 }), 60);
  assert.equal(effectiveInterval({ interval: 30, consecutiveFailures: 1 }), 30);
});

// --- entegrasyon: sweep ---

test("sweep: 3 confirm cycles — first failure is NOT down (bozma-3onay)", async () => {
  const m = await createMonitor({ url: URL("/fail"), name: "uc-onay" });
  const queue = { events: [], add: async (e) => queue.events.push(e) };

  const t1 = await sweep({ queue });
  assert.equal(t1.measured, 1);
  assert.equal(t1.canary, true);
  let doc = await Monitor.findById(m._id).lean();
  assert.equal(doc.consecutiveFailures, 1);
  assert.notEqual(doc.status, "down", "tek hata down ilan etmemeli");
  let checks = await Check.find({ monitor: m._id }).lean();
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.equal(checks[0].confirmed, false, "onaysız başarısızlık confirmed=false");

  // 2. tur: hâlâ down değil
  await Monitor.updateOne({ _id: m._id }, { lastCheckedAt: new Date(Date.now() - 61_000) });
  await sweep({ queue });
  doc = await Monitor.findById(m._id).lean();
  assert.equal(doc.consecutiveFailures, 2);
  assert.notEqual(doc.status, "down", "iki hata da down ilan etmemeli");

  // 3. tur: ONAYLI down + tek bildirim olayı
  await Monitor.updateOne({ _id: m._id }, { lastCheckedAt: new Date(Date.now() - 61_000) });
  const t3 = await sweep({ queue });
  doc = await Monitor.findById(m._id).lean();
  assert.equal(doc.status, "down");
  assert.equal(doc.consecutiveFailures, 3);
  const confirmedChecks = await Check.find({ monitor: m._id }).sort({ at: 1 }).lean();
  assert.equal(confirmedChecks.length, 3);
  assert.equal(confirmedChecks[0].confirmed, false);
  assert.equal(confirmedChecks[1].confirmed, false);
  assert.equal(confirmedChecks[2].confirmed, true, "3. turda onaylı");
  const downs = queue.events.filter(([kind]) => kind === "down");
  assert.equal(downs.length, 1, "down bildirimi YALNIZ onay turunda bir kez");

  // 4. tur: down sürüyor → YENİ down bildirimi yok
  await Monitor.updateOne({ _id: m._id }, { lastCheckedAt: new Date(Date.now() - 61_000) });
  await sweep({ queue });
  assert.equal(queue.events.filter(([kind]) => kind === "down").length, 1);
});

test("sweep: recovery — 1 success flips up and sends the event", async () => {
  const m = await createMonitor({ url: URL("/ok"), name: "toparlanma", status: "down", consecutiveFailures: 4 });
  const queue = { events: [], add: async (e) => queue.events.push(e) };
  await sweep({ queue });
  const doc = await Monitor.findById(m._id).lean();
  assert.equal(doc.status, "up");
  assert.equal(doc.consecutiveFailures, 0);
  const ups = queue.events.filter(([kind]) => kind === "up");
  assert.equal(ups.length, 1);
  assert.equal(ups[0][1].name, "toparlanma");
});

test("sweep: canary down → sweep CANCELLED — no measurement, no events (bozma-kanarya)", async () => {
  const previous = process.env.MOON_CANARY_URLS;
  process.env.MOON_CANARY_URLS = "http://127.0.0.1:9/yok1,http://127.0.0.1:9/yok2"; // erişilemez
  try {
    const m = await createMonitor({ url: URL("/ok"), name: "kanarya-denem" });
    const queue = { events: [], add: async (e) => queue.events.push(e) };
    const result = await sweep({ queue });
    assert.equal(result.canary, false);
    assert.equal(result.measured, 0);
    assert.equal(await Check.countDocuments({ monitor: m._id }), 0, "tur iptal: check YAZILMAMALI");
    assert.equal(queue.events.length, 0);
    const doc = await Monitor.findById(m._id).lean();
    assert.equal(doc.status, "pending", "site düşmüş sayılmaz");
  } finally {
    if (previous === undefined) delete process.env.MOON_CANARY_URLS;
    else process.env.MOON_CANARY_URLS = previous;
  }
});

test("sweep: per-monitor interval — not due yet → not measured", async () => {
  await refreshAll();
  const fresh = await createMonitor({ name: "taze", lastCheckedAt: new Date(Date.now() - 5_000) });
  const result = await sweep({ queue: noSend });
  assert.equal(result.measured, 0, "yarım dakika önce ölçülen (interval 900) due olmamalı");
  assert.equal(await Check.countDocuments({ monitor: fresh._id }), 0);
});

test("sweep: while down/failing retried every 60 s (no 900 s wait)", async () => {
  await refreshAll();
  const m = await createMonitor({
    name: "hata-aralik",
    url: URL("/fail"),
    consecutiveFailures: 1,
    lastCheckedAt: new Date(Date.now() - 61_000),
  });
  const result = await sweep({ queue: noSend });
  assert.ok(result.measured >= 1, "61 sn önce hata alan monitör due olmalı (etkin 60 sn)");
  assert.ok((await Check.countDocuments({ monitor: m._id })) >= 1);
});

test("sweep: healthy monitor NOT due after 61 s (interval 900)", async () => {
  await refreshAll();
  await createMonitor({ name: "saglikli-61sn", consecutiveFailures: 0, lastCheckedAt: new Date(Date.now() - 61_000) });
  const result = await sweep({ queue: noSend });
  assert.equal(result.measured, 0, "consec=0 + 61 sn → due değil");
});

test("sweep: disabled (enabled=false) monitor never measured", async () => {
  const m = await createMonitor({ name: "kapali-test", enabled: false });
  await sweep({ queue: noSend });
  assert.equal(await Check.countDocuments({ monitor: m._id }), 0);
});

test("sweep: ≤8 parallel workers (12 slow monitors, peak concurrency ≤8)", async () => {
  await refreshAll();
  await Monitor.deleteMany({ name: /^slow-/ });
  for (let i = 0; i < 12; i++) {
    await createMonitor({ name: `slow-${i}`, url: URL("/slow") });
  }
  counter.peak = 0;
  counter.inflight = 0;
  const result = await sweep({ queue: noSend });
  assert.equal(result.measured, 12);
  assert.ok(counter.peak > 1, "paralellik gerçekten işliyor olmalı");
  assert.ok(counter.peak <= CONSTANTS.MAX_PARALLEL, `tepe eşzamanlılık ${counter.peak} ≤ 8 olmalı`);
  await Monitor.deleteMany({ name: /^slow-/ });
});

test("sweep: phase breakdown and answering IP written to the check", async () => {
  await refreshAll();
  const m = await createMonitor({ name: "fazli" });
  await sweep({ queue: noSend });
  const c = await Check.findOne({ monitor: m._id }).sort({ at: -1 }).lean();
  assert.ok(c.phases, "faz kırılımı yazılmalı");
  assert.ok(c.phases.dns >= 0);
  assert.ok(c.phases.tcp >= 0);
  assert.ok(c.ip && c.ip.length > 0, "cevaplayan IP yazılmalı");
});

test("schema: check TTL index is 90 days (panel rule)", async () => {
  const indexes = await Check.collection.indexes();
  const ttl = indexes.find((i) => i.name === "at_1");
  assert.ok(ttl, "at_1 TTL indeksi olmalı");
  assert.equal(ttl.expireAfterSeconds, 90 * 86_400);
});

test("constants: panel values (20s TO, 3 attempts, 3 confirms, ≤8 parallel, SSL 14d)", () => {
  assert.equal(CONSTANTS.CHECK_TIMEOUT_MS, 20_000);
  assert.equal(CONSTANTS.MAX_ATTEMPTS, 3);
  assert.equal(CONSTANTS.RETRY_DELAY_MS, 3_000);
  assert.equal(CONSTANTS.CONFIRM_CYCLES, 3);
  assert.equal(CONSTANTS.MAX_PARALLEL, 8);
  assert.equal(CONSTANTS.SSL_DAYS_LIMIT, 14);
  assert.equal(CONSTANTS.KEYWORD_LIMIT, 300_000);
});
