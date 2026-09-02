import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GUARDED_MATCHES } from "../guard/src/hosts.js";
import { createAuditEvent, normalizeAuditEvent, summarizeSelectedFindings } from "../guard/src/audit.js";
import { decideScannedFiles, decideScannedPrompt } from "../guard/src/enforcement.js";
import { guardManifest } from "../guard/manifest.mjs";
import { connectRuntime, runtimeOrThrow, sendRuntimeMessage, sendRuntimeMessageBestEffort } from "../guard/src/runtime.js";
import { coerceSettings } from "../guard/src/settings.js";
import { aggregateFindings, createReplacementMap, replaceText } from "../src/pii.js";
import {
  SYNC_SCAN_LIMIT,
  maskPromptText,
  primeRules,
  scanPromptText,
} from "../guard/src/content/text-engine.js";
import {
  APPROVED_ATTRIBUTE,
  CONFIG_ATTRIBUTE,
  PAGE,
  SCANNABLE_EXTENSIONS,
  fileKey,
  isScannable,
} from "../guard/src/protocol.js";
import { base64ToBytes, bytesToBase64, chunkBytes, chunkCount, joinChunks } from "../guard/src/transfer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath) => fs.readFile(path.join(root, relativePath), "utf8");
const AUDIT_EVENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const AUDIT_CREATED_AT = "2026-09-01T08:30:00.000Z";

test("kurumsal politika yerel ayarlarla gevşetilemez", () => {
  const settings = coerceSettings({
    enabled: false,
    networkGuard: false,
    blockUnscannable: false,
    allowUnmaskedOverride: true,
    autoSelectProbable: false,
    automaticMasking: false,
    guardPrompts: false,
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.networkGuard, true);
  assert.equal(settings.blockUnscannable, true);
  assert.equal(settings.allowUnmaskedOverride, false);
  assert.equal(settings.autoSelectProbable, true);
  assert.equal(settings.automaticMasking, true);
  assert.equal(settings.guardPrompts, true);
});

test("tam taramadaki bütün bulgular otomatik seçilir", () => {
  const decision = decideScannedFiles([
    { findings: [{ id: "a" }, { id: "b" }], warnings: [] },
    { findings: [{ id: "c" }], warnings: [] },
  ]);
  assert.equal(decision.action, "mask");
  assert.deepEqual(decision.selections.get(0), ["a", "b"]);
  assert.deepEqual(decision.selections.get(1), ["c"]);
});

test("uyarı, passthrough ve prompt uyarısı ham gönderime değil engellemeye düşer", () => {
  assert.equal(decideScannedFiles([{ findings: [], warnings: [{ title: "eksik" }] }]).action, "block");
  assert.equal(decideScannedFiles([{ findings: [], warnings: [], passthrough: true }]).action, "block");
  assert.equal(decideScannedPrompt([], [{ title: "eksik" }]).action, "block");
  assert.equal(decideScannedFiles([{ findings: [], warnings: [] }]).action, "clean");
});

test("audit özeti ham bulgu değerlerini ve dosya adını taşımaz", () => {
  const findings = [
    { id: "1", category: "person", source: "ner", scope: "document", count: 2, value: "Ahmet Yılmaz" },
    { id: "2", category: "email", source: "pattern", scope: "document", count: 1, value: "ahmet@sirket.local" },
    { id: "3", category: "phone", source: "pattern", scope: "document", count: 1, value: "0532 111 22 33" },
  ];
  const summary = summarizeSelectedFindings(findings, ["1", "2", "3"]);
  const event = createAuditEvent({
    site: "chatgpt",
    artifact: "file",
    summaries: [summary],
    formats: ["xlsx"],
    eventId: AUDIT_EVENT_ID,
    createdAt: AUDIT_CREATED_AT,
  });
  const serialized = JSON.stringify(event);
  assert.equal(summary.maskedOccurrences, 4);
  assert.deepEqual(summary.categories, { person: 2, email: 1, phone: 1 });
  for (const secret of ["Ahmet Yılmaz", "ahmet@sirket.local", "0532 111 22 33", "musteri-listesi.xlsx"]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("background normalizasyonu sonradan eklenen ham alanları düşürür", () => {
  const raw = {
    schema: 1,
    eventId: AUDIT_EVENT_ID,
    createdAt: AUDIT_CREATED_AT,
    site: "chatgpt",
    artifact: "file",
    outcome: "masked",
    summary: {
      fileCount: 1,
      formats: ["xlsx"],
      selectedFindings: 1,
      maskedOccurrences: 1,
      categories: { email: 1 },
      sources: { pattern: 1 },
      scopes: { document: 1 },
    },
    value: "Ahmet Yılmaz",
    filename: "gizli.xlsx",
  };
  const normalized = normalizeAuditEvent(raw);
  assert.equal("value" in normalized, false);
  assert.equal("filename" in normalized, false);
});

test("yardımcı runtime bildirimi uzantı bağlamı yokken teslim akışını düşürmez", async () => {
  assert.equal(sendRuntimeMessageBestEffort({ type: "audit" }, {}), false);
  assert.equal(sendRuntimeMessageBestEffort({ type: "audit" }, { chrome: { runtime: {} } }), false);
  assert.equal(sendRuntimeMessageBestEffort({ type: "audit" }, {
    chrome: { runtime: { id: "guard", sendMessage() { throw new Error("context invalidated"); } } },
  }), false);

  let called = 0;
  assert.equal(sendRuntimeMessageBestEffort({ type: "audit" }, {
    chrome: { runtime: { id: "guard", sendMessage() { called += 1; return Promise.reject(new Error("worker asleep")); } } },
  }), true);
  await Promise.resolve();
  assert.equal(called, 1);
});

test("kritik motor çağrısı geçersiz uzantı bağlamında anlaşılır yenileme hatası verir", () => {
  assert.throws(() => runtimeOrThrow({}), /sayfayı yenileyip dosyayı tekrar bırakın/u);
  const runtime = { id: "guard", sendMessage() {}, connect() {} };
  assert.equal(runtimeOrThrow({ chrome: { runtime } }), runtime);
});

test("kritik runtime çağrıları invalidated context hatasını kullanıcı mesajına çevirir", async () => {
  const scope = {
    chrome: {
      runtime: {
        id: "guard",
        sendMessage() { throw new Error("Extension context invalidated."); },
        connect() { throw new TypeError("Cannot read properties of undefined (reading 'connect')"); },
      },
    },
  };
  await assert.rejects(() => sendRuntimeMessage({ type: "engine" }, scope), /sayfayı yenileyip dosyayı tekrar bırakın/u);
  assert.throws(() => connectRuntime({ name: "engine" }, scope), /sayfayı yenileyip dosyayı tekrar bırakın/u);
});

test("yardımcı bildirimler maskeli dosya ve prompt teslimini geciktiremez", async () => {
  const code = await source("guard/src/content/interceptor.js");

  const fileStart = code.indexOf("// Maskeli kopyanın teslimi");
  const fileEnd = code.indexOf("  } catch (error) {", fileStart);
  const fileSuccess = code.slice(fileStart, fileEnd);
  const finishAt = fileSuccess.indexOf("finish(output)");
  const fileActivityAt = fileSuccess.indexOf("reportActivity(maskedCount)");
  const fileAuditAt = fileSuccess.indexOf("reportAudit(");
  assert.ok(
    fileStart >= 0 && finishAt >= 0 && finishAt < fileActivityAt && fileActivityAt < fileAuditAt,
    "dosya teslimi yardımcı activity/audit bildirimlerinden önce başlamıyor"
  );

  const promptStart = code.indexOf("const applied = await apply(maskedResult.text, selectedIds);");
  const promptEnd = code.indexOf("  } catch (error) {", promptStart);
  const promptSuccess = code.slice(promptStart, promptEnd);
  const appliedAt = promptSuccess.indexOf("const applied = await apply(");
  const promptActivityAt = promptSuccess.indexOf("reportActivity(selectedIds.length)");
  const promptAuditAt = promptSuccess.indexOf("reportAudit(");
  assert.ok(
    promptStart >= 0 && appliedAt >= 0 && appliedAt < promptActivityAt && promptActivityAt < promptAuditAt,
    "prompt önce kutuya uygulanmadan yardımcı activity/audit bildirimi yapılıyor"
  );
});

test("içerik betiği geçersiz bağlamda çıplak runtime çağrısı yapmaz", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.doesNotMatch(code, /chrome\.runtime\.(?:sendMessage|connect)\s*\(/u);
  assert.match(code, /sendRuntimeMessageBestEffort/u);
  assert.match(code, /sendRuntimeMessage\(\{ type: MSG\.ensureEngine \}\)/u);
  assert.match(code, /connectRuntime\(\{ name: ENGINE_PORT \}\)/u);
});

test("dosya baytları parçalara bölünüp aynen geri toplanır", () => {
  // Parça sınırına denk gelmeyen boy: son parça kısa kalır.
  const original = new Uint8Array(1024 * 1024 + 7);
  for (let index = 0; index < original.length; index += 1) original[index] = (index * 31 + 17) % 256;

  const size = 64 * 1024;
  const parts = [...chunkBytes(original, size)].map((bytes, seq) => ({
    seq,
    bytes: base64ToBytes(bytesToBase64(bytes)),
  }));

  assert.equal(parts.length, chunkCount(original.length, size));
  // Sıra bozulsa da birleştirme doğru olmalı; port mesajları sıralı gelmeyebilir.
  assert.deepEqual(joinChunks([...parts].reverse()), original);
});

test("boş dosya da tek parça olarak taşınır", () => {
  const empty = new Uint8Array(0);
  assert.equal(chunkCount(empty.length), 1);
  assert.deepEqual(joinChunks([...chunkBytes(empty)].map((bytes, seq) => ({ seq, bytes }))), empty);
});

test("manifest korunan adresleri tek kaynaktan alır", () => {
  const manifest = guardManifest("1.2.3");
  assert.equal(manifest.version, "1.2.3");
  for (const entry of manifest.content_scripts) {
    assert.deepEqual(entry.matches, [...GUARDED_MATCHES]);
    // Sayfanın kendi betiklerinden önce çalışmalı; yoksa dosya uygulamaya ulaşır.
    assert.equal(entry.run_at, "document_start");
  }
});

test("sayfa dünyasındaki emniyet, yalıtılmış katmandan önce yüklenir", () => {
  const [first, second] = guardManifest("1.0.0").content_scripts;
  assert.equal(first.world, "MAIN");
  assert.equal(second.world, "ISOLATED");
});

test("uzantı geniş host izni istemez", () => {
  const manifest = guardManifest("1.0.0");
  // Kural sunucusuna erişim ayarlar sayfasında, tek adres için ve kullanıcı onayıyla alınır.
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.permissions, ["storage", "offscreen", "alarms"]);
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/u);
});

// İçerik betikleri MV3'te modül değildir ve tek dosya olmak zorundadır.
// Belge hattını, modeli veya OCR'ı içeri almaları paketi şişirir ve 147 MB'lık
// modeli her sekmede yükletir; onlar offscreen belgede kalır, tarama porta devredilir.
//
// Tek istisna: prompt metninin hızlı katmanı. Gönderim tuşuna basıldığında karar
// milisaniyeler içinde verilmeli, port gidiş-dönüşü her mesaja gecikme eklerdi.
const ALLOWED_ENGINE_IMPORTS = [
  "../../../src/pii.js",
  "../../../src/custom-rules.js",
  "../../../src/text-match.js",
  "../../../src/field-labels.js",
];

const CONTENT_SCRIPT_SOURCES = [
  "guard/src/content/interceptor.js",
  "guard/src/content/page-guard.js",
  "guard/src/content/text-engine.js",
  "guard/src/content/composer.js",
  "guard/src/content/panel.js",
];

test("içerik betikleri belge hattını, modeli ve OCR'ı içeri almaz", async () => {
  for (const file of CONTENT_SCRIPT_SOURCES) {
    const code = await source(file);
    const imported = [...code.matchAll(/from\s+"(\.\.\/\.\.\/\.\.\/src\/[^"]+)"/gu)].map((match) => match[1]);
    for (const path of imported) {
      assert.ok(ALLOWED_ENGINE_IMPORTS.includes(path), `${file} izinsiz motor modülü alıyor: ${path}`);
    }
    assert.doesNotMatch(code, /@huggingface|tesseract\.js|pdfjs-dist|jszip/u, `${file} ağır bağımlılık taşıyor`);
  }
});

// İstisnanın dayanağı: bu modüllerin gövdesi kapalıdır. Biri listede olmayan
// bir şeyi (paket ya da başka bir kaynak modülü) içeri alırsa, içerik betiği
// sessizce bütün hattı yutmaya başlar. Kural "hiç import yok" değil, "yalnızca
// aynı listedeki modüller"dir: paylaşılan bir yaprak modül (text-match.js)
// kopyalanmak yerine listeye alınır.
test("içerik betiğine alınan motor modülleri kapalı kümede kalır", async () => {
  const allowed = new Set(ALLOWED_ENGINE_IMPORTS.map((path) => path.replace("../../../src/", "./")));
  for (const path of ALLOWED_ENGINE_IMPORTS) {
    const code = await source(path.replace("../../../", ""));
    const specifiers = [...code.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gmu)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(allowed.has(specifier), `${path} kapalı kümenin dışından alıyor: ${specifier}`);
    }
  }
});

// Sayfa dünyası, kullanıcının belgesindeki değerleri asla görmemeli.
// Ortak DOM kanalına yalnızca politika, onay anahtarı ve rastgele teslim
// jetonları yazılır; belge içeriği/bulgular yazılmaz.
test("yalıtılmış katman ortak DOM kanalına yalnız onay ve teslim jetonu yazar", async () => {
  const code = await source("guard/src/content/interceptor.js");
  const written = [...code.matchAll(/setAttribute\(\s*\n?\s*(\w+)/gu)].map((match) => match[1]);
  assert.ok(written.length >= 2, "sayfa dünyasına yazan çağrı bulunamadı");
  for (const attribute of written) {
    assert.ok(
      [
        "CONFIG_ATTRIBUTE",
        "APPROVED_ATTRIBUTE",
        "FILE_DELIVERY_TOKEN_ATTRIBUTE",
        "DROP_DELIVERY_TOKEN_ATTRIBUTE",
        "DROP_DELIVERY_POINT_ATTRIBUTE",
        "DROP_DELIVERY_TARGET_ATTRIBUTE",
      ].includes(attribute),
      `sayfa dünyasına ${attribute} yazılıyor`
    );
  }
  // Onay anahtarı yalnızca ad ve boyuttan üretilir.
  const approve = code.slice(code.indexOf("function approve("));
  const body = approve.slice(0, approve.indexOf("\n}"));
  assert.match(body, /fileKey\(file\.name, file\.size\)/u);
  assert.doesNotMatch(body, /findings|placeholder|value/u);
});

// Onay, sentetik olaydan ÖNCE yazılmalı. Sayfa "drop" olayını eşzamanlı işleyip
// yüklemeyi hemen başlatabilir; sıra ters olsaydı kendi maskelediğimiz dosya
// ağ katmanında engellenirdi.
test("onay, maskelenmiş dosya sayfaya verilmeden önce yazılır", async () => {
  const code = await source("guard/src/content/interceptor.js");
  const start = code.indexOf("const finish = async (");
  assert.ok(start > 0, "finish fonksiyonu bulunamadı");
  // Gövdenin sonu: girintili kapanış. Dosyanın başka yerindeki bloklara kaymaz.
  const finish = code.slice(start, code.indexOf("\n  };", start));
  assert.ok(finish.includes("approve(delivered)"), "onay yazılmıyor");
  assert.ok(finish.indexOf("approve(delivered)") < finish.indexOf("deliver(delivered)"), "onay geç yazılıyor");
});

test("sayfa dünyasındaki betik yalnızca ad ve boyutla, eşzamanlı karar verir", async () => {
  const code = await source("guard/src/content/page-guard.js");
  assert.doesNotMatch(code, /findings|placeholder|originalText/u, "sayfa dünyasına bulgu sızıyor");
  assert.match(code, /const originalFetch = window\.fetch/u);
  assert.match(code, /XMLHttpRequest\.prototype\.send/u);
  // Karar bir söz (promise) beklemeden verilmeli; yoksa istek çoktan yola çıkar.
  assert.doesNotMatch(code, /\bawait\b|async function offender/u, "karar eşzamanlı değil");
  assert.match(code, new RegExp(`${CONFIG_ATTRIBUTE.replace(/-/gu, "-")}|CONFIG_ATTRIBUTE`, "u"));
});

test("taranabilir türler ile sayfa dünyasının kararı aynı listeden gelir", () => {
  assert.ok(isScannable("musteri.DOCX"));
  assert.ok(isScannable("bordro.xlsx"));
  assert.ok(!isScannable("arsiv.zip"));
  assert.deepEqual([...SCANNABLE_EXTENSIONS], ["docx", "xlsx", "pdf", "txt", "jpg", "jpeg", "png"]);
  assert.equal(fileKey("a b.docx", 12), "a b.docx|12");
  assert.deepEqual(Object.values(PAGE), ["blocked"]);
  assert.equal(CONFIG_ATTRIBUTE, "data-redakt-guard");
  assert.equal(APPROVED_ATTRIBUTE, "data-redakt-guard-approved");
});

// ---------------------------------------------------------------- inceleme regresyonları

// Test ajanının yakaladığı iki high hata. İkisi de `blockUnscannable` açıkken
// ortaya çıkıyordu ve kaynak denetimiyle kalıcı olarak kapatılıyor.
test("ağ katmanı, kendi verdiğimiz onayı her dosya türünde tanır", async () => {
  const code = await source("guard/src/content/page-guard.js");
  const body = code.slice(code.indexOf("function offender("), code.indexOf("function announce("));
  const approvedAt = body.indexOf("approved.has(");
  const scannableAt = body.indexOf("const scannable");
  assert.ok(approvedAt > 0 && scannableAt > 0, "karar akışı bulunamadı");
  // Onay kontrolü taranabilirlik dalından ÖNCE olmalı; yoksa kullanıcının
  // bilerek onayladığı taranamayan dosyayı uzantı kendi engelliyor.
  assert.ok(approvedAt < scannableAt, "onay, taranamayan dosyalarda okunmuyor");
});

test("adsız Blob gövdesi yalnız kurumsal zorlamada yükleme sayılır", async () => {
  const code = await source("guard/src/content/page-guard.js");

  // filesIn hâlâ yalnız File tanır: sıradan kullanımda siteler JSON ve
  // telemetriyi de Blob gönderir, onları dosya saymak siteyi kırar.
  const filesIn = code.slice(code.indexOf("function filesIn("), code.indexOf("function binaryBodySize("));
  assert.match(filesIn, /instanceof File/u);
  assert.doesNotMatch(filesIn, /instanceof Blob/u, "adsız Blob dosya sayılıyor");

  // Ama site dosyayı adsız bir gövdeye sarıp imzalı URL'e PUT edebiliyor.
  // O yol yalnız File aranırsa tamamen görünmez kalır. Zorlama açıkken
  // ("maskesiz gönderim yoktur") tanınmayan büyük ikili gövde durdurulur.
  const offender = code.slice(code.indexOf("function offender("), code.indexOf("function announce("));
  assert.match(offender, /binaryBodySize\(body\)/u, "ikili gövde hiç incelenmiyor");
  assert.match(offender, /!config\.blockUnscannable/u, "zorlama kapalıyken de engelliyor");
  assert.match(offender, /BINARY_BODY_FLOOR_BYTES/u, "küçük gövdeler için eşik yok");
  // Kendi maskelediğimiz dosya boyutuyla onaylı olduğu için geçmeli.
  assert.match(offender, /approved\.has\(sizeKey\(size\)\)/u, "kendi çıktımız engellenir");

  const interceptor = await source("guard/src/content/interceptor.js");
  assert.match(interceptor, /approvedKeys\.add\(sizeKey\(file\.size\)\)/u, "boyut onayı yazılmıyor");
});
test("bildirilen parça sayısı gerçekten gönderilen parça sayısına eşittir", () => {
  const size = 1024;
  for (const length of [0, 1, size - 1, size, size + 1, size * 3, size * 3 + 7]) {
    const bytes = new Uint8Array(length);
    const produced = [...chunkBytes(bytes, size)];
    assert.equal(produced.length, chunkCount(length, size), `${length} baytta parça sayısı uyuşmuyor`);
    assert.equal(produced.reduce((sum, part) => sum + part.length, 0), length);
  }
});

test("onay kanalı dosya adındaki satır sonundan etkilenmez", () => {
  // Dosya adı satır sonu içerebilir. Düz birleştirme hem kendi onayımızı bozar
  // hem de uydurma bir adla başka dosyaya sahte onay üretmeye izin verirdi.
  const nasty = fileKey("rapor\nsahte.docx", 10);
  const other = fileKey("sahte.docx", 10);
  const encoded = JSON.stringify([nasty]);
  const decoded = new Set(JSON.parse(encoded));
  assert.ok(decoded.has(nasty));
  assert.ok(!decoded.has(other), "satır sonu ikinci bir onay uydurdu");
});

test("sürükleme perdesi başarı, iptal ve hata sonunda kesin olarak kapatılır", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.match(code, /function cleanupDropUi\(/u);
  assert.match(code, /guardFiles\(files,[\s\S]{0,2600}\.finally\(\(\) => cleanupDropUi/u,
    "iptal/hata yolu terminal sürükleme temizliğine bağlanmıyor");
  const cleanup = code.slice(code.indexOf("async function cleanupDropUi"), code.indexOf('window.addEventListener(\n  "drop"'));
  assert.match(cleanup, /dispatchDrag\(overlay, "drop", empty/u, "görünen perdeye boş terminal drop gönderilmiyor");
  assert.match(cleanup, /new CustomEvent\(DROP_CLEANUP_EVENT/u, "terminal olaylar MAIN dünyasına aktarılmıyor");
  assert.match(cleanup, /dispatchDrag\(target, "dragleave"/u);
  assert.match(cleanup, /dispatchDrag\(target, "dragend"/u);
  assert.match(cleanup, /key: "Escape"/u);

  const delivery = code.slice(code.indexOf("guardFiles(files, async (delivered)"), code.indexOf("  },\n  true\n);"));
  const enterAt = delivery.indexOf('dispatchDrag(host, "dragenter"');
  const firstFrameAt = delivery.indexOf("await nextFrame()", enterAt);
  const retargetAt = delivery.indexOf("host = deliveryFallback", firstFrameAt);
  const overAt = delivery.indexOf('dispatchDrag(host, "dragover"', retargetAt);
  const dropAt = delivery.indexOf('dispatchDrag(host, "drop"', overAt);
  const secondFrameAt = delivery.indexOf("await nextFrame()", dropAt);
  const leaveAt = delivery.indexOf('dispatchDrag(host, "dragleave"', secondFrameAt);
  assert.ok(
    enterAt >= 0 && enterAt < firstFrameAt && firstFrameAt < retargetAt && retargetAt < overAt &&
      overAt < dropAt && dropAt < secondFrameAt && secondFrameAt < leaveAt,
    "sentetik teslim dragenter → kare/hedef → dragover/drop → kare/dragleave sırasını kapatmıyor"
  );
  assert.match(delivery.slice(leaveAt), /clientX: -1, clientY: -1/u, "terminal dragleave pencere dışına çıkmıyor");
});

test("Gemini ve Claude güvenli kopyayı MAIN-world dosya girdisine teslim eder", async () => {
  const code = await source("guard/src/content/interceptor.js");
  const pageGuard = await source("guard/src/content/page-guard.js");
  assert.match(code, /function findCompatibleFileInput\(/u);
  assert.match(code, /Object\.getOwnPropertyDescriptor\(HTMLInputElement\.prototype, "files"\)/u,
    "dosya listesi React/Angular'ın görebileceği yerel setter ile yazılmıyor");
  assert.match(code, /new CustomEvent\(FILE_DELIVERY_EVENT, \{ bubbles: true, composed: true \}\)/u);
  assert.match(pageGuard, /input\.dispatchEvent\(new Event\("input", \{ bubbles: true, composed: true \}\)\)/u);
  assert.match(pageGuard, /input\.dispatchEvent\(new Event\("change", \{ bubbles: true, composed: true \}\)\)/u);
  assert.match(pageGuard, /input\.addEventListener\(FILE_DELIVERY_EVENT, relaySafeFileInput, true\)/u,
    "DOM'dan ayrılan özgün input'ta MAIN-world teslim dinleyicisi kalmıyor");
  assert.match(code, /new CustomEvent\(DROP_DELIVERY_EVENT, \{ bubbles: true, composed: true \}\)/u);
  assert.match(pageGuard, /for \(const type of \["dragenter", "dragover", "drop"\]\)/u,
    "drag ile başlayan dosya sayfanın MAIN dünyasında tamamlanmıyor");
  assert.match(pageGuard, /window\.addEventListener\(DROP_CLEANUP_EVENT, relayDropCleanup, true\)/u,
    "iptal sonrası site drop perdesi MAIN dünyasında kapatılmıyor");

  const dropFlow = code.slice(
    code.indexOf("guardFiles(files, async (delivered)"),
    code.indexOf("function interceptFileInput")
  );
  const mainDropAt = dropFlow.indexOf("replayDropInPage(host, delivered");
  const inputAt = dropFlow.indexOf("deliverToFileInput(firstInput, delivered)");
  const dragAt = dropFlow.indexOf('dispatchDrag(host, "dragenter"');
  assert.ok(mainDropAt >= 0 && mainDropAt < inputAt && inputAt < dragAt,
    "Gemini/Claude MAIN drop → file input → genel drop yedek sırası korunmuyor");

  const inputFlow = code.slice(code.indexOf("function interceptFileInput"), code.indexOf('window.addEventListener("input"'));
  assert.match(inputFlow, /deliverToFileInput\(input, delivered\)/u,
    "tarama sırasında ayrılan özgün input ve güncel eşdeğeri birlikte denenmiyor");
});

test("Guard bildirimi okunacak kadar kalır ve kullanıcı tarafından kapatılabilir", async () => {
  const panel = await source("guard/src/content/panel.js");
  assert.match(panel, /if \(!persistent\) setTimeout\(dismiss, 10000\)/u);
  assert.match(panel, /close\.addEventListener\("click", dismiss\)/u);
  assert.match(panel, /aria-label", "Bildirimi kapat"/u);
  assert.match(panel, /const persistent = \/hata\|durdur/u,
    "hata ve engelleme bildirimleri kalıcı değil");
  assert.doesNotMatch(panel, /\}, 3200\)/u, "eski 3,2 saniyelik süre geri geldi");
});

test("akış kilidi sahiplik jetonuyla bırakılır", async () => {
  const code = await source("guard/src/content/interceptor.js");
  // Terk edilmiş bir akışın finally'si, sonradan başlamış akışın kilidini silmemeli.
  assert.doesNotMatch(code, /\bbusy\s*=\s*(true|false)/u, "çıplak busy bayrağı geri geldi");
  assert.match(code, /if \(activeFlow === flow\) activeFlow = null/u);
});

test("farklı sekmelerin motor işleri tek kuyrukta ve heartbeat ile yürür", async () => {
  const offscreen = await source("guard/src/offscreen.js");
  assert.match(offscreen, /let engineWork = Promise\.resolve\(\)/u);
  assert.match(offscreen, /function enqueueEngineWork\(/u);
  assert.match(offscreen, /engineWork\.then\(run, run\)/u);
  assert.match(offscreen, /setInterval\(announceQueued, 10_000\)/u,
    "kuyruk bekleyeni watchdog süresinden önce canlı tutan heartbeat yok");
  for (const call of ["runScan", "runMask", "runTextScan", "runTextMask"]) {
    assert.match(offscreen, new RegExp(`enqueueEngineWork\\(port, id, \\(\\) =>\\s*${call}\\(`, "u"),
      `${call} ortak motor kuyruğundan geçmiyor`);
  }
  const panel = await source("guard/src/content/panel.js");
  assert.match(panel, /queued: "Diğer sekmedeki tarama bekleniyor"/u);
});

test("oturum kimliği sekmeler arasında çakışmaz", async () => {
  const code = await source("guard/src/content/interceptor.js");
  // Motor tüm sekmelerce paylaşılıyor; sekme içi sayaç kimlik için yeterli değil.
  assert.match(code, /crypto\.randomUUID\(\)/u);
  assert.doesNotMatch(code, /nextId = \(\) => `guard_\$\{Date\.now/u);
});

test("dosya adı da bir tarama birimidir", async () => {
  const code = await source("guard/src/engine.js");
  // Ad artık ayrı bir yoldan değil, belgeyle AYNI katmanlardan geçiyor:
  // kurumsal kural taraması bir birim olarak alıyor, model de görüyor.
  assert.match(code, /const filenameUnit = \{ text: filenameStem/u);
  assert.match(code, /detectImportedRulesBatched\(scanUnits, imported/u);
  assert.match(code, /detectNamedEntitiesInWorker\(\[\.\.\.\(context\.texts \|\| \[\]\), filenameStem\]/u,
    "dosya adı modele verilmiyor");
  assert.match(code, /scope: "filename"/u);

  // Mekanizmanın kendisi: aynı motor parçalarıyla dosya adı gerçekten maskeleniyor mu.
  const stem = "AhmetYilmaz_10000000146_ihbarname";
  const findings = aggregateFindings([stem]);
  assert.ok(findings.some((finding) => finding.category === "tc"), "dosya adındaki T.C. no bulunamadı");
  const map = createReplacementMap(findings, findings.map((finding) => finding.id));
  const masked = replaceText(`${stem}_redakte.docx`, map, { unitIndex: 0 });
  assert.ok(!masked.includes("10000000146"), "dosya adındaki T.C. no maskelenmedi");
  assert.ok(masked.endsWith("_redakte.docx"));
});

test("tek bozuk kurumsal kural listenin tamamını düşürmez", async () => {
  const code = await source("guard/src/engine.js");
  const body = code.slice(code.indexOf("function normalizeRules("), code.indexOf("function scanFilename("));
  // Toplu normalize hata verirse kural kural ayıklanmalı ve atlananlar bildirilmeli.
  assert.match(body, /for \(const rule of rules\)/u);
  assert.match(body, /skipped\.push/u);
  assert.match(code, /kurumsal kural okunamadı/u);
});

test("motor hazır olmadan port açıldığı bildirilmez", async () => {
  const code = await source("guard/src/background.js");
  const body = code.slice(code.indexOf("async function ensureOffscreen("), code.indexOf("async function refreshRules("));
  // getContexts belgeyi "var" gösterse de modül henüz çalışmamış olabilir;
  // uçuştaki oluşturma sözü önce beklenmeli.
  assert.ok(body.indexOf("if (creating)") < body.indexOf("await offscreenExists()"), "erken ok dönülüyor");
});

// ---------------------------------------------------------------- prompt metni

test("prompt metnindeki hassas veri bulunur ve maskelenir", () => {
  const prompt =
    "Ahmet'in TCKN'si 10000000146, e-postası ahmet@siskon.com.tr. " +
    "JTI için Project Phoenix teklifini özetle.";
  const rules = [
    { id: "1", find: "JTI", replacement: "[MUSTERI_1]", exact: true },
    { id: "2", find: "Project Phoenix", replacement: "[PROJE_1]" },
  ];

  const findings = scanPromptText(prompt, rules);
  const categories = new Set(findings.map((finding) => finding.category));
  assert.ok(categories.has("tc"), "T.C. kimlik no bulunamadı");
  assert.ok(categories.has("email"), "e-posta bulunamadı");
  assert.ok(categories.has("custom"), "kurumsal kural eşleşmedi");
  assert.ok(findings.every((finding) => finding.scope === "prompt"));

  const masked = maskPromptText(prompt, findings, findings.map((finding) => finding.id));
  for (const secret of ["10000000146", "ahmet@siskon.com.tr", "JTI", "Project Phoenix"]) {
    assert.ok(!masked.includes(secret), `${secret} maskelenmedi`);
  }
});

test("seçilmeyen bulgu maskelenmez", () => {
  const prompt = "TCKN 10000000146 ve e-posta ahmet@siskon.com.tr";
  const findings = scanPromptText(prompt, []);
  const onlyEmail = findings.filter((finding) => finding.category === "email").map((finding) => finding.id);
  const masked = maskPromptText(prompt, findings, onlyEmail);
  assert.ok(!masked.includes("ahmet@siskon.com.tr"));
  assert.ok(masked.includes("10000000146"), "seçilmeyen bulgu da maskelenmiş");
});

test("temiz prompt hiç değiştirilmez", () => {
  const prompt = "Bu piston tasarımında hangi malzemeyi önerirsin?";
  assert.deepEqual(scanPromptText(prompt, []), []);
});

// Bulanık kurumsal kural sıradan metinde ve kodda yanlış eşleşebiliyor. Şirket
// politikası kullanıcıya ham gönderme seçeneği vermediği için bu eşleşme de
// otomatik maskelenir; kural kalitesi merkezi olarak iyileştirilmelidir.
test("bulanık kurumsal kural da kullanıcı onayı olmadan maskelenir", async () => {
  const rules = [{ id: "1", find: "Project Phoenix", replacement: "[PROJE_1]" }];
  const findings = scanPromptText("const project = phoenix.init({ retries: 3 });", rules);
  assert.ok(findings.length > 0, "yanlış pozitif senaryosu artık üretilmiyor — test güncellenmeli");

  const decision = decideScannedPrompt(findings, []);
  assert.equal(decision.action, "mask");
  assert.deepEqual(decision.selectedIds, findings.map((finding) => finding.id));

  const code = await source("guard/src/content/interceptor.js");
  const flow = code.slice(code.indexOf("async function guardPrompt("));
  assert.match(flow, /decideScannedPrompt\(findings, warnings\)/u);
  assert.doesNotMatch(flow, /panel\.askReview\(/u, "prompt yolu kullanıcıya maskesiz seçim sunuyor");
});

test("üretim panelinde seçim kaldırma veya maskesiz gönderme yolu yoktur", async () => {
  const panel = await source("guard/src/content/panel.js");
  assert.doesNotMatch(panel, /askReview|showFailure|allowUnmasked/u);
  assert.doesNotMatch(panel, /Maskesiz|Yine de gönder|Olduğu gibi gönder/u);
});

test("kendi tetiklediğimiz gönderim yeniden yakalanmaz", async () => {
  const code = await source("guard/src/content/interceptor.js");
  const decision = code.slice(code.indexOf("function promptDecision("), code.indexOf("const settle ="));
  // Maskeledikten sonra gönder düğmesine biz basıyoruz; bu kontrol olmadan
  // kendi gönderimimizi yakalayıp sonsuz döngüye girerdik.
  assert.match(decision, /approvedPrompts\.has\(promptKey\(text\)\)/u);
  assert.match(code, /approvedPrompts\.add\(promptKey\(finalText\)\)/u);
});

test("IME yazımı ve satır atlama gönderim sayılmaz", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.match(code, /event\.key !== "Enter" \|\| event\.isComposing/u);
});

test("prompt modeli kurum politikasıyla zorunlu açık", async () => {
  const { DEFAULT_SETTINGS } = await import("../guard/src/settings.js");
  assert.equal(DEFAULT_SETTINGS.guardPrompts, true);
  assert.equal(DEFAULT_SETTINGS.promptModelScan, true);
  assert.equal(coerceSettings({ promptModelScan: false }).promptModelScan, true);
  const options = await source("guard/src/options/options.html");
  assert.doesNotMatch(options, /id="promptModelScan"/u, "prompt modeli hâlâ kullanıcı seçeneği olarak gösteriliyor");
});

// ---------------------------------------------------------------- ikinci inceleme regresyonları

test("gönderim dinleyicileri modül düzeyinde kaydedilir", async () => {
  const code = await source("guard/src/content/interceptor.js");
  const promiseBlock = code.slice(code.indexOf("readSettings()"), code.indexOf("onSettingsChanged("));
  // Ayar okuması hata verirse koruma hiç kurulmasın diye içeri alınmamalı;
  // ayrıca document_start'ta kayıtlı olmaları sayfa betiklerinden önce gelmelerinin şartı.
  assert.doesNotMatch(promiseBlock, /addEventListener/u, "dinleyici ayar sözünün içine kaymış");
  for (const type of ["keydown", "click", "paste", "drop"]) {
    assert.match(code, new RegExp(`window\\.addEventListener\\(\\s*\n?\\s*"${type}"`, "u"), `${type} dinleyicisi yok`);
  }
});

// Gerçek Chrome'da ölçüldü: execCommand("insertText") metindeki her \n için
// paragraf ayırıcı üretir, innerText ise <p> sınırını iki satır sonu sayar.
// Bu yüzden "yazdığımı geri okuyunca aynı mı" karşılaştırması çok satırlı
// hiçbir promptta sağlanamaz ve maskeli gönderimi tamamen durdurur.
test("metin yazımı round-trip eşitliğiyle doğrulanmaz", async () => {
  const composer = await source("guard/src/content/composer.js");
  assert.doesNotMatch(composer, /readComposerText\(composer\)\.trim\(\) === text\.trim\(\)/u);
  // Satır yapısı korunmalı: tek parça yazım paragrafları çoğaltıyor.
  assert.match(composer, /insertLineBreak/u);

  const interceptor = await source("guard/src/content/interceptor.js");
  // Asıl güvenlik koşulu: seçilen değerler artık kutuda yok.
  assert.match(interceptor, /function residualValues\(/u);
  assert.match(interceptor, /residualValues\(composer, findings, selectedIds\)/u);
});

test("kutu ve gönder düğmesi arama alanı sayfa geneline taşmaz", async () => {
  const code = await source("guard/src/content/composer.js");
  const find = code.slice(code.indexOf("export function findComposer("), code.indexOf("export function composerForSend("));
  // Belge geneline düşmek, kenar çubuğundaki arama kutusunda basılan Enter'ı
  // prompt gönderimi sayıyordu.
  assert.doesNotMatch(find, /document\.querySelector/u, "findComposer sayfa geneline düşüyor");
  // Genel "button[type=submit]" yedeği sayfadaki her formu gönderim sanardı.
  assert.doesNotMatch(code, /GENERIC_SEND|button\[type='submit'\]/u);
});

test("kendi gönderimimizi tanımak boşluk farkına takılmaz", async () => {
  const code = await source("guard/src/content/interceptor.js");
  // Kutuya yazdığımız metni geri okuduğumuzda satır sonu sayısı değişebiliyor;
  // tam eşitlik aranırsa kendi gönderimimizi yakalayıp döngüye gireriz.
  assert.match(code, /const promptKey = \(text\) => String\(text\)\.replace\(\/\\s\+\/gu, " "\)\.trim\(\)/u);
  assert.match(code, /approvedPrompts\.has\(promptKey\(text\)\)/u);
});

test("uzun promptta model çalıştırılmaz, tarama offscreen'e devredilir", async () => {
  const interceptor = await source("guard/src/content/interceptor.js");
  assert.match(interceptor, /text\.length > SYNC_SCAN_LIMIT.*useModel: false/su);
  const engine = await source("guard/src/engine.js");
  assert.match(engine, /useModel = false/u);
  assert.match(engine, /if \(!useModel\) throw new SkipModel\(\)/u);
});

test("eşzamanlı tarama sınırı ölçülen en kötü duruma göre seçilmiş", () => {
  // 500 KB'da yoğun PII ile 3,8 s tarama ölçüldü; sınır ona göre indirildi.
  assert.ok(SYNC_SCAN_LIMIT <= 100_000, "eşzamanlı sınır sekmeyi kilitleyecek kadar yüksek");
});

test("kurumsal kural indeksi her taramada yeniden kurulmaz", () => {
  const rules = [
    { id: "1", find: "Project Phoenix", replacement: "[PROJE_1]" },
    { id: "2", find: "Utsunomiya", replacement: "[FABRIKA_1]" },
  ];
  // Aynı dizi ikinci kez verildiğinde önbellek kullanılmalı; 5.000 kuralda
  // indeksi yeniden kurmak her Enter'a 129 ms ekliyordu.
  assert.strictEqual(primeRules(rules), primeRules(rules));
  const other = [...rules];
  assert.notStrictEqual(primeRules(other), primeRules(rules));
});

test("yalnız yapılandırılmış kural sunucusundaki kesinti gönderimi durdurur", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.match(code, /function ruleWarnings\(/u);
  assert.match(code, /!settings\.serverUrl \|\| rulesStatus === "ready"/u);
  assert.match(code, /settings\.serverUrl && rulesStatus !== "ready"/u);

  const offscreen = await source("guard/src/offscreen.js");
  assert.match(offscreen, /if \(settings\.serverUrl && ruleCache\.status !== "ready"\)/u);
});

test("engelleme mesajı başarısız koruma katmanını açıkça söyler", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.match(code, /function blockingReason\(/u);
  assert.match(code, /Gönderim durduruldu: \$\{blockingReason\(warnings/u);
  assert.match(code, /Prompt gönderimi durduruldu: \$\{blockingReason\(warnings/u);
});

test("deferred taramada vazgeçmek paneli kapatır ve oturumu bırakır", async () => {
  const code = await source("guard/src/content/interceptor.js");
  const flow = code.slice(code.indexOf("async function guardPrompt("));
  const cancel = flow.slice(flow.indexOf("onCancel: () => {"), flow.indexOf("const opened = await EnginePort.open()"));
  assert.match(cancel, /teardown\(\)/u, "vazgeçince panel ekranda kalıyor");
  assert.match(flow, /const teardown = \(\) => \{/u);
});

test("Cmd/Ctrl+Enter gönderimi de denetlenir", async () => {
  const code = await source("guard/src/content/interceptor.js");
  // Shift/Alt+Enter satır atlar; Cmd/Ctrl+Enter bazı arayüzlerde gönderir.
  assert.match(code, /if \(event\.shiftKey \|\| event\.altKey\) return;/u);
  assert.doesNotMatch(code, /event\.shiftKey \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey/u);
});

// ---------------------------------------------------------------- çekirdekten portlanan katmanlar

// Belgenin kendi alan etiketlerini okuyan katman modelden bağımsızdır: resmî
// evrakta model yanılsa ya da hiç çalışmasa bile ad, adres ve kayıt numarası
// bulunur. Guard'ın hiçbir yolunda yoktu.
test("alan etiketi katmanı Guard'ın iki yolunda da çalışır", async () => {
  const engine = await source("guard/src/engine.js");
  assert.match(engine, /import \{ detectLabelledFields \}/u);
  assert.match(engine, /const fieldFindings = detectLabelledFields\(units\)/u);

  const textEngine = await source("guard/src/content/text-engine.js");
  assert.match(textEngine, /detectLabelledFields\(units\)/u, "prompt yolunda alan katmanı yok");
});

// Gerçek çalıştırma: resmî evrak METNİ prompt kutusuna yapıştırıldığında
// etiketli alanlar bulunuyor ve maskeleniyor mu.
test("yapıştırılan ikametgâh metninde etiketli alanlar maskelenir", () => {
  const belge = [
    "T.C. NÜFUS VE VATANDAŞLIK İŞLERİ",
    "Adı : SAMET",
    "Soyadı : KARA",
    "Baba adı : MEHMET",
    "Adres : Kızılırmak Mah. 1450. Sok. No:3 Çankaya/ANKARA",
    "Adres no : 1234567890",
  ].join("\n");

  const findings = scanPromptText(belge, []);
  assert.ok(findings.length > 0, "etiketli alanlar hiç bulunamadı");

  const masked = maskPromptText(belge, findings, findings.map((finding) => finding.id));
  for (const secret of ["SAMET", "KARA", "MEHMET", "Kızılırmak", "1234567890"]) {
    assert.ok(!masked.includes(secret), `"${secret}" maskelenmedi:\n${masked}`);
  }
});

// Düz dizi birleştirmesi her katmanı 1'den saydırıyor, iki farklı değere aynı
// yer tutucuyu veriyordu — eşleştirme kaydı anlamsızlaşıyor.
test("bulgular güven sırasıyla birleştirilir, düz dizi ile değil", async () => {
  const engine = await source("guard/src/engine.js");
  assert.match(engine, /const findings = mergeFindings\(\[/u);
  assert.doesNotMatch(
    engine,
    /const findings = \[\.\.\.importedFindings/u,
    "belge yolunda düz dizi birleştirmesi geri geldi"
  );
  assert.match(engine, /mergeFindings\(\[ruleFindings, patternFindings, fieldFindings, namedEntities\]\)/u);

  const textEngine = await source("guard/src/content/text-engine.js");
  assert.match(textEngine, /const found = mergeFindings\(\[/u);
});

// Ayrı dosya adı yolu kaldırıldı: çıktı adını applyDocumentChanges aynı
// haritayla yazıyor, ayrı numaralandırma yer tutucu çakışması üretiyordu.
test("çıktı adı belgeyle aynı haritadan yazılır", async () => {
  const engine = await source("guard/src/engine.js");
  assert.doesNotMatch(engine, /function scanFilename\(/u, "ayrı dosya adı yolu geri geldi");
  assert.doesNotMatch(engine, /session\.filenameFindings/u);
  assert.match(engine, /filename: result\.filename/u);
});

// İlerleme ekranı 30 saniye boyunca tek bir "taranıyor" satırı gösteriyordu;
// kullanıcı takıldığını sanıyor. Motorun ürettiği HER aşamanın adı olmalı.
test("motorun her ilerleme aşamasının kullanıcı dilinde adı var", async () => {
  const panel = await source("guard/src/content/panel.js");
  const labels = new Set(
    [...panel.matchAll(/^\s{2}(\w+): "/gmu)].map((match) => match[1])
  );

  const engineSources = ["guard/src/engine.js", "guard/src/offscreen.js"];
  const emitted = new Set();
  for (const file of engineSources) {
    const code = await source(file);
    for (const match of code.matchAll(/phase: "(\w+)"/gu)) emitted.add(match[1]);
  }

  assert.ok(emitted.size >= 4, "motor aşama yayınlamıyor");
  for (const phase of emitted) {
    assert.ok(labels.has(phase), `"${phase}" aşamasının panelde adı yok`);
  }
});

test("ilerleme ekranı yüzde, kalan süre ve çalışan donanımı gösterir", async () => {
  const panel = await source("guard/src/content/panel.js");
  assert.match(panel, /%\$\{Math\.round\(ratio \* 100\)\}/u, "yüzde gösterilmiyor");
  assert.match(panel, /function remainingLabel\(/u, "kalan süre tahmini yok");
  // Erken tahmin çok oynak; yanlış bir "2 dk kaldı" güveni bitirir.
  assert.match(panel, /ratio < 0\.05/u, "kalan süre çok erken gösteriliyor");
  assert.match(panel, /yavaş yol/u, "WASM'e düşüldüğü kullanıcıya söylenmiyor");

  const interceptor = await source("guard/src/content/interceptor.js");
  assert.match(interceptor, /device: engineDevice/u, "cihaz panele geçirilmiyor");
});

// storage.session varsayılan olarak yalnız güvenilir bağlamlara açıktır.
// Açılmazsa içerik betiği cihazı hiç okuyamaz ve WASM'e düşüldüğü
// kullanıcıdan gizli kalır — ilerleme ekranındaki uyarı sessizce ölür.
test("çalışan donanım içerik betiğinden okunabilir", async () => {
  const background = await source("guard/src/background.js");
  assert.match(background, /setAccessLevel\(\{ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" \}\)/u);
  const interceptor = await source("guard/src/content/interceptor.js");
  assert.match(interceptor, /chrome\.storage\.session\s*\n?\s*\.get\(DEVICE_KEY\)/u);
});

// chatgpt.com'da canlı ölçüldü: gerçek upload input'una files+change de,
// sentetik drop da eki iliştiriyor. ChatGPT'de "taranıyor ama eklenmiyor"
// belirtisinin sebebi mekanizma değil, teslimin site-özel bir kapının
// arkasında kalıp ChatGPT'de hiç DOĞRULANMAMASIYDI: yanlış hedefe inen drop
// sessizce kayboluyordu. Katmanlı ve doğrulanan teslim her sitede açık kalmalı.
test("teslim her sitede katmanlı ve doğrulanır; site-özel kapı yok", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.match(code, /const prefersFileInputDelivery = \(\) => true;/u, "teslim yine site-özel kapıya alınmış");
  assert.doesNotMatch(code, /prefersFileInputDelivery = \(\) => SITE_ID ===/u);

  // Drop yolu: `void guardFiles(` üç kez, `cleanupDropUi(` iki kez geçtiği için
  // dilim, yalnız drop yolunda geçen uyarı metnine kadar alınır.
  const dropEnd = code.indexOf("Maskelenmiş dosya ${SITE} yükleme alanı tarafından kabul edilmedi");
  assert.ok(dropEnd > 0, "drop yolunun başarısızlık uyarısı yok — sessiz kayıp geri geldi");
  const dropStart = code.lastIndexOf("const firstInput = prefersFileInputDelivery()", dropEnd);
  const drop = code.slice(dropStart, dropEnd);
  // Girdi teslimi denenmeli ve sonuç beklenmeli; başarısızsa kullanıcı duymalı.
  assert.match(drop, /deliverToFileInput\(firstInput, delivered\)/u, "drop yolunda girdi teslimi yok");
  assert.match(drop, /await waitForDelivery\(delivered, deliveryBaseline\)/u, "teslim doğrulanmıyor");
});

// gemini.google.com'da canlı ölçüldü: dosya girdisi yalnız "Yükleme ve araçlar"
// menüsü açıkken DOM'da; bırakma anında yok. Tarama sürerken menü kapanıp
// girdiyi öldürünce teslim ölü girdiye gidiyor, ek hiç oluşmuyordu. Girdi yoksa
// menü açılıp taze girdi beklenmeli. Girdi yolu (menü açıkken files+change)
// aynı sayfada gerçek ek üretti — mekanizma doğru, eksik olan girdinin varlığıydı.
test("teslim anında dosya girdisi yoksa yükleme menüsü açılıp taze girdi beklenir", async () => {
  const code = await source("guard/src/content/interceptor.js");
  assert.match(code, /async function materializeUploadInput\(/u, "girdi kurdurma yok");
  assert.match(code, /async function deliverToFileInput\(/u, "teslim eşzamansız değil; menü beklenemez");
  // Gemini'nin Türkçe etiketi ve İngilizce karşılıkları tanınmalı.
  assert.match(code, /UPLOAD_TRIGGER_LABEL = \/[^/]*yükleme ve araçlar[^/]*upload and tools/u, "Gemini tetikleyicisi tanınmıyor");
  // Bağlı aday yoksa kurdurma denenmeli.
  assert.match(code, /if \(!candidates\.some\(\(input\) => input\.isConnected\)\)/u);
  assert.match(code, /await materializeUploadInput\(files\)/u);
  // Üç çağrı yeri de artık beklemeli; beklenmeyen çağrı her zaman "truthy" Promise döner
  // ve teslim başarılı sanılır.
  const calls = code.match(/deliverToFileInput\((firstInput|input), delivered\)/gu) || [];
  assert.ok(calls.length >= 3, `çağrı yeri sayısı beklenmedik: ${calls.length}`);
  assert.doesNotMatch(code, /(?<!await )deliverToFileInput\((firstInput|input), delivered\)/u, "beklenmeyen deliverToFileInput çağrısı var");
});

// Uzantı yüklenmeden açık kalan sekmeye içerik betiği girmez: panel yok, uyarı
// yok, dosya maskelenmeden gider — sahada Gemini'de tam bu yaşandı. Kullanıcı
// bunu simgeden görebilmeli: nokta yoksa Guard o sekmede yok.
test("içerik betiği yüklendiğini bildirir ve rozet bunu gösterir", async () => {
  const interceptor = await source("guard/src/content/interceptor.js");
  assert.match(interceptor, /type: MSG\.contentReady/u, "içerik betiği hazır olduğunu bildirmiyor");
  const background = await source("guard/src/background.js");
  assert.match(background, /case MSG\.contentReady:/u);
  assert.match(background, /ready \? "●" : ""/u, "hazır sekme rozette görünmüyor");
  // Sekme yenilenince işaret düşmeli; içerik betiği yeniden bildirir.
  assert.match(background, /delete ready\[tabId\]/u);
});
