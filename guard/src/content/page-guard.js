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

// Engellenmesi gereken ilk dosyanın adını döndürür, yoksa null.
// Gövdede dosya yoksa tek bir instanceof kontrolüyle çıkar: bu yol her
// fetch çağrısında işlediği için ucuz kalmalı.
function offender(body) {
  const files = filesIn(body);
  if (!files.length) return null;

  const config = readJson(CONFIG_ATTRIBUTE);
  if (!config?.active) return null;
  const extensions = Array.isArray(config.extensions) ? config.extensions : [];
  const approved = new Set(readJson(APPROVED_ATTRIBUTE) || []);

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

function announce(filename) {
  window.postMessage({ __redaktGuard: GUARD_MARK, type: PAGE.blocked, filename }, location.origin);
}

window.fetch = function guardedFetch(input, init) {
  // Gövde Request nesnesinin içindeyse eşzamanlı okunamaz; bu yol DOM
  // katmanındaki araya girmeye bırakılır (README'de açıkça yazılıdır).
  const blocked = offender(init?.body);
  if (blocked) {
    announce(blocked);
    return Promise.reject(new TypeError("Failed to fetch"));
  }
  return originalFetch.call(this, input, init);
};

XMLHttpRequest.prototype.send = function guardedSend(body) {
  const blocked = offender(body);
  if (blocked) {
    announce(blocked);
    throw new DOMException("Redakt Guard: maskelenmemiş dosya gönderilemez.", "NetworkError");
  }
  return originalSend.call(this, body);
};
