import assert from "node:assert/strict";
import test from "node:test";

import { createCanvas } from "@napi-rs/canvas";
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from "pdf-lib";
import { createReplacementMap } from "../src/pii.js";
import {
  pageAnnotations,
  pdfRedactionProgress,
  redactPdf,
  renderPdfPage,
  scanPdf,
} from "../src/pdf.js";

test("PDF çizimi print amacıyla başlatılır", async () => {
  let parameters = null;
  const task = { promise: Promise.resolve("tamam"), cancel() {} };
  const page = {
    render(value) {
      parameters = value;
      return task;
    },
  };

  assert.equal(await renderPdfPage(page, { viewport: "örnek", intent: "display" }), "tamam");
  assert.equal(parameters.intent, "print", "çağıran render amacını gevşetebiliyor");
  assert.equal(parameters.viewport, "örnek");
  assert.equal(typeof task.onContinue, "function", "print render event loop'a kontrollü geçiş yapmıyor");
});

test("PDF çizimi iptal sinyalinde gerçek RenderTask'i de durdurur", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  let rejectTask;
  const task = {
    promise: new Promise((resolve, reject) => { rejectTask = reject; }),
    cancel() {
      cancelled += 1;
      const error = new Error("pdf.js iptali");
      error.name = "RenderingCancelledException";
      rejectTask(error);
    },
  };
  const pending = renderPdfPage({ render: () => task }, {}, { signal: controller.signal });

  controller.abort(new DOMException("Kullanıcı iptal etti.", "AbortError"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
});

test("PDF çizimi sayfa zaman aşımında fail-closed davranır", async () => {
  let cancelled = 0;
  let rejectTask;
  const task = {
    promise: new Promise((resolve, reject) => { rejectTask = reject; }),
    cancel() {
      cancelled += 1;
      rejectTask(new Error("pdf.js iptali"));
    },
  };

  await assert.rejects(
    renderPdfPage({ render: () => task }, {}, { timeoutMs: 10 }),
    (error) => error.name === "TimeoutError" && /gönderim güvenlik için durduruldu/u.test(error.message)
  );
  assert.equal(cancelled, 1);
});

test("PDF ek açıklaması okunamazsa boş listeyle devam edilmez", async () => {
  let receivedIntent = null;
  const cause = new Error("bozuk annotation sözlüğü");
  const page = {
    async getAnnotations({ intent }) {
      receivedIntent = intent;
      throw cause;
    },
  };

  await assert.rejects(
    pageAnnotations(page, "any"),
    (error) => error.name === "PdfAnnotationError" && error.cause === cause && /gönderim durduruldu/u.test(error.message)
  );
  assert.equal(receivedIntent, "any");
});

test("tek sayfalık PDF yalnız çıktı üretildikten sonra yüzde 100 olur", () => {
  const render = pdfRedactionProgress(1, 1, "render");
  const embedded = pdfRedactionProgress(1, 1, "embedded");
  const save = pdfRedactionProgress(1, 1, "save");
  const complete = pdfRedactionProgress(1, 1, "complete");

  assert.deepEqual([render.current, render.total], [0, 5]);
  assert.deepEqual([embedded.current, embedded.total], [4, 5]);
  assert.deepEqual([save.current, save.total], [4, 5]);
  assert.deepEqual([complete.current, complete.total], [5, 5]);
  assert.equal(render.pageNumber, 1);
  assert.equal(render.pageTotal, 1);
});

test("gerçek pdf.js RenderTask güvenli çıktı yolunda tamamlanır", async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  const page = source.addPage([320, 220]);
  page.drawText("Iletisim: ahmet@example.com", { x: 20, y: 170, size: 14, font });
  const bytes = new Uint8Array(await source.save());
  const scanned = await scanPdf(bytes, "ornek.pdf");
  const selected = scanned.findings.filter((finding) => finding.category === "email");
  assert.equal(selected.length, 1, "fixture e-postası bulunamadı");
  const replacements = createReplacementMap(selected, selected.map((finding) => finding.id));
  const progress = [];

  const output = await redactPdf(scanned.context, replacements, {
    canvasFactory: (width, height) => createCanvas(width, height),
    onProgress: (entry) => progress.push(entry),
    renderTimeoutMs: 5_000,
  });

  const parsed = await PDFDocument.load(output);
  assert.equal(parsed.getPageCount(), 1);
  assert.equal(progress.at(0).step, "render");
  assert.equal(progress.at(0).current, 0);
  assert.equal(progress.at(-1).step, "complete");
  assert.equal(progress.at(-1).current, progress.at(-1).total);
});

// Annotation listesi amaca göre filtrelenir. Print açık + NoView alan ekranda
// görünmez ama print render'da çizilir; tarama "any" üst kümesini okumazsa
// maskelenmiş kopyaya görünmez bir kaçak olarak girebilir.
async function pdfWithPrintOnlyAnnotation(hiddenText) {
  const document = await PDFDocument.create();
  const page = document.addPage([320, 220]);
  page.drawText("Sayfa metni burada durur", { x: 20, y: 180, size: 12 });
  const context = document.context;
  const annotation = (rect, flags, text) => {
    const dictionary = context.obj({});
    dictionary.set(PDFName.of("Type"), PDFName.of("Annot"));
    dictionary.set(PDFName.of("Subtype"), PDFName.of("FreeText"));
    dictionary.set(PDFName.of("Rect"), context.obj(rect));
    dictionary.set(PDFName.of("F"), PDFNumber.of(flags));
    dictionary.set(PDFName.of("Contents"), PDFString.of(text));
    dictionary.set(PDFName.of("DA"), PDFString.of("/Helv 10 Tf 0 g"));
    return context.register(dictionary);
  };
  const annotations = PDFArray.withContext(context);
  annotations.push(annotation([20, 120, 300, 150], 4, "Olağan alan: Mehmet Demir"));
  annotations.push(annotation([20, 60, 300, 100], 4 + 32, hiddenText));
  page.node.set(PDFName.of("Annots"), annotations);
  return new Uint8Array(await document.save());
}

test("ekranda görünmeyip basılan PDF alanı tarama üst kümesine girer", async () => {
  const hidden = "Sadece baskida: Ahmet Yilmaz 12345678901";
  const { context } = await scanPdf(await pdfWithPrintOnlyAnnotation(hidden), "bayrak.pdf");
  const formTexts = context.units
    .filter((unit) => unit.location?.kind === "pdf-form")
    .map((unit) => unit.text);

  assert.ok(formTexts.some((text) => text.includes("Mehmet Demir")));
  assert.ok(formTexts.some((text) => text.includes(hidden)), "Print + NoView alanı taranmıyor");
  assert.ok(context.texts.some((text) => text.includes("12345678901")));
});
