const EDITORS = {
  chatgpt: `
    <form id="composer"><div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>
      <input id="upload" type="file" multiple aria-label="Attach files"><button type="button" data-testid="send-button">Send</button></form>`,
  gemini: `
    <form id="composer"><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
      <input id="upload" type="file" multiple aria-label="Upload and tools"><button type="button" class="send-button">Send</button></form>`,
  claude: `
    <form id="composer"><div class="ProseMirror" contenteditable="true"></div>
      <input id="upload" type="file" multiple aria-label="Attach files"><button type="button" aria-label="Send message">Send</button></form>`,
};

export function fixturePage(site) {
  if (!EDITORS[site]) throw new Error(`Bilinmeyen E2E sitesi: ${site}`);
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>Redakt Guard E2E · ${site}</title>
  <style>
    body { font: 14px system-ui; margin: 32px; }
    form { display: grid; gap: 12px; max-width: 680px; }
    [contenteditable] { min-height: 80px; border: 1px solid #aaa; }
    .attachment { padding: 8px; border: 1px solid #888; }
  </style>
</head>
<body data-site="${site}">
  <main>${EDITORS[site]}<section id="attachments"></section></main>
  <script>
    window.__redaktFixture = { ready: true, received: [], errors: [] };
    const input = document.getElementById("upload");
    const handled = new WeakSet();
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file || handled.has(file)) return;
      handled.add(file);
      try {
        const text = file.type === "text/plain" ? await file.text() : "";
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        window.__redaktFixture.received.push({ name: file.name, type: file.type, size: file.size, text, base64: btoa(binary) });
        const chip = document.createElement("article");
        chip.className = "attachment";
        chip.dataset.testid = "attachment-chip";
        chip.textContent = file.name;
        const progress = document.createElement("span");
        progress.dataset.testid = "attachment-upload-progress";
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", "Uploading");
        chip.append(progress);
        document.getElementById("attachments").append(chip);
        setTimeout(() => progress.remove(), 900);
      } catch (error) {
        window.__redaktFixture.errors.push(String(error && error.message || error));
      }
    });
  </script>
</body>
</html>`;
}
