import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";

import { CdpClient } from "./cdp-client.mjs";
import { fixturePage } from "./fixture-page.mjs";
import { MSG } from "../../guard/src/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const extensionDir = path.join(root, "dist-guard");
const sites = [
  { id: "chatgpt", url: "https://chatgpt.com/__redakt_guard_e2e__" },
  { id: "gemini", url: "https://gemini.google.com/__redakt_guard_e2e__" },
  { id: "claude", url: "https://claude.ai/__redakt_guard_e2e__" },
];
const secrets = ["ayse.yilmaz@example.com", "+90 532 111 22 33"];
const sampleText = `E2E synthetic record\nEmail: ${secrets[0]}\nPhone: ${secrets[1]}\n`;
const explicitBrowser = argument("browser");
const headed = process.argv.includes("--headed") || process.env.GUARD_E2E_HEADED === "1";
const quick = process.argv.includes("--quick");
const safeMode = process.argv.includes("--safe-mode");
const timeoutMs = Number(argument("timeout") || 180_000);

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function candidates(kind) {
  const configured = kind === "edge"
    ? process.env.GUARD_E2E_EDGE_BINARY
    : process.env.GUARD_E2E_CHROME_BINARY;
  const fromPath = (process.env.PATH || "")
    .split(path.delimiter)
    .flatMap((directory) => {
      if (!directory) return [];
      const names = process.platform === "win32"
        ? (kind === "edge" ? ["msedge.exe"] : ["chrome.exe"])
        : (kind === "edge" ? ["microsoft-edge", "microsoft-edge-stable"] : ["chrome", "google-chrome", "chromium"]);
      return names.map((name) => path.join(directory, name));
    });
  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const relative = kind === "edge"
      ? "Microsoft/Edge/Application/msedge.exe"
      : "Google/Chrome/Application/chrome.exe";
    return [configured, ...fromPath, ...roots.map((base) => path.join(base, relative))].filter(Boolean);
  }
  if (process.platform === "darwin") {
    return kind === "edge"
      ? [configured, ...fromPath, "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].filter(Boolean)
      : [configured, ...fromPath, "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  }
  return kind === "edge"
    ? [configured, ...fromPath, "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"].filter(Boolean)
    : [configured, ...fromPath, "/opt/google/chrome-for-testing/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
}

async function executable(kind) {
  for (const candidate of candidates(kind)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Sonraki bilinen kurulum yolunu dene.
    }
  }
  return null;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Edge'in yardımcı süreçleri Windows'ta ana süreç kapandıktan kısa süre sonra
// profil dosyalarını bırakabilir. EBUSY/EPERM için sınırlı bekleme uygulanır;
// temizliğin başarısızlığı dosya teslim testinin sonucunu rastgele düşürmesin.
const removeTemporaryDirectory = (directory) => fs.rm(directory, {
  recursive: true, force: true, maxRetries: 10, retryDelay: 250,
});

async function waitUntil(check, { timeout = timeoutMs, interval = 200, message = "Koşul zaman aşımına uğradı." } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw new Error(`${message}${lastError ? ` Son hata: ${lastError.message}` : ""}`);
}

async function launch(kind, binary) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), `redakt-guard-e2e-${kind}-`));
  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--enable-unsafe-extension-debugging",
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync",
    "--ignore-certificate-errors",
    "--window-size=1280,900",
  ];
  if (!headed) args.push("--headless=new");
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push("about:blank");

  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  const activePort = path.join(profileDir, "DevToolsActivePort");
  const port = await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`${kind} erken kapandı: ${stderr}`);
    const text = await fs.readFile(activePort, "utf8").catch(() => "");
    return Number(text.split(/\r?\n/u)[0]) || 0;
  }, { timeout: 30_000, message: `${kind} DevTools portu açılmadı.` });
  const version = await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    return response?.ok ? response.json() : null;
  }, { timeout: 15_000, message: `${kind} CDP sürüm bilgisi alınamadı.` });
  const client = await CdpClient.connect(version.webSocketDebuggerUrl);

  const close = async () => {
    await client.send("Browser.close").catch(() => {});
    client.close();
    await waitUntil(() => child.exitCode !== null, { timeout: 5_000 }).catch(() => child.kill());
    await removeTemporaryDirectory(profileDir);
  };
  return { client, close, product: version.Browser || kind };
}

async function evaluate(client, sessionId, expression, contextId = null) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Sayfa değerlendirmesi başarısız.");
  return response.result?.value;
}

async function fixtureTarget(client, site) {
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const executionContexts = [];
  const removeContextListener = client.on("Runtime.executionContextCreated", (event, eventSession) => {
    if (eventSession === sessionId && event.context) executionContexts.push(event.context);
  });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Fetch.enable", {
    patterns: [{ urlPattern: "*__redakt_guard_e2e__*", resourceType: "Document", requestStage: "Request" }],
  }, sessionId);
  const remove = client.on("Fetch.requestPaused", (event, eventSession) => {
    if (eventSession !== sessionId) return;
    const body = Buffer.from(fixturePage(site.id), "utf8").toString("base64");
    void client.send("Fetch.fulfillRequest", {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "text/html; charset=utf-8" },
        { name: "Cache-Control", value: "no-store" },
      ],
      body,
    }, sessionId);
  });
  await client.send("Page.navigate", { url: site.url }, sessionId);
  await waitUntil(
    () => evaluate(client, sessionId, "Boolean(window.__redaktFixture && window.__redaktFixture.ready)"),
    { timeout: 30_000, message: `${site.id} fixture yüklenmedi.` }
  );
  await waitUntil(
    () => evaluate(client, sessionId, `(() => {
      const raw = document.documentElement.getAttribute("data-redakt-guard");
      if (!raw) return false;
      try { return JSON.parse(raw).active === true; } catch { return false; }
    })()`),
    { timeout: 30_000, message: `${site.id} sayfasında Redakt Guard etkinleşmedi. Chrome 137+ resmi dağıtımı komut satırından paketlenmemiş uzantı yüklemez; Chrome for Testing yolunu GUARD_E2E_CHROME_BINARY ile verin.` }
  );
  return {
    sessionId,
    targetId,
    executionContexts,
    remove: () => {
      remove();
      removeContextListener();
    },
  };
}

async function createFixtures() {
  const text = Buffer.from(sampleText, "utf8");

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([620, 260]);
  page.drawText(sampleText.replace(/\n/gu, "  "), { x: 30, y: 180, size: 16, font });

  const docx = new JSZip();
  docx.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  docx.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  docx.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${sampleText}</w:t></w:r></w:p></w:body></w:document>`);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["E-posta", "Telefon"],
    [secrets[0], secrets[1]],
  ]), "Sentetik");

  const canvas = createCanvas(1500, 300);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.font = "48px Arial";
  context.fillText(`Email: ${secrets[0]}`, 40, 105);
  context.fillText(`Phone: ${secrets[1]}`, 40, 205);

  const fixtures = [
    { id: "txt", name: "redakt-e2e.txt", mime: "text/plain", bytes: text },
    { id: "pdf", name: "redakt-e2e.pdf", mime: "application/pdf", bytes: Buffer.from(await pdf.save()) },
    { id: "docx", name: "redakt-e2e.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: await docx.generateAsync({ type: "nodebuffer" }) },
    { id: "xlsx", name: "redakt-e2e.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })) },
    { id: "png", name: "redakt-e2e.png", mime: "image/png", bytes: canvas.toBuffer("image/png") },
  ];
  return quick ? fixtures.slice(0, 1) : fixtures;
}

async function triggerFile(client, sessionId, fixture, suffix = "") {
  const name = suffix ? fixture.name.replace(/(\.[^.]+)$/u, `-${suffix}$1`) : fixture.name;
  // Tarayıcı gerçek bir disk dosyasını girdiye bağlar ve native change/input
  // olaylarını üretir. Windows yol/boşluk/Türkçe karakterleri de bu yoldan geçer.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "redakt-e2e Türkçe dosya "));
  try {
    const filename = path.join(directory, name);
    await fs.writeFile(filename, fixture.bytes);
    const { root: document } = await client.send("DOM.getDocument", {}, sessionId);
    const { nodeId } = await client.send("DOM.querySelector", { nodeId: document.nodeId, selector: "#upload" }, sessionId);
    await client.send("DOM.setFileInputFiles", { nodeId, files: [filename] }, sessionId);
    // Guard baytları eşzamansız okuyabilir; çıktı veya terminal olaya kadar
    // dosya diskte tutulur. Temizliği readOutcome sonrasındaki finally yapar.
    return () => removeTemporaryDirectory(directory);
  } catch (error) {
    await removeTemporaryDirectory(directory);
    throw error;
  }
}

async function validateOutput(fixture, received, label) {
  const output = Buffer.from(received.base64, "base64");
  assert.ok(output.length > 0, `${label}: güvenli çıktı boş`);
  assert.notDeepEqual(output, fixture.bytes, `${label}: çıktı özgün dosyayla aynı kaldı`);
  assert.match(received.name, /_redakte\.[^.]+$/u, `${label}: güvenli çıktı adı işaretlenmedi`);

  let extracted = "";
  if (fixture.id === "txt") extracted = output.toString("utf8");
  if (fixture.id === "docx") extracted = await (await JSZip.loadAsync(output)).file("word/document.xml").async("text");
  if (fixture.id === "xlsx") {
    const workbook = XLSX.read(output, { type: "buffer" });
    extracted = workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join("\n");
  }
  if (fixture.id === "pdf") assert.equal((await PDFDocument.load(output)).getPageCount(), 1, `${label}: PDF çıktısı geçersiz`);
  if (fixture.id === "png") {
    const image = await loadImage(output);
    assert.ok(image.width > 0 && image.height > 0, `${label}: görsel çıktısı geçersiz`);
  }
  if (extracted) {
    for (const secret of secrets) assert.ok(!extracted.includes(secret), `${label}: özgün sentetik değer sızdı`);
    assert.match(extracted, /\[(?:EMAIL|TELEFON)_\d+\]/u, `${label}: maskeli yer tutucu bulunamadı`);
  }
}

async function readOutcome(client, target, site, fixture, previousOperationIds) {
  const sessionId = target.sessionId;
  const outcome = await waitUntil(
    async () => {
      const received = await evaluate(client, sessionId, "window.__redaktFixture && window.__redaktFixture.received[0] || null");
      if (received) return { received };
      const diagnostic = await extensionMessage(client, target, MSG.readDiagnostics).catch(() => null);
      // Tanılama listesi bütün sekmelerce paylaşılır. Diğer sekmenin tamamlanan
      // işi bu sekmenin başarısızlığı sayılmamalı; başarı mesajı dosya okuma
      // callback'inden önce de gelebilir.
      const terminal = diagnostic?.report?.recentOperations?.find((event) =>
        !previousOperationIds.has(event.operationId)
        && event.site === site.replace(/-parallel$/u, "")
        && event.outcome !== "success"
      );
      return terminal ? { terminal } : null;
    },
    { message: `${site}/${fixture.id} güvenli dosyayı teslim alamadı.` }
  );
  if (outcome.terminal) {
    throw new Error(`${site}/${fixture.id} Guard tarafından ${outcome.terminal.outcome}: ${outcome.terminal.errorCode || "unknown"}`);
  }
  const { received } = outcome;
  assert.equal((await evaluate(client, sessionId, "window.__redaktFixture.received.length")), 1, `${site}: dosya birden fazla teslim edildi`);
  await validateOutput(fixture, received, `${site}/${fixture.id}`);
  assert.deepEqual(await evaluate(client, sessionId, "window.__redaktFixture.errors"), [], `${site}: fixture dosyayı okuyamadı`);
  // Dosyanın input'a düşmesi teslimin başlangıcıdır. Guard panelinin kapanması,
  // sitenin yüklemeyi kararlı gördüğünü ve işlem/tanılama kapanışının çalıştığını
  // gösterir; sekmeyi bundan önce kapatmak gerçek kullanıcı akışını yarıda keser.
  await waitUntil(
    () => evaluate(client, sessionId, "window.__redaktFixture.received.length === 1 && !document.querySelector('redakt-guard')"),
    { timeout: 15_000, message: `${site}/${fixture.id} Guard teslim akışını kapatmadı.` }
  );
  return { site, format: fixture.id, name: received.name, bytes: received.size, masked: true };
}

async function extensionMessage(client, target, type) {
  const context = await waitUntil(
    () => target.executionContexts.find((item) => item.auxData?.type === "isolated" && !item.auxData?.isDefault),
    { timeout: 15_000, message: "Redakt Guard yalıtılmış içerik bağlamı bulunamadı." }
  );
  return evaluate(
    client,
    target.sessionId,
    `(async () => chrome.runtime.sendMessage({ type: ${JSON.stringify(type)} }))()`,
    context.id
  );
}

async function verifyDiagnosticReport(client, expectedOperations) {
  // Aynı mesajı kullanıcı Ayarlar sayfasındaki düğme de gönderir. CDP ile
  // chrome-extension:// sayfası açmak bazı Chromium sürümlerinde engellenir;
  // içerik betiğinin gerçek ISOLATED bağlamı aynı yetkili runtime kanalını sınar.
  const target = await fixtureTarget(client, sites[0]);
  try {
    const response = await waitUntil(async () => {
      const value = await extensionMessage(client, target, MSG.readDiagnostics);
      return value?.ok && value.report?.recentOperations?.length >= expectedOperations ? value : null;
    }, { timeout: 15_000, message: "Tanılama raporu tamamlanan işlemleri içermedi." });
    const report = response.report;
    assert.equal(report.schema, 1, "tanılama raporu şeması geçersiz");
    assert.equal(report.privacy.containsFileNames, false, "tanılama raporu dosya adı taşıdığını bildiriyor");
    assert.equal(report.privacy.containsDocumentContent, false, "tanılama raporu belge içeriği taşıdığını bildiriyor");
    if (safeMode) assert.equal(report.engine.device, "wasm", "güvenli mod CPU/WASM üzerinde çalışmadı");
    assert.ok(report.recentOperations.every((event) => event.outcome === "success"), "başarılı E2E akışları tanılamada başarısız göründü");
    const serialized = JSON.stringify(report);
    for (const sensitive of [...secrets, "redakt-e2e", "parallel-0", "parallel-1"]) {
      assert.ok(!serialized.includes(sensitive), `tanılama raporu hassas/değişken veri taşıdı: ${sensitive}`);
    }
    return report.recentOperations.length;
  } finally {
    target.remove();
    await client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  }
}

async function runBrowser(kind, binary, fixtures) {
  const browser = await launch(kind, binary);
  const startedAt = Date.now();
  const results = [];
  try {
    process.stdout.write(`[${kind}] ${browser.product} · izole test sayfaları · ${safeMode ? "tek iş parçacıklı CPU" : "otomatik motor"}\n`);
    if (safeMode) {
      const target = await fixtureTarget(browser.client, sites[0]);
      try {
        const response = await extensionMessage(browser.client, target, MSG.restartEngine);
        assert.equal(response?.ok, true, "güvenli motor yeniden başlatılamadı");
      } finally {
        target.remove();
        await browser.client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      }
    }
    for (const site of sites) {
      for (const fixture of fixtures) {
        const target = await fixtureTarget(browser.client, site);
        let removeFile;
        try {
          process.stdout.write(`[${kind}] ${site.id}/${fixture.id} · taranıyor\n`);
          const before = await extensionMessage(browser.client, target, MSG.readDiagnostics);
          const previousOperationIds = new Set((before?.report?.recentOperations || []).map((event) => event.operationId));
          removeFile = await triggerFile(browser.client, target.sessionId, fixture);
          try {
            results.push(await readOutcome(browser.client, target, site.id, fixture, previousOperationIds));
          } catch (error) {
            const diagnostics = await extensionMessage(browser.client, target, MSG.readDiagnostics).catch(() => null);
            if (diagnostics?.report) process.stderr.write(`PII-siz tanılama: ${JSON.stringify(diagnostics.report)}\n`);
            throw error;
          }
        } finally {
          await removeFile?.();
          target.remove();
          await browser.client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
        }
      }
    }

    // Paylaşılan offscreen motor kuyruğu ve sekme başına akış kilidi birlikte
    // sınanır: iki ayrı site aynı anda dosya bırakır ve ikisi de tek kopya alır.
    const concurrent = await Promise.all(sites.slice(0, 2).map((site) => fixtureTarget(browser.client, site)));
    const removeFiles = [];
    try {
      const previousIds = await Promise.all(concurrent.map(async (target) => {
        const before = await extensionMessage(browser.client, target, MSG.readDiagnostics);
        return new Set((before?.report?.recentOperations || []).map((event) => event.operationId));
      }));
      const triggered = await Promise.allSettled(concurrent.map(async (target, index) => {
        removeFiles.push(await triggerFile(browser.client, target.sessionId, fixtures[0], `parallel-${index}`));
      }));
      for (const result of triggered) if (result.status === "rejected") throw result.reason;
      results.push(...await Promise.all(concurrent.map((target, index) => readOutcome(browser.client, target, `${sites[index].id}-parallel`, fixtures[0], previousIds[index]))));
    } finally {
      await Promise.all(removeFiles.map((remove) => remove()));
      for (const target of concurrent) {
        target.remove();
        await browser.client.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
      }
    }
    const diagnosticOperations = await verifyDiagnosticReport(browser.client, results.length);
    return { browser: kind, product: browser.product, durationMs: Date.now() - startedAt, results, diagnosticOperations };
  } finally {
    await browser.close();
  }
}

const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3, "Önce npm run build ile MV3 paketini üretin.");
const fixtures = await createFixtures();

const requested = explicitBrowser && explicitBrowser !== "all" ? [explicitBrowser] : ["chrome", "edge"];
const selected = [];
for (const kind of requested) {
  if (!["chrome", "edge"].includes(kind)) throw new Error(`--browser yalnız chrome, edge veya all olabilir: ${kind}`);
  const binary = await executable(kind);
  if (binary) selected.push({ kind, binary });
  else if (explicitBrowser && explicitBrowser !== "all") throw new Error(`${kind} bu cihazda bulunamadı.`);
}
if (!selected.length) throw new Error("Chrome veya Edge kurulumu bulunamadı.");

const reports = [];
for (const browser of selected) {
  process.stdout.write(`\n[${browser.kind}] Redakt Guard ${manifest.version} E2E başlıyor…\n`);
  const report = await runBrowser(browser.kind, browser.binary, fixtures);
  reports.push(report);
  process.stdout.write(`[${browser.kind}] PASS · ${report.results.length} izole sayfa dosya teslimi · ${(report.durationMs / 1000).toFixed(1)} sn\n`);
}
process.stdout.write(`\nPASS · ${reports.length} tarayıcı · ${reports.reduce((sum, item) => sum + item.results.length, 0)} senaryo\n`);
