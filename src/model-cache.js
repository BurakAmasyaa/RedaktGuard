const NER_MODEL_ASSET_BYTES = Object.freeze({
  "config.json": 1_057,
  "tokenizer.json": 497_438,
  "tokenizer_config.json": 373,
  "special_tokens_map.json": 112,
  "onnx/model_q4.onnx": 291_331,
  "onnx/model_q4.onnx_data": 98_308_096,
  "onnx/model_q4.onnx_data_1": 55_151_932,
});

export const NER_MODEL_TOTAL_BYTES = Object.values(NER_MODEL_ASSET_BYTES)
  .reduce((total, bytes) => total + bytes, 0);
export const NER_MODEL_DOWNLOAD_MESSAGE = "Model indiriliyor (~147MB) — bu işlem bir kereye mahsus, sonraki kullanımlarda anında açılacak.";

const NER_MODEL_WEIGHT_FILES = Object.freeze([
  "onnx/model_q4.onnx",
  "onnx/model_q4.onnx_data",
  "onnx/model_q4.onnx_data_1",
]);

const MIN_MEASURABLE_MODEL_BYTES = 1024 * 1024;

// Transformers.js indirdiği varlıkları tarayıcının Cache Storage'ında
// "transformers-cache" adlı depoda tutar. Kullanıcının bilmesi gereken de tam
// olarak budur: model bir kez sunucudan alınır, sonra bu cihazın tarayıcı
// profilinde kalır — cihazdan çıkmaz, sunucuya geri gitmez, başka bir profile
// taşınmaz. Nerede durduğu söylenmediği sürece "yerel model" ifadesi
// kullanıcı için doğrulanamayan bir iddia olarak kalıyordu.
export const NER_MODEL_CACHE_NAME = "transformers-cache";
export const NER_MODEL_PATH = "models/redakt-turkish-ner/";

export function nerModelStorage({
  origin = globalThis.location?.origin || "",
  baseUri = globalThis.document?.baseURI || globalThis.location?.href || "",
} = {}) {
  let sourceUrl = NER_MODEL_PATH;
  try {
    sourceUrl = new URL(NER_MODEL_PATH, baseUri || origin || "http://127.0.0.1").href;
  } catch {
    sourceUrl = `${origin}/${NER_MODEL_PATH}`;
  }
  return {
    cacheName: NER_MODEL_CACHE_NAME,
    sourceUrl,
    totalBytes: NER_MODEL_TOTAL_BYTES,
    files: Object.keys(NER_MODEL_ASSET_BYTES),
  };
}

export function formatModelSize(bytes = NER_MODEL_TOTAL_BYTES) {
  return `${Math.round(bytes / (1024 * 1024)).toLocaleString("tr-TR")} MB`;
}

// Modeli cihazdan silmek kullanıcının hakkıdır: nerede durduğunu söyleyip
// kaldırma yolunu vermemek yarım bir cevap olurdu.
export async function clearNerModelCache({ cacheStorage = globalThis.caches, modelBaseUrl } = {}) {
  // Taban adres gövdede çözülür: varsayılan parametre olsaydı Cache Storage
  // bulunmayan bir ortamda (test, worker, eski tarayıcı) daha koruma
  // denetimine gelmeden URL kurulmaya çalışılırdı.
  if (!cacheStorage?.open) return 0;
  const prefix = new URL(modelBaseUrl || nerModelStorage().sourceUrl).href;
  const cache = await cacheStorage.open(NER_MODEL_CACHE_NAME);
  const entries = await cache.keys();
  let removed = 0;
  for (const request of entries) {
    if (!request.url.startsWith(prefix)) continue;
    if (await cache.delete(request)) removed += 1;
  }
  return removed;
}

export async function isNerModelCached({
  cacheStorage = globalThis.caches,
  modelBaseUrl = new URL("models/redakt-turkish-ner/", globalThis.document?.baseURI || globalThis.location?.href),
} = {}) {
  if (!cacheStorage?.match) return false;

  try {
    const matches = await Promise.all(
      NER_MODEL_WEIGHT_FILES.map((file) => cacheStorage.match(new URL(file, modelBaseUrl).href))
    );
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

export function formatModelDownloadBytes(loaded, total) {
  const megabyte = 1024 * 1024;
  const format = (bytes) => {
    const value = Math.max(0, Number(bytes) || 0) / megabyte;
    return value >= 10 ? Math.round(value).toLocaleString("tr-TR") : value.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
  };
  return `${format(loaded)} / ${format(total)} MB indirildi`;
}

export function isMeasurableModelDownload(progress) {
  return progress?.status === "progress"
    && Number(progress.total) >= MIN_MEASURABLE_MODEL_BYTES
    && Number.isFinite(Number(progress.loaded));
}

function normalizedModelFile(file) {
  const value = String(file || "").replace(/^\.\//u, "");
  const marker = "redakt-turkish-ner/";
  const markerIndex = value.lastIndexOf(marker);
  return markerIndex >= 0 ? value.slice(markerIndex + marker.length) : value;
}

export function createModelDownloadAggregator() {
  const loadedByFile = new Map();
  let ready = false;

  const snapshot = (file = "") => {
    const rawLoaded = [...loadedByFile.values()].reduce((total, loaded) => total + loaded, 0);
    const loaded = ready
      ? NER_MODEL_TOTAL_BYTES
      : Math.min(rawLoaded, Math.floor(NER_MODEL_TOTAL_BYTES * 0.99));
    return {
      status: "progress",
      file,
      loaded,
      total: NER_MODEL_TOTAL_BYTES,
    };
  };

  return {
    update(progress = {}) {
      const file = normalizedModelFile(progress.file);
      const expectedBytes = NER_MODEL_ASSET_BYTES[file];
      if (!expectedBytes) return null;

      const previous = loadedByFile.get(file) || 0;
      const reportedLoaded = progress.status === "done"
        ? expectedBytes
        : Math.max(0, Number(progress.loaded) || 0);
      loadedByFile.set(file, Math.max(previous, Math.min(expectedBytes, reportedLoaded)));
      return snapshot(file);
    },
    complete() {
      ready = true;
      return snapshot();
    },
  };
}
