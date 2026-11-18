// Panel "Hosts" bölümünün görünüm modeli — SAF fonksiyonlar (lib/hosts.test.js).
// Bileşen (src/components/Hosts) bunların üzerine ince bir JSX haritasıdır.
// Host/servis adları VERİDEN gelir (hostReports belgeleri); UI'da hardcoded ad YOK.

export const STALE_AFTER_MS = 10 * 60_000; // bayat rapor eşiği (>10 dk → amber)

const pct = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : null);

/** Bar rengi: ≥90 kırmızı, ≥75 amber, ölçüm yok gri. */
export const barTone = (p) => (p == null ? "idle" : p >= 90 ? "down" : p >= 75 ? "warn" : "up");

/** uptimeH → "26 h" / "3.5 d" gibi kısa metin. */
export function fmtUptimeH(h) {
  if (!Number.isFinite(h) || h < 0) return "—";
  return h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} d`;
}

/** hostsWire satırı → kart görünüm modeli. */
export function hostCard(host, now = Date.now()) {
  const at = Number(host?.at) || 0;
  const load = Array.isArray(host?.load) ? host.load.slice(0, 3).map((n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)) : [];
  return {
    name: String(host?.name || ""),
    stale: at ? now - at > STALE_AFTER_MS : true, // rapor yoksa/çok bayatsa amber
    ageS: at ? Math.max(0, Math.round((now - at) / 1000)) : null,
    bars: [
      { key: "cpu", label: "CPU", pct: pct(host?.cpuPct), sub: null },
      { key: "mem", label: "RAM", pct: pct(host?.memPct), sub: Number.isFinite(host?.memMB) ? `${Math.round(host.memMB).toLocaleString("en-US")} MB` : null },
      { key: "disk", label: "Disk", pct: pct(host?.diskPct), sub: Number.isFinite(host?.diskGB) ? `${Math.round(host.diskGB).toLocaleString("en-US")} GB` : null },
    ],
    load,
    uptimeH: Number.isFinite(host?.uptimeH) ? host.uptimeH : null,
    services: (Array.isArray(host?.services) ? host.services : []).map((s) => ({
      name: String(s?.name || ""),
      status: s?.status === "up" ? "up" : "down",
    })),
    // Faz 2b: son geçiş olayı satırı (veriden; yoksa null → UI satırı gizler)
    lastAlert: host?.lastAlert ? { text: String(host.lastAlert.text || ""), at: Number(host.lastAlert.at) || 0 } : null,
  };
}

/**
 * Bölümün görünüm modeli: rapor YOKSA null → bileşen bölümü TAMAMEN gizler
 * (boş durum yok — Faz A kuralı; lib/hosts.test.js bekler).
 */
export function hostsSection(hosts, now = Date.now()) {
  if (!Array.isArray(hosts) || !hosts.length) return null;
  return hosts.map((h) => hostCard(h, now));
}
