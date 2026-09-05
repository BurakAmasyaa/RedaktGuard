import { PDFDocument } from "pdf-lib";
import { aggregateFindings, redactedOutputFilename, replacementsForText } from "./pii.js";
import { processingConfig } from "./profiles.js";

const PDF_MIME = "application/pdf";
const MIN_TEXT_CHARACTERS = 8;
const MAX_RENDER_EDGE = 2400;
export const PDF_RENDER_TIMEOUT_MS = 2 * 60_000;

// pdf.js, "display" amaçlı çizimde operatör listesini parçalara böler ve her
// parçadan sonrasını window.requestAnimationFrame ile planlar. rAF yalnızca
// GÖRÜNÜR sekmelerde tetiklenir; gizli sekmede duraklatılır ve bir offscreen
// belgede (uzantının maskeleme yaptığı yer) HİÇ tetiklenmez. Sonuç: page.render
// sözü hiç dönmez, maskeleme "Sayfa çiziliyor / %100"de sonsuza dek asılır.
// "print" amacı devamı microtask (Promise.resolve().then) ile planlar; bu her
// görünürlük durumunda çalışır ve düzleştirilmiş çıktı için zaten doğru amaçtır.
// Ölçümle doğrulandı: gizli sekmede display 15 sn+ asılırken print 0.1 sn'de çizdi.
const RENDER_INTENT = "print";
let pdfRuntimePromise = null;

async function loadPdfRuntime() {
  if (pdfRuntimePromise) return pdfRuntimePromise;
  pdfRuntimePromise = (async () => {
    if (typeof window === "undefined") return import("pdfjs-dist/legacy/build/pdf.mjs");
    const [runtime, workerModule] = await Promise.all([
      // Ana modül ve worker aynı legacy sürümden gelmeli: kurumsal tarayıcıda
      // yeni Promise/Map API'lerinin eksikliği PDF açılışını durdurmasın.
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ]);
    runtime.GlobalWorkerOptions.workerSrc = workerModule.default;
    return runtime;
  })();
  return pdfRuntimePromise;
}

function normalizedBytes(arrayBuffer) {
  if (arrayBuffer instanceof Uint8Array) return arrayBuffer.slice();
  return new Uint8Array(arrayBuffer.slice(0));
}

function separatorBetween(previous, current) {
  if (!previous) return "";
  if (previous.hasEOL) return "\n";
  if (/\s$/u.test(previous.str) || /^\s/u.test(current.str)) return "";

  const previousSize = Math.max(Math.abs(previous.transform?.[3] || 0), previous.height || 0, 1);
  const currentSize = Math.max(Math.abs(current.transform?.[3] || 0), current.height || 0, 1);
  const lineSize = Math.max(previousSize, currentSize);
  const verticalGap = Math.abs((previous.transform?.[5] || 0) - (current.transform?.[5] || 0));
  if (verticalGap > lineSize * 0.65) return "\n";

  const previousEnd = (previous.transform?.[4] || 0) + (previous.width || 0);
  const horizontalGap = (current.transform?.[4] || 0) - previousEnd;
  return horizontalGap > lineSize * 0.16 ? " " : "";
}

export function buildPdfPageText(items, styles = {}) {
  let text = "";
  let previous = null;
  const records = [];

  for (const item of items) {
    if (typeof item?.str !== "string" || !item.str) continue;
    text += separatorBetween(previous, item);
    const start = text.length;
    text += item.str;
    records.push({
      start,
      end: text.length,
      str: item.str,
      dir: item.dir || "ltr",
      width: item.width || 0,
      height: item.height || 0,
      fontFamily: styles[item.fontName]?.fontFamily || "sans-serif",
      transform: [...(item.transform || [1, 0, 0, 1, 0, 0])],
    });
    previous = item;
  }
  return { text, records };
}

function pageContainsImage(operatorList, OPS) {
  const imageOperators = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageXObjectRepeat,
  ]);
  return operatorList.fnArray.some((operator) => imageOperators.has(operator));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
}

function renderTimeoutError(timeoutMs) {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const error = new Error(`PDF sayfası ${seconds} saniye içinde çizilemedi; gönderim güvenlik için durduruldu.`);
  error.name = "TimeoutError";
  return error;
}

function continueRenderAfterEventLoop(callback) {
  // Gizli sekmelerde setTimeout yoğun biçimde kısılabilir. MessageChannel bir
  // sonraki task'a geçerek heartbeat/zaman aşımına çalışma fırsatı verir fakat
  // her pdf.js parçasını bir saniyelik gizli-sekme timer'ına dönüştürmez.
  if (typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      callback();
    };
    channel.port2.postMessage(null);
    return;
  }
  setTimeout(callback, 0);
}

// RenderTask elde tutulmadan yalnız `.promise` beklenirse AbortSignal çalışan
// pdf.js işini durduramaz. Gizli offscreen belgede takılan bir sayfa da motoru
// süresiz kilitler. Bu sarmalayıcı hem iptali RenderTask.cancel()'a bağlar hem
// sayfa başına kesin bir üst süre uygular. onContinue'daki kısa event-loop geçişi
// print render'ın yoğun microtask zincirinin timer/heartbeat'i aç bırakmasını
// önler.
export function renderPdfPage(page, parameters, options = {}) {
  const signal = options.signal;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : PDF_RENDER_TIMEOUT_MS;
  throwIfAborted(signal);

  let task;
  try {
    task = page.render({ ...parameters, intent: RENDER_INTENT });
  } catch (error) {
    return Promise.reject(error);
  }

  if (!task?.promise || typeof task.cancel !== "function") {
    return Promise.reject(new Error("PDF çizim görevi başlatılamadı; gönderim güvenlik için durduruldu."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let interruptedBy = null;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      handler(value);
    };
    const cancel = (reason) => {
      if (settled) return;
      interruptedBy = reason;
      try {
        task.cancel();
      } catch {
        // Aşağıdaki açık hata yine çağırana döner; iptal hatası onu gölgelememeli.
      }
      finish(reject, reason);
    };
    const abort = () => cancel(signal.reason || new DOMException("İşlem iptal edildi.", "AbortError"));
    const timer = setTimeout(() => cancel(renderTimeoutError(timeoutMs)), timeoutMs);

    signal?.addEventListener("abort", abort, { once: true });
    task.onContinue = (continueCallback) => {
      continueRenderAfterEventLoop(() => {
        if (!settled) continueCallback();
      });
    };
    Promise.resolve(task.promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, interruptedBy || error)
    );
  });
}

function buildOcrPageText(words, scale) {
  let text = "";
  const records = [];
  for (const word of words) {
    const value = String(word.text || "").trim();
    if (!value) continue;
    if (text) text += " ";
    const start = text.length;
    text += value;
    records.push({
      start,
      end: text.length,
      str: value,
      bbox: { ...word.bbox },
      confidence: Number(word.confidence) || 0,
    });
  }
  return { text, records, ocrScale: scale, source: "ocr" };
}

async function imageForOcr(canvas) {
  if (typeof window !== "undefined") return canvas;
  if (typeof canvas.encode === "function") return canvas.encode("png");
  return canvas;
}

function readablePdfError(error) {
  if (error?.name === "PasswordException") return new Error("Parola korumalı PDF dosyaları desteklenmiyor.");
  if (error?.name === "InvalidPDFException") return new Error("Bu dosya geçerli bir PDF belgesi değil.");
  if (error?.name === "MissingPDFException") return new Error("PDF dosyası okunamadı.");
  return error;
}

async function openPdf(bytes) {
  const runtime = await loadPdfRuntime();
  try {
    const loadingTask = runtime.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    return { runtime, document: await loadingTask.promise, loadingTask };
  } catch (error) {
    throw readablePdfError(error);
  }
}


// PDF form alanları (AcroForm) metin katmanında DEĞİLDİR: getTextContent onları
// hiç görmez. Ama düzleştirilmiş çıktı sayfayı çizerken alanın görünümünü de
// basar — yani değer taranmadan, bulgu listesinde görünmeden, okunur biçimde
// çıktıya gider. Bir başvuru formunda bu, formun tamamının sızması demektir.
function annotationValues(annotation) {
  const values = [];
  for (const candidate of [annotation?.fieldValue, annotation?.buttonValue, annotation?.alternativeText]) {
    if (Array.isArray(candidate)) values.push(...candidate.map(String));
    else if (typeof candidate === "string") values.push(candidate);
  }
  for (const object of [annotation?.contentsObj, annotation?.titleObj]) {
    if (typeof object?.str === "string") values.push(object.str);
  }
  return values.filter((value) => value.trim());
}

// Ek açıklama listesi amaca göre FİLTRELENİR: "display" yalnız görüntülenebilir,
// "print" yalnız basılabilir olanları verir. Bu ikisi aynı küme değildir; bir
// alan "Print açık + NoView" olabilir. Sayfayı print amacıyla çizip ek açıklamayı
// display amacıyla sorsaydık, böyle bir alan çıktıya ÇİZİLİR ama taranmadığı ve
// karartılmadığı için okunur biçimde sızardı. Bu yüzden:
//   - tarama "any" ile yapılır: üst küme, hiçbir bulgu raporun dışında kalmasın;
//   - karartma çizimle AYNI amaçla yapılır: çizilen her şey kapatılsın, çizilmeyen
//     alana boşuna siyah kutu basılmasın.
export async function pageAnnotations(page, intent = RENDER_INTENT) {
  try {
    return await page.getAnnotations({ intent });
  } catch (cause) {
    const error = new Error("PDF form alanları güvenli biçimde okunamadı; gönderim durduruldu.", { cause });
    error.name = "PdfAnnotationError";
    throw error;
  }
}

export async function scanPdf(arrayBuffer, filename, options = {}) {
  const bytes = normalizedBytes(arrayBuffer);
  const { runtime, document: pdfDocument, loadingTask } = await openPdf(bytes);
  const pages = [];
  const unreadablePages = [];
  let totalCharacters = 0;
  let ocrWorker = null;
  let ocrTools = null;
  const profile = processingConfig(options.profile);

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await pdfDocument.getPage(pageNumber);
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent({ disableNormalization: false }),
        page.getOperatorList(),
      ]);
      let pageMap = buildPdfPageText(textContent.items, textContent.styles);
      pageMap.source = "text";
      const characterCount = pageMap.text.replace(/\s/gu, "").length;
      const viewport = page.getViewport({ scale: 1 });
      const needsOcr = characterCount < MIN_TEXT_CHARACTERS && pageContainsImage(operatorList, runtime.OPS);

      if (needsOcr) {
        ocrTools ||= await import("./ocr.js");
        options.onProgress?.({ phase: "ocr", status: "initializing", current: pageNumber - 1, total: pdfDocument.numPages });
        ocrWorker ||= options.ocrFactory
          ? await options.ocrFactory({ signal: options.signal, onProgress: options.onOcrProgress })
          : await ocrTools.createLocalOcrWorker({ signal: options.signal, onProgress: options.onOcrProgress });
        const ocrScale = Math.min(profile.ocr.dpi / 72, MAX_RENDER_EDGE / Math.max(viewport.width, viewport.height));
        const ocrViewport = page.getViewport({ scale: ocrScale });
        const canvas = canvasForPage(Math.ceil(ocrViewport.width), Math.ceil(ocrViewport.height), options.canvasFactory);
        const canvasContext = canvas.getContext("2d", { alpha: false });
        if (!canvasContext) throw new Error("OCR için PDF sayfası çizilemedi.");
        await renderPdfPage(
          page,
          { canvas, canvasContext, viewport: ocrViewport, background: "#FFFFFF" },
          { signal: options.signal, timeoutMs: options.renderTimeoutMs }
        );
        throwIfAborted(options.signal);
        const ocrResult = options.recognizeOcr
          ? await options.recognizeOcr(ocrWorker, await imageForOcr(canvas), { pageNumber, profile: profile.id })
          : await ocrTools.recognizeOcrPage(ocrWorker, await imageForOcr(canvas), { rotateAuto: true });
        pageMap = buildOcrPageText(ocrResult.words || [], ocrScale);
        if (pageMap.text.replace(/\s/gu, "").length < MIN_TEXT_CHARACTERS) unreadablePages.push(pageNumber);
        canvas.width = 1;
        canvas.height = 1;
        options.onProgress?.({ phase: "ocr", status: "complete", current: pageNumber, total: pdfDocument.numPages });
      }

      totalCharacters += pageMap.text.replace(/\s/gu, "").length;
      // Taramada üst küme: görüntülenebilir olmayan ama basılabilir alanlar da
      // bulgulara girsin; hiçbir kişisel veri rapordan kaçmasın.
      const formValues = (await pageAnnotations(page, "any")).flatMap(annotationValues);
      totalCharacters += formValues.join("").replace(/\s/gu, "").length;
      pages.push({ ...pageMap, pageNumber, width: viewport.width, height: viewport.height, formValues });
      page.cleanup();
    }
  } finally {
    if (ocrWorker) {
      if (ocrTools) await ocrTools.terminateOcrWorker(ocrWorker);
      else await ocrWorker.terminate?.();
    }
    await loadingTask.destroy();
  }

  if (totalCharacters < MIN_TEXT_CHARACTERS || unreadablePages.length) {
    const pageDetail = unreadablePages.length ? ` Okunamayan sayfa: ${unreadablePages.join(", ")}.` : "";
    throw new Error(`PDF içeriği yerel OCR ile güvenilir biçimde okunamadı.${pageDetail}`);
  }

  const units = pages
    .filter((page) => page.text.trim())
    // Kayıtların konumu maskeleme kutularını boyamak için zaten tutuluyor;
    // aynı konum, sütun başlıklı tabloda etiketi değerle eşlemeye de yarar.
    .map((page) => ({
      text: page.text,
      location: { kind: "pdf", pageNumber: page.pageNumber },
      layout: page.records,
    }));
  // Form alanı değerleri kendi birimleri olur: bulgu listesinde görünürler,
  // sayıma girerler ve maskeleme sırasında kutuları kapatılır.
  for (const page of pages) {
    for (const value of page.formValues || []) {
      units.push({ text: value, location: { kind: "pdf-form", pageNumber: page.pageNumber } });
    }
  }
  const texts = units.map((unit) => unit.text);
  return {
    context: {
      kind: "pdf",
      filename,
      bytes,
      pages,
      texts,
      units,
      flattenedOutput: true,
      ocrPageCount: pages.filter((page) => page.source === "ocr").length,
    },
    findings: aggregateFindings(units),
  };
}

function canvasForPage(width, height, canvasFactory) {
  if (canvasFactory) return canvasFactory(width, height);
  if (typeof document === "undefined") {
    throw new Error("PDF çıktısı yalnızca tarayıcıda hazırlanabilir.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToJpeg(canvas) {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF sayfası görüntüye dönüştürülemedi.")), "image/jpeg", 0.94);
    });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof canvas.encode === "function") return new Uint8Array(await canvas.encode("jpeg", 94));
  throw new Error("Bu tarayıcı PDF sayfalarını güvenli çıktıya dönüştüremiyor.");
}

function matchSegments(pageMap, matches, viewport, Util, measureContext) {
  const segments = [];
  for (const match of matches) {
    let first = true;
    for (const record of pageMap.records) {
      const overlapStart = Math.max(match.start, record.start);
      const overlapEnd = Math.min(match.end, record.end);
      if (overlapStart >= overlapEnd) continue;

      const length = Math.max(record.str.length, 1);
      const transform = Util.transform(viewport.transform, record.transform);
      const fullWidth = Math.max(record.width * viewport.scale, 2);
      const fontHeight = Math.max(Math.hypot(transform[2], transform[3]), record.height * viewport.scale, 5);
      const startOffset = overlapStart - record.start;
      const endOffset = overlapEnd - record.start;
      measureContext.save();
      measureContext.font = `${fontHeight}px ${record.fontFamily}`;
      const measuredFullWidth = measureContext.measureText(record.str).width;
      const startRatio = measuredFullWidth > 0
        ? measureContext.measureText(record.str.slice(0, startOffset)).width / measuredFullWidth
        : startOffset / length;
      const endRatio = measuredFullWidth > 0
        ? measureContext.measureText(record.str.slice(0, endOffset)).width / measuredFullWidth
        : endOffset / length;
      measureContext.restore();
      const angle = Math.atan2(transform[1], transform[0]);
      const rtl = record.dir === "rtl";
      const start = rtl ? 1 - endRatio : startRatio;
      const end = rtl ? 1 - startRatio : endRatio;
      const startSafety = overlapStart > record.start ? fontHeight * 0.16 : 0;
      const endSafety = overlapEnd < record.end ? fontHeight * 0.16 : 0;
      segments.push({
        x: transform[4] + Math.cos(angle) * (fullWidth * start - startSafety),
        y: transform[5] + Math.sin(angle) * (fullWidth * start - startSafety),
        width: Math.max(fullWidth * (end - start) + startSafety + endSafety, 3),
        height: fontHeight,
        angle,
        placeholder: first ? match.placeholder : "",
      });
      first = false;
    }
  }
  return segments;
}

function matchOcrSegments(pageMap, matches, renderScale) {
  const ratio = renderScale / pageMap.ocrScale;
  const segments = [];
  for (const match of matches) {
    let first = true;
    for (const record of pageMap.records) {
      if (match.start >= record.end || match.end <= record.start) continue;
      segments.push({
        x: record.bbox.x0 * ratio,
        y: record.bbox.y0 * ratio,
        width: Math.max((record.bbox.x1 - record.bbox.x0) * ratio, 3),
        height: Math.max((record.bbox.y1 - record.bbox.y0) * ratio, 5),
        placeholder: first ? match.placeholder : "",
      });
      first = false;
    }
  }
  return segments;
}

function paintRedactions(context, segments, scale) {
  const horizontalPadding = Math.max(2, 1.5 * scale);
  const verticalPadding = Math.max(1.5, 1.1 * scale);

  for (const segment of segments) {
    context.save();
    context.translate(segment.x, segment.y);
    context.rotate(segment.angle);
    const x = -horizontalPadding;
    const y = -segment.height * 0.86 - verticalPadding;
    const width = segment.width + horizontalPadding * 2;
    const height = segment.height * 1.08 + verticalPadding * 2;
    context.fillStyle = "#0A0A0A";
    context.fillRect(x, y, width, height);

    if (segment.placeholder && width >= 38 * scale) {
      const maxSize = Math.max(6 * scale, Math.min(9 * scale, height * 0.54));
      context.font = `600 ${maxSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      context.fillStyle = "#FAFAF7";
      context.textBaseline = "middle";
      let label = segment.placeholder;
      while (label.length > 4 && context.measureText(label).width > width - horizontalPadding * 2) {
        label = `${label.slice(0, -2)}…`;
      }
      context.fillText(label, 0, y + height / 2, width - horizontalPadding * 2);
    }
    context.restore();
  }
}

function paintOcrRedactions(context, segments, scale) {
  const padding = Math.max(2, 1.5 * scale);
  for (const segment of segments) {
    const x = segment.x - padding;
    const y = segment.y - padding;
    const width = segment.width + padding * 2;
    const height = segment.height + padding * 2;
    context.fillStyle = "#0A0A0A";
    context.fillRect(x, y, width, height);
    if (!segment.placeholder || width < 38 * scale) continue;
    const fontSize = Math.max(6 * scale, Math.min(9 * scale, height * 0.5));
    context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    context.fillStyle = "#FAFAF7";
    context.textBaseline = "middle";
    let label = segment.placeholder;
    while (label.length > 4 && context.measureText(label).width > width - padding * 2) {
      label = `${label.slice(0, -2)}…`;
    }
    context.fillText(label, x + padding, y + height / 2, width - padding * 2);
  }
}

const REDACTION_STEPS_PER_PAGE = 4;
const REDACTION_STEP_OFFSET = Object.freeze({
  render: 0,
  text: 1,
  annotations: 2,
  jpeg: 3,
  embedded: REDACTION_STEPS_PER_PAGE,
});

// `current/total` sayfa sayısı değil tamamlanan iş birimidir. Böylece tek
// sayfalık bir belge render başlamadan %100 görünmez; %100 yalnız PDF baytları
// gerçekten üretildikten sonra yayınlanır. pageNumber/pageTotal ise panel ve
// tanılama izi için gerçek sayfa bilgisini korur.
export function pdfRedactionProgress(pageNumber, pageTotal, step) {
  const pages = Math.max(1, Number(pageTotal) || 1);
  const page = Math.min(pages, Math.max(1, Number(pageNumber) || 1));
  const total = pages * REDACTION_STEPS_PER_PAGE + 1;

  if (step === "complete") return { current: total, total, step, pageNumber: page, pageTotal: pages };
  if (step === "save") return { current: total - 1, total, step, pageNumber: page, pageTotal: pages };
  if (!(step in REDACTION_STEP_OFFSET)) throw new RangeError(`Bilinmeyen PDF maskeleme adımı: ${step}`);

  return {
    current: (page - 1) * REDACTION_STEPS_PER_PAGE + REDACTION_STEP_OFFSET[step],
    total,
    step,
    pageNumber: page,
    pageTotal: pages,
  };
}

export async function redactPdf(context, replacementMap, options = {}) {
  const { runtime, document: pdfDocument, loadingTask } = await openPdf(context.bytes);
  const output = await PDFDocument.create();
  output.setTitle("Redakte belge");
  output.setCreator("Redakt");
  output.setProducer("Redakt - tamamen tarayıcı içinde");

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      throwIfAborted(options.signal);
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderScale = Math.min(2, MAX_RENDER_EDGE / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = canvasForPage(Math.ceil(viewport.width), Math.ceil(viewport.height), options.canvasFactory);
      const canvasContext = canvas.getContext("2d", { alpha: false });
      if (!canvasContext) throw new Error("PDF sayfası çizilemedi.");
      // Adım düzeyinde ilerleme: sayfa işlemenin hangi adımda uzadığı hem
      // panelde hem izde görünsün. Sahada tek sayfalık PDF "1/1"de asılı kaldı;
      // sayfa içi hangi adım olduğu görülemiyordu.
      options.onProgress?.(pdfRedactionProgress(pageNumber, pdfDocument.numPages, "render"));
      await renderPdfPage(
        page,
        { canvas, canvasContext, viewport, background: "#FFFFFF" },
        { signal: options.signal, timeoutMs: options.renderTimeoutMs }
      );

      options.onProgress?.(pdfRedactionProgress(pageNumber, pdfDocument.numPages, "text"));
      const textContent = await page.getTextContent({ disableNormalization: false });
      const extractedPage = context.pages[pageNumber - 1];
      const pageMap = extractedPage?.source === "ocr"
        ? extractedPage
        : buildPdfPageText(textContent.items, textContent.styles);
      const matches = replacementsForText(pageMap.text, replacementMap);
      if (pageMap.source === "ocr") {
        paintOcrRedactions(canvasContext, matchOcrSegments(pageMap, matches, renderScale), renderScale);
      } else {
        paintRedactions(canvasContext, matchSegments(pageMap, matches, viewport, runtime.Util, canvasContext), renderScale);
      }

      // Eşleşen form alanının kutusu bütünüyle kapatılır. Alanın kendi
      // görünüm akışında glif konumu yok; harf harf boyamak yerine kutuyu
      // kapatmak hem kesin hem de bir form alanında görsel olarak doğrudur.
      options.onProgress?.(pdfRedactionProgress(pageNumber, pdfDocument.numPages, "annotations"));
      for (const annotation of await pageAnnotations(page)) {
        const rect = annotation?.rect;
        if (!Array.isArray(rect) || rect.length < 4) continue;
        const values = annotationValues(annotation);
        if (!values.some((value) => replacementsForText(value, replacementMap).length)) continue;
        const [a, b, c, d, e, f] = viewport.transform;
        const toCanvas = (x, y) => [a * x + c * y + e, b * x + d * y + f];
        const [x1, y1] = toCanvas(rect[0], rect[1]);
        const [x2, y2] = toCanvas(rect[2], rect[3]);
        canvasContext.fillStyle = "#000000";
        canvasContext.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }

      options.onProgress?.(pdfRedactionProgress(pageNumber, pdfDocument.numPages, "jpeg"));
      const jpeg = await output.embedJpg(await canvasToJpeg(canvas));
      const outputPage = output.addPage([baseViewport.width, baseViewport.height]);
      outputPage.drawImage(jpeg, { x: 0, y: 0, width: baseViewport.width, height: baseViewport.height });
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
      options.onProgress?.(pdfRedactionProgress(pageNumber, pdfDocument.numPages, "embedded"));
    }
  } finally {
    await loadingTask.destroy();
  }

  options.onProgress?.(pdfRedactionProgress(pdfDocument.numPages, pdfDocument.numPages, "save"));
  const result = await output.save({ useObjectStreams: true, addDefaultPage: false });
  options.onProgress?.(pdfRedactionProgress(pdfDocument.numPages, pdfDocument.numPages, "complete"));
  return result;
}

export { PDF_MIME };

function outputPdfFilename(filename, replacementMap = null) {
  return redactedOutputFilename(filename, replacementMap);
}

export const pdfAdapter = Object.freeze({
  id: "pdf",
  extensions: [".pdf"],
  mimeType: PDF_MIME,
  canHandle: (filename) => /\.pdf$/iu.test(filename),
  extract: scanPdf,
  applyChanges: redactPdf,
  outputFilename: outputPdfFilename,
  dispose(context) {
    context.bytes = new Uint8Array(0);
    context.pages = [];
    context.texts = [];
    context.units = [];
  },
});
