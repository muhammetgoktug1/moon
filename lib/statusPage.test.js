import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { Monitor, Check, Group, HostReport } from "./models.js";
import { statusData, resetStatusCache } from "./statusPage.js";

// /status HERKES AÇIK sayfasının verisi: yalnız {groups, services}. Faz A host
// kaynak raporları buraya ÇIKMAZ (bozma: hosts sızarsa kırmızı); URL/hata metni
// de sızmaz. Panel verisi (socket "hosts") oturum ister — bkz. server.js.

const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_statuspage_test`;

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  const now = new Date();
  const group = await Group.create({ name: "grup-a", order: 0 });
  const monitor = await Monitor.create({
    name: "svc-a monitor",
    group: group._id,
    url: "https://fixture.example.com/path",
    order: 0,
    status: "up",
    interval: 900,
    lastCheckedAt: now,
  });
  await Check.create({ monitor: monitor._id, at: now, ms: 120, status: 200, ok: true, confirmed: true, ip: "192.0.2.10", error: "gizli hata metni" });
  // Faz A: rapor VAR — /status verisine rağmen hosts ÇIKMAMALI
  await HostReport.create({
    at: now,
    host: { name: "host-alpha", cpuPct: 10, memPct: 20, diskPct: 30 },
    services: [{ name: "svc-a", status: "up" }],
  });
  resetStatusCache();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("statusData: tam olarak {groups, services} — hosts YOK (bozma-status-leak)", async () => {
  const data = await statusData();
  assert.deepEqual(Object.keys(data).sort(), ["groups", "services"]);
  const text = JSON.stringify(data);
  assert.ok(!text.includes("host-alpha"), "host adı /status verisine sızmamalı");
  assert.ok(!/"hosts"/.test(text), "hosts alanı /status verisinde OLMAMALI");
  assert.ok(!text.includes("cpuPct"), "kaynak ölçümleri /status verisine sızmamalı");
});

test("statusData: servis satırında URL/hata/IP yok (mevcut gizlilik korunur)", async () => {
  const data = await statusData();
  const text = JSON.stringify(data);
  assert.ok(!text.includes("fixture.example.com"), "URL sızmamalı");
  assert.ok(!text.includes("192.0.2.10"), "IP sızmamalı");
  assert.ok(!text.includes("gizli hata metni"), "hata metni sızmamalı");
  for (const s of data.services) {
    assert.ok(!("url" in s), "servis satırında url alanı olmamalı");
    assert.deepEqual(Object.keys(s).sort(), ["days", "group", "id", "last", "name"].sort());
  }
});

test("statusData: önbellek — INTERVAL_MS içinde aynı nesne, reset sonrası taze veri", async () => {
  const a = await statusData();
  const b = await statusData();
  assert.equal(a, b, "önbellekten aynı referans dönmeli");
  await Monitor.create({ name: "svc-b monitor", url: "https://fixture-b.example.com/", order: 1, status: "pending", interval: 900 });
  resetStatusCache();
  const c = await statusData();
  assert.notEqual(c, a);
  assert.equal(c.services.length, a.services.length + 1, "reset sonrası yeni servis görünmeli");
  resetStatusCache();
});
