import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Kimlik doğrulama — uptime projesinin deseni:
//   e-posta + parola, ilk-açılış kurulumu, bcrypt + SHA-256 ön özeti,
//   yarışa dayanıklı kayıt kilidi, kayar 30 gün çerezli oturum,
//   hız sınırı ve yazma uçlarında Origin kontrolü.
// Parola tarayıcıda SHA-256 özetine çevrilir; sunucuya asla düz metin gitmez,
// bcrypt bu 64 karakterlik özet üzerine çalışır (bcrypt 72 bayt sınırı da aşılmış olur).

// Çerez adı 18.11'de moon_oturum → moon_session oldu; eski ad HALA okunur
// (kalıcı oturumlar düşmesin diye) ve geçerli eski çerez yenisiyle tazelenir.
export const COOKIE_NAME = "moon_session";
export const LEGACY_COOKIE_NAME = "moon_oturum";
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;
const TOUCH_MS = 6 * 3_600_000; // oturum kaydı en çok 6 saatte bir tazelenir
const RATE_LIMIT = 10;          // 15 dakikada deneme sayısı
const RATE_WINDOW_MS = 15 * 60_000;
const PASSWORD_MIN = 8;

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passHash: { type: String, required: true },
    role: { type: String, enum: ["admin", "viewer"], default: "admin" },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  lastUsedAt: { type: Date, required: true },
  method: String,
});

// Kurulum kilidi: "ilk hesap yönetici olur, kayıt kapanır" kuralını atomik çözer.
// Aynı belge üzerindeki findOneAndUpdate tek kazanan bırakır (yarış kilidi).
const gateSchema = new mongoose.Schema({ _id: String, closed: Boolean, at: Date });

export const User = mongoose.model("User", userSchema, "users");
export const Session = mongoose.model("Session", sessionSchema, "sessions");
export const Gate = mongoose.model("Gate", gateSchema, "gates");

export const sha256hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGEST = /^[0-9a-f]{64}$/;

// --- hız sınırı (bellek içi; tek örnek dağıtım için yeterli) ---
const attempts = new Map();

export function rateLimit(key, limit = RATE_LIMIT, window = RATE_WINDOW_MS) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < window);
  if (list.length >= limit) {
    attempts.set(key, list);
    return true; // sınır aşıldı
  }
  list.push(now);
  attempts.set(key, list);
  if (attempts.size > 5000) attempts.clear(); // taşma koruması
  return false;
}

// --- Origin kontrolü: tarayıcıdan gelen yazma isteklerinde Origin başlığı
//     varsa Host ile aynı olmalı; yoksa (sunucu taraflı istemci) geçer ---
export function originAllowed(headers = {}) {
  const origin = headers.origin;
  if (!origin) return true;
  const host = headers.host;
  try {
    return !host || new URL(origin).host === host;
  } catch {
    return false;
  }
}

// --- çerez yardımcıları ---
// Yeni ad önce, eski ad (moon_oturum) yedek yolu olarak okunur.
export function cookieValue(cookieHeader, name = COOKIE_NAME) {
  if (!cookieHeader) return undefined;
  const read = (n) => {
    for (const part of cookieHeader.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === n) return decodeURIComponent(v.join("="));
    }
    return undefined;
  };
  return read(name) ?? read(LEGACY_COOKIE_NAME);
}

export function cookieHeader(token, { secure = false, days = SESSION_DAYS, clear = false } = {}) {
  const attr = [
    `${COOKIE_NAME}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${clear ? 0 : days * 86_400}`,
  ];
  return attr.filter(Boolean).join("; ");
}

// --- kurulum / kayıt ---
export async function authBootstrap() {
  await User.init();
  await Session.init();
  await Gate.updateOne({ _id: "kayit" }, { $setOnInsert: { closed: false, at: new Date() } }, { upsert: true });
}

export async function setupOpen() {
  const gate = await Gate.findById("kayit").lean();
  return !gate?.closed;
}

// İlk hesabı açar. Eşzamanlı çağrılarda (yarış) yalnızca biri kazanır.
export async function openFirstAccount(email, digest) {
  if (!EMAIL.test(String(email || ""))) return { error: "Geçerli bir e-posta girin." };
  if (!DIGEST.test(String(digest || ""))) return { error: "Parola özeti geçersiz." };
  // kilit belgesi yoksa (ör. elle sıfırlama sonrası) atomik oluştur; kapalıysa dokunma
  await Gate.updateOne({ _id: "kayit" }, { $setOnInsert: { closed: false, at: new Date() } }, { upsert: true });
  const gate = await Gate.findOneAndUpdate({ _id: "kayit", closed: false }, { $set: { closed: true, at: new Date() } });
  if (!gate) return { error: "Kayıt kapalı.", code: 403 };
  try {
    const user = await User.create({ email: String(email).toLowerCase(), passHash: await bcrypt.hash(digest, 10), role: "admin" });
    return { user };
  } catch (err) {
    if (err.code === 11000) return { error: "Bu e-posta zaten kayıtlı.", code: 409 };
    // hesap açılamadıysa kilidi geri aç
    await Gate.updateOne({ _id: "kayit" }, { $set: { closed: false } });
    return { error: "Hesap açılamadı.", code: 500 };
  }
}

// --- giriş ---
export async function login(email, digest, ip = "", method = "password") {
  if (rateLimit(`login:${String(email).toLowerCase()}|${ip}`)) return { error: "Çok fazla deneme. 15 dakika sonra tekrar deneyin.", code: 429 };
  if (!EMAIL.test(String(email || "")) || !DIGEST.test(String(digest || ""))) return { error: "E-posta veya parola hatalı.", code: 401 };
  const user = await User.findOne({ email: String(email).toLowerCase() }).lean();
  if (!user || !(await bcrypt.compare(digest, user.passHash))) return { error: "E-posta veya parola hatalı.", code: 401 };
  const token = crypto.randomBytes(32).toString("base64url");
  await Session.create({ tokenHash: sha256hex(token), user: user._id, lastUsedAt: new Date(), method });
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return { token, user: { email: user.email, role: user.role } };
}

// --- oturum denetimi (kayar pencere) ---
export async function verifySession(token) {
  if (!token) return null;
  const session = await Session.findOne({ tokenHash: sha256hex(token) }).lean();
  if (!session) return null;
  const now = Date.now();
  if (now - new Date(session.lastUsedAt).getTime() > SESSION_MS) {
    await Session.deleteOne({ _id: session._id });
    return null;
  }
  if (now - new Date(session.lastUsedAt).getTime() > TOUCH_MS) {
    await Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } });
  }
  const user = await User.findById(session.user).lean();
  if (!user) {
    await Session.deleteMany({ user: session.user });
    return null;
  }
  return { email: user.email, role: user.role, userId: String(user._id) };
}

export async function logout(token) {
  if (!token) return;
  await Session.deleteOne({ tokenHash: sha256hex(token) });
}

export { PASSWORD_MIN };
