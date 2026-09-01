# Redakt Guard

Redakt Guard; ChatGPT, Claude, Gemini ve Microsoft Copilot'a yüklenen belgeleri
sayfaya ulaşmadan yakalayan, cihaz üzerinde tarayıp otomatik maskeleyen kurumsal
Chrome/Edge eklentisidir. Özgün belge tarayıcıdan dışarı çıkmaz ve kullanıcıya
maskesiz gönderim seçeneği verilmez.

Bu depo yalnız Guard eklentisini, Guard'ın kullandığı belge maskeleme çekirdeğini,
yerel model/OCR varlıklarını ve Guard regresyon testlerini içerir. Redakt sunucusu
ve masaüstü arayüzü bu deponun kapsamında değildir.

## Kurulum ve derleme

```bash
npm install
npm test
npm run build
```

Üretilen `dist-guard/` klasörünü Chrome/Edge uzantılar sayfasında geliştirici
moduyla **Paketlenmemiş öğe yükle** seçeneğinden yükleyin.

Ayrıntılı mimari, güvenlik sınırları ve kurumsal dağıtım notları için
[Guard dokümantasyonuna](guard/README.md) bakın.

## Lisans

Bu yazılım tescillidir ve yalnız şirket içi/lisanslı kullanım içindir. Ayrıntılar
[LICENSE](LICENSE) dosyasındadır.
