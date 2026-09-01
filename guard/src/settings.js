// Ayarlar ve kurumsal kural önbelleği. chrome.storage'a doğrudan erişebilen
// bağlamlar (service worker, ayarlar sayfası ve içerik betiği) bu modülü
// kullanır. Offscreen belge yalnız chrome.runtime kullanabildiği için bu
// verilere service worker mesajları üzerinden ulaşır.

export const SETTINGS_KEY = "guard.settings";
export const RULES_KEY = "guard.rules";
// Motorun ısınırken saptadığı çalışma donanımı (webgpu | wasm).
export const DEVICE_KEY = "guard.device";
// Motor akışının bıraktığı iz. Yalnız adım adları ve zaman damgaları tutulur —
// dosya adı, içerik veya bulgu ASLA yazılmaz.
export const TRACE_KEY = "guard.trace";
// Motor tarama ortasında çöktüyse işaretlenir; sonraki deneme GPU'yu atlayıp
// güvenli WASM yolundan gider. Yavaş ama çalışır.
export const CRASH_KEY = "guard.engineCrashed";

// Bu dağıtım şirket içidir. Yerel storage veya ayarlar ekranı bu alanları
// gevşetemez; taranamayan/uyarılı içerik ham geçemez ve bulunan her şey
// otomatik maskelenir. Eklentinin kaldırılmasını ayrıca GPO/Intune engeller.
export const ENTERPRISE_POLICY = Object.freeze({
  enabled: true,
  networkGuard: true,
  blockUnscannable: true,
  allowUnmaskedOverride: false,
  autoSelectProbable: true,
  automaticMasking: true,
  guardPrompts: true,
});

export const DEFAULT_SETTINGS = Object.freeze({
  // Ana anahtar. Kapalıyken hiçbir yüklemeye dokunulmaz.
  enabled: true,
  // Redakt On-Premise sunucusunun kökü. Kurumsal kurallar buradan okunur.
  serverUrl: "",
  // Tarama derinliği: fast | balanced | thorough
  profile: "balanced",
  // Kişi/kurum gibi model bulguları panelde baştan seçili gelsin mi.
  autoSelectProbable: true,
  // Çalışan "maskesiz gönder" diyebilsin mi. Kurumsal kurulumda kapatılır.
  allowUnmaskedOverride: false,
  // Bulgular kullanıcı seçimi olmadan tamamen maskelenir.
  automaticMasking: true,
  // Motorun açamadığı türler (zip, csv, pptx...) engellensin mi.
  blockUnscannable: true,
  // Ağ katmanı koruması: araya girilemeyen bir yükleme çıkarsa durdurulur.
  networkGuard: true,
  // Prompt metni koruması: yapıştırma ve gönderim taranır.
  guardPrompts: true,
  // Prompt taramasında yerel model de çalışsın mı. Kişi ve kurum adlarını
  // yakalar ama her gönderime saniyeler ekler; bu yüzden varsayılan kapalı.
  promptModelScan: false,
});

export function coerceSettings(stored) {
  const settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  for (const key of Object.keys(settings)) {
    if (!(key in DEFAULT_SETTINGS)) delete settings[key];
    else if (typeof DEFAULT_SETTINGS[key] === "boolean") settings[key] = Boolean(settings[key]);
  }
  settings.serverUrl = String(settings.serverUrl || "").trim().replace(/\/+$/u, "");
  if (!["fast", "balanced", "thorough"].includes(settings.profile)) settings.profile = DEFAULT_SETTINGS.profile;
  Object.assign(settings, ENTERPRISE_POLICY);
  return settings;
}

export async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return coerceSettings(stored?.[SETTINGS_KEY]);
}

export async function writeSettings(patch) {
  const next = coerceSettings({ ...(await readSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function readRules() {
  const stored = await chrome.storage.local.get(RULES_KEY);
  const cache = stored?.[RULES_KEY];
  return {
    rules: Array.isArray(cache?.rules) ? cache.rules : [],
    status: cache?.status || "unavailable",
    message: cache?.message || null,
    fetchedAt: cache?.fetchedAt || null,
  };
}

export async function writeRules(cache) {
  await chrome.storage.local.set({ [RULES_KEY]: cache });
  return cache;
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    callback(coerceSettings(changes[SETTINGS_KEY].newValue));
  });
}
