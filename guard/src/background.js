// Service worker: offscreen motorun ömrünü yönetir, kurumsal kuralları tazeler,
// rozet sayacını tutar. Belge içeriği buradan hiç geçmez — içerik betiği
// offscreen belgeye doğrudan bağlanır.

import { fetchCorporateRules } from "../../src/rule-source.js";
import { AUDIT_ENDPOINT, AUDIT_QUEUE_KEY, normalizeAuditEvent } from "./audit.js";
import { ENGINE_PORT, ENGINE_RELAY_PORT, MSG } from "./protocol.js";
import { CRASH_KEY, DEVICE_KEY, TRACE_KEY, readRules, readSettings, writeRules, writeSettings } from "./settings.js";

const OFFSCREEN_PATH = "offscreen.html";
const RULES_ALARM = "guard/rules-refresh";
const RULES_PERIOD_MINUTES = 360;
const AUDIT_QUEUE_LIMIT = 500;
const AUDIT_MAX_AGE_MS = 30 * 86_400_000;
const AUDIT_TIMEOUT_MS = 15_000;

let creating = null;
let restarting = null;

async function offscreenExists() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen({ duringRestart = false } = {}) {
  // Yeniden kurulum başlamışsa eski belge hâlâ getContexts'te görünebilir.
  // Yeni istemciyi ona bağlamak yerine aynı yeniden kurulum sözünü beklet.
  if (!duringRestart && restarting) return restarting;
  // Sıra önemli: uçuşta bir oluşturma varken getContexts belgeyi "var" gösterir
  // ama modül henüz çalışmadığı için onConnect dinleyicisi kurulmamıştır; erken
  // "ok" dönmek portu anında kopartıyordu. Önce uçuştaki söz beklenir.
  if (creating) return creating;
  const exists = await offscreenExists();
  // getContexts beklenirken başka bir mesaj yeniden kurulumu başlatmış olabilir.
  if (!duringRestart && restarting) return restarting;
  if (creating) return creating;
  if (exists) return true;
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["WORKERS", "DOM_PARSER", "BLOBS"],
      justification:
        "Belge maskeleme motoru (yerel NER modeli, OCR ve Office ayrıştırma) kalıcı bir belgede çalışmalıdır.",
    })
    .then(() => true)
    .catch(async (error) => {
      // Yarış hâlinde ikinci çağrı hata verir; belge yine de ayaktadır.
      if (await offscreenExists()) return true;
      throw error;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

async function restartOffscreen() {
  if (restarting) return restarting;
  restarting = (async () => {
    // Sessizlik zaman aşımı da motor çökmesidir. Belgeyi istemci portu
    // kapandıktan sonra kapatırsak onDisconnect bunu göremeyebilir; işareti
    // burada açıkça koy ki yeni belge güvenli WASM yoluyla başlasın.
    await chrome.storage.session.set({ [CRASH_KEY]: true });
    if (creating) await creating.catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    creating = null;
    return ensureOffscreen({ duringRestart: true });
  })();
  try {
    return await restarting;
  } finally {
    restarting = null;
  }
}

async function refreshRules() {
  const settings = await readSettings();
  if (!settings.serverUrl) {
    return writeRules({
      rules: [],
      status: "unavailable",
      message: "Redakt sunucu adresi tanımlı değil. Kurumsal kurallar olmadan yalnızca desen katmanı çalışır.",
      fetchedAt: null,
    });
  }

  const base = `${settings.serverUrl}/`;
  const result = await fetchCorporateRules({
    // rule-source.js göreli "/api/rules" ister; sunucu kökünü burada bağlarız.
    // Ters proxy arkasındaki kimlik doğrulaması için çerezler taşınır.
    fetchImpl: (path, init) => fetch(new URL(path, base).href, { ...init, credentials: "include" }),
  });

  return writeRules({
    rules: result.rules || [],
    status: result.status,
    message: result.message || null,
    fetchedAt: result.fetchedAt || new Date().toISOString(),
  });
}

// Audit olayları PII içermez ama ağ kesintisinde kaybolmamalıdır. Tek zincir,
// eşzamanlı enqueue/flush çağrılarının storage.local içindeki kuyruğu ezmesini
// önler. Kuyruk yaş ve adet sınırıyla diski sınırsız büyütemez.
let auditWork = Promise.resolve();

function scheduleAudit(task) {
  const next = auditWork.then(task, task);
  auditWork = next.catch(() => {});
  return next;
}

async function readAuditQueue() {
  const stored = await chrome.storage.local.get(AUDIT_QUEUE_KEY);
  const cutoff = Date.now() - AUDIT_MAX_AGE_MS;
  const version = chrome.runtime.getManifest().version;
  const output = [];
  for (const raw of Array.isArray(stored?.[AUDIT_QUEUE_KEY]) ? stored[AUDIT_QUEUE_KEY] : []) {
    try {
      const event = normalizeAuditEvent(raw);
      if (Date.parse(event.createdAt) < cutoff) continue;
      output.push({ ...event, guardVersion: String(raw.guardVersion || version).slice(0, 32) });
    } catch {
      // Geçersiz/eski şema ağdan gönderilmez.
    }
  }
  return output.slice(-AUDIT_QUEUE_LIMIT);
}

async function writeAuditQueue(queue) {
  await chrome.storage.local.set({ [AUDIT_QUEUE_KEY]: queue.slice(-AUDIT_QUEUE_LIMIT) });
}

async function postAudit(serverUrl, event) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(AUDIT_ENDPOINT, `${serverUrl}/`).href, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Audit sunucusu HTTP ${response.status} döndürdü.`);
  } finally {
    clearTimeout(timer);
  }
}

async function flushAuditQueue() {
  const settings = await readSettings();
  const queue = await readAuditQueue();
  if (!settings.serverUrl || !queue.length) return { sent: 0, pending: queue.length };

  let sent = 0;
  while (queue.length) {
    try {
      await postAudit(settings.serverUrl, queue[0]);
    } catch (error) {
      mark("audit kuyruğu bekliyor", `${queue.length} kayıt · ${String(error?.message || error).slice(0, 100)}`);
      break;
    }
    queue.shift();
    sent += 1;
    // Başarılı POST'tan sonra hemen kalıcılaştır; service worker uyursa aynı
    // olay gereksiz yere tekrar gönderilmesin. eventId yine de dedupe anahtarıdır.
    await writeAuditQueue(queue);
  }
  return { sent, pending: queue.length };
}

function recordAudit(raw) {
  return scheduleAudit(async () => {
    const event = {
      ...normalizeAuditEvent(raw),
      guardVersion: chrome.runtime.getManifest().version,
    };
    const queue = await readAuditQueue();
    queue.push(event);
    await writeAuditQueue(queue);
    return { eventId: event.eventId, ...(await flushAuditQueue()) };
  });
}

function retryAudits() {
  return scheduleAudit(() => flushAuditQueue());
}

// Sayaç service worker belleğinde tutulamaz: SW 30 saniyede uykuya dalar ve
// rozet geriye düşer. storage.session tarayıcı oturumu boyunca yaşar, diske
// yazılmaz — sayfa başına kaç maskeleme yapıldığı diskte iz bırakmamalı.
const ACTIVITY_KEY = "guard.activity";

async function readActivity() {
  const stored = await chrome.storage.session.get(ACTIVITY_KEY);
  return stored?.[ACTIVITY_KEY] || {};
}

// Uzantı yüklenmeden önce açılmış sekmeye içerik betiği girmez ve hiçbir şey
// olmaz — ne panel, ne uyarı; dosya maskelenmeden gider. Sahada tam bu yaşandı.
// Rozet bu yüzden üç şeyden birini söyler: boş = bu sekmede Guard YOK (sekmeyi
// yenile), yeşil nokta = yüklü ve bekliyor, sayı = bu sekmede yapılan maskeleme.
const READY_KEY = "guard.ready";

async function readReady() {
  const stored = await chrome.storage.session.get(READY_KEY);
  return stored?.[READY_KEY] || {};
}

function paintBadge(tabId, count, ready = false) {
  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : ready ? "●" : "";
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: count > 0 ? "#1f6feb" : "#1a7f37" }).catch(() => {});
}

async function markReady(tabId) {
  if (typeof tabId !== "number") return;
  const [ready, activity] = await Promise.all([readReady(), readActivity()]);
  ready[tabId] = true;
  await chrome.storage.session.set({ [READY_KEY]: ready });
  paintBadge(tabId, activity[tabId] || 0, true);
}

async function recordActivity(tabId, amount) {
  if (typeof tabId !== "number" || amount <= 0) return;
  const activity = await readActivity();
  activity[tabId] = (activity[tabId] || 0) + amount;
  await chrome.storage.session.set({ [ACTIVITY_KEY]: activity });
  paintBadge(tabId, activity[tabId], true);
}

async function forgetActivity(tabId) {
  const ready = await readReady();
  if (tabId in ready) {
    delete ready[tabId];
    await chrome.storage.session.set({ [READY_KEY]: ready });
  }
  const activity = await readActivity();
  if (!(tabId in activity)) return;
  delete activity[tabId];
  await chrome.storage.session.set({ [ACTIVITY_KEY]: activity });
  paintBadge(tabId, 0);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetActivity(tabId).catch(() => {});
});
// "tabs" izni istememek için changeInfo.url okunmaz; yeniden yükleme sayacı sıfırlar.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  forgetActivity(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (!type || !Object.values(MSG).includes(type)) return false;

  (async () => {
    switch (type) {
      case MSG.ensureEngine:
        await ensureOffscreen();
        return { ok: true };
      case MSG.restartEngine:
        // Kilitlenmiş bir offscreen belge kendiliğinden kurtulmaz; sonraki
        // her tarama arkasında sıraya girip sonsuza kadar bekler. Tek çıkış
        // belgeyi kapatıp yeniden kurmaktır.
        await restartOffscreen();
        return { ok: true };
      case MSG.retryGpu:
        // Çökme işareti tek yönlüydü: bir kez düşünce oturum boyunca WASM'de
        // kalınıyor ve ayarlar bunu "WebGPU bulunamadı" sanıyordu. İşaretleri
        // silip belgeyi yeniden kur; ısınma GPU'yu yeniden dener.
        if (restarting) await restarting.catch(() => {});
        if (creating) await creating.catch(() => {});
        await chrome.offscreen.closeDocument().catch(() => {});
        await chrome.storage.session.remove([CRASH_KEY, DEVICE_KEY]);
        creating = null;
        await ensureOffscreen();
        return { ok: true };
      case MSG.readSettings:
        return { ok: true, settings: await readSettings() };
      case MSG.writeSettings:
        return { ok: true, settings: await writeSettings(message.patch || {}) };
      case MSG.mark:
        mark(String(message.step || "?"), message.detail);
        return { ok: true };
      case MSG.readTrace: {
        const stored = await chrome.storage.session.get(TRACE_KEY);
        return { ok: true, trace: stored?.[TRACE_KEY] || [] };
      }
      case MSG.readRules:
        return { ok: true, ...(await readRules()) };
      case MSG.readEngineState: {
        const stored = await chrome.storage.session.get([CRASH_KEY, DEVICE_KEY]);
        return {
          ok: true,
          crashed: Boolean(stored?.[CRASH_KEY]),
          device: stored?.[DEVICE_KEY] || null,
        };
      }
      case MSG.writeEngineDevice: {
        const known = new Set(["webgpu", "wasm", "cpu"]);
        const device = known.has(message.device) ? message.device : "bilinmiyor";
        await chrome.storage.session.set({ [DEVICE_KEY]: device });
        return { ok: true, device };
      }
      case MSG.auditMasking:
        return { ok: true, ...(await recordAudit(message.event)) };
      case MSG.refreshRules:
        return { ok: true, ...(await refreshRules()) };
      case MSG.contentReady:
        await markReady(sender?.tab?.id);
        return { ok: true };
      case MSG.activity:
        await recordActivity(sender?.tab?.id, Number(message.count) || 0);
        return { ok: true };
      default:
        return { ok: false };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));

  return true;
});

// storage.session varsayılan olarak yalnız güvenilir bağlamlara açıktır;
// içerik betiği okuyamaz. Çalışan donanımı ilerleme ekranında gösterebilmek
// için erişim açıkça genişletilir. Burada yalnız cihaz adı ve rozet sayacı
// durur — belge içeriği asla.
function openSessionStorageToContentScripts() {
  chrome.storage.session
    .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    .catch(() => {});
}

openSessionStorageToContentScripts();

// İçerik betiği ile offscreen belge arasındaki röle.
//
// İçerik betiğinin doğrudan offscreen belgeye chrome.runtime.connect ile
// bağlanabilmesi MV3'te garanti edilmez; service worker'a bağlanmak ise
// belgelenmiş yoldur. Bu yüzden her tarama buradan geçer: iki port açılır,
// mesajlar iki yönde aynen aktarılır. Belge içeriği burada yalnız transit
// hâlindedir — okunmaz, saklanmaz, hiçbir yere yazılmaz.
// Akışın nerede durduğunu konsol açmadan görebilmek için adım izi tutulur.
// İçerik yok, yalnız adım adı ve saat.
// İz bellekte değil depoda birikir: service worker her uyanışında bellek
// kopyası boş başlıyor ve depodakini eziyordu — sorun giderme yolu kendi
// kanıtını siliyordu. Tek zincir: oku-ekle-yaz sırayla.
const TRACE_LIMIT = 40;
let traceWork = Promise.resolve();
function mark(step, detail) {
  const entry = { step, detail: detail || null, at: new Date().toISOString() };
  traceWork = traceWork
    .then(async () => {
      const stored = (await chrome.storage.session.get(TRACE_KEY))?.[TRACE_KEY];
      const trace = Array.isArray(stored) ? stored : [];
      await chrome.storage.session.set({ [TRACE_KEY]: [...trace.slice(-(TRACE_LIMIT - 1)), entry] });
    })
    .catch(() => {});
}

chrome.runtime.onConnect.addListener((clientPort) => {
  if (clientPort.name !== ENGINE_PORT) return;
  mark("istemci portu geldi");

  let enginePort = null;
  const backlog = [];
  let closed = false;

  const shutdown = (reason) => {
    if (closed) return;
    closed = true;
    mark("röle kapandı", reason || null);
    try { enginePort?.disconnect(); } catch { /* zaten kapalı */ }
    try { clientPort.disconnect(); } catch { /* zaten kapalı */ }
  };

  clientPort.onMessage.addListener((message) => {
    if (enginePort) {
      try { enginePort.postMessage(message); } catch { shutdown(); }
    } else {
      // Offscreen belge hazır olana kadar gelenler sırada bekler; aksi hâlde
      // ilk parçalar sessizce düşerdi.
      backlog.push(message);
    }
  });
  clientPort.onDisconnect.addListener(() => shutdown("istemci ayrıldı"));

  ensureOffscreen()
    .then(() => {
      if (closed) return;
      mark("offscreen belge hazır");
      enginePort = chrome.runtime.connect({ name: ENGINE_RELAY_PORT });
      let firstReply = true;
      enginePort.onMessage.addListener((message) => {
        if (firstReply) {
          firstReply = false;
          mark("motordan ilk yanıt", message?.cmd || null);
        }
        try { clientPort.postMessage(message); } catch { shutdown("istemciye yazılamadı"); }
      });
      enginePort.onDisconnect.addListener(() => {
        // İstemci hâlâ oradayken motorun ayrılması = offscreen belge öldü.
        // Bir dahaki denemede GPU atlanır; çökmenin en olası sebebi orası.
        if (!closed) {
          mark("motor çöktü", "sonraki tarama güvenli yoldan denenecek");
          chrome.storage.session.set({ [CRASH_KEY]: true }).catch(() => {});
        }
        shutdown("motor ayrıldı (offscreen dinlemiyor olabilir)");
      });
      mark("röle bağlandı", `${backlog.length} bekleyen mesaj`);
      for (const message of backlog.splice(0)) enginePort.postMessage(message);
    })
    .catch((error) => {
      mark("offscreen kurulamadı", String(error?.message || error).slice(0, 160));
      shutdown("offscreen kurulamadı");
    });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RULES_ALARM) {
    refreshRules().catch(() => {});
    retryAudits().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  refreshRules().catch(() => {});
  retryAudits().catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(RULES_ALARM, { periodInMinutes: RULES_PERIOD_MINUTES });
  const settings = await readSettings();
  await refreshRules().catch(() => {});
  await retryAudits().catch(() => {});
  if (!settings.serverUrl) chrome.runtime.openOptionsPage();
});
