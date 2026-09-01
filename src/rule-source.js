// Uygulamada ağ erişimi YALNIZCA bu modülde bulunur.
// Buradan sunucuya hiçbir belge içeriği gönderilmez; sadece kural listesi okunur.
// İstek gövdesiz GET'tir ve yanıt kurumsal kural listesidir.

const RULES_ENDPOINT = "/api/rules";
const REQUEST_TIMEOUT_MS = 15000;

export const RULE_SOURCE_STATUS = Object.freeze({
  loading: "loading",
  ready: "ready",
  stale: "stale",
  unavailable: "unavailable",
});

function toRules(payload) {
  if (!Array.isArray(payload?.rules)) return [];
  return payload.rules
    .map((rule) => ({
      id: String(rule.id),
      find: String(rule.find ?? "").trim(),
      replacement: String(rule.replacement ?? "").trim(),
      category: rule.category ? String(rule.category) : null,
      // TamEslesme = 1 olan kural bulanık eşleşmeye kapalıdır. Kısa marka
      // adlarında ("Siskon") bulanıklık "Piston"u da maskeler.
      exact: Boolean(rule.exact),
    }))
    .filter((rule) => rule.find && rule.replacement);
}

export async function fetchCorporateRules({ fetchImpl = globalThis.fetch, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetchImpl(RULES_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        status: RULE_SOURCE_STATUS.unavailable,
        rules: [],
        message: "Kural sunucusu bulunamadı. Uygulama Redakt On-Premise servisi üzerinden açılmalı.",
      };
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        status: RULE_SOURCE_STATUS.unavailable,
        rules: [],
        message: payload?.message || "Kurumsal kural listesi yüklenemedi.",
        detail: payload?.detail || null,
      };
    }

    const rules = toRules(payload);
    return {
      status: payload?.stale ? RULE_SOURCE_STATUS.stale : RULE_SOURCE_STATUS.ready,
      rules,
      duplicates: payload?.duplicates || [],
      fetchedAt: payload?.fetchedAt || null,
      message: payload?.warning || null,
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      status: RULE_SOURCE_STATUS.unavailable,
      rules: [],
      message: aborted
        ? "Kural sunucusuna zaman aşımı nedeniyle ulaşılamadı."
        : "Kural sunucusuna ulaşılamıyor. Ağ bağlantınızı veya servisin çalıştığını kontrol edin.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function describeRuleSource(state) {
  if (!state) return "Kurumsal kurallar yükleniyor…";
  switch (state.status) {
    case RULE_SOURCE_STATUS.loading:
      return "Kurumsal kurallar yükleniyor…";
    case RULE_SOURCE_STATUS.ready:
      return state.rules.length
        ? `${state.rules.length} kurumsal kural etkin. Karşılaştırma yalnızca bu cihazda yapılır.`
        : "Veritabanında tanımlı aktif kural yok.";
    case RULE_SOURCE_STATUS.stale:
      return state.message || "Kurallar yenilenemedi, son bilinen kopya kullanılıyor.";
    default:
      return state.message || "Kurumsal kural listesi yüklenemedi.";
  }
}

// Kurallar yüklenemediğinde belge eksik maskelenebilir; bu sessizce geçilmemeli.
export function shouldWarnBeforeScan(state) {
  return !state || state.status === RULE_SOURCE_STATUS.unavailable || state.status === RULE_SOURCE_STATUS.stale;
}
