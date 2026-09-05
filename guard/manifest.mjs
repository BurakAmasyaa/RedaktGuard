// Manifest tek yerden üretilir: korunan adresler hosts.js'ten gelir,
// sürüm package.json'dan. İkinci bir kopya tutulmaz.

import { GUARDED_MATCHES } from "./src/hosts.js";

export function icons() {
  return { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" };
}

export function guardManifest(version, matches = [...GUARDED_MATCHES]) {
  return {
    manifest_version: 3,
    name: "Redakt Guard",
    version,
    description:
      "Yapay zekâ araçlarına yüklenen belgeleri cihaz üzerinde tarar, hassas bilgileri maskeler ve ancak öyle gönderir.",
    // PDF.js 6 legacy'nin desteklediği Chromium alt sınırı (Chrome/Edge).
    minimum_chrome_version: "125",
    background: { service_worker: "background.js", type: "module" },
    // Geniş host izni istenmez: kural sunucusuna erişim ayarlar sayfasından,
    // kullanıcının onayıyla tek adres için alınır.
    permissions: ["storage", "offscreen", "alarms"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_scripts: [
      // Sayfa dünyasındaki emniyet önce yüklenir: fetch/XHR yamaları sayfanın
      // kendi betiklerinden önce yerine oturmalı.
      {
        matches,
        js: ["content/page-guard.js"],
        run_at: "document_start",
        world: "MAIN",
        all_frames: false,
      },
      {
        matches,
        js: ["content/interceptor.js"],
        run_at: "document_start",
        world: "ISOLATED",
        all_frames: false,
      },
    ],
    action: { default_title: "Redakt Guard", default_icon: icons() },
    icons: icons(),
    options_page: "options/options.html",
    content_security_policy: {
      // ONNX ve Tesseract WebAssembly derler; uzantı sayfalarında izin verilir.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // Offscreen belgeyi çapraz kaynak yalıtımlı yapar: SharedArrayBuffer açılır,
    // WebGPU bulunmayan makinelerde ONNX'in WASM yolu çok çekirdek kullanır.
    // Uzantının bütün varlıkları kendi kaynağından geldiği için bir şey kırılmaz.
    cross_origin_embedder_policy: { value: "require-corp" },
    cross_origin_opener_policy: { value: "same-origin" },
  };
}
