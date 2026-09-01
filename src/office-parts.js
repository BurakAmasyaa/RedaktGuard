// Office paketi tek bir XML'den ibaret değildir. Metin; üstbilgi, altbilgi,
// dipnot, yorum, çizim, belge özellikleri ve ilişki dosyaları arasına dağılır.
// Yalnızca gövdeyi maskelemek en tehlikeli arızayı üretir: kullanıcı belgeyi
// indirir, maskelendiğini sanır, oysa isim paketin bir köşesinde durur.
//
// Bu modül paketin metin taşıyan tüm parçalarını tek bir soyutlamaya indirger:
// bir "yuva" (slot), okunabilen ve yerine yazılabilen mantıksal bir metindir.
// Tarama yuvaları okur, maskeleme aynı yuvalara yazar — ikisi asla ayrışmaz.

import { replaceText, replacementsForText } from "./pii.js";

const XML_SPACE_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

function preserveWhitespace(node) {
  const text = node.textContent || "";
  if (/^\s|\s$/u.test(text)) node.setAttributeNS(XML_SPACE_NAMESPACE, "xml:space", "preserve");
}

// Bir mantıksal metin birden çok düğüme bölünmüş olabilir: Word bir cümleyi
// biçimlendirme değiştiği her yerde ayrı <w:t>'ye böler, Excel zengin metni
// ayrı <r><t>'lere. Eşleşme bu sınırları aştığı için düğümler önce birleştirilip
// aranır, sonra sondan başa doğru yerine yazılır (önceki konumlar kaymasın diye).
export function replaceAcrossNodes(nodes, replacementMap, options = {}) {
  if (!nodes.length) return false;
  const original = nodes.map((node) => node.textContent || "").join("");
  const replacements = replacementsForText(original, replacementMap, options);
  if (!replacements.length) return false;

  const starts = [];
  let cursor = 0;
  for (const node of nodes) {
    starts.push(cursor);
    cursor += (node.textContent || "").length;
  }

  const locate = (position) => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (starts[index] <= position) return [index, position - starts[index]];
    }
    return [0, position];
  };

  for (const match of [...replacements].reverse()) {
    const [startNodeIndex, startOffset] = locate(match.start);
    const [endNodeIndex, finalCharacterOffset] = locate(match.end - 1);
    const endOffset = finalCharacterOffset + 1;
    const startNode = nodes[startNodeIndex];
    const endNode = nodes[endNodeIndex];

    if (startNodeIndex === endNodeIndex) {
      const text = startNode.textContent || "";
      startNode.textContent = text.slice(0, startOffset) + match.placeholder + text.slice(endOffset);
      preserveWhitespace(startNode);
      continue;
    }

    const prefix = (startNode.textContent || "").slice(0, startOffset);
    const suffix = (endNode.textContent || "").slice(endOffset);
    startNode.textContent = prefix + match.placeholder;
    for (let index = startNodeIndex + 1; index < endNodeIndex; index += 1) {
      nodes[index].textContent = "";
    }
    endNode.textContent = suffix;
    preserveWhitespace(startNode);
    preserveWhitespace(endNode);
  }
  return true;
}

function localNameOf(node) {
  return node.localName || String(node.nodeName).split(":").pop();
}

// Belge sırasını koruyan yürüyüş. Eşleşen düğümün içine inilmez; "sınır"
// düğümünün alt ağacı ise tamamen atlanır. Metin kutusu bu yüzden kendi
// birimini alır: dış paragraf onun metnini ikinci kez saymaz.
function collectOrdered(root, isMatch, isBoundary, into = []) {
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) continue;
    if (isMatch(child)) {
      into.push(child);
      continue;
    }
    if (isBoundary && isBoundary(child)) continue;
    collectOrdered(child, isMatch, isBoundary, into);
  }
  return into;
}

function elementsByLocalName(root, names) {
  const wanted = new Set(names);
  const found = [];
  const visit = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (wanted.has(localNameOf(child))) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function nodeGroupSlot(nodes, location) {
  return {
    location,
    read: () => nodes.map((node) => node.textContent || "").join(""),
    apply(replacementMap, options = {}) {
      let changed = false;
      // Ön dönüşüm yalnızca tek düğümlü yuvada uygulanabilir: çok düğümlü
      // metinde uzunluk değişirse aşağıdaki konum hesabı kayar. Sayfa
      // başvurusu gibi tek parça değerler zaten bölünmez.
      if (options.preTransform && nodes.length === 1) {
        const original = nodes[0].textContent || "";
        const transformed = options.preTransform(original, location);
        if (transformed !== original) {
          nodes[0].textContent = transformed;
          changed = true;
        }
      }
      return replaceAcrossNodes(nodes, replacementMap, options) || changed;
    },
  };
}

function attributeSlot(element, attribute, location) {
  return {
    location,
    read: () => attribute.value || "",
    apply(replacementMap, options = {}) {
      const original = attribute.value || "";
      const transformed = options.preTransform ? options.preTransform(original, location) : original;
      const replaced = replaceText(transformed, replacementMap, options);
      if (replaced === original) return false;
      element.setAttributeNS(attribute.namespaceURI || null, attribute.name, replaced);
      return true;
    },
  };
}

function attributeSlots(xmlDocument, localNames, location) {
  const wanted = new Set(localNames);
  const slots = [];
  const visit = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      for (const attribute of Array.from(child.attributes || [])) {
        if (wanted.has(localNameOf(attribute))) {
          slots.push(attributeSlot(child, attribute, { ...location, field: localNameOf(attribute) }));
        }
      }
      visit(child);
    }
  };
  visit(xmlDocument);
  return slots;
}

function siblingIndexAmong(node, name) {
  let index = 0;
  for (let sibling = node.parentNode?.firstChild; sibling; sibling = sibling.nextSibling) {
    if (sibling.nodeType !== 1 || localNameOf(sibling) !== name) continue;
    if (sibling === node) return index;
    index += 1;
  }
  return index;
}

// Word tablosunda etiket satırın başında değil, sütunun tepesinde olabilir
// ("Adres No" başlığının altındaki numara). Etiketle değeri eşleyebilmek için
// paragrafın hangi tabloda, hangi satır ve sütunda olduğu gerekir; paragraf
// listesi bunu kendiliğinden söylemez. Ata düğümlerden okunur ve yalnızca
// gerçekten tablo içindeki paragraflara eklenir. İç içe tabloda en içteki
// hücre bulunur, ki doğrusu odur.
function tableCoordinates(node, tableIds) {
  let cell = null;
  let row = null;
  for (let current = node; current && current.nodeType === 1; current = current.parentNode) {
    const name = localNameOf(current);
    if (!cell && name === "tc") cell = current;
    else if (cell && !row && name === "tr") row = current;
    else if (cell && row && name === "tbl") {
      let table = tableIds.get(current);
      if (table === undefined) {
        table = tableIds.size;
        tableIds.set(current, table);
      }
      return { table, row: siblingIndexAmong(row, "tr"), column: siblingIndexAmong(cell, "tc") };
    }
  }
  return null;
}

// Paragraf biçimli parçalar: bir grup düğümü (paragraf, zengin metin, yorum
// gövdesi) ve içindeki metin düğümleri. Word, DrawingML ve SpreadsheetML'in
// üçü de bu şekle oturur.
function groupedTextSlots(xmlDocument, { groupNames, textNames }, location) {
  const groups = elementsByLocalName(xmlDocument, groupNames);
  const isText = (node) => textNames.includes(localNameOf(node));
  const isGroup = (node) => groupNames.includes(localNameOf(node));
  const tableIds = new Map();
  const slots = [];
  for (const group of groups) {
    const nodes = collectOrdered(group, isText, isGroup);
    if (!nodes.length) continue;
    const cell = tableCoordinates(group, tableIds);
    slots.push(nodeGroupSlot(nodes, cell
      ? { ...location, index: slots.length, cell }
      : { ...location, index: slots.length }));
  }
  return slots;
}

function elementTextSlots(xmlDocument, localNames, location) {
  return elementsByLocalName(xmlDocument, localNames)
    .filter((element) => (element.textContent || "").trim())
    .map((element) => nodeGroupSlot([element], { ...location, field: localNameOf(element) }));
}

// Dış köprüler ilişki dosyasında durur; hedef bir "mailto:" ise gövde temiz
// olsa bile e-posta paketin içindedir.
function externalRelationshipSlots(xmlDocument, location) {
  const slots = [];
  for (const relationship of elementsByLocalName(xmlDocument, ["Relationship"])) {
    if (relationship.getAttribute("TargetMode") !== "External") continue;
    const attribute = relationship.getAttributeNode("Target");
    if (!attribute) continue;
    slots.push(attributeSlot(relationship, attribute, { ...location, field: "Target" }));
  }
  return slots;
}

const WORD_TEXT_ELEMENTS = ["t", "delText", "instrText"];
// Yorum, revizyon ve kişi kayıtlarında ad ve e-posta metin değil özniteliktir.
const AUTHOR_ATTRIBUTES = ["author", "initials", "userId", "displayName", "providerId"];

// Metin her zaman düğüm içinde durmaz. Alan kodu (w:fldSimple/@w:instr),
// görselin alternatif metni (wp:docPr/@descr), köprü ipucu (@w:tooltip) ve
// çizim adı kullanıcının yazdığı metni öznitelikte taşır; taranmadıkları için
// çıktıda aynen kalıyorlardı.
const TEXT_BEARING_ATTRIBUTES = ["instr", "descr", "tooltip", "title", "name"];

const DOCUMENT_PROPERTY_ELEMENTS = [
  "creator", "lastModifiedBy", "title", "subject", "description", "keywords", "category",
  "Company", "Manager", "Application", "HyperlinkBase", "contentStatus",
];

const HANDLERS = [
  {
    // Gövde, üstbilgi, altbilgi, dipnot, sonnot, yorum metni, sözlük parçası.
    match: /^word\/(document2?|header\d*|footer\d*|footnotes|endnotes|comments|glossary\/document)\.xml$/u,
    slots: (xmlDocument, location) => [
      ...groupedTextSlots(xmlDocument, { groupNames: ["p"], textNames: WORD_TEXT_ELEMENTS }, location),
      ...attributeSlots(xmlDocument, [...AUTHOR_ATTRIBUTES, ...TEXT_BEARING_ATTRIBUTES], location),
    ],
  },
  {
    match: /^word\/people\.xml$/u,
    slots: (xmlDocument, location) => attributeSlots(xmlDocument, AUTHOR_ATTRIBUTES, location),
  },
  {
    // Grafik ve çizim kutuları: DrawingML paragrafları, ayrıca grafiğin
    // önbelleğe aldığı hücre değerleri ve sayfa başvuruları.
    match: /^(word|xl|ppt)\/(charts|drawings|diagrams)\/.+\.xml$/u,
    slots: (xmlDocument, location) => [
      ...groupedTextSlots(xmlDocument, { groupNames: ["p"], textNames: ["t"] }, location),
      ...elementTextSlots(xmlDocument, ["v", "f"], location),
    ],
  },
  {
    match: /^xl\/sharedStrings\.xml$/u,
    slots: (xmlDocument, location) => groupedTextSlots(xmlDocument, { groupNames: ["si"], textNames: ["t"] }, location),
  },
  {
    match: /^xl\/comments\d*\.xml$/u,
    slots: (xmlDocument, location) => [
      ...groupedTextSlots(xmlDocument, { groupNames: ["text"], textNames: ["t"] }, location),
      ...elementTextSlots(xmlDocument, ["author"], location),
    ],
  },
  {
    match: /^xl\/threadedComments\/.+\.xml$/u,
    slots: (xmlDocument, location) => elementTextSlots(xmlDocument, ["text"], location),
  },
  {
    match: /^xl\/persons\/.+\.xml$/u,
    slots: (xmlDocument, location) => attributeSlots(xmlDocument, AUTHOR_ATTRIBUTES, location),
  },
  {
    // Sayfa adları office.js'de ayrı ele alınır (Excel'in ad kuralları var);
    // burada tanımlı adların formül metni taranır.
    match: /^xl\/workbook\.xml$/u,
    slots: (xmlDocument, location) => elementTextSlots(xmlDocument, ["definedName"], location),
  },
  {
    match: /^docProps\/(core|app)\.xml$/u,
    slots: (xmlDocument, location) => elementTextSlots(xmlDocument, DOCUMENT_PROPERTY_ELEMENTS, location),
  },
  {
    // Özel belge alanları: adı da değeri de kullanıcı tarafından yazılır.
    match: /^docProps\/custom\.xml$/u,
    slots: (xmlDocument, location) => [
      ...elementTextSlots(xmlDocument, ["lpstr", "lpwstr", "bstr"], location),
      ...attributeSlots(xmlDocument, ["name"], location),
    ],
  },
  {
    // İçerik denetimi veri deposu. Gövdedeki alan bir yer tutucuya çevrilse
    // bile Word dosyayı açtığında değeri BURADAN geri dolduruyor; bu parça
    // taranmadığı sürece maskeleme kalıcı değildir.
    match: /^customXml\/(item\d*|itemProps\d*)\.xml$/u,
    slots: (xmlDocument, location) => [
      ...elementTextSlots(xmlDocument, ALL_TEXT_ELEMENTS(xmlDocument), location),
      ...attributeSlots(xmlDocument, TEXT_BEARING_ATTRIBUTES, location),
    ],
  },
  {
    // Pivot önbelleği kaynak hücrelerin değerlerini kopyalar; sayfa maskelense
    // bile pivot tablo orijinali göstermeye devam ediyordu.
    match: /^xl\/pivotCache\/.+\.xml$/u,
    slots: (xmlDocument, location) => [
      ...elementTextSlots(xmlDocument, ["s"], location),
      ...attributeSlots(xmlDocument, ["v", "name", "caption"], location),
    ],
  },
  {
    // Tablo ve sütun adları, otomatik filtre değerleri.
    match: /^xl\/tables\/.+\.xml$/u,
    slots: (xmlDocument, location) => attributeSlots(xmlDocument, ["name", "displayName", "val", "totalsRowLabel"], location),
  },
  {
    // Sayfanın kendi XML'i: veri doğrulama listesi, otomatik filtre değeri,
    // köprü metni ve ipucu. Hücre değerleri workbook üzerinden ayrıca işlenir.
    match: /^xl\/worksheets\/sheet\d*\.xml$/u,
    slots: (xmlDocument, location) => [
      ...elementTextSlots(xmlDocument, ["formula1", "formula2"], location),
      ...attributeSlots(xmlDocument, ["val", "display", "tooltip", "prompt", "promptTitle", "error", "errorTitle"], location),
    ],
  },
  {
    match: /^xl\/connections\.xml$/u,
    slots: (xmlDocument, location) => attributeSlots(xmlDocument, ["name", "description", "connection", "command"], location),
  },
  {
    match: /_rels\/[^/]+\.rels$/u,
    slots: (xmlDocument, location) => externalRelationshipSlots(xmlDocument, location),
  },
];

// customXml şeması serbesttir; metin taşıyan eleman adları önceden bilinemez.
function ALL_TEXT_ELEMENTS(xmlDocument) {
  const names = new Set();
  const visit = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      const hasText = Array.from(child.childNodes || []).some((leaf) => leaf.nodeType === 3 && (leaf.nodeValue || "").trim());
      if (hasText) names.add(localNameOf(child));
      visit(child);
    }
  };
  visit(xmlDocument);
  return [...names];
}

export function handlerFor(path) {
  return HANDLERS.find((handler) => handler.match.test(path)) || null;
}

export function partPaths(zip) {
  return Object.values(zip.files)
    .filter((entry) => !entry.dir && handlerFor(entry.name))
    .map((entry) => entry.name)
    // Gövde önce gelsin: bulgu numaraları ([EMAIL_1], [KISI_1]) belgenin
    // okunma sırasını izlesin, üstbilgiden başlamasın.
    .sort((left, right) => Number(right.endsWith("word/document.xml")) - Number(left.endsWith("word/document.xml")) || left.localeCompare(right));
}

// Paketin metin taşıyan parçalarını okur. Dönen `parts` maskeleme sırasında
// aynen yeniden kullanılır; tarama ile yazma arasında ikinci bir yorum yoktur.
export async function readParts(zip, parseXml, { kind, skip = () => false } = {}) {
  const parts = [];
  const slots = [];
  for (const path of partPaths(zip)) {
    if (skip(path)) continue;
    const handler = handlerFor(path);
    let xmlDocument;
    try {
      xmlDocument = parseXml(await zip.file(path).async("string"));
    } catch {
      // Bozuk yan parça belgenin tamamını reddetmeye değmez; gövde zaten
      // ayrıca doğrulanıyor. Ama sessizce geçilmemesi için işaretlenir.
      parts.push({ path, xmlDocument: null, slots: [], unreadable: true });
      continue;
    }
    const partSlots = handler.slots(xmlDocument, { kind, part: path });
    parts.push({ path, xmlDocument, slots: partSlots });
    slots.push(...partSlots);
  }
  return { parts, slots };
}

export function partUnits(slots) {
  return slots
    .map((slot) => ({ text: slot.read(), location: slot.location }))
    .filter((unit) => unit.text.trim());
}

export function applyParts(parts, replacementMap, options = {}) {
  const changed = new Set();
  for (const part of parts) {
    for (const slot of part.slots) {
      if (slot.apply(replacementMap, options)) changed.add(part.path);
    }
  }
  return changed;
}

export function writeParts(zip, parts, serializeXml, changed) {
  for (const part of parts) {
    if (!part.xmlDocument || !changed.has(part.path)) continue;
    zip.file(part.path, serializeXml(part.xmlDocument));
  }
}

export function unreadableParts(parts) {
  return parts.filter((part) => part.unreadable).map((part) => part.path);
}
