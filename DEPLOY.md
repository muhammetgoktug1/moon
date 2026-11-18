# moon fork — deployment notes (sanitized)

Bu fork'un amacı: uptime izlememizi Moon tabanına taşımak. Faz 1 = auth + deploy +
veri ithali. Upstream'e PR/issue AÇILMAZ; tüm değişiklikler bu fork'ta kalır.

> **Makineye özel bilgiler (alan adları, portlar, dosya yolları, sertifikalar)
> bilinçli olarak BU DOSYADA YOK** — repo herkese açık. Gerçek dağıtım notları
> repo dışındaki özel işlem dizinindeki `DEPLOY-ozel.md`'dedir (Faz A, 18.11).

## Kod dili (18.11 temizliği)

Kullanıcı kuralı: **kod tanımlayıcıları İNGİLİZCE — Türkçe yalnız UI metni.**
Bu fork'un kendi eklerinde tanımlayıcılar, rota/endpoint adları, env adları ve
Mongo koleksiyon adları İngilizcedir; panelde GÖRÜNEN metinler ve WhatsApp
mesajları TÜRKÇE kalır. Upstream koduna dokunulmaz.

- **Rotalar:** `/login`, `/setup`; API `/api/login`, `/api/setup`, `/api/logout`,
  `/api/external/summary`, `/api/internal/host-report`. Eski Türkçe yollar
  (`/giris`, `/kurulum`, `/api/giris`, `/api/kurulum`, `/api/cikis`,
  `/api/disis/ozet`) **307 (geçici)** ile yenilere yönlenir — yer imleri
  çalışmaya devam eder; bilinçli olarak 301 (kalıcı) KULLANILMAZ.
- **Env adları:** `MOON_CHECKER`, `MOON_INSECURE_TLS`, `MOON_SERVICE_TOKEN`,
  `MOON_DNS_OVERRIDES`, `MOON_STATIC_IP`, `MOON_CANARY_URLS`,
  `MOON_RETRY_DELAY_MS`, `MOON_NOTIFY_CONF`. Eski adlardan biri env'de
  bulunursa açılışta İngilizce uyarı basılır (`lib/config.js warnLegacyEnv`).
- **Koleksiyonlar:** `users`, `sessions`, `gates`, `sslAlerts`, `hostReports`
  (eskiden Türkçe adlı koleksiyonlardı — `renameCollection` + alan `$rename`
  ile göçürüldü; oturum token'ları TAŞINDI, kullanıcı yeniden login olmak
  zorunda kalmadı).
- **Çerez:** `moon_session` (eskiden `moon_oturum`). Eski ad hâlâ OKUNUR ve
  geçerli eski çerez yeni adla tazelenir — oturum düşmez.

## Bu fork'ta upstream'te olmayanlar

- **Auth (e-posta + parola).** İlk-açılış kurulumu (`/setup`): kullanıcı tablosu
  boşken açıktır, ilk hesap yönetici olur ve kayıt kapanır (yarışa dayanıklı kilit).
  Parola tarayıcıda SHA-256 özetine çevrilir (`src/utils/sha256.js`, saf JS — http
  üzerinde `crypto.subtle` yok), sunucuda bcrypt ile saklanır. Oturum: 30 günlük
  kayar çerez (`moon_session`, HttpOnly, SameSite=Lax; https'ten gelinirse Secure).
  Girişte e-posta+IP hız sınırı (15 dk'da 10), yazma uçlarında Origin kontrolü.
- **Panel ve API oturum arkasında; `/status` herkese açık.** Herkese açık veriden
  URL/origin, hata metni, IP ve faz süreleri çıkarılmıştır (URL sızması yok).
  socket.io: anonim istemci yalnız `status` event'ini kullanabilir; `list`,
  `hosts`, `history` ve tüm yazma event'leri yetki ister.
- **Kontrolcü varsayılan DURUR.** Dakikalik kontrol turu `MOON_CHECKER=1`
  verilmedikçe başlamaz (çift kontrolcülük olmasın — ölçümü mevcut uptime
  uygulamamız yapıyor). Env değişikliği recreate ister; restart yetmez.
- **`MOON_INSECURE_TLS=1`** → kontrolcü izlenen sitelerde self-signed/iç CA
  sertifikalarını da kabul eder (`tls internal` arkasındaki kendi
  servislerimizi izlemek için). Varsayılan 0.
- **Faz 2a — panel checker kuralları (lib/checker.js):** monitör başına
  `interval` (tur 60 sn), 20 sn zaman aşımı + istek başına 3 deneme (3 sn
  aralık), DOWN için 3 onay döngüsü (`consecutiveFailures ≥ 3`, onaysız check
  `confirmed:false` yazılır), down monitör 60 sn'de bir denenir, ≤8 paralel
  ölçüm, tur başında kanarya (iki genel DNS; ikisi de düşükse tur iptal + log),
  UA `HermesPanel-Uptime/1.0`, IPv4-öncelikli çözümleme (+ `MOON_DNS_OVERRIDES`/
  `MOON_STATIC_IP` alan sabitleme), başarı 200–399 YA DA monitörün
  `expectedStatus`'u, `keyword` ilk 300 KB'da, GET/HEAD/POST + başlık/gövde,
  dns/tcp/tls/server faz kırılımı + cevaplayan IP, SSL bitiş ≤14 gün → günde
  bir uyarı olayı, check TTL 90 gün (Mongo TTL indeksi; açılışta
  `Check.syncIndexes()` 30g→90g göçünü yapar).
- **Bildirim (lib/notify.js):** gruplu WhatsApp köprüsü. Conf biçimi
  `uptime-notify.conf.json` ile aynı: `{whatsapp:{apiUrl,apiKey,session,chatId}}`;
  dosya `MOON_NOTIFY_CONF` (varsayılan `/data/bildirim.conf.json`) — repo dışı
  conf dosyası compose override'la bind-mount edilir. Aynı grupta 5 dk
  penceresine düşen olaylar TEK mesaj; grupsuz olaylar ve SSL uyarıları
  bekletmeden gider. Mesaj metinleri panel `olay_metinleri` ile aynı (TÜRKÇE).
- **`/api/external/summary`** (GET, `Authorization: Bearer <MOON_SERVICE_TOKEN>`):
  total/up/down/stale + monitör özeti (name+group+status+lastCheck; URL YOK) +
  Faz A `hosts` (en küçük host özeti; rapor yoksa `null`).
  Token env'de yoksa uç 404 döner; yanlış token 401.
- **Faz A — host kaynak izleme (18.11):**
  - Koleksiyon `hostReports`: host başına tek belge (unique indeks + upsert),
    `at` TTL 30 gün; belge yalnız ölçüm sayıları + adları taşır — token, URL,
    IP asla yazılmaz ("tokenless").
  - `POST /api/internal/host-report` (aynı bearer token; gövde:
    `{host:{name,cpuPct,memPct,memMB,diskPct,diskGB,uptimeH,load:[1,5,15]},
    services:[{name,status,ms,code,detail}]}`). Eksik/hatalı alan → 400,
    token'sız → 401, token env yoksa uç → 404. Aynı hosta <30 sn arayla gelen
    rapor sessizce atlanır (200 + `stored:false`; 429 yok, eski rapor korunur).
    Tam sözleşme şeması `lib/hostReport.js` başlığında.
  - Panelde oturumlu "Hosts" bölümü (CPU/RAM/disk yüzde barlar + yük + uptime +
    servis noktaları; bayat rapor >10 dk amber; rapor yoksa bölüm gizli — boş
    durum render YOK). `/status` herkese açık sayfasında host bölümü YOK
    (`lib/statusPage.js` + `lib/statusPage.test.js` bu garantisini sınar).
  - `scripts/host-agent.py`: genel amaçlı ajan (yalnız stdlib; macOS `top`/
    `vm_stat`/`df`/`uptime`, Linux `/proc`). Konfigürasyon env'den:
    `MOON_REPORT_URL`, `MOON_SERVICE_TOKEN`, `HOST_AGENT_CONFIG` (JSON: host
    adı + os + servisler; makineye özel dosya repo DIŞINDA). Bayraklar:
    `--dry-run`, `--once`.
  - Bozma testleri: `python3 scripts/bozma-host.py` (5 bozma: token denetimi,
    alan doğrulama, 30 sn kuralı, /status sızıntısı, boş durum gizliliği).
- **Gizlilik taraması:** `python3 scripts/privacy-scan.py [base]` — diff'in
  eklenen satırlarında alan adı/IP/port/ev dizini izi arar (izin listesi:
  example.com ailesi, localhost, RFC 5737 test ağları, bilinen varsayılan
  portlar). Ek desenler `PRIVACY_EXTRA_PATTERNS` env'iyle verilir — gerçek
  adlar repoda bulunmadığı için betik kendisi de temiz kalır.

## Dağıtım

- Moon'un kendi compose'u: app + MongoDB pinned `mongo:8`.
- Makineye özel bağlantı noktaları ve bind-mount'lar git dışı compose override
  dosyasındadır; env dosyası repo dışındaki özel dizinde durur (dizin 700,
  dosya 600) ve repoya yalnız gitignore'lı `.env` sembolik bağlantısıyla
  takılır. Compose `${VAR:-…}` referansları bu dosyadan okur.
- Ters vekil (ters proxy) `tls internal` arkasında çalışır; `X-Forwarded-Proto`
  https ise çerez Secure alınır. http de açıktır (`crypto.subtle` gerekmediği
  için giriş http üzerinde de çalışır).

## Veri ithali (uptime SQLite → MongoDB)

```sh
# daima YEDEN KOPYA üzerinde çalış; canlı uptime DB'sine bağlanma
node scripts/migrate-sqlite-mongo.mjs /path/to/source.db "$MOON_TEST_MONGO"
```

- İdempotent: aynı kaynakla ikinci koşu 0 yeni kayıt ekler (monitör URL'e,
  check `(monitor, at)` ikilisine göre eşleşir).
- `--wipe` Moon koleksiyonlarını temizleyip yeniden yazar; `--days N` pencereyi
  değiştirir (varsayılan 30).
- **Faz 2a ikinci geçiş** (aynı komut, güncellenmiş eşleme): `keyword`,
  `beklenen_kod`, `enabled`, `notes`, `consecutive_failures`, `interval` ve
  monitör durumu URL eşleşmesiyle GÜNCELLENİR (yeni check eklenmez; kapalı
  monitörler `enabled:false` olarak ithal edilir). Kaynak daima yedek kopya,
  salt okunur açılır; kaynak SQLite kolon adları ESKİ UYGULAMANIN şemasıdır
  (grup, basliklar…), değiştirilmez.

## Koleksiyon göçü (18.11; tamamlandı)

Türkçe koleksiyon adları İngilizceye `db.runCommand({renameCollection})` + alan
adları `$rename` ile göçürüldü; eski alan adlı indeksler yeniden kuruldu.
Öncesinde `db-backup.py --sistem moon --simdi` yedeği alındı; sayılar birebir
doğrulandı (monitör/check/oturum).

## Testler

```sh
npm test        # node --env-file-if-exists=.env --test lib/ → stats + auth + routes +
                # external + checker + notify + migrate + hostReport + hosts + statusPage
```

- Mongo isteyen testler `MOON_TEST_MONGO` env'iyle gösterilen örneğe bağlanır
  (yoksa Mongo'nun standart portu denenir); her dosya KENDİ test veritabanını
  kurar-siler. `.env` gitignore'lıdır; dosya yoksa da koşar.
- `lib/routes.test.js`: eski rotalar 307, yeni rotalar handle; 301 olmaz
  (bozma), yeni rota bozulursa kırmızı.
- Bozma: `python3 scripts/bozma-host.py` — her bozmada testler KIRMIZI çıkmalı;
  betik dosyaları geri yükler ve son koşuda yeşili doğrular.
- Canlı auth akışı (307/401/429, kurulum yarışı, /status URL sızması) dağıtım
  sonrası elle doğrulanır (kanıt raporda).
