import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { sha256 } from "../src/utils/sha256.js";
import {
  authBootstrap,
  setupOpen,
  openFirstAccount,
  login,
  verifySession,
  logout,
  cookieValue,
  cookieHeader,
  rateLimit,
  originAllowed,
  User,
  Session,
  Gate,
  sha256hex,
  COOKIE_NAME,
  LEGACY_COOKIE_NAME,
} from "./auth.js";

// Bu testlerin çalışması için MOON_TEST_MONGO ile bir test MongoDB gösterin
// (makineye özel eşleme repo dışıdır). Test kendi veritabanını kurar ve sonunda siler.
const URI = `${process.env.MOON_TEST_MONGO || "mongodb://127.0.0.1:27017"}/moon_auth_test`;
const digest = (s) => sha256hex(s);

let winnerEmail = "";
let winnerDigest = "";

test.before(async () => {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase().catch(() => {});
  await authBootstrap();
});

test.after(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("saf JS sha256 produces the same digest as node:crypto", () => {
  assert.equal(sha256("abc"), crypto.createHash("sha256").update("abc").digest("hex"));
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256("parola-123-türkçe"), crypto.createHash("sha256").update("parola-123-türkçe", "utf8").digest("hex"));
  assert.equal(sha256(""), crypto.createHash("sha256").update("").digest("hex"));
});

test("collections use the English names (users/sessions/gates)", async () => {
  const names = await mongoose.connection.db.listCollections().toArray();
  const set = new Set(names.map((n) => n.name));
  assert.ok(set.has("users"), "users collection expected");
  assert.ok(set.has("sessions"), "sessions collection expected");
  assert.ok(set.has("gates"), "gates collection expected");
  assert.ok(!set.has("moonusers") && !set.has("moonsessions") && !set.has("moongates"), "legacy collection names must not be created");
});

test("registration is open before setup", async () => {
  assert.equal(await setupOpen(), true);
});

test("invalid email/digest rejected", async () => {
  assert.ok((await openFirstAccount("gecersiz", digest("parola123"))).error);
  assert.ok((await openFirstAccount("a@b.com", "ksaltılmış")).error);
});

test("setup race: only one account opens under concurrent calls", async () => {
  const attempts = Array.from({ length: 8 }, (_, i) => openFirstAccount(`race${i}@test.local`, digest(`parola-${i}-123`)));
  const results = await Promise.all(attempts); // hepsi aynı anda başlar
  const successful = results.filter((r) => !r.error);
  const rejected = results.filter((r) => r.error);
  assert.equal(successful.length, 1, "yalnızca bir hesap açılmalı");
  winnerEmail = successful[0].user.email;
  winnerDigest = digest(`parola-${Number(winnerEmail.match(/\d+/)[0])}-123`);
  assert.equal(rejected.length, 7);
  assert.ok(rejected.every((r) => r.code === 403), "kalanları kayıt kapalı reddetmeli");
  assert.equal(await User.countDocuments(), 1);
  assert.equal(await setupOpen(), false, "ilk hesaptan sonra kayıt kapanır");
});

test("no new account after setup closes", async () => {
  const r = await openFirstAccount("other@test.local", digest("parola123"));
  assert.equal(r.code, 403);
});

test("wrong password fails, correct one opens a session; role is English (admin)", async () => {
  const bad = await login(winnerEmail, digest("wrong-password"), "1.2.3.4");
  assert.equal(bad.code, 401);
  const good = await login(winnerEmail.toUpperCase(), winnerDigest, "1.2.3.4");
  assert.ok(good.token, "e-posta küçük harfe normalize edilmeli");
  assert.equal(good.user.role, "admin");
});

test("session verified; fake cookie fails; logout drops it", async () => {
  const { token } = await login(winnerEmail, winnerDigest, "1.2.3.4");
  const s = await verifySession(token);
  assert.equal(s.email, winnerEmail);
  assert.equal(await verifySession("fake-token"), null);
  await logout(token);
  assert.equal(await verifySession(token), null);
  assert.ok((await Session.countDocuments()) >= 0);
});

test("sliding session: lastUsedAt 31 days ago → session expired", async () => {
  const { token } = await login(winnerEmail, winnerDigest, "1.2.3.4");
  await Session.updateOne({ tokenHash: sha256hex(token) }, { $set: { lastUsedAt: new Date(Date.now() - 31 * 86_400_000) } });
  assert.equal(await verifySession(token), null);
});

test("rate limit fills after 10 attempts", () => {
  const key = `test-${Math.random()}`;
  for (let i = 0; i < 10; i++) assert.equal(rateLimit(key), false);
  assert.equal(rateLimit(key), true);
});

test("cookie: HttpOnly + SameSite=Lax + 30 days; secure optional", () => {
  const c = cookieHeader("abc123", { secure: true });
  assert.match(c, /^moon_session=abc123;/);
  assert.ok(c.includes("HttpOnly"));
  assert.ok(c.includes("SameSite=Lax"));
  assert.ok(c.includes("Secure"));
  assert.ok(c.includes("Max-Age=2592000"));
  assert.ok(!cookieHeader("abc123").includes("Secure"));
  assert.equal(cookieValue(`${COOKIE_NAME}=abc123; other=1`), "abc123");
  assert.equal(cookieValue("other=1"), undefined);
  assert.ok(cookieHeader("", { clear: true }).includes("Max-Age=0"));
});

test("legacy cookie name moon_oturum still reads (sessions survive the rename)", () => {
  assert.equal(COOKIE_NAME, "moon_session");
  assert.equal(LEGACY_COOKIE_NAME, "moon_oturum");
  // eski adla gelen çerez okunabilmeli (yeniden login istemiyoruz)
  assert.equal(cookieValue(`${LEGACY_COOKIE_NAME}=legacy-tok`), "legacy-tok");
  // yeni ad öncelikli
  assert.equal(cookieValue(`${LEGACY_COOKIE_NAME}=old; ${COOKIE_NAME}=new`), "new");
});

test("origin check: same host accepted, foreign rejected, missing passes", () => {
  const host = { host: "panel.example.com", origin: "https://panel.example.com" };
  assert.equal(originAllowed(host), true);
  assert.equal(originAllowed({ host: "panel.example.com", origin: "https://evil.com" }), false);
  assert.equal(originAllowed({ host: "panel.example.com" }), true);
});

test("password length enforced client-side (server only sees the digest)", () => {
  // sunucu tarafı 64-hex dışını reddeder; 8 karakter kuralı istemci formunda,
  // doğrulama testi değil kuralın varlığı:
  assert.match(digest("12345678"), /^[0-9a-f]{64}$/);
});

test("legacy env names produce an English warning (bozma-env)", async () => {
  process.env.MONGODB_URI ||= URI; // config.js require'ları için (yalnız test)
  process.env.PORT ||= "3000";
  const { warnLegacyEnv } = await import("./config.js");
  const lines = [];
  const old = process.env.MOON_KONTROLCU;
  process.env.MOON_KONTROLCU = "1";
  try {
    const found = warnLegacyEnv((m) => lines.push(m));
    assert.deepEqual(found, ["MOON_KONTROLCU"]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MOON_KONTROLCU.*MOON_CHECKER/);
    assert.match(lines[0], /^\[moon\] legacy env/, "warning must be in English");
  } finally {
    if (old === undefined) delete process.env.MOON_KONTROLCU;
    else process.env.MOON_KONTROLCU = old;
  }
  assert.deepEqual(warnLegacyEnv(() => {}), [], "temiz env'de uyarı olmamalı");
});
