# Gerçek site kabul testi

Bu liste otomatik fixture testinden ayrıdır. Siteye giriş yapılmış gerçek
Windows Chrome ve Windows Edge üzerinde ayrı ayrı doldurulur. Mac sonuçları
Windows sonucu olarak yazılmaz. Eklenti sürümü, tarayıcı sürümü, işletim sistemi,
tarih ve test dosyalarının SHA-256 değerleri rapora eklenir.

`npm run test:live-fixtures` gerçek kişi/belge içermeyen PDF, PNG ve TXT üretir.
Çıktı klasörünü test cihazına kopyalayın. Şirket belgesi kullanmayın. Eklentinin
yeşil etkinlik rozeti yoksa önce kurulumu doğrulayın ve test sayfasını yenileyin.
Var olan sohbet taslaklarına dokunmadan boş test sohbetleri açın.

| Senaryo (her tarayıcıda) | ChatGPT | Gemini | Claude |
| --- | --- | --- | --- |
| Dosya seçiciyle PDF | Bekliyor | Bekliyor | Bekliyor |
| Dosya seçiciyle PNG | Bekliyor | Bekliyor | Bekliyor |
| Dosya seçiciyle TXT | Bekliyor | Bekliyor | Bekliyor |
| Masaüstünden PDF sürükle/bırak | Bekliyor | Bekliyor | Bekliyor |
| Masaüstünden PNG sürükle/bırak | Bekliyor | Bekliyor | Bekliyor |
| PNG'yi görüntü olarak kopyala/yapıştır | Bekliyor | Bekliyor | Bekliyor |
| Taramada Vazgeç; ardından tekrar yükle | Bekliyor | Bekliyor | Bekliyor |
| İki ayrı sekmede peş peşe PDF yükle | Bekliyor | Bekliyor | Bekliyor |

Her satır için PASS/FAIL/BLOCKED, geçen süre ve varsa hata kodunu yazın.

Başarı koşulları:

- Maskeleme sormadan çalışır. Özgün dosya sohbete eklenmez.
- Tek bir `_redakte` kopyası eklenir; sitenin yükleme göstergesi biter.
- Guard bekleme durumunu gösterir; sonunda kapanır. Sürükleme perdesi kalmaz.
- TXT önizlemesinde e-posta/telefon yerine yer tutucular vardır. PDF/PNG'de
  `ayse.yilmaz@example.com` ve `+90 532 111 22 33` okunmaz; `PUBLIC SAMPLE DOCUMENT`
  okunur. Tamamen boş/siyah çıktı PASS değildir.
- İptal edilen dosya sonradan eklenmez; yeni yükleme çalışır.
- Çoklu sekmede her çıktı yalnız kendi sekmesine ve bir kez eklenir.
- Tanılama raporunda doğru sonuç/aşama vardır; dosya adı ve ham içerik yoktur.

Dosya çipinin görünmesi tek başına maskelemenin kanıtı değildir. Site önizlemesini
inceleyin; mümkünse teslim edilen maskeli çıktıyı indirin. Sohbete modelden yorum
isteyen mesaj göndermek zorunlu değildir ve model cevabı bağımsız OCR kanıtı
yerine geçmez. Görseli panoya alırken dosya yolunu değil görüntü piksellerini
kopyaladığınızdan emin olun.

## Otomatik sızıntı testi neyi kapsar?

`npm test` bağımsız OCR denetleyicisinin özgün dosyayı okuyabildiğini, sızıntılı
ve boş çıktıyı reddettiğini sınar. `npm run test:e2e` paketlenmiş Guard'ın gerçek
motorundan çıkan PDF/PNG'yi yeniden render/OCR ile kontrol eder; PDF metin,
ek açıklama ve metadata katmanlarında da sentetik değer arar. OCR yerel dil
paketleriyle çalışır; belgeleri buluta göndermez. `--quick` yalnız TXT çalıştırır,
OCR kabul testi değildir. Bu örnekler bütün belge düzenleri veya tüm PII türleri
için sızıntısızlık garantisi sağlamaz.

## 2026-09-05 canlı deneme durumu

Mac Chrome'da üç gerçek site açıldı. ChatGPT dosya seçici girişiminden sonra ek
görünmedi ve Guard etkinlik işareti alınamadı. Gemini'de etkinlik işareti vardı,
ancak otomasyon dosya seçiciyi yakalayamadan zaman aşımına uğradı. Claude yeni
sohbet ekranında mevcut bir kullanıcı taslağı içerdiğinden değiştirilmedi.
Tarayıcı etkileşimi kullanıcı tarafından değiştirildiği için devam edilmedi.
Bu bulgular ürünün maskelemesinin PASS/FAIL kararı değildir: canlı kabul BLOCKED,
Windows canlı kabul henüz çalıştırılmadı. Yukarıdaki satırlar tamamlanmış sayılmaz.
