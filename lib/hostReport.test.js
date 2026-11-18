import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { HostReport, HOST_TTL_DAYS } from "./models.js";
import {
  hostReportEndpoint,
  parseHostReport,
  storeHostReport,
  hostsWire,
  hostsSummary,
  hostSummaryRow,
  HOST_REPORT_PATH,
} from "./hostReport.js";

// POST /api/internal/host-report: token kapalı/yancı 404-401, eksik alan 400,
// host başına tek belge + 30 sn sessiz atlama, TTL indeksi, token DEPOLANMAZ,
// panel/dış özet biçimleri. Sentezik adlar (repo public — gerçek ad YOK).

const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_hostreport_test`;
const TOKEN = "test-service-token-host";

const validBody = {
  host: { name: "host-alpha", cpuPct: 12.5, memPct: 40, memMB: 16000, diskPct: 61, diskGB: 400, uptimeH: 100.5, load: [0.5, 1.25, 1.75] },
  services: [
    { name: "svc-a", status: "up", ms: 5, code: 200 },
    { name: "svc-b", status: "down", ms: 3001, code: 0, detail: "timed out" },
  ],
};

function fakePost(body, token = null, raw = null) {
  const req = {
    url: HOST_REPORT_PATH,
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    async *[Symbol.asyncIterator]() {
      yield raw !== null ? raw : JSON.stringify(body);
    },
  };
  let code = null;
  const parts = [];
  const res = { writeHead: (c) => (code = c), end: (b) => parts.push(b) };
  return { req, res, result: async () => ({ code, body: parts.length ? JSON.parse(parts[0]) : null }) };
}

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await HostReport.syncIndexes();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("uç kapalı: MOON_SERVICE_TOKEN env yoksa → 404", async () => {
  const old = process.env.MOON_SERVICE_TOKEN;
  delete process.env.MOON_SERVICE_TOKEN;
  try {
    const { req, res, result } = fakePost(validBody);
    assert.equal(await hostReportEndpoint(req, res), true);
    assert.equal((await result()).code, 404);
  } finally {
    process.env.MOON_SERVICE_TOKEN = old;
  }
});

test("token yanlış/eksik → 401 (bozma-token: kabul edilirse kırmızı)", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  for (const header of [null, "wrong-token", "bearer " + TOKEN]) {
    const { req, res, result } = fakePost(validBody, header);
    assert.equal(await hostReportEndpoint(req, res), true);
    assert.equal((await result()).code, 401, `başlık "${header}" için 401 beklenir`);
  }
  assert.equal(await HostReport.countDocuments(), 0, "401'lik istek hiçbir şey yazmamalı");
});

test("geçersiz gövde → 400 (eksik alan/hatalı tür)", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  const cases = [
    [() => fakePost(validBody, TOKEN, "not-json{"), "bozuk JSON"],
    [() => fakePost([1, 2], TOKEN), "gövde dizi"],
    [() => fakePost({}, TOKEN), "host yok"],
    [() => fakePost({ host: {} }, TOKEN), "host.name yok"],
    [() => fakePost({ host: { name: "x".repeat(61) } }, TOKEN), "host.name çok uzun"],
    [() => fakePost({ host: { name: "h", cpuPct: 150 } }, TOKEN), "cpuPct > 100"],
    [() => fakePost({ host: { name: "h", memPct: "yuksek" } }, TOKEN), "memPct sayı değil"],
    [() => fakePost({ host: { name: "h" }, services: "hepsi" }, TOKEN), "services dizi değil"],
    [() => fakePost({ host: { name: "h" }, services: [{ name: "s" }] }, TOKEN), "servis status yok"],
    [() => fakePost({ host: { name: "h" }, services: [{ name: "s", status: "maybe" }] }, TOKEN), "servis status geçersiz"],
    [() => fakePost({ host: { name: "h" }, services: [{ name: "", status: "up" }] }, TOKEN), "servis adı boş"],
  ];
  for (const [make, label] of cases) {
    const { req, res, result } = make();
    assert.equal(await hostReportEndpoint(req, res), true);
    const out = await result();
    assert.equal(out.code, 400, `${label} → 400`);
    assert.ok(out.body.error, `${label} → hata iletisi`);
  }
  assert.equal(await HostReport.countDocuments(), 0, "400'lik istek hiçbir şey yazmamalı");
});

test("geçerli rapor → 200 stored:true; belge şeması + token DEPOLANMIYOR", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  const { req, res, result } = fakePost(validBody, TOKEN);
  assert.equal(await hostReportEndpoint(req, res), true);
  const { code, body } = await result();
  assert.equal(code, 200);
  assert.deepEqual(body, { ok: true, stored: true });

  const doc = await HostReport.findOne({ "host.name": "host-alpha" }).lean();
  assert.ok(doc, "belge yazılmalı");
  assert.equal(doc.host.cpuPct, 12.5);
  assert.equal(doc.host.load.length, 3);
  assert.equal(doc.services.length, 2);
  assert.equal(doc.services[1].detail, "timed out");
  const text = JSON.stringify(doc);
  assert.ok(!text.includes(TOKEN), "token belgeye YAZILMAMALI (tokenless)");
  assert.ok(!/authorization/i.test(text), "başlık bilgisi belgeye yazılmamalı");
  // bilinmeyen alanlar beyaz listeye takılır → depolanmaz
  const parsed = parseHostReport({ host: { name: "h", secret: "x" }, evil: true });
  assert.ok(!JSON.stringify(parsed.report).includes("evil"));
  assert.ok(!JSON.stringify(parsed.report).includes("secret"));
});

test("30 sn kuralı: aynı hosta çabuk ikinci rapor sessizce atlanır, farklı host yazar", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  // önceki testin raporunu 60 sn geri çek → bu testin ilk raporu kesin yazılsın
  await HostReport.updateOne({ "host.name": "host-alpha" }, { $set: { at: new Date(Date.now() - 60_000) } });

  const first = fakePost({ ...validBody, host: { ...validBody.host, cpuPct: 10 } }, TOKEN);
  assert.equal(await hostReportEndpoint(first.req, first.res), true);
  assert.deepEqual((await first.result()).body, { ok: true, stored: true });
  const firstDoc = await HostReport.findOne({ "host.name": "host-alpha" }).lean();

  const quick = fakePost({ ...validBody, host: { ...validBody.host, cpuPct: 99 } }, TOKEN);
  assert.equal(await hostReportEndpoint(quick.req, quick.res), true);
  const quickOut = await quick.result();
  assert.deepEqual(quickOut.body, { ok: true, stored: false }, "hızlı ikinci rapor 200 + stored:false (429 yok)");
  const unchanged = await HostReport.findOne({ "host.name": "host-alpha" }).lean();
  assert.equal(unchanged.host.cpuPct, firstDoc.host.cpuPct, "eski rapor yenisiyle DEĞİŞMEZ");
  assert.equal(new Date(unchanged.at).getTime(), new Date(firstDoc.at).getTime(), "at korunur");

  const other = fakePost({ host: { name: "host-beta", cpuPct: 1 }, services: [] }, TOKEN);
  assert.equal(await hostReportEndpoint(other.req, other.res), true);
  assert.deepEqual((await other.result()).body, { ok: true, stored: true });
  assert.equal(await HostReport.countDocuments(), 2, "host başına tek belge");
});

test("30 sn geçince rapor yerini alar (upsert)", async () => {
  await HostReport.updateOne({ "host.name": "host-alpha" }, { $set: { at: new Date(Date.now() - 60_000) } });
  const again = fakePost({ ...validBody, host: { ...validBody.host, cpuPct: 77 } }, TOKEN);
  assert.equal(await hostReportEndpoint(again.req, again.res), true);
  assert.deepEqual((await again.result()).body, { ok: true, stored: true });
  const doc = await HostReport.findOne({ "host.name": "host-alpha" }).lean();
  assert.equal(doc.host.cpuPct, 77, "yeni değer");
  assert.equal(await HostReport.countDocuments({ "host.name": "host-alpha" }), 1, "hâlâ tek belge");
});

test("TTL indeksi: at üzerinde 30 günlük expireAfterSeconds", async () => {
  const indexes = await HostReport.collection.indexes();
  const ttl = indexes.find((i) => i.key && i.key.at === 1);
  assert.ok(ttl, "at indeksi olmalı");
  assert.equal(ttl.expireAfterSeconds, HOST_TTL_DAYS * 86_400, "30 gün TTL");
  const unique = indexes.find((i) => i.key && i.key["host.name"] === 1);
  assert.ok(unique?.unique, "host.name unique indeks (host başına tek belge)");
});

test("hostsWire: panel biçimi (tam sayılar + servis ms/code)", async () => {
  const wire = await hostsWire();
  assert.equal(wire.length, 2);
  assert.deepEqual(wire.map((h) => h.name), ["host-alpha", "host-beta"], "isme göre sıralı");
  const alpha = wire[0];
  assert.deepEqual(
    Object.keys(alpha).sort(),
    ["at", "cpuPct", "diskGB", "diskPct", "load", "memMB", "memPct", "name", "services", "uptimeH"].sort(),
  );
  assert.equal(alpha.services.length, 2);
  assert.deepEqual(Object.keys(alpha.services[0]).sort(), ["code", "ms", "name", "status"]);
});

test("hostsSummary: rapor yokken null; doluyken minimal satır (URL/port YOK)", async () => {
  const row = hostSummaryRow(await HostReport.findOne({ "host.name": "host-alpha" }).lean());
  assert.deepEqual(Object.keys(row).sort(), ["at", "cpuPct", "diskPct", "memPct", "name", "services"].sort());
  assert.deepEqual(row.services, [{ name: "svc-a", status: "up" }, { name: "svc-b", status: "down" }]);

  await HostReport.deleteMany({});
  assert.equal(await hostsSummary(), null, "boş koleksiyon → null (canlı boş-uç kanıtı bu değeri bekler)");

  await storeHostReport(parseHostReport(validBody).report);
  assert.equal((await hostsSummary()).length, 1, "geri yazılınca dizi");
});

test("uç yalnız POST /api/internal/host-report yolunu işler", async () => {
  process.env.MOON_SERVICE_TOKEN = TOKEN;
  const foreign = { url: "/api/external/summary", method: "POST", headers: {} };
  assert.equal(await hostReportEndpoint(foreign, { writeHead() {}, end() {} }), false);
  const get = { url: HOST_REPORT_PATH, method: "GET", headers: {} };
  assert.equal(await hostReportEndpoint(get, { writeHead() {}, end() {} }), false, "GET bu uca ait değil");
});
