// Resmî evrakın hassas bilgisi düzyazıda değil, etiketli alanlarda durur.
//
// Nüfus kaydı, ikametgâh, tapu, sözleşme: bilgi "Adı : KEREM" biçiminde,
// tek başına, büyük harfle ve cümlesiz yazılır. Dil modeli bu biçimi kötü
// okur — eğitim verisi cümledir, tablo değil — ve bir ikametgâh belgesinde
// T.C. kimlik numarası maskelenirken adın, soyadın ve kayıt numarasının
// belgede kaldığı görüldü. Oysa alanın ne olduğunu belgenin kendisi söylüyor:
// etiket orada yazıyor.
//
// Bu katman modelden bağımsız çalışır ve deterministiktir: etiketi bulur,
// değeri alır. Model çalışmasa bile bu alanlar bulunur.

import { detectText, matchKey, normalizeValue } from "./pii.js";
import { createFoldedIndex, foldForMatching } from "./text-match.js";

// Etiketten sonra iki nokta zorunludur. Zorunlu olmasa "il", "ad", "no" gibi
// kısa etiketler düzyazının içinde durmadan eşleşirdi.
const LABEL_GROUPS = [
  {
    category: "person",
    labels: [
      "adı", "adi", "ad", "soyadı", "soyadi", "soyad", "adı soyadı", "adi soyadi",
      "ad soyad", "adı ve soyadı", "ad ve soyad", "baba adı", "baba adi", "ana adı",
      "anne adı", "anne adi", "eşinin adı", "kızlık soyadı", "kizlik soyadi",
      "önceki soyadı", "velisi", "vekili", "talep eden", "başvuran", "basvuran",
      "düzenleyen", "hazırlayan", "yetkili", "yetkilisi", "imza sahibi", "ilgili kişi",
      "alıcı", "gönderen", "malik", "kiracı", "kiraya veren", "borçlu", "alacaklı",
    ],
  },
  {
    category: "location",
    labels: [
      "adres", "adresi", "yerleşim yeri adresi", "yerlesim yeri adresi",
      "ikametgah adresi", "ikametgâh adresi", "ikamet adresi", "ev adresi",
      "iş adresi", "is adresi", "tebligat adresi", "fatura adresi", "teslimat adresi",
      "doğum yeri", "dogum yeri", "nüfusa kayıtlı olduğu yer", "nufusa kayitli oldugu yer",
      "mahalle", "mahallesi", "cadde", "caddesi", "sokak", "sokağı", "köy", "koy",
      "mezra", "il", "ilçe", "ilce", "semt", "bucak",
    ],
  },
  {
    category: "documentNumber",
    labels: [
      "kimlik no", "kimlik numarası", "t.c. kimlik no", "tc kimlik no", "tckn",
      "seri no", "cilt no", "aile sıra no", "aile sira no", "birey sıra no",
      "sıra no", "sira no", "adres no", "belge no", "kayıt no", "kayit no",
      "dosya no", "sicil no", "sicil numarası", "vergi no", "vergi kimlik no",
      "vergi numarası", "müşteri no", "musteri no", "abone no", "sözleşme no",
      "sozlesme no", "referans no", "makbuz no", "fatura no", "sgk no",
      "sgk sicil no", "pasaport no", "ehliyet no", "plaka", "iban no",
      "hesap no", "hesap numarası", "tapu no", "ada no", "parsel no",
    ],
  },
];

const MAX_VALUE_LENGTH = 160;
const MIN_NUMBER_CHARACTERS = 4;

// "Web adresi", "E-posta adresi", "IP adresi" bir yer değildir. Etiketten
// önceki nitelemeye bakılmadığında sıradan bir kurumsal belgede imza bloğundaki
// site adresi konum diye maskeleniyordu — aşırı maskeleme de bir arızadır.
// "Posta adresi" ve "teslimat adresi" listede yok: onlar gerçekten adrestir.
const NON_LOCATION_QUALIFIERS = new Set([
  "web", "internet", "e-posta", "eposta", "e-mail", "email", "mail", "ip", "url", "mac", "kep",
]);

// Değerin kendisi bir adres/ad değil, bir bağlantı ya da makine adresi.
const MACHINE_ADDRESS = /^(?:[a-z][a-z0-9+.\-]*:\/\/|www\.)|^\d{1,3}(?:\.\d{1,3}){3}$/iu;

// Etiket eşleşmesi belgenin geri kalanıyla AYNI katlamayı kullanmalı.
//
// Eskiden etiketler tr-TR ile küçültülüp ham satırda `iu` bayrağıyla aranıyordu;
// JS'in basit katlaması "İ" ile "i"yi eş saymadığı için "KİMLİK NO :" satırı
// hiç eşleşmiyordu. Resmî evrak neredeyse her zaman BÜYÜK HARF yazıldığı için
// bu, ikametgâh/nüfus belgelerinin tamamının maskesiz kalması demekti.
function foldLabel(value) {
  return foldForMatching(value).replace(/\s+/gu, " ").trim();
}

const CATEGORY_BY_LABEL = new Map();
for (const group of LABEL_GROUPS) {
  for (const label of group.labels) CATEGORY_BY_LABEL.set(foldLabel(label), group.category);
}

// Uzun etiket önce denenir: "baba adı" varken "adı" ile eşleşmek yanlış değeri alır.
const LABELS_BY_LENGTH = [...CATEGORY_BY_LABEL.keys()].sort((left, right) => right.length - left.length);
const LABEL_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${LABELS_BY_LENGTH.map((label) => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})\\s*[:：]`,
  "giu"
);

function isLabelOnly(text) {
  return CATEGORY_BY_LABEL.has(foldLabel(String(text).replace(/[:：]\s*$/u, "")));
}

function isSeparatorOnly(text) {
  return /^[\s:：.\-–—|]*$/u.test(String(text));
}

// Değerin kendisi zaten desenle bulunuyorsa (e-posta, T.C., IBAN, telefon)
// burada ikinci bir bulgu üretmek listeyi ikizler ve iki farklı yer tutucu
// çıkarır. Desen katmanı daha kesindir, alan orada bırakılır.
function alreadyCoveredByPattern(value) {
  const matches = detectText(value);
  if (!matches.length) return false;
  const covered = matches.reduce((total, match) => total + (match.end - match.start), 0);
  return covered >= value.trim().length * 0.8;
}

function isAcceptableValue(category, value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return false;
  if (isLabelOnly(trimmed) || isSeparatorOnly(trimmed)) return false;
  if (MACHINE_ADDRESS.test(trimmed)) return false;
  if (alreadyCoveredByPattern(trimmed)) return false;

  if (category === "person") {
    // Ad alanı harften oluşur ve kısadır. Rakam ya da uzun bir öbek varsa
    // muhtemelen etiketten sonra gelen şey ad değildir.
    if (!/\p{L}/u.test(trimmed) || /\p{N}/u.test(trimmed)) return false;
    return trimmed.split(/\s+/u).length <= 5;
  }
  if (category === "documentNumber") {
    const alphanumeric = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
    return alphanumeric >= MIN_NUMBER_CHARACTERS && /\p{N}/u.test(trimmed);
  }
  return (trimmed.match(/[\p{L}\p{N}]/gu) || []).length >= 3;
}

// Listede olmayan bir etiket ("Uyruğu :", "Medeni Hâli :") satırda değerin
// ardından geldiğinde değer ona kadar uzuyordu: "KEREM Uyruğu : T.C" tek bir
// kişi adı sayılıyor, hem belge bozuluyor hem de asıl ad ("KEREM") başka
// yerlerde bu varyantla eşleşmediği için maskesiz kalıyordu.
//
// Adres için kesme yapılmaz: gerçek adresler iki nokta taşır ("413 SK. NO: 10").
// Etiket çok kelimeli olabilir ("Medeni Hâli :"); en soldaki eşleşme alınır.
// Değer önce kırpılır, böylece baştaki boşluk ilk sözcüğü etikete katmaz.
const TRAILING_LABEL = /\s+(?:[^\s:：]{1,30}\s+){0,2}[^\s:：]{1,30}\s*[:：]/u;

function cutAtTrailingLabel(category, value) {
  if (category === "location") return value;
  const match = TRAILING_LABEL.exec(value);
  return match ? value.slice(0, match.index) : value;
}

function trimValue(value) {
  return String(value).replace(/^[\s:：.\-–—|]+/u, "").replace(/[\s.,;|]+$/u, "");
}

function qualifierBefore(line, index) {
  const match = /([\p{L}\p{N}.\-]+)\s*$/u.exec(line.slice(0, index));
  return match ? foldLabel(match[1]) : "";
}

// 1) Aynı satırda: "Adı : KEREM". Değer bir sonraki etikete ya da satır sonuna
//    kadar uzanır; "Adı: KEREM Soyadı: AYDIN" iki alan olarak okunur.
function collectFromLine(line, collect) {
  const index = createFoldedIndex(line);
  const toSource = (position) => (index.offsets ? index.offsets[position] : position);
  const matches = [...index.folded.matchAll(LABEL_PATTERN)];
  for (let order = 0; order < matches.length; order += 1) {
    const match = matches[order];
    const category = CATEGORY_BY_LABEL.get(foldLabel(match[1]));
    if (!category) continue;
    if (category === "location" && NON_LOCATION_QUALIFIERS.has(qualifierBefore(index.folded, match.index))) continue;
    const valueStart = toSource(match.index + match[0].length);
    const valueEnd = order + 1 < matches.length ? toSource(matches[order + 1].index) : line.length;
    const raw = cutAtTrailingLabel(category, trimValue(line.slice(valueStart, valueEnd)));
    if (isAcceptableValue(category, raw)) collect(category, raw);
  }
}

// Sütununun başlığı bir alan adı değilse, o sütundaki hücreler veri hücresidir.
// Metni tesadüfen bir alan adına benzese bile ("Yerleşim Yeri Adresi" burada
// bir adres türü DEĞERİDİR, etiket değil) komşusunun etiketi sayılamaz —
// sayılınca yandaki sıradan hücre gereksiz yere maskeleniyordu.
function dataCellIndexes(texts, locations) {
  // Etiket-değer tablosu ile veri tablosunu genişlik ayırır.
  //
  // Form tabloları dardır: "Adı | KEREM" ya da "Adı | : | KEREM". Veri
  // tabloları geniştir ve etiketleri satırda değil sütunun tepesinde taşır.
  // Genişlik ayrımı olmadan iki arıza birden çıkıyordu: dar formun ilk
  // satırında bir başlık ("KİMLİK BİLGİLERİ") varsa ad/soyad hiç eşleşmiyor,
  // geniş tabloda ise etikete benzeyen bir VERİ hücresi ("Yerleşim Yeri
  // Adresi") yanındaki sıradan hücreyi maskeletiyordu.
  const widthByGrid = new Map();
  const cells = [];
  for (let index = 0; index < texts.length; index += 1) {
    const cell = cellCoordinates(locations[index]);
    if (!cell) continue;
    cells.push({ index, cell });
    const column = Number(cell.column) || columnOrder(cell.column);
    widthByGrid.set(cell.grid, Math.max(widthByGrid.get(cell.grid) ?? 0, column + 1));
  }

  // Altında veri bulunan hücre bir SÜTUN BAŞLIĞIDIR, satır etiketi değil.
  // Ayrım şu: form tablosunda "Adı"nın altında yine bir etiket ("Soyadı")
  // durur; başlık satırında ise veri ("Kerem") durur. Bu ayrım yapılmadığında
  // "Adı | Tutar" başlığının ikinci hücresi kişi adı sanılıp maskeleniyordu.
  const byCell = new Map(cells.map(({ index, cell }) => [`${cell.grid}\u0000${cell.column}\u0000${cell.row}`, index]));
  const dataCells = new Set();
  for (const { index, cell } of cells) {
    if ((widthByGrid.get(cell.grid) ?? 0) > NARROW_TABLE_COLUMNS) {
      dataCells.add(index);
      continue;
    }
    const below = byCell.get(`${cell.grid}\u0000${cell.column}\u0000${cell.row + 1}`);
    if (below !== undefined && !isLabelOnly(trimValue(texts[below]))) dataCells.add(index);
  }
  return dataCells;
}

// Excel sütunları harfle adlandırılır ("A", "B", ... "AA"); Word'de sayıdır.
function columnOrder(column) {
  const label = String(column);
  if (/^\d+$/u.test(label)) return Number(label);
  let order = 0;
  for (const character of label) order = order * 26 + (character.charCodeAt(0) - 64);
  return order - 1;
}

const NARROW_TABLE_COLUMNS = 3;

// 2) Komşu hücrelerde: tablo satırı "Adı" | ":" | "KEREM" olarak üç ayrı
//    hücreye bölünür; etiketle değer aynı metinde hiç bulunmaz.
function collectFromNeighbour(units, index, collect, dataCells) {
  if (dataCells.has(index)) return;
  const category = CATEGORY_BY_LABEL.get(foldLabel(String(units[index]).replace(/[:：]\s*$/u, "")));
  if (!category) return;
  for (let ahead = index + 1; ahead < Math.min(units.length, index + 3); ahead += 1) {
    const candidate = trimValue(units[ahead]);
    if (isSeparatorOnly(candidate)) continue;
    if (isAcceptableValue(category, candidate)) collect(category, candidate);
    return;
  }
}

// 3) Sütun başlığı: Excel'de etiket satırda değil, sütunun tepesindedir.
//    Başlığın kendisi bir alan adıysa ("Adres No", "Adı"), o sütundaki bütün
//    değerler o alandır.
//
//    Bu yalnızca hücre koordinatı bilinen belgede yapılır. Konum bilgisi
//    olmadan "ardışık hücreler bir satırdır" varsayımı yanlış hizalanıyordu:
//    veri hücresinin metni tesadüfen bir etiketle aynı olduğunda ("Yerleşim
//    Yeri Adresi" hem başlık hem değer olabilir) bütün sütunlar kayıyordu.
const CELL_ADDRESS = /^([A-Z]+)(\d+)$/u;

function cellCoordinates(location) {
  if (location?.kind === "xlsx" && location.address) {
    const match = CELL_ADDRESS.exec(String(location.address).toUpperCase());
    if (!match) return null;
    return { grid: `xlsx ${location.sheetName || ""}`, column: match[1], row: Number(match[2]) };
  }
  // Word tablosu aynı kurala tabidir; koordinatı office-parts.js hücre
  // ata düğümlerinden çıkarır.
  if (location?.cell) {
    return {
      grid: `${location.kind} ${location.part || ""} ${location.cell.table}`,
      column: String(location.cell.column),
      row: Number(location.cell.row),
    };
  }
  return null;
}

function collectFromColumnHeaders(texts, locations, collectAt) {
  const byColumn = new Map();
  for (let index = 0; index < texts.length; index += 1) {
    const cell = cellCoordinates(locations[index]);
    if (!cell) continue;
    const key = `${cell.grid}\u0000${cell.column}`;
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key).push({ ...cell, index });
  }

  for (const cells of byColumn.values()) {
    cells.sort((left, right) => left.row - right.row);
    let category = null;
    let previousRow = null;
    for (const cell of cells) {
      const text = trimValue(texts[cell.index]);
      // Başlığın kapsamı tablo bitince biter. Boş hücre ya da satır atlaması
      // tablonun sonudur; sıfırlanmadığında aynı sütundaki ikinci tablo,
      // toplam satırı ve dipnot da kişi adı/adres sayılıp maskeleniyordu.
      if (!text || (previousRow !== null && cell.row - previousRow > 1)) category = null;
      previousRow = cell.row;
      if (!text) continue;
      if (isLabelOnly(text)) {
        category = CATEGORY_BY_LABEL.get(foldLabel(text.replace(/[:：]\s*$/u, ""))) || null;
        continue;
      }
      if (!category) continue;
      if (isAcceptableValue(category, text)) collectAt(cell.index)(category, text);
    }
  }
}

// 4) PDF sayfasında hücre yoktur, yalnızca konum vardır. Aynı satırdaki
//    kayıtlar yatay boşluğa göre hücrelere ayrılır; bir satırın hücrelerinden
//    en az ikisi alan adıysa o satır sütun başlığı sayılır ve altındaki
//    satırlar aynı x aralıklarına göre eşlenir. İkiden az etiket varsa hiçbir
//    şey yapılmaz: tek bir kelimenin tesadüfen etikete benzemesi bir sayfayı
//    tabloya çeviremez.
const COLUMN_GAP_RATIO = 1.2;
const MIN_COLUMN_GAP = 10;
const MIN_HEADER_LABELS = 2;

function recordGeometry(record) {
  if (Array.isArray(record?.transform)) {
    const size = Math.max(Math.abs(Number(record.transform[3]) || 0), Number(record.height) || 0, 1);
    const x = Number(record.transform[4]) || 0;
    return { x, right: x + (Number(record.width) || 0), size };
  }
  if (record?.bbox) {
    const x = Number(record.bbox.x0) || 0;
    const right = Number(record.bbox.x1) || x;
    return { x, right, size: Math.max((Number(record.bbox.y1) || 0) - (Number(record.bbox.y0) || 0), 1) };
  }
  return null;
}

function lineRanges(text) {
  const ranges = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === "\n") {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  return ranges;
}

function lineCells(text, records) {
  const cells = [];
  let current = null;
  for (const record of records) {
    const geometry = recordGeometry(record);
    if (!geometry) continue;
    const gapLimit = Math.max((current?.size || geometry.size) * COLUMN_GAP_RATIO, MIN_COLUMN_GAP);
    // Sütun aralığı çoğu PDF'te geometrik boşluk değil, kendi genişliği olan
    // ayrı bir boşluk kaydıdır; o hesaba katılmazsa satırın tamamı tek hücre
    // görünür ve tablo hiç fark edilmez.
    if (!String(record.str || "").trim()) {
      if (current && geometry.right - geometry.x > gapLimit) {
        cells.push(current);
        current = null;
      }
      continue;
    }
    if (current && geometry.x - current.right > gapLimit) {
      cells.push(current);
      current = null;
    }
    if (!current) current = { start: record.start, end: record.end, x: geometry.x, right: geometry.right, size: geometry.size };
    else {
      current.end = record.end;
      current.right = geometry.right;
      current.size = Math.max(current.size, geometry.size);
    }
  }
  if (current) cells.push(current);
  return cells
    .map((cell) => ({ ...cell, text: trimValue(text.slice(cell.start, cell.end)) }))
    .filter((cell) => cell.text);
}

function headerColumns(cells) {
  return cells.map((cell, position) => ({
    category: CATEGORY_BY_LABEL.get(foldLabel(cell.text.replace(/[:：]\s*$/u, ""))) || null,
    from: cell.x - cell.size,
    to: position + 1 < cells.length ? cells[position + 1].x - cell.size : Number.POSITIVE_INFINITY,
  }));
}

function collectFromPageLayout(text, records, collect) {
  if (!Array.isArray(records) || !records.length) return;
  const lines = lineRanges(text);
  const byLine = lines.map(() => []);
  let lineIndex = 0;
  for (const record of [...records].sort((left, right) => left.start - right.start)) {
    while (lineIndex < lines.length - 1 && record.start >= lines[lineIndex].end) lineIndex += 1;
    byLine[lineIndex].push(record);
  }

  const cellsByLine = byLine.map((lineRecords) => lineCells(text, lineRecords));
  for (let index = 0; index < cellsByLine.length; index += 1) {
    const header = cellsByLine[index];
    if (header.filter((cell) => isLabelOnly(cell.text)).length < MIN_HEADER_LABELS) continue;
    const columns = headerColumns(header);
    for (let ahead = index + 1; ahead < cellsByLine.length; ahead += 1) {
      const cells = cellsByLine[ahead];
      if (!cells.length) break;
      // Yeni bir başlık satırı: buradan sonrası başka bir tablodur.
      if (cells.filter((cell) => isLabelOnly(cell.text)).length >= MIN_HEADER_LABELS) break;
      const aligned = cells
        .map((cell) => ({ cell, column: columns.find((candidate) => cell.x >= candidate.from && cell.x < candidate.to) }))
        .filter((pair) => pair.column);
      // Gerçek bir veri satırı birden çok sütuna yayılır. Tek hücrelik satır
      // tablonun bittiği yerdir; devam edilirse tablodan sonraki düz metin
      // paragrafı ilk sütunun değeri sanılıp maskeleniyordu.
      if (aligned.length < MIN_HEADER_LABELS) break;
      for (const { cell, column } of aligned) {
        if (column.category && isAcceptableValue(column.category, cell.text)) collect(column.category, cell.text);
      }
    }
  }
}

export function detectLabelledFields(units) {
  const texts = units.map((unit) => (typeof unit === "string" ? unit : String(unit?.text || "")));
  const locations = units.map((unit) => (typeof unit === "string" ? null : unit?.location || null));
  const layouts = units.map((unit) => (typeof unit === "string" ? null : unit?.layout || null));
  const aggregate = new Map();

  const collectAt = (unitIndex) => (category, raw) => {
    const normalized = normalizeValue(category, raw);
    const key = matchKey(category, normalized);
    const current = aggregate.get(key);
    if (current) {
      current.variants.add(raw);
      current.units.add(unitIndex);
    } else {
      aggregate.set(key, { category, normalized, value: raw, variants: new Set([raw]), units: new Set([unitIndex]) });
    }
  };

  const dataCells = dataCellIndexes(texts, locations);
  for (let unitIndex = 0; unitIndex < texts.length; unitIndex += 1) {
    const collect = collectAt(unitIndex);
    for (const line of texts[unitIndex].split(/\r?\n/u)) collectFromLine(line, collect);
    collectFromNeighbour(texts, unitIndex, collect, dataCells);
    collectFromPageLayout(texts[unitIndex], layouts[unitIndex], collect);
  }

  collectFromColumnHeaders(texts, locations, collectAt);

  const categoryCounts = { person: 0, location: 0, documentNumber: 0 };
  return [...aggregate.values()].map((item, index) => {
    categoryCounts[item.category] += 1;
    const meta = categoryMetaFor(item.category);
    return {
      id: `field_${index + 1}`,
      // Maskeleme tarafı bu kaynağı varlık gibi ele alır: değer belgenin
      // tamamında, sözcük sınırlarıyla ve harf duyarsız aranır.
      source: "field",
      category: item.category,
      label: meta.label,
      value: item.value,
      originalText: item.value,
      variants: [...item.variants],
      normalized: item.normalized,
      count: item.variants.size,
      confidence: "probable",
      fieldLabelled: true,
      placeholder: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      replacementText: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      locations: [...item.units].map((unitIndex) => ({ unitIndex, start: 0, end: 0 })),
    };
  });
}

function categoryMetaFor(category) {
  return FIELD_CATEGORY_META[category];
}

const FIELD_CATEGORY_META = Object.freeze({
  person: { label: "Kişi adı", prefix: "KISI" },
  location: { label: "Adres/Konum", prefix: "KONUM" },
  documentNumber: { label: "Belge / kayıt no", prefix: "BELGE_NO" },
});

