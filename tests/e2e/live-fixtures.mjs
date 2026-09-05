import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { visualFixtures, visualSecrets, controlText } from "./visual-fixtures.mjs";

// Sadece test verisi üretir; tarayıcı açmaz, dosya yüklemez, gerçek belge okumaz.
// Her çağrı yeni bir klasör açar, kullanıcının dosyalarının üzerine yazmaz.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "Redakt canlı kabul "));
const fixtures = [
  ...await visualFixtures(),
  { name: "redakt-e2e.txt", bytes: Buffer.from(`${controlText}\nEmail: ${visualSecrets[0]}\nPhone: ${visualSecrets[1]}\n`) },
];
const manifest = { synthetic: true, createdAt: new Date().toISOString(), files: [] };
for (const fixture of fixtures) {
  await fs.writeFile(path.join(directory, fixture.name), fixture.bytes, { flag: "wx" });
  manifest.files.push({ name: fixture.name, sha256: createHash("sha256").update(fixture.bytes).digest("hex") });
}
await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
await fs.copyFile(new URL("./LIVE-ACCEPTANCE.md", import.meta.url), path.join(directory, "KABUL-LISTESI.md"));
process.stdout.write(`Sentetik canlı test paketi: ${directory}\nPDF + PNG + TXT + SHA-256 manifesti + kabul listesi\n`);
