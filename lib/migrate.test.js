import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import mongoose from "mongoose";
import { readSource, writeToTarget } from "./migrate.js";
import { Monitor, Check, Group } from "./models.js";

// Göç ithalatının fikstür testi: küçük bir uptime SQLite kopyası → Moon MongoDB.
// Çalışması için MOON_TEST_MONGO ile bir test MongoDB belirtin.
const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_migrate_test`;

function setupFixture(file) {
  const db = new DatabaseSync(file);
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
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const insert = db.prepare(
    `INSERT INTO monitors (id, name, url, method, grup, sira, ssl_bitis, basliklar, govde,
                           interval, keyword, beklenen_kod, enabled, notes, status, consecutive_failures)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run("m1", "sistem web", "https://ornek.com/", "GET", "yonetim", 1, "2027-01-02", "[]", "",
    600, "hosgeldin", null, 1, "ana site", "up", 0);
  insert.run("m2", "api saglik", "https://api.ornek.com/health", "GET", null, 2, null, "[]", "",
    900, "", 204, 1, "", "down", 4);
  insert.run("m3", "gecersiz", "ftp://bozuk-adres", "GET", null, 3, null, "[]", "",
    900, "", null, 1, "", "pending", 0);
  // ikinci geçiş: kapalı monitör — ithal edilmeli ama enabled=false kalmalı
  insert.run("m4", "eski deneme", "https://eski.ornek.com/", "GET", null, 4, null, "[]", "",
    1200, "", null, 0, "kapatildi", "down", 7);

  const insertCheck = db.prepare(
    `INSERT INTO checklogs (monitor_id, status, error_kind, response_time, status_code, checked_at, dns_ms, tcp_ms, tls_ms, ttfb_ms, ip) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insertCheck.run("m1", "up", "", 120, 200, iso(now - 60_000), null, null, null, null, null);
  insertCheck.run("m1", "down", "timeout", 10_000, 0, iso(now - 120_000), null, null, null, null, null);
  insertCheck.run("m1", "up", "", 140, 200, iso(now - 180_000), 20, 30, 40, 150, "93.184.216.34");
  insertCheck.run("m2", "up", "", 90, 204, iso(now - 60_000), null, null, null, null, null);
  // 31 gün önceki kayıt: 30 günlük pencere dışında — alınmamalı
  insertCheck.run("m2", "up", "", 80, 200, iso(now - 31 * 86_400_000), null, null, null, null, null);
  // kaynak içi mükerrer (aynı an): bir kez yazılmalı
  insertCheck.run("m2", "up", "", 95, 200, iso(now - 60_000), null, null, null, null, null);
  // geçersiz monitöre ait kayıt: dışarıda kalmalı
  insertCheck.run("m3", "up", "", 50, 200, iso(now - 60_000), null, null, null, null, null);
  db.close();
}

let file;
let data;

test.before(async () => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "moon-migrate-")), "fixture.db");
  setupFixture(file);
  data = readSource(file, 30);
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("source read: invalid URL skipped, out-of-window kept out at write time", () => {
  assert.equal(data.monitors.length, 3, "ftp:// atlanmalı");
  assert.equal(data.skipped.length, 1);
  assert.equal(data.skipped[0].reason, "geçersiz URL");

  const m1 = data.monitors.find((m) => m.legacyId === "m1");
  assert.equal(m1.name, "sistem web");
  assert.equal(m1.url, "https://ornek.com/");
  assert.equal(m1.group, "yonetim");
  assert.ok(m1.certExpires instanceof Date, "ssl_bitis tarihe çevrilmeli");

  // ikinci geçiş alanları okunur
  assert.equal(m1.interval, 600);
  assert.equal(m1.keyword, "hosgeldin");
  assert.equal(m1.expectedStatus, null);
  assert.equal(m1.enabled, true);
  assert.equal(m1.notes, "ana site");
  assert.equal(m1.consecutiveFailures, 0);
  assert.equal(m1.status, "up");

  // 31 gün önceki hariç 5 satır okunur (mükerrer okumada kalır)
  assert.equal(data.checks.length, 5);
  assert.ok(data.checks.every((c) => !c.legacyMonitorId || c.legacyMonitorId !== "m3"));
  const noOld = data.checks.every((c) => Date.now() - c.at.getTime() < 31 * 86_400_000);
  assert.ok(noOld, "31 günlük kayıt pencere dışı kalmalı");
});

test("read mapping: ok=up, phases from ttfb, ip preserved", () => {
  const phased = data.checks.find((c) => c.legacyMonitorId === "m1" && c.phases);
  assert.deepEqual(phased.phases, { redirect: 0, dns: 20, tcp: 30, tls: 40, server: 60 });
  assert.equal(phased.ip, "93.184.216.34");
  const bad = data.checks.find((c) => c.legacyMonitorId === "m1" && c.ok === false);
  assert.equal(bad.error, "timeout");
  assert.equal(bad.status, 0);
});

test("first write: counts match, group opened as a tab", async () => {
  const r = await writeToTarget(URI, data);
  assert.deepEqual(r.monitors, { total: 3, new: 3, updated: 0 });
  assert.equal(r.groups.new, 1);
  assert.equal(r.checks.new, 4, "mükerrer bir kez yazılmalı (5 okuma − 1)");
  assert.equal(await Monitor.countDocuments(), 3);
  assert.equal(await Group.countDocuments(), 1);
  assert.equal(await Check.countDocuments(), 4);
  const grouped = await Monitor.findOne({ url: "https://ornek.com/" }).populate("group").lean();
  assert.equal(grouped.group?.name, "yonetim");
});

test("second-pass fields written to target (keyword/expectedStatus/enabled/notes/consec/interval/status)", async () => {
  const m1 = await Monitor.findOne({ url: "https://ornek.com/" }).lean();
  assert.equal(m1.interval, 600);
  assert.equal(m1.keyword, "hosgeldin");
  assert.equal(m1.expectedStatus, null);
  assert.equal(m1.enabled, true);
  assert.equal(m1.notes, "ana site");
  assert.equal(m1.consecutiveFailures, 0);
  assert.equal(m1.status, "up");

  const m2 = await Monitor.findOne({ url: "https://api.ornek.com/health" }).lean();
  assert.equal(m2.expectedStatus, 204);
  assert.equal(m2.status, "down");
  assert.equal(m2.consecutiveFailures, 4);
  assert.equal(m2.interval, 900);

  const m4 = await Monitor.findOne({ url: "https://eski.ornek.com/" }).lean();
  assert.ok(m4, "kapalı monitör de ithal edilmeli");
  assert.equal(m4.enabled, false, "kapalı monitör kapalı kalmalı");
  assert.equal(m4.status, "down");
});

test("second write (idempotent): 0 new records, fields updated", async () => {
  const r = await writeToTarget(URI, data);
  assert.equal(r.monitors.new, 0);
  assert.equal(r.monitors.updated, 3);
  assert.equal(r.checks.new, 0);
  assert.equal(r.groups.new, 0);
  assert.equal(await Monitor.countDocuments(), 3, "monitör sayısı değişmemeli");
  assert.equal(await Check.countDocuments(), 4, "sayı değişmemeli");
  const m2 = await Monitor.findOne({ url: "https://api.ornek.com/health" }).lean();
  assert.equal(m2.expectedStatus, 204, "güncelleme alanları bozmamalı");
});

test("wipe option clears and rewrites", async () => {
  const r = await writeToTarget(URI, data, { wipe: true });
  assert.equal(r.monitors.new, 3);
  assert.equal(r.checks.new, 4);
  assert.equal(await Check.countDocuments(), 4);
});
