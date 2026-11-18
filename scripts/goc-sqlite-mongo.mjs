#!/usr/bin/env node
// Göç: uptime SQLite KOPI veritabanı → Moon MongoDB.
//
//   node scripts/goc-sqlite-mongo.mjs <kaynak.db> <mongoUri> [--kurut] [--gun 30]
//
// --kurut : Moon'un monitors/checks/groups koleksiyonlarını yazmadan önce temizler.
// İdempotent: aynı kaynakla ikinci koşu 0 yeni kayıt ekler.
// Canlı uptime DB'sine ASLA bağlanmayın — daima kopya üzerinde çalışın.

import process from "node:process";
import { kaynakOku, hedefeYaz } from "../lib/goc.js";

const args = process.argv.slice(2);
const kurut = args.includes("--kurut");
const gunIdx = args.indexOf("--gun");
const gun = gunIdx >= 0 ? Number(args[gunIdx + 1]) || 30 : 30;
const dosyalar = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--gun");

if (dosyalar.length < 2) {
  console.error("Kullanım: node scripts/goc-sqlite-mongo.mjs <kaynak.db> <mongoUri> [--kurut] [--gun 30]");
  process.exit(2);
}

const [kaynak, uri] = dosyalar;

console.log(`kaynak: ${kaynak} (pencere: ${gun} gün)`);
const veri = kaynakOku(kaynak, gun);
console.log(`okundu: ${veri.monitorler.length} monitör, ${veri.checkler.length} check, atlanan: ${veri.atlanan.length}`);
for (const a of veri.atlanan) console.warn(`  ATLANDI: ${a.ad} — ${a.neden} (${a.url})`);

const sonuc = await hedefeYaz(uri, veri, { kurut });
console.log(JSON.stringify(sonuc, null, 2));
console.log(
  `bitti: monitör +${sonuc.monitorlar.yeni}/${sonuc.monitorlar.toplam}, check +${sonuc.checkler.yeni}/${sonuc.checkler.toplam}, grup +${sonuc.gruplar.yeni}`,
);
