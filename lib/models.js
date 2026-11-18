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
    beklenenKod: { type: Number, default: null }, // boş → 200–399 başarılı; dolu → YALNIZ o kod
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
export const CHECK_TTL_GUN = 90;

export const checkSchema = new mongoose.Schema({
  monitor: { type: mongoose.Schema.Types.ObjectId, ref: "Monitor", required: true },
  at: { type: Date, required: true, expires: `${CHECK_TTL_GUN}d` },
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
const sslUyariSchema = new mongoose.Schema({ anahtar: { type: String, unique: true }, at: Date });

export const Monitor = mongoose.model("Monitor", monitorSchema);
export const Check = mongoose.model("Check", checkSchema);
export const Group = mongoose.model("Group", groupSchema);
export const SslUyari = mongoose.model("MoonSslUyari", sslUyariSchema);
