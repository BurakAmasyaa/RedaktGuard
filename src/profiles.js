// Seviyeler yalnız hızı değil, taramanın neyi görebildiğini de değiştirir.
// İki gerçek kaldıraç var: parça bindirmesi (overlap) ve OCR çözünürlüğü.
//
// Bindirme, parça sınırına denk gelen adın kaybını önler. "Hızlı"nın eski
// 24 karakterlik bindirmesi bir ad öbeğini bile taşıyamıyordu; sınıra denk
// gelen her isim yalnız bu yüzden düşüyor, aynı belge Hızlı ile taranınca
// Dengeli'ye göre gözle görülür biçimde az bulgu çıkıyordu. Bindirme, en uzun
// makul ad öbeğini (unvan + ad + soyad) taşıyacak düzeye çekildi; hız
// kaldıracı parça uzunluğunda bırakıldı.
export const processingProfiles = Object.freeze({
  fast: Object.freeze({
    id: "fast",
    label: "Hızlı",
    summary: "Uzun parçalar, düşük OCR çözünürlüğü (150 DPI). Temiz ve dijital belgeler için.",
    ner: Object.freeze({ maxChunkLength: 900, overlap: 96 }),
    ocr: Object.freeze({ dpi: 150, retryLowConfidence: false }),
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "Dengeli",
    summary: "Orta parça ve bindirme, 200 DPI OCR. Önerilen ayar.",
    ner: Object.freeze({ maxChunkLength: 800, overlap: 80 }),
    ocr: Object.freeze({ dpi: 200, retryLowConfidence: false }),
  }),
  thorough: Object.freeze({
    id: "thorough",
    label: "Kapsamlı",
    summary: "Kısa parça, geniş bindirme, 300 DPI OCR. Taranmış ve yoğun belgeler için.",
    ner: Object.freeze({ maxChunkLength: 700, overlap: 180 }),
    ocr: Object.freeze({ dpi: 300, retryLowConfidence: false }),
  }),
});

export function processingConfig(profile = "balanced") {
  return processingProfiles[profile] || processingProfiles.balanced;
}

export function recommendedProfile(device = globalThis.navigator || {}) {
  const cores = Number(device.hardwareConcurrency) || null;
  const memory = Number(device.deviceMemory) || null;
  if ((cores && cores <= 2) || (memory && memory <= 2)) return "fast";
  if ((cores && cores >= 8) && (memory && memory >= 8)) return "thorough";
  return "balanced";
}
