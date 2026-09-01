import { docxAdapter, xlsxAdapter } from "./office.js";
import { pdfAdapter } from "./pdf.js";
import { createReplacementMap } from "./pii.js";
import { txtAdapter } from "./txt.js";
import { imageAdapter } from "./image.js";
import { validateDocumentBytes } from "./file-validation.js";

const adapters = [docxAdapter, xlsxAdapter, pdfAdapter, txtAdapter, imageAdapter];

export function documentAdapterFor(filename) {
  return adapters.find((adapter) => adapter.canHandle(filename)) || null;
}

export function supportedExtensions() {
  return adapters.flatMap((adapter) => adapter.extensions);
}

export async function extractDocument(arrayBuffer, filename, options = {}) {
  const adapter = documentAdapterFor(filename);
  if (!adapter) {
    throw new Error(`Desteklenen dosya türleri: ${supportedExtensions().join(", ")}.`);
  }
  await validateDocumentBytes(arrayBuffer, filename);
  const result = await adapter.extract(arrayBuffer, filename, options);
  return {
    ...result,
    context: {
      ...result.context,
      adapterId: adapter.id,
      filename,
    },
  };
}

export async function applyDocumentChanges(context, findings, selectedIds, options = {}) {
  if (!selectedIds.length) throw new Error("En az bir öğe seçin.");
  const adapter = adapters.find((candidate) => candidate.id === context.adapterId || candidate.id === context.kind);
  if (!adapter) throw new Error("Belge türü desteklenmiyor.");
  const replacementMap = createReplacementMap(findings, selectedIds);
  const bytes = await adapter.applyChanges(context, replacementMap, options);
  return {
    bytes,
    mimeType: context.mimeType || adapter.mimeType,
    filename: adapter.outputFilename(context.filename, replacementMap),
  };
}

export async function disposeDocument(context) {
  if (!context) return;
  const adapter = adapters.find((candidate) => candidate.id === context.adapterId || candidate.id === context.kind);
  if (adapter?.dispose) await adapter.dispose(context);
  else if (["docx", "xlsx"].includes(context.kind)) {
    const { disposeOfficeContext } = await import("./office.js");
    await disposeOfficeContext(context);
  }
}

export const documentAdapters = Object.freeze(adapters);
