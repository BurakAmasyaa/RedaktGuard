// Kullanıcıya gösterilen tek yüzey. Kapalı shadow root kullanır: sayfa ne
// panelin içeriğini okuyabilir ne de stilini bozabilir.

import { PANEL_CSS } from "./panel-styles.js";

// Motorun aşama adları kullanıcı diline çevrilir. Aşamayı söylemek,
// yüzdeden daha çok işe yarar: hangi adımın uzun sürdüğü görünür.
const PHASE_LABELS = {
  connecting: "Tarama motoru hazırlanıyor",
  queued: "Diğer sekmedeki tarama bekleniyor",
  transferring: "Dosya motora aktarılıyor",
  model: "Yerel model hazırlanıyor",
  extracting: "Belge açılıyor",
  ocr: "Görseller okunuyor (OCR)",
  rules: "Kurumsal kurallar karşılaştırılıyor",
  detecting: "Kişi ve kurum adları aranıyor",
  redacting: "Maskelenmiş kopya hazırlanıyor",
};

function humanSeconds(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} sn`;
  return `${Math.round(seconds / 60)} dk`;
}

// Kalan süre yalnız aşamanın kendi gözlenen hızından tahmin edilir. İlk
// yüzdede tahmin çok oynak olduğu için %5'in altında hiçbir şey söylenmez —
// yanlış bir "2 dk kaldı" güveni bitirir.
function remainingLabel(nodes, ratio) {
  if (!ratio || ratio < 0.05 || ratio >= 1) return null;
  const elapsed = performance.now() - nodes.phaseStartedAt;
  if (elapsed < 1200) return null;
  return `yaklaşık ${humanSeconds((elapsed / ratio) * (1 - ratio))} kaldı`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Hangi yapının çalıştığı takılma anında okunabilmeli; "son sürümde miyim"
// sorusu konsol açmadan cevaplanmalı.
const BUILD = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "?";
  }
})();

export class GuardPanel {
  constructor(siteLabel) {
    this.siteLabel = siteLabel;
    this.host = document.createElement("redakt-guard");
    this.host.setAttribute("role", "presentation");
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    this.root.append(style);

    this.backdrop = element("div", "backdrop");
    this.card = element("div", "card");
    this.backdrop.append(this.card);
    this.root.append(this.backdrop);

    // Sayfanın kısayolları ve genel dinleyicileri panele karışmasın.
    for (const type of ["keydown", "keyup", "keypress", "click", "pointerdown", "wheel"]) {
      this.host.addEventListener(type, (event) => event.stopPropagation());
    }
    this.onEscape = null;
    this.host.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.onEscape?.();
    });
  }

  mount() {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  destroy() {
    this.host.remove();
  }

  #header(subtitle) {
    const header = element("header");
    header.append(element("div", "mark", "R"));
    const title = element("div", "title");
    title.append(element("strong", null, `Redakt Guard ${BUILD}`));
    title.append(element("span", null, subtitle));
    header.append(title);
    return header;
  }

  #reset() {
    this.card.replaceChildren();
    this.onEscape = null;
  }

  showScanning({ filename, index = 0, total = 1, device = null, onCancel }) {
    this.mount();
    this.#reset();
    this.card.append(this.#header(`${this.siteLabel} · gönderim durduruldu`));

    const scan = element("div", "scan");
    scan.append(element("div", "file", filename));
    // Ne yapıldığı: aşamanın adı. Boş bir "taranıyor" satırı 30 saniye boyunca
    // hiçbir şey söylemiyor, kullanıcı takıldığını sanıyor.
    const stage = element("p", "stage", "Hazırlanıyor…");
    scan.append(stage);
    const bar = element("div", "bar indeterminate");
    const fill = element("i");
    bar.append(fill);
    scan.append(bar);
    // Ne kadar kaldı ve hangi donanımda: yavaşlık kendini açıklasın.
    const meta = element("p", "meta", "");
    scan.append(meta);
    scan.append(element("p", "quiet", "İçeriği hiçbir yere gönderilmedi."));
    if (total > 1) scan.append(element("p", "quiet", `Dosya ${index + 1} / ${total}`));
    this.card.append(scan);

    const footer = element("footer");
    footer.append(element("span", "spacer"));
    const cancel = element("button", null, "Vazgeç");
    cancel.addEventListener("click", () => onCancel?.());
    footer.append(cancel);
    this.card.append(footer);

    this.onEscape = () => onCancel?.();
    this.progressNodes = { bar, fill, stage, meta, device, phase: null, phaseStartedAt: performance.now() };
  }

  setProgress({ phase, current, total, detail }) {
    const nodes = this.progressNodes;
    if (!nodes) return;

    // Aşama değiştiğinde kalan süre tahmini sıfırlanır; farklı aşamaların
    // hızları birbirinden bağımsızdır.
    if (phase && phase !== nodes.phase) {
      nodes.phase = phase;
      nodes.phaseStartedAt = performance.now();
    }

    const label = PHASE_LABELS[nodes.phase] || "Taranıyor";
    const measurable = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    const ratio = measurable ? Math.min(1, Math.max(0, current / total)) : 0;

    nodes.stage.textContent = measurable ? `${label} · %${Math.round(ratio * 100)}` : `${label}…`;

    if (measurable) {
      nodes.bar.classList.remove("indeterminate");
      nodes.fill.style.width = `${Math.round(ratio * 100)}%`;
    } else {
      nodes.bar.classList.add("indeterminate");
    }

    const parts = [];
    const remaining = remainingLabel(nodes, ratio);
    if (remaining) parts.push(remaining);
    if (detail) parts.push(detail);
    if (nodes.device) parts.push(nodes.device === "webgpu" ? "WebGPU" : `${nodes.device} · yavaş yol`);
    nodes.meta.textContent = parts.join(" · ");
  }

}

let activeToast = null;

// Panelsiz bilgi. Başarı mesajları okunabilsin diye 10 saniye kalır; hata ve
// engelleme mesajları kullanıcı kapatana kadar görünür. Yeni mesaj eskisinin
// üzerine binmez, onun yerini alır.
export function toast(message) {
  activeToast?.remove();
  const host = document.createElement("redakt-guard-toast");
  activeToast = host;
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; position: fixed; inset: auto 16px 16px auto; z-index: 2147483647; }
    div {
      display: flex; gap: 8px; align-items: center;
      padding: 10px 14px;
      font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      color: #fafaf7; background: #16161a;
      border: 1px solid #2f2f36; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.3);
      opacity: 0; transform: translateY(6px);
      transition: opacity 180ms ease, transform 180ms ease;
      max-width: min(680px, calc(100vw - 56px));
    }
    div.in { opacity: 1; transform: none; }
    b { display: grid; place-items: center; width: 20px; height: 20px; font-size: 11px; color: #fff; background: #c81e1e; border-radius: 6px; }
    span { flex: 1; }
    button { all: unset; cursor: pointer; padding: 3px 6px; color: #b8b8bf; font: 600 16px/1 Arial, sans-serif; border-radius: 5px; }
    button:hover, button:focus-visible { color: #fff; background: #2f2f36; outline: none; }
  `;
  const box = document.createElement("div");
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");
  const mark = document.createElement("b");
  mark.textContent = "R";
  const text = document.createElement("span");
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Bildirimi kapat");
  close.textContent = "×";
  box.append(mark, text, close);
  root.append(style, box);
  document.documentElement.append(host);
  requestAnimationFrame(() => box.classList.add("in"));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (activeToast === host) activeToast = null;
    box.classList.remove("in");
    setTimeout(() => host.remove(), 220);
  };
  close.addEventListener("click", dismiss);

  const persistent = /hata|durdur|engell|ulaşılam|kaybol|eklenemedi|başlatılam|yenile|koptu|taranamadı|yüklenemedi/iu.test(message);
  if (!persistent) setTimeout(dismiss, 10000);
}
