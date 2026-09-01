// Motorun çalıştığı kalıcı bağlam. Service worker 30 saniyede uykuya daldığı,
// içinde iç içe Worker açamadığı ve 147 MB'lık modeli bellekte tutamadığı için
// tarama buradan yürür. İçerik betiği bu belgeye doğrudan bağlanır.

import { CMD, ENGINE_RELAY_PORT, MSG } from "./protocol.js";
import { bytesToBase64, base64ToBytes, chunkBytes, chunkCount, joinChunks } from "./transfer.js";
import { maskDocument, maskTextUnit, release, scanDocument, scanTextUnit, warmUpEngine } from "./engine.js";

const inbox = new Map();
// Isınma, ilk gerçek taramayla üst üste gelebilir. Isınmanın model indirme
// ilerlemesini aktif oturumlara iletmek hem kullanıcıya gerçek durumu gösterir
// hem de sağlıklı ama uzun süren hazırlığın sessizlik sanılmasını önler.
const relaySessions = new Map();

// Motor tarafının izi. İki taraf da aynı listeyi oku-değiştir-yaz yapınca
// birbirini eziyordu; artık tek yazıcı var: işaretler background'a bildirilir.
// İçerik veya bulgu yazılmaz, yalnız adım adı.
function mark(step, detail) {
  chrome.runtime
    .sendMessage({ type: MSG.mark, step: `motor: ${step}`, detail: detail || null })
    .catch(() => {});
}

mark("offscreen belge yüklendi");

function abortReason() {
  return new DOMException("İşlem iptal edildi.", "AbortError");
}

function send(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    // Sekme kapandıysa port ölür; taramanın kalanı release ile toplanır.
  }
}

// Chrome offscreen belgelerinde chrome.runtime dışındaki uzantı API'leri
// sunulmaz. Ayarlar, kurallar ve oturum durumu bu yüzden storage'a doğrudan
// dokunmadan service worker üzerinden okunup yazılır.
async function request(type, fallbackMessage, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.message || fallbackMessage);
  return response;
}

async function readScanConfiguration() {
  const [settingsResponse, ruleCache] = await Promise.all([
    request(MSG.readSettings, "Guard ayarları okunamadı."),
    request(MSG.readRules, "Kurumsal kurallar okunamadı."),
  ]);
  if (!settingsResponse.settings) throw new Error("Guard ayarları eksik döndü.");
  return { settings: settingsResponse.settings, ruleCache };
}

async function runScan(port, id) {
  const entry = inbox.get(id);
  if (!entry) {
    // Sessizce dönmek çağıranı sonsuza kadar bekletiyordu.
    send(port, { cmd: CMD.failure, id, message: "Tarama oturumu motorda bulunamadı; dosyayı yeniden bırakın." });
    return;
  }

  try {
    // Mesaj/storage hataları da failure olarak dönmeli. Bu okumalar try dışında
    // kalırsa motor sessizleşir ve kullanıcı yalnız 45 sn sonra watchdog görür.
    const { settings, ruleCache } = await readScanConfiguration();
    const bytes = joinChunks(entry.parts);
    entry.parts = [];

    if (bytes.length !== entry.size) {
      send(port, { cmd: CMD.failure, id, message: "Dosya eksik aktarıldı; yeniden deneyin." });
      inbox.delete(id);
      return;
    }

    const result = await scanDocument({
      id,
      bytes,
      filename: entry.filename,
      profile: settings.profile,
      rules: ruleCache.rules,
      signal: entry.controller.signal,
      onProgress: (progress) => send(port, { cmd: CMD.progress, id, ...progress }),
    });
    // Kural sunucusu isteğe bağlı bir ek katmandır. Hiç yapılandırılmadıysa
    // yerel desen, alan etiketi, NER ve OCR hattı normal çalışır. Bir adres
    // özellikle yapılandırılmışsa erişim/bayatlık sessiz bir koruma düşüşüne
    // dönüşemez; enforcement uyarıyla gönderimi fail-closed durdurur.
    if (settings.serverUrl && ruleCache.status !== "ready") {
      result.warnings.push({
        title: "Kurumsal kural listesi güncel değil.",
        detail: ruleCache.message || "Redakt sunucusu yapılandırılmadı veya kurallara ulaşılamadı.",
      });
    }
    send(port, { cmd: CMD.scanResult, id, ...result });
  } catch (error) {
    if (error?.name !== "AbortError") {
      send(port, {
        cmd: CMD.failure,
        id,
        message: error instanceof Error ? error.message : "Dosya taranamadı.",
      });
    }
    release(id);
  }
}

async function runMask(port, id, selectedIds) {
  const entry = inbox.get(id);
  try {
    const result = await maskDocument({
      id,
      selectedIds,
      signal: entry?.controller.signal,
      onProgress: (progress) => send(port, { cmd: CMD.progress, id, ...progress }),
    });

    // Yalnızca dosya adı maskelendiyse belge yeniden kodlanmaz; içerik betiği
    // özgün dosyayı yeni adla sarar.
    send(port, {
      cmd: CMD.maskBegin,
      id,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.bytes ? result.bytes.length : 0,
      chunks: result.bytes ? chunkCount(result.bytes.length) : 0,
      documentChanged: result.documentChanged,
      audit: result.audit,
    });
    if (result.bytes) {
      let seq = 0;
      for (const part of chunkBytes(result.bytes)) {
        send(port, { cmd: CMD.maskChunk, id, seq, data: bytesToBase64(part) });
        seq += 1;
      }
    }
    send(port, { cmd: CMD.maskEnd, id });
  } catch (error) {
    if (error?.name !== "AbortError") {
      send(port, {
        cmd: CMD.failure,
        id,
        message: error instanceof Error ? error.message : "Maskelenmiş kopya hazırlanamadı.",
      });
    }
  }
}

async function runTextScan(port, id, text, useModel) {
  const controller = new AbortController();
  inbox.set(id, { filename: "prompt", size: 0, parts: [], controller });
  try {
    const { settings, ruleCache } = await readScanConfiguration();
    const result = await scanTextUnit({
      id,
      text,
      profile: settings.profile,
      rules: ruleCache.rules,
      useModel: Boolean(useModel),
      signal: controller.signal,
      onProgress: (progress) => send(port, { cmd: CMD.progress, id, ...progress }),
    });
    send(port, { cmd: CMD.scanResult, id, ...result });
  } catch (error) {
    if (error?.name !== "AbortError") {
      send(port, { cmd: CMD.failure, id, message: error instanceof Error ? error.message : "Metin taranamadı." });
    }
    release(id);
  }
}

function runTextMask(port, id, selectedIds) {
  try {
    send(port, { cmd: CMD.maskTextResult, id, ...maskTextUnit({ id, selectedIds }) });
  } catch (error) {
    send(port, { cmd: CMD.failure, id, message: error instanceof Error ? error.message : "Metin maskelenemedi." });
  }
}

function dropSession(id) {
  const entry = inbox.get(id);
  if (entry) {
    entry.controller.abort(abortReason());
    inbox.delete(id);
  }
  release(id);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ENGINE_RELAY_PORT) return;
  mark("röle portu karşılandı");
  const owned = new Set();
  relaySessions.set(port, owned);

  port.onMessage.addListener((message) => {
    const id = message?.id;
    switch (message?.cmd) {
      case CMD.scanBegin:
        owned.add(id);
        inbox.set(id, {
          filename: String(message.filename || "belge"),
          size: Number(message.size) || 0,
          parts: [],
          controller: new AbortController(),
        });
        break;
      case CMD.scanChunk: {
        const entry = inbox.get(id);
        if (entry) entry.parts.push({ seq: Number(message.seq) || 0, bytes: base64ToBytes(message.data) });
        break;
      }
      case CMD.scanEnd:
        mark("scanEnd alındı, tarama başlıyor");
        runScan(port, id);
        break;
      case CMD.scanText:
        owned.add(id);
        runTextScan(port, id, String(message.text || ""), message.useModel);
        break;
      case CMD.maskText:
        runTextMask(port, id, Array.isArray(message.selectedIds) ? message.selectedIds : []);
        break;
      case CMD.mask:
        runMask(port, id, Array.isArray(message.selectedIds) ? message.selectedIds : []);
        break;
      case CMD.release:
        owned.delete(id);
        dropSession(id);
        break;
      default:
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    for (const id of owned) dropSession(id);
    owned.clear();
    relaySessions.delete(port);
  });

  send(port, { cmd: CMD.ready });
});

// Belge oluşturulur oluşturulmaz model hazırlanır. İçerik betiği korunan bir
// sayfa açıldığında bu belgeyi kurdurur, böylece ilk sürüklemede oturum kurma
// bedeli (WebGPU'da ~0,8 sn, WASM'de ~1,7 sn) ödenmez.
// Çalışan cihaz ayarlar sayfasında gösterilir: WebGPU sessizce WASM'e
// düşerse (12 kat yavaş) bunun görünmesi gerekir.
// Önceki oturum tarama ortasında çöktüyse GPU atlanır. Yavaş ama çalışan yol,
// hiç çalışmayana yeğdir; kullanıcı ayarlar sayfasında hangisinde olduğunu görür.
request(MSG.readEngineState, "Motor durumu okunamadı.")
  .then((state) => Boolean(state.crashed))
  .catch((error) => {
    // Durum okunamıyorsa hız yerine güvenilir yolu seç; hatayı izde görünür tut.
    mark("motor durumu okunamadı", String(error?.message || error).slice(0, 160));
    return true;
  })
  .then((safeMode) => {
    mark("ısınma başlıyor", safeMode ? "güvenli yol (wasm)" : "normal");
    return warmUpEngine(safeMode ? "wasm" : null, (progress) => {
      for (const [port, owned] of relaySessions) {
        for (const id of owned) send(port, { ...progress, cmd: CMD.progress, id });
      }
    }).then(
      (device) => {
        mark("ısınma bitti", device || "bilinmiyor");
        request(MSG.writeEngineDevice, "Çalışan motor kaydedilemedi.", { device: device || "bilinmiyor" }).catch(
          (error) => mark("çalışan motor kaydedilemedi", String(error?.message || error).slice(0, 160))
        );
      },
      (error) => mark("ısınma başarısız", String(error?.message || error).slice(0, 160))
    );
  });
