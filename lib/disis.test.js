import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { Monitor, Check, Group } from "./models.js";
import { disisUcu, disisOzet } from "./disis.js";

// /api/disis/ozet eşleniği: Bearer token korumalı, 401 davranışı, yanıtta
// URL/IP/hata metni SIZMAZ (yalnız ad+grup+durum+son ölçüm), bayat sayımı doğru.

const URI = process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27018/moon_disis_test";
const TOKEN = "test-servis-token-123";

function sahteUcu(yol, token = null) {
  const req = { url: yol, method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} };
  const parca = [];
  let kod = null;
  const res = {
    writeHead: (k) => (kod = k),
    end: (g) => parca.push(g),
  };
  return { req, res, sonuc: async () => ({ kod, govde: parca.length ? JSON.parse(parca[0]) : null }) };
}

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await Check.syncIndexes();
  const grup = await Group.create({ name: "yonetim", order: 0 });
  const simdi = new Date();
  await Monitor.create([
    { name: "canli site", group: grup._id, url: "https://gizli-canli-adres.sistem.com/", order: 0, status: "up", interval: 900, lastCheckedAt: simdi },
    { name: "kopya panel", group: grup._id, url: "http://192.168.1.55:40072/gizli", order: 1, status: "down", interval: 900, lastCheckedAt: simdi, consecutiveFailures: 5 },
    { name: "bayat service", url: "https://baska-gizli.example.net/x", order: 2, status: "up", interval: 900, lastCheckedAt: new Date(simdi.getTime() - 30 * 60_000) },
    { name: "kapali monitor", url: "https://kapali-gizli.example.net/", order: 3, enabled: false, status: "pending", interval: 900 },
  ]);
  const [canli, kopya, bayat] = await Monitor.find().sort({ order: 1 }).lean();
  await Check.create([
    { monitor: canli._id, at: simdi, ms: 120, status: 200, ok: true, confirmed: true, ip: "10.0.0.1", error: "gizli hata metni" },
    { monitor: kopya._id, at: simdi, ms: 0, status: 0, ok: false, confirmed: true, ip: "10.0.0.2", error: "gizli hata metni" },
    { monitor: bayat._id, at: new Date(simdi.getTime() - 30 * 60_000), ms: 90, status: 200, ok: true, confirmed: true },
  ]);
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("disisOzet: sayılar ve bayat tanımı", async () => {
  const ozet = await disisOzet();
  assert.equal(ozet.toplam, 4);
  assert.equal(ozet.up, 2);
  assert.equal(ozet.down, 1);
  assert.equal(ozet.bayat, 1, "yarım saat ölçülmeyen bayat olmalı");
  const bayat = ozet.monitorler.find((m) => m.ad === "bayat service");
  assert.ok(bayat, "bayat monitör listede olmalı");
  assert.equal(bayat.sonOlcum.ok, true);
  assert.equal(bayat.bayat, true, "bayat monitör bayraklı olmalı");
  const taze = ozet.monitorler.find((m) => m.ad === "canli site");
  assert.equal(taze.bayat, false, "taze monitör bayraksız olmalı");
  const kapali = ozet.monitorler.find((m) => m.ad === "kapali monitor");
  assert.equal(kapali.durum, "kapali", "enabled=false monitör 'kapali' görünmeli");
  assert.equal(kapali.bayat, false, "kapalı monitör bilinçli olarak kapalı → bayat değil");
});

test("disisOzet: yanıtta URL, IP ve hata metni SIZMAZ (bozma-gizlilik)", async () => {
  const metin = JSON.stringify(await disisOzet());
  assert.ok(!metin.includes("gizli-canli-adres"), "URL sızmamalı");
  assert.ok(!metin.includes("192.168.1.55"), "iç IP sızmamalı");
  assert.ok(!metin.includes("gizli hata metni"), "hata metni sızmamalı");
  assert.ok(!metin.includes("10.0.0."), "cevaplayan IP sızmamalı");
  assert.ok(!/"url"/.test(metin), "url alanı hiç olmamalı");
  for (const m of (await disisOzet()).monitorler) {
    assert.ok(!("url" in m), "monitör özetinde url alanı olmamalı");
    assert.deepEqual(Object.keys(m).sort(), ["ad", "bayat", "durum", "grup", "sonOlcum"].sort());
  }
});

test("disisUcu: token yoksa uç kapalı (404)", async () => {
  const eski = process.env.MOON_SERVIS_TOKEN;
  delete process.env.MOON_SERVIS_TOKEN;
  try {
    const { req, res, sonuc } = sahteUcu("/api/disis/ozet");
    assert.equal(await disisUcu(req, res), true);
    assert.equal((await sonuc()).kod, 404);
  } finally {
    process.env.MOON_SERVIS_TOKEN = eski;
  }
});

test("disisUcu: yanlış/eksik token → 401 (bozma-token)", async () => {
  process.env.MOON_SERVIS_TOKEN = TOKEN;
  const { req, res, sonuc } = sahteUcu("/api/disis/ozet", "yanlis-token");
  assert.equal(await disisUcu(req, res), true);
  assert.equal((await sonuc()).kod, 401);

  const basliksiz = sahteUcu("/api/disis/ozet");
  assert.equal(await disisUcu(basliksiz.req, basliksiz.res), true);
  assert.equal((await basliksiz.sonuc()).kod, 401);
});

test("disisUcu: doğru token → 200 + özet gövdesi", async () => {
  process.env.MOON_SERVIS_TOKEN = TOKEN;
  const { req, res, sonuc } = sahteUcu("/api/disis/ozet", TOKEN);
  assert.equal(await disisUcu(req, res), true);
  const { kod, govde } = await sonuc();
  assert.equal(kod, 200);
  assert.equal(govde.toplam, 4);
  assert.ok(Array.isArray(govde.monitorler));
});

test("disisUcu: başka yol/yöntem bu uca ait değildir (false)", async () => {
  process.env.MOON_SERVIS_TOKEN = TOKEN;
  const baska = sahteUcu("/api/giris", TOKEN);
  assert.equal(await disisUcu(baska.req, baska.res), false);
  const post = { url: "/api/disis/ozet", method: "POST", headers: {} };
  assert.equal(await disisUcu(post, { writeHead() {}, end() {} }), false);
});
