import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Kimlik doğrulama — uptime projesinin deseni:
//   e-posta + parola, ilk-açılış kurulumu, bcrypt + SHA-256 ön özeti,
//   yarışa dayanıklı kayıt kilidi, kayar 30 gün çerezli oturum,
//   hız sınırı ve yazma uçlarında Origin kontrolü.
// Parola tarayıcıda SHA-256 özetine çevrilir; sunucuya asla düz metin gitmez,
// bcrypt bu 64 karakterlik özet üzerine çalışır (bcrypt 72 bayt sınırı da aşılmış olur).

export const COOKIE_ADI = "moon_oturum";
export const OTURUM_GUN = 30;
const OTURUM_MS = OTURUM_GUN * 86_400_000;
const DOKUNMA_MS = 6 * 3_600_000; // oturum kaydı en çok 6 saatte bir tazelenir
const HIZ_LIMITI = 10;             // 15 dakikada deneme sayısı
const HIZ_PENCERE_MS = 15 * 60_000;
const PAROLA_MIN = 8;

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passHash: { type: String, required: true },
    role: { type: String, enum: ["yonetici", "izleyici"], default: "yonetici" },
    sonGiris: Date,
  },
  { timestamps: true },
);

const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "MoonUser", required: true },
  sonKullanma: { type: Date, required: true },
  yontem: String,
});

// Kurulum kilidi: "ilk hesap yönetici olur, kayıt kapanır" kuralını atomik çözer.
// Aynı belge üzerindeki findOneAndUpdate tek kazanan bırakır (yarış kilidi).
const gateSchema = new mongoose.Schema({ _id: String, kapali: Boolean, at: Date });

export const User = mongoose.model("MoonUser", userSchema);
export const Session = mongoose.model("MoonSession", sessionSchema);
export const Gate = mongoose.model("MoonGate", gateSchema);

export const sha256hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

const EPOSTA = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OZET = /^[0-9a-f]{64}$/;

// --- hız sınırı (bellek içi; tek örnek dağıtım için yeterli) ---
const denemeler = new Map();

export function hizSiniri(anahtar, limit = HIZ_LIMITI, pencere = HIZ_PENCERE_MS) {
  const simdi = Date.now();
  const liste = (denemeler.get(anahtar) || []).filter((t) => simdi - t < pencere);
  if (liste.length >= limit) {
    denemeler.set(anahtar, liste);
    return true; // sınır aşıldı
  }
  liste.push(simdi);
  denemeler.set(anahtar, liste);
  if (denemeler.size > 5000) denemeler.clear(); // taşma koruması
  return false;
}

// --- Origin kontrolü: tarayıcıdan gelen yazma isteklerinde Origin başlığı
//     varsa Host ile aynı olmalı; yoksa (sunucu taraflı istemci) geçer ---
export function kokenKabul(headers = {}) {
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
export function cerezDegeri(cookieBasligi, ad = COOKIE_ADI) {
  if (!cookieBasligi) return undefined;
  for (const parca of cookieBasligi.split(";")) {
    const [k, ...v] = parca.trim().split("=");
    if (k === ad) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function cerezBasligi(token, { guvenli = false, gun = OTURUM_GUN, sil = false } = {}) {
  const attr = [
    `${COOKIE_ADI}=${sil ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    guvenli ? "Secure" : "",
    `Max-Age=${sil ? 0 : gun * 86_400}`,
  ];
  return attr.filter(Boolean).join("; ");
}

// --- kurulum / kayıt ---
export async function authBootstrap() {
  await User.init();
  await Session.init();
  await Gate.updateOne({ _id: "kayit" }, { $setOnInsert: { kapali: false, at: new Date() } }, { upsert: true });
}

export async function setupAcikMi() {
  const gate = await Gate.findById("kayit").lean();
  return !gate?.kapali;
}

// İlk hesabı açar. Eşzamanlı çağrılarda (yarış) yalnızca biri kazanır.
export async function ilkHesabiAc(email, ozet) {
  if (!EPOSTA.test(String(email || ""))) return { hata: "Geçerli bir e-posta girin." };
  if (!OZET.test(String(ozet || ""))) return { hata: "Parola özeti geçersiz." };
  // kilit belgesi yoksa (ör. elle sıfırlama sonrası) atomik oluştur; kapalıysa dokunma
  await Gate.updateOne({ _id: "kayit" }, { $setOnInsert: { kapali: false, at: new Date() } }, { upsert: true });
  const gate = await Gate.findOneAndUpdate({ _id: "kayit", kapali: false }, { $set: { kapali: true, at: new Date() } });
  if (!gate) return { hata: "Kayıt kapalı.", kod: 403 };
  try {
    const user = await User.create({ email: String(email).toLowerCase(), passHash: await bcrypt.hash(ozet, 10), role: "yonetici" });
    return { user };
  } catch (err) {
    if (err.code === 11000) return { hata: "Bu e-posta zaten kayıtlı.", kod: 409 };
    // hesap açılamadıysa kilidi geri aç
    await Gate.updateOne({ _id: "kayit" }, { $set: { kapali: false } });
    return { hata: "Hesap açılamadı.", kod: 500 };
  }
}

// --- giriş ---
export async function girisYap(email, ozet, ip = "", yontem = "parola") {
  if (hizSiniri(`giris:${String(email).toLowerCase()}|${ip}`)) return { hata: "Çok fazla deneme. 15 dakika sonra tekrar deneyin.", kod: 429 };
  if (!EPOSTA.test(String(email || "")) || !OZET.test(String(ozet || ""))) return { hata: "E-posta veya parola hatalı.", kod: 401 };
  const user = await User.findOne({ email: String(email).toLowerCase() }).lean();
  if (!user || !(await bcrypt.compare(ozet, user.passHash))) return { hata: "E-posta veya parola hatalı.", kod: 401 };
  const token = crypto.randomBytes(32).toString("base64url");
  await Session.create({ tokenHash: sha256hex(token), user: user._id, sonKullanma: new Date(), yontem });
  await User.updateOne({ _id: user._id }, { $set: { sonGiris: new Date() } });
  return { token, user: { email: user.email, role: user.role } };
}

// --- oturum denetimi (kayar pencere) ---
export async function oturumDenetle(token) {
  if (!token) return null;
  const oturum = await Session.findOne({ tokenHash: sha256hex(token) }).lean();
  if (!oturum) return null;
  const simdi = Date.now();
  if (simdi - new Date(oturum.sonKullanma).getTime() > OTURUM_MS) {
    await Session.deleteOne({ _id: oturum._id });
    return null;
  }
  if (simdi - new Date(oturum.sonKullanma).getTime() > DOKUNMA_MS) {
    await Session.updateOne({ _id: oturum._id }, { $set: { sonKullanma: new Date() } });
  }
  const user = await User.findById(oturum.user).lean();
  if (!user) {
    await Session.deleteMany({ user: oturum.user });
    return null;
  }
  return { email: user.email, role: user.role, userId: String(user._id) };
}

export async function cikisYap(token) {
  if (!token) return;
  await Session.deleteOne({ tokenHash: sha256hex(token) });
}

export { PAROLA_MIN };
