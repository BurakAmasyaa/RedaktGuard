// Redakt Desktop'ın maskeleme hattının Guard tarafındaki sarmalayıcısı.
// Buradaki iş sırası src/main.js'teki handleFile + processSelection ile
// bilerek aynıdır: aynı bulgular, aynı yer tutucular, aynı çıktı adı.

import { applyDocumentChanges, disposeDocument, extractDocument } from "../../src/pipeline.js";
import { detectImportedRules, detectImportedRulesBatched, normalizeImportedRules } from "../../src/custom-rules.js";
import { detectLabelledFields } from "../../src/field-labels.js";
import { aggregateFindings, createReplacementMap, mergeFindings, replaceText } from "../../src/pii.js";
import { detectNamedEntitiesInWorker, nerDevice, warmUpNerWorker } from "../../src/ner-client.js";
import { summarizeSelectedFindings } from "./audit.js";

const sessions = new Map();

// Panelde gösterilecek alanlar. locations dizisi binlerce kayıt olabildiği için
// oturumda kalır, içerik betiğine geçmez.
function slimFinding(finding) {
  return {
    id: finding.id,
    scope: finding.scope || "document",
    source: finding.source || "pattern",
    category: finding.category,
    label: finding.label,
    value: finding.value,
    placeholder: finding.placeholder,
    replacementText: finding.replacementText || finding.placeholder,
    ruleText: finding.ruleText || null,
    count: finding.count,
    confidence: finding.confidence,
    score: typeof finding.score === "number" ? finding.score : null,
  };
}

// Tek bozuk kural bütün listeyi düşürmemeli: toplu normalize başarısız olursa
// kural kural ayıklanır ve atlananlar çağırana bildirilir.
function normalizeRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return { rules: [], skipped: [] };
  try {
    return { rules: normalizeImportedRules(rules), skipped: [] };
  } catch {
    const accepted = [];
    const skipped = [];
    for (const rule of rules) {
      try {
        accepted.push(...normalizeImportedRules([rule]));
      } catch {
        skipped.push(String(rule?.find ?? rule?.id ?? "?"));
      }
    }
    // Toplu normalize'in yaptığı tekilleştirme kural kural ayıklamada kaybolur.
    const unique = new Map();
    for (const rule of accepted) unique.set(rule.comparison, rule);
    return { rules: [...unique.values()], skipped };
  }
}

function abortIfCancelled(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
}

export async function scanDocument({ id, bytes, filename, profile = "balanced", rules = [], signal, onProgress }) {
  release(id);
  let context = null;
  const warnings = [];

  try {
    const { rules: imported, skipped } = normalizeRules(rules);
    if (skipped.length) {
      warnings.push({
        title: `${skipped.length} kurumsal kural okunamadı.`,
        detail: `Atlanan kurallar: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}. Bu adlar maskelenmemiş olabilir; yöneticinize bildirin.`,
      });
    }

    onProgress?.({ phase: "extracting", detail: "Belge yapısı ve metin katmanları ayrıştırılıyor." });
    const extracted = await extractDocument(bytes.buffer ? bytes.buffer : bytes, filename, {
      profile,
      signal,
      onProgress(progress) {
        if (progress.phase !== "ocr") return;
        onProgress?.({
          phase: "ocr",
          current: progress.current,
          total: progress.total,
          detail:
            progress.kind === "image"
              ? "Belgedeki görseller yerel OCR ile okunuyor."
              : "Taranmış sayfalar yerel OCR ile okunuyor.",
        });
      },
      onOcrProgress(progress) {
        if (progress.status !== "recognizing text") return;
        onProgress?.({ phase: "ocr", detail: `Yerel OCR %${Math.round((progress.progress || 0) * 100)}.` });
      },
    });
    context = extracted.context;

    const units = context.units || context.texts || [];

    // Dosya adı da taranan bir birimdir: belge içi maskelenip adı olduğu gibi
    // kalınca dosya paylaşıldığı anda maskeleme boşa çıkıyor. src/main.js:703
    // ile aynı yol — ad bütün katmanlardan geçer, çıktı adını da
    // applyDocumentChanges aynı haritayla yazar (src/pipeline.js:44).
    const filenameStem = String(filename).replace(/\.[^.]+$/u, "");
    const filenameUnit = { text: filenameStem, location: { kind: "filename" } };
    const scanUnits = [...units, filenameUnit];

    // Belgenin kendi alan etiketlerini okur ("Adı : SAMET", "Adres : ...").
    // Modelden bağımsız ve deterministik: resmî evrakta model yanılsa veya hiç
    // çalışmasa bile bu alanlar bulunur. Çekirdek gibi yalnız belge birimleri
    // verilir — dosya adında iki nokta zaten geçemez.
    const fieldFindings = detectLabelledFields(units);

    let importedFindings = [];
    if (imported.length) {
      onProgress?.({ phase: "rules", detail: `${imported.length} kurumsal kural karşılaştırılıyor.` });
      importedFindings = await detectImportedRulesBatched(scanUnits, imported, {
        batchSize: 100,
        signal,
        onProgress: ({ current, total }) => onProgress?.({ phase: "rules", current, total }),
      });
    }

    const filenameFindings = aggregateFindings([filenameUnit])
      .map((finding, index) => ({ ...finding, id: `fn_${index + 1}`, scope: "filename" }));

    let namedEntities = [];
    try {
      onProgress?.({ phase: "model", detail: "Yerel Türkçe model hazırlanıyor." });
      // Dosya adı modele de verilir: yalnız adda geçen bir kişi adı başka
      // hiçbir katmana yakalanmıyordu.
      namedEntities = await detectNamedEntitiesInWorker([...(context.texts || []), filenameStem], {
        profile,
        signal,
        onProgress(progress) {
          if (progress.phase === "batch") {
            onProgress?.({
              phase: "detecting",
              current: progress.current,
              total: progress.total,
              detail: "Kişi ve kurum adları aranıyor.",
            });
          } else if (progress.status === "progress" && progress.total) {
            onProgress?.({
              phase: "model",
              current: progress.loaded,
              total: progress.total,
              detail: "Yerel model ilk kullanımda hazırlanıyor.",
            });
          }
        },
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Model çalışmadıysa isimler maskelenmeden kalır. Bu sessizce geçilemez:
      // kullanıcı göndermeden önce bilmeli.
      warnings.push({
        title: "Kişi ve kurum adları aranamadı.",
        detail: `Bu belgede isimler maskelenmemiş olabilir; yalnızca e-posta, telefon, IBAN, T.C. kimlik, kart numaraları ve kurumsal kurallar uygulandı.${
          error?.detail ? ` (${error.detail})` : ""
        }`,
      });
    }

    // Sıra güven sırasıdır (src/main.js:783 ile aynı): kurumsal kural,
    // doğrulanabilir desen, dosya adı, belgenin kendi alan etiketi, sonra dil
    // modeli. Aynı değeri iki katman da bulduysa öndeki kazanır ve yer
    // tutucular BİRLEŞİK liste üzerinde yeniden numaralanır. Düz dizi
    // birleştirmesi her katmanı 1'den saydırıyor, iki farklı kişiye aynı
    // [KISI_1] etiketini verip eşleştirmeyi anlamsızlaştırıyordu.
    const findings = mergeFindings([
      importedFindings,
      extracted.findings || [],
      filenameFindings,
      fieldFindings,
      namedEntities,
    ]);

    // İptal, oturuma yazmadan hemen önce son kez denetlenir: aksi hâlde
    // iptal edilmiş bir taramanın bağlamı offscreen belgede sahipsiz kalır.
    abortIfCancelled(signal);
    sessions.set(id, { context, findings, filename });
    return { findings: findings.map(slimFinding), warnings };
  } catch (error) {
    if (context) await disposeDocument(context).catch(() => {});
    throw error;
  }
}

// PDF sayfa döngüsünün adımları; hangisinin uzadığı panelde ve izde görünsün.
// Sahada tek sayfalık PDF "1/1"de asılı kaldı; sayfa içi adım görülemiyordu.
const REDACT_STEP_DETAIL = Object.freeze({
  render: "Sayfa çiziliyor.",
  text: "Sayfa metni hizalanıyor.",
  annotations: "Form alanları kapatılıyor.",
  jpeg: "Sayfa görüntüye dönüştürülüyor.",
  embedded: "Sayfa güvenli çıktıya eklendi.",
  save: "Güvenli çıktı dosyası yazılıyor.",
});

export async function maskDocument({ id, selectedIds, signal, onProgress }) {
  const session = sessions.get(id);
  if (!session) throw new Error("Tarama oturumu bulunamadı; dosyayı yeniden bırakın.");

  const selected = Array.isArray(selectedIds) ? selectedIds : [];
  if (!selected.length) throw new Error("Maskelenecek en az bir bulgu seçilmeli.");

  // Çıktı adını da applyDocumentChanges aynı replacementMap ile yazıyor
  // (src/pipeline.js:44 -> src/pii.js:459 redactedOutputFilename). Guard'ın
  // ayrı dosya adı yolu kaldırıldı: ayrı bir liste ve ayrı numaralandırma,
  // belgedeki ve addaki iki farklı değere aynı yer tutucuyu veriyordu.
  const result = await applyDocumentChanges(session.context, session.findings, selected, {
    signal,
    onProgress(progress) {
      onProgress?.({
        phase: "redacting",
        current: progress.current,
        total: progress.total,
        step: progress.step || null,
        detail:
          REDACT_STEP_DETAIL[progress.step] ||
          (progress.kind === "image" ? "Gömülü görseller maskeleniyor." : "Sayfalar güvenli çıktıya dönüştürülüyor."),
      });
    },
  });

  return {
    bytes: result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes),
    mimeType: result.mimeType,
    filename: result.filename,
    documentChanged: true,
    audit: summarizeSelectedFindings(session.findings, selected),
  };
}

// Prompt metninin tam taraması. Hızlı katman içerik betiğinde eşzamanlı
// çalışır; buraya yalnızca kullanıcı modeli de istediğinde gelinir.
export async function scanTextUnit({ id, text, profile = "balanced", rules = [], useModel = false, signal, onProgress }) {
  release(id);
  const units = [String(text)];
  const warnings = [];

  const { rules: imported, skipped } = normalizeRules(rules);
  if (skipped.length) {
    warnings.push({
      title: `${skipped.length} kurumsal kural okunamadı.`,
      detail: "Bu adlar promptta maskelenmemiş olabilir; yöneticinize bildirin.",
    });
  }

  const ruleFindings = imported.length ? detectImportedRules(units, imported) : [];
  const patternFindings = aggregateFindings(units);
  const fieldFindings = detectLabelledFields(units);

  // Model yalnız kullanıcı istediğinde çalışır. Uzun metin bu yola sırf
  // sayfayı dondurmamak için düştüğünde modelin dakikalarca çalışması
  // beklenmemeli.
  let namedEntities = [];
  try {
    if (!useModel) throw new SkipModel();
    onProgress?.({ phase: "model", detail: "Kişi ve kurum adları aranıyor." });
    namedEntities = await detectNamedEntitiesInWorker(units, { profile, signal });
  } catch (error) {
    if (error instanceof SkipModel) namedEntities = [];
    else
    if (error?.name === "AbortError") throw error;
    warnings.push({
      title: "Kişi ve kurum adları aranamadı.",
      detail: "Bu promptta isimler maskelenmemiş olabilir; desen ve kurumsal kural katmanları uygulandı.",
    });
  }

  const findings = mergeFindings([ruleFindings, patternFindings, fieldFindings, namedEntities]).map(
    (finding, index) => ({ ...finding, id: `p_${index + 1}`, scope: "prompt" })
  );

  abortIfCancelled(signal);
  sessions.set(id, { text: String(text), findings });
  return { findings: findings.map(slimFinding), warnings };
}

export function maskTextUnit({ id, selectedIds }) {
  const session = sessions.get(id);
  if (!session || typeof session.text !== "string") {
    throw new Error("Tarama oturumu bulunamadı; metni yeniden gönder.");
  }
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const picks = session.findings.filter((finding) => selected.has(finding.id));
  if (!picks.length) return { text: session.text, audit: summarizeSelectedFindings([], []) };
  const map = createReplacementMap(picks, picks.map((finding) => finding.id));
  return {
    text: replaceText(session.text, map, { unitIndex: 0 }),
    audit: summarizeSelectedFindings(session.findings, [...selected]),
  };
}

// Modeli ve worker'ı önden hazırlar. Worker artık taramalar arasında ayakta
// kaldığı için bu bedel oturumda bir kez ödenir; kullanıcı ilk dosyayı
// bıraktığında model çoktan hazırdır.
export async function warmUpEngine(preferDevice = null, onProgress) {
  try {
    await warmUpNerWorker({ preferDevice, onProgress });
  } catch {
    // Isıtma başarısız olursa tarama yine çalışır, sadece ilk sefer yavaşlar.
    return null;
  }
  return nerDevice();
}

export function release(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  if (session.context) disposeDocument(session.context).catch(() => {});
}

export function releaseAll() {
  for (const id of [...sessions.keys()]) release(id);
}
