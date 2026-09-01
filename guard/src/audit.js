// Audit olayına yalnız sayısal özet girer. Bulguların value/ruleText/placeholder
// alanları bu modülün çıktısına hiçbir koşulda taşınmaz.

export const AUDIT_ENDPOINT = "/api/audit/masking";
export const AUDIT_QUEUE_KEY = "guard.auditQueue";

const CATEGORIES = new Set([
  "email", "phone", "iban", "tc", "card", "person", "organization", "location", "documentNumber", "custom",
]);
const SOURCES = new Set(["pattern", "ner", "field", "imported-rule", "custom"]);
const SCOPES = new Set(["document", "filename", "prompt"]);
const SITES = new Set(["chatgpt", "claude", "gemini", "copilot"]);
const ARTIFACTS = new Set(["file", "prompt-paste", "prompt-send"]);

function increment(target, key, amount) {
  if (!key || amount <= 0) return;
  target[key] = (target[key] || 0) + amount;
}

function positiveCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
}

export function summarizeSelectedFindings(findings, selectedIds) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const summary = {
    selectedFindings: 0,
    maskedOccurrences: 0,
    categories: {},
    sources: {},
    scopes: {},
  };

  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!selected.has(finding?.id)) continue;
    const category = CATEGORIES.has(finding.category) ? finding.category : null;
    const source = SOURCES.has(finding.source) ? finding.source : null;
    const scope = SCOPES.has(finding.scope) ? finding.scope : "document";
    const occurrences = positiveCount(finding.count);
    summary.selectedFindings += 1;
    summary.maskedOccurrences += occurrences;
    increment(summary.categories, category, occurrences);
    increment(summary.sources, source, occurrences);
    increment(summary.scopes, scope, occurrences);
  }
  return summary;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) increment(target, key, Number(value) || 0);
}

export function createAuditEvent({ site, artifact, summaries, formats = [], eventId, createdAt } = {}) {
  if (!SITES.has(site) || !ARTIFACTS.has(artifact)) throw new Error("Audit hedefi veya türü geçersiz.");
  const summary = {
    fileCount: artifact === "file" ? Math.max(1, formats.length) : 0,
    formats: artifact === "file" ? [...new Set(formats.filter((value) => /^[a-z0-9]{1,12}$/u.test(value)))] : [],
    selectedFindings: 0,
    maskedOccurrences: 0,
    categories: {},
    sources: {},
    scopes: {},
  };
  for (const item of Array.isArray(summaries) ? summaries : []) {
    summary.selectedFindings += Number(item?.selectedFindings) || 0;
    summary.maskedOccurrences += Number(item?.maskedOccurrences) || 0;
    mergeCounts(summary.categories, item?.categories);
    mergeCounts(summary.sources, item?.sources);
    mergeCounts(summary.scopes, item?.scopes);
  }
  if (!summary.selectedFindings || !summary.maskedOccurrences) return null;
  return {
    schema: 1,
    eventId: eventId || crypto.randomUUID(),
    createdAt: createdAt || new Date().toISOString(),
    site,
    artifact,
    outcome: "masked",
    summary,
  };
}

// Background, içerik betiğinden gelen nesneye güvenmez. JSON turu ve kesin
// alan seçimi, sonradan eklenmiş ham bir alanın kuyruğa/sunucuya taşınmasını önler.
export function normalizeAuditEvent(input) {
  const event = input && typeof input === "object" ? input : {};
  if (event.schema !== 1 || !SITES.has(event.site) || !ARTIFACTS.has(event.artifact) || event.outcome !== "masked") {
    throw new Error("Audit olayı geçersiz.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(String(event.eventId || ""))) throw new Error("Audit kimliği geçersiz.");
  if (!Number.isFinite(Date.parse(event.createdAt))) throw new Error("Audit zamanı geçersiz.");

  const source = event.summary && typeof event.summary === "object" ? event.summary : {};
  const readCount = (value) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000) throw new Error("Audit sayacı geçersiz.");
    return number;
  };
  const counts = (value, allowed) => {
    const output = {};
    for (const [key, raw] of Object.entries(value && typeof value === "object" ? value : {})) {
      if (!allowed.has(key)) throw new Error("Audit kategorisi geçersiz.");
      output[key] = readCount(raw);
    }
    return output;
  };
  const formats = Array.isArray(source.formats)
    ? [...new Set(source.formats.map(String).filter((value) => /^[a-z0-9]{1,12}$/u.test(value)))].slice(0, 16)
    : [];
  const normalized = {
    schema: 1,
    eventId: String(event.eventId),
    createdAt: new Date(event.createdAt).toISOString(),
    site: event.site,
    artifact: event.artifact,
    outcome: "masked",
    summary: {
      fileCount: readCount(source.fileCount),
      formats,
      selectedFindings: readCount(source.selectedFindings),
      maskedOccurrences: readCount(source.maskedOccurrences),
      categories: counts(source.categories, CATEGORIES),
      sources: counts(source.sources, SOURCES),
      scopes: counts(source.scopes, SCOPES),
    },
  };
  if (!normalized.summary.selectedFindings || !normalized.summary.maskedOccurrences) throw new Error("Boş audit olayı yazılamaz.");
  return normalized;
}
