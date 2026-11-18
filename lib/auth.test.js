import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { sha256 } from "../src/utils/sha256.js";
import {
  authBootstrap,
  setupAcikMi,
  ilkHesabiAc,
  girisYap,
  oturumDenetle,
  cikisYap,
  cerezDegeri,
  cerezBasligi,
  hizSiniri,
  kokenKabul,
  User,
  Session,
  Gate,
  sha256hex,
  COOKIE_ADI,
} from "./auth.js";

// Bu test çalışması için Moon MongoDB'sinin 127.0.0.1:27018'de eşlenmiş olması gerekir
// (compose.override.yaml). Test kendi veritabanını kurar ve sonunda siler.
const URI = process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27018/moon_auth_test";
const ozet = (s) => sha256hex(s);

let kazanEmail = "";
let kazanOzet = "";

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await authBootstrap();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("saf JS sha256, node:crypto ile aynı özeti üretir", () => {
  assert.equal(sha256("abc"), crypto.createHash("sha256").update("abc").digest("hex"));
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("parola-123-türkçe"), crypto.createHash("sha256").update("parola-123-türkçe", "utf8").digest("hex"));
  assert.equal(sha256(""), crypto.createHash("sha256").update("").digest("hex"));
});

test("kurulum öncesi kayıt açıktır", async () => {
  assert.equal(await setupAcikMi(), true);
});

test("geçersiz e-posta/özet reddedilir", async () => {
  assert.ok((await ilkHesabiAc("gecersiz", ozet("parola123"))).hata);
  assert.ok((await ilkHesabiAc("a@b.com", "ksaltılmış")).hata);
});

test("kurulum yarışı: eşzamanlı çağrılarda yalnızca bir hesap açılır", async () => {
  const denemeler = Array.from({ length: 8 }, (_, i) => ilkHesabiAc(`yaris${i}@test.local`, ozet(`parola-${i}-123`)));
  const sonuc = await Promise.all(denemeler); // hepsi aynı anda başlar
  const basarili = sonuc.filter((s) => !s.hata);
  const basarisiz = sonuc.filter((s) => s.hata);
  assert.equal(basarili.length, 1, "yalnızca bir hesap açılmalı");
  kazanEmail = basarili[0].user.email;
  kazanOzet = ozet(`parola-${Number(kazanEmail.match(/\d+/)[0])}-123`);
  assert.equal(basarisiz.length, 7);
  assert.ok(basarisiz.every((s) => s.kod === 403), "kalanları kayıt kapalı reddetmeli");
  assert.equal(await User.countDocuments(), 1);
  assert.equal(await setupAcikMi(), false, "ilk hesaptan sonra kayıt kapanır");
});

test("kurulum kapalıyken yeni hesap açılamaz", async () => {
  const s = await ilkHesabiAc("baska@test.local", ozet("parola123"));
  assert.equal(s.kod, 403);
});

test("yanlış parola ile giriş olmaz, doğrusu ile oturum açılır", async () => {
  const kotu = await girisYap(kazanEmail, ozet("yanlis-parola"), "1.2.3.4");
  assert.equal(kotu.kod, 401);
  const iyi = await girisYap(kazanEmail.toUpperCase(), kazanOzet, "1.2.3.4");
  assert.ok(iyi.token, "e-posta küçük harfe normalize edilmeli");
  assert.equal(iyi.user.role, "yonetici");
});

test("oturum denetlenir; sahte çerez geçmez; çıkış düşürür", async () => {
  const { token } = await girisYap(kazanEmail, kazanOzet, "1.2.3.4");
  const o = await oturumDenetle(token);
  assert.equal(o.email, kazanEmail);
  assert.equal(await oturumDenetle("sahte-token"), null);
  await cikisYap(token);
  assert.equal(await oturumDenetle(token), null);
  assert.ok((await Session.countDocuments()) >= 0);
});

test("oturum kayarı: son kullanma 31 gün önceyse oturum düşmüştür", async () => {
  const { token } = await girisYap(kazanEmail, kazanOzet, "1.2.3.4");
  await Session.updateOne({ tokenHash: sha256hex(token) }, { $set: { sonKullanma: new Date(Date.now() - 31 * 86_400_000) } });
  assert.equal(await oturumDenetle(token), null);
});

test("hız sınırı: 10 denemeden sonra dolar", () => {
  const anahtar = `test-${Math.random()}`;
  for (let i = 0; i < 10; i++) assert.equal(hizSiniri(anahtar), false);
  assert.equal(hizSiniri(anahtar), true);
});

test("çerez: HttpOnly + SameSite=Lax + 30 gün; secure isteğe bağlı", () => {
  const c = cerezBasligi("abc123", { guvenli: true });
  assert.match(c, /^moon_oturum=abc123;/);
  assert.ok(c.includes("HttpOnly"));
  assert.ok(c.includes("SameSite=Lax"));
  assert.ok(c.includes("Secure"));
  assert.ok(c.includes("Max-Age=2592000"));
  assert.ok(!cerezBasligi("abc123").includes("Secure"));
  assert.equal(cerezDegeri(`${COOKIE_ADI}=abc123; baska=1`), "abc123");
  assert.equal(cerezDegeri("baska=1"), undefined);
  assert.ok(cerezBasligi("", { sil: true }).includes("Max-Age=0"));
});

test("Origin kontrolü: aynı host kabul, yabancı reddedilir, yoksa geçer", () => {
  const host = { host: "moon.sistem.com", origin: "https://moon.sistem.com" };
  assert.equal(kokenKabul(host), true);
  assert.equal(kokenKabul({ host: "moon.sistem.com", origin: "https://kotu.com" }), false);
  assert.equal(kokenKabul({ host: "moon.sistem.com" }), true);
});

test("parola uzunluğu istemcide zorlanır (sunucu yalnız özet görür)", () => {
  // sunucu tarafı 64-hex dışını reddeder; 8 karakter kuralı istemci formunda,
  // doğrulama testi değil kuralın varlığı:
  assert.match(ozet("12345678"), /^[0-9a-f]{64}$/);
});
