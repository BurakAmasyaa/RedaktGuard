# Redakt Guard

Redakt Guard; ChatGPT, Claude, Gemini ve Microsoft Copilot'a yüklenen belgeleri
sayfaya ulaşmadan yakalayan, cihaz üzerinde tarayıp otomatik maskeleyen kurumsal
Chrome/Edge eklentisidir. Özgün belge tarayıcıdan dışarı çıkmaz ve kullanıcıya
maskesiz gönderim seçeneği verilmez.

Bu depo yalnız Guard eklentisini, Guard'ın kullandığı belge maskeleme çekirdeğini,
yerel model/OCR varlıklarını ve Guard regresyon testlerini içerir. Redakt sunucusu
ve masaüstü arayüzü bu deponun kapsamında değildir.

## Kurulum — 3 dakika, derleme yok

`dist-guard/` depoda hazır durur; klonlayıp doğrudan yüklersiniz.

```bash
git clone https://github.com/BurakAmasyaa/RedaktGuard.git
```

### Google Chrome

1. Adres çubuğuna `chrome://extensions` yazın.
2. Sağ üstten **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle** → `RedaktGuard/dist-guard` klasörünü seçin.
4. Açık ChatGPT / Claude / Gemini sekmelerini **yenileyin** (koruma sayfa açılışında yüklenir).

### Microsoft Edge

1. Adres çubuğuna `edge://extensions` yazın.
2. Sol alttan **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle** → `RedaktGuard/dist-guard` klasörünü seçin.
4. Redakt Guard kartında **Ayrıntılar** → **Site erişimi** → **Tüm sitelerde**'yi seçin.
   Bu adım atlanırsa Edge korumayı yalnız simgeye tıkladığınız sekmede çalıştırır:
   ChatGPT çalışır görünür, `claude.ai`'de dosya maskelenmeden gider.
5. Açık ChatGPT / Claude / Gemini sekmelerini **yenileyin**.

### Çalıştığını doğrulayın

1. ChatGPT'yi açın, 2-3 saniye bekleyin (motor arka planda ısınır).
2. Redakt Guard simgesine tıklayın → ayarlar sayfası açılır.
3. Korunan sekmede simgenin üstünde **yeşil nokta** görünmeli (maskeleme yapıldıkça sayıya döner).
4. **Tarama** bölümünde yeşil "**WebGPU üzerinde çalışıyor**" satırını görmelisiniz.
   Sarı "**wasm**" yazıyorsa da çalışır, yalnız daha yavaştır (aşağıya bakın).
5. Sohbete içinde T.C. kimlik numarası geçen bir belge sürükleyin: panel açılmalı,
   bulgular listelenmeli ve sohbete `_redakte` ekli maskeli kopya iliştirilmeli.

### Sık karşılaşılan durumlar

| Belirti | Sebep | Çözüm |
|---|---|---|
| Panel hiç açılmıyor, dosya maskelenmeden gidiyor | Sekme uzantıdan önce açılmış ya da Edge'de site erişimi "tıklandığında" | Simgeye bakın: **yeşil nokta yoksa Guard o sekmede yüklü değil** → sekmeyi yenileyin; Edge'de Site erişimi → Tüm sitelerde |
| Panel "Tarama motoru hazırlanıyor"da uzun bekliyor | 147 MB model ilk kullanımda hazırlanıyor | Bir kerelik; sonraki taramalar saniyeler sürer |
| Ayarlarda "Model wasm üzerinde çalışıyor" | Tarayıcı WebGPU vermemiş (`chrome://gpu` / `edge://gpu`) | Çalışır, 12 kat yavaş. GPU sürücüsü güncelse WebGPU kendiliğinden devreye girer |
| "Motor yanıt vermedi; yeniden kuruldu" | Motor kilitlendi, kendini toparladı | Dosyayı tekrar bırakın |
| Panel "Motor sırada" diyor | Model hâlâ ısınıyor (ilk 5-10 sn) ya da önceki tarama bitmedi | Bekleyin; kendiliğinden devam eder |
| Kurumsal kurallar "0 kural" | Redakt On-Premise adresi girilmemiş | Ayarlar → Kurumsal kural sunucusu (isteğe bağlı; yerel katmanlar adres olmadan da çalışır) |

Takılırsanız: ayarlar → **Sorun giderme** → **Motoru sına**. İz, akışın hangi adımda
durduğunu gösterir; yalnız adım adları tutulur, belge içeriği asla yazılmaz.

### Kurumsal dağıtım

Intune / GPO ile Chrome ve Edge aynı politika adlarını kullanır:
`ExtensionInstallForcelist` zorunlu kurar, `ExtensionSettings` kaldırmayı engeller
ve `runtime_allowed_hosts` ile site erişimini sabitler — Edge'deki 4. adım
kullanıcıya kalmaz.

Guard'ın çalışması gereken host'lar (izin listesine bunlar girer; alt alan adları dahil):

```
https://chatgpt.com/*      https://*.chatgpt.com/*      https://chat.openai.com/*
https://claude.ai/*        https://*.claude.ai/*        https://claude.com/*        https://*.claude.com/*
https://gemini.google.com/*
https://copilot.microsoft.com/*   https://*.copilot.microsoft.com/*
https://m365.cloud.microsoft/*    https://copilot.cloud.microsoft/*
```

Sitelerin kendi içerik kaynakları (`*.claudeusercontent.com`, `*.oaiusercontent.com` gibi)
izin listesinde bulunabilir; Guard orada çalışmaz ve çalışması gerekmez.

## Geliştiriciler için

Kodu değiştirdiyseniz paketi tazeleyin ve testleri koşturun:

```bash
npm install
npm test
npm run build
```

Derleme yalnız kodu yeniler; `dist-guard/models` ve `dist-guard/ocr` yerinde kalır.

Kurumsal pilot tanılaması, Chrome/Edge E2E komutları, mimari, güvenlik sınırları,
hız ölçümleri ve kapsam dışı durumlar için [Guard belgelerine](guard/README.md) bakın.

## Lisans

Bu yazılım tescillidir ve yalnız şirket içi/lisanslı kullanım içindir. Ayrıntılar
[LICENSE](LICENSE) dosyasındadır.
