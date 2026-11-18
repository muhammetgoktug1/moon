import assert from "node:assert/strict";
import test from "node:test";
import { routeGate, LEGACY_ROUTES, REDIRECT_CODE } from "./routes.js";

// Rota kapısı: yeni yollar 200 (handle), eski Türkçe yollar 307 (GEÇİCİ) ile
// yenilere yönlenir — kullanıcı yer imleri çalışmaya devam eder.
// Bozma: 301 (kalıcı) OLMAZ; yeni rota bozulursa (handle değil redirect
// dönerse) bu testler kırmızı çıkar.

const session = { email: "a@b.c" };

test("panel pages: session → handled, anonymous → 307 /login", () => {
  assert.deepEqual(routeGate("/", { session }), { handle: true });
  assert.deepEqual(routeGate("/m/abc", { session }), { handle: true });
  const anon = routeGate("/", { session: null });
  assert.equal(anon.redirect, "/login");
  assert.equal(anon.code, REDIRECT_CODE);
});

test("/login: anonymous → handled (200), session → 307 /", () => {
  assert.deepEqual(routeGate("/login", { session: null }), { handle: true });
  const authed = routeGate("/login", { session });
  assert.equal(authed.redirect, "/");
  assert.equal(authed.code, REDIRECT_CODE);
});

test("/setup: open → handled; closed → 307 /login; authed → 307 /", () => {
  assert.deepEqual(routeGate("/setup", { session: null, setupOpen: true }), { handle: true });
  const closed = routeGate("/setup", { session: null, setupOpen: false });
  assert.equal(closed.redirect, "/login");
  const authed = routeGate("/setup", { session, setupOpen: true });
  assert.equal(authed.redirect, "/");
});

test("public paths always handled", () => {
  for (const p of ["/status", "/_next/static/x.js", "/icon.svg", "/api/external/summary"]) {
    assert.deepEqual(routeGate(p, { session: null }), { handle: true }, p);
  }
});

test("legacy Turkish routes 307 to the new English ones (bookmarks survive)", () => {
  assert.deepEqual(LEGACY_ROUTES, {
    "/giris": "/login",
    "/kurulum": "/setup",
    "/api/giris": "/api/login",
    "/api/kurulum": "/api/setup",
    "/api/cikis": "/api/logout",
    "/api/disis/ozet": "/api/external/summary",
  });
  for (const [oldPath, newPath] of Object.entries(LEGACY_ROUTES)) {
    const d = routeGate(oldPath, { session: null });
    assert.equal(d.redirect, newPath, `${oldPath} → ${newPath}`);
    assert.equal(d.code, 307, `${oldPath} 307 olmalı`);
  }
});

test("bozma-301: legacy redirects are TEMPORARY (307), never permanent (301)", () => {
  assert.equal(REDIRECT_CODE, 307);
  for (const oldPath of Object.keys(LEGACY_ROUTES)) {
    assert.equal(routeGate(oldPath, { session: null }).code, 307, `${oldPath} kalıcı olmamalı`);
  }
});

test("bozma-yeni-rota: breaking /login (returning a redirect) turns this red", () => {
  // /login anonim için handle dönmeli; eğer kapı yanlışlıkla yönlendirme
  // döndürürse (yeni rota bozulursa) bu satır patlar.
  const d = routeGate("/login", { session: null, setupOpen: false });
  assert.equal(d.redirect, undefined, "/login anonim kullanıcıya sunulmalı (200)");
  assert.equal(d.handle, true);
});
