import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { HostReport } from "./models.js";
import { storeHostReport, parseHostReport, hostsWire } from "./hostReport.js";
import {
  serviceTransitions,
  transitionTexts,
  missingText,
  recoveredText,
  dispatchReportAlerts,
  scanMissingReports,
  HOST_REPORT_INTERVAL_MS,
  MISSING_REPORTS,
  MISSING_ALERT_AFTER_MS,
} from "./hostAlerts.js";

// Faz 2b: host-servis geçiş bildirimleri — DÜŞTÜ/TOPARLANDI anında, çoklu düşüş
// tek mesajda, çıkan servis sessiz, 3 eksik raporda tek "rapor yok" uyarısı.
// MESAJ METİNLERİ TÜRKÇEDİR (ürün dili); adlar sentezik (svc-a/host-x — repo public).

const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_hostalerts_test`;
const TS = "2026-11-18T12:00:00+00:00";

const report = (name, services) => parseHostReport({ host: { name }, services }).report;
const age = (name, minutes) => HostReport.updateOne({ "host.name": name }, { $set: { at: new Date(Date.now() - minutes * 60_000) } });

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await HostReport.syncIndexes();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

// ——— geçiş algılama (saf fonksiyon) ———

test("serviceTransitions: up→down DÜŞTÜ, down→up TOPARLANDI, değişmeyen sessiz", () => {
  const t = serviceTransitions(
    [
      { name: "svc-a", status: "up" },
      { name: "svc-b", status: "down" },
      { name: "svc-c", status: "up" },
    ],
    [
      { name: "svc-a", status: "down", detail: "timeout" },
      { name: "svc-b", status: "up", ms: 40 },
      { name: "svc-c", status: "up" },
    ],
  );
  assert.deepEqual(t.downs, [{ name: "svc-a", detail: "timeout" }]);
  assert.deepEqual(t.ups, [{ name: "svc-b", ms: 40 }]);
  assert.deepEqual(t.removed, []);
});

test("serviceTransitions: yeni servis İLK raporda down → DÜŞTÜ; ilk raporda up → sessiz", () => {
  const down = serviceTransitions([{ name: "svc-a", status: "up" }], [
    { name: "svc-a", status: "up" },
    { name: "svc-b", status: "down", detail: "connection refused" },
  ]);
  assert.deepEqual(down.downs.map((d) => d.name), ["svc-b"], "yeni + down = DÜŞTÜ");
  const up = serviceTransitions([{ name: "svc-a", status: "up" }], [
    { name: "svc-a", status: "up" },
    { name: "svc-b", status: "up", ms: 5 },
  ]);
  assert.deepEqual(up.downs, []);
  assert.deepEqual(up.ups, [], "yeni + up = olay yok");
});

test("serviceTransitions: rapordan ÇIKAN servis için mesaj YOK (bozma: üretilirse kırmızı)", () => {
  const t = serviceTransitions(
    [
      { name: "svc-a", status: "up" },
      { name: "svc-x", status: "up" },
    ],
    [{ name: "svc-a", status: "up" }],
  );
  assert.deepEqual(t.downs, [], "çıkan servis DÜŞTÜ sayılmaz");
  assert.deepEqual(t.ups, []);
  assert.deepEqual(t.removed, ["svc-x"]);
});

test("serviceTransitions: durum değişimi yoksa hiç olay; boş girdiler güvenli", () => {
  assert.deepEqual(serviceTransitions([{ name: "svc-a", status: "down" }], [{ name: "svc-a", status: "down" }]), {
    downs: [],
    ups: [],
    removed: [],
  });
  assert.deepEqual(serviceTransitions(null, undefined), { downs: [], ups: [], removed: [] });
});

// ——— mesaj biçimi (Türkçe, adlar veriden) ———

test("transitionTexts: tek düşüş — host + servis + durum + kısa detail", () => {
  assert.deepEqual(transitionTexts("host-x", { downs: [{ name: "svc-a", detail: "timeout" }], ups: [] }, TS), [
    `🔴 host-x: svc-a düştü — timeout (${TS})`,
  ]);
  assert.deepEqual(transitionTexts("host-x", { downs: [{ name: "svc-a", detail: "" }], ups: [] }, TS), [
    `🔴 host-x: svc-a düştü (${TS})`,
  ]);
});

test("transitionTexts: aynı raporda ÇOKLU DÜŞÜŞ tek mesajda toplanır", () => {
  const out = transitionTexts("host-x", { downs: [{ name: "svc-a", detail: "" }, { name: "svc-b", detail: "" }], ups: [] }, TS);
  assert.deepEqual(out, [`🔴 host-x: 2 servis düştü: svc-a, svc-b (${TS})`]);
});

test("transitionTexts: toparlanma tekil (ms ile) ve çoğul (tek satır)", () => {
  assert.deepEqual(transitionTexts("host-x", { downs: [], ups: [{ name: "svc-a", ms: 45 }] }, TS), [
    `🟢 host-x: svc-a toparlandı (${TS}, 45 ms)`,
  ]);
  assert.deepEqual(transitionTexts("host-x", { downs: [], ups: [{ name: "svc-a", ms: null }, { name: "svc-b", ms: 10 }] }, TS), [
    `🟢 host-x: 2 servis toparlandı: svc-a, svc-b (${TS})`,
  ]);
});

test("transitionTexts: uzun detail kırpılır; olay yoksa boş dizi", () => {
  const [out] = transitionTexts("host-x", { downs: [{ name: "svc-a", detail: "hata ".repeat(60) }], ups: [] }, TS);
  assert.ok(out.startsWith(`🔴 host-x: svc-a düştü — hata`), "detail kırpılmış biçimde kalmalı");
  assert.ok(out.length < 150, "satır kısa kalmalı");
  assert.deepEqual(transitionTexts("host-x", { downs: [], ups: [] }, TS), []);
});

test("eksik rapor metinleri: süre/sayı sabitten gelir (15 dk / 3 rapor)", () => {
  assert.equal(HOST_REPORT_INTERVAL_MS, 5 * 60_000);
  assert.equal(MISSING_REPORTS, 3);
  assert.equal(MISSING_ALERT_AFTER_MS, 15 * 60_000);
  assert.equal(missingText("host-x", TS), `⚠️ host-x: 15 dakikadır rapor yok (3 eksik rapor) (${TS})`);
  assert.equal(recoveredText("host-x", TS), `🟢 host-x: rapor geri geldi (${TS})`);
});

// ——— uçtan uca: depo + gönderim (gerçek Mongo, sahte gönderim) ———

test("dispatchReportAlerts: ilk rapor sessiz; up→down ANINDA tek mesaj + belgeye son olay", async () => {
  const first = report("host-x", [{ name: "svc-a", status: "up", ms: 5, code: 200 }]);
  const s1 = await storeHostReport(first);
  assert.ok(s1.stored);
  assert.equal(s1.prev, null, "ilk raporda önceki belge yok");
  const sent0 = [];
  await dispatchReportAlerts(s1.prev, first, { send: async (t) => sent0.push(t) });
  assert.deepEqual(sent0, [], "ilk raporda down yoksa mesaj yok");

  await age("host-x", 1); // 30 sn kuralını geç
  const second = report("host-x", [{ name: "svc-a", status: "down", ms: 3000, code: 0, detail: "timeout" }]);
  const s2 = await storeHostReport(second);
  assert.ok(s2.stored);
  assert.ok(s2.prev, "önceki belge dönmeli (geçiş karşılaştırması için)");
  const sent = [];
  const texts = await dispatchReportAlerts(s2.prev, second, { send: async (t) => sent.push(t) });
  assert.equal(sent.length, 1, "tek geçiş = tek mesaj (anında — pencere yok)");
  assert.match(sent[0], /^🔴 host-x: svc-a düştü — timeout \(2026-/);
  assert.equal(texts.length, 1);
  const doc = await HostReport.findOne({ "host.name": "host-x" }).lean();
  assert.equal(doc.lastAlert.text, sent[0], "belgeye son olay yazılır");
  assert.ok(doc.lastAlert.at);
});

test("dispatchReportAlerts: down→up TOPARLANDI mesajı", async () => {
  await age("host-x", 1);
  const third = report("host-x", [{ name: "svc-a", status: "up", ms: 45, code: 200 }]);
  const s3 = await storeHostReport(third);
  const sent = [];
  await dispatchReportAlerts(s3.prev, third, { send: async (t) => sent.push(t) });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^🟢 host-x: svc-a toparlandı \(2026-.*45 ms\)/);
});

test("dispatchReportAlerts: aynı raporda 2 düşüş TEK mesaj (uçtan uca)", async () => {
  const base = report("host-y", [
    { name: "svc-a", status: "up", ms: 1, code: 200 },
    { name: "svc-b", status: "up", ms: 2, code: 200 },
  ]);
  const s1 = await storeHostReport(base);
  await dispatchReportAlerts(s1.prev, base, { send: async () => {} });
  await age("host-y", 1);
  const both = report("host-y", [
    { name: "svc-a", status: "down", ms: 0, code: 0, detail: "refused" },
    { name: "svc-b", status: "down", ms: 0, code: 0, detail: "refused" },
  ]);
  const s2 = await storeHostReport(both);
  const sent = [];
  await dispatchReportAlerts(s2.prev, both, { send: async (t) => sent.push(t) });
  assert.equal(sent.length, 1, "çoklu düşüş tek mesaj");
  assert.match(sent[0], /^🔴 host-y: 2 servis düştü: svc-a, svc-b \(2026-/);
});

test("dispatchReportAlerts: rapordan çıkan servis SESSİZ (uçtan uca)", async () => {
  await storeHostReport(report("host-z", [
    { name: "svc-a", status: "up", ms: 1, code: 200 },
    { name: "svc-x", status: "up", ms: 2, code: 200 },
  ]));
  await age("host-z", 1);
  const gone = report("host-z", [{ name: "svc-a", status: "up", ms: 1, code: 200 }]); // svc-x config'ten çıktı
  const s = await storeHostReport(gone);
  const sent = [];
  await dispatchReportAlerts(s.prev, gone, { send: async (t) => sent.push(t) });
  assert.deepEqual(sent, [], "çıkan servis için mesaj gitmez (başka geçiş de yok)");
  const doc = await HostReport.findOne({ "host.name": "host-z" }).lean();
  assert.ok(!doc.lastAlert, "sessiz olay son olay yazmaz");
});

test("dispatchReportAlerts: gönderim hatası bastırılır (köprü düşse akış patlamaz)", async () => {
  await age("host-y", 1);
  const back = report("host-y", [
    { name: "svc-a", status: "up", ms: 1, code: 200 },
    { name: "svc-b", status: "up", ms: 2, code: 200 },
  ]);
  const s = await storeHostReport(back);
  // önceki raporda iki servis de down → 2 toparlanma TEK mesaj; send patlar → yutulmalı
  await assert.doesNotReject(() => dispatchReportAlerts(s.prev, back, { send: async () => { throw new Error("bridge down"); } }));
});

// ——— eksik rapor uyarısı (host seviyesi) ———

test("scanMissingReports: 3 eksik rapor (15 dk) → TEK uyarı; sonraki taramalar sessiz", async () => {
  await age("host-x", 16); // son rapor 16 dk önce → 3 beklenen rapor kaçtı
  const sent = [];
  const first = await scanMissingReports({ send: async (t) => sent.push(t) });
  assert.deepEqual(first, ["host-x"]);
  assert.match(sent[0], /^⚠️ host-x: 15 dakikadır rapor yok \(3 eksik rapor\) \(2026-/);
  const second = await scanMissingReports({ send: async (t) => sent.push(t) });
  assert.deepEqual(second, [], "ikinci tarama tekrar ETMEZ");
  assert.equal(sent.length, 1);
  const doc = await HostReport.findOne({ "host.name": "host-x" }).lean();
  assert.equal(doc.missedAlerts, true, "kilit belgeye yazılır");
  assert.match(doc.lastAlert.text, /^⚠️ host-x/);
});

test("dispatchReportAlerts: rapor dönünce toparlanma + kilit sıfırlanır", async () => {
  await age("host-x", 1); // 30 sn kuralı (missedAlerts koruması upsert'e dokunmaz)
  const r = report("host-x", [{ name: "svc-a", status: "up", ms: 5, code: 200 }]);
  const { prev, stored } = await storeHostReport(r);
  assert.ok(stored);
  assert.equal(prev.missedAlerts, true, "önceki belgede uyarı kilidi duruyor");
  const sent = [];
  await dispatchReportAlerts(prev, r, { send: async (t) => sent.push(t) });
  assert.equal(sent.length, 1, "yalnız rapor-geri-geldi mesajı (servis geçişi yok)");
  assert.match(sent[0], /^🟢 host-x: rapor geri geldi \(2026-/);
  const doc = await HostReport.findOne({ "host.name": "host-x" }).lean();
  assert.equal(doc.missedAlerts, false, "kilit sıfırlanır (sonraki kesintide yeniden uyarır)");
});

test("scanMissingReports: taze raporu olan host için mesaj YOK", async () => {
  const out = await scanMissingReports({ send: async () => assert.fail("taze host için mesaj gitmemeli") });
  assert.deepEqual(out, []);
});

test("hostsWire: son olay yalnız PANEL verisinde (dış özet bu alanı taşımaz)", async () => {
  const wire = await hostsWire();
  const by = Object.fromEntries(wire.map((h) => [h.name, h]));
  assert.match(by["host-x"].lastAlert.text, /^🟢 host-x: rapor geri geldi/, "rapor-dönüş olayı kalır");
  assert.match(by["host-y"].lastAlert.text, /^🟢 host-y: 2 servis toparlandı/, "çoklu toparlanma tek satır");
  assert.equal(by["host-z"].lastAlert, null, "sessiz kalan hostta son olay YOK");
  for (const h of wire) {
    if (h.lastAlert) assert.ok(Number.isFinite(h.lastAlert.at), "zaman damgası ms");
  }
});

test("alerts:false servis için düştü/toparlandı üretilmez", () => {
  const r1 = serviceTransitions([{ name: "m", status: "up" }], [{ name: "m", status: "down", alerts: false }]);
  assert.equal(r1.downs.length, 0);
  const r2 = serviceTransitions([{ name: "m", status: "down" }], [{ name: "m", status: "up", alerts: false }]);
  assert.equal(r2.ups.length, 0);
  const r3 = serviceTransitions([{ name: "m", status: "up" }], [{ name: "m", status: "down" }]);
  assert.equal(r3.downs.length, 1);
});
