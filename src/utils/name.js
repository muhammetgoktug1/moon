// Bir monitörün adı her zaman dolu olmayabilir (ör. doğrudan mongosh ile
// eklenen kayıt şema doğrulamasını atlar) — eksik ad UI'da ASLA çökertmesin:
// metinlerde "İsimsiz", avatar baş harfinde "?" gösterilir.
const text = (name) => (typeof name === "string" ? name.trim() : "");

/** Monitörün görünen adı: eksik/boşsa "İsimsiz". */
export const nameOf = (m) => text(m?.name) || "İsimsiz";

/** Avatar baş harfi: eksik/boşsa "?". */
export const initial = (name) => text(name)[0]?.toUpperCase() || "?";
