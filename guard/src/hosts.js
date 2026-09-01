// Guard'ın araya girdiği yapay zekâ arayüzleri.
// manifest.json bu listeden üretilir; ikinci bir yerde tekrarlanmaz.

export const GUARDED_SITES = Object.freeze([
  Object.freeze({ id: "chatgpt", label: "ChatGPT", matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"] }),
  Object.freeze({ id: "claude", label: "Claude", matches: ["https://claude.ai/*"] }),
  Object.freeze({ id: "gemini", label: "Gemini", matches: ["https://gemini.google.com/*"] }),
  Object.freeze({ id: "copilot", label: "Microsoft Copilot", matches: ["https://copilot.microsoft.com/*"] }),
]);

export const GUARDED_MATCHES = Object.freeze(GUARDED_SITES.flatMap((site) => site.matches));

export function siteFor(hostname = "") {
  const host = String(hostname).toLowerCase();
  for (const site of GUARDED_SITES) {
    for (const match of site.matches) {
      const domain = match.replace(/^https:\/\//u, "").replace(/\/\*$/u, "");
      if (host === domain || host.endsWith(`.${domain}`)) return site;
    }
  }
  return null;
}

export function siteLabelFor(hostname = "") {
  return siteFor(hostname)?.label || "yapay zekâ aracı";
}

export function siteIdFor(hostname = "") {
  return siteFor(hostname)?.id || null;
}
