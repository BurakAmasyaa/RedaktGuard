import { replacementsForText } from "./pii.js";

const MEDIA_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
}

function mediaEntries(zip, directory) {
  const prefix = `${directory.replace(/\/$/u, "")}/`;
  return Object.values(zip.files).filter((entry) => {
    if (entry.dir || !entry.name.startsWith(prefix)) return false;
    const extension = entry.name.split(".").pop()?.toLowerCase();
    return Boolean(MEDIA_TYPES[extension]);
  });
}

function mediaType(path) {
  return MEDIA_TYPES[path.split(".").pop()?.toLowerCase()] || null;
}

export function buildOcrImageText(words = []) {
  let text = "";
  const records = [];
  for (const word of words) {
    const value = String(word.text || "").trim();
    if (!value || !word.bbox) continue;
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
  return { text, records };
}

export function imageInput(bytes, mimeType) {
  if (typeof window !== "undefined" && typeof Blob !== "undefined") return new Blob([bytes], { type: mimeType });
  return bytes;
}

export async function scanEmbeddedImages(zip, directory, options = {}) {
  const entries = mediaEntries(zip, directory);
  if (!entries.length) return [];
  let worker = null;
  let ocrTools = null;
  const images = [];
  try {
    ocrTools = await import("./ocr.js");
    options.onProgress?.({ phase: "ocr", status: "initializing", current: 0, total: entries.length, kind: "image" });
    worker = options.ocrFactory
      ? await options.ocrFactory({ signal: options.signal, onProgress: options.onOcrProgress })
      : await ocrTools.createLocalOcrWorker({ signal: options.signal, onProgress: options.onOcrProgress });
    for (let index = 0; index < entries.length; index += 1) {
      throwIfAborted(options.signal);
      const entry = entries[index];
      const bytes = await entry.async("uint8array");
      const mimeType = mediaType(entry.name);
      const result = options.recognizeOcr
        ? await options.recognizeOcr(worker, imageInput(bytes, mimeType), {
          imageNumber: index + 1,
          mediaPath: entry.name,
          profile: options.profile || "balanced",
        })
        : await ocrTools.recognizeOcrPage(worker, imageInput(bytes, mimeType), { rotateAuto: true });
      const pageMap = buildOcrImageText(result.words || []);
      images.push({
        ...pageMap,
        path: entry.name,
        mimeType,
        source: "ocr-image",
      });
      options.onProgress?.({
        phase: "ocr",
        status: "complete",
        current: index + 1,
        total: entries.length,
        kind: "image",
      });
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(`Gömülü Office görseli yerel OCR ile okunamadı: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
  } finally {
    if (worker) {
      if (options.ocrFactory) await worker.terminate?.();
      else await ocrTools?.terminateOcrWorker(worker);
    }
  }
  return images;
}

export async function loadImage(bytes, mimeType, options) {
  if (options.imageFactory) return options.imageFactory(bytes, mimeType);
  if (typeof createImageBitmap === "undefined") {
    throw new Error("Gömülü görsel tarayıcıda açılamadı.");
  }
  return createImageBitmap(new Blob([bytes], { type: mimeType }));
}

export function canvasForImage(width, height, options) {
  if (options.canvasFactory) return options.canvasFactory(width, height);
  if (typeof document === "undefined") throw new Error("Gömülü görsel yalnızca tarayıcıda maskelenebilir.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function canvasBytes(canvas, mimeType) {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Gömülü görsel yeniden oluşturulamadı.")),
        mimeType,
        0.94
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (typeof canvas.encode === "function") {
    const format = mimeType === "image/jpeg" ? "jpeg" : mimeType === "image/webp" ? "webp" : "png";
    return new Uint8Array(format === "png" ? await canvas.encode("png") : await canvas.encode(format, 94));
  }
  throw new Error("Gömülü görsel yeniden oluşturulamadı.");
}

export function ocrSegments(image, matches) {
  const segments = [];
  for (const match of matches) {
    let first = true;
    for (const record of image.records) {
      if (match.start >= record.end || match.end <= record.start) continue;
      segments.push({
        x: record.bbox.x0,
        y: record.bbox.y0,
        width: Math.max(record.bbox.x1 - record.bbox.x0, 3),
        height: Math.max(record.bbox.y1 - record.bbox.y0, 5),
        placeholder: first ? match.placeholder : "",
      });
      first = false;
    }
  }
  return segments;
}

export function paintRedactions(context, segments) {
  const padding = 2;
  for (const segment of segments) {
    const x = segment.x - padding;
    const y = segment.y - padding;
    const width = segment.width + padding * 2;
    const height = segment.height + padding * 2;
    context.fillStyle = "#0A0A0A";
    context.fillRect(x, y, width, height);
    if (!segment.placeholder || width < 38) continue;
    const fontSize = Math.max(6, Math.min(9, height * 0.5));
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

export async function redactEmbeddedImages(zip, images = [], replacementMap, options = {}) {
  for (let index = 0; index < images.length; index += 1) {
    throwIfAborted(options.signal);
    const image = images[index];
    const matches = replacementsForText(image.text, replacementMap);
    if (!matches.length) continue;
    const entry = zip.file(image.path);
    if (!entry) continue;
    const bytes = await entry.async("uint8array");
    const source = await loadImage(bytes, image.mimeType, options);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const canvas = canvasForImage(width, height, options);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Gömülü görsel maskelenemedi.");
    context.drawImage(source, 0, 0, width, height);
    paintRedactions(context, ocrSegments(image, matches));
    zip.file(image.path, await canvasBytes(canvas, image.mimeType));
    source.close?.();
    canvas.width = 1;
    canvas.height = 1;
    options.onProgress?.({ current: index + 1, total: images.length, kind: "image" });
  }
}
