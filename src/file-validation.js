import JSZip from "jszip";

export const MAX_DOCUMENT_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_OFFICE_UNCOMPRESSED_SIZE = 250 * 1024 * 1024;
export const MAX_OFFICE_ENTRY_COUNT = 10_000;

const EXTENSION_KIND = Object.freeze({
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pdf": "pdf",
  ".txt": "txt",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
});

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

function extensionOf(filename) {
  const match = String(filename || "").toLowerCase().match(/\.[^.]+$/u);
  return match?.[0] || "";
}

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes, start = 0, end = bytes.length) {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

function validatePdf(bytes) {
  const header = ascii(bytes, 0, Math.min(bytes.length, 1024));
  const trailer = ascii(bytes, Math.max(0, bytes.length - 4096));
  return /%PDF-1\.[0-9]/u.test(header) && /%%EOF[\s\0]*$/u.test(trailer);
}

function validatePng(bytes) {
  return bytes.length >= 20
    && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && ascii(bytes, 12, 16) === "IHDR"
    && ascii(bytes, Math.max(0, bytes.length - 8), bytes.length - 4) === "IEND";
}

function validateJpeg(bytes) {
  return bytes.length >= 4
    && startsWith(bytes, [0xff, 0xd8, 0xff])
    && bytes.at(-2) === 0xff
    && bytes.at(-1) === 0xd9;
}

function validateTxt(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.includes("\u0000")) return false;
  const controls = [...text].filter((character) => {
    const code = character.codePointAt(0);
    return code < 32 && ![9, 10, 13].includes(code);
  }).length;
  return !text.length || controls / text.length < 0.01;
}

async function validateOffice(bytes, kind) {
  if (!startsWith(bytes, [0x50, 0x4b])) return false;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    return false;
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_OFFICE_ENTRY_COUNT) throw new Error("Office dosyası güvenli giriş sayısı sınırını aşıyor.");
  const uncompressedSize = entries.reduce((total, entry) => total + (Number(entry?._data?.uncompressedSize) || 0), 0);
  if (uncompressedSize > MAX_OFFICE_UNCOMPRESSED_SIZE) throw new Error("Office dosyasının açılmış boyutu güvenli sınırı aşıyor.");
  if (!zip.file("[Content_Types].xml")) return false;
  return kind === "docx"
    ? Boolean(zip.file("word/document.xml"))
    : Boolean(zip.file("xl/workbook.xml"));
}

export function acceptedDocumentExtensions() {
  return Object.keys(EXTENSION_KIND);
}

export async function validateDocumentBytes(input, filename, options = {}) {
  const bytes = bytesOf(input);
  const maximumSize = options.maximumSize ?? MAX_DOCUMENT_FILE_SIZE;
  if (bytes.byteLength > maximumSize) throw new Error(`Dosya boyutu ${Math.round(maximumSize / 1024 / 1024)} MB sınırını aşıyor.`);
  if (!bytes.byteLength) throw new Error("Boş dosya işlenemez.");
  const extension = extensionOf(filename);
  const kind = EXTENSION_KIND[extension];
  if (!kind) throw new Error("Yalnızca gerçek DOCX, XLSX, PDF, UTF-8 TXT, JPG ve PNG dosyaları destekleniyor.");

  let genuine = false;
  if (kind === "docx" || kind === "xlsx") genuine = await validateOffice(bytes, kind);
  else if (kind === "pdf") genuine = validatePdf(bytes);
  else if (kind === "png") genuine = validatePng(bytes);
  else if (kind === "jpeg") genuine = validateJpeg(bytes);
  else genuine = validateTxt(bytes);
  if (!genuine) {
    if (kind === "txt") throw new Error("TXT dosyası UTF-8 olarak okunamadı veya ikili içerik taşıyor.");
    throw new Error(`${filename} dosyasının içeriği uzantısıyla eşleşmiyor veya dosya bozuk.`);
  }
  return Object.freeze({ kind, extension, byteLength: bytes.byteLength });
}
