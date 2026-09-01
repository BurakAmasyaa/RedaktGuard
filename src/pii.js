import { createFoldedIndex, foldForMatching, findOccurrences } from "./text-match.js";

const CATEGORY_META = {
  email: { label: "E-posta", prefix: "EMAIL", confidence: "exact" },
  phone: { label: "Telefon", prefix: "TELEFON", confidence: "probable" },
  iban: { label: "IBAN", prefix: "IBAN", confidence: "exact" },
  tc: { label: "T.C. Kimlik No", prefix: "TC_KIMLIK", confidence: "exact" },
  card: { label: "Kredi Kartı", prefix: "KREDI_KARTI", confidence: "exact" },
  person: { label: "Kişi adı", prefix: "KISI", confidence: "probable" },
  organization: { label: "Kurum / şirket", prefix: "KURUM", confidence: "probable" },
  location: { label: "Adres/Konum", prefix: "KONUM", confidence: "probable" },
  // Belgenin kendi etiketiyle işaretlenmiş kayıt numaraları: adres no, cilt no,
  // aile sıra no, dosya no... Hiçbiri T.C. ya da IBAN gibi doğrulanabilir bir
  // desene uymaz, ama resmî evrakta kişiyi doğrudan işaret ederler.
  documentNumber: { label: "Belge / kayıt no", prefix: "BELGE_NO", confidence: "probable" },
  custom: { label: "Kendi kuralın", prefix: "OZEL", confidence: "custom" },
};

const CATEGORY_PRIORITY = { email: 0, iban: 1, tc: 2, card: 3, phone: 4, documentNumber: 5, person: 6, organization: 7, location: 8 };

const TR_PHONE_AREA_CODES = new Set([
  "212", "216", "222", "224", "226", "228", "232", "236", "242", "246", "248", "252", "256", "258",
  "262", "264", "266", "272", "274", "276", "282", "284", "286", "288", "312", "318", "322", "324",
  "326", "328", "332", "338", "342", "344", "346", "348", "352", "354", "356", "358", "362", "364",
  "366", "368", "370", "372", "374", "376", "378", "380", "382", "384", "386", "388", "412", "414",
  "416", "422", "424", "426", "428", "432", "434", "436", "438", "442", "446", "452", "454", "456",
  "458", "462", "464", "466", "472", "474", "476", "478", "482", "484", "486", "488", "501", "505",
  "506", "507", "510", "516", "530", "531", "532", "533", "534", "535", "536", "537", "538", "539",
  "540", "541", "542", "543", "544", "545", "546", "547", "548", "549", "551", "552", "553", "554",
  "555", "559", "561", "570", "571", "572", "573", "574", "575", "800", "850",
]);

// Word, Excel ve web'den kopyalanan metin ayırıcı olarak sık sık kırılmaz
// boşluk (U+00A0) ve tipografik tire üretir. ASCII sınıf bunları görmediği için
// "0532 111 22 33" ve "4111 1111 1111 1111" — gözle normal görünen, hatta
// "Telefon:" etiketiyle yazılmış numaralar — taramaya HİÇ girmiyor, bulgu
// listesinde çıkmıyor ve maskelenmemiş olarak çıktıya yazılıyordu. IBAN deseni
// \s kullandığı için bu arızadan etkilenmiyordu.
const HORIZONTAL_SPACE = " \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000";
const DASH = "\\-\\u2010-\\u2015\\u2212";
const CARD_SEPARATOR = `[${HORIZONTAL_SPACE}${DASH}]`;
// Telefonda nokta da ayırıcıdır; kartta değildir — "1.234.567.890.123" gibi
// binlik ayraçlı bir tutarı kart numarası sanmamak için.
const PHONE_SEPARATOR = `[${HORIZONTAL_SPACE}${DASH}.]`;

const PATTERNS = {
  // Sınıflar Unicode harf ve birleştirici işareti kapsar: ASCII sınıfla
  // "şeyma@..." yalnızca "eyma@..." olarak eşleşip adresin başını
  // maskelenmeden bırakıyordu; ayrışık (NFD) yazımda da aynı sonuç çıkıyor.
  // Sondaki bakış ileri YALNIZCA harfi yasaklar. "." ve "-" yasaklanırsa
  // cümle sonundaki "ulaşın: ahmet@ornek.com.tr." tamamen kaçırılır;
  // rakam yasaklanırsa dipnot işareti ("a@b.co.uk¹") eşleşmeyi "a@b.co"ya
  // kısaltır. Uzantı zaten açgözlü eşleştiği için harf yasağı yeterlidir.
  email: /(?<![\p{L}\p{M}\p{N}._%+\-])[\p{L}\p{M}\p{N}._%+\-]+@[\p{L}\p{M}\p{N}.\-]+\.[\p{L}\p{M}]{2,63}(?![\p{L}\p{M}])/giu,
  trIban: /(?<![A-Z0-9])TR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}(?![A-Z0-9])/giu,
  compactIban: /(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Z0-9])/giu,
  tc: /(?<!\d)[1-9]\d{10}(?!\d)/gu,
  card: new RegExp(`(?<!\\d)\\d(?:${CARD_SEPARATOR}?\\d){12,18}(?!\\d)`, "gu"),
  phone: new RegExp(
    `(?<!\\d)(?:(?:(?:\\+|00)90${PHONE_SEPARATOR}?|0)(?:\\(\\d{3}\\)|\\d{3})${PHONE_SEPARATOR}?\\d{3}${PHONE_SEPARATOR}?\\d{2}${PHONE_SEPARATOR}?\\d{2}`
    + `|(?:\\(\\d{3}\\)|\\d{3})${PHONE_SEPARATOR}\\d{3}${PHONE_SEPARATOR}?\\d{2}${PHONE_SEPARATOR}?\\d{2})(?!\\d)`,
    "gu"
  ),
};

function digits(value) {
  return value.replace(/\D/gu, "");
}

export function isValidTcKimlik(value) {
  const compact = digits(String(value));
  if (!/^[1-9]\d{10}$/u.test(compact) || new Set(compact).size === 1) return false;
  const numbers = [...compact].map(Number);
  const oddSum = numbers[0] + numbers[2] + numbers[4] + numbers[6] + numbers[8];
  const evenSum = numbers[1] + numbers[3] + numbers[5] + numbers[7];
  const tenth = (oddSum * 7 - evenSum) % 10;
  const eleventh = numbers.slice(0, 10).reduce((sum, number) => sum + number, 0) % 10;
  return tenth === numbers[9] && eleventh === numbers[10];
}

export function isValidLuhn(value) {
  const compact = digits(String(value));
  if (compact.length < 13 || compact.length > 19 || new Set(compact).size === 1) return false;
  const parity = compact.length % 2;
  let total = 0;
  for (let index = 0; index < compact.length; index += 1) {
    let number = Number(compact[index]);
    if (index % 2 === parity) {
      number *= 2;
      if (number > 9) number -= 9;
    }
    total += number;
  }
  return total % 10 === 0;
}

export function isValidIban(value) {
  const compact = String(value).replace(/\s/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(compact) || compact.length < 15 || compact.length > 34) {
    return false;
  }
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const expanded = /[A-Z]/u.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidPhone(value) {
  let compact = digits(String(value));
  if (compact.startsWith("0090")) compact = compact.slice(4);
  else if (compact.startsWith("90") && compact.length === 12) compact = compact.slice(2);
  else if (compact.startsWith("0") && compact.length === 11) compact = compact.slice(1);
  if (!/^\d{10}$/u.test(compact)) return false;
  return TR_PHONE_AREA_CODES.has(compact.slice(0, 3));
}

export function normalizeValue(category, value) {
  const raw = String(value);
  // Türkçe yerel burada zararlı: "AHMET@ORNEK.COM.TR" içindeki ASCII "I"
  // "ı"ya dönüşüp aynı adresi ikinci bir bulgu ve ikinci bir yer tutucu
  // hâline getiriyordu. Adres yerelden bağımsız küçültülür.
  // NFC olmadan aynı adresin ayrışık ve birleşik yazımı iki ayrı anahtar,
  // dolayısıyla iki ayrı bulgu ve iki ayrı yer tutucu üretiyordu.
  if (category === "email") return raw.normalize("NFC").toLowerCase();
  if (category === "iban") return raw.replace(/\s/gu, "").toUpperCase();
  if (category === "tc" || category === "card") return digits(raw);
  if (category === "phone") {
    let compact = digits(raw);
    if (compact.startsWith("0090")) compact = compact.slice(2);
    if (compact.startsWith("0") && compact.length === 11) compact = `90${compact.slice(1)}`;
    else if (compact.length === 10) compact = `90${compact}`;
    return `+${compact}`;
  }
  if (["person", "organization", "location", "documentNumber"].includes(category)) {
    return raw.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("tr-TR");
  }
  return raw;
}

export function matchKey(category, normalized) {
  return `${category}\u0000${normalized}`;
}

export const NUMERIC_SAFE_CATEGORIES = Object.freeze(["tc", "card"]);

// Görünmez biçim karakterleri (yumuşak tire, ZWJ/ZWNJ/ZWSP, bidi işaretleri)
// deseni ortasından kesiyordu: "ah\u00ADmet@ornek.com.tr" adresinin yalnızca
// "met@ornek.com.tr" bölümü bulunup maskeleniyor, adresin başı belgede
// kalıyordu — üstelik kullanıcıya var olmayan bir adres gösteriliyordu.
// T.C. kimlik numarasında ise numara hiç bulunamıyordu. Desen, görünmezlerden
// arındırılmış metinde çalışır; bulunan aralık ham metne geri çevrilir ve
// görünmezleri de kapsar, yani maskeleme onları da siler.
const FORMAT_CHARACTER = /\p{Cf}/u;

function withoutFormatCharacters(source) {
  if (!FORMAT_CHARACTER.test(source)) return null;
  let cleaned = "";
  const offsets = [];
  let index = 0;
  for (const character of source) {
    if (!FORMAT_CHARACTER.test(character)) {
      for (let step = 0; step < character.length; step += 1) offsets.push(index + step);
      cleaned += character;
    }
    index += character.length;
  }
  offsets.push(source.length);
  return { cleaned, offsets };
}

export function detectText(text, options = {}) {
  const source = String(text);
  const stripped = withoutFormatCharacters(source);
  const scanned = stripped ? stripped.cleaned : source;
  const toSource = stripped ? (position) => stripped.offsets[position] : (position) => position;
  const candidates = [];
  const allow = options.categories ? new Set(options.categories) : null;

  // Reddedilen bir aday, hemen ardındaki GERÇEK numarayı da yutuyordu.
  // Desenler açgözlüdür: "12345 4111 1111 1111 1111" satırında kart deseni
  // baştan itibaren uzun bir aday üretir, Luhn onu eler ve `matchAll`
  // lastIndex'i elenen adayın ARDINA taşıdığı için gerçek kart hiç taranmaz.
  // Aynı arıza kart adayının komşu T.C. kimlik numarasını yutmasında da
  // görülüyordu. Reddedilen adaydan sonra arama bir karakter ileriden sürer.
  const collect = (pattern, category, validator = null) => {
    if (allow && !allow.has(category)) return;
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    regex.lastIndex = 0;
    let result = regex.exec(scanned);
    while (result !== null) {
      if (validator && !validator(result[0])) {
        regex.lastIndex = result.index + 1;
      } else {
        candidates.push({
          category,
          start: toSource(result.index),
          end: toSource(result.index + result[0].length),
          raw: result[0],
          normalized: normalizeValue(category, result[0]),
        });
        if (result[0].length === 0) regex.lastIndex += 1;
      }
      result = regex.exec(scanned);
    }
  };

  collect(PATTERNS.email, "email");
  collect(PATTERNS.trIban, "iban", isValidIban);
  collect(PATTERNS.compactIban, "iban", isValidIban);
  collect(PATTERNS.tc, "tc", isValidTcKimlik);
  collect(PATTERNS.card, "card", isValidLuhn);
  collect(PATTERNS.phone, "phone", isValidPhone);

  candidates.sort((a, b) =>
    a.start - b.start ||
    CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category] ||
    (b.end - b.start) - (a.end - a.start)
  );

  const accepted = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some((item) => candidate.start < item.end && candidate.end > item.start);
    if (!overlaps) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

export function aggregateFindings(texts) {
  const aggregate = new Map();
  for (let unitIndex = 0; unitIndex < texts.length; unitIndex += 1) {
    const input = texts[unitIndex];
    const text = typeof input === "string" ? input : String(input.text || "");
    const location = typeof input === "string" ? { kind: "text", unitIndex } : input.location;
    const categories = typeof input === "object" ? input.categories : null;
    for (const match of detectText(text, categories ? { categories } : {})) {
      const key = matchKey(match.category, match.normalized);
      const current = aggregate.get(key);
      const occurrence = { unitIndex, start: match.start, end: match.end, location };
      if (current) {
        current.count += 1;
        current.locations.push(occurrence);
      } else aggregate.set(key, { ...match, count: 1, locations: [occurrence] });
    }
  }

  const categoryCounts = Object.fromEntries(Object.keys(CATEGORY_META).map((category) => [category, 0]));
  return [...aggregate.values()].map((item, index) => {
    categoryCounts[item.category] += 1;
    const meta = CATEGORY_META[item.category];
    return {
      id: `f_${index + 1}`,
      source: "pattern",
      category: item.category,
      label: meta.label,
      value: item.raw,
      originalText: item.raw,
      normalized: item.normalized,
      count: item.count,
      confidence: meta.confidence,
      placeholder: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      replacementText: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      locations: item.locations,
    };
  });
}

export function createReplacementMap(findings, selectedIds) {
  const selected = new Set(selectedIds);
  const chosen = findings.filter((finding) => selected.has(finding.id));
  const replacementMap = new Map(
    chosen.map((finding) => [matchKey(finding.category, finding.normalized), finding.placeholder])
  );
  // Bir eşleşmeyi hangi bulgunun ürettiğini geri izleyebilmek için: inceleme
  // ekranındaki "kaç kullanım maskelenecek" sayısı bu izle çıkarılır, yani
  // maskelemenin kendisiyle aynı koddan.
  Object.defineProperty(replacementMap, "findingIdByKey", {
    value: new Map(chosen.map((finding) => [matchKey(finding.category, finding.normalized), finding.id])),
  });
  // Belgede literal olarak aranacak bulgular: model varlıkları ve belgenin
  // kendi etiketinden okunan alan değerleri. İkisi de aynı yolla uygulanır —
  // değer, belgenin tamamında sözcük sınırlarıyla aranır.
  Object.defineProperty(replacementMap, "entityFindings", {
    value: findings.filter((finding) =>
      selected.has(finding.id)
      && (["ner", "field"].includes(finding.source)
        || (!finding.source && ["person", "organization", "location"].includes(finding.category)))
    ),
  });
  Object.defineProperty(replacementMap, "literalFindings", {
    value: findings.filter((finding) => selected.has(finding.id) && ["custom", "imported-rule"].includes(finding.source)),
  });
  Object.defineProperty(replacementMap, "variantsByFindingId", {
    value: new Map([...replacementMap.entityFindings, ...replacementMap.literalFindings]
      .map((finding) => [finding.id, dedupedVariants(finding)])),
  });
  return replacementMap;
}

// Aynı bulgunun varyantları katlandığında çakışabilir ("KEREM" ve "Kerem").
// Aynı aramayı iki kez yapmanın anlamı yok. Liste bulgu başına bir kez
// çıkarılır ve haritada saklanır: metin başına yeniden kurmak, uzun belgede
// binlerce kez tekrarlanan boş bir maliyetti.
function dedupedVariants(finding) {
  const seen = new Set();
  const variants = [];
  for (const variant of finding.variants || [finding.value]) {
    const key = foldForMatching(variant);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    variants.push(variant);
  }
  return variants;
}

function variantsFor(replacementMap, finding) {
  return replacementMap.variantsByFindingId?.get(finding.id) || dedupedVariants(finding);
}

export function replacementCandidates(text, replacementMap, options = {}) {
  const findingIdByKey = replacementMap.findingIdByKey;
  const candidates = detectText(text, options)
    .map((match) => {
      const key = matchKey(match.category, match.normalized);
      return {
        ...match,
        placeholder: replacementMap.get(key),
        findingId: findingIdByKey?.get(key),
        priority: 1,
      };
    })
    .filter((match) => Boolean(match.placeholder));

  // Katlanmış dizin metin başına bir kez kurulur; her bulgu ve varyant aynı
  // dizini kullanır.
  let index = null;
  const foldedIndex = () => (index ||= createFoldedIndex(text));

  // Eşleşme büyük/küçük harfe takılmaz ve BELGENİN TAMAMINDA aranır.
  //
  // İki ayrı arıza buradaydı. Birincisi harf duyarlılığı: model bir yerde
  // "LEAF" yakalayıp başka bir yerdeki "Leaf"i görmediğinde ad belgede
  // kalıyordu. İkincisi kapsam: varlık bulguları eskiden yalnızca modelin
  // onları GÖRDÜĞÜ birime uygulanıyordu. XLSX her hücreyi ayrı birim olarak
  // maskelediği için, A1'de bulunan ad B3'te maskesiz kalıyor; sayım ise
  // bütün hücreleri saydığından rapor "3 kullanım" derken çalışma kitabında
  // 1 değişiklik oluyordu. Kapsam artık DOCX/PDF/TXT ile aynı: belge geneli.
  for (const finding of replacementMap.entityFindings || []) {
    for (const variant of variantsFor(replacementMap, finding)) {
      for (const hit of findOccurrences(foldedIndex(), variant, { wholeWord: true })) {
        candidates.push({
          category: finding.category,
          start: hit.start,
          end: hit.end,
          raw: hit.text,
          normalized: finding.normalized,
          placeholder: finding.placeholder,
          findingId: finding.id,
          priority: 2,
        });
      }
    }
  }

  for (const finding of replacementMap.literalFindings || []) {
    for (const variant of variantsFor(replacementMap, finding)) {
      for (const hit of findOccurrences(foldedIndex(), variant, { wholeWord: true })) {
        candidates.push({
          category: "custom",
          start: hit.start,
          end: hit.end,
          raw: hit.text,
          normalized: finding.normalized,
          placeholder: finding.replacementText,
          findingId: finding.id,
          priority: 0,
        });
      }
    }
  }

  // Çakışan adaylardan biri elenmek zorunda. Eleneni sessizce düşürmek, onun
  // kapsadığı metnin çıktıda AÇIK kalması demekti: kısa bir kurumsal kural bir
  // IBAN'ın ortasına denk geldiğinde panelde "IBAN -> [IBAN_1]" yazıyor ama
  // çıktıda "TR02 0006 [SUBE_1] 4793 5326 41" kalıyordu.
  //
  // Bu yüzden önce EN GENİŞ aralık kazanır (eşitlikte güven sırası karar verir),
  // sonra elenen adayın açıkta bıraktığı kısım kazananın aralığına katılır.
  // Değişmez şudur: seçili hiçbir bulgunun metni çıktıda kalmaz. Bedeli,
  // görünen etiketin dar kuralın karşılığı değil geniş desenin yer tutucusu
  // olabilmesidir — değer her hâlükârda tamamen maskelenir.
  candidates.sort((a, b) =>
    (b.end - b.start) - (a.end - a.start)
    || a.priority - b.priority
    || a.start - b.start
    || (CATEGORY_PRIORITY[a.category] ?? 99) - (CATEGORY_PRIORITY[b.category] ?? 99)
  );
  return candidates;
}

// Çözümleme ayrı bir adımdır, çünkü iki yerden çağrılır: maskelemenin kendisi
// ve inceleme ekranındaki "kaç kullanım maskelenecek" sayısı. Aynı fonksiyon
// olmadan ikisi kaçınılmaz olarak ayrışır — kullanıcının bildirdiği arıza
// tam olarak buydu.
//
// Sıra yalnızca adayın kendi özniteliklerinden çıktığı için listeyi bir alt
// kümeye süzmek sırayı bozmaz: aynı çözümleme her seçim için yeniden
// koşturulabilir.
// Çakışma aramasında kabul edilenlerin tamamını taramak karesel maliyet
// çıkarıyordu: 3 MB'lık tek bir metin biriminde 153.000 aday oluşuyor ve
// tarama 73 saniye sürüyor, sonra her onay kutusu tıklaması 3 saniye
// donuyordu. Kabul edilen aralıklar konuma göre kovalara yazılır; bir adayın
// çakışma denetimi yalnız kendi kovalarına bakar. Kabul edilenler birbiriyle
// çakışmadığı için kova başına birkaç öge düşer.
const OVERLAP_BUCKET = 64;

export function resolveReplacements(candidates, isSelected = null) {
  const accepted = [];
  const buckets = new Map();
  const register = (item) => {
    const last = Math.floor(Math.max(item.start, item.end - 1) / OVERLAP_BUCKET);
    for (let key = Math.floor(item.start / OVERLAP_BUCKET); key <= last; key += 1) {
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      if (!bucket.includes(item)) bucket.push(item);
    }
  };

  for (const candidate of candidates) {
    if (isSelected && !isSelected(candidate.findingId)) continue;
    // `find` en önce eklenen çakışanı seçerdi; sıra numarası aynı seçimi korur.
    let clash = null;
    const last = Math.floor(Math.max(candidate.start, candidate.end - 1) / OVERLAP_BUCKET);
    for (let key = Math.floor(candidate.start / OVERLAP_BUCKET); key <= last; key += 1) {
      for (const item of buckets.get(key) || []) {
        if (candidate.start < item.end && candidate.end > item.start
          && (!clash || item.order < clash.order)) clash = item;
      }
    }
    if (clash) {
      clash.start = Math.min(clash.start, candidate.start);
      clash.end = Math.max(clash.end, candidate.end);
      register(clash);
    } else {
      const item = { ...candidate, order: accepted.length };
      accepted.push(item);
      register(item);
    }
  }

  // Genişletme iki kabul edilmiş aralığı birbirine değdirmiş olabilir.
  accepted.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of accepted) {
    const previous = merged[merged.length - 1];
    if (previous && item.start < previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push(item);
  }
  return merged;
}

export function replacementsForText(text, replacementMap, options = {}) {
  return resolveReplacements(replacementCandidates(text, replacementMap, options));
}

export function replaceText(text, replacementMap, options = {}) {
  let output = String(text);
  const replacements = replacementsForText(output, replacementMap, options);
  for (const match of [...replacements].reverse()) {
    output = output.slice(0, match.start) + match.placeholder + output.slice(match.end);
  }
  return output;
}

// Yer tutucu numaraları birleşik listede verilir.
//
// Her katman kendi içinde 1'den saymaya başlarsa iki farklı kişi aynı
// [KISI_1] etiketini alır: eşleştirme dosyası anlamsızlaşır ve maskelenmiş
// belgeyi okuyan kişi iki ayrı kişiyi tek kişi sanır. Kendi kuralların ve
// kurumsal kurallar dışarıda tutulur; onların karşılığını kullanıcı yazar.
export function renumberPlaceholders(findings) {
  // Kullanıcının kendi yazdığı karşılıklar rezerve edilir. Bir kuralın
  // karşılığı "[KISI_1]" olarak yazıldığında otomatik numaralandırma da aynı
  // etiketi üretebiliyor, iki farklı kişi maskelenmiş belgede tek kişi gibi
  // görünüyordu; eşleştirme dosyası da bunu çözemez hâle geliyordu.
  const reserved = new Set(findings
    .filter((finding) => ["custom", "imported-rule"].includes(finding.source))
    .map((finding) => String(finding.replacementText)));
  const counts = {};
  for (const finding of findings) {
    const meta = CATEGORY_META[finding.category];
    if (!meta || ["custom", "imported-rule"].includes(finding.source)) continue;
    let placeholder;
    do {
      counts[finding.category] = (counts[finding.category] || 0) + 1;
      placeholder = `[${meta.prefix}_${counts[finding.category]}]`;
    } while (reserved.has(placeholder));
    finding.placeholder = placeholder;
    finding.replacementText = placeholder;
  }
  return findings;
}

// Bulgular birden çok katmandan gelir: desen, belgenin kendi alan etiketleri,
// dil modeli, kendi kuralların, kurumsal kurallar. Aynı değeri iki katman da
// bulabilir. Birleştirilmezse listede aynı isim iki satır olarak görünür ve
// iki ayrı yer tutucu alır. Önce gelen katman kazanır — sıra çağıranın
// verdiği güven sırasıdır — sonrakinin yazım varyantları ona eklenir.
export function mergeFindings(findingGroups) {
  const byKey = new Map();
  const merged = [];
  for (const group of findingGroups) {
    for (const finding of group || []) {
      const key = matchKey(finding.category, finding.normalized);
      const existing = byKey.get(key);
      if (!existing) {
        const copy = {
          ...finding,
          variants: [...new Set(finding.variants || [finding.value])],
          locations: [...(finding.locations || [])],
        };
        byKey.set(key, copy);
        merged.push(copy);
        continue;
      }
      existing.variants = [...new Set([...existing.variants, ...(finding.variants || [finding.value])])];
      existing.locations = [...existing.locations, ...(finding.locations || [])];
      if (finding.score && !(existing.score >= finding.score)) existing.score = finding.score;
    }
  }
  return renumberPlaceholders(merged);
}

// Rapordaki sayı ile belgedeki sonuç aynı koddan çıkmalı.
//
// Bulgunun `count` alanı şimdiye kadar TESPİT sayısıydı: modelin kaç kez
// gördüğü. Maskeleme ise belgenin tamamında literal olarak arar; ikisi
// birbirini tutmuyordu. Kullanıcı "17 kullanım maskelenecek" okuyup indirilen
// belgede 18 yer tutucu sayabiliyor, ters yönde sapmada ise "2 kullanım" denip
// 8 yer değiştirilebiliyordu. Sayım artık maskelemenin kendi fonksiyonuyla ve
// aynı çakışma kurallarıyla yapılır.
// Sayım iki kez sorulur: tarama biterken bir kez, sonra kullanıcı her seçim
// değiştirdiğinde yeniden. İkincisi belgeyi yeniden taramaya değmez ve zaten
// toplu modda belge bellekte yoktur. Bu yüzden tarama sırasında ADAY listesi
// çıkarılıp saklanır; her seçim için yalnızca çakışma çözümlemesi yeniden
// koşturulur — maskelemenin kullandığı fonksiyonun aynısıyla.
export function collectReplacementPlan(units, findings) {
  const replacementMap = createReplacementMap(findings, findings.map((finding) => finding.id));
  const plan = [];
  for (const input of units) {
    const text = typeof input === "string" ? input : String(input?.text || "");
    if (!text) continue;
    const categories = typeof input === "object" && input ? input.categories : null;
    const candidates = replacementCandidates(text, replacementMap, categories ? { categories } : {});
    if (!candidates.length) continue;
    plan.push(candidates.map(({ findingId, start, end, priority, category }) =>
      ({ findingId, start, end, priority, category })));
  }
  return plan;
}

export function countsForSelection(plan, selectedIds) {
  const selected = new Set(selectedIds);
  const counts = new Map();
  for (const candidates of plan) {
    for (const accepted of resolveReplacements(candidates, (id) => selected.has(id))) {
      if (!accepted.findingId) continue;
      counts.set(accepted.findingId, (counts.get(accepted.findingId) || 0) + 1);
    }
  }
  return counts;
}

export function countPlannedReplacements(units, findings, selectedIds = null) {
  return countsForSelection(
    collectReplacementPlan(units, findings),
    selectedIds || findings.map((finding) => finding.id)
  );
}

// Uzun belgede aday çıkarımı tek karede bitmez; arayüz donmasın diye parça parça.
export async function collectReplacementPlanBatched(units, findings, options = {}) {
  const batchSize = Math.max(1, Number(options.batchSize) || 200);
  const plan = [];
  for (let start = 0; start < units.length; start += batchSize) {
    if (options.signal?.aborted) throw options.signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
    plan.push(...collectReplacementPlan(units.slice(start, start + batchSize), findings));
    options.onProgress?.({ current: Math.min(start + batchSize, units.length), total: units.length });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return plan;
}

// Dosya adı da belgenin bir parçasıdır.
//
// "Kerem Aydın ikametgah.pdf" maskelenip indirildiğinde içerik temizdi ama ad
// hâlâ kişiyi söylüyordu: dosya e-postayla gönderildiği anda maskeleme boşa
// çıkar. Ad, belgeyle aynı yer tutucularla yazılır.
const UNSAFE_FILENAME_CHARACTERS = /[\\/:*?"<>|]/gu;

export function redactFilename(filename, replacementMap, options = {}) {
  const name = String(filename);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const redacted = replaceText(stem, replacementMap, options)
    .replace(UNSAFE_FILENAME_CHARACTERS, "_")
    .replace(/\s+/gu, " ")
    .trim();
  return { stem: redacted || "belge", extension, changed: redacted !== stem };
}

export function redactedOutputFilename(filename, replacementMap = null, suffix = "_redakte") {
  if (!replacementMap) {
    const name = String(filename);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
  }
  const { stem, extension } = redactFilename(filename, replacementMap);
  return `${stem}${suffix}${extension}`;
}

export const categoryMeta = CATEGORY_META;
