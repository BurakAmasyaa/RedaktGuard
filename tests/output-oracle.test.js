import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { checkVisualText, createOutputOracle } from "./e2e/output-oracle.mjs";
import { controlText, visualFixtures } from "./e2e/visual-fixtures.mjs";

test("sızıntı kontrolü boş OCR'ı, noktalama farkını ve kısmi maskelemeyi başarı saymaz", () => {
  for (const text of ["", `${controlText} ayse yilmaz @ example . com`, `${controlText} 532 111 22 33`]) {
    assert.throws(() => checkVisualText(text));
  }
  assert.throws(() => checkVisualText(controlText, { original: true }));
});

test("gerçek OCR oracle: özgün PDF/PNG okunur; sızıntı ve boş çıktı reddedilir; maskeli çıktı geçer", { timeout: 180_000 }, async () => {
  const oracle = await createOutputOracle();
  try {
    const original = await visualFixtures();
    const masked = await visualFixtures({ masked: true });
    const blank = await visualFixtures({ blank: true });
    for (let i = 0; i < original.length; i += 1) {
      await oracle.verify(original[i], original[i].bytes, { original: true });
      await assert.rejects(oracle.verify(original[i], original[i].bytes), /hassas alan|katmanında sızıntı/u);
      await assert.rejects(oracle.verify(blank[i], blank[i].bytes), /kontrol metni okunamadı/u);
      await oracle.verify(masked[i], masked[i].bytes);
    }
    const hiddenLeak = await PDFDocument.load(masked[0].bytes);
    hiddenLeak.setTitle("ayse.yilmaz@example.com");
    await assert.rejects(oracle.verify(masked[0], await hiddenLeak.save()), /metadata katmanında sızıntı/u);
  } finally { await oracle.close(); }
});
