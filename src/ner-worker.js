import { configureNerRuntime, detectNamedEntities, preloadNerModel } from "./ner.js";
import { mergeNerBatches, nerBatchDelayMs } from "./ner-batching.js";

// Worker artık her istekten sonra sonlandırılmıyor, bu yüzden mesajlar
// requestId taşır: iptal edilmiş bir isteğin geç gelen çıktısı yenisine karışmaz.
let active = null;

// İstekler SIRAYA alınır. Yeni istek öncekini iptal eder ama onun bitmesini
// bekler: aynı ONNX oturumunda iki çıkarım aynı anda koşarsa ikisi de asılı
// kalıyor. Isınma ile ilk taramanın çakışması tam olarak buydu — panel
// "Yerel model hazırlanıyor" satırında sonsuza kadar duruyordu.
let queue = Promise.resolve();

function abortError() {
  return new DOMException("İşlem iptal edildi.", "AbortError");
}

function reply(requestId, payload) {
  self.postMessage({ ...payload, requestId });
}

self.addEventListener("message", (event) => {
  const message = event.data || {};
  const requestId = message.requestId;

  if (message.type === "cancel") {
    if (active && (!requestId || active.requestId === requestId)) active.controller.abort(abortError());
    return;
  }
  if (message.type !== "detect" && message.type !== "warmup") return;

  // Uçuştaki işi iptal et, ama sırayı bozma: bir sonraki iş ancak öncekinin
  // sözü kapandıktan sonra başlar.
  active?.controller.abort(abortError());
  queue = queue.then(() => handle(message, requestId)).catch(() => {});
});

async function handle(message, requestId) {
  const controller = new AbortController();
  active = { requestId, controller };
  configureNerRuntime({ modelPath: message.modelPath, preferDevice: message.preferDevice });

  try {
    if (message.type === "warmup") {
      const device = await preloadNerModel((progress) => reply(requestId, { type: "model-progress", progress }));
      reply(requestId, { type: "complete", findings: [], device });
      return;
    }

    const texts = Array.isArray(message.texts) ? message.texts : [];

    // Belgenin tamamı tek çağrıda gider. Metinleri 150'lik gruplara bölmek,
    // yinelenen hücre ayıklamasını grubun içine hapsediyordu: 2.000 hücrelik
    // ve yalnız 21 farklı değer taşıyan bir tabloda aynı hücre 14 grupta
    // yeniden taranıyor, 21 çıkarım yerine 294 çıkarım yapılıyordu.
    const findings = await detectNamedEntities(texts, {
      profile: message.profile,
      signal: controller.signal,
      // Ölçüm (WASM, 8 iş parçacığı): batch=1 416 karakter/sn, batch=8 1.208.
      // WebGPU'da fark yok (326 / 338 ms), yani yükseltmek yalnız yedeği
      // hızlandırır, GPU yolunu bozmaz.
      inferenceBatchSize: texts.every((text) => text.length <= 160) ? 32 : 8,
      interBatchDelayMs: nerBatchDelayMs(texts),
      onProgress(progress) {
        if (progress.phase === "inference") {
          reply(requestId, { type: "batch-progress", current: progress.current, total: progress.total });
        } else if (progress.phase === "model" || progress.status) {
          reply(requestId, { type: "model-progress", progress });
        }
      },
    });
    reply(requestId, { type: "complete", findings: mergeNerBatches([{ offset: 0, findings }]) });
  } catch (error) {
    // Gerçek hata metni kurulum ve sorun gidermede tek ipucudur; kaybedilmemeli.
    // Bu metin çalışma zamanından gelir, belge içeriği taşımaz.
    reply(requestId, {
      type: "error",
      name: error?.name || "Error",
      message: error?.name === "AbortError" ? "İşlem iptal edildi." : "Yerel kişi/kurum modeli çalıştırılamadı.",
      detail: error?.name === "AbortError" ? null : String(error?.message || error || "").slice(0, 300),
    });
  } finally {
    if (active?.requestId === requestId) active = null;
  }
}
