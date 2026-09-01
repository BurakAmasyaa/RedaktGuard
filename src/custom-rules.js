import { findFoldedOccurrences, foldForMatching } from "./text-match.js";

function validateRule(rule, index) {
  // Kural metni kırpılır: Excel'den yapıştırmada kalan sondaki boşluk,
  // eşleşmenin sağ sınırını kaydırıp kuralı yanlış yere uyguluyordu.
  // Kurumsal kurallar (rule-source.js) zaten kırpılıyordu.
  const find = String(rule.find || "").trim();
  const replacement = String(rule.replacement || "").trim();
  if (!find && !replacement) return null;
  if (!find || !replacement) {
    throw new Error(`${index + 1}. özel kuralda hem “Bul” hem “Şununla değiştir” alanını doldurun.`);
  }
  if (find === replacement) throw new Error(`${index + 1}. özel kuralda aranan ve yeni değer aynı olamaz.`);
  return { id: rule.id || `rule_${index + 1}`, find, replacement, exact: Boolean(rule.exact) };
}

export function normalizeCustomRules(rules) {
  const normalized = rules.map(validateRule).filter(Boolean);
  const unique = new Map();
  // Eşleşme harf duyarsız olduğu için "Kerem" ve "KEREM" aynı kuraldır;
  // ikisi de listede kalırsa aynı yer iki kez aday olur.
  for (const rule of normalized) unique.set(foldForMatching(rule.find), rule);
  return [...unique.values()];
}

// Kurumsal kurallar ile kendi kuralların aynı normalizasyonu kullanır.
// Ayrıştıklarında aynı kural metni, kurumsal listeden geldiğinde belgedeki
// diyakritiksiz yazımı buluyor, kullanıcının kural kutusundan geldiğinde
// hiç bulamıyordu; kullanıcı kuralını yazdığı için maskelendiğini sanıyordu.
export function normalizeTurkishForComparison(value) {
  return foldForMatching(value).replace(/\s+/gu, " ").trim();
}

export function levenshteinDistance(left, right, limit = Number.POSITIVE_INFINITY) {
  const source = [...String(left)];
  const target = [...String(right)];
  if (Math.abs(source.length - target.length) > limit) return limit + 1;
  let previous = target.map((_, index) => index + 1);
  previous.unshift(0);

  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = [sourceIndex];
    let rowMinimum = current[0];
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const substitution = previous[targetIndex - 1] + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1);
      const value = Math.min(previous[targetIndex] + 1, current[targetIndex - 1] + 1, substitution);
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[target.length];
}

function comparisonTokens(value) {
  const tokens = [];
  for (const match of String(value).matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.push({ raw: match[0], normalized: normalizeTurkishForComparison(match[0]), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

// Bulanıklık kelime uzunluğuna göre ölçeklenir. Kısa kelimede tek harflik
// tolerans bile felakettir: "Ak" kuralı "Ok"u, "Merve" kuralı "Serve"i yakalar.
// Beş harften kısa kelimede hiç bulanıklık yoktur; asıl çözüm kuralın kendi
// TamEslesme anahtarıdır (SQL tablosunda TamEslesme = 1).
export function tokenTolerance(token, exact = false) {
  if (exact) return 0;
  const length = [...token].length;
  if (length < 5) return 0;
  return length < 8 ? 1 : 2;
}

export function normalizeImportedRules(rules) {
  const normalized = rules.map((rule, index) => {
    const validated = validateRule(rule, index);
    if (!validated) return null;
    const comparison = normalizeTurkishForComparison(validated.find);
    if (!comparisonTokens(comparison).length) throw new Error(`${index + 1}. kuralda karşılaştırılabilir bir ifade yok.`);
    return { ...validated, comparison };
  }).filter(Boolean);
  const unique = new Map();
  for (const rule of normalized) unique.set(rule.comparison, rule);
  return [...unique.values()];
}

// Bir kelimeden en fazla k karakter silinerek üretilen tüm varyantlar.
// SymSpell özelliği: iki kelimenin düzenleme uzaklığı k'yı geçmiyorsa
// silme varyantı kümeleri mutlaka kesişir. Böylece bulanık eşleşme
// adayları tek tek karşılaştırma yerine hash aramasıyla bulunabilir.
function deletionVariants(word, k) {
  const variants = new Set([word]);
  let frontier = [[...word]];
  for (let depth = 0; depth < k; depth += 1) {
    const next = [];
    for (const characters of frontier) {
      for (let index = 0; index < characters.length; index += 1) {
        const reduced = characters.slice(0, index).concat(characters.slice(index + 1));
        const key = reduced.join("");
        if (!variants.has(key)) {
          variants.add(key);
          next.push(reduced);
        }
      }
    }
    frontier = next;
  }
  return variants;
}

const MAX_QUERY_DELETIONS = 2;

// Kural listesini bir kez indeksler. Aynı indeks tüm belge ve batch'lerde kullanılır.
export function buildImportedRuleIndex(rules) {
  const validRules = normalizeImportedRules(rules);
  const byVariant = new Map();
  const entries = [];

  validRules.forEach((rule, ruleIndex) => {
    const tokens = comparisonTokens(rule.comparison);
    if (!tokens.length) return;
    // Çapa: kuralın en uzun kelimesi. En seçici olan odur, en az yanlış aday üretir.
    let anchorOffset = 0;
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index].normalized.length > tokens[anchorOffset].normalized.length) anchorOffset = index;
    }
    const anchor = tokens[anchorOffset].normalized;
    const entry = { rule, ruleIndex, tokens, anchorOffset, exact: Boolean(rule.exact) };
    entries.push(entry);
    for (const variant of deletionVariants(anchor, tokenTolerance(anchor, entry.exact))) {
      const bucket = byVariant.get(variant);
      if (bucket) bucket.push(entry);
      else byVariant.set(variant, [entry]);
    }
  });

  return { byVariant, entries };
}

function matchesAt(entry, documentTokens, startIndex) {
  if (startIndex < 0 || startIndex + entry.tokens.length > documentTokens.length) return false;
  for (let index = 0; index < entry.tokens.length; index += 1) {
    const ruleToken = entry.tokens[index].normalized;
    const tolerance = tokenTolerance(ruleToken, entry.exact);
    if (levenshteinDistance(ruleToken, documentTokens[startIndex + index].normalized, tolerance) > tolerance) return false;
  }
  return true;
}

export function detectImportedRules(units, rules, options = {}) {
  const built = options.index || buildImportedRuleIndex(rules);
  const unitOffset = Number(options.unitOffset) || 0;
  const matchesByEntry = new Map();
  const variantCache = options.variantCache || new Map();

  for (let localUnitIndex = 0; localUnitIndex < units.length; localUnitIndex += 1) {
    const input = units[localUnitIndex];
    const text = typeof input === "string" ? input : String(input.text || "");
    const location = typeof input === "string" ? { kind: "text", unitIndex: localUnitIndex + unitOffset } : input.location;
    const documentTokens = comparisonTokens(text);
    // Aynı kuralın eşleşmeleri çakışmaz: bir eşleşmeden sonra o kural için
    // izin verilen bir sonraki başlangıç, eşleşmenin bittiği yerdir.
    const nextAllowedStart = new Map();

    for (let position = 0; position < documentTokens.length; position += 1) {
      const token = documentTokens[position].normalized;
      let queryVariants = variantCache.get(token);
      if (!queryVariants) {
        queryVariants = deletionVariants(token, MAX_QUERY_DELETIONS);
        variantCache.set(token, queryVariants);
      }

      const considered = new Set();
      for (const variant of queryVariants) {
        const bucket = built.byVariant.get(variant);
        if (!bucket) continue;
        for (const entry of bucket) {
          if (considered.has(entry)) continue;
          considered.add(entry);
          const startIndex = position - entry.anchorOffset;
          if (startIndex < (nextAllowedStart.get(entry) ?? 0)) continue;
          if (!matchesAt(entry, documentTokens, startIndex)) continue;

          const first = documentTokens[startIndex];
          const last = documentTokens[startIndex + entry.tokens.length - 1];
          const matchedText = text.slice(first.start, last.end);
          let record = matchesByEntry.get(entry);
          if (!record) matchesByEntry.set(entry, (record = { locations: [], variants: new Set() }));
          record.variants.add(matchedText);
          record.locations.push({ unitIndex: localUnitIndex + unitOffset, start: first.start, end: last.end, location, matchedText });
          nextAllowedStart.set(entry, startIndex + entry.tokens.length);
        }
      }
    }
  }

  const findings = [];
  for (const entry of built.entries) {
    const record = matchesByEntry.get(entry);
    if (!record) continue;
    const { rule } = entry;
    findings.push({
      id: `imported_${rule.id || entry.ruleIndex + 1}`,
      source: "imported-rule",
      category: "custom",
      label: "İçe aktarılan kural",
      value: record.variants.values().next().value || rule.find,
      ruleText: rule.find,
      originalText: rule.find,
      replacementText: rule.replacement,
      normalized: rule.comparison,
      count: record.locations.length,
      exact: Boolean(rule.exact),
      confidence: "exact",
      placeholder: rule.replacement,
      variants: [...record.variants],
      locations: record.locations,
    });
  }
  return findings;
}

export async function detectImportedRulesBatched(units, rules, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize) || 100);
  const findingsById = new Map();
  // İndeks ve varyant önbelleği batch'ler arasında paylaşılır; her batch'te yeniden kurulmaz.
  const index = options.index || buildImportedRuleIndex(rules);
  const variantCache = new Map();
  for (let start = 0; start < units.length; start += batchSize) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
    const batchFindings = detectImportedRules(units.slice(start, start + batchSize), rules, { unitOffset: start, index, variantCache });
    for (const finding of batchFindings) {
      const current = findingsById.get(finding.id);
      if (!current) findingsById.set(finding.id, finding);
      else {
        current.count += finding.count;
        current.locations.push(...finding.locations);
        current.variants = [...new Set([...current.variants, ...finding.variants])];
      }
    }
    options.onProgress?.({ current: Math.min(start + batchSize, units.length), total: units.length });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return [...findingsById.values()];
}

// Kendi kuralların büyük/küçük harfe takılmaz.
//
// Kullanıcı kuralını "Kerem" diye yazar; belge o adı "KEREM" biçiminde
// taşıyabilir — resmî evrakta neredeyse her zaman öyle taşır. Eşleşme birebir
// yapıldığında kural sessizce hiçbir şey yakalamıyor, kullanıcı da kuralını
// yazdığı için maskelendiğini sanıyordu. Kurumsal kurallar zaten harf duyarsız
// karşılaştırılıyordu; kendi kuralların da aynı davranışa alındı.
//
// Sınır denetimi eklendi: harf duyarsız aramada sınırsız alt dize eşleşmesi
// tehlikelidir ("Ali" kuralı "kalite"nin içini yakalardı).
export function detectCustomRules(units, rules) {
  const validRules = normalizeCustomRules(rules);
  return validRules.map((rule, ruleIndex) => {
    const locations = [];
    const variants = new Set();
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
      const input = units[unitIndex];
      const text = typeof input === "string" ? input : String(input.text || "");
      const location = typeof input === "string" ? { kind: "text", unitIndex } : input.location;
      for (const hit of findFoldedOccurrences(text, rule.find, { wholeWord: true })) {
        variants.add(hit.text);
        locations.push({ unitIndex, start: hit.start, end: hit.end, location });
      }
    }
    return {
      id: `custom_${ruleIndex + 1}`,
      source: "custom",
      category: "custom",
      label: "Kendi kuralın",
      value: rule.find,
      originalText: rule.find,
      replacementText: rule.replacement,
      normalized: rule.find,
      count: locations.length,
      confidence: "custom",
      placeholder: rule.replacement,
      // Maskeleme belgedeki yazımı arar; bulunan her yazım varyant olarak taşınır.
      variants: variants.size ? [...variants] : [rule.find],
      locations,
    };
  }).filter((finding) => finding.count > 0);
}
