// Prompt metninin hızlı katmanı. İçerik betiğinin içinde, EŞZAMANLI çalışır.
//
// Neden burada: gönderim tuşuna basıldığında karar milisaniyeler içinde
// verilmeli. Offscreen belgeye gidip dönmek her mesajda göze batan bir gecikme
// yaratırdı. Bu iki modül (pii.js, custom-rules.js) hiçbir şeye bağımlı değil
// ve kapalı bir küme oluşturur; modeli, OCR'ı veya belge hattını içeri almazlar.
//
// Ölçüm: 37.600 karakterlik metinde desen katmanı 2,6 ms.

import { detectLabelledFields } from "../../../src/field-labels.js";
import { aggregateFindings, createReplacementMap, mergeFindings, replaceText } from "../../../src/pii.js";
import { buildImportedRuleIndex, detectImportedRules, normalizeImportedRules } from "../../../src/custom-rules.js";

// Bunun ötesinde tarama offscreen belgeye devredilir; sayfa donmaz.
// Ölçüm (3 kurumsal kural): 10 KB 3 ms · 50 KB ~12 ms · 100 KB 25 ms ·
// 500 KB 148 ms. Yoğun PII'de 500 KB 3,8 s tarama + 6,8 s maskeleme —
// bu yüzden sınır ölçülen en kötü duruma göre seçildi, ortalamaya göre değil.
export const SYNC_SCAN_LIMIT = 50_000;

// Kuralların normalize edilmiş hâli DE indeksi DE önbelleğe alınır: indeks
// her Enter'da sıfırdan kurulursa 5.000 kuralda tuşa her basış 129 ms sürer.
let ruleCache = { source: null, rules: [], index: null };

export function primeRules(rules) {
  if (ruleCache.source === rules) return ruleCache.rules;
  let normalized = [];
  try {
    normalized = normalizeImportedRules(rules || []);
  } catch {
    // Tek bozuk kural listeyi düşürmesin.
    for (const rule of rules || []) {
      try {
        normalized.push(...normalizeImportedRules([rule]));
      } catch {
        /* atlanır */
      }
    }
  }
  ruleCache = {
    source: rules,
    rules: normalized,
    index: normalized.length ? buildImportedRuleIndex(normalized) : null,
  };
  return normalized;
}

export function scanPromptText(text, rules) {
  const units = [String(text)];
  const imported = primeRules(rules);
  // Sıra ve birleştirme belge yoluyla aynı: aynı değeri iki katman da
  // bulduysa tek satıra iner ve yer tutucular birleşik liste üzerinde
  // numaralanır. Alan etiketi katmanı burada da çalışır — resmî evrakın
  // METNİ prompt kutusuna yapıştırıldığında "Adı : SAMET" satırı aksi hâlde
  // hiçbir katmana takılmıyordu.
  const found = mergeFindings([
    imported.length ? detectImportedRules(units, imported, { index: ruleCache.index }) : [],
    aggregateFindings(units),
    detectLabelledFields(units),
  ]);
  // Kimlikler belge bulgularıyla çakışmasın; panel gruplaması scope'a bakar.
  return found.map((finding, index) => ({ ...finding, id: `p_${index + 1}`, scope: "prompt" }));
}

export function maskPromptText(text, findings, selectedIds) {
  const selected = new Set(selectedIds);
  const picks = findings.filter((finding) => selected.has(finding.id));
  if (!picks.length) return String(text);
  const map = createReplacementMap(picks, picks.map((finding) => finding.id));
  return replaceText(String(text), map, { unitIndex: 0 });
}
