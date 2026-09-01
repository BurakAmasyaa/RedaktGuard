// Uzantı geliştirici modunda yenilendiğinde açık sekmelerdeki eski içerik
// betiği yaşamaya devam eder, ancak chrome.runtime bağı kopar. Kritik motor
// çağrıları açık bir "sayfayı yenile" hatası vermeli; rozet/audit gibi yardımcı
// bildirimler ise maskelenmiş içeriğin teslimini hiçbir zaman bozmamalı.

export const RUNTIME_RELOAD_MESSAGE =
  "Redakt Guard güncellendi veya bağlantısı kesildi; bu sayfayı yenileyip dosyayı tekrar bırakın.";

export function runtimeOrThrow(scope = globalThis) {
  const runtime = scope?.chrome?.runtime;
  if (!runtime?.id || typeof runtime.sendMessage !== "function" || typeof runtime.connect !== "function") {
    throw new Error(RUNTIME_RELOAD_MESSAGE);
  }
  return runtime;
}

function normalizedRuntimeError(error) {
  const message = String(error?.message || error || "");
  return /extension context invalidated|cannot read properties of undefined|context.*invalid/iu.test(message)
    ? new Error(RUNTIME_RELOAD_MESSAGE)
    : error instanceof Error
      ? error
      : new Error(message || RUNTIME_RELOAD_MESSAGE);
}

export async function sendRuntimeMessage(message, scope = globalThis) {
  const runtime = runtimeOrThrow(scope);
  try {
    return await runtime.sendMessage(message);
  } catch (error) {
    throw normalizedRuntimeError(error);
  }
}

export function connectRuntime(options, scope = globalThis) {
  const runtime = runtimeOrThrow(scope);
  try {
    return runtime.connect(options);
  } catch (error) {
    throw normalizedRuntimeError(error);
  }
}

export function sendRuntimeMessageBestEffort(message, scope = globalThis) {
  try {
    const runtime = scope?.chrome?.runtime;
    if (!runtime?.id || typeof runtime.sendMessage !== "function") return false;
    Promise.resolve(runtime.sendMessage(message)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
