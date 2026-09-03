// Prompt kutusunun bulunması, okunması ve yerine yazılması.
//
// Üç arayüz üç farklı düzenleyici kullanıyor (ProseMirror, Lexical, Quill) ve
// hiçbiri değeri doğrudan atamayı kabul etmiyor: React/ProseMirror kendi
// durumunu tutar, DOM'a yazmak sessizce geri alınır. Tek güvenilir yol
// execCommand("insertText") — beforeinput/input olaylarını gerçek yazma gibi
// üretir, üç düzenleyici de bunu kendi durumuna işler.

const SITES = [
  {
    match: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/u,
    editor: "#prompt-textarea, div.ProseMirror[contenteditable='true']",
    send: "#composer-submit-button, button[data-testid='send-button']",
  },
  {
    match: /(^|\.)claude\.(ai|com)$/u,
    editor: "div.ProseMirror[contenteditable='true']",
    send: "button[aria-label*='Send'], button[aria-label*='send']",
  },
  {
    match: /(^|\.)gemini\.google\.com$/u,
    editor: "div.ql-editor[contenteditable='true'], rich-textarea div[contenteditable='true']",
    send: "button.send-button, button[aria-label*='Send'], button[aria-label*='Gönder']",
  },
  {
    match: /(^|\.)copilot\.microsoft\.com$/u,
    editor: "textarea#userInput, div[contenteditable='true']",
    send: "button[title*='Submit'], button[aria-label*='Submit'], button[data-testid='submit-button']",
  },
];

function siteConfig() {
  return SITES.find((site) => site.match.test(location.hostname)) || null;
}

function isEditable(node) {
  if (!(node instanceof HTMLElement)) return false;
  if (node instanceof HTMLTextAreaElement) return true;
  return node.isContentEditable;
}

function usable(node) {
  return node instanceof HTMLElement && !node.disabled && node.getClientRects().length > 0;
}

// Olay hedefinden YUKARI çıkarak prompt kutusunu bulur ve bulamazsa null döner.
// Belge geneline düşmek tehlikeli: kenar çubuğundaki arama kutusunda basılan
// Enter da prompt gönderimi sanılır ve sayfanın kendi davranışı kesilirdi.
export function findComposer(target) {
  const config = siteConfig();
  let node = target instanceof Node ? target : null;
  if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;

  while (node instanceof HTMLElement) {
    if (config && node.matches?.(config.editor)) return node;
    if (isEditable(node)) return node;
    node = node.parentElement;
  }
  return null;
}

// Gönder düğmesine tıklandığında kutuyu bulur. Düğme siteye özgü seçiciyle
// eşleştiği için önce kendi formu/kapsayıcısı, sonra sayfadaki prompt kutusu
// denenir — bu düğme başka bir formun submit'i olamaz.
export function composerForSend(button) {
  const config = siteConfig();
  if (!config || !(button instanceof HTMLElement)) return null;
  const scope = button.closest("form") || button.parentElement?.parentElement;
  const scoped = scope?.querySelector?.(config.editor);
  if (scoped instanceof HTMLElement) return scoped;
  const global = document.querySelector(config.editor);
  return global instanceof HTMLElement ? global : null;
}

export function readComposerText(composer) {
  if (composer instanceof HTMLTextAreaElement) return composer.value;
  // innerText satır sonlarını görsel düzene göre üretir; ProseMirror'da
  // paragraflar arası boşluk bu şekilde korunur.
  return composer instanceof HTMLElement ? composer.innerText : "";
}

// Satır satır yazar. Tek parça insertText, metindeki her "\n" için Blink'te
// PARAGRAF AYIRICI üretiyor; iki satırlık bir prompt üç paragrafa dönüşüyordu.
function typeText(text) {
  const parts = String(text).split("\n");
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0 && !document.execCommand("insertLineBreak")) return false;
    if (parts[index] && !document.execCommand("insertText", false, parts[index])) return false;
  }
  return true;
}

// Metni yerine yazar. Yalnızca yazma komutunun uygulanıp uygulanmadığını
// bildirir — "yazdığımı geri okuyunca aynı mı" karşılaştırması YANLIŞ bir
// değişmezdir: innerText <p> sınırını iki, <br>'ı bir satır sonu sayar, bu
// yüzden çok satırlı hiçbir metin round-trip'ten eşit çıkmaz. Asıl güvenlik
// koşulu ("seçilen değerler artık kutuda yok") çağıran tarafta, düzenleyici
// DOM'u uzlaştırdıktan sonra denetlenir.
export function replaceComposerText(composer, text) {
  if (composer instanceof HTMLTextAreaElement) {
    // React kendi value izleyicisini tuttuğu için doğrudan atama yutulur;
    // prototip setter'ı üzerinden yazıp input olayı üretmek gerekir.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(composer, text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return composer.value === text;
  }

  if (!(composer instanceof HTMLElement) || !composer.isContentEditable) return false;

  composer.focus();
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection.removeAllRanges();
  selection.addRange(range);
  return typeText(text);
}

// Panel odağı çaldığı için imleç konumu önceden saklanmalı; yapıştırma
// metnin tamamını değil, imlecin bulunduğu yeri değiştirir.
export function saveCaret(composer) {
  if (composer instanceof HTMLTextAreaElement) {
    return { kind: "textarea", start: composer.selectionStart, end: composer.selectionEnd };
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  return { kind: "range", range: selection.getRangeAt(0).cloneRange() };
}

function restoreCaret(composer, caret) {
  composer.focus();
  if (!caret) return;
  if (caret.kind === "textarea" && composer instanceof HTMLTextAreaElement) {
    composer.setSelectionRange(caret.start, caret.end);
    return;
  }
  if (caret.kind !== "range") return;
  const selection = window.getSelection();
  if (!selection) return;
  try {
    selection.removeAllRanges();
    selection.addRange(caret.range);
  } catch {
    // Aralık geçersizleştiyse imleç kutunun sonunda kalır; metin yine girer.
  }
}

export function insertAtCaret(composer, text, caret) {
  if (!(composer instanceof HTMLElement)) return false;
  restoreCaret(composer, caret);

  if (composer instanceof HTMLTextAreaElement) {
    const start = composer.selectionStart ?? composer.value.length;
    const end = composer.selectionEnd ?? start;
    const next = composer.value.slice(0, start) + text + composer.value.slice(end);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(composer, next);
    composer.setSelectionRange(start + text.length, start + text.length);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  return typeText(text);
}

// Tıklamanın gönder düğmesine mi geldiğini söyler. Yalnızca siteye özgü
// seçiciler kullanılır: genel bir "button[type=submit]" yedeği sayfadaki her
// formu prompt gönderimi sanardı.
export function isSendControl(path) {
  const config = siteConfig();
  if (!config) return null;
  for (const node of path) {
    if (node instanceof HTMLElement && node.matches?.(config.send)) return node;
  }
  return null;
}

export function findSendButton(composer) {
  const config = siteConfig();
  if (!config) return null;
  const scope = composer?.closest("form") || composer?.parentElement?.parentElement;
  const scoped = scope?.querySelector?.(config.send);
  if (usable(scoped)) return scoped;
  const global = document.querySelector(config.send);
  return usable(global) ? global : null;
}

export function composerSelectors() {
  const config = siteConfig();
  return { editor: config?.editor || null, send: config?.send || null };
}
