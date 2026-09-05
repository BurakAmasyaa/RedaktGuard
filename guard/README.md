# Redakt Guard

Çalışanın ChatGPT, Claude, Gemini veya Copilot arayüzüne yüklediği belgeyi
**uygulamanın JavaScript'ine ulaşmadan önce** yakalar, cihaz üzerinde tarar,
maskeler ve yalnızca maskelenmiş kopyayı yükletir.

Redakt Desktop'ın maskeleme hattının aynısını kullanır: aynı bulgular, aynı
yer tutucular, aynı çıktı. Fark, tetikleyicinin dosya seçme ekranı değil,
tarayıcıdaki yükleme hareketi olması.

```
Çalışan musteri.docx dosyasını ChatGPT'ye sürükler
        ↓
drop olayı yakalama fazında durdurulur          (sayfa dosyayı hiç görmez)
        ↓
Baytlar offscreen belgeye aktarılır             (cihazdan çıkmaz)
        ↓
Regex + doğrulama · yerel NER · kurumsal kurallar
        ↓
Bütün bulgular otomatik seçilir                 (kullanıcı kararı yok)
        ↓
musteri_redakte.docx üretilir
        ↓
Güvenli drop/input olayı sitenin MAIN dünyasında üretilir
        ↓
Ek önizlemesi doğrulanır                        (yalnızca maskeli dosya yüklenir)
```

Prompt metninde bütün yerel katmanlar kurum politikasıyla zorunlu çalışır:

```
Çalışan müşteri listesini prompt kutusuna yapıştırır (veya Enter'a basar)
        ↓
Metin yerel motorda taranır                     (desen + kişi/kurum/konum modeli)
        ↓
Bulgu yoksa metin değiştirilmeden devam eder
        ↓
Bulgu varsa tamamı otomatik maskelenir
        ↓
Maskelenmiş metin kutuya yazılır ve gönderilir
```

Tarama eksik kalırsa, motor hata verirse, yapılandırılmış kurumsal kural sunucusu
ulaşılamaz/bayat durumdaysa veya dosya türü açılamıyorsa akış **fail-closed**
kapanır: özgün içerik sayfaya verilmez. Kural sunucusu hiç yapılandırılmamışsa
yerel desen, doğrulama, alan etiketi, NER ve OCR katmanları normal çalışır.

---

## Neden bu yapı

MV3'ün üç kısıtı mimariyi belirledi.

| Kısıt | Sonuç |
|---|---|
| Service worker 30 sn boşta ölür, içinde Worker açamaz | Motor **offscreen belgede** çalışır; 147 MB'lık model bellekte kalır |
| İçerik betiği modül olamaz, tek dosya olmalı | İçerik betiği motoru **içeri almaz**, porta devreder ([tests/guard.test.js](../tests/guard.test.js) korur) |
| `chrome.runtime` mesajları yalnız JSON taşır | Baytlar 512 KB'lık **base64 parçalar** hâlinde akar |
| Farklı sekmeler aynı ağır motoru paylaşır | Office/PDF/OCR/model işleri **tek güvenli kuyrukta** yürür; bekleyen sekmeye heartbeat ilerlemesi gider |

İki ayrı içerik betiği vardır ve ikisi de `document_start`'ta yüklenir:

- **`content/interceptor.js` (ISOLATED)** — asıl araya girme. `drop`, `change`,
  `input` ve `paste` olaylarını `window` üzerinde **yakalama fazında** dinler.
  Sayfanın kendi betikleri henüz çalışmadığı için dinleyici sırada birincidir;
  `stopImmediatePropagation()` çağrıldığında dosya uygulamaya hiç ulaşmaz.
  Aynı betik prompt metnini de kapsar: `paste` (metin dalı), `keydown` (Enter) ve
  gönder düğmesine `click`. Prompt modeli zorunlu çalışır; bulgu yoksa metin
  değiştirilmez, bulgu varsa kullanıcıya seçim sunmadan maskelenir.
- **`content/page-guard.js` (MAIN)** — son emniyet. `fetch` ve
  `XMLHttpRequest.prototype.send` yamalanır. Araya girme başarısız olursa
  (arayüz değişti, bilmediğimiz bir yükleme yolu var) taranabilir bir dosya
  yine de ağa çıkamaz.

İki dünya arasındaki kalıcı kanal, `<html>` üzerindeki politika
(`data-redakt-guard`) ve onaylanmış dosya anahtarlarından
(`data-redakt-guard-approved`, `ad|boyut` biçiminde) ibarettir. Teslim sırasında
yalnız rastgele, kısa ömürlü röle jetonları eklenir. Bulgular, değerler ve
maskeleme eşlemesi DOM'a hiç geçmez — bu sınır testle korunur.

Kanalın `postMessage` değil de öznitelik olmasının sebebi bir yarıştır: sayfa
`drop` olayını eşzamanlı işleyip yüklemeyi hemen başlatabilir, kuyruğa alınmış
bir mesaj o ana yetişmez ve **kendi maskelediğimiz dosya** engellenirdi.
Öznitelik okuması eşzamanlıdır.

Kanal gizli değildir; sayfa okuyabilir. Bu bir zafiyet değil: sayfa özgün dosyayı
hiçbir zaman eline geçirmediği için onay taklit etmek ona bir şey kazandırmaz.

### İçerik betiğinin motorla tek bağı

İçerik betiği belge hattını, modeli ve OCR'ı **içeri almaz** — onlar offscreen
belgede kalır. Tek istisna prompt'un hızlı katmanıdır: [src/pii.js](../src/pii.js)
ve [src/custom-rules.js](../src/custom-rules.js). İkisi de hiçbir şeye bağımlı
değil (toplam ~25 KB) ve gönderim tuşunda eşzamanlı karar için gerekli. Bu
istisna testle sınırlanır: izinli liste dışına çıkan bir import ve bu iki
modülün bağımsızlığını bozan bir değişiklik testi düşürür.

## Çekirdekle parite

Guard, Desktop'ın hattını yeniden kullanır ama kendi akış kodu vardır
([src/engine.js](src/engine.js), `src/main.js`'in handleFile akışını taklit
eder). Bu yüzden çekirdeğe `main.js` üzerinden eklenen bir katman Guard'a
kendiliğinden gelmez. Bir denetimle üç kayma bulundu ve kapatıldı:

- **Alan etiketi katmanı** ([src/field-labels.js](../src/field-labels.js)) her
  iki yolda da çalışıyor. Modelden bağımsız ve deterministik: resmî evrakta
  ("Adı : SAMET", "Adres : ...", "Adres no : ...") model yanılsa ya da hiç
  çalışmasa bile bu alanlar bulunur. Ölçülmüştü: bir ikametgâh belgesinde
  çekirdek 8 bulgu çıkarırken Guard 3 çıkarıyor, ad ve adres çıktıda kalıyordu.
- **Bulgu birleştirme** artık `mergeFindings` ile güven sırasına göre yapılıyor:
  kurumsal kural, doğrulanabilir desen, dosya adı, alan etiketi, model. Düz dizi
  birleştirmesi her katmanı 1'den saydırdığı için iki farklı kişi aynı
  `[KISI_1]` etiketini alabiliyordu.
- **Dosya adı** ayrı bir yoldan değil, belgeyle aynı katmanlardan geçiyor —
  modele de veriliyor. Çıktı adını `applyDocumentChanges` aynı haritayla yazar,
  Guard'ın ayrı dosya adı makinesi kaldırıldı.

Prompt yolunun hızlı katmanı da alan etiketini içerir; ölçülen maliyet
37 KB metinde ~7 ms, eşzamanlı sınırın (50 KB) altında sorun çıkarmıyor.

---

## Hız

Bütün süre kişi/kurum modelinde geçiyor; desen ve kural katmanları zaten
milisaniyeler mertebesinde (37 KB metinde 2,6 ms). Aynı cihazda ölçüldü
(8 paragraf, 2.416 karakter):

| yol | verim | 20 sayfalık belge |
|---|---|---|
| WASM, tek iş parçacığı (eski varsayılan) | 242 karakter/sn | ~3,3 dakika |
| WASM, 8 iş parçacığı, batch 8 | 1.208 karakter/sn | ~40 saniye |
| **WebGPU** | **7.400 karakter/sn** | **6,8 saniye** |

Üç şey bu farkı üretiyor:

- **WebGPU önce denenir**, yoksa WASM'e düşülür ([src/ner.js](../src/ner.js)).
  Vendor'daki ort ikilisi zaten JSEP yapısı olduğu için ek varlık gerekmedi.
- **Worker taramalar arasında ayakta kalır.** Eskiden her çağrı kendi worker'ını
  kurup bitince sonlandırıyordu; ONNX oturumu her belgede yeniden kuruluyordu
  (WebGPU'da 833 ms, WASM'de 1.705 ms). Artık bu bedel oturumda bir kez ödenir.
- **Offscreen belge açılır açılmaz ısınır.** İçerik betiği korunan bir sayfa
  yüklendiğinde motoru kurdurur; kullanıcı ilk dosyayı bıraktığında model
  hazırdır. Ölçüm: ısıtma 342 ms, ardından ilk tarama 338 ms — yani sonrakilerle
  aynı (326, 325 ms).

Tablolarda kazanç ayrı bir yerden gelir: aynı değer onlarca hücrede geçtiği
için çıkarıma yalnız **benzersiz** metin girer, bulgular sonra o metnin geçtiği
bütün birimlere yayılır. 2.000 hücrelik ve 21 farklı değer taşıyan bir tabloda:

| | süre |
|---|---|
| ayıklama yok | 47.811 ms |
| ayıklama yalnız grup içinde | 7.518 ms |
| **ayıklama belge genelinde** | **278 ms** |

Ortadaki satır bir tuzağı gösteriyor: metinler worker'da 150'lik gruplara
bölündüğü sürece ayıklama grubun içine hapsoluyor ve aynı hücre her grupta
yeniden taranıyordu. Belgenin tamamı artık tek çağrıda gidiyor.

Aynı değişiklik bir maskeleme hatasını da kapatıyor: boş birimler eskiden
diziden süzülüyor ama bulgular süzülmüş dizinin indeksiyle işaretleniyordu.
Boş bir birimden sonraki her şeyin birim indeksi kayıyor, maskeleme yanlış
birime bakıp adı belgede bırakıyordu. Birim eşlemesi artık açıkça tutuluyor.

WASM yedeği çapraz kaynak yalıtımı ister (COOP + COEP). Uzantıda manifest
anahtarlarıyla, on-prem uygulamada sunucu başlığıyla verilir
([server/src/static.js](../server/src/static.js)). Yalıtım olmadan
`SharedArrayBuffer` kapalı kalır ve model tek çekirdekte koşar.

İş parçacığı yalnız WASM yoluna açılır: WebGPU da aynı JSEP ikilisi üzerinden
koştuğu için, GPU kullanılacakken iş parçacığı istemek oturumu askıda bırakıyor.

---

## Kurulum

Derleme gerekmez: `dist-guard/` depoda hazır durur.

```bash
git clone https://github.com/BurakAmasyaa/RedaktGuard.git
```

Chrome/Edge → Uzantılar → Geliştirici modu → **Paketlenmemiş öğe yükle** → `RedaktGuard/dist-guard`.

Paket ~206 MB'tır; 180 MB'ı model ve OCR varlıkları. Model ve OCR yalnız
`dist-guard/` altında durur; derleme onları yerinde bırakır.

Kodu değiştirdiysen paketi tazele:

```bash
npm install && npm run build
```

Derleme yalnız kodu yeniler; `dist-guard/models` ve `dist-guard/ocr` yerinde kalır.

Varlıkları hiç kopyalamadan yalnız kodu derlemek için `node guard/build.mjs --no-assets`;
varlıklar `dist-guard` içinde zaten varsa paket yine tam çalışır.

Kurumsal dağıtımda uzantı, Intune/GPO ile `ExtensionInstallForcelist` üzerinden
zorunlu kurulur ve `ExtensionSettings` ile kaldırılması engellenir.

## Microsoft Edge

Edge'de aynı paket çalışır; farklar kurulumda ve hızda.

**Kurulum**

1. `edge://extensions` → sol altta **Geliştirici modu** → **Paketlenmemiş öğe yükle** → `dist-guard`.
2. Aynı sayfada Redakt Guard → **Ayrıntılar** → **Site erişimi** → **"Tüm sitelerde"**.
   Edge, paketlenmemiş uzantıya site erişimini "tıklandığında" verebiliyor: o zaman
   içerik betiği yalnız simgeye bastığın sekmede çalışır. Belirti tam olarak şudur —
   ChatGPT'de çalışır, `claude.ai`'de Guard hiç devreye girmez ve dosya maskelenmeden gider.
3. Açık ChatGPT/Claude/Gemini sekmelerini **yenile**; içerik betiği sayfa açılışında yüklenir.
4. Korunan bir sayfa açıp 2-3 saniye bekle, sonra ayarlar → **Tarama** satırına bak.

**Hız**

Ayarlarda "Model **wasm** üzerinde çalışıyor" yazıyorsa Edge WebGPU'yu vermemiş demektir;
`edge://gpu` sayfasındaki **WebGPU** satırı sebebini gösterir. Tarama yine çalışır ama
tek çekirdekte, 12 kat yavaş (20 sayfalık belge ~40 sn). Zorlanan bir şey yok: bu
makinede WebGPU açılırsa Guard onu kendiliğinden kullanır.

**Kurumsal dağıtım**

Edge, Chrome ile aynı politika adlarını kullanır: Intune/GPO ile
`ExtensionInstallForcelist` zorunlu kurar, `ExtensionSettings` kaldırmayı engeller ve
`runtime_allowed_hosts` ile site erişimini sabitler — 2. adım böylece kullanıcıya kalmaz.

Guard'ın çalışması gereken host'lar (izin listesine bunlar girer; alt alan adları dahil):

```
https://chatgpt.com/*      https://*.chatgpt.com/*      https://chat.openai.com/*
https://claude.ai/*        https://*.claude.ai/*        https://claude.com/*        https://*.claude.com/*
https://gemini.google.com/*
https://copilot.microsoft.com/*   https://*.copilot.microsoft.com/*
https://m365.cloud.microsoft/*    https://copilot.cloud.microsoft/*
```

Sitelerin kendi içerik kaynakları (`*.claudeusercontent.com`, `*.oaiusercontent.com` gibi)
kurumsal izin listesinde bulunabilir; Guard orada çalışmaz ve çalışması gerekmez — yükleme
kararı sohbet sayfasında verilir.

**Takılırsa**

Ayarlar → **Sorun giderme** → **Motoru sına**. İz, akışın nerede durduğunu adım adım
söyler; yalnız adım adları tutulur, dosya adı ve içerik asla yazılmaz. `motor:` satırları
hiç yoksa offscreen belge kurulmamıştır; `ready` gelip sonrası yoksa motor yanıt vermiyordur.

Aynı bölümdeki **Tanılama raporunu indir** düğmesi destek ekibine verilebilecek bir
JSON üretir. Raporda Guard/tarayıcı/işletim sistemi sürümü, motor yolu, kural durumu,
son işlemlerin site ve türü, tarama–maskeleme–teslim süreleri, teslim yöntemi, sonuç,
son aşama ve hata kodu bulunur. Dosya adı, sunucu adresi, belge içeriği, prompt,
gerçek bulgu değeri ve serbest biçimli hata metni rapora alınmaz. Olay geçmişi
`storage.session` içinde en fazla 30 kayıt tutulur ve tarayıcı kapanınca silinir.

## Chrome ve Edge otomatik E2E

Bağımlılık veya ayrı test framework'ü gerektirmeyen CDP koşucusu, paketlenmiş
`dist-guard` uzantısını gerçek Chrome/Edge sürecine yükler. ChatGPT, Gemini ve Claude
originlerindeki belge istekleri ağdan önce izole fixture sayfalarıyla karşılanır; gerçek
hesaba bağlanılmaz ve hiçbir mesaj gönderilmez. Böylece uzantının gerçek origin eşleşmesi,
MAIN/ISOLATED içerik betikleri, offscreen motoru ve dosya teslimi birlikte çalışır.

Tam sürüm matrisi her sitede sentetik TXT, PDF, DOCX, XLSX ve PNG dosyalarını; ayrıca
ChatGPT + Gemini eşzamanlı sekme akışını sınar. Özgün e-posta/telefonun metin çıktılarda
kalmadığı, `_redakte` adının geldiği ve siteye yalnız tek kopya teslim edildiği doğrulanır.
PDF/PNG çıktısı bağımsız yerel OCR ile yeniden okunur: hassas alanlar kaybolmalı,
hassas olmayan kontrol metni korunmalıdır. Önce özgün dosyada iki alanın da OCR ile
okunduğu doğrulanır; okunamayan özgün dosya veya boş çıktı başarı sayılmaz.
PDF'in metin, ek açıklama ve metadata katmanları da sızıntı için kontrol edilir.
Bu sentetik örnekler tüm belge düzenleri ve PII türleri için garanti değildir.
Dosyalar diskte Türkçe karakter ve boşluk içeren geçici dizinlere yazılır;
`DOM.setFileInputFiles` ile gerçek tarayıcı dosya girdisinden geçirilir. Windows
dosya seçici penceresini veya canlı sitenin yükleme sunucusunu otomatik test etmez.

```bash
# Edge'i ve uyumlu Chromium/Chrome for Testing kurulumunu otomatik bulur
npm run test:e2e

# Tek tarayıcı veya hızlı TXT kontrolü
npm run test:e2e -- --browser=chrome --quick
npm run test:e2e -- --browser=edge --headed
npm run test:e2e -- --browser=chrome --safe-mode

# Chrome for Testing özel bir konumdaysa
GUARD_E2E_CHROME_BINARY=/tam/yol/chrome npm run test:e2e -- --browser=chrome
```

Google Chrome'un resmi dağıtımı 137 ve sonrasında komut satırından paketlenmemiş
uzantı yüklemeyi kısıtladığı için otomasyon Chrome for Testing/Chromium kullanır.
Windows CI kararlı Chrome for Testing sürümünü Google'ın resmi manifestinden indirir;
Edge işi cihazdaki Edge kurulumunu kullanır. Bu ayrım son kullanıcı desteğini değiştirmez:
üretilen Manifest V3 paketi hem Chrome hem Edge'e normal kurulumla yüklenebilir.
Windows koşucusunda ilk yerel model ısınması daha yavaş olabildiğinden senaryo üst
sınırı 10 dakikadır; her dosya türünün başlangıcı iş günlüğünde ayrı görünür.

`.github/workflows/guard-browser-e2e.yml`, `main` veya `v*` sürüm etiketi pushlandığında
Windows'ta kararlı Chrome, kararlı Edge ve minimum Chrome 125 işlerini ayrı çalıştırır.
Chrome 125 işi motoru güvenli modda yeniden başlatır ve CPU/WASM yolunu doğrular.
Minimum desteklenen sürüm Chrome/Edge 125'tir; PDF.js legacy ana modülü ve worker'ı
birlikte paketlenir ([PDF.js desteği](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported)).
Bu deterministik paket site adaptörünün
ve tarayıcı entegrasyonunun regresyonunu yakalar; canlı sitenin o günkü DOM değişimini
doğrulamak için sürüm kabulünde kısa bir gerçek hesap smoke testi yine yapılmalıdır.

Canlı kabul için `npm run test:live-fixtures` sentetik PDF/PNG/TXT, SHA-256 manifesti
ve [tarayıcı/site kabul listesini](../tests/e2e/LIVE-ACCEPTANCE.md) yeni bir geçici
klasörde üretir. Gerçek site sonuçları otomatik fixture sonuçlarından ayrı tutulur;
yükleme/izin engeli olan satırlar PASS değil BLOCKED olarak kaydedilir.

## Ayarlar

Araç çubuğundaki simge ayarlar sayfasını açar.

| Ayar | Varsayılan | Ne yapar |
|---|---|---|
| Kurumsal koruma | **zorunlu açık** | Guard, ağ emniyeti, prompt taraması ve taranamayan içerik engeli yerel ayarla kapatılamaz |
| Otomatik maskeleme | **zorunlu açık** | Başarılı taramadaki bütün bulgular seçilir; maskesiz gönderme seçeneği yoktur |
| Prompt modeli | **zorunlu açık** | Her yapıştırma/gönderimde kişi, kurum ve konum modeli dahil bütün yerel katmanlar çalışır; kapatma seçeneği yoktur |
| Kural sunucusu | isteğe bağlı | Redakt On-Premise adresi; boşsa yerel katmanlar çalışır, adres verilmişken ulaşılamaz/bayat durumdaysa gönderim durur |
| Tarama profili | Dengeli | Hızlı / Dengeli / Kapsamlı |

Kural sunucusuna erişim izni ayarlar sayfasında, **tek adres için** ve kullanıcı
onayıyla alınır. Uzantı geniş host izni istemez.

## Kullanıcı audit kaydı

Başarılı otomatik maskelemeden sonra Guard, aynı Redakt On-Premise adresindeki
`POST /api/audit/masking` ucuna yalnızca güvenli bir özet yollar. Sunucu kullanıcı
adını istemci gövdesinden kabul etmez; `AUTH_MODE=proxy` ile güvenilen ters
proxy'nin doğruladığı `request.user` kimliğini kullanır. `AUTH_MODE=none` iken
audit ucu `503` döner ve olay uzantının PII içermeyen yerel kuyruğunda bekler.

Kayda giren alanlar: kullanıcı, hedef site, dosya/prompt türü, Guard sürümü,
dosya adedi ve uzantıları, seçilen bulgu ve maskelenen kullanım adetleri,
kategori/kaynak/kapsam sayaçları. **Dosya adı, prompt, gerçek ad, e-posta,
telefon, kural metni, placeholder veya belge içeriği kaydedilmez.** Ağ geçici
olarak kapalıysa en fazla 500 olay, en fazla 30 gün tutulur ve sonra yeniden
denenir. Sunucu kayıtları normal `redakt-YYYY-MM-DD.log` dosyasına yazılır.

## Kapsam dışı — açıkça

Bu sınırlar gizlenmemeli; ilk güvenlik toplantısında sorulacaktır.

- **Masaüstü uygulamaları.** ChatGPT ve Claude'un Mac/Windows uygulamaları
  tarayıcıdan geçmez; uzantı onları görmez.
- **Mobil ve kişisel cihaz.** Aynı sebeple kapsam dışı.
- **Word/Excel içindeki Copilot.** M365 istemcisinden çıkan veri buraya uğramaz.
- **Yeniden adlandırılmış dosya.** `.docx` uzantısı `.zip` yapılırsa motor açamaz
  ve kurumsal politika gönderimi engeller.
- **`Request` gövdesi.** `fetch(new Request(...))` biçimindeki yüklemeler ağ
  katmanında eşzamanlı incelenemez; bu yol DOM katmanındaki araya girmeye kalır.
- **Uzun prompt.** 50.000 karakteri aşan metin, sayfayı dondurmamak için
  offscreen belgeye devredilir ve tarama sırasında panel görünür. Sınır
  ölçülen en kötü duruma göre seçildi: yoğun PII içeren 500 KB'lık metinde
  eşzamanlı tarama 3,8 saniye sürüyor.
- **Promptta kişi adları.** Varsayılan hızlı katman desen, doğrulama ve kurumsal
  kuralları uygular; kişi/kurum adı için yerel model gerekir ve o ayar kapalıdır
  (açıldığında her gönderim saniyeler uzar).
- **Bulanık kural yanlış pozitifi.** Kurumsal kural bulanık eşleştiği için kod
  yapıştırıldığında yanlış yakalayabilir — ölçüldü: `Project Phoenix` kuralı
  `const project = phoenix.init()` ifadesine takılıyor. Zorunlu politikada bu
  eşleşme de otomatik maskelenir; birebir kurallarda SQL'de `TamEslesme = 1`
  kullanılmalıdır.

Yani "maskelenmeden veri çıkmaz" garantisi yalnız uzantı koduyla bütün cihaz için
verilemez. Guard yönetilen tarayıcıdaki desteklenen yolları fail-closed korur;
uzantının devre dışı bırakılması/kaldırılması Intune/GPO ile engellenmeli, masaüstü
ve mobil kanallar için Gateway/Purview/Netskope gibi ayrı zorlama katmanı olmalıdır.

## Kapatılan açık konu — kısmi maskeleme

Kurumsal bir kural, üstünü örttüğü desen bulgusunu iptal edebiliyordu:
[src/pii.js](../src/pii.js) içindeki `replacementsForText` sabit kurallara en
yüksek önceliği veriyordu. Kural metni bir IBAN'ın ortasıyla çakıştığında
panelde "IBAN → `[IBAN_1]`" yazıyor, çıktıda numaranın geri kalanı açık
kalıyordu.

Artık çakışan adaylar arasında **en geniş aralık** kazanır; eşit aralıkta
öncelik karar verir, yani kural deseni birebir karşıladığında kendi karşılığı
yazılmaya devam eder. Aralıklar birbirini tam kapsamıyorsa kazananın aralığı
birleşime genişletilir. Değişmez şudur: seçili hiçbir bulgunun metni çıktıda
kalmaz. Prompt yolu ([src/content/text-engine.js](src/content/text-engine.js))
ile belge yolu ([src/engine.js](src/engine.js)) aynı modülü kullandığı için
düzeltme iki yolda da geçerlidir.

Bedeli: kural, kendisini kapsayan bir desenden dar kaldığında çıktıda kuralın
karşılığı değil desenin yer tutucusu görünür. Değer her durumda tamamen
maskelenir; yalnızca görünen etiket kural satırındaki vaatten farklı olabilir.

Kayda geçsin: bu bölümde daha önce "prompt yolunda maskeleme sonrası değer
denetimi bunu yakalar" yazıyordu — doğru değildi. `residualValues`
([src/content/interceptor.js](src/content/interceptor.js)) değerin **tamamını**
arar; ortasından bölünmüş bir IBAN o aramaya da takılmıyordu. Kısmi sızıntı iki
yolda da yakalanmıyordu; asıl emniyet artık maskeleme kararının kendisinde.

Regresyon testi [tests/output-leak.test.js](../tests/output-leak.test.js): çıktı
paketini açar, seçili her bulgunun değerinin ve o değerin tek tek parçalarının
belgede kalmadığını doğrular.

## Dosyalar

| Yol | İş |
|---|---|
| [manifest.mjs](manifest.mjs) | Manifest üretimi — korunan adresler [src/hosts.js](src/hosts.js)'ten |
| [build.mjs](build.mjs) | Üç derleme: motor bağlamı (ESM), içerik betikleri (IIFE), varlıklar |
| [src/background.js](src/background.js) | Offscreen ömrü, kural tazeleme, rozet |
| [src/audit.js](src/audit.js) | Ham değer taşımayan audit özeti ve kuyruk şeması |
| [src/diagnostics.js](src/diagnostics.js) | PII içermeyen tanılama olayı ve indirilebilir rapor şeması |
| [src/enforcement.js](src/enforcement.js) | Zorunlu otomatik maskeleme/fail-closed karar çekirdeği |
| [src/offscreen.js](src/offscreen.js) | Port sunucusu; tarama ve maskeleme oturumları |
| [src/engine.js](src/engine.js) | `src/pipeline.js` sarmalayıcısı — Desktop ile aynı hat |
| [src/content/interceptor.js](src/content/interceptor.js) | Olay yakalama, dosya ve prompt akışları, sentetik yeniden gönderim |
| [src/content/text-engine.js](src/content/text-engine.js) | Prompt'un eşzamanlı hızlı katmanı |
| [src/content/composer.js](src/content/composer.js) | Prompt kutusunu bulma, okuma, yerine yazma |
| [src/content/panel-styles.js](src/content/panel-styles.js) | Panelin kendi stil sayfası |
| [src/content/page-guard.js](src/content/page-guard.js) | `fetch` / `XHR` emniyeti |
| [src/content/panel.js](src/content/panel.js) | Kapalı shadow root içindeki tarama/ilerleme paneli |
| [src/transfer.js](src/transfer.js) | Base64 parçalama ve birleştirme |
