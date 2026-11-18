// Sayfa kapısı + rota yönlendirme kuralları (saf fonksiyon — test edilir).
// Panel (`/`, `/m/...`) oturum ister; `/status` herkese açıktır.
// `/login` oturumluyken panele, `/setup` kayıt kapatıldıysa girişe döner.
// Eski Türkçe yollar kalıcı değil GEÇİÇİ (307) yönlendirme alır — kullanıcı
// yer imleri çalışmaya devam etsin; bir gün yeni adreslere geçilirse 301'e
// çevrilebilir (şimdilik bilinçli olarak 307).

export const REDIRECT_CODE = 307;

// eski yol → yeni yol (sayfalar + kimlik API'leri + dış özet ucu)
export const LEGACY_ROUTES = {
  "/giris": "/login",
  "/kurulum": "/setup",
  "/api/giris": "/api/login",
  "/api/kurulum": "/api/setup",
  "/api/cikis": "/api/logout",
  "/api/disis/ozet": "/api/external/summary",
};

const redirect = (location) => ({ redirect: location, code: REDIRECT_CODE });

/**
 * Yol için kararı döndürür.
 *   { handle: true }                       → Next işlesin (200)
 *   { redirect: "/login", code: 307 }      → geçici yönlendirme
 * session: doğrulanmış oturum (truthy) | null
 * setupOpen: kayıt kilidi açık mı (yalnız /setup için sorulur)
 */
export function routeGate(path, { session = null, setupOpen = true } = {}) {
  if (LEGACY_ROUTES[path]) return { redirect: LEGACY_ROUTES[path], code: REDIRECT_CODE };

  const panel = path === "/" || path.startsWith("/m/");
  if (panel) return session ? { handle: true } : redirect("/login");

  if (path === "/login") return session ? redirect("/") : { handle: true };
  if (path === "/setup") {
    if (session) return redirect("/");
    if (!setupOpen) return redirect("/login");
    return { handle: true };
  }

  return { handle: true }; // /status, _next, icon… herkese açık
}
