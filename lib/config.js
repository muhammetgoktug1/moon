function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export const MONGODB_URI = need("MONGODB_URI");
export const PORT = Number(need("PORT"));

// 18.11 kod dili temizliği: eski Türkçe env adları → yenileri. Ayarlarda eski
// ad kalmışsa sessizce yok sayılmasın diye açılışta UYARI basılır.
export const LEGACY_ENV = {
  MOON_KONTROLCU: "MOON_CHECKER",
  MOON_SABIT_ALANLAR: "MOON_DNS_OVERRIDES",
  MOON_GUVENSIZ_TLS: "MOON_INSECURE_TLS",
  MOON_SERVIS_TOKEN: "MOON_SERVICE_TOKEN",
  MOON_SABIT_IP: "MOON_STATIC_IP",
  MOON_KANARYA_URLLER: "MOON_CANARY_URLS",
  MOON_DENEME_ARALIK_MS: "MOON_RETRY_DELAY_MS",
  MOON_BILDIRIM_CONF: "MOON_NOTIFY_CONF",
};

/** Eski env adı tanımlıysa İngilizce uyarı basar; bulunan eski adları döndürür. */
export function warnLegacyEnv(log = console.warn) {
  const found = Object.entries(LEGACY_ENV).filter(([oldName]) => process.env[oldName] !== undefined);
  for (const [oldName, newName] of found) log(`[moon] legacy env "${oldName}" is ignored — rename it to "${newName}"`);
  return found.map(([oldName]) => oldName);
}
