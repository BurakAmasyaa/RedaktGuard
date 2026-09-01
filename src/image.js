import { aggregateFindings, redactedOutputFilename, replacementsForText } from "./pii.js";
import {
  buildOcrImageText,
  canvasBytes,
  canvasForImage,
  imageInput,
  loadImage,
  ocrSegments,
  paintRedactions,
} from "./office-images.js";

function imageMime(filename) {
  return /\.png$/iu.test(filename) ? "image/png" : "image/jpeg";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
}

export async function scanImage(arrayBuffer, filename, options = {}) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer.slice() : new Uint8Array(arrayBuffer.slice(0));
  const mimeType = imageMime(filename);
  const ocr = await import("./ocr.js");
  let worker;
  try {
    options.onProgress?.({ phase: "ocr", status: "initializing", current: 0, total: 1, kind: "image" });
    worker = options.ocrFactory
      ? await options.ocrFactory({ signal: options.signal, onProgress: options.onOcrProgress })
      : await ocr.createLocalOcrWorker({ signal: options.signal, onProgress: options.onOcrProgress });
    throwIfAborted(options.signal);
    const result = options.recognizeOcr
      ? await options.recognizeOcr(worker, imageInput(bytes, mimeType), { imageNumber: 1, profile: options.profile || "balanced" })
      : await ocr.recognizeOcrPage(worker, imageInput(bytes, mimeType), { rotateAuto: true });
    const image = { ...buildOcrImageText(result.words || []), source: "ocr-image", mimeType, unitIndex: 0 };
    if (!image.text.trim()) throw new Error("Görselde okunabilir metin bulunamadı.");
    options.onProgress?.({ phase: "ocr", status: "complete", current: 1, total: 1, kind: "image" });
    const units = [{ text: image.text, location: { kind: "image", imageNumber: 1 } }];
    return {
      context: { kind: "image", filename, bytes, image, texts: [image.text], units, mimeType },
      findings: aggregateFindings(units),
    };
  } finally {
    if (worker) {
      if (options.ocrFactory) await worker.terminate?.();
      else await ocr.terminateOcrWorker(worker);
    }
  }
}

export async function redactImage(context, replacementMap, options = {}) {
  throwIfAborted(options.signal);
  const source = await loadImage(context.bytes, context.mimeType, options);
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const canvas = canvasForImage(width, height, options);
  const drawing = canvas.getContext("2d");
  if (!drawing) throw new Error("Görsel maskelenemedi.");
  drawing.drawImage(source, 0, 0, width, height);
  const matches = replacementsForText(context.image.text, replacementMap);
  paintRedactions(drawing, ocrSegments(context.image, matches));
  const output = await canvasBytes(canvas, context.mimeType);
  source.close?.();
  canvas.width = 1;
  canvas.height = 1;
  return output;
}

function outputImageFilename(filename, replacementMap = null) {
  return redactedOutputFilename(filename, replacementMap);
}

export const imageAdapter = Object.freeze({
  id: "image",
  extensions: [".jpg", ".jpeg", ".png"],
  mimeType: "image/*",
  canHandle: (filename) => /\.(?:jpe?g|png)$/iu.test(filename),
  extract: scanImage,
  applyChanges: redactImage,
  outputFilename: outputImageFilename,
  dispose(context) {
    context.bytes = new Uint8Array(0);
    context.texts = [];
    context.units = [];
  },
});
