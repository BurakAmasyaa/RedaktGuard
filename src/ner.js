import { env, pipeline } from "@huggingface/transformers";
import { categoryMeta, matchKey, normalizeValue } from "./pii.js";
import { createModelDownloadAggregator } from "./model-cache.js";
import ortWasmModuleUrl from "./vendor/ort-wasm-simd-threaded.jsep.mjs?url";
import { processingConfig } from "./profiles.js";
import { isTechnicalNoise } from "./technical-noise.js";

const MODEL_ID = "redakt-turkish-ner";
const MIN_ENTITY_SCORE = 0.84;
const MAX_CHUNK_LENGTH = 1200;
// Kırpılan kuyruk için en fazla kaç ek geçiş yapılır. Sınır, hiç ilerlemeyen
// bir parçanın sonsuz döngüye dönmesini engeller.
const MAX_COVERAGE_PASSES = 3;
const ENTITY_CATEGORIES = Object.freeze({ PER: "person", ORG: "organization", LOC: "location" });
const IS_BROWSER = typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined";
const BASE_URL = import.meta.env?.BASE_URL || (IS_BROWSER ? "/" : "public/");

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = IS_BROWSER;
env.localModelPath = `${BASE_URL}models/`;
if (IS_BROWSER) {
  const runtimeOrigin = globalThis.location?.origin || "http://127.0.0.1";
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL(ortWasmModuleUrl, runtimeOrigin).href,
    wasm: new URL("./vendor/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href,
  };
  // WASM çoklu iş parçacığı SharedArrayBuffer ister, o da çapraz kaynak
  // yalıtımı ister (COOP + COEP başlıkları). Yalıtım yoksa tek iş parçacığı
  // zorunludur; birden fazla istemek oturumu hiç kurdurmaz.
  //
  // İş parçacıkları YALNIZCA WASM yoluna açılır. WebGPU da aynı JSEP wasm
  // ikilisi üzerinden koştuğu için, GPU kullanılacakken iş parçacığı istemek
  // modül worker'ında oturum kurulmasını askıda bırakıyor.
  const webGpuAvailable = Boolean(globalThis.navigator?.gpu);
  env.backends.onnx.wasm.numThreads = !webGpuAvailable && globalThis.crossOriginIsolated
    ? Math.max(1, Math.min(8, globalThis.navigator?.hardwareConcurrency || 4))
    : 1;
}

let modelPromise = null;
let activeDevice = null;

let forcedDevice = null;

export function configureNerRuntime({ modelPath, preferDevice } = {}) {
  if (modelPromise) return;
  if (modelPath) env.localModelPath = modelPath.endsWith("/") ? modelPath : `${modelPath}/`;
  // Önceki oturum çöktüyse çağıran taraf güvenli yolu dayatabilir.
  if (preferDevice) forcedDevice = preferDevice;
}

// Aynı cihazda ölçüldü (8 paragraf, 2.416 karakter, Chromium):
//   WASM  q4  -> 9.972 ms · 242 karakter/sn   (tek iş parçacığı; SharedArrayBuffer yok)
//   WebGPU q4 ->   423 ms · 5.713 karakter/sn (11,8 kat, model yüklemesi de 2 kat hızlı)
// Vendor'daki ort wasm zaten JSEP yapısı, yani WebGPU için ek varlık gerekmiyor.
// WebGPU yoksa veya oturum kurulamazsa sessizce WASM'e düşülür: hız kaybı olur,
// doğruluk değişmez.
const DEVICE_ORDER = IS_BROWSER ? ["webgpu", "wasm"] : ["cpu"];

function buildPipeline(device, progressCallback) {
  const downloadProgress = createModelDownloadAggregator();
  return pipeline("token-classification", MODEL_ID, {
    device,
    dtype: "q4",
    progress_callback(progress) {
      const aggregate = downloadProgress.update(progress);
      if (aggregate) progressCallback?.(aggregate);
    },
  }).then((classifier) => {
    progressCallback?.(downloadProgress.complete());
    return classifier;
  });
}

function loadModel(progressCallback) {
  if (!modelPromise) {
    modelPromise = (async () => {
      let lastError = null;
      const order = forcedDevice ? [forcedDevice] : DEVICE_ORDER;
      for (const device of order) {
        if (device === "webgpu" && !globalThis.navigator?.gpu) continue;
        try {
          const classifier = await buildPipeline(device, progressCallback);
          activeDevice = device;
          return classifier;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("Yerel model çalıştırılamadı.");
    })().catch((error) => {
      modelPromise = null;
      activeDevice = null;
      throw error;
    });
  }
  return modelPromise;
}

// Tanılama ve ilerleme metni için: tarama hangi donanımda koştu.
export function activeNerDevice() {
  return activeDevice;
}

// Modeli ve çekirdekleri önden hazırlar. Tek ve çok kısa bir çıkarım yapılır:
// oturum kurulur, gölgelendiriciler/çekirdekler derlenir, ilk gerçek taramada
// bu bedel ödenmez.
export async function preloadNerModel(onProgress) {
  const classifier = await loadModel((progress) => onProgress?.({ phase: "model", ...progress }));
  await classifier("Ahmet", { ignore_labels: [], truncation: true, max_length: 512 });
  return activeDevice;
}

function foldForAlignment(value) {
  return String(value).normalize("NFC").toLocaleLowerCase("tr-TR");
}

// foldedText çağıran tarafta bir kez hesaplanır. Metnin tamamını her token
// için yeniden normalize etmek O(token x metin) maliyet çıkarıyordu; GPU'da
// çıkarım 50 ms'ye inince bu son işlem baskın gider hâline geldi.
function findAlignedPiece(text, foldedText, token, cursor) {
  const continuation = token.startsWith("##");
  const piece = token.replace(/^##/u, "");
  if (!piece || piece === "[UNK]") return null;

  let searchStart = cursor;
  if (!continuation) {
    while (/\s/u.test(text[searchStart] || "")) searchStart += 1;
  }

  const foldedPiece = foldForAlignment(piece);
  const direct = foldedText.slice(searchStart, searchStart + foldedPiece.length);
  let start = direct === foldedPiece
    ? searchStart
    : foldedText.indexOf(foldedPiece, searchStart);

  if (start < 0 || start - searchStart > 64) return null;
  return { start, end: start + piece.length, continuation, piece };
}

function cleanEntitySpan(text, start, end) {
  const leading = /^[\s“”"()\[\]{},;:]+/u.exec(text.slice(start, end));
  const trailing = /[\s“”"()\[\]{},;:]+$/u.exec(text.slice(start, end));
  return {
    start: start + (leading?.[0].length || 0),
    end: end - (trailing?.[0].length || 0),
  };
}

function meaningfulCharacterCount(value) {
  return [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const MAX_WORD_EXPANSION = 24;

// Model bir sözcüğün yalnız bir parçasını etiketleyebilir: "Agent" WordPiece
// olarak "Ag" + "##ent" bölünür, yalnız "Ag" ORG işaretlenir ve varlık
// sözcüğün ortasında biter. Sonuç iki türlü kötüdür: listede "Ag" gibi
// anlamsız bir öge görünür ve maskeleme yapılırsa sözcüğün geri kalanı
// ("ent") belgede kalır. Aralık daima sözcük sınırına taşınır.
function expandToWordBoundaries(text, start, end) {
  let expandedStart = start;
  let expandedEnd = end;
  while (
    expandedStart > 0
    && expandedStart > start - MAX_WORD_EXPANSION
    && WORD_CHARACTER.test(text[expandedStart - 1] || "")
    && WORD_CHARACTER.test(text[expandedStart] || "")
  ) expandedStart -= 1;
  while (
    expandedEnd < text.length
    && expandedEnd < end + MAX_WORD_EXPANSION
    && WORD_CHARACTER.test(text[expandedEnd] || "")
    && WORD_CHARACTER.test(text[expandedEnd - 1] || "")
  ) expandedEnd += 1;
  return { start: expandedStart, end: expandedEnd };
}

function lineAt(text, position) {
  const start = text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const newline = text.indexOf("\n", position);
  const end = newline < 0 ? text.length : newline;
  return { start, end, text: text.slice(start, end) };
}

// Yurt dışı posta kodu biçimi ("TR-35390", "PL-00001"). Eskiden hem `/i`
// bayrağı hem boşluklu biçim kabul ediliyordu; bu, "tutar TL 15000" ya da
// "Fatura No 12345" geçen HER satırı adres sayıp o satırdaki bütün kişi ve
// kurum adlarını sessizce eliyordu — sıradan bir faturada doğrudan sızıntı.
function hasPostalStructure(value) {
  return /(?:\b[A-Z]{2}-\d{4,6}\b|\b\d{2,3}-\d{3}\b)/u.test(value);
}

function isAddressLikeFragment(text, start, end, value, type) {
  if (type === "LOC" || value.includes("\n")) return false;
  const line = lineAt(text, start);
  const relativeStart = Math.max(0, start - line.start);
  const relativeEnd = Math.min(line.text.length, end - line.start);
  const surroundingText = `${line.text.slice(0, relativeStart)} ${line.text.slice(relativeEnd)}`;
  const nextLine = line.end < text.length ? lineAt(text, line.end + 1).text : "";
  const embeddedAmongOtherWords = (surroundingText.match(/[\p{L}]{2,}/gu) || []).length >= 2;
  const currentLineHasAddressNumbers = hasPostalStructure(line.text)
    || /\b\d{1,5}\s*[,/]\s*\d{2,6}\b/u.test(line.text);
  return currentLineHasAddressNumbers || (embeddedAmongOtherWords && hasPostalStructure(nextLine));
}

export function groupNerTokens(text, tokens, threshold = MIN_ENTITY_SCORE) {
  const entities = [];
  const foldedText = foldForAlignment(text);
  let cursor = 0;
  let current = null;

  const flush = () => {
    if (!current) return;
    const trimmed = cleanEntitySpan(text, current.start, current.end);
    const span = expandToWordBoundaries(text, trimmed.start, trimmed.end);
    const value = text.slice(span.start, span.end);
    // Eşik token ORTALAMASINA uygulanıyordu: "Kerem Aydın" gibi iki parçalı bir
    // adda tek bir zayıf token bütün kişiyi düşürüyor, aynı ad tek başına
    // geçtiğinde bulunuyordu. Modelin herhangi bir parçadan emin olması varlığı
    // ayakta tutmaya yeter; kaçırmak, fazladan bir bulgu göstermekten ağırdır.
    const score = Math.max(...current.scores);
    const category = ENTITY_CATEGORIES[current.type];
    if (category
      && meaningfulCharacterCount(value) >= 2
      && !isAddressLikeFragment(text, span.start, span.end, value, current.type)
      && !isTechnicalNoise(value, lineAt(text, span.start).text, span.start - lineAt(text, span.start).start)
      && score >= threshold) {
      entities.push({
        category,
        start: span.start,
        end: span.end,
        raw: value,
        normalized: normalizeValue(category, value),
        score,
      });
    }
    current = null;
  };

  for (const token of tokens) {
    const aligned = findAlignedPiece(text, foldedText, token.word, cursor);
    if (!aligned) {
      flush();
      continue;
    }
    cursor = aligned.end;

    if (token.entity === "O") {
      flush();
      continue;
    }

    const [bio, type] = String(token.entity).split("-");
    if (!ENTITY_CATEGORIES[type]) {
      flush();
      continue;
    }

    // Satır sonu varlığı BÖLER (kesmez). Alt alta yazılmış bir ad listesinde
    // model parçaları birleştirdiğinde tek bir çok satırlı varlık oluşuyor;
    // aralığı kesmek listenin kalanını tamamen düşürürdü, bölmek her adı
    // ayrı bulgu olarak ayakta tutar.
    const startsAnother = current
      && (current.type !== type
        || (bio === "B" && !aligned.continuation)
        || text.slice(current.end, aligned.start).includes("\n"));
    if (startsAnother) flush();
    if (!current) current = { type, start: aligned.start, end: aligned.end, scores: [] };
    current.end = aligned.end;
    current.scores.push(Number(token.score) || 0);
  }
  flush();
  return entities;
}

// Modelin gerçekten okuduğu son karakter. Token dizisi metnin tamamını
// kapsamıyorsa kalan kuyruk hiç değerlendirilmemiştir.
export function nerCoverage(text, tokens) {
  const foldedText = foldForAlignment(text);
  let cursor = 0;
  for (const token of tokens) {
    const aligned = findAlignedPiece(text, foldedText, token.word, cursor);
    if (aligned) cursor = aligned.end;
  }
  return cursor;
}

// Parçalar üst üste biner. Aynı konumdaki kopyayı anahtar eler; ama parça
// sınırına denk gelen varlık bir parçada kesik ("SISPR"), diğerinde bütün
// ("SISPRO") çıkar. Kesik olanı bırakmak hem listeye sahte bir öge ekler hem de
// maskelemeden sonra sözcüğün kalanını belgede bırakır. Çakışan aralıklarda
// uzun olan kazanır; eşitlikte model skoru yüksek olan.
export function resolveEntityOverlaps(entities) {
  const byText = new Map();
  for (const entity of entities) {
    if (!byText.has(entity.textIndex)) byText.set(entity.textIndex, []);
    byText.get(entity.textIndex).push(entity);
  }

  const kept = [];
  for (const group of byText.values()) {
    const ordered = [...group].sort((left, right) =>
      (right.end - right.start) - (left.end - left.start)
      || right.score - left.score
      || left.start - right.start
    );
    const accepted = [];
    for (const entity of ordered) {
      if (accepted.some((item) => entity.start < item.end && entity.end > item.start)) continue;
      accepted.push(entity);
    }
    kept.push(...accepted);
  }
  return kept.sort((left, right) => left.textIndex - right.textIndex || left.start - right.start);
}

export function chunkText(text, maxLength = MAX_CHUNK_LENGTH, overlap = 0) {
  if (text.length <= maxLength) return [{ text, offset: 0 }];
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxLength, text.length);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf(". ", end),
        text.lastIndexOf("! ", end),
        text.lastIndexOf("? ", end),
        text.lastIndexOf("; ", end),
        text.lastIndexOf(" ", end)
      );
      if (boundary > offset + Math.floor(maxLength * 0.58)) end = boundary + 1;
    }
    chunks.push({ text: text.slice(offset, end), offset });
    if (end >= text.length) break;
    offset = Math.max(offset + 1, end - overlap);
    while (/\s/u.test(text[offset] || "")) offset += 1;
  }
  return chunks;
}

function aggregateEntities(entities) {
  const aggregate = new Map();
  for (const entity of entities) {
    const key = matchKey(entity.category, entity.normalized);
    const current = aggregate.get(key);
    if (current) {
      current.count += 1;
      current.score = Math.max(current.score, entity.score);
      current.variants.add(entity.raw);
    } else {
      aggregate.set(key, { ...entity, count: 1, variants: new Set([entity.raw]), locations: [] });
    }
    aggregate.get(key).locations.push({ unitIndex: entity.textIndex, start: entity.start, end: entity.end });
  }

  const categoryCounts = { person: 0, organization: 0, location: 0 };
  return [...aggregate.values()].map((item, index) => {
    categoryCounts[item.category] += 1;
    const meta = categoryMeta[item.category];
    return {
      id: `ner_${index + 1}`,
      source: "ner",
      category: item.category,
      label: meta.label,
      value: item.raw,
      originalText: item.raw,
      variants: [...item.variants],
      normalized: item.normalized,
      count: item.count,
      score: item.score,
      confidence: "probable",
      placeholder: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      replacementText: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      locations: item.locations,
    };
  });
}

export async function detectNamedEntities(texts, {
  onProgress,
  profile = "balanced",
  signal,
  inferenceBatchSize = 1,
  interBatchDelayMs = 0,
} = {}) {
  const sourceTexts = texts.map(String);

  // Aynı metin belgede birçok birimde geçer — tabloda kural, düz metinde de sık.
  // Model aynı girdiye her seferinde aynı çıktıyı verdiği için çıkarıma yalnız
  // BENZERSİZ metinler girer; bulgular sonra o metnin geçtiği bütün birimlere
  // yayılır. Boş birim modele hiç gitmez.
  //
  // Eşleme burada açıkça tutulur. Eskiden boş birimler diziden süzülüyor ama
  // bulgular süzülmüş dizinin indeksiyle işaretleniyordu: boş bir birimden
  // sonraki her şeyin birim indeksi kayıyor, maskeleme yanlış birime bakıp
  // adı belgede bırakıyordu.
  const unitsByText = new Map();
  for (let unitIndex = 0; unitIndex < sourceTexts.length; unitIndex += 1) {
    const text = sourceTexts[unitIndex];
    if (!text.trim()) continue;
    const units = unitsByText.get(text);
    if (units) units.push(unitIndex);
    else unitsByText.set(text, [unitIndex]);
  }
  if (!unitsByText.size) return [];

  const uniqueTexts = [...unitsByText.keys()];

  const classifier = await loadModel((progress) => onProgress?.({ phase: "model", ...progress }));
  const config = processingConfig(profile);
  // textIndex bu noktadan sonra BENZERSİZ metnin indeksidir; birim indeksine
  // ancak çıkarım bittikten sonra çevrilir.
  const work = uniqueTexts.flatMap((text, textIndex) =>
    chunkText(text, config.ner.maxChunkLength, config.ner.overlap).map((chunk) => ({ ...chunk, textIndex }))
  );
  const uniqueEntities = new Map();

  const safeBatchSize = Math.max(1, Math.min(32, Number(inferenceBatchSize) || 1));
  const safeDelayMs = Math.max(0, Math.min(20, Number(interBatchDelayMs) || 0));
  for (let index = 0; index < work.length; index += safeBatchSize) {
    if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
    const inferenceWork = work.slice(index, index + safeBatchSize);
    const outputs = await classifier(
      inferenceWork.length === 1 ? inferenceWork[0].text : inferenceWork.map((chunk) => chunk.text),
      { ignore_labels: [], truncation: true, max_length: 512 }
    );
    const tokenGroups = inferenceWork.length === 1 ? [outputs] : outputs;
    for (let batchIndex = 0; batchIndex < inferenceWork.length; batchIndex += 1) {
      const chunk = inferenceWork[batchIndex];
      const tokens = tokenGroups[batchIndex] || [];
      // Model 512 token ile sınırlıdır ve fazlasını sessizce kırpar. Yoğun
      // metin (kod, tablo, kısaltma) aynı karakter sayısından kat kat fazla
      // token ürettiği için uzun parça kullanan profillerde parçanın kuyruğu
      // hiç taranmadan geçebiliyordu — belgenin o bölümünde isim aranmamış
      // olur. Kapsanmayan kuyruk yeni bir parça olarak sıraya alınır.
      const covered = nerCoverage(chunk.text, tokens);
      const remainder = chunk.text.slice(covered);
      const passes = chunk.passes || 0;
      if (covered > 0 && remainder.trim().length > 0 && passes < MAX_COVERAGE_PASSES) {
        work.push({
          text: remainder,
          offset: chunk.offset + covered,
          textIndex: chunk.textIndex,
          passes: passes + 1,
        });
      }
      for (const entity of groupNerTokens(chunk.text, tokens)) {
        const detected = {
          ...entity,
          start: entity.start + chunk.offset,
          end: entity.end + chunk.offset,
          textIndex: chunk.textIndex,
        };
        const key = `${detected.textIndex}:${detected.start}:${detected.end}:${detected.category}`;
        const existing = uniqueEntities.get(key);
        if (!existing || detected.score > existing.score) uniqueEntities.set(key, detected);
      }
    }
    onProgress?.({ phase: "inference", current: Math.min(index + inferenceWork.length, work.length), total: work.length });
    if (safeDelayMs > 0 && index + safeBatchSize < work.length) {
      await new Promise((resolve) => setTimeout(resolve, safeDelayMs));
    }
  }
  // Çakışma çözümü benzersiz metin üzerinde yapılır (aynı metnin kopyalarında
  // sonuç zaten aynıdır), sonra bulgular gerçek birim indekslerine yayılır.
  const resolved = resolveEntityOverlaps([...uniqueEntities.values()]);
  const perUnit = resolved.flatMap((entity) =>
    (unitsByText.get(uniqueTexts[entity.textIndex]) || []).map((unitIndex) => ({ ...entity, textIndex: unitIndex }))
  );
  return aggregateEntities(perUnit);
}

export const nerModel = Object.freeze({
  id: "akdeniz27/bert-base-turkish-cased-ner",
  runtime: "Transformers.js · ONNX Runtime Web",
  dtype: "q4",
  threshold: MIN_ENTITY_SCORE,
});
