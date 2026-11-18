import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { confYukle, whatsappGonder, olayMetinleri, BildirimKuyrugu, BILDIRIM_PENCERE_MS } from "./bildirim.js";

// Bildirim katmanı: olay metinleri panel olay_metinleri ile BAYT BAYT aynı;
// WhatsApp gönderimi köprü API desenine (X-API-Key + session/chatId/text) uyar;
// 5 dk gruplama penceresi aynı grubun olaylarını tek mesaja düşürür.

test("olayMetinleri: grupsuz down/up satırları panel biçiminde", () => {
  const ts = "2026-11-18T09:00:00+00:00";
  const cikti = olayMetinleri(
    [
      ["down", { name: "film", grup: null, reason: "HTTP 500", ts }],
      ["up", { name: "film", grup: null, ts, ms: 123 }],
    ],
    new Map(),
    new Map(),
  );
  assert.deepEqual(cikti, [`🔴 DOWN: film — HTTP 500 (${ts})`, `🟢 UP: film tekrar çalışıyor (${ts}, 123 ms)`]);
});

test("olayMetinleri: aynı gruptan 2 down → tek satır, kapalı listesi sıralı", () => {
  const ts = "2026-11-18T09:05:00+00:00";
  const olaylar = [
    ["down", { name: "a", grup: "render", reason: "timeout", ts }],
    ["down", { name: "b", grup: "render", reason: "timeout", ts }],
  ];
  const cikti = olayMetinleri(olaylar, new Map([["render", 3]]), new Map([["render", ["a", "b"]]]));
  assert.deepEqual(cikti, ["🔴 render grubu: 2/3 site kapalı: a, b — timeout (" + ts + ")"]);
});

test("olayMetinleri: grubun tamamı kapalı → n/n (ortak uygulama)", () => {
  const ts = "2026-11-18T09:06:00+00:00";
  const olaylar = [
    ["down", { name: "a", grup: "render", reason: "timeout", ts }],
    ["down", { name: "b", grup: "render", reason: "timeout", ts }],
  ];
  const cikti = olayMetinleri(olaylar, new Map([["render", 2]]), new Map([["render", ["a", "b"]]]));
  assert.deepEqual(cikti, ["🔴 render grubu: 2/2 site kapalı (ortak uygulama) — timeout (" + ts + ")"]);
});

test("olayMetinleri: gruptan tek düşen ayrı satırda kalır (≥2 kuralı)", () => {
  const ts = "2026-11-18T09:07:00+00:00";
  const cikti = olayMetinleri([["down", { name: "a", grup: "render", reason: "HTTP 500", ts }]], new Map([["render", 3]]), new Map([["render", ["a"]]]));
  assert.deepEqual(cikti, ["🔴 DOWN: a — HTTP 500 (" + ts + ")"]);
});

test("olayMetinleri: toparlanma grubu tek satır, adlar listede", () => {
  const ts = "2026-11-18T09:08:00+00:00";
  const olaylar = [
    ["up", { name: "a", grup: "render", ts, ms: 100 }],
    ["up", { name: "b", grup: "render", ts, ms: 110 }],
  ];
  const cikti = olayMetinleri(olaylar, new Map([["render", 3]]), new Map());
  assert.deepEqual(cikti, ["🟢 render grubu: 2/3 site tekrar çalışıyor: a, b (" + ts + ")"]);
});

test("olayMetinleri: SSL uyarısı aynen geçer", () => {
  const cikti = olayMetinleri([["ssl", "⚠️ SSL: film sertifikası 3 gün sonra bitiyor"]], new Map(), new Map());
  assert.deepEqual(cikti, ["⚠️ SSL: film sertifikası 3 gün sonra bitiyor"]);
});

test("BildirimKuyrugu: aynı gruptan iki down pencere içinde TEK mesaja birleşir", async () => {
  const giden = [];
  const kuyruk = new BildirimKuyrugu({
    pencereMs: 120,
    gonder: async (metin) => giden.push(metin),
    bilgilendir: async () => ({ boyut: new Map([["render", 2]]), kapali: new Map([["render", ["a", "b"]]]) }),
  });
  const ts = "2026-11-18T09:10:00+00:00";
  await kuyruk.ekle(["down", { name: "a", grup: "render", reason: "timeout", ts }]);
  await kuyruk.ekle(["down", { name: "b", grup: "render", reason: "timeout", ts }]);
  assert.equal(giden.length, 0, "pencere kapanmadan gönderim olmamalı");
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(giden.length, 1, "iki olay tek mesaj olmalı");
  assert.match(giden[0], /^🔴 render grubu: 2\/2 site kapalı \(ortak uygulama\) — timeout/);
});

test("BildirimKuyrugu: grupsuz olay ve SSL bekletilmeden gider", async () => {
  const giden = [];
  const kuyruk = new BildirimKuyrugu({ pencereMs: 5000, gonder: async (m) => giden.push(m), bilgilendir: async () => ({ boyut: new Map(), kapali: new Map() }) });
  const ts = "2026-11-18T09:11:00+00:00";
  await kuyruk.ekle(["down", { name: "tek", grup: null, reason: "HTTP 500", ts }]);
  await kuyruk.ekle(["ssl", "⚠️ SSL: tek sertifikası 5 gün sonra bitiyor"]);
  assert.equal(giden.length, 2);
  assert.equal(giden[0], `🔴 DOWN: tek — HTTP 500 (${ts})`);
});

test("whatsappGonder: köprü API desenine uyar (X-API-Key + session/chatId/text)", async () => {
  const gelen = [];
  const sunucu = http.createServer((req, res) => {
    let govde = "";
    req.on("data", (p) => (govde += p));
    req.on("end", () => {
      gelen.push({ key: req.headers["x-api-key"], icerik: JSON.parse(govde) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => sunucu.listen(0, "127.0.0.1", r));
  const port = sunucu.address().port;
  try {
    const conf = { whatsapp: { apiUrl: `http://127.0.0.1:${port}/api/sendText`, apiKey: "gizli-anahtar", session: "oturum1", chatId: "120363@g.us" } };
    const ok = await whatsappGonder("🔴 DOWN: deneme", conf);
    assert.equal(ok, true);
    assert.equal(gelen.length, 1);
    assert.equal(gelen[0].key, "gizli-anahtar");
    assert.deepEqual(gelen[0].icerik, { session: "oturum1", chatId: "120363@g.us", text: "🔴 DOWN: deneme" });
  } finally {
    sunucu.close();
  }
});

test("whatsappGonder: köprü erişilemezse hata BASTIRILIR (false döner, fırlamaz)", async () => {
  const conf = { whatsapp: { apiUrl: "http://127.0.0.1:1/yok", apiKey: "x", chatId: "y" } };
  const ok = await whatsappGonder("deneme", conf);
  assert.equal(ok, false);
});

test("whatsappGonder: conf yoksa hiçbir şey yapmaz", async () => {
  assert.equal(await whatsappGonder("x", { whatsapp: null }), false);
  assert.equal(await whatsappGonder("x", {}), false);
});

test("confYukle: dosyadan okur, yoksa sessiz whatsapp:null", () => {
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), "moon-bild-"));
  const dosya = path.join(dizin, "conf.json");
  fs.writeFileSync(dosya, JSON.stringify({ whatsapp: { apiUrl: "http://x", apiKey: "k", chatId: "c" } }));
  const conf = confYukle(dosya);
  assert.equal(conf.whatsapp.apiUrl, "http://x");
  assert.deepEqual(confYukle(path.join(dizin, "yok.json")), { whatsapp: null });
  fs.rmSync(dizin, { recursive: true, force: true });
});

test("pencere sabiti 5 dakikadır", () => {
  assert.equal(BILDIRIM_PENCERE_MS, 300_000);
});
