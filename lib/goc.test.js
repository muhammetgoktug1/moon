import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import mongoose from "mongoose";
import { kaynakOku, hedefeYaz } from "./goc.js";
import { Monitor, Check, Group } from "./models.js";

// Göç ithalatının fikstür testi: küçük bir uptime SQLite kopyası → Moon MongoDB.
// Çalışması için Moon MongoDB'sinin 127.0.0.1:27018'de eşlenmiş olması gerekir.
const URI = process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27018/moon_goc_test";

function fiksturKur(dosya) {
  const db = new DatabaseSync(dosya);
  db.exec(`
    CREATE TABLE monitors (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET', interval INTEGER NOT NULL DEFAULT 900,
      enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT, last_response_time INTEGER, last_status_code INTEGER,
      notes TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT,
      keyword TEXT, ssl_bitis TEXT, beklenen_kod INTEGER, grup TEXT,
      basliklar TEXT, govde TEXT, sira INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE checklogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id TEXT NOT NULL,
      status TEXT NOT NULL, error_kind TEXT NOT NULL DEFAULT '',
      confirmed INTEGER NOT NULL DEFAULT 1,
      response_time INTEGER, status_code INTEGER, reason TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL,
      dns_ms INTEGER, tcp_ms INTEGER, tls_ms INTEGER, ttfb_ms INTEGER, ip TEXT
    );
  `);
  const simdi = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const ekle = db.prepare(
    `INSERT INTO monitors (id, name, url, method, grup, sira, ssl_bitis, basliklar, govde) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  ekle.run("m1", "sistem web", "https://ornek.com/", "GET", "yonetim", 1, "2027-01-02", "[]", "");
  ekle.run("m2", "api saglik", "https://api.ornek.com/health", "GET", null, 2, null, "[]", "");
  ekle.run("m3", "gecersiz", "ftp://bozuk-adres", "GET", null, 3, null, "[]", "");

  const checkEkle = db.prepare(
    `INSERT INTO checklogs (monitor_id, status, error_kind, response_time, status_code, checked_at, dns_ms, tcp_ms, tls_ms, ttfb_ms, ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  checkEkle.run("m1", "up", "", 120, 200, iso(simdi - 60_000), null, null, null, null, null);
  checkEkle.run("m1", "down", "timeout", 10_000, 0, iso(simdi - 120_000), null, null, null, null, null);
  checkEkle.run("m1", "up", "", 140, 200, iso(simdi - 180_000), 20, 30, 40, 150, "93.184.216.34");
  checkEkle.run("m2", "up", "", 90, 204, iso(simdi - 60_000), null, null, null, null, null);
  // 31 gün önceki kayıt: 30 günlük pencere dışında — alınmamalı
  checkEkle.run("m2", "up", "", 80, 200, iso(simdi - 31 * 86_400_000), null, null, null, null, null);
  // kaynak içi mükerrer (aynı an): bir kez yazılmalı
  checkEkle.run("m2", "up", "", 95, 200, iso(simdi - 60_000), null, null, null, null, null);
  // geçersiz monitöre ait kayıt: dışarıda kalmalı
  checkEkle.run("m3", "up", "", 50, 200, iso(simdi - 60_000), null, null, null, null, null);
  db.close();
}

let dosya;
let veri;

test.before(async () => {
  dosya = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moon-goc-")), "fikstur.db");
  fiksturKur(dosya);
  veri = kaynakOku(dosya, 30);
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  fs.rmSync(path.dirname(dosya), { recursive: true, force: true });
});

test("kaynak okuma: geçersiz URL atlanır, pencere dışı ve mükerrer ayıklanmaz (yazımda ayıklanır)", () => {
  assert.equal(veri.monitorler.length, 2, "ftp:// atlanmalı");
  assert.equal(veri.atlanan.length, 1);
  assert.equal(veri.atlanan[0].neden, "geçersiz URL");

  const m1 = veri.monitorler.find((m) => m.eskiId === "m1");
  assert.equal(m1.name, "sistem web");
  assert.equal(m1.url, "https://ornek.com/");
  assert.equal(m1.grup, "yonetim");
  assert.ok(m1.certBitis instanceof Date, "ssl_bitis tarihe çevrilmeli");

  // 31 gün önceki hariç 5 satır okunur (mükerrer okumada kalır)
  assert.equal(veri.checkler.length, 5);
  assert.ok(veri.checkler.every((c) => !c.eskiMonitorId || c.eskiMonitorId !== "m3"));
  const eskiYok = veri.checkler.every((c) => Date.now() - c.at.getTime() < 31 * 86_400_000);
  assert.ok(eskiYok, "31 günlük kayıt pencere dışı kalmalı");
});

test("okuma eşlemesi: ok=up, fazlar ttfb'den, ip korunur", () => {
  const fazli = veri.checkler.find((c) => c.eskiMonitorId === "m1" && c.phases);
  assert.deepEqual(fazli.phases, { redirect: 0, dns: 20, tcp: 30, tls: 40, server: 60 });
  assert.equal(fazli.ip, "93.184.216.34");
  const kotu = veri.checkler.find((c) => c.eskiMonitorId === "m1" && c.ok === false);
  assert.equal(kotu.error, "timeout");
  assert.equal(kotu.status, 0);
});

test("ilk yazım: sayılar tutar, grup tab olarak açılır", async () => {
  const s = await hedefeYaz(URI, veri);
  assert.deepEqual(s.monitorlar, { toplam: 2, yeni: 2 });
  assert.equal(s.gruplar.yeni, 1);
  assert.equal(s.checkler.yeni, 4, "mükerrer bir kez yazılmalı (5 okuma − 1)");
  assert.equal(await Monitor.countDocuments(), 2);
  assert.equal(await Group.countDocuments(), 1);
  assert.equal(await Check.countDocuments(), 4);
  const grupMon = await Monitor.findOne({ url: "https://ornek.com/" }).populate("group").lean();
  assert.equal(grupMon.group?.name, "yonetim");
});

test("ikinci yazım (idempotent): 0 yeni kayıt", async () => {
  const s = await hedefeYaz(URI, veri);
  assert.equal(s.monitorlar.yeni, 0);
  assert.equal(s.checkler.yeni, 0);
  assert.equal(s.gruplar.yeni, 0);
  assert.equal(await Check.countDocuments(), 4, "sayı değişmemeli");
});

test("kurut seçeneği temizleyip yeniden yazar", async () => {
  const s = await hedefeYaz(URI, veri, { kurut: true });
  assert.equal(s.monitorlar.yeni, 2);
  assert.equal(s.checkler.yeni, 4);
  assert.equal(await Check.countDocuments(), 4);
});
