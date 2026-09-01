// Kurumsal karar çekirdeği. Arayüz seçimi değildir: eksik tarama ham veriye
// düşemez, başarılı taramadaki bütün bulgular seçilir.

function warningsOf(item) {
  return Array.isArray(item?.warnings) ? item.warnings : [];
}

export function decideScannedFiles(items) {
  const files = Array.isArray(items) ? items : [];
  if (files.some((item) => item?.passthrough || warningsOf(item).length)) {
    return { action: "block", selections: new Map(), findingCount: 0 };
  }

  const selections = new Map();
  let findingCount = 0;
  for (let index = 0; index < files.length; index += 1) {
    const ids = (files[index]?.findings || []).map((finding) => finding.id).filter(Boolean);
    selections.set(index, ids);
    findingCount += ids.length;
  }
  return {
    action: findingCount ? "mask" : "clean",
    selections,
    findingCount,
  };
}

export function decideScannedPrompt(findings, warnings = []) {
  if (Array.isArray(warnings) && warnings.length) return { action: "block", selectedIds: [] };
  const selectedIds = (Array.isArray(findings) ? findings : []).map((finding) => finding.id).filter(Boolean);
  return { action: selectedIds.length ? "mask" : "clean", selectedIds };
}
