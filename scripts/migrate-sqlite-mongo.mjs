#!/usr/bin/env node
// Göç: uptime SQLite KOPI veritabanı → Moon MongoDB.
//
//   node scripts/migrate-sqlite-mongo.mjs <kaynak.db> <mongoUri> [--wipe] [--days 30]
//
// --wipe : Moon'un monitors/checks/groups koleksiyonlarını yazmadan önce temizler.
// İdempotent: aynı kaynakla ikinci koşu 0 yeni kayıt ekler.
// Canlı uptime DB'sine ASLA bağlanmayın — daima kopya üzerinde çalışın.

import process from "node:process";
import { readSource, writeToTarget } from "../lib/migrate.js";

const args = process.argv.slice(2);
const wipe = args.includes("--wipe");
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--days");

if (files.length < 2) {
  console.error("Usage: node scripts/migrate-sqlite-mongo.mjs <source.db> <mongoUri> [--wipe] [--days 30]");
  process.exit(2);
}

const [source, uri] = files;

console.log(`source: ${source} (window: ${days} days)`);
const data = readSource(source, days);
console.log(`read: ${data.monitors.length} monitors, ${data.checks.length} checks, skipped: ${data.skipped.length}`);
for (const s of data.skipped) console.warn(`  SKIPPED: ${s.name} — ${s.reason} (${s.url})`);

const result = await writeToTarget(uri, data, { wipe });
console.log(JSON.stringify(result, null, 2));
console.log(
  `done: monitors +${result.monitors.new}/${result.monitors.total} (updated: ${result.monitors.updated ?? 0}), checks +${result.checks.new}/${result.checks.total}, groups +${result.groups.new}`,
);
