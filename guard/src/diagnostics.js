// Tanılama çıktısı destek ekibine gönderilebilir olmalı, fakat destek için
// belge içeriği gerekmez. Bu modül bütün girdileri kesin bir allowlist'e
// indirger; bilinmeyen alanlar, dosya adı, URL, prompt ve hata metni düşer.

export const DIAGNOSTIC_SCHEMA = 1;
export const DIAGNOSTIC_EVENTS_KEY = "guard.diagnosticEvents";

const SITES = new Set(["chatgpt", "claude", "gemini", "copilot"]);
const ARTIFACTS = new Set(["file", "image", "prompt-paste", "prompt-send"]);
const OUTCOMES = new Set(["success", "blocked", "failed", "cancelled"]);
const DEVICES = new Set(["webgpu", "wasm", "cpu", "unknown"]);
const DELIVERY_METHODS = new Set(["main-drop", "file-input", "clipboard", "synthetic-drop", "none", "unknown"]);
const STAGES = new Set(["start", "engine", "scan", "mask", "delivery", "ready", "audit", "error"]);
const FORMATS = new Set(["docx", "xlsx", "pdf", "txt", "jpg", "jpeg", "png"]);
const DURATION_FIELDS = ["scanMs", "maskMs", "deliveryMs", "totalMs"];

function iso(value, fallback = null) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function boundedInteger(value, maximum = 15 * 60_000) {
  const number = Math.round(Number(value));
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : 0;
}

function safeCode(value, fallback = "unknown") {
  const code = String(value || "").toLowerCase();
  return /^[a-z][a-z0-9-]{0,47}$/u.test(code) ? code : fallback;
}

function formatsOf(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((format) => FORMATS.has(format)))];
}

export function normalizeDiagnosticEvent(input) {
  const event = input && typeof input === "object" ? input : {};
  if (event.schema !== DIAGNOSTIC_SCHEMA) throw new Error("Tanılama olayı şeması geçersiz.");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(String(event.operationId || ""))) {
    throw new Error("Tanılama işlem kimliği geçersiz.");
  }
  if (!SITES.has(event.site) || !ARTIFACTS.has(event.artifact) || !OUTCOMES.has(event.outcome)) {
    throw new Error("Tanılama işlem türü geçersiz.");
  }

  const startedAt = iso(event.startedAt);
  const finishedAt = iso(event.finishedAt);
  if (!startedAt || !finishedAt) throw new Error("Tanılama zamanı geçersiz.");

  const durations = {};
  for (const field of DURATION_FIELDS) durations[field] = boundedInteger(event.durations?.[field]);

  return {
    schema: DIAGNOSTIC_SCHEMA,
    operationId: String(event.operationId),
    startedAt,
    finishedAt,
    site: event.site,
    artifact: event.artifact,
    outcome: event.outcome,
    fileCount: boundedInteger(event.fileCount, 100),
    formats: formatsOf(event.formats),
    findingCount: boundedInteger(event.findingCount, 1_000_000),
    durations,
    device: DEVICES.has(event.device) ? event.device : "unknown",
    deliveryMethod: DELIVERY_METHODS.has(event.deliveryMethod) ? event.deliveryMethod : "unknown",
    lastStage: STAGES.has(event.lastStage) ? event.lastStage : "error",
    errorCode: event.outcome === "success" ? null : safeCode(event.errorCode),
  };
}

function runtimeInfo(userAgent = "", platform = "") {
  const ua = String(userAgent);
  const edge = /Edg\/([\d.]+)/u.exec(ua);
  const chrome = /(?:Chrome|Chromium)\/([\d.]+)/u.exec(ua);
  const browser = edge ? { family: "Edge", version: edge[1] } : chrome ? { family: "Chrome", version: chrome[1] } : {
    family: "Chromium-compatible",
    version: "unknown",
  };
  const platformText = `${platform} ${ua}`;
  const os = /Windows/iu.test(platformText)
    ? "Windows"
    : /CrOS/iu.test(platformText)
      ? "ChromeOS"
      : /Mac/iu.test(platformText)
        ? "macOS"
        : /Linux/iu.test(platformText)
          ? "Linux"
          : "unknown";
  return { browser, os };
}

function stageOf(step) {
  const value = String(step || "").toLowerCase();
  if (/hata|başarısız|çök|koptu|kurulamadı/u.test(value)) return { stage: "error", status: "failed" };
  if (/audit/u.test(value)) return { stage: "audit", status: "info" };
  if (/teslim|upload|yükle/u.test(value)) return { stage: "delivery", status: "info" };
  if (/mask/u.test(value)) return { stage: "mask", status: "info" };
  if (/scan|tara/u.test(value)) return { stage: "scan", status: "info" };
  if (/motor|offscreen|röle|ısınma|port/u.test(value)) return { stage: "engine", status: "info" };
  return { stage: "start", status: "info" };
}

function safeTrace(trace) {
  const output = [];
  for (const raw of Array.isArray(trace) ? trace : []) {
    const at = iso(raw?.at);
    if (!at) continue;
    output.push({ at, ...stageOf(raw?.step) });
  }
  return output.slice(-40);
}

export function createDiagnosticReport({
  version,
  userAgent,
  platform,
  locale,
  profile,
  serverConfigured,
  rulesStatus,
  rulesCount,
  engineDevice,
  engineRecovered,
  auditPending,
  trace,
  events,
  generatedAt = new Date().toISOString(),
} = {}) {
  const timeline = safeTrace(trace);
  const operations = [];
  for (const event of Array.isArray(events) ? events : []) {
    try {
      operations.push(normalizeDiagnosticEvent(event));
    } catch {
      // Bozuk/eski olay rapora girmez.
    }
  }
  const runtime = runtimeInfo(userAgent, platform);
  return {
    schema: DIAGNOSTIC_SCHEMA,
    generatedAt: iso(generatedAt, new Date().toISOString()),
    guard: {
      name: "Redakt Guard",
      version: /^\d{1,4}(?:\.\d{1,4}){0,3}$/u.test(String(version || "")) ? String(version) : "unknown",
    },
    runtime: {
      ...runtime,
      locale: /^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(String(locale || "")) ? String(locale) : "unknown",
    },
    policy: {
      profile: ["fast", "balanced", "thorough"].includes(profile) ? profile : "unknown",
      serverConfigured: Boolean(serverConfigured),
      rulesStatus: ["ready", "stale", "unavailable", "loading"].includes(rulesStatus) ? rulesStatus : "unknown",
      rulesCount: boundedInteger(rulesCount, 1_000_000),
    },
    engine: {
      device: DEVICES.has(engineDevice) ? engineDevice : "unknown",
      recoveredAfterCrash: Boolean(engineRecovered),
    },
    audit: { pendingCount: boundedInteger(auditPending, 500) },
    recentOperations: operations.slice(-30),
    trace: {
      lastStage: timeline.at(-1)?.stage || "start",
      timeline,
    },
    privacy: {
      containsFileNames: false,
      containsDocumentContent: false,
      containsPromptText: false,
      containsDetectedValues: false,
      containsServerUrl: false,
    },
  };
}
