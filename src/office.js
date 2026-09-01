import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  aggregateFindings,
  createReplacementMap,
  NUMERIC_SAFE_CATEGORIES,
  redactedOutputFilename,
  replaceText,
} from "./pii.js";
import { redactEmbeddedImages, scanEmbeddedImages } from "./office-images.js";
import { applyParts, partUnits, readParts, unreadableParts, writeParts } from "./office-parts.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MIME = "application/pdf";

function extensionOf(filename) {
  const match = /\.[^.]+$/u.exec(filename.toLowerCase());
  return match ? match[0] : "";
}

function requireXmlTools() {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new Error("Bu tarayıcı Office XML dosyalarını işlemek için gereken desteği sunmuyor.");
  }
}

function parseOfficeXml(xml) {
  requireXmlTools();
  const document = new DOMParser().parseFromString(xml.replace(/^﻿/u, ""), "application/xml");
  if (document.getElementsByTagName("parsererror").length) {
    throw new Error("Belgenin metin yapısı okunamadı.");
  }
  return document;
}

function serializeOfficeXml(xmlDocument) {
  return new XMLSerializer().serializeToString(xmlDocument);
}

function elementsByLocalName(xmlDocument, localName) {
  return Array.from(xmlDocument.getElementsByTagNameNS("*", localName));
}

// Bir hücrenin maskelenebilir metni birden fazla olabilir: formülün kendisi ve
// formülün ürettiği önbellek değeri. İkincisi Excel'de görünen, birincisi formül
// çubuğunda görünen değerdir; ikisi de sızabilir.
function cellSlots(cell) {
  if (!cell) return [];
  const slots = [];
  if (typeof cell.f === "string" && cell.f.trim()) slots.push({ field: "f", text: cell.f, numeric: false });
  if (typeof cell.v === "string") slots.push({ field: "v", text: cell.v, numeric: false });
  else if (typeof cell.v === "number" && Number.isSafeInteger(cell.v)) {
    slots.push({ field: "v", text: String(cell.v), numeric: true });
  }
  return slots;
}

// Sayfanın bildirdiği aralık (<dimension>) gerçeği yansıtmayabilir: "A1:A1"
// derken B5'te veri durabilir. Bu hücreler Excel'de görünür ama aralık
// gezilerek okunduğunda hiç taranmıyordu. Aralık gerçekte var olan hücrelere
// göre onarılır; onarılmazsa hücre ya sessizce sızar ya da yazma aşamasında
// paket eşleşmesi kopar.
function repairSheetRanges(workbook) {
  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    let start = null;
    let end = null;
    for (const address of Object.keys(sheet)) {
      if (address.startsWith("!")) continue;
      let cell;
      try {
        cell = XLSX.utils.decode_cell(address);
      } catch {
        continue;
      }
      if (!start) {
        start = { r: cell.r, c: cell.c };
        end = { r: cell.r, c: cell.c };
        continue;
      }
      start.r = Math.min(start.r, cell.r);
      start.c = Math.min(start.c, cell.c);
      end.r = Math.max(end.r, cell.r);
      end.c = Math.max(end.c, cell.c);
    }
    if (start) sheet["!ref"] = XLSX.utils.encode_range({ s: start, e: end });
  }
}

function workbookCells(workbook) {
  const cells = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    // Sayfanın bildirdiği aralık (<dimension>) eksik olabilir; dışında kalan
    // hücreler Excel'de görünür ama hiç taranmıyordu. Aralığı gezmek yerine
    // sayfanın kendi hücre anahtarları gezilir, böylece bildirim yanlış ya da
    // eksik olsa da hiçbir hücre atlanmaz.
    for (const address of Object.keys(sheet)) {
      if (address.startsWith("!")) continue;
      const cell = sheet[address];
      for (const slot of cellSlots(cell)) {
        cells.push({ cell, ...slot, address, sheetName });
      }
    }
  }
  return cells;
}

function appendImageUnits(units, images, kind) {
  for (const image of images) {
    if (!image.text.trim()) continue;
    image.unitIndex = units.length;
    units.push({
      text: image.text,
      location: { kind: "office-image", documentKind: kind, mediaPath: image.path },
    });
  }
}

export async function scanDocx(arrayBuffer, filename, options = {}) {
  const zip = await JSZip.loadAsync(arrayBuffer, { checkCRC32: true });
  if (!zip.file("word/document.xml")) throw new Error("Bu dosya geçerli bir DOCX belgesi değil.");

  // Gövde, üstbilgi, altbilgi, dipnot, sonnot, yorum, kişi kayıtları, çizimler,
  // belge özellikleri ve dış köprü hedefleri — hepsi tek geçişte okunur.
  const { parts, slots } = await readParts(zip, parseOfficeXml, { kind: "docx" });
  if (!parts.some((part) => part.path === "word/document.xml" && !part.unreadable)) {
    throw new Error("Word belgesinin metin yapısı okunamadı.");
  }

  const units = partUnits(slots);
  const ocrImages = await scanEmbeddedImages(zip, "word/media", options);
  appendImageUnits(units, ocrImages, "docx");
  const texts = units.map((unit) => unit.text);
  const findings = aggregateFindings(units);
  return {
    context: {
      kind: "docx",
      filename,
      zip,
      parts,
      xmlDocument: parts.find((part) => part.path === "word/document.xml")?.xmlDocument || null,
      skippedParts: unreadableParts(parts),
      texts,
      units,
      ocrImages,
      ocrImageCount: ocrImages.length,
    },
    findings,
  };
}

export async function scanXlsx(arrayBuffer, filename, options = {}) {
  const workbook = XLSX.read(arrayBuffer, {
    type: "array",
    cellStyles: true,
    cellFormula: true,
    cellDates: true,
    bookVBA: true,
  });
  repairSheetRanges(workbook);
  const originalZip = await JSZip.loadAsync(arrayBuffer, { checkCRC32: true });
  if (!originalZip.file("xl/workbook.xml")) throw new Error("Bu dosya geçerli bir XLSX çalışma kitabı değil.");

  const cells = workbookCells(workbook);
  const units = [];
  for (const entry of cells) {
    entry.unitIndex = units.length;
    units.push({
      text: entry.text,
      location: { kind: "xlsx", sheetName: entry.sheetName, address: entry.address, field: entry.field },
      categories: entry.numeric ? NUMERIC_SAFE_CATEGORIES : null,
    });
  }

  // Sayfa adı da müşteri adı taşıyabilir ve dosyanın en görünür yerindedir.
  const sheetNameUnits = workbook.SheetNames.map((sheetName) => ({
    text: sheetName,
    location: { kind: "xlsx", part: "xl/workbook.xml", field: "sheetName", sheetName },
  }));
  units.push(...sheetNameUnits);

  const { parts, slots } = await readParts(originalZip, parseOfficeXml, { kind: "xlsx" });
  units.push(...partUnits(slots));

  const ocrImages = await scanEmbeddedImages(originalZip, "xl/media", options);
  appendImageUnits(units, ocrImages, "xlsx");
  const texts = units.map((unit) => unit.text);
  const findings = aggregateFindings(units);
  return {
    context: {
      kind: "xlsx",
      filename,
      workbook,
      originalZip,
      cells,
      parts,
      skippedParts: unreadableParts(parts),
      texts,
      units,
      ocrImages,
      ocrImageCount: ocrImages.length,
    },
    findings,
  };
}

export async function estimateXlsxRows(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const worksheetEntries = Object.values(zip.files).filter((entry) =>
    !entry.dir && /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name)
  );
  let totalRows = 0;
  for (const entry of worksheetEntries) {
    const xml = await entry.async("string");
    const dimension = /<(?:\w+:)?dimension\b[^>]*\bref="(?:[^:"]+:)?[A-Z]+(\d+)"/iu.exec(xml);
    if (dimension) totalRows += Number(dimension[1]) || 0;
    else totalRows += (xml.match(/<(?:\w+:)?row\b/gu) || []).length;
  }
  return totalRows;
}

export async function scanOffice(arrayBuffer, filename, options = {}) {
  const extension = extensionOf(filename);
  if (extension === ".docx") return scanDocx(arrayBuffer, filename, options);
  if (extension === ".xlsx") return scanXlsx(arrayBuffer, filename, options);
  if (extension === ".pdf") {
    const { scanPdf } = await import("./pdf.js");
    return scanPdf(arrayBuffer, filename, options);
  }
  throw new Error("Yalnızca .docx, .xlsx ve metin katmanlı .pdf dosyaları destekleniyor.");
}

export async function scanOfficeNamedEntities(context, options = {}) {
  const { detectNamedEntities } = await import("./ner.js");
  return detectNamedEntities(context.texts || [], options);
}

export async function disposeOfficeContext(context) {
  context.xmlDocument = null;
  context.workbook = null;
  context.originalZip = null;
  context.zip = null;
  context.parts = null;
  context.cells = null;
  context.texts = [];
  context.units = [];
  context.ocrImages = [];
}

export async function redactDocx(context, replacementMap, options = {}) {
  const changed = applyParts(context.parts, replacementMap);
  writeParts(context.zip, context.parts, serializeOfficeXml, changed);
  await redactEmbeddedImages(context.zip, context.ocrImages, replacementMap, options);
  return context.zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: DOCX_MIME,
  });
}

function normalizeZipPath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${base}/${target}`.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

async function sheetPartMap(zip) {
  const workbookEntry = zip.file("xl/workbook.xml");
  const relationshipsEntry = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relationshipsEntry) throw new Error("Excel sayfa ilişkileri okunamadı.");
  const workbookDocument = parseOfficeXml(await workbookEntry.async("string"));
  const relationshipsDocument = parseOfficeXml(await relationshipsEntry.async("string"));
  const targets = new Map(
    elementsByLocalName(relationshipsDocument, "Relationship").map((relationship) => [
      relationship.getAttribute("Id"),
      normalizeZipPath("xl", relationship.getAttribute("Target")),
    ])
  );
  return new Map(
    elementsByLocalName(workbookDocument, "sheet").map((sheet) => [
      sheet.getAttribute("name"),
      targets.get(sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships/", "id")),
    ])
  );
}

function cellsByAddress(xmlDocument) {
  return new Map(
    elementsByLocalName(xmlDocument, "c")
      .map((cell) => [cell.getAttribute("r"), cell])
      .filter(([address]) => Boolean(address))
  );
}

const TRANSPLANTED_CHILDREN = ["v", "is", "f"];

function transplantCellValue(originalCell, generatedCell) {
  const generatedType = generatedCell.getAttribute("t");
  if (generatedType) originalCell.setAttribute("t", generatedType);
  else originalCell.removeAttribute("t");

  for (const child of Array.from(originalCell.childNodes)) {
    if (child.nodeType === 1 && TRANSPLANTED_CHILDREN.includes(child.localName || child.nodeName.split(":").pop())) {
      originalCell.removeChild(child);
    }
  }
  for (const child of Array.from(generatedCell.childNodes)) {
    if (child.nodeType === 1 && TRANSPLANTED_CHILDREN.includes(child.localName || child.nodeName.split(":").pop())) {
      originalCell.appendChild(child.cloneNode(true));
    }
  }
}

// Excel sayfa adlarında bu karakterler yasaktır ve ad 31 karakteri aşamaz.
// Yer tutucu doğrudan yazılırsa ("[EMAIL_1]") Excel dosyayı bozuk sayar.
const FORBIDDEN_SHEET_CHARACTERS = /[[\]:*?/\\]/gu;

function safeSheetName(candidate, used) {
  let name = String(candidate).replace(FORBIDDEN_SHEET_CHARACTERS, "_").replace(/^'+|'+$/gu, "").trim().slice(0, 31);
  if (!name) name = "Sayfa";
  let unique = name;
  let counter = 2;
  while (used.has(unique.toLocaleLowerCase("tr-TR"))) {
    const suffix = `_${counter}`;
    counter += 1;
    unique = name.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(unique.toLocaleLowerCase("tr-TR"));
  return unique;
}

function computeSheetRenames(sheetNames, replacementMap) {
  const renames = new Map();
  const used = new Set();
  for (const sheetName of sheetNames) {
    const replaced = replaceText(sheetName, replacementMap);
    if (replaced === sheetName) {
      used.add(sheetName.toLocaleLowerCase("tr-TR"));
      continue;
    }
    renames.set(sheetName, safeSheetName(replaced, used));
  }
  return renames;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Sayfa adı değişince ona yapılan tüm başvurular da değişmeli, yoksa formüller
// #REF! olur. Başvuru ya tırnaklı ('Satış 2026'!A1) ya da çıplaktır (Rapor!A1).
function rewriteSheetReferences(text, renames) {
  if (!renames.size || !text) return text;
  let output = String(text);
  for (const [oldName, newName] of renames) {
    const quotedOld = oldName.replace(/'/gu, "''");
    const quotedNew = newName.replace(/'/gu, "''");
    output = output.replace(new RegExp(`'${escapeForRegExp(quotedOld)}'(?=!)`, "gu"), `'${quotedNew}'`);
    if (/^[A-Za-z_\\][\w.\\]*$/u.test(oldName)) {
      output = output.replace(new RegExp(`(?<![\\w.'!])${escapeForRegExp(oldName)}(?=!)`, "gu"), newName);
    }
  }
  return output;
}

function applySheetRenamesToPart(part, renames) {
  if (!part?.xmlDocument || !renames.size) return false;
  let changed = false;
  for (const sheet of elementsByLocalName(part.xmlDocument, "sheet")) {
    const current = sheet.getAttribute("name");
    if (renames.has(current)) {
      sheet.setAttribute("name", renames.get(current));
      changed = true;
    }
  }
  // docProps/app.xml sayfa adlarını ikinci bir kopya olarak taşır.
  for (const entry of elementsByLocalName(part.xmlDocument, "lpstr")) {
    const current = entry.textContent || "";
    if (renames.has(current)) {
      entry.textContent = renames.get(current);
      changed = true;
    }
  }
  return changed;
}

async function preserveOriginalXlsxPackage(originalZip, generatedBytes, modifiedBySheet, renames) {
  const generatedZip = await JSZip.loadAsync(generatedBytes);
  const originalParts = await sheetPartMap(originalZip);
  const generatedParts = await sheetPartMap(generatedZip);

  for (const [sheetName, addresses] of modifiedBySheet) {
    const originalPath = originalParts.get(sheetName) || originalParts.get(renames.get(sheetName));
    const generatedPath = generatedParts.get(sheetName) || generatedParts.get(renames.get(sheetName));
    const originalEntry = originalZip.file(originalPath);
    const generatedEntry = generatedZip.file(generatedPath);
    if (!originalEntry || !generatedEntry) throw new Error("Excel sayfa içeriği yeniden yazılamadı.");
    const originalDocument = parseOfficeXml(await originalEntry.async("string"));
    const generatedDocument = parseOfficeXml(await generatedEntry.async("string"));
    const originalCells = cellsByAddress(originalDocument);
    const generatedCells = cellsByAddress(generatedDocument);

    for (const address of addresses) {
      const originalCell = originalCells.get(address);
      const generatedCell = generatedCells.get(address);
      if (!originalCell || !generatedCell) throw new Error(`Excel hücresi güncellenemedi: ${address}`);
      transplantCellValue(originalCell, generatedCell);
    }
    originalZip.file(originalPath, serializeOfficeXml(originalDocument));
  }

  return originalZip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: XLSX_MIME,
  });
}

export async function redactXlsx(context, replacementMap, options = {}) {
  const renames = computeSheetRenames(context.workbook.SheetNames, replacementMap);
  const modifiedBySheet = new Map();
  const cells = context.cells || workbookCells(context.workbook);

  const markModified = (sheetName, address) => {
    if (!modifiedBySheet.has(sheetName)) modifiedBySheet.set(sheetName, new Set());
    modifiedBySheet.get(sheetName).add(address);
  };
  const valueChanged = new Set();
  const formulaChanged = new Set();

  for (const entry of cells) {
    const { cell, text, address, sheetName, numeric, field, unitIndex } = entry;
    const source = field === "f" ? rewriteSheetReferences(text, renames) : text;
    const replaced = replaceText(source, replacementMap, numeric ? { categories: NUMERIC_SAFE_CATEGORIES } : {});
    if (replaced === text) continue;
    if (field === "f") {
      cell.f = replaced;
      formulaChanged.add(`${sheetName}\u0000${address}`);
    } else {
      cell.v = replaced;
      cell.t = "s";
      delete cell.w;
      delete cell.r;
      delete cell.h;
      valueChanged.add(`${sheetName}\u0000${address}`);
    }
    markModified(sheetName, address);
  }

  // Önbellek değeri maskelendiği hâlde formül dokunulmadan kalırsa Excel dosyayı
  // açtığında formülü yeniden hesaplar ve orijinali geri getirir. O formül düşer.
  for (const key of valueChanged) {
    if (formulaChanged.has(key)) continue;
    const [sheetName, address] = key.split("\u0000");
    const cell = context.workbook.Sheets[sheetName]?.[address];
    if (cell?.f) delete cell.f;
  }

  const generatedBytes = XLSX.write(context.workbook, {
    bookType: "xlsx",
    type: "array",
    cellStyles: true,
    bookSST: false,
    compression: true,
  });

  await redactEmbeddedImages(context.originalZip, context.ocrImages, replacementMap, options);

  // Paylaşılan dizge tablosu, hücre notları, çizim kutuları, belge özellikleri
  // ve dış köprüler. Hücreler yamalanmış olsa da orijinal metin bu parçalarda
  // durmaya devam ederdi.
  const changed = applyParts(context.parts, replacementMap, {
    preTransform: (text) => rewriteSheetReferences(text, renames),
  });
  for (const part of context.parts) {
    if (applySheetRenamesToPart(part, renames)) changed.add(part.path);
  }
  writeParts(context.originalZip, context.parts, serializeOfficeXml, changed);

  return preserveOriginalXlsxPackage(context.originalZip, generatedBytes, modifiedBySheet, renames);
}

export async function redactOffice(context, findings, selectedIds, options = {}) {
  if (!selectedIds.length) throw new Error("En az bir öğe seçin.");
  const replacementMap = createReplacementMap(findings, selectedIds);
  let bytes;
  if (context.kind === "docx") bytes = await redactDocx(context, replacementMap, options);
  else if (context.kind === "xlsx") bytes = await redactXlsx(context, replacementMap, options);
  else if (context.kind === "pdf") {
    const { redactPdf } = await import("./pdf.js");
    bytes = await redactPdf(context, replacementMap, options);
  } else throw new Error("Belge türü desteklenmiyor.");
  return {
    bytes,
    mimeType: context.kind === "docx" ? DOCX_MIME : context.kind === "xlsx" ? XLSX_MIME : PDF_MIME,
    filename: outputFilename(context.filename, replacementMap),
  };
}

// Maskeleme haritası verildiğinde ad da belgeyle aynı yer tutucularla yazılır.
export function outputFilename(filename, replacementMap = null) {
  return redactedOutputFilename(filename, replacementMap);
}

export const docxAdapter = Object.freeze({
  id: "docx",
  extensions: [".docx"],
  mimeType: DOCX_MIME,
  canHandle: (filename) => extensionOf(filename) === ".docx",
  extract: scanDocx,
  applyChanges: redactDocx,
  outputFilename,
});

export const xlsxAdapter = Object.freeze({
  id: "xlsx",
  extensions: [".xlsx"],
  mimeType: XLSX_MIME,
  canHandle: (filename) => extensionOf(filename) === ".xlsx",
  extract: scanXlsx,
  applyChanges: redactXlsx,
  outputFilename,
});
