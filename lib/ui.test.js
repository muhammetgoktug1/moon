// İstemci sağlamlık testleri: isimsiz monitör (doğrudan mongosh insert'i şema
// doğrulamasını atlayabilir) kartı/status satırı/avatarı ÇÖKERTMEMELİ —
// metinler "İsimsiz", avatar baş harfi "?" gösterir. Ayrıca favicon adresi
// monitör URL'sinden türetilirken https'e zorlanır; geçersiz URL ya da favicon
// yokluğunda baş-harf avatarına düşülür.
//
// İstemci paketi JSX yazar, "@/lib/*" → lib/*, "@/*" → src/* (jsconfig)
// eşlemeleri ve .scss import'ları kullanır; düz node bunların hiçbirini
// çözemez. Bu yüzden GERÇEK bileşenler react-dom/server ile render edilmeden
// önce burada minik çözümleme/dosya kancaları kaydedilir: JSX, next'in kendi
// SWC binding'i ile klasik createElement'e çevrilir (React import'u başa
// eklenir), scss boş modula yönlendirilir. Böylece koruma kaldırılırsa test
// GERÇEKTEN kırmızı olur (render fırlatır).
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const APP = path.join(ROOT, "app");
const LIB = path.join(ROOT, "lib");

const swc = await import("next/dist/build/swc/index.js");
await swc.loadBindings();
const transformSync = swc.getBindingsSync().transformSync;

// uzantısız istemci import'ları için adaylar: aynen, +".js", +"/index.js"
const resolveHere = (nextResolve, context, base, rel) => {
  const stem = path.join(base, rel);
  const candidates = [stem, `${stem}.js`, path.join(stem, "index.js")];
  for (const p of candidates) {
    try {
      return nextResolve(pathToFileURL(p).href, context);
    } catch {
      /* sıradaki aday */
    }
  }
  return nextResolve(pathToFileURL(`${stem}.js`).href, context); /* net hata */
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".scss")) return { url: "data:text/javascript,export default {}", shortCircuit: true };
    if (specifier.startsWith("@/lib/")) return resolveHere(nextResolve, context, LIB, specifier.slice(5));
    if (specifier.startsWith("@/")) return resolveHere(nextResolve, context, SRC, specifier.slice(2));
    try {
      return nextResolve(specifier, context);
    } catch {
      return nextResolve(`${specifier}.js`, context); /* örn. uzantısız "next/link" */
    }
  },
  load(url, context, nextLoad) {
    const p = url.startsWith("file:") ? fileURLToPath(url) : url;
    if ((p.startsWith(`${APP}/`) || p.startsWith(`${SRC}/`)) && /\.(js|jsx)$/.test(p)) {
      const src = fs.readFileSync(p, "utf8");
      const out = transformSync(src, { jsc: { parser: { syntax: "ecmascript", jsx: true } } });
      const code = typeof out === "string" ? out : out.code;
      return { format: "module", shortCircuit: true, source: `import React from "react";\n${code}` };
    }
    return nextLoad(url, context);
  },
});

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const Avatar = (await import("../src/components/Avatar/index.js")).default;
const MonitorCard = (await import("../app/partials/MonitorCard.js")).default;
const Service = (await import("../app/status/partials/Service.js")).default;
const { initial, nameOf } = await import("../src/utils/name.js");
const NotificationFields = (await import("../src/components/NotificationFields/index.js")).default;
const ServiceSettings = (await import("../src/components/Hosts/ServiceSettings.js")).default;

const h = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

// mongosh ile elle eklenmiş, adı (ve dolayısıyla payload'da name alanı) olmayan monitör
const unnamed = {
  id: "m-isimsiz",
  url: "https://example.com/api/health",
  method: "GET",
  group: "",
  checks: [],
  cert: null,
  headerNames: [],
  bodySize: 0,
};

// --- yardımcılar -----------------------------------------------------------

test("initial: eksik/boş adda '?', dolu adda baş harf", () => {
  assert.equal(initial(undefined), "?");
  assert.equal(initial(null), "?");
  assert.equal(initial(""), "?");
  assert.equal(initial("   "), "?");
  assert.equal(initial(123), "?", "ad string değilse '?'");
  assert.equal(initial("film"), "F");
  assert.equal(initial("  istanbul  "), "I");
});

test("nameOf: eksik/boş adda 'İsimsiz', dolu adda kırpılmış ad", () => {
  assert.equal(nameOf(unnamed), "İsimsiz");
  assert.equal(nameOf({}), "İsimsiz");
  assert.equal(nameOf(null), "İsimsiz");
  assert.equal(nameOf({ name: "   " }), "İsimsiz");
  assert.equal(nameOf({ name: " render " }), "render");
});

test("ad sıralaması isimsiz monitörle çökmez", () => {
  const by = (a, b) => nameOf(a).localeCompare(nameOf(b));
  const rows = [{ name: "zeta" }, { name: undefined }, { name: "alpha" }, {}];
  const sorted = [...rows].sort(by);
  assert.equal(sorted.length, 4, "sıralama fırlatmaz");
  assert.deepEqual(sorted.map((m) => nameOf(m)), [...rows.map((m) => nameOf(m))].sort((a, b) => a.localeCompare(b)));
});

// --- avatar ----------------------------------------------------------------

test("avatar: isimsiz monitör '?' gösterir, çökmez", () => {
  const html = h(Avatar, { name: unnamed.name });
  assert.ok(html.includes(">?<"), "span içinde '?' karakteri");
  assert.ok(!html.includes("<img"), "favicon yokken img render edilmez");
});

test("avatar: favicon https'e zorlanır (http origin karma içerik üretmez)", () => {
  const html = h(Avatar, { url: "http://film.example.com/izle", name: "film" });
  assert.match(html, /src="https:\/\/film\.example\.com\/favicon\.ico"/);
  assert.ok(!html.includes("http://"), "http ile hiçbir istik açık kalmaz");
});

test("avatar: https URL aynen kalır, geçersiz URL baş-harfe düşer", () => {
  assert.match(h(Avatar, { url: "https://a.example.com/x", name: "alfa" }), /src="https:\/\/a\.example\.com\/favicon\.ico"/);
  const bad = h(Avatar, { url: "::geçersiz::", name: "beta" });
  assert.ok(!bad.includes("<img"), "geçersiz URL img üretmez");
  assert.ok(bad.includes(">B<"), "baş harfe düşer");
});

test("avatar: URL verilmediğinde favicon istenmez (/status gizliliği)", () => {
  const html = h(Avatar, { name: "gizli" });
  assert.ok(!html.includes("<img"), "public status favicon istemez");
  assert.ok(html.includes(">G<"));
});

// --- kart + status satırı (canlı çöküşün olduğu yerler) --------------------

test("monitor kartı: isimsiz monitör render OLUR ve 'İsimsiz' gösterir", () => {
  const html = h(MonitorCard, { m: unnamed });
  assert.ok(html.includes("İsimsiz"), "kart başlığı 'İsimsiz'");
  assert.ok(html.includes("Pending"), "checks boşken bekliyor durumundadır");
});

test("monitor kartı: URL'süz monitör de çökmez", () => {
  const html = h(MonitorCard, { m: { ...unnamed, url: undefined } });
  assert.ok(html.includes("İsimsiz"));
});

test("/status satırı: isimsiz servis render OLUR, 'İsimsiz' + '?' gösterir", () => {
  const svc = { id: "s1", name: undefined, group: "", last: null, days: [{ day: 1, count: 0, ok: 0 }] };
  const html = h(Service, { m: svc });
  assert.ok(html.includes("İsimsiz"), "satır adı 'İsimsiz'");
  assert.ok(html.includes(">?<"), "avatar baş harfi '?'");
  assert.ok(html.includes("İsimsiz: daily uptime"), "aria-label da güvenli addır");
});

// --- bildirim ayarları (monitör kartı, form bölümü, host servis düğmesi) ------

const withNotifications = (notifications) => ({ ...unnamed, name: "svc-bell", notifications });
const ALL_ON = { whatsapp: { enabled: true, events: { down: true, recovery: true, ssl: true } } };

test("monitor kartı: bildirimi kapalı monitörde 'Notifications off' simgesi; açık/eski kayıtta yok", () => {
  assert.ok(!h(MonitorCard, { m: withNotifications(undefined) }).includes("Notifications off"), "alanı olmayan eski kayıt = açık");
  assert.ok(!/otifications off/.test(h(MonitorCard, { m: withNotifications(ALL_ON) })), "hepsi açık → simge yok");
  const off = h(MonitorCard, { m: withNotifications({ whatsapp: { enabled: false, events: { down: true, recovery: true, ssl: true } } }) });
  assert.match(off, /role="img" aria-label="Notifications off"/);
  assert.match(off, /data-mute="off"/);
  assert.ok(off.includes("<svg"), "simge çizilir");
});

test("monitor kartı: yalnız bazı olaylar kapalıysa soluk 'Some notifications off' simgesi", () => {
  const html = h(MonitorCard, { m: withNotifications({ whatsapp: { enabled: true, events: { down: true, recovery: true, ssl: false } } }) });
  assert.match(html, /aria-label="Some notifications off"/);
  assert.match(html, /data-mute="partial"/);
});

test("bildirim bölümü: WhatsApp anahtarı + monitörde 3 olay; kanal kapalıyken olaylar devre dışı", () => {
  const on = h(NotificationFields, { scope: "monitor", value: ALL_ON, onChange: () => {} });
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.ok(on.includes("WhatsApp"));
  for (const label of ["Down", "Recovered", "SSL expiry"]) assert.ok(on.includes(label), label);
  assert.equal((on.match(/role="checkbox"/g) || []).length, 3);
  assert.ok(!/disabled=""/.test(on), "kanal açıkken olaylar etkin");

  const off = h(NotificationFields, { scope: "monitor", value: { whatsapp: { enabled: false, events: { down: true, recovery: true, ssl: true } } }, onChange: () => {} });
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.equal((off.match(/disabled=""/g) || []).length, 3, "kanal kapalı → olay seçenekleri devre dışı");
});

test("bildirim bölümü: host servisinde SSL olayı yok; eksik değer 'açık' okunur", () => {
  const html = h(NotificationFields, { scope: "hostService", value: { whatsapp: { enabled: true, events: { down: false } } }, onChange: () => {} });
  assert.ok(!html.includes("SSL expiry"));
  assert.equal((html.match(/role="checkbox"/g) || []).length, 2);
  assert.match(html, /aria-checked="false"[^>]*>[^<]*<span[^>]*>✓<\/span>Down/, "down kapalı");
  assert.match(html, /aria-checked="true"[^>]*>[^<]*<span[^>]*>✓<\/span>Recovered/, "recovery eksik = açık");
});

test("host servis düğmesi: host-agent ayarıyla kapalıysa notu gösterir; panelden kapalıysa simge", () => {
  const base = { name: "svc-a", status: "up", agentMuted: false, notifications: { whatsapp: { enabled: true, events: { down: true, recovery: true } } }, mute: "on" };
  const normal = h(ServiceSettings, { host: "host-x", service: base });
  assert.ok(!normal.includes("Off via host-agent setting"));
  assert.ok(!normal.includes("<svg"), "açık servis simge taşımaz");
  assert.match(normal, /aria-label="svc-a: notification settings"/);

  const agent = h(ServiceSettings, { host: "host-x", service: { ...base, agentMuted: true, mute: "agent" } });
  assert.ok(agent.includes("Off via host-agent setting"), "kullanıcıya 'host-agent ayarıyla kapalı' denir");
  assert.match(agent, /title="Notifications off \(host-agent setting\)"/);

  const panel = h(ServiceSettings, { host: "host-x", service: { ...base, notifications: { whatsapp: { enabled: false, events: { down: true, recovery: true } } }, mute: "off" } });
  assert.match(panel, /title="Notifications off"/);
  assert.ok(!panel.includes("Off via host-agent setting"));
});
