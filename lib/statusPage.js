import { Monitor, Check, Group } from "./models.js";
import { toWire } from "./checker.js";
import { INTERVAL_MS } from "./stats.js";

// Herkese açık /status sayfasının verisi (server.js'den Faz A ile taşındı —
// lib/statusPage.test.js "hosts sızması yok" garantisini burada sınar).
//
// GİZLİLİK: URL/origin, hata metni, IP ve faz süreleri panele özeldir — buraya
// yalnız ad + günlük özet + son durum (at/ms/status/ok) çıkar; URL hiçbir şekilde
// sızmaz. Faz A host kaynak raporları (hostReports) da BURAYA ÇIKMAZ: kaynak
// verisi yalnız oturumlu panelde (socket "hosts") ve token'lı uçlardadır.

const DAY_MS = 86_400_000;
const STATUS_DAYS = 30; // checks expire after 30 days
const ORDER = { order: 1, createdAt: 1 };
let statusCache;

async function groupList() {
  const groups = await Group.find().sort(ORDER).lean();
  return groups.map((g) => ({ id: String(g._id), name: g.name }));
}

/** Test için: önbelleği boşaltır (veri değişikliğinden sonra yeniden okumayı zorlar). */
export function resetStatusCache() {
  statusCache = undefined;
}

export async function statusData() {
  if (statusCache && Date.now() - statusCache.at < INTERVAL_MS) return statusCache.data;
  const since = new Date().setUTCHours(0, 0, 0, 0) - (STATUS_DAYS - 1) * DAY_MS;
  const [groups, monitors, days] = await Promise.all([
    groupList(),
    Monitor.find().sort(ORDER).lean(),
    Check.aggregate([
      { $match: { at: { $gte: new Date(since) } } },
      {
        $group: {
          // UTC midnight in ms; $dateTrunc would need MongoDB 5
          _id: { monitor: "$monitor", day: { $subtract: [{ $toLong: "$at" }, { $mod: [{ $toLong: "$at" }, DAY_MS] }] } },
          count: { $sum: 1 },
          ok: { $sum: { $cond: ["$ok", 1, 0] } },
        },
      },
    ]),
  ]);
  const byKey = new Map(days.map((d) => [`${d._id.monitor}:${d._id.day}`, d]));
  const services = await Promise.all(
    monitors.map(async (m) => {
      const last = await Check.findOne({ monitor: m._id }).sort({ at: -1 }).lean();
      const wire = last && toWire(last);
      return {
        id: String(m._id),
        name: m.name,
        group: m.group ? String(m.group) : "",
        last: wire ? { at: wire.at, ms: wire.ms, status: wire.status, ok: wire.ok } : null,
        days: Array.from({ length: STATUS_DAYS }, (_, i) => {
          const day = since + i * DAY_MS;
          const d = byKey.get(`${m._id}:${day}`);
          return { day, count: d?.count || 0, ok: d?.ok || 0 };
        }),
      };
    }),
  );
  const data = { groups, services };
  statusCache = { at: Date.now(), data };
  return data;
}
