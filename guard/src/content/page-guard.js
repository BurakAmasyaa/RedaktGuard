// Sayfa dünyasında çalışan son emniyet. DOM'da araya girme başarısız olursa
// (arayüz değişti, bilmediğimiz bir yükleme yolu var) taranabilir bir dosya
// yine de ağa çıkamaz.
//
// Politika ve onaylar iki dünyanın ortak DOM'undan eşzamanlı okunur; kuyruğa
// alınmış bir mesajı beklemek, sayfanın hemen başlattığı yüklemeye yetişemezdi.
//
// Not: sayfa özgün dosyayı hiçbir zaman eline geçirmediği için bu kanalın
// taklit edilmesi saldırgana bir şey kazandırmaz; kanal gizli değildir.

import {
  APPROVAL_WINDOW_MS,
  BINARY_BODY_FLOOR_BYTES,
  LARGE_BINARY_BYTES,
  APPROVED_ATTRIBUTE,
  CONFIG_ATTRIBUTE,
  DROP_DELIVERY_ACK_ATTRIBUTE,
  DROP_DELIVERY_ACTIVE_ATTRIBUTE,
  DROP_CLEANUP_EVENT,
  DROP_DELIVERY_EVENT,
  DROP_DELIVERY_POINT_ATTRIBUTE,
  DROP_DELIVERY_TARGET_ATTRIBUTE,
  DROP_DELIVERY_TOKEN_ATTRIBUTE,
  FILE_DELIVERY_ACK_ATTRIBUTE,
  FILE_DELIVERY_EVENT,
  FILE_DELIVERY_TOKEN_ATTRIBUTE,
  GUARD_MARK,
  PAGE,
  parseSizeKey,
} from "../protocol.js";

const originalFetch = window.fetch;
const originalSend = XMLHttpRequest.prototype.send;
const relayedDeliveryEvents = new WeakSet();

// Dosya seçimi isolated dünyada durdurulup maskelendikten sonra, siteye
// verilecek tek FileList güvenli kopyadır. Gemini ve Claude bazı sürümlerinde
// isolated dünyadan üretilen input/change olaylarını framework katmanına
// taşımıyor. Bu röle aynı DOM input'undaki güvenli FileList'i değiştirmeden
// olayları sayfanın kendi JavaScript dünyasında yeniden üretir.
function relaySafeFileInput(event) {
  if (relayedDeliveryEvents.has(event)) return;
  const pathTarget = event.composedPath?.()[0] || event.target;
  const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : pathTarget;
  if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files?.length) return;

  const token = input.getAttribute(FILE_DELIVERY_TOKEN_ATTRIBUTE);
  if (!token) return;
  relayedDeliveryEvents.add(event);
  // Önce onayla: site ilk olayda input'u DOM'dan çıkarsa bile isolated dünya
  // rölenin gerçekten çalıştığını eşzamanlı olarak görebilir.
  input.setAttribute(FILE_DELIVERY_ACK_ATTRIBUTE, token);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

const boundFileInputs = new WeakSet();

function bindFileInputs(root) {
  const inputs = [];
  if (root instanceof HTMLInputElement && root.type === "file") inputs.push(root);
  for (const input of root.querySelectorAll?.('input[type="file"]') || []) inputs.push(input);
  for (const input of inputs) {
    if (boundFileInputs.has(input)) continue;
    boundFileInputs.add(input);
    // Doğrudan dinleyici, tarama sırasında DOM'dan ayrılan input'ta da kalır.
    input.addEventListener(FILE_DELIVERY_EVENT, relaySafeFileInput, true);
  }
  for (const element of root.querySelectorAll?.("*") || []) {
    if (element.shadowRoot) bindFileInputs(element.shadowRoot);
  }
}

// Bağlı input'lar için pencere dinleyicisi yeterlidir; MutationObserver ise
// daha sonra DOM'dan ayrılan girdiye doğrudan MAIN-world dinleyiciyi bırakır.
window.addEventListener(FILE_DELIVERY_EVENT, relaySafeFileInput, true);
bindFileInputs(document);
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element || node instanceof DocumentFragment) bindFileInputs(node);
    }
  }
}).observe(document, { childList: true, subtree: true });

// Drag ile başlayan teslimi sayfanın dünyasında yeniden oynat. CustomEvent
// yalnız bir jeton taşır; File nesneleri ortak DOM'daki geçici input'tan okunur.
// O input'a hiçbir zaman özgün dosya değil, yalnız Guard çıktısı yazılır.
function relaySafeDrop(event) {
  const target = event.composedPath?.()[0] || event.target;
  if (!(target instanceof Element)) return;
  const token = target.getAttribute(DROP_DELIVERY_TARGET_ATTRIBUTE);
  if (!token) return;

  const bridge = [...document.querySelectorAll(`input[${DROP_DELIVERY_TOKEN_ATTRIBUTE}]`)].find(
    (input) => input.getAttribute(DROP_DELIVERY_TOKEN_ATTRIBUTE) === token
  );
  if (!(bridge instanceof HTMLInputElement) || !bridge.files?.length) return;

  let clientX = 0;
  let clientY = 0;
  try {
    [clientX, clientY] = JSON.parse(bridge.getAttribute(DROP_DELIVERY_POINT_ATTRIBUTE) || "[0,0]");
  } catch {
    // Koordinat yalnız hedef seçimini iyileştirir; teslim için zorunlu değildir.
  }

  const transfer = new DataTransfer();
  for (const file of bridge.files) transfer.items.add(file);
  document.documentElement.setAttribute(DROP_DELIVERY_ACTIVE_ATTRIBUTE, token);
  bridge.setAttribute(DROP_DELIVERY_ACK_ATTRIBUTE, token);
  try {
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: Number(clientX) || 0,
          clientY: Number(clientY) || 0,
          dataTransfer: transfer,
        })
      );
    }
  } finally {
    document.documentElement.removeAttribute(DROP_DELIVERY_ACTIVE_ATTRIBUTE);
  }
}

window.addEventListener(DROP_DELIVERY_EVENT, relaySafeDrop, true);

// İptal/hata yolunda güvenli FileList yoktur, fakat sitenin daha önce açtığı
// tam ekran drop durumu MAIN-world olaylarıyla kesin kapatılmalıdır.
function relayDropCleanup(event) {
  const target = event.composedPath?.()[0] || event.target;
  if (!(target instanceof Element)) return;
  const transfer = new DataTransfer();
  document.documentElement.setAttribute(DROP_DELIVERY_ACTIVE_ATTRIBUTE, "cleanup");
  try {
    for (const type of ["drop", "dragleave", "dragend"]) {
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: -1,
          clientY: -1,
          dataTransfer: transfer,
        })
      );
    }
    (document.activeElement || document.body)?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, composed: true })
    );
  } finally {
    document.documentElement.removeAttribute(DROP_DELIVERY_ACTIVE_ATTRIBUTE);
  }
}

window.addEventListener(DROP_CLEANUP_EVENT, relayDropCleanup, true);

function readJson(attribute) {
  try {
    const raw = document.documentElement.getAttribute(attribute);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function extensionOf(name) {
  const match = /\.([^.]+)$/u.exec(String(name || "").toLowerCase());
  return match ? match[1] : "";
}

// Yalnızca File örnekleri incelenir. Adsız bir Blob "kullanıcının yüklediği
// dosya" değildir — siteler JSON ve ikili gövdeleri de Blob olarak gönderir;
// onları engellemek dosya sızıntısını durdurmaz, siteyi kırar.
function filesIn(body) {
  const found = [];
  if (!body) return found;
  if (body instanceof File) found.push(body);
  else if (body instanceof FormData) {
    for (const value of body.values()) if (value instanceof File) found.push(value);
  }
  return found;
}

// Adsız ikili gövdenin bayt uzunluğu. Siteler dosyayı kendi adını taşımayan
// bir gövdeye sarıp imzalı URL'e PUT edebiliyor; o yol yalnız File ve FormData
// aranırsa tamamen görünmez kalır ve maskelenmemiş belge ağa çıkar.
// Belge imzaları: %PDF-, PK (docx/xlsx/zip), OLE (doc/xls), {\rtf. Görsel
// imzaları bilerek yok; DOCUMENT_MIME ile aynı sınırda kalır.
function sniffsDocument(head) {
  if (!head || head.length < 4) return false;
  const [a, b, c, d] = head;
  if (a === 0x25 && b === 0x50 && c === 0x44 && d === 0x46) return true; // %PDF
  if (a === 0x50 && b === 0x4b && c === 0x03 && d === 0x04) return true; // PK..
  if (a === 0xd0 && b === 0xcf && c === 0x11 && d === 0xe0) return true; // OLE
  if (a === 0x7b && b === 0x5c && c === 0x72 && d === 0x74) return true; // {\rt
  return false;
}

function binaryBodyProbe(body) {
  if (!body || body instanceof File) return null;
  if (body instanceof Blob) return { size: body.size, type: String(body.type || ""), head: null };
  if (body instanceof ArrayBuffer) return { size: body.byteLength, type: "", head: new Uint8Array(body, 0, Math.min(8, body.byteLength)) };
  if (ArrayBuffer.isView(body)) {
    return { size: body.byteLength, type: "", head: new Uint8Array(body.buffer, body.byteOffset, Math.min(8, body.byteLength)) };
  }
  if (body instanceof FormData) {
    for (const value of body.values()) {
      if (value instanceof Blob && !(value instanceof File)) return { size: value.size, type: String(value.type || "") };
    }
  }
  return null;
}

// Belge gibi görünen MIME türleri. Telemetri protobuf/JSON/metin taşır.
const DOCUMENT_MIME = /pdf|msword|officedocument|vnd\.ms-|rtf|octet-stream|zip|x-hwp/iu;

// Engellenmesi gereken ilk dosyanın adını döndürür, yoksa null.
// Gövdede dosya yoksa tek bir instanceof kontrolüyle çıkar: bu yol her
// fetch çağrısında işlediği için ucuz kalmalı.
function offender(body, sniffedDocument = false) {
  const files = filesIn(body);
  const config = readJson(CONFIG_ATTRIBUTE);
  if (!config?.active) return null;
  if (!files.length && !config.blockUnscannable) return null;
  const extensions = Array.isArray(config.extensions) ? config.extensions : [];
  const approved = new Set(readJson(APPROVED_ATTRIBUTE) || []);

  if (!files.length) {
    // Buraya yalnız adsız ikili gövdeyle gelinir. Kurumsal zorlama kapalıyken
    // dokunulmaz: sıradan siteler JSON ve telemetriyi de Blob gönderir ve
    // onları engellemek sızıntıyı durdurmaz, siteyi kırar.
    //
    // Zorlama açıkken kural şudur: bu sekmede HİÇ onaylı dosya yoksa büyük
    // ikili gövde durdurulur — yakalama atlanmış, sayfa elindeki özgün dosyayı
    // yüklüyor demektir. Onaylı dosya varsa gövde geçer. Boyut eşitliği
    // aranmaz: Gemini teslim ettiğimiz dosyayı parça parça (resumable) yüklüyor,
    // parça boyutu dosya boyutuna eşit olmadığı için kendi çıktımızı
    // engelliyorduk — temiz PDF'te bile "adsız yükleme" uyarısı çıkıyordu.
    const probe = binaryBodyProbe(body);
    if (!config.blockUnscannable || !probe || probe.size < BINARY_BODY_FLOOR_BYTES) return null;
    // Onay süreli ve boyutludur: son 10 dakikada teslim ettiğimiz bir dosyadan
    // büyük olmayan gövde geçer (parçalı yükleme dosya boyutunu aşmaz). Sekme
    // ömrü boyunca "bir kez onaylandı, artık her şey geçer" olmaz.
    const now = Date.now();
    const covered = [...approved].some((key) => {
      const approval = parseSizeKey(key);
      return approval && now - approval.at < APPROVAL_WINDOW_MS && probe.size <= approval.size;
    });
    if (covered) return null;
    // Telemetri ile belge ayrımı: MIME belge diyorsa, ilk baytlar belge imzasıysa
    // ya da gövde gerçekten büyükse yükleme sayılır; küçük ve türsüz gövde
    // sayfanın kendi trafiğidir.
    const documentLike = DOCUMENT_MIME.test(probe.type) || sniffedDocument || sniffsDocument(probe.head);
    if (!documentLike && probe.size < LARGE_BINARY_BYTES) return null;
    return "adsız yükleme";
  }

  for (const file of files) {
    const name = String(file.name || "");
    // Onay her türde geçerlidir: kullanıcı taranamayan bir dosyayı bilerek
    // gönderdiyse, kendi verdiğimiz izni burada geri almamalıyız.
    if (approved.has(`${name}|${file.size}`)) continue;
    const scannable = name && extensions.includes(extensionOf(name));
    if (!scannable) {
      if (config.blockUnscannable) return name || "adsız dosya";
      continue;
    }
    return name;
  }
  return null;
}

function announcePage(type, payload = {}) {
  window.postMessage({ __redaktGuard: GUARD_MARK, type, ...payload }, location.origin);
}

function announce(filename) {
  announcePage(PAGE.blocked, { filename });
}

function approvedUpload(body, sniffedDocument = false) {
  const approved = new Set(readJson(APPROVED_ATTRIBUTE) || []);
  const files = filesIn(body);
  if (files.some((file) => approved.has(`${String(file.name || "")}|${file.size}`))) return true;

  // Gemini güvenli File'ı parçalı, adsız Blob/ArrayBuffer gövdelerine çevirebilir.
  // Eski bir onayın sıradan telemetriyi "yükleme" saymaması için ağ emniyetiyle
  // aynı süre, boyut ve belge-benzerliği koşulları kullanılır.
  const probe = binaryBodyProbe(body);
  if (!probe || probe.size < BINARY_BODY_FLOOR_BYTES) return false;
  const now = Date.now();
  const covered = [...approved].some((key) => {
    const approval = parseSizeKey(key);
    return approval && now - approval.at < APPROVAL_WINDOW_MS && probe.size <= approval.size;
  });
  if (!covered) return false;
  return DOCUMENT_MIME.test(probe.type) || sniffedDocument || sniffsDocument(probe.head) || probe.size >= LARGE_BINARY_BYTES;
}

let uploadSequence = 0;

function beginApprovedUpload(body, sniffedDocument = false) {
  if (!approvedUpload(body, sniffedDocument)) return null;
  const uploadId = `upload_${Date.now()}_${uploadSequence += 1}`;
  announcePage(PAGE.uploadStarted, { uploadId });
  return uploadId;
}

function finishApprovedUpload(uploadId, ok) {
  if (uploadId) announcePage(PAGE.uploadFinished, { uploadId, ok: Boolean(ok) });
}

function fetchWithUploadTracking(receiver, input, init, body, sniffedDocument = false) {
  const uploadId = beginApprovedUpload(body, sniffedDocument);
  let request;
  try {
    request = originalFetch.call(receiver, input, init);
  } catch (error) {
    finishApprovedUpload(uploadId, false);
    throw error;
  }
  if (!uploadId) return request;
  return Promise.resolve(request).then(
    (response) => {
      finishApprovedUpload(uploadId, response?.ok !== false);
      return response;
    },
    (error) => {
      finishApprovedUpload(uploadId, false);
      throw error;
    }
  );
}

// Türsüz, küçük, adsız Blob eşzamanlı koklanamaz; fetch zaten söz döndürdüğü
// için ilk 8 baytı okuyup karar vermek mümkün. Yalnız zorlama açıkken ve
// karar gerçekten bu baytlara bağlıyken yapılır — geri kalan her istek
// eşzamanlı yoldan geçer. XHR eşzamanlıdır, orada koklama yoktur.
function needsAsyncSniff(body) {
  if (!(body instanceof Blob) || body instanceof File || body.type) return false;
  if (body.size < BINARY_BODY_FLOOR_BYTES || body.size >= LARGE_BINARY_BYTES) return false;
  const config = readJson(CONFIG_ATTRIBUTE);
  return Boolean(config?.active && config.blockUnscannable);
}

window.fetch = function guardedFetch(input, init) {
  const body = init?.body;
  if (needsAsyncSniff(body)) {
    return body.slice(0, 8).arrayBuffer().then((head) => {
      const sniffedDocument = sniffsDocument(new Uint8Array(head));
      const blocked = offender(body, sniffedDocument);
      if (blocked) {
        announce(blocked);
        throw new TypeError("Failed to fetch");
      }
      return fetchWithUploadTracking(window, input, init, body, sniffedDocument);
    });
  }
  // Gövde Request nesnesinin içindeyse eşzamanlı okunamaz; bu yol DOM
  // katmanındaki araya girmeye bırakılır (README'de açıkça yazılıdır).
  const blocked = offender(body);
  if (blocked) {
    announce(blocked);
    return Promise.reject(new TypeError("Failed to fetch"));
  }
  return fetchWithUploadTracking(this, input, init, body);
};

XMLHttpRequest.prototype.send = function guardedSend(body) {
  const blocked = offender(body);
  if (blocked) {
    announce(blocked);
    throw new DOMException("Redakt Guard: maskelenmemiş dosya gönderilemez.", "NetworkError");
  }
  const uploadId = beginApprovedUpload(body);
  const complete = () => finishApprovedUpload(uploadId, this.status >= 200 && this.status < 400);
  if (uploadId) this.addEventListener("loadend", complete, { once: true });
  try {
    return originalSend.call(this, body);
  } catch (error) {
    if (uploadId) this.removeEventListener("loadend", complete);
    finishApprovedUpload(uploadId, false);
    throw error;
  }
};
