import mongoose from "mongoose";

export const monitorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    group: { type: mongoose.Schema.Types.ObjectId, ref: "Group" },
    order: { type: Number, default: 0 },
    url: { type: String, required: true },
    method: { type: String, enum: ["GET", "HEAD", "POST"], default: "GET" },
    headers: [{ _id: false, key: String, value: String }],
    body: { type: String, default: "" },
    cert: { subject: String, issuer: String, issued: Date, expires: Date },
    // --- Faz 2a: panel kuralları alanları (uptime SQLite ithalatı + kontrolcü) ---
    interval: { type: Number, default: 900, min: 30 }, // saniye; monitör başına ölçüm aralığı
    keyword: { type: String, default: "" }, // ilk 300 KB içinde aranır; boş = içerik kontrolü yok
    expectedStatus: { type: Number, default: null }, // boş → 200–399 başarılı; dolu → YALNIZ o kod
    enabled: { type: Boolean, default: true }, // kapalı monitör ölçülmez
    notes: { type: String, default: "" },
    status: { type: String, enum: ["up", "down", "pending"], default: "pending" },
    consecutiveFailures: { type: Number, default: 0 }, // ≥3 → down ilanı (3 onay döngüsü)
    lastCheckedAt: Date,
  },
  { timestamps: true },
);

export const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// TTL 90 gün — panel kuralı (Faz 1'deki 30 gün yerine). Mevcut 30g indeksini
// değiştirmek için açılışta Check.syncIndexes() çağrılır (server.js).
export const CHECK_TTL_DAYS = 90;

export const checkSchema = new mongoose.Schema({
  monitor: { type: mongoose.Schema.Types.ObjectId, ref: "Monitor", required: true },
  at: { type: Date, required: true, expires: `${CHECK_TTL_DAYS}d` },
  ms: Number,
  status: Number,
  ok: Boolean,
  confirmed: { type: Boolean, default: true }, // onaysız başarısızlık = false (3 onay döngüsü)
  error: String,
  ip: String,
  phases: { redirect: Number, dns: Number, tcp: Number, tls: Number, server: Number },
});
checkSchema.index({ monitor: 1, at: -1 });

// SSL uyarı günlük-tekrar kilidi: anahtar = "<monitorId>:<YYYY-MM-DD>"
// (panel ssl_uyari durum dosyasının Mongo karşılığı).
const sslAlertSchema = new mongoose.Schema({ key: { type: String, unique: true }, at: Date });

// --- Faz A: host kaynak raporları ------------------------------------------------
// host-agent.py POST /api/internal/host-report üzerinden yazar (lib/hostReport.js).
// Bir host adına TEK belge (unique indeks + upsert) → koleksiyon her zaman "son rapor"u
// tutar; `at` TTL 30 gün → rapor göndermeyi bırakan host kendiliğinden düşer.
// GİZLİLİK: belge yalnız ölçüm sayıları + adları taşır — token, URL, IP, kullanıcı
// adı ASLA yazılmaz (uç doğrulaması Bearer MOON_SERVICE_TOKEN başlığıyla yapılır).
export const HOST_TTL_DAYS = 30;

const hostServiceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    status: { type: String, enum: ["up", "down"], required: true },
    ms: { type: Number, min: 0 },
    code: { type: Number, min: 0 },
    detail: { type: String, maxlength: 300 },
  },
  { _id: false },
);

const hostReportSchema = new mongoose.Schema({
  at: { type: Date, required: true, expires: `${HOST_TTL_DAYS}d` },
  host: {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    cpuPct: { type: Number, min: 0, max: 100 },
    memPct: { type: Number, min: 0, max: 100 },
    memMB: { type: Number, min: 0 },
    diskPct: { type: Number, min: 0, max: 100 },
    diskGB: { type: Number, min: 0 },
    uptimeH: { type: Number, min: 0 },
    load: [{ type: Number, min: 0 }], // [1dk, 5dk, 15dk]
  },
  services: [hostServiceSchema],
});
hostReportSchema.index({ "host.name": 1 }, { unique: true }); // host başına tek belge

// koleksiyon adları: users/sessions/gates/sslAlerts/hostReports (kod dili temizliği, 18.11)
export const Monitor = mongoose.model("Monitor", monitorSchema);
export const Check = mongoose.model("Check", checkSchema);
export const Group = mongoose.model("Group", groupSchema);
export const SslAlert = mongoose.model("SslAlert", sslAlertSchema, "sslAlerts");
export const HostReport = mongoose.model("HostReport", hostReportSchema, "hostReports");
