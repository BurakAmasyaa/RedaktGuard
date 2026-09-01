import { createWorker, OEM } from "tesseract.js";

const IS_BROWSER = typeof window !== "undefined";
const BASE_URL = import.meta.env?.BASE_URL || (IS_BROWSER ? "/" : "");

function browserOptions(onProgress) {
  const origin = window.location.origin;
  return {
    workerPath: new URL(`${BASE_URL}ocr/worker.min.js`, origin).href,
    corePath: new URL(`${BASE_URL}ocr/core`, origin).href,
    langPath: new URL(`${BASE_URL}ocr/lang`, origin).href.replace(/\/$/u, ""),
    workerBlobURL: false,
    cacheMethod: "write",
    logger: (message) => onProgress?.(message),
  };
}

async function nodeOptions(onProgress) {
  const languageDirectory = new URL(["..", "public", "ocr", "lang"].join("/"), import.meta.url);
  return {
    langPath: decodeURIComponent(languageDirectory.pathname),
    cacheMethod: "readOnly",
    logger: (message) => onProgress?.(message),
  };
}

export async function createLocalOcrWorker({ onProgress, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
  const worker = await createWorker(
    ["tur", "eng"],
    OEM.LSTM_ONLY,
    IS_BROWSER ? browserOptions(onProgress) : await nodeOptions(onProgress)
  );
  if (signal?.aborted) {
    await worker.terminate();
    throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
  }
  signal?.addEventListener("abort", () => worker.terminate(), { once: true });
  return worker;
}

export function wordsFromOcrBlocks(blocks = []) {
  return blocks.flatMap((block) =>
    (block.paragraphs || []).flatMap((paragraph) =>
      (paragraph.lines || []).flatMap((line) => line.words || [])
    )
  ).filter((word) => word.text && word.bbox);
}

export async function recognizeOcrPage(worker, image, options = {}) {
  const result = await worker.recognize(image, {
    rotateAuto: options.rotateAuto !== false,
  }, { text: true, blocks: true });
  return {
    text: result.data.text || "",
    confidence: Number(result.data.confidence) || 0,
    words: wordsFromOcrBlocks(result.data.blocks || []),
  };
}

export async function terminateOcrWorker(worker) {
  if (worker) await worker.terminate();
}
