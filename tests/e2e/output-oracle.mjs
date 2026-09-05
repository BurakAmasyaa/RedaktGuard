import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createWorker, OEM } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { controlText, visualSecrets } from "./visual-fixtures.mjs";

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]/gu, "");
const markers = visualSecrets.map(normalize);

// Guard bulgularını/maskelerini kullanmayan bağımsız çıktı kontrolü.
// Noktalama ve boşluk değişiklikleri OCR'ın sızıntıyı gizlemesine yetmez.
export function checkVisualText(text, { original = false, label = "çıktı" } = {}) {
  const normalized = normalize(text);
  assert.ok(normalized.includes(normalize(controlText)), `${label}: kontrol metni okunamadı; boş/bozuk çıktı veya geçersiz OCR ölçümü`);
  for (const marker of markers) {
    assert.equal(normalized.includes(marker), original,
      `${label}: ${original ? "özgün hassas alan OCR ile okunamadı; ölçüm geçersiz" : "hassas alan çıktıdan hâlâ okunabiliyor"}`);
  }
  if (!original) {
    // Ülke kodunun ya da domain'in tek başına silinmesi güvenli sayılmaz.
    for (const fragment of ["ayseyilmaz", "5321112233"]) {
      assert.ok(!normalized.includes(fragment), `${label}: hassas alanın ayırt edici kısmı hâlâ okunabiliyor`);
    }
  }
}

export async function createOutputOracle({ timeoutMs = 90_000 } = {}) {
  let worker;
  let unusable = false;
  const bounded = async (operation) => {
    assert.ok(!unusable, "OCR ölçüm motoru zaman aşımından sonra tekrar kullanılamaz");
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => { timer = setTimeout(() => {
          unusable = true;
          void worker?.terminate();
          reject(new Error("Bağımsız OCR ölçümü zaman aşımına uğradı; test başarısız"));
        }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  // Yerel dil paketleri: test için belge/dil indirmesi veya bulut OCR yok.
  worker = await bounded(async () => {
    const created = await createWorker(["eng", "tur"], OEM.LSTM_ONLY, {
      langPath: fileURLToPath(new URL("../../dist-guard/ocr/lang/", import.meta.url)),
      cacheMethod: "none", gzip: true,
    });
    if (unusable) { await created.terminate(); throw new Error("OCR başlangıç zaman aşımı"); }
    return created;
  });
  const recognize = async (bytes) => (await bounded(() => worker.recognize(bytes))).data.text;

  return {
    async verify(fixture, bytes, { original = false, label = fixture.id } = {}) {
      if (fixture.id === "png") {
        const decoded = await loadImage(bytes);
        assert.equal(decoded.width, 1500, `${label}: görsel genişliği değişti`);
        assert.equal(decoded.height, 400, `${label}: görsel yüksekliği değişti`);
        checkVisualText(await recognize(bytes), { original, label });
        return;
      }
      assert.equal(fixture.id, "pdf");
      const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true, isEvalSupported: false });
      let doc;
      try {
        doc = await task.promise;
        assert.equal(doc.numPages, 1, `${label}: PDF sayfa sayısı değişti`);
        const page = await doc.getPage(1);
        const text = (await page.getTextContent()).items.map((item) => item.str || "").join(" ");
        if (!original) {
          const hidden = normalize(text + JSON.stringify(await page.getAnnotations()) + JSON.stringify(await doc.getMetadata()));
          for (const marker of [...markers, "ayseyilmaz", "5321112233"]) {
            assert.ok(!hidden.includes(marker), `${label}: PDF metin/annotation/metadata katmanında sızıntı`);
          }
        }
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, intent: "print" }).promise;
        checkVisualText(await recognize(canvas.toBuffer("image/png")), { original, label });
      } finally { await task.destroy(); }
    },
    async close() { await worker.terminate(); },
  };
}
