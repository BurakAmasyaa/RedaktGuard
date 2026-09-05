import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";

export const visualSecrets = ["ayse.yilmaz@example.com", "+90 532 111 22 33"];
export const controlText = "PUBLIC SAMPLE DOCUMENT";

// Her iki hassas alan gerçekten görünür olmalı; tek satırdaki PDF metni
// sayfa dışına taşıp telefon testini yanlışlıkla başarılı gösteriyordu.
export async function visualFixtures({ masked = false, blank = false } = {}) {
  const lines = blank ? [] : [
    controlText,
    `Email: ${masked ? "[EMAIL_1]" : visualSecrets[0]}`,
    `Phone: ${masked ? "[TELEFON_1]" : visualSecrets[1]}`,
  ];
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([620, 260]);
  lines.forEach((line, i) => page.drawText(line, { x: 30, y: 210 - i * 65, size: 20, font }));
  const canvas = createCanvas(1500, 400);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  context.font = "48px Arial";
  lines.forEach((line, i) => context.fillText(line, 40, 85 + i * 120));
  return [
    { id: "pdf", name: "redakt-e2e.pdf", mime: "application/pdf", bytes: Buffer.from(await pdf.save()) },
    { id: "png", name: "redakt-e2e.png", mime: "image/png", bytes: canvas.toBuffer("image/png") },
  ];
}
