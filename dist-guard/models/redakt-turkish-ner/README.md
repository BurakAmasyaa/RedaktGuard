# Yerel Türkçe NER modeli

- Kaynak model: `akdeniz27/bert-base-turkish-cased-ner`
- Lisans: MIT (kaynak model kartındaki beyana göre)
- Çalışma zamanı: Transformers.js / ONNX Runtime Web
- Paketlenen sürüm: q4 ONNX
- Görev: `PER`, `ORG` ve `LOC` token classification

Model ve tokenizer dosyaları uygulama ile aynı origin'den yüklenir. Uygulamada
uzak model erişimi kapalıdır. Büyük ONNX ağırlığı GitHub'ın tek dosya sınırının
altında kalması için ONNX external-data biçiminde iki parçaya ayrılmıştır.
