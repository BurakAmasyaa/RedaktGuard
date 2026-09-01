// Yalıtılmış dünyada çalışan asıl araya girme katmanı.
// document_start'ta yüklendiği için yakalama fazındaki dinleyicileri sayfanın
// kendi betiklerinden önce kaydeder; bu yüzden dosya, uygulamanın JavaScript'ine
// hiç ulaşmadan durdurulabilir.

import { createAuditEvent, summarizeSelectedFindings } from "../audit.js";
import { decideScannedFiles, decideScannedPrompt } from "../enforcement.js";
import { siteIdFor, siteLabelFor } from "../hosts.js";
import {
  APPROVED_ATTRIBUTE,
  CMD,
  CONFIG_ATTRIBUTE,
  DROP_CLEANUP_EVENT,
  DROP_DELIVERY_ACK_ATTRIBUTE,
  DROP_DELIVERY_ACTIVE_ATTRIBUTE,
  DROP_DELIVERY_EVENT,
  DROP_DELIVERY_POINT_ATTRIBUTE,
  DROP_DELIVERY_TARGET_ATTRIBUTE,
  DROP_DELIVERY_TOKEN_ATTRIBUTE,
  ENGINE_PORT,
  ENGINE_SILENCE_TIMEOUT_MS,
  FILE_DELIVERY_ACK_ATTRIBUTE,
  FILE_DELIVERY_EVENT,
  FILE_DELIVERY_TOKEN_ATTRIBUTE,
  GUARD_MARK,
  MAX_SCANNABLE_BYTES,
  MSG,
  PAGE,
  SCANNABLE_EXTENSIONS,
  extensionOf,
  fileKey,
  isScannable,
} from "../protocol.js";
import { DEFAULT_SETTINGS, DEVICE_KEY, RULES_KEY, onSettingsChanged, readRules, readSettings } from "../settings.js";
import { connectRuntime, sendRuntimeMessage, sendRuntimeMessageBestEffort } from "../runtime.js";
import { base64ToBytes, bytesToBase64, chunkBytes, chunkCount, joinChunks } from "../transfer.js";
import {
  composerForSend,
  findComposer,
  findSendButton,
  insertAtCaret,
  isSendControl,
  readComposerText,
  replaceComposerText,
  saveCaret,
} from "./composer.js";
import { GuardPanel, toast } from "./panel.js";
import { SYNC_SCAN_LIMIT, maskPromptText, primeRules, scanPromptText } from "./text-engine.js";

const SITE = siteLabelFor(location.hostname);
const SITE_ID = siteIdFor(location.hostname);
const synthetic = new WeakSet();
// MAIN-world rölenin ürettiği input/change olayları tekrar taranmamalı.
// Sayaç kullanılır çünkü tek teslimde iki ayrı olay gelir.
const replayingFileInputs = new WeakMap();

let settings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
// Tek bir bayrak yetmiyor: terk edilmiş bir akışın finally'si, kendisinden
// sonra başlamış akışın kilidini siliyordu. Jeton sahipliği bunu engeller.
let activeFlow = null;

readSettings()
  .then((loaded) => {
    settings = loaded;
    settingsReady = true;
    configurePageGuard();
  })
  .catch(() => {
    settingsReady = true;
  });

onSettingsChanged((next) => {
  settings = next;
  configurePageGuard();
});

// Prompt taraması eşzamanlı çalıştığı için kurallar önceden hazır olmalı.
let corporateRules = [];
let rulesStatus = "loading";
readRules()
  .then((cache) => {
    corporateRules = cache.rules || [];
    rulesStatus = cache.status;
    primeRules(corporateRules);
  })
  .catch(() => {
    rulesStatus = "unavailable";
  });

// Motorun hangi donanımda koştuğu ilerleme ekranında gösterilir: WASM'e
// düşülmüşse tarama 12 kat yavaşlar ve kullanıcı bunu "takıldı" sanmamalı.
let engineDevice = null;
chrome.storage.session
  .get(DEVICE_KEY)
  .then((stored) => {
    engineDevice = stored?.[DEVICE_KEY] || null;
  })
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[DEVICE_KEY]) engineDevice = changes[DEVICE_KEY].newValue || null;
  if (area !== "local" || !changes[RULES_KEY]) return;
  const next = changes[RULES_KEY].newValue;
  corporateRules = next?.rules || [];
  rulesStatus = next?.status || "unavailable";
  primeRules(corporateRules);
});

// Sayfa dünyasına geçen tek şey budur: politika ve "şu ad/boyuttaki dosya
// onaylandı" anahtarları. Bulgu değerleri, yer tutucular ve eşleme buraya
// hiç uğramaz.
function configurePageGuard() {
  document.documentElement.setAttribute(
    CONFIG_ATTRIBUTE,
    JSON.stringify({
      active: Boolean(settings.enabled && settings.networkGuard),
      extensions: SCANNABLE_EXTENSIONS,
      blockUnscannable: Boolean(settings.blockUnscannable),
    })
  );
}

const approvedKeys = new Set();

function approve(files) {
  for (const file of files) approvedKeys.add(fileKey(file.name, file.size));
  // JSON: dosya adı satır sonu içerebilir, düz birleştirme hem kendi onayımızı
  // bozar hem de uydurma bir adla sahte onay üretmeye izin verirdi.
  document.documentElement.setAttribute(APPROVED_ATTRIBUTE, JSON.stringify([...approvedKeys]));
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__redaktGuard !== GUARD_MARK || data.type !== PAGE.blocked) return;
  toast(`Redakt Guard durdurdu: ${data.filename || "dosya"} maskelenmeden gönderilemez.`);
});

function reportActivity(count) {
  if (count > 0) sendRuntimeMessageBestEffort({ type: MSG.activity, count });
}

function reportAudit(details) {
  // Audit yardımcı bir güvenlik kaydıdır; kimlik üretimi veya gelecekteki bir
  // şema uyumsuzluğu maskelenmiş dosyanın teslimini asla bozmamalı. İçerik
  // betiği yalnız güvenli özeti üretir, background tekrar allowlist uygular.
  try {
    const event = createAuditEvent({ site: SITE_ID, ...details });
    if (event) sendRuntimeMessageBestEffort({ type: MSG.auditMasking, event });
  } catch {
    // Ağ/storage hataları background kuyruğunda ele alınır. Buradaki hata da
    // veri koruma akışından bağımsızdır ve ham içeriğe geri düşüş yaratmaz.
  }
}

function blockingReason(items, fallback) {
  const titles = [];
  for (const item of Array.isArray(items) ? items : []) {
    const title = String(item?.title || "").trim();
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles.length ? titles.slice(0, 2).join(" ") : fallback;
}

// ---------------------------------------------------------------- motor bağlantısı

class EnginePort {
  constructor(port) {
    this.port = port;
    this.routes = new Map();
    this.closed = false;
    // Motordan hiç ses çıkmazsa sonsuza kadar beklemek yerine takıldığını
    // söyle. Kilitlenen bir offscreen belge kendiliğinden kurtulmuyor ve
    // arkasındaki her tarama sessizce ölüyordu.
    this.watchdog = null;
    port.onMessage.addListener((message) => {
      this.#heardFromEngine();
      this.routes.get(message?.id)?.(message);
    });
    port.onDisconnect.addListener(() => {
      this.closed = true;
      for (const route of this.routes.values()) route({ cmd: CMD.failure, message: "Tarama motoruyla bağlantı koptu." });
    });
  }

  #heardFromEngine() {
    if (!this.watchdog) return;
    clearTimeout(this.watchdog.timer);
    this.watchdog.timer = setTimeout(this.watchdog.onSilence, ENGINE_SILENCE_TIMEOUT_MS);
  }

  // Uzun süren bir iş boyunca sessizliği izler; her mesaj sayacı sıfırlar.
  watchSilence(onSilence) {
    this.stopWatching();
    this.watchdog = { onSilence, timer: setTimeout(onSilence, ENGINE_SILENCE_TIMEOUT_MS) };
  }

  stopWatching() {
    if (!this.watchdog) return;
    clearTimeout(this.watchdog.timer);
    this.watchdog = null;
  }

  static async open() {
    const ack = await sendRuntimeMessage({ type: MSG.ensureEngine });
    if (!ack?.ok) throw new Error("Tarama motoru başlatılamadı.");
    const port = connectRuntime({ name: ENGINE_PORT });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Tarama motoru yanıt vermedi.")), 15000);
        const onReady = (message) => {
          if (message?.cmd !== CMD.ready) return;
          clearTimeout(timer);
          port.onMessage.removeListener(onReady);
          resolve();
        };
        port.onMessage.addListener(onReady);
        port.onDisconnect.addListener(() => {
          clearTimeout(timer);
          reject(new Error("Tarama motoruna bağlanılamadı."));
        });
      });
    } catch (error) {
      // El sıkışma başarısızsa port açık kalmamalı.
      try { port.disconnect(); } catch { /* uzantı yenilenmiş olabilir */ }
      throw error;
    }
    return new EnginePort(port);
  }

  async #stream(id, bytes, filename, onProgress) {
    const total = chunkCount(bytes.length);
    this.port.postMessage({ cmd: CMD.scanBegin, id, filename, size: bytes.length, chunks: total });
    let seq = 0;
    for (const part of chunkBytes(bytes)) {
      this.port.postMessage({ cmd: CMD.scanChunk, id, seq, data: bytesToBase64(part) });
      seq += 1;
      onProgress?.({ phase: "transferring", current: seq, total });
      // Büyük dosyada sekmeyi kilitlememek için ara ver.
      if (seq % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.port.postMessage({ cmd: CMD.scanEnd, id });
  }

  async scan(id, file, onProgress) {
    onProgress?.({ phase: "transferring", detail: "Dosya motora aktarılıyor." });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const done = new Promise((resolve, reject) => {
      this.routes.set(id, (message) => {
        if (message.cmd === CMD.progress) onProgress?.(message);
        else if (message.cmd === CMD.scanResult) {
          this.routes.delete(id);
          resolve({ findings: message.findings || [], warnings: message.warnings || [] });
        } else if (message.cmd === CMD.failure) {
          this.routes.delete(id);
          reject(new Error(message.message || "Dosya taranamadı."));
        }
      });
    });
    await this.#stream(id, bytes, file.name, onProgress);
    return done;
  }

  mask(id, selectedIds, original, onProgress) {
    const parts = [];
    let header = null;
    const done = new Promise((resolve, reject) => {
      this.routes.set(id, (message) => {
        if (message.cmd === CMD.progress) onProgress?.(message);
        else if (message.cmd === CMD.maskBegin) header = message;
        else if (message.cmd === CMD.maskChunk) parts.push({ seq: message.seq, bytes: base64ToBytes(message.data) });
        else if (message.cmd === CMD.maskEnd) {
          this.routes.delete(id);
          if (!header) {
            reject(new Error("Maskelenmiş dosya eksik aktarıldı."));
            return;
          }
          // Belge içeriği değişmediyse (yalnızca dosya adı maskelendi)
          // baytlar yeniden taşınmaz; özgün dosya yeni adla sarılır.
          if (!header.documentChanged) {
            resolve({
              file: new File([original], header.filename, { type: original.type || header.mimeType }),
              audit: header.audit || null,
            });
            return;
          }
          const bytes = joinChunks(parts);
          if (bytes.length !== header.size) reject(new Error("Maskelenmiş dosya eksik aktarıldı."));
          else resolve({ file: new File([bytes], header.filename, { type: header.mimeType }), audit: header.audit || null });
        } else if (message.cmd === CMD.failure) {
          this.routes.delete(id);
          reject(new Error(message.message || "Maskelenmiş kopya hazırlanamadı."));
        }
      });
    });
    this.port.postMessage({ cmd: CMD.mask, id, selectedIds });
    return done;
  }

  scanText(id, text, useModel, onProgress) {
    const done = new Promise((resolve, reject) => {
      this.routes.set(id, (message) => {
        if (message.cmd === CMD.progress) onProgress?.(message);
        else if (message.cmd === CMD.scanResult) {
          this.routes.delete(id);
          resolve({ findings: message.findings || [], warnings: message.warnings || [] });
        } else if (message.cmd === CMD.failure) {
          this.routes.delete(id);
          reject(new Error(message.message || "Metin taranamadı."));
        }
      });
    });
    this.port.postMessage({ cmd: CMD.scanText, id, text, useModel });
    return done;
  }

  maskText(id, selectedIds) {
    const done = new Promise((resolve, reject) => {
      this.routes.set(id, (message) => {
        if (message.cmd === CMD.maskTextResult) {
          this.routes.delete(id);
          resolve({ text: String(message.text ?? ""), audit: message.audit || null });
        } else if (message.cmd === CMD.failure) {
          this.routes.delete(id);
          reject(new Error(message.message || "Metin maskelenemedi."));
        }
      });
    });
    this.port.postMessage({ cmd: CMD.maskText, id, selectedIds });
    return done;
  }

  release(id) {
    if (!this.closed) {
      try { this.port.postMessage({ cmd: CMD.release, id }); } catch { /* yalnız temizlik */ }
    }
  }

  close() {
    this.stopWatching();
    if (!this.closed) {
      try { this.port.disconnect(); } catch { /* uzantı yenilenmiş olabilir */ }
    }
    this.closed = true;
  }
}

// ---------------------------------------------------------------- akış

// Motor tüm sekmelerce paylaşıldığı için kimlik sekme içi sayaçla üretilemez.
const nextId = () => `guard_${crypto.randomUUID()}`;

function classify(file) {
  if (!isScannable(file.name)) return "unscannable";
  if (file.size > MAX_SCANNABLE_BYTES) return "toolarge";
  return "scannable";
}

async function guardFiles(files, deliver) {
  if (activeFlow) {
    toast("Redakt Guard önceki dosyayı işliyor; bitince tekrar dene.");
    return;
  }
  const flow = Symbol("guard-flow");
  activeFlow = flow;
  const releaseFlow = () => {
    if (activeFlow === flow) activeFlow = null;
  };

  const panel = new GuardPanel(SITE);
  let engine = null;
  let cancelled = false;
  let recovering = false;
  const sessions = [];

  let finished = false;
  const finish = async (delivered) => {
    if (finished) return;
    finished = true;
    for (const session of sessions) engine?.release(session.id);
    engine?.close();
    panel.destroy();
    try {
      if (delivered?.length) {
        approve(delivered);
        await deliver(delivered);
      }
    } finally {
      releaseFlow();
    }
  };

  const recoverEngine = () => {
    if (recovering) return;
    recovering = true;
    engine?.stopWatching();
    engine?.close();
    panel.destroy();
    toast("Tarama motoru yanıt vermedi; yeniden kuruluyor.");
    Promise.resolve()
      .then(() => sendRuntimeMessage({ type: MSG.restartEngine }))
      .then((response) => {
        if (!response?.ok) throw new Error(response?.message || "Motor yeniden kurulamadı.");
        toast("Tarama motoru yeniden kuruldu. Dosyayı tekrar bırak.");
      })
      .catch((error) => {
        toast(`Tarama motoru yeniden kurulamadı: ${String(error?.message || error)}`);
      })
      .finally(releaseFlow);
  };

  try {
    panel.showScanning({ device: engineDevice,
      filename: files[0].name,
      total: files.length,
      onCancel: () => {
        cancelled = true;
        void finish(null);
      },
    });

    // Motorun kurulması (offscreen belge + 147 MB modelin ilk kez
    // hazırlanması) saniyeler sürebiliyor. Burada susmak, kullanıcıya
    // "takıldı" hissi veren tek en büyük boşluktu.
    panel.setProgress({ phase: "connecting", detail: "İlk kullanımda model hazırlanır, bu biraz sürebilir." });
    const opened = await EnginePort.open();
    if (cancelled) {
      opened.close();
      return;
    }
    engine = opened;

    const scanned = [];
    for (let index = 0; index < files.length; index += 1) {
      if (cancelled) return;
      const file = files[index];
      const kind = classify(file);
      panel.showScanning({ device: engineDevice,
        filename: file.name,
        index,
        total: files.length,
        onCancel: () => {
          cancelled = true;
          void finish(null);
        },
      });

      if (kind !== "scannable") {
        const message =
          kind === "toolarge"
            ? "Dosya 50 MB sınırını aşıyor; Redakt bu boyutu tarayamıyor."
            : "Redakt bu dosya türünü açamıyor; içeriği taranamadı.";
        toast(`${message} Kurum politikası gönderimi durdurdu.`);
        return finish(null);
      }

      const id = nextId();
      sessions.push({ id, index });
      // Yalnız aktif motor işi sırasında sessizliği izle. İnceleme panelinde
      // kullanıcı 45 saniyeden uzun düşünürse sağlıklı motor kapatılmamalı.
      engine.watchSilence(recoverEngine);
      try {
        const result = await engine.scan(id, file, (progress) => panel.setProgress(progress));
        scanned.push({ file, id, findings: result.findings, warnings: result.warnings, passthrough: false });
      } catch (error) {
        if (cancelled || recovering) return;
        toast(`Dosya güvenli biçimde taranamadı; gönderim durduruldu: ${error instanceof Error ? error.message : String(error)}`);
        return finish(null);
      } finally {
        engine.stopWatching();
      }
    }

    if (cancelled) return;

    const enforcement = decideScannedFiles(scanned);
    if (enforcement.action === "block") {
      const warnings = scanned.flatMap((item) => item.warnings || []);
      toast(`Gönderim durduruldu: ${blockingReason(warnings, "Tarama bütün koruma katmanlarıyla tamamlanamadı.")}`);
      return finish(null);
    }
    // Tam taramada hiçbir şey bulunmadıysa içerik güvenle değişmeden geçer.
    if (enforcement.action === "clean") {
      toast(`Redakt Guard taradı · ${files.length > 1 ? `${files.length} dosya` : files[0].name} · hassas bilgi yok.`);
      return finish(scanned.map((item) => item.file));
    }

    const output = [];
    const auditSummaries = [];
    const auditFormats = [];
    let maskedCount = 0;
    for (let index = 0; index < scanned.length; index += 1) {
      const item = scanned[index];
      const selectedIds = enforcement.selections.get(index) || [];
      if (!selectedIds.length) {
        output.push(item.file);
        continue;
      }
      panel.showScanning({ device: engineDevice,
        filename: item.file.name,
        index,
        total: scanned.length,
        onCancel: () => {
          cancelled = true;
          void finish(null);
        },
      });
      panel.setProgress({ detail: "Maskelenmiş kopya hazırlanıyor." });
      engine.watchSilence(recoverEngine);
      try {
        const masked = await engine.mask(item.id, selectedIds, item.file, (progress) => panel.setProgress(progress));
        output.push(masked.file);
        if (masked.audit) auditSummaries.push(masked.audit);
        auditFormats.push(extensionOf(item.file.name));
      } finally {
        engine.stopWatching();
      }
      maskedCount += selectedIds.length;
    }

    if (cancelled) return;
    toast(`${maskedCount} bulgu otomatik maskelendi; güvenli kopya yükleniyor.`);
    // Maskeli kopyanın teslimi rozet/audit gibi yardımcı bildirimlerden önce
    // başlar. Uzantı tam bu anda yeniden yüklense bile güvenli çıktı kaybolmaz.
    await finish(output);
    reportActivity(maskedCount);
    reportAudit({ artifact: "file", summaries: auditSummaries, formats: auditFormats });
  } catch (error) {
    if (!cancelled && !recovering) {
      releaseFlow();
      panel.destroy();
      engine?.close();
      toast(`Redakt Guard hatası: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    // Kurtarma sürerken yeni dosya akışını açma: ikinci deneme kapanmakta olan
    // belgeye bağlanmasın. Kilidi restartEngine yanıtı geldiğinde bırakırız.
    if (!recovering) releaseFlow();
  }
}

// ---------------------------------------------------------------- prompt metni

// Gönderilmesi onaylanmış metinler. Anahtar boşlukları sadeleştirir: kutuya
// yazdığımız metni geri okuduğumuzda satır sonu sayısı değişebiliyor
// (innerText <p> sınırını iki, <br>'ı bir satır sonu sayar), tam eşitlik
// aransaydı kendi gönderimimizi tanıyamaz ve döngüye girerdik.
const approvedPrompts = new Set();
const promptKey = (text) => String(text).replace(/\s+/gu, " ").trim();

function promptGuardActive() {
  return Boolean(settings.enabled && settings.guardPrompts);
}

// Kurumsal kural listesi eksikse şirkete özel adlar maskelenmeden gider.
// Dosya yolunda bu uyarı var; prompt yolunda da olmalı.
function ruleWarnings() {
  if (!settings.serverUrl || rulesStatus === "ready") return [];
  return [
    {
      title: "Kurumsal kural listesi güncel değil.",
      detail: "Redakt sunucusuna ulaşılamadı; şirkete özel adlar bu promptta maskelenmemiş olabilir.",
    },
  ];
}

// Eşzamanlı karar: metne dokunulacak mı? null dönerse hiç karışılmaz.
// Model taraması kurum politikasıyla zorunlu açıktır. Karar eşzamanlı verilemez
// — model ancak offscreen belgede çalışır — bu yüzden her gönderim panele uğrar.
function promptDecision(text) {
  if (!promptGuardActive()) return null;
  if (!String(text).trim()) return null;
  if (approvedPrompts.has(promptKey(text))) return null;
  if (settings.promptModelScan) return { deferred: true, useModel: true, findings: [] };
  // Uzun metin sayfayı dondurmadan offscreen belgede taranır; model orada da
  // çalıştırılmaz, yalnızca hızlı katman.
  if (text.length > SYNC_SCAN_LIMIT) return { deferred: true, useModel: false, findings: [] };
  const findings = scanPromptText(text, corporateRules);
  const rulesIncomplete = Boolean(settings.serverUrl && rulesStatus !== "ready");
  return findings.length || rulesIncomplete ? { deferred: false, useModel: false, findings } : null;
}

const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// Maskelemeden sonraki asıl güvenlik koşulu: seçilen değerler artık kutuda yok.
// "Yazdığımı geri okuyunca aynı mı" karşılaştırması yanlış bir değişmez.
function residualValues(composer, findings, selectedIds) {
  const selected = new Set(selectedIds);
  const current = readComposerText(composer);
  return findings.filter((finding) => selected.has(finding.id) && finding.value && current.includes(finding.value));
}

async function submitComposer(composer) {
  const button = findSendButton(composer);
  if (button) {
    button.click();
    return;
  }
  const key = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  synthetic.add(key);
  composer.dispatchEvent(key);
}

async function guardPrompt({ text, findings, deferred, useModel, composer, caret, mode }) {
  if (activeFlow) {
    toast("Redakt Guard önceki işi bitirmeden yeni metin taranamaz.");
    return;
  }
  const flow = Symbol("prompt-flow");
  activeFlow = flow;
  const releaseFlow = () => {
    if (activeFlow === flow) activeFlow = null;
  };

  const panel = new GuardPanel(SITE);
  const label = mode === "paste" ? "Yapıştırılan metin" : "Prompt metni";
  let engine = null;
  let sessionId = null;
  let cancelled = false;
  let settled = false;

  const teardown = () => {
    if (settled) return;
    settled = true;
    if (sessionId) engine?.release(sessionId);
    engine?.close();
    panel.destroy();
    releaseFlow();
  };

  const apply = async (finalText, selectedIds = []) => {
    if (mode === "paste") {
      if (!insertAtCaret(composer, finalText, caret)) {
        toast("Metin kutusuna yazılamadı; maskelenmiş metin yapıştırılmadı.");
        return false;
      }
      return true;
    }
    approvedPrompts.add(promptKey(finalText));
    if (finalText !== text) {
      if (!replaceComposerText(composer, finalText)) {
        toast("Prompt kutusu güncellenemedi; gönderim durduruldu.");
        return false;
      }
      // Düzenleyici DOM'u uzlaştırsın, sonra değer bazlı denetim.
      await settle();
      const residue = residualValues(composer, findings, selectedIds);
      if (residue.length) {
        toast(`Prompt kutusunda ${residue.length} hassas değer kaldı; gönderim durduruldu.`);
        return false;
      }
      approvedPrompts.add(promptKey(readComposerText(composer)));
    }
    await submitComposer(composer);
    return true;
  };

  try {
    let warnings = ruleWarnings();
    if (deferred) {
      panel.showScanning({ device: engineDevice,
        filename: label,
        onCancel: () => {
          cancelled = true;
          teardown();
        },
      });
      panel.setProgress({ phase: "connecting", detail: "İlk kullanımda model hazırlanır, bu biraz sürebilir." });
      const opened = await EnginePort.open();
      if (cancelled) {
        opened.close();
        return;
      }
      engine = opened;
      sessionId = nextId();
      const result = await engine.scanText(sessionId, text, useModel, (progress) => panel.setProgress(progress));
      findings = result.findings;
      warnings = [...warnings, ...result.warnings];
    }

    if (cancelled) return;

    const enforcement = decideScannedPrompt(findings, warnings);
    if (enforcement.action === "block") {
      toast(`Prompt gönderimi durduruldu: ${blockingReason(warnings, "Tarama bütün koruma katmanlarıyla tamamlanamadı.")}`);
      return;
    }
    if (enforcement.action === "clean") {
      // Bulgu yoksa akışı kesmenin anlamı yok; metin olduğu gibi devam eder.
      await apply(text);
      return;
    }

    const selectedIds = enforcement.selectedIds;
    const maskedResult = engine
      ? await engine.maskText(sessionId, selectedIds)
      : {
          text: maskPromptText(text, findings, selectedIds),
          audit: summarizeSelectedFindings(findings, selectedIds),
        };
    const applied = await apply(maskedResult.text, selectedIds);
    if (applied) {
      reportActivity(selectedIds.length);
      reportAudit({
        artifact: mode === "paste" ? "prompt-paste" : "prompt-send",
        summaries: [maskedResult.audit],
      });
      toast(`${selectedIds.length} bulgu otomatik maskelendi.`);
    }
  } catch (error) {
    if (!cancelled) toast(`Redakt Guard hatası: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    teardown();
  }
}

// ---------------------------------------------------------------- olay yakalama

function shouldIntercept(files) {
  if (!files.length) return false;
  if (settingsReady && !settings.enabled) return false;
  return files.some((file) => isScannable(file.name)) || settings.blockUnscannable;
}

function makeTransfer(files) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return transfer;
}

function openFileInputs(root = document, output = []) {
  for (const input of root.querySelectorAll?.('input[type="file"]') || []) output.push(input);
  // Gemini bazı yükleme bileşenlerini açık shadow root içinde kurabiliyor.
  // Belge geneline bir kez bakmak, kaybolan/eski input'u körlemesine yeniden
  // kullanmaktan daha güvenli; kapalı shadow root tarayıcı gereği erişilemez.
  for (const element of root.querySelectorAll?.("*") || []) {
    if (element.shadowRoot) openFileInputs(element.shadowRoot, output);
  }
  return output;
}

function inputAccepts(input, file) {
  const accept = String(input.accept || "").trim().toLowerCase();
  if (!accept) return true;
  const mime = String(file.type || "").toLowerCase();
  const extension = `.${extensionOf(file.name)}`;
  return accept.split(",").some((raw) => {
    const token = raw.trim();
    if (!token || token === "*/*") return true;
    if (token.startsWith(".")) return token === extension;
    if (token.endsWith("/*")) return mime.startsWith(token.slice(0, -1));
    return token === mime;
  });
}

function findCompatibleFileInput(files) {
  const candidates = openFileInputs().filter(
    (input) => input.isConnected && !input.disabled && (files.length <= 1 || input.multiple) && files.every((file) => inputAccepts(input, file))
  );
  if (!candidates.length) return null;
  const score = (input) => {
    const hint = `${input.id} ${input.name} ${input.className} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
    let value = input.multiple ? 4 : 0;
    if (/upload|attach|attachment|file|dosya|belge|ek/iu.test(hint)) value += 8;
    if (/avatar|profile|camera|profil/iu.test(hint)) return -100;
    const form = input.closest("form");
    const editorSelector =
      SITE_ID === "gemini"
        ? "rich-textarea, div.ql-editor[contenteditable='true']"
        : "div.ProseMirror[contenteditable='true']";
    if (form?.querySelector(editorSelector)) value += 20;
    else if (input.parentElement?.parentElement?.querySelector?.(editorSelector)) value += 12;
    if (input.closest("main")) value += 2;
    return value;
  };
  const ranked = candidates.map((input) => ({ input, score: score(input) })).sort((left, right) => right.score - left.score);
  // Yalnızca profil/kamera girdisi varsa ona güvenli belge teslim edip başarı
  // sanma. Doğrudan kullanıcı seçiminin input'u bu filtreden geçmeden saklanır.
  return ranked[0]?.score > 0 ? ranked[0].input : null;
}

function replayFilesToInput(input, files) {
  if (!(input instanceof HTMLInputElement) || input.type !== "file" || input.disabled) return false;
  try {
    const transfer = makeTransfer(files);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (setter) setter.call(input, transfer.files);
    else input.files = transfer.files;

    // Önce MAIN-world rölesini dene. Bu yol framework olayını Gemini/Claude'un
    // kendi JavaScript bağlamında üretir ve tarama sırasında DOM'dan ayrılmış
    // eski input'ta da (page-guard'ın doğrudan dinleyicisi sayesinde) çalışır.
    const token = crypto.randomUUID();
    input.setAttribute(FILE_DELIVERY_TOKEN_ATTRIBUTE, token);
    replayingFileInputs.set(input, 2);
    input.dispatchEvent(new CustomEvent(FILE_DELIVERY_EVENT, { bubbles: true, composed: true }));
    const relayed = input.getAttribute(FILE_DELIVERY_ACK_ATTRIBUTE) === token;
    input.removeAttribute(FILE_DELIVERY_TOKEN_ATTRIBUTE);
    input.removeAttribute(FILE_DELIVERY_ACK_ATTRIBUTE);
    if (relayed) return true;

    replayingFileInputs.delete(input);
    // Eski sayfa/uzantı oturumunda page-guard henüz yenilenmemiş olabilir.
    // Bağlı bir input için önceki isolated-world davranışı güvenli yedektir.
    for (const type of ["input", "change"]) {
      const replay = new Event(type, { bubbles: true, composed: true });
      synthetic.add(replay);
      input.dispatchEvent(replay);
    }
    return input.isConnected;
  } catch {
    replayingFileInputs.delete(input);
    input?.removeAttribute?.(FILE_DELIVERY_TOKEN_ATTRIBUTE);
    input?.removeAttribute?.(FILE_DELIVERY_ACK_ATTRIBUTE);
    return false;
  }
}

function deliverToFileInput(firstInput, files) {
  const candidates = [firstInput, findCompatibleFileInput(files)].filter(Boolean);
  const tried = new Set();
  for (const input of candidates) {
    if (tried.has(input)) continue;
    tried.add(input);
    if (replayFilesToInput(input, files)) return true;
  }
  return false;
}

const prefersFileInputDelivery = () => SITE_ID === "gemini" || SITE_ID === "claude";

function replayDropInPage(target, files, { clientX = 0, clientY = 0 } = {}) {
  if (!(target instanceof Element) || !target.isConnected || !files.length) return false;
  const bridge = document.createElement("input");
  bridge.type = "file";
  bridge.multiple = true;
  bridge.hidden = true;
  bridge.setAttribute("aria-hidden", "true");
  const token = crypto.randomUUID();
  try {
    const transfer = makeTransfer(files);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
    if (setter) setter.call(bridge, transfer.files);
    else bridge.files = transfer.files;
    bridge.setAttribute(DROP_DELIVERY_TOKEN_ATTRIBUTE, token);
    bridge.setAttribute(DROP_DELIVERY_POINT_ATTRIBUTE, JSON.stringify([clientX, clientY]));
    target.setAttribute(DROP_DELIVERY_TARGET_ATTRIBUTE, token);
    document.documentElement.append(bridge);
    target.dispatchEvent(new CustomEvent(DROP_DELIVERY_EVENT, { bubbles: true, composed: true }));
    return bridge.getAttribute(DROP_DELIVERY_ACK_ATTRIBUTE) === token;
  } catch {
    return false;
  } finally {
    target.removeAttribute(DROP_DELIVERY_TARGET_ATTRIBUTE);
    document.documentElement.removeAttribute(DROP_DELIVERY_ACTIVE_ATTRIBUTE);
    bridge.remove();
  }
}

function dropTargetOf(event) {
  if (event.target?.isConnected) return event.target;
  return deliveryFallback(event.clientX, event.clientY);
}

// document.body'ye göndermek işe yaramaz: React kökü body'nin ALTINDA olduğu
// için olay kabarcıklanırken kök dinleyiciye hiç uğramaz. Önce imlecin
// altındaki öğe, sonra kök konteyner denenir.
function deliveryFallback(clientX, clientY) {
  const pointTarget = document.elementFromPoint(clientX ?? 0, clientY ?? 0);
  if (pointTarget && pointTarget !== document.body && pointTarget !== document.documentElement) return pointTarget;
  // Gemini tam sayfa drop dinlemiyor; ek kabul eden bileşen prompt alanının
  // çevresinde. İmleç boş arka plandaysa drop oraya gider ve sessizce kaybolur.
  if (SITE_ID === "gemini" || SITE_ID === "claude") {
    const editor = document.querySelector(
      SITE_ID === "gemini"
        ? "rich-textarea, div.ql-editor[contenteditable='true']"
        : "div.ProseMirror[contenteditable='true']"
    );
    if (editor?.isConnected) return editor;
  }
  return (
    pointTarget ||
    document.querySelector("main") ||
    document.body?.firstElementChild ||
    document.body
  );
}

function dispatchDrag(target, type, dataTransfer, { clientX = 0, clientY = 0, relatedTarget = null } = {}) {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    relatedTarget,
    dataTransfer: dataTransfer || new DataTransfer(),
  });
  synthetic.add(event);
  target?.dispatchEvent(event);
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const shortDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function attachmentUiCount() {
  const selectors = [
    '[data-testid*="attachment" i]',
    '[class*="attachment" i]',
    '[class*="file-chip" i]',
    '[class*="upload-preview" i]',
    'img[src^="blob:"]',
    'video[src^="blob:"]',
  ];
  return new Set(document.querySelectorAll(selectors.join(", "))).size;
}

function deliveryVisible(files, baseline) {
  const text = String(document.body?.innerText || "").toLocaleLowerCase("tr-TR");
  const namesVisible = files.every((file) => text.includes(String(file.name || "").toLocaleLowerCase("tr-TR")));
  return namesVisible || attachmentUiCount() > baseline;
}

async function waitForDelivery(files, baseline, timeoutMs = 2200) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (deliveryVisible(files, baseline)) return true;
    await shortDelay(100);
  } while (performance.now() < deadline);
  return deliveryVisible(files, baseline);
}

function announceDelivered(files) {
  toast(`${files.length > 1 ? `${files.length} maskelenmiş dosya` : "Maskelenmiş güvenli kopya"} ${SITE} yükleme alanına eklendi.`);
}

function visibleDropOverlays() {
  const found = new Set();
  const candidates = document.querySelectorAll(
    '[data-testid*="drop" i], [class*="drop-overlay" i], [class*="dropzone" i], [class*="drop-zone" i], [role="dialog"]'
  );
  for (const element of candidates) {
    if (element instanceof HTMLElement && element.getClientRects().length) found.add(element);
  }
  // Claude'un güncel perdesinde kararlı bir test id yok; görünen metinden
  // yalnız en yakın kapsayıcıyı bulup ona terminal drop/leave gönderilir.
  for (const element of document.querySelectorAll("div, p, span")) {
    const text = String(element.textContent || "").trim();
    if (!/^(drop files here to add to chat|add anything|dosyaları buraya bırak)/iu.test(text)) continue;
    if (element instanceof HTMLElement && element.getClientRects().length) found.add(element.parentElement || element);
  }
  return [...found];
}

async function cleanupDropUi(originalTarget, clientX, clientY) {
  await nextFrame();
  const overlays = visibleDropOverlays();
  const targets = new Set([
    originalTarget?.isConnected ? originalTarget : null,
    document.elementFromPoint(clientX ?? 0, clientY ?? 0),
    ...overlays,
    document.activeElement,
    document.body,
    document.documentElement,
  ]);
  const empty = new DataTransfer();
  // Görünen perdeye boş terminal drop göndermek site iç durumunu kapatır;
  // dosya olmadığı için yeni yükleme başlatamaz.
  for (const overlay of overlays) dispatchDrag(overlay, "drop", empty, { clientX, clientY });
  for (const target of targets) {
    if (!target?.dispatchEvent) continue;
    if (target instanceof Element && target.isConnected) {
      target.dispatchEvent(new CustomEvent(DROP_CLEANUP_EVENT, { bubbles: true, composed: true }));
    }
    dispatchDrag(target, "dragleave", empty, { clientX: -1, clientY: -1 });
    dispatchDrag(target, "dragend", empty, { clientX: -1, clientY: -1 });
  }
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  synthetic.add(escape);
  (document.activeElement || document.body)?.dispatchEvent(escape);
}

window.addEventListener(
  "drop",
  (event) => {
    if (synthetic.has(event) || document.documentElement.hasAttribute(DROP_DELIVERY_ACTIVE_ATTRIBUTE)) return;
    const files = [...(event.dataTransfer?.files || [])];
    if (!shouldIntercept(files)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const target = dropTargetOf(event);
    const { clientX, clientY } = event;
    const deliveryBaseline = attachmentUiCount();
    // Menü/overlay tarama sırasında kapanabilir. Kullanıcının güvenilir drop
    // anında var olan input'u sakla; page-guard ona MAIN-world dinleyici bağladı.
    const firstInput = prefersFileInputDelivery() ? findCompatibleFileInput(files) : null;

    void guardFiles(files, async (delivered) => {
      let host = target.isConnected ? target : deliveryFallback(clientX, clientY);
      // Drag ile başlayan akışı önce aynı mekanizmayla, fakat sayfanın MAIN
      // dünyasında tamamla. Bu hem Gemini teslimini hem Claude perdesinin kendi
      // drop durumunu kapatmasını sağlar.
      if (prefersFileInputDelivery() && replayDropInPage(host, delivered, { clientX, clientY })) {
        if (await waitForDelivery(delivered, deliveryBaseline)) {
          announceDelivered(delivered);
          return;
        }
      }
      // MAIN drag yolu kullanılamadıysa gerçek upload input'u ikinci yedektir.
      if (prefersFileInputDelivery() && deliverToFileInput(firstInput, delivered)) {
        if (await waitForDelivery(delivered, deliveryBaseline)) {
          announceDelivered(delivered);
          return;
        }
      }
      const transfer = makeTransfer(delivered);
      // Durumu temizledik; bırakma bölgesi kendi durumunu yeniden kurmadan
      // gelen drop'u yok sayabilir. dragenter yeni bir overlay de kurabildiği
      // için bir kare sonra canlı hedef yeniden bulunur.
      dispatchDrag(host, "dragenter", transfer, { clientX, clientY });
      await nextFrame();
      host = deliveryFallback(clientX, clientY);
      dispatchDrag(host, "dragover", transfer, { clientX, clientY });
      dispatchDrag(host, "drop", transfer, { clientX, clientY });
      // Sentetik drop tarayıcının gerçek drag oturumunu sonlandırmaz. ChatGPT
      // dosyayı kabul etse de tam ekran "Drop any file" perdesi açık kalır;
      // sonraki karede açık bir terminal leave ile bu ikinci döngüyü kapat.
      await nextFrame();
      host = deliveryFallback(clientX, clientY);
      dispatchDrag(host, "dragleave", transfer, { clientX: -1, clientY: -1 });
      if (prefersFileInputDelivery()) {
        if (await waitForDelivery(delivered, deliveryBaseline)) announceDelivered(delivered);
        else toast(`Maskelenmiş dosya ${SITE} yükleme alanı tarafından kabul edilmedi; gönderim durduruldu.`);
      }
    }).finally(() => cleanupDropUi(target, clientX, clientY).catch(() => {}));
  },
  true
);

function interceptFileInput(event) {
  if (synthetic.has(event)) return;
  // event.target shadow host'a yeniden hedeflenir; gerçek girdi composedPath'in
  // başındadır. Açık shadow root'taki dosya girdileri ancak böyle yakalanır.
  const input = event.composedPath?.()[0] || event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
  const replayCount = replayingFileInputs.get(input) || 0;
  if (replayCount) {
    if (replayCount === 1) replayingFileInputs.delete(input);
    else replayingFileInputs.set(input, replayCount - 1);
    return;
  }
  const files = [...(input.files || [])];
  if (!shouldIntercept(files)) return;

  event.stopImmediatePropagation();
  // Özgün dosyalar girdide bırakılmaz: sayfa bir başka yolla okumaya kalkarsa
  // elinde yalnızca boş bir liste bulmalı.
  input.value = "";
  const deliveryBaseline = attachmentUiCount();

  void guardFiles(files, async (delivered) => {
    // Önce kullanıcının seçtiği input denenir: doğrudan MAIN-world dinleyicisi
    // DOM'dan ayrılmış olsa bile üzerinde kalır. Sonra güncel eşdeğeri aranır.
    if (!deliverToFileInput(input, delivered) || !(await waitForDelivery(delivered, deliveryBaseline))) {
      toast(`Yükleme alanı değişti; maskelenmiş dosya ${SITE} sitesine eklenemedi.`);
    } else {
      announceDelivered(delivered);
    }
  });
}

window.addEventListener("input", interceptFileInput, true);
window.addEventListener("change", interceptFileInput, true);

window.addEventListener(
  "paste",
  (event) => {
    if (synthetic.has(event)) return;
    const files = [...(event.clipboardData?.files || [])];

    // Dosya yoksa metin yolu: bulgu çıkmazsa yapıştırmaya hiç dokunulmaz,
    // böylece sıradan yapıştırma gecikmesiz kalır.
    if (!files.length) {
      const text = event.clipboardData?.getData("text/plain") || "";
      const decision = promptDecision(text);
      if (!decision) return;
      const composer = findComposer(event.composedPath?.()[0] || event.target);
      if (!composer) return;
      const caret = saveCaret(composer);
      event.preventDefault();
      event.stopImmediatePropagation();
      guardPrompt({ text, ...decision, composer, caret, mode: "paste" });
      return;
    }

    if (!shouldIntercept(files)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const target = event.target?.isConnected ? event.target : document.activeElement || document.body;
    const firstInput = prefersFileInputDelivery() ? findCompatibleFileInput(files) : null;
    const deliveryBaseline = attachmentUiCount();
    void guardFiles(files, async (delivered) => {
      // Görsel yapıştırma da dosya yükleme hattıdır. Gemini/Claude sentetik
      // ClipboardEvent'i yok sayarsa gerçek upload input'u üzerinden teslim et.
      if (prefersFileInputDelivery() && deliverToFileInput(firstInput, delivered)) {
        if (await waitForDelivery(delivered, deliveryBaseline)) {
          announceDelivered(delivered);
          return;
        }
      }
      if (prefersFileInputDelivery() && replayDropInPage(target, delivered)) {
        if (await waitForDelivery(delivered, deliveryBaseline)) {
          announceDelivered(delivered);
          return;
        }
      }
      const transfer = makeTransfer(delivered);
      let replay = null;
      try {
        replay = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: transfer,
        });
      } catch {
        replay = null;
      }
      if (replay && replay.clipboardData === transfer) {
        synthetic.add(replay);
        target.dispatchEvent(replay);
        if (!prefersFileInputDelivery()) return;
        if (await waitForDelivery(delivered, deliveryBaseline)) {
          announceDelivered(delivered);
          return;
        }
      }
      // ClipboardEvent taşınamadıysa dosya, aynı hedefe bırakma olayı olarak verilir.
      const fallback = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: transfer,
      });
      synthetic.add(fallback);
      target.dispatchEvent(fallback);
      if (prefersFileInputDelivery()) {
        if (await waitForDelivery(delivered, deliveryBaseline)) announceDelivered(delivered);
        else toast(`Maskelenmiş görsel ${SITE} yükleme alanı tarafından kabul edilmedi; gönderim durduruldu.`);
      }
    });
  },
  true
);

// Gönderim: Enter tuşu ve gönder düğmesi. Dinleyiciler modül düzeyinde,
// document_start'ta kaydedilir — ayar okumasının içine alınırsa okuma hata
// verdiğinde koruma hiç kurulmaz ve gönderim sessizce serbest kalır.
window.addEventListener(
  "keydown",
  (event) => {
    if (synthetic.has(event)) return;
    if (event.key !== "Enter" || event.isComposing) return;
    // Bazı arayüzler Cmd/Ctrl+Enter ile gönderir; Shift/Alt+Enter satır atlar.
    if (event.shiftKey || event.altKey) return;

    const composer = findComposer(event.composedPath?.()[0] || event.target);
    if (!composer) return;
    const text = readComposerText(composer);
    const decision = promptDecision(text);
    if (!decision) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    guardPrompt({ text, ...decision, composer, caret: null, mode: "send" });
  },
  true
);

window.addEventListener(
  "click",
  (event) => {
    if (!promptGuardActive()) return;
    const path = event.composedPath?.() || [event.target];
    const button = isSendControl(path);
    if (!button) return;

    const composer = composerForSend(button);
    if (!composer) return;
    const text = readComposerText(composer);
    const decision = promptDecision(text);
    if (!decision) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    guardPrompt({ text, ...decision, composer, caret: null, mode: "send" });
  },
  true
);

configurePageGuard();

// Korunan bir sayfa açıldı: motoru şimdiden kurdur ki ilk sürüklemede model
// yüklenmesi beklenmesin. Sayfanın kendi yüklenmesiyle yarışmamak için beklenir.
setTimeout(() => {
  if (settingsReady && !settings.enabled) return;
  sendRuntimeMessageBestEffort({ type: MSG.ensureEngine });
}, 1500);
