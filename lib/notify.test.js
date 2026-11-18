import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { loadConf, sendWhatsapp, eventTexts, NotifyQueue, NOTIFY_WINDOW_MS } from "./notify.js";

// Bildirim katmanı: olay metinleri panel olay_metinleri ile BAYT BAYT aynı;
// WhatsApp gönderimi köprü API desenine (X-API-Key + session/chatId/text) uyar;
// 5 dk gruplama penceresi aynı grubun olaylarını tek mesaja düşürür.
// MESAJ METİNLERİ TÜRKÇEDİR (ürün dili) — kod dili temizliğinden muaf.

test("eventTexts: ungrouped down/up lines in panel format", () => {
  const ts = "2026-11-18T09:00:00+00:00";
  const out = eventTexts(
    [
      ["down", { name: "film", group: null, reason: "HTTP 500", ts }],
      ["up", { name: "film", group: null, ts, ms: 123 }],
    ],
    new Map(),
    new Map(),
  );
  assert.deepEqual(out, [`🔴 DOWN: film — HTTP 500 (${ts})`, `🟢 UP: film tekrar çalışıyor (${ts}, 123 ms)`]);
});

test("eventTexts: 2 downs in one group → single line, down list ordered", () => {
  const ts = "2026-11-18T09:05:00+00:00";
  const events = [
    ["down", { name: "a", group: "render", reason: "timeout", ts }],
    ["down", { name: "b", group: "render", reason: "timeout", ts }],
  ];
  const out = eventTexts(events, new Map([["render", 3]]), new Map([["render", ["a", "b"]]]));
  assert.deepEqual(out, ["🔴 render grubu: 2/3 site kapalı: a, b — timeout (" + ts + ")"]);
});

test("eventTexts: whole group down → n/n (shared app)", () => {
  const ts = "2026-11-18T09:06:00+00:00";
  const events = [
    ["down", { name: "a", group: "render", reason: "timeout", ts }],
    ["down", { name: "b", group: "render", reason: "timeout", ts }],
  ];
  const out = eventTexts(events, new Map([["render", 2]]), new Map([["render", ["a", "b"]]]));
  assert.deepEqual(out, ["🔴 render grubu: 2/2 site kapalı (ortak uygulama) — timeout (" + ts + ")"]);
});

test("eventTexts: single down in a group stays on its own line (≥2 rule)", () => {
  const ts = "2026-11-18T09:07:00+00:00";
  const out = eventTexts([["down", { name: "a", group: "render", reason: "HTTP 500", ts }]], new Map([["render", 3]]), new Map([["render", ["a"]]]));
  assert.deepEqual(out, ["🔴 DOWN: a — HTTP 500 (" + ts + ")"]);
});

test("eventTexts: group recovery single line, names listed", () => {
  const ts = "2026-11-18T09:08:00+00:00";
  const events = [
    ["up", { name: "a", group: "render", ts, ms: 100 }],
    ["up", { name: "b", group: "render", ts, ms: 110 }],
  ];
  const out = eventTexts(events, new Map([["render", 3]]), new Map());
  assert.deepEqual(out, ["🟢 render grubu: 2/3 site tekrar çalışıyor: a, b (" + ts + ")"]);
});

test("eventTexts: SSL warning passes through unchanged", () => {
  const out = eventTexts([["ssl", "⚠️ SSL: film sertifikası 3 gün sonra bitiyor"]], new Map(), new Map());
  assert.deepEqual(out, ["⚠️ SSL: film sertifikası 3 gün sonra bitiyor"]);
});

test("NotifyQueue: two downs in one group merge into ONE message within the window", async () => {
  const sent = [];
  const queue = new NotifyQueue({
    windowMs: 120,
    send: async (text) => sent.push(text),
    stats: async () => ({ size: new Map([["render", 2]]), down: new Map([["render", ["a", "b"]]]) }),
  });
  const ts = "2026-11-18T09:10:00+00:00";
  await queue.add(["down", { name: "a", group: "render", reason: "timeout", ts }]);
  await queue.add(["down", { name: "b", group: "render", reason: "timeout", ts }]);
  assert.equal(sent.length, 0, "pencere kapanmadan gönderim olmamalı");
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(sent.length, 1, "iki olay tek mesaj olmalı");
  assert.match(sent[0], /^🔴 render grubu: 2\/2 site kapalı \(ortak uygulama\) — timeout/);
});

test("NotifyQueue: ungrouped event and SSL go immediately", async () => {
  const sent = [];
  const queue = new NotifyQueue({ windowMs: 5000, send: async (m) => sent.push(m), stats: async () => ({ size: new Map(), down: new Map() }) });
  const ts = "2026-11-18T09:11:00+00:00";
  await queue.add(["down", { name: "tek", group: null, reason: "HTTP 500", ts }]);
  await queue.add(["ssl", "⚠️ SSL: tek sertifikası 5 gün sonra bitiyor"]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], `🔴 DOWN: tek — HTTP 500 (${ts})`);
});

test("sendWhatsapp: matches the bridge API shape (X-API-Key + session/chatId/text)", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (p) => (body += p));
    req.on("end", () => {
      received.push({ key: req.headers["x-api-key"], ua: req.headers["user-agent"], payload: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const conf = { whatsapp: { apiUrl: `http://127.0.0.1:${port}/api/sendText`, apiKey: "gizli-anahtar", session: "oturum1", chatId: "120363@g.us" } };
    const ok = await sendWhatsapp("🔴 DOWN: deneme", conf);
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].key, "gizli-anahtar");
    assert.equal(received[0].ua, "HermesPanel-Uptime/1.0", "köprü Cloudflare'i geçmek için UA göndermeli");
    assert.deepEqual(received[0].payload, { session: "oturum1", chatId: "120363@g.us", text: "🔴 DOWN: deneme" });
  } finally {
    server.close();
  }
});

test("sendWhatsapp: bridge unreachable → error SUPPRESSED (returns false, does not throw)", async () => {
  const conf = { whatsapp: { apiUrl: "http://127.0.0.1:1/yok", apiKey: "x", chatId: "y" } };
  const ok = await sendWhatsapp("deneme", conf);
  assert.equal(ok, false);
});

test("sendWhatsapp: no conf → no-op", async () => {
  assert.equal(await sendWhatsapp("x", { whatsapp: null }), false);
  assert.equal(await sendWhatsapp("x", {}), false);
});

test("loadConf: reads file, missing file → silent whatsapp:null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moon-notify-"));
  const file = path.join(dir, "conf.json");
  fs.writeFileSync(file, JSON.stringify({ whatsapp: { apiUrl: "http://x", apiKey: "k", chatId: "c" } }));
  const conf = loadConf(file);
  assert.equal(conf.whatsapp.apiUrl, "http://x");
  assert.deepEqual(loadConf(path.join(dir, "yok.json")), { whatsapp: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("window constant is 5 minutes", () => {
  assert.equal(NOTIFY_WINDOW_MS, 300_000);
});
