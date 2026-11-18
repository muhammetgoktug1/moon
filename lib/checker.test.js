import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import mongoose from "mongoose";
import { Monitor, Check, Group } from "./models.js";
import { olcEt, sweep, etkinAralik, SABITLER, UA } from "./checker.js";

// Kontrolcü kuralları — SAHTE SUNUCULARLA (canlı ölçüm yok; test/canlı disiplini).
// Kapsam: 3 onay döngüsü, toparlanma, kanarya iptali, monitör başına interval,
// down 60 sn hata aralığı, ≤8 paralel, keyword (ilk 300 KB), beklenen_kod,
// GET/HEAD/POST, faz kırılımı + IP, TTL 90 gün, onaysız check confirmed=false.

process.env.MOON_DENEME_ARALIK_MS = "10"; // denemeler arası 3 sn → 10 ms (yalnız test)
const URI = process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27018/moon_checker_test";

// --- sahte sunucu ---
let sunucu;
let port;
const sayac = { istek: new Map(), tepe: 0, anlik: 0 };

function say(path) {
  sayac.istek.set(path, (sayac.istek.get(path) || 0) + 1);
  sayac.anlik++;
  sayac.tepe = Math.max(sayac.tepe, sayac.anlik);
  return () => sayac.anlik--;
}

const KELIME = "MERHABA-DUNYA";
const CUZDAN = "x".repeat(400 * 1024); // keyword 300 KB sınırının ÖTESİNDE

test.before(async () => {
  sunucu = http.createServer((req, res) => {
    const bitti = say(req.url);
    res.on("finish", bitti); // eşzamanlılık: istek yaşam süresi boyunca açık sayılır
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${KELIME} canli</body></html>`);
    } else if (req.url === "/hata") {
      res.writeHead(500);
      res.end("boom");
    } else if (req.url === "/kelime-yok") {
      res.writeHead(200);
      res.end("baska icerik");
    } else if (req.url === "/kelime-uzak") {
      res.writeHead(200);
      res.end(CUZDAN.slice(0, 350 * 1024) + KELIME); // kelime 300 KB'dan sonra
    } else if (req.url === "/401") {
      res.writeHead(401);
      res.end("gizli");
    } else if (req.url === "/yavas") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("ok");
      }, 250);
    } else if (req.url === "/yonlen") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => sunucu.listen(0, "127.0.0.1", r));
  port = sunucu.address().port;
  // kanarya da sahte sunucuya bağlanır — testler dış ağa çıkmasın (test/canlı disiplini)
  process.env.MOON_KANARYA_URLLER = `http://127.0.0.1:${port}/ok`;

  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await Check.syncIndexes();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
  sunucu.close();
  delete process.env.MOON_DENEME_ARALIK_MS;
  delete process.env.MOON_KANARYA_URLLER;
});

const URL = (yol) => `http://127.0.0.1:${port}${yol}`;
const gidenYok = { ekle: async () => {} };

// önceki testlerin monitörlerini due-dışı bırak (monitör başına interval testi için)
const hepsiniTazele = () => Monitor.updateMany({}, { lastCheckedAt: new Date() });

async function monitorYarat(alanlar = {}) {
  return Monitor.create({ name: "test", url: URL("/ok"), interval: 900, ...alanlar });
}

// --- birim: ölçüm kuralları ---

test("olcEt: 200 başarı, faz kırılımı ve cevaplayan IP dolar", async () => {
  const m = { url: URL("/ok"), method: "GET" };
  const s = await olcEt(m);
  assert.equal(s.check.ok, true);
  assert.equal(s.check.status, 200);
  assert.ok(s.check.ip.length > 0, "cevaplayan IP dolmalı");
  assert.ok(s.check.phases, "faz kırılımı dolmalı");
  assert.ok(s.check.phases.dns >= 0 && s.check.phases.tcp >= 0 && s.check.phases.server >= 0);
});

test("olcEt: UA panel değeridir (HermesPanel-Uptime/1.0)", async () => {
  assert.equal(UA, "HermesPanel-Uptime/1.0 (+uptime-monitor)");
  let gorulen = "";
  const s = http.createServer((req, res) => {
    gorulen = req.headers["user-agent"];
    res.writeHead(200);
    res.end();
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  await olcEt({ url: `http://127.0.0.1:${s.address().port}/`, method: "GET" });
  s.close();
  assert.equal(gorulen, UA);
});

test("olcEt: keyword gövdede VAR → başarı; YOK → başarısız + 'anahtar kelime yok' (bozma-keyword)", async () => {
  const varken = await olcEt({ url: URL("/ok"), method: "GET", keyword: KELIME });
  assert.equal(varken.check.ok, true);
  const yoken = await olcEt({ url: URL("/kelime-yok"), method: "GET", keyword: KELIME });
  assert.equal(yoken.check.ok, false);
  assert.match(yoken.check.error, /^anahtar kelime yok: MERHABA-DUNYA/);
  // büyük/küçük duyarsız
  const kucuk = await olcEt({ url: URL("/ok"), method: "GET", keyword: KELIME.toLowerCase() });
  assert.equal(kucuk.check.ok, true);
});

test("olcEt: keyword 300 KB SINIRININ ötesindeyse bulunmaz → başarısız", async () => {
  const s = await olcEt({ url: URL("/kelime-uzak"), method: "GET", keyword: KELIME });
  assert.equal(s.check.ok, false, "ilk 300 KB'da olmayan kelime başarısız sayılmalı");
  assert.match(s.check.error, /^anahtar kelime yok/);
});

test("olcEt: beklenen_kod doluysa YALNIZ o kod başarılı (401 → ok)", async () => {
  const beklenenli = await olcEt({ url: URL("/401"), method: "GET", beklenenKod: 401 });
  assert.equal(beklenenli.check.ok, true);
  assert.equal(beklenenli.check.status, 401);
  const beklenensiz = await olcEt({ url: URL("/401"), method: "GET" });
  assert.equal(beklenensiz.check.ok, false);
  assert.equal(beklenensiz.check.error, "HTTP 401");
  const yanlisBeklenen = await olcEt({ url: URL("/ok"), method: "GET", beklenenKod: 401 });
  assert.equal(yanlisBeklenen.check.ok, false);
  assert.match(yanlisBeklenen.check.error, /beklenen 401/);
});

test("olcEt: HEAD ve POST + gövde desteklenir", async () => {
  const head = await olcEt({ url: URL("/ok"), method: "HEAD" });
  assert.equal(head.check.ok, true);
  const post = await olcEt({ url: URL("/ok"), method: "POST", body: '{"a":1}' });
  assert.equal(post.check.ok, true);
});

test("olcEt: hatalı istek 3 kez denenir (ilk başarılı = up)", async () => {
  sayac.istek.set("/hata", 0);
  const s = await olcEt({ url: URL("/hata"), method: "GET" });
  assert.equal(s.check.ok, false);
  assert.equal(sayac.istek.get("/hata"), 3, "3 deneme yapılmalı");
});

test("olcEt: yönlendirme izlenir, yönlendiği sayfanın içeriği kontrol edilir", async () => {
  const s = await olcEt({ url: URL("/yonlen"), method: "GET", keyword: KELIME });
  assert.equal(s.check.ok, true);
  assert.equal(s.check.error, "");
});

// --- birim: etkin aralık ---

test("etkinAralik: hata sürerken min(interval, 60); sağlıklıyken interval", () => {
  assert.equal(etkinAralik({ interval: 900, consecutiveFailures: 0 }), 900);
  assert.equal(etkinAralik({ interval: 900, consecutiveFailures: 2 }), 60);
  assert.equal(etkinAralik({ interval: 30, consecutiveFailures: 1 }), 30);
});

// --- entegrasyon: sweep ---

test("sweep: 3 onay döngüsü — ilk hata down DEMEZ (bozma-3onay)", async () => {
  const m = await monitorYarat({ url: URL("/hata"), name: "uc-onay" });
  const kuyruk = { olaylar: [], ekle: async (o) => kuyruk.olaylar.push(o) };

  const t1 = await sweep({ kuyruk });
  assert.equal(t1.olcum, 1);
  assert.equal(t1.kanarya, true);
  let dok = await Monitor.findById(m._id).lean();
  assert.equal(dok.consecutiveFailures, 1);
  assert.notEqual(dok.status, "down", "tek hata down ilan etmemeli");
  let checkler = await Check.find({ monitor: m._id }).lean();
  assert.equal(checkler.length, 1);
  assert.equal(checkler[0].ok, false);
  assert.equal(checkler[0].confirmed, false, "onaysız başarısızlık confirmed=false");

  // 2. tur: hâlâ down değil
  await Monitor.updateOne({ _id: m._id }, { lastCheckedAt: new Date(Date.now() - 61_000) });
  await sweep({ kuyruk });
  dok = await Monitor.findById(m._id).lean();
  assert.equal(dok.consecutiveFailures, 2);
  assert.notEqual(dok.status, "down", "iki hata da down ilan etmemeli");

  // 3. tur: ONAYLI down + tek bildirim olayı
  await Monitor.updateOne({ _id: m._id }, { lastCheckedAt: new Date(Date.now() - 61_000) });
  const t3 = await sweep({ kuyruk });
  dok = await Monitor.findById(m._id).lean();
  assert.equal(dok.status, "down");
  assert.equal(dok.consecutiveFailures, 3);
  const onayli = await Check.find({ monitor: m._id }).sort({ at: 1 }).lean();
  assert.equal(onayli.length, 3);
  assert.equal(onayli[0].confirmed, false);
  assert.equal(onayli[1].confirmed, false);
  assert.equal(onayli[2].confirmed, true, "3. turda onaylı");
  const downlar = kuyruk.olaylar.filter(([tur]) => tur === "down");
  assert.equal(downlar.length, 1, "down bildirimi YALNIZ onay turunda bir kez");

  // 4. tur: down sürüyor → YENİ down bildirimi yok
  await Monitor.updateOne({ _id: m._id }, { lastCheckedAt: new Date(Date.now() - 61_000) });
  await sweep({ kuyruk });
  assert.equal(kuyruk.olaylar.filter(([tur]) => tur === "down").length, 1);
});

test("sweep: toparlanma — 1 başarı up döner ve bildirim gider", async () => {
  const m = await monitorYarat({ url: URL("/ok"), name: "toparlanma", status: "down", consecutiveFailures: 4 });
  const kuyruk = { olaylar: [], ekle: async (o) => kuyruk.olaylar.push(o) };
  await sweep({ kuyruk });
  const dok = await Monitor.findById(m._id).lean();
  assert.equal(dok.status, "up");
  assert.equal(dok.consecutiveFailures, 0);
  const uplar = kuyruk.olaylar.filter(([tur]) => tur === "up");
  assert.equal(uplar.length, 1);
  assert.equal(uplar[0][1].name, "toparlanma");
});

test("sweep: kanarya düşükse tur İPTAL — ölçüm yok, olay yok (bozma-kanarya)", async () => {
  const onceki = process.env.MOON_KANARYA_URLLER;
  process.env.MOON_KANARYA_URLLER = "http://127.0.0.1:9/yok1,http://127.0.0.1:9/yok2"; // erişilemez
  try {
    const m = await monitorYarat({ url: URL("/ok"), name: "kanarya-denem" });
    const kuyruk = { olaylar: [], ekle: async (o) => kuyruk.olaylar.push(o) };
    const sonuc = await sweep({ kuyruk });
    assert.equal(sonuc.kanarya, false);
    assert.equal(sonuc.olcum, 0);
    assert.equal(await Check.countDocuments({ monitor: m._id }), 0, "tur iptal: check YAZILMAMALI");
    assert.equal(kuyruk.olaylar.length, 0);
    const dok = await Monitor.findById(m._id).lean();
    assert.equal(dok.status, "pending", "site düşmüş sayılmaz");
  } finally {
    if (onceki === undefined) delete process.env.MOON_KANARYA_URLLER;
    else process.env.MOON_KANARYA_URLLER = onceki;
  }
});

test("sweep: monitör başına interval — süresi gelmeyen ölçülmez", async () => {
  await hepsiniTazele();
  const taze = await monitorYarat({ name: "taze", lastCheckedAt: new Date(Date.now() - 5_000) });
  const sonuc = await sweep({ kuyruk: gidenYok });
  assert.equal(sonuc.olcum, 0, "yarım dakika önce ölçülen (interval 900) due olmamalı");
  assert.equal(await Check.countDocuments({ monitor: taze._id }), 0);
});

test("sweep: down/hata sürerken 60 sn'de bir denenir (900 beklemeksizin)", async () => {
  await hepsiniTazele();
  const m = await monitorYarat({
    name: "hata-aralik",
    url: URL("/hata"),
    consecutiveFailures: 1,
    lastCheckedAt: new Date(Date.now() - 61_000),
  });
  const sonuc = await sweep({ kuyruk: gidenYok });
  assert.ok(sonuc.olcum >= 1, "61 sn önce hata alan monitör due olmalı (etkin 60 sn)");
  assert.ok((await Check.countDocuments({ monitor: m._id })) >= 1);
});

test("sweep: sağlıklı monitör 61 sn sonra due DEĞİL (interval 900)", async () => {
  await hepsiniTazele();
  await monitorYarat({ name: "saglikli-61sn", consecutiveFailures: 0, lastCheckedAt: new Date(Date.now() - 61_000) });
  const sonuc = await sweep({ kuyruk: gidenYok });
  assert.equal(sonuc.olcum, 0, "consec=0 + 61 sn → due değil");
});

test("sweep: kapalı (enabled=false) monitör hiç ölçülmez", async () => {
  const m = await monitorYarat({ name: "kapali-test", enabled: false });
  await sweep({ kuyruk: gidenYok });
  assert.equal(await Check.countDocuments({ monitor: m._id }), 0);
});

test("sweep: ≤8 paralel işçi (12 yavaş monitör, tepe eşzamanlılık ≤8)", async () => {
  await hepsiniTazele();
  await Monitor.deleteMany({ name: /^yavas-/ });
  for (let i = 0; i < 12; i++) {
    await monitorYarat({ name: `yavas-${i}`, url: URL("/yavas") });
  }
  sayac.tepe = 0;
  sayac.anlik = 0;
  const sonuc = await sweep({ kuyruk: gidenYok });
  assert.equal(sonuc.olcum, 12);
  assert.ok(sayac.tepe > 1, "paralellik gerçekten işliyor olmalı");
  assert.ok(sayac.tepe <= SABITLER.MAX_PARALEL, `tepe eşzamanlılık ${sayac.tepe} ≤ 8 olmalı`);
  await Monitor.deleteMany({ name: /^yavas-/ });
});

test("sweep: faz kırılımı ve cevaplayan IP check'e yazılır", async () => {
  await hepsiniTazele();
  const m = await monitorYarat({ name: "fazli" });
  await sweep({ kuyruk: gidenYok });
  const c = await Check.findOne({ monitor: m._id }).sort({ at: -1 }).lean();
  assert.ok(c.phases, "faz kırılımı yazılmalı");
  assert.ok(c.phases.dns >= 0);
  assert.ok(c.phases.tcp >= 0);
  assert.ok(c.ip && c.ip.length > 0, "cevaplayan IP yazılmalı");
});

test("şema: check TTL indeksi 90 gündür (panel kuralı)", async () => {
  const indeksler = await Check.collection.indexes();
  const ttl = indeksler.find((i) => i.name === "at_1");
  assert.ok(ttl, "at_1 TTL indeksi olmalı");
  assert.equal(ttl.expireAfterSeconds, 90 * 86_400);
});

test("sabitler: panel değerleri (20sn TO, 3 deneme, 3 onay, ≤8 paralel, SSL 14g)", () => {
  assert.equal(SABITLER.CHECK_TIMEOUT_MS, 20_000);
  assert.equal(SABITLER.MAX_ATTEMPTS, 3);
  assert.equal(SABITLER.RETRY_DELAY_MS, 3_000);
  assert.equal(SABITLER.CONFIRM_CYCLES, 3);
  assert.equal(SABITLER.MAX_PARALEL, 8);
  assert.equal(SABITLER.SSL_ESIK_GUN, 14);
  assert.equal(SABITLER.KEYWORD_LIMIT, 300_000);
});
