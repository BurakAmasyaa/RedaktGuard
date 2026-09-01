const BASE_URL = import.meta.env?.BASE_URL || "/";

function localModelPath() {
  return new URL(`${BASE_URL}models/`, document.baseURI).href;
}

// Worker taramadan sonra sonlandırılmıyor. Eskiden her çağrı kendi worker'ını
// kurup bitince terminate ediyordu; bu, ONNX oturumunun HER belgede sıfırdan
// kurulması demekti — ölçüldü: WebGPU'da 833 ms, WASM'de 1.705 ms, her tarama.
// Worker'ı ayakta tutmak bu bedeli oturumda bir kereye indirir.
let activeWorker = null;
let lastDevice = null;
let sequence = 0;
const pending = new Map();

function abortError(signal) {
  return signal?.reason || new DOMException("İşlem iptal edildi.", "AbortError");
}

// Worker'ı bırakır ve bekleyen herkese hata iletir; sonraki çağrı yenisini kurar.
function dropWorker(error) {
  const worker = activeWorker;
  activeWorker = null;
  lastDevice = null;
  for (const entry of pending.values()) {
    entry.cleanup();
    entry.reject(error);
  }
  pending.clear();
  worker?.terminate();
}

function handleMessage(event) {
  const message = event.data || {};
  const entry = pending.get(message.requestId);
  // Kimliği tanınmayan mesaj: iptal edilmiş bir isteğin geç gelen çıktısı.
  if (!entry) return;

  if (message.type === "batch-progress") {
    entry.onProgress?.({ phase: "batch", ...message });
    return;
  }
  if (message.type === "model-progress") {
    entry.onProgress?.({ phase: "model", ...message.progress });
    return;
  }
  if (message.type === "complete") {
    if (message.device) lastDevice = message.device;
    pending.delete(message.requestId);
    entry.cleanup();
    entry.resolve(message.findings || []);
    return;
  }
  if (message.type !== "error") return;

  pending.delete(message.requestId);
  entry.cleanup();
  const error = new Error(message.message || "Yerel kişi/kurum modeli çalıştırılamadı.");
  error.name = message.name || "Error";
  error.detail = message.detail ? String(message.detail).slice(0, 300) : null;
  // İptal beklenen bir sonuçtur; oturumu bozmaz, worker ayakta kalır.
  // Gerçek hatada oturum şüphelidir, bırakılır.
  if (error.name !== "AbortError") dropWorker(error);
  entry.reject(error);
}

function handleWorkerError(event) {
  const error = new Error("Yerel kişi/kurum worker'ı başlatılamadı.");
  error.detail = String(event?.message || "").slice(0, 300);
  dropWorker(error);
}

function ensureWorker() {
  if (activeWorker) return activeWorker;
  const worker = new Worker(new URL("./ner-worker.js", import.meta.url), { type: "module", name: "redakt-ner" });
  worker.addEventListener("message", handleMessage);
  worker.addEventListener("error", handleWorkerError);
  activeWorker = worker;
  return worker;
}

function request(payload, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    let worker;
    try {
      worker = ensureWorker();
    } catch (error) {
      reject(error);
      return;
    }

    const requestId = `ner_${(sequence += 1)}`;
    const cancel = () => {
      if (!pending.delete(requestId)) return;
      signal?.removeEventListener("abort", cancel);
      worker.postMessage({ type: "cancel", requestId });
      reject(abortError(signal));
    };

    pending.set(requestId, {
      resolve,
      reject,
      onProgress,
      cleanup: () => signal?.removeEventListener("abort", cancel),
    });
    signal?.addEventListener("abort", cancel, { once: true });
    worker.postMessage({ ...payload, requestId, modelPath: localModelPath() });
  });
}

export function detectNamedEntitiesInWorker(texts, { profile = "balanced", preferDevice = null, signal, onProgress } = {}) {
  if (!texts.some((text) => String(text).trim())) return Promise.resolve([]);
  return request({ type: "detect", texts: texts.map(String), profile, preferDevice }, { signal, onProgress });
}

// Modeli önden yükletir. İlk taramada oturum kurma bedeli ödenmesin diye
// Guard'ın offscreen belgesi açılır açılmaz çağrılır.
export function warmUpNerWorker({ preferDevice = null, onProgress } = {}) {
  return request({ type: "warmup", preferDevice }, { onProgress });
}

// Tanılama: model hangi donanımda koşuyor (worker'da yüklendiği için
// ana iş parçacığından ancak böyle görülebilir).
export function nerDevice() {
  return lastDevice;
}

// Sekme kapanırken veya motor bırakılırken belleği geri vermek için.
export function releaseNerWorker() {
  dropWorker(new DOMException("İşlem iptal edildi.", "AbortError"));
}
