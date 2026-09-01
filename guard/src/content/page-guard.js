// Sayfa dünyasında çalışan son emniyet. DOM'da araya girme başarısız olursa
// (arayüz değişti, bilmediğimiz bir yükleme yolu var) taranabilir bir dosya
// yine de ağa çıkamaz.
//
// Politika ve onaylar iki dünyanın ortak DOM'undan eşzamanlı okunur; kuyruğa
// alınmış bir mesajı beklemek, sayfanın hemen başlattığı yüklemeye yetişemezdi.
//
// Not: sayfa özgün dosyayı hiçbir zaman eline geçirmediği için bu kanalın
// taklit edilmesi saldırgana bir şey kazandırmaz; kanal gizli değildir.

import { APPROVED_ATTRIBUTE, CONFIG_ATTRIBUTE, GUARD_MARK, PAGE } from "../protocol.js";

const originalFetch = window.fetch;
const originalSend = XMLHttpRequest.prototype.send;

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
