// Redakt Guard paketleyicisi.
//
// Üç ayrı derleme gerekir:
//   1. Motor bağlamı (offscreen + ayarlar sayfası + service worker) — ES modül,
//      kod bölmeli, Worker'lı.
//   2. İçerik betikleri — MV3 içerik betiği modül olamaz, tek parça IIFE olmalı.
//   3. Model/OCR varlıkları ve manifest.
//
// Varlıklar (~177 MB) uzantıya kopyalanır; motor tamamen çevrimdışı çalışır.
// Kurumsal dağıtımda bunları sunucudan çekmek isterseniz --no-assets ile atlayın.

import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { guardManifest } from "./manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "dist-guard");
const withAssets = !process.argv.includes("--no-assets");

const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

async function clean() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
}

async function buildEngineContext() {
  await build({
    configFile: false,
    root: path.join(here, "src"),
    base: "./",
    publicDir: false,
    logLevel: "warn",
    worker: { format: "es" },
    build: {
      outDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      rollupOptions: {
        input: {
          offscreen: path.join(here, "src/offscreen.html"),
          options: path.join(here, "src/options/options.html"),
          background: path.join(here, "src/background.js"),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
}

// İçerik betikleri tek dosya olmalı: MV3 bunları modül olarak yüklemez,
// dinamik import da edemez.
async function buildContentScript(name) {
  await build({
    configFile: false,
    root,
    // Depo kökündeki public/ (177 MB model ve OCR) lib derlemesine kopyalanmasın.
    publicDir: false,
    logLevel: "warn",
    build: {
      outDir: path.join(outDir, "content"),
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      lib: {
        entry: path.join(here, `src/content/${name}.js`),
        formats: ["iife"],
        name: `RedaktGuard_${name.replace(/-/gu, "_")}`,
        fileName: () => `${name}.js`,
      },
    },
  });
}

async function copyAssets() {
  if (!withAssets) return;
  for (const folder of ["models", "ocr"]) {
    await fs.cp(path.join(root, "public", folder), path.join(outDir, folder), { recursive: true });
  }
}

async function writeIcons() {
  const dir = path.join(outDir, "icons");
  await fs.mkdir(dir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    const radius = size * 0.22;
    ctx.fillStyle = "#c81e1e";
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(size - radius, 0);
    ctx.quadraticCurveTo(size, 0, size, radius);
    ctx.lineTo(size, size - radius);
    ctx.quadraticCurveTo(size, size, size - radius, size);
    ctx.lineTo(radius, size);
    ctx.quadraticCurveTo(0, size, 0, size - radius);
    ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(size * 0.62)}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("R", size / 2, size * 0.54);
    await fs.writeFile(path.join(dir, `${size}.png`), canvas.toBuffer("image/png"));
  }
}

async function writeManifest() {
  const manifest = guardManifest(pkg.version);
  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function report() {
  let total = 0;
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await fs.stat(full)).size;
    }
  };
  await walk(outDir);
  const mb = (total / (1024 * 1024)).toFixed(1);
  console.log(`\nRedakt Guard hazır: dist-guard (${mb} MB${withAssets ? "" : ", varlıklar hariç"})`);
  console.log("Chrome/Edge → Uzantılar → Geliştirici modu → Paketlenmemiş öğe yükle → dist-guard");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await clean();
  await buildEngineContext();
  await buildContentScript("interceptor");
  await buildContentScript("page-guard");
  await copyAssets();
  await writeIcons();
  await writeManifest();
  await report();
}
