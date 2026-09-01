import { aggregateFindings, redactedOutputFilename, replaceText } from "./pii.js";

const TXT_MIME = "text/plain;charset=utf-8";
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function asBytes(arrayBuffer) {
  if (arrayBuffer instanceof Uint8Array) return arrayBuffer.slice();
  return new Uint8Array(arrayBuffer.slice(0));
}

function hasUtf8Bom(bytes) {
  return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function lineEndingOf(text) {
  const crlf = (text.match(/\r\n/gu) || []).length;
  const lf = (text.match(/(?<!\r)\n/gu) || []).length;
  return crlf >= lf && crlf > 0 ? "crlf" : "lf";
}

export async function scanTxt(arrayBuffer, filename) {
  const bytes = asBytes(arrayBuffer);
  const bom = hasUtf8Bom(bytes);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.slice(3) : bytes);
  } catch {
    throw new Error("TXT dosyası UTF-8 olarak okunamadı. UTF-8 veya UTF-8 BOM biçiminde kaydedip tekrar deneyin.");
  }
  if (/\u0000/u.test(text)) throw new Error("Bu TXT dosyası desteklenmeyen bir kodlama veya ikili içerik kullanıyor.");

  const units = [{ text, location: { kind: "txt", start: 0, end: text.length } }];
  return {
    context: { kind: "txt", filename, text, texts: [text], units, bom, lineEnding: lineEndingOf(text) },
    findings: aggregateFindings(units),
  };
}

export async function redactTxt(context, replacementMap) {
  const encoded = new TextEncoder().encode(replaceText(context.text, replacementMap));
  if (!context.bom) return encoded;
  const output = new Uint8Array(UTF8_BOM.length + encoded.length);
  output.set(UTF8_BOM, 0);
  output.set(encoded, UTF8_BOM.length);
  return output;
}

function outputTxtFilename(filename, replacementMap = null) {
  return redactedOutputFilename(filename, replacementMap);
}

export const txtAdapter = Object.freeze({
  id: "txt",
  extensions: [".txt"],
  mimeType: TXT_MIME,
  canHandle: (filename) => /\.txt$/iu.test(filename),
  extract: scanTxt,
  applyChanges: redactTxt,
  outputFilename: outputTxtFilename,
  dispose(context) {
    context.text = "";
    context.texts = [];
    context.units = [];
  },
});

export { TXT_MIME };
