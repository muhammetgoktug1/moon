import assert from "node:assert/strict";
import test from "node:test";
import { hostCard, hostsSection, barTone, fmtUptimeH, STALE_AFTER_MS } from "./hosts.js";

// Panel Hosts bölümünün görünüm modeli (sahte raporla): bölüm gizli/visible,
// bayat rapor >10 dk amber, bar değerleri/kırpma, servis noktaları.

const NOW = 1_700_000_000_000;

const fakeHost = (over = {}) => ({
  name: "host-alpha",
  cpuPct: 12.4,
  memPct: 40.6,
  memMB: 16000,
  diskPct: 61,
  diskGB: 400,
  uptimeH: 26.5,
  load: [0.5, 1.25, 1.75],
  services: [
    { name: "svc-a", status: "up", ms: 5, code: 200 },
    { name: "svc-b", status: "down", ms: 3001, code: 0 },
  ],
  at: NOW - 60_000, // 1 dk önce → taze
  ...over,
});

test("boş durum: veri yoksa bölüm GİZLİ (null — boş durum render YOK)", async () => {
  assert.equal(hostsSection([], NOW), null);
  assert.equal(hostsSection(undefined, NOW), null);
  assert.equal(hostsSection(null, NOW), null);
  // bozma: [] dönülürse bileşim falsy değil → test bu yüzden null bekler
  const fromServerError = hostsSection(undefined, NOW);
  assert.ok(fromServerError === null);
});

test("kart görünümü: barlar/kırpma/yuvarlama (sahte raporla render verisi)", async () => {
  const card = hostCard(fakeHost(), NOW);
  assert.equal(card.name, "host-alpha");
  assert.equal(card.stale, false, "1 dk önceki rapor taze");
  assert.deepEqual(
    card.bars.map((b) => [b.label, b.pct, b.sub]),
    [
      ["CPU", 12, null],
      ["RAM", 41, "16,000 MB"],
      ["Disk", 61, "400 GB"],
    ],
  );
  assert.deepEqual(card.load, [0.5, 1.25, 1.75]);
  assert.equal(card.uptimeH, 26.5);
  const on = { whatsapp: { enabled: true, events: { down: true, recovery: true } } };
  assert.deepEqual(card.services, [
    { name: "svc-a", status: "up", agentMuted: false, notifications: on, mute: "on" },
    { name: "svc-b", status: "down", agentMuted: false, notifications: on, mute: "on" },
  ]);
  assert.equal(card.ageS, 60);
});

test("bayat rapor: >10 dk → stale (amber); ölçüm yoksa yine stale", async () => {
  assert.equal(hostCard(fakeHost({ at: NOW - STALE_AFTER_MS - 1 }), NOW).stale, true, "10 dk + 1 ms → stale");
  assert.equal(hostCard(fakeHost({ at: NOW - STALE_AFTER_MS + 1000 }), NOW).stale, false, "eşik içinde → taze");
  assert.equal(hostCard(fakeHost({ at: 0 }), NOW).stale, true, "at yok → stale");
});

test("eksik ölçümler: pct null → '—' çizgisi, bar 0 genişlik, tone idle", async () => {
  const card = hostCard(fakeHost({ cpuPct: null, memPct: undefined, diskPct: "x" }), NOW);
  assert.deepEqual(card.bars.map((b) => b.pct), [null, null, null]);
  assert.equal(barTone(null), "idle");
});

test("barTone eşikleri: ≥90 down, ≥75 warn, altı up", async () => {
  assert.equal(barTone(0), "up");
  assert.equal(barTone(74), "up");
  assert.equal(barTone(75), "warn");
  assert.equal(barTone(89), "warn");
  assert.equal(barTone(90), "down");
  assert.equal(barTone(100), "down");
});

test("fmtUptimeH: saat/gün biçimi", async () => {
  assert.equal(fmtUptimeH(3.34), "3.3 h");
  assert.equal(fmtUptimeH(47.9), "47.9 h");
  assert.equal(fmtUptimeH(72), "3 d");
  assert.equal(fmtUptimeH(null), "—");
});

test("hostsSection: liste → kart listesi (UI render girdisi)", async () => {
  const cards = hostsSection([fakeHost(), fakeHost({ name: "host-beta", at: NOW - 20 * 60_000 })], NOW);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, "host-alpha");
  assert.equal(cards[1].stale, true, "20 dk önceki rapor amber");
});

test("hostCard: son geçiş olayı VERİDEN gelir; yoksa null (UI satırı gizlenir)", async () => {
  const card = hostCard(fakeHost({ lastAlert: { text: "🔴 host-alpha: svc-a düştü", at: NOW - 5_000 } }), NOW);
  assert.deepEqual(card.lastAlert, { text: "🔴 host-alpha: svc-a düştü", at: NOW - 5_000 });
  assert.equal(hostCard(fakeHost()).lastAlert, null);
  assert.equal(hostCard(fakeHost({ lastAlert: { text: "", at: 0 } })).lastAlert.text, "");
});
