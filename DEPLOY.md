# moon fork — dağıtım notları (sistem.com)

Bu fork'un amacı: uptime izlememizi Moon tabanına taşımak. Faz 1 = auth + deploy +
veri ithali. Upstream'e PR/issue AÇILMAZ; tüm değişiklikler bu fork'ta kalır.

## Bu fork'ta upstream'te olmayanlar

- **Auth (e-posta + parola).** İlk-açılış kurulumu (`/kurulum`): kullanıcı tablosu
  boşken açıktır, ilk hesap yönetici olur ve kayıt kapanır (yarışa dayanıklı kilit).
  Parola tarayıcıda SHA-256 özetine çevrilir (`src/utils/sha256.js`, saf JS — http
  üzerinde `crypto.subtle` yok), sunucuda bcrypt ile saklanır. Oturum: 30 günlük
  kayar çerez (`moon_oturum`, HttpOnly, SameSite=Lax; https'ten gelinirse Secure).
  Girişte e-posta+IP hız sınırı (15 dk'da 10), yazma uçlarında Origin kontrolü.
- **Panel ve API oturum arkasında; `/status` herkese açık.** Herkese açık veriden
  URL/origin, hata metni, IP ve faz süreleri çıkarılmıştır (URL sızması yok).
  socket.io: anonim istemci yalnız `status` event'ini kullanabilir; `list`,
  `history`, tüm yazma event'leri yetki ister.
- **Kontrolcü varsayılan DURUR.** Dakikalık kontrol turu `MOON_KONTROLCU=1`
  verilmedikçe başlamaz (çift kontrolcülük olmasın — ölçümü mevcut uptime
  uygulamamız yapıyor). Açmak: `moon-ozel/moon.env` içinde `MOON_KONTROLCU=1`
  yapıp `docker compose up -d app` (env değişikliği recreate ister; restart yetmez).
- **`MOON_GUVENSIZ_TLS=1`** → kontrolcü izlenen sitelerde self-signed/iç CA
  sertifikalarını da kabul eder (moon.sistem.com gibi `tls internal` arkasındaki
  servisleri izlemek için). Varsayılan 0.
- **Faz 2a — panel checker kuralları (lib/checker.js):** monitör başına
  `interval` (tur 60 sn), 20 sn zaman aşımı + istek başına 3 deneme (3 sn aralık),
  DOWN için 3 onay döngüsü (`consecutiveFailures ≥ 3`, onaysız check
  `confirmed:false` yazılır), down monitör 60 sn'de bir denenir, ≤8 paralel ölçüm,
  tur başında kanarya (1.1.1.1 + 8.8.8.8; ikisi de düşükse tur iptal + log),
  UA `HermesPanel-Uptime/1.0`, IPv4-öncelikli çözümleme (+ `MOON_SABIT_ALANLAR`/
  `MOON_SABIT_IP` alan sabitleme), başarı 200–399 YA DA monitörün `beklenenKod`'u,
  `keyword` ilk 300 KB'da, GET/HEAD/POST + başlık/gövde, dns/tcp/tls/server faz
  kırılımı + cevaplayan IP, SSL bitiş ≤14 gün → günde bir uyarı olayı, check TTL
  90 gün (Mongo TTL indeksi; açılışta `Check.syncIndexes()` 30g→90g göçünü yapar).
- **Bildirim (lib/bildirim.js):** gruplu WhatsApp köprüsü. Conf biçimi
  `uptime-notify.conf.json` ile aynı: `{whatsapp:{apiUrl,apiKey,session,chatId}}`;
  dosya `MOON_BILDIRIM_CONF` (varsayılan `/data/bildirim.conf.json`) — compose
  override'la `moon-ozel/bildirim.conf.json` bind-mount edilir. Aynı grupta
  5 dk penceresine düşen olaylar TEK mesaj; grupsuz olaylar ve SSL uyarıları
  bekletmeden gider. Mesaj biçimleri panel `olay_metinleri` ile aynı.
- **`/api/disis/ozet`** (GET, `Authorization: Bearer $MOON_SERVIS_TOKEN`):
  toplam/up/down/bayat + monitör özeti (ad+grup+durum+son ölçüm; URL YOK).
  Token env'de yoksa uç 404 döner; yanlış token 401.

## Dağıtım (Mac mini)

- Moon'un kendi compose'u: app + MongoDB pinned `mongo:8`.
- Makineye özel bağlantı noktaları `compose.override.yaml`'da (git'te yok):
  app `127.0.0.1:40080`, mongo `127.0.0.1:27018`.
- Env dosyası repo dışında: `~/Desktop/muhammet/moon-ozel/moon.env`
  (dizin 700, dosya 600; repoya `~/Desktop/muhammet/moon/.env` sembolik
  bağlantısı ile takılır — `.env` gitignore'dadır). Compose `${VAR:-0}`
  referansları bu dosyadan okur.
- Caddy: `http://moon.sistem.com` + `https://moon.sistem.com { tls internal }`
  blokları → `host.docker.internal:40080`.
- Sertifika notu: https Caddy iç CA'sıdır; kök sertifika
  `~/Desktop/muhammet/sertifika/sistem-com-kok.crt`. http da açık kalır;
  `crypto.subtle` gerekmediği için giriş http üzerinde de çalışır.

## Veri ithali (uptime SQLite → MongoDB)

```sh
# daima KOPIA üzerinde çalış; canlı uptime DB'sine bağlanma
cp ~/.hermes/cache/scratch/uptime-hedef.db /tmp/kaynak.db
node scripts/goc-sqlite-mongo.mjs /tmp/kaynak.db mongodb://127.0.0.1:27018/moon
```

- İdempotent: aynı kaynakla ikinci koşu 0 yeni kayıt ekler (monitör URL'e,
  check `(monitor, at)` ikilisine göre eşleşir).
- `--kurut` Moon koleksiyonlarını temizleyip yeniden yazar; `--gun N` pencereyi
  değiştirir (varsayılan 30).
- **Faz 2a ikinci geçiş** (aynı komut, güncellenmiş eşleme): `keyword`,
  `beklenen_kod`, `enabled`, `notes`, `consecutive_failures`, `interval` ve
  monitör durumu URL eşleşmesiyle GÜNCELLENİR (yeni check eklenmez; kapalı
  monitörler `enabled:false` olarak ithal edilir). Kaynak daima KOPIA
  (`~/.hermes/cache/scratch/moon-goc/kaynak.db`, salt okunur açılır).

## Testler

```sh
npm test        # node --test lib/ → stats self-check + auth + göç ithalatı
```

- `lib/auth.test.js` ve `lib/goc.test.js` MongoDB ister: `compose.override.yaml`'ın
  eşlediği `127.0.0.1:27018` (test veritabanları kurar-siler). `MOON_TEST_MONGO`
  ile başka URI verilebilir.
- Canlı auth akışı (307/401/429, kurulum yarışı, /status URL sızması) dağıtım
  sonrası elle doğrulanır (kanıt raporda).
