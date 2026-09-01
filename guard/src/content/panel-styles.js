// Panel kapalı bir shadow root içinde yaşar; sayfanın CSS'i buraya sızmaz,
// buradaki kurallar da sayfayı etkilemez.

export const PANEL_CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: block;
  font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }

.backdrop {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(10, 10, 10, 0.55);
  backdrop-filter: blur(2px);
}

.card {
  --paper: #fafaf7;
  --ink: #0a0a0a;
  --muted: #6b6b66;
  --faint: #85857f;
  --accent: #c81e1e;
  --exact: #1c7c4c;
  --probable: #a66a00;
  --line: #d9d9d2;
  --soft: #f1f1ec;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
  display: flex;
  flex-direction: column;
  width: min(600px, 100%);
  max-height: min(760px, 88vh);
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
  overflow: hidden;
}

@media (prefers-color-scheme: dark) {
  .card {
    --paper: #16161a;
    --ink: #f4f4f0;
    --muted: #a3a39c;
    --faint: #8a8a83;
    --line: #2f2f36;
    --soft: #1f1f25;
    --exact: #4cc38a;
    --probable: #e0a33a;
    --accent: #f0616d;
  }
}

header {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--line);
}
.mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  font-weight: 700;
  font-size: 16px;
  color: #fff;
  background: var(--accent);
  border-radius: 9px;
}
.title { flex: 1; min-width: 0; }
.title strong { display: block; font-size: 15px; font-weight: 600; }
.title span { display: block; font-size: 13px; color: var(--muted); }

.body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px; }

.scan { display: grid; gap: 12px; padding: 28px 20px 32px; text-align: center; }
.scan p { margin: 0; font-size: 14px; color: var(--muted); }
.scan .stage { font-size: 14px; font-weight: 500; color: var(--ink); }
.scan .meta { font-size: 12px; color: var(--faint); min-height: 1.2em; }
.scan .quiet { font-size: 12px; color: var(--faint); }
.scan .file { font-size: 15px; font-weight: 600; color: var(--ink); word-break: break-all; }
.bar { height: 4px; overflow: hidden; background: var(--soft); border-radius: 999px; }
.bar i { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width 180ms ease; }
.bar.indeterminate i { width: 35% !important; animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }

.file-block + .file-block { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--line); }
.file-head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.file-head b { font-size: 14px; font-weight: 600; word-break: break-all; }
.file-head em { flex: none; font-style: normal; font-size: 13px; color: var(--muted); }

.group { margin-top: 12px; }
.group > h4 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
}
.row:hover { background: var(--soft); }
.row input { flex: none; width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
.row .copy { flex: 1; min-width: 0; }
.row .value {
  display: block;
  overflow: hidden;
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.row .kind { display: block; font-size: 12px; color: var(--muted); }
.row code {
  flex: none;
  padding: 2px 6px;
  font: 500 11px/1.6 var(--mono);
  color: var(--muted);
  background: var(--soft);
  border-radius: 5px;
}
.row .count { flex: none; min-width: 26px; font-size: 12px; color: var(--faint); text-align: right; }
.row.probable .value { color: var(--probable); }
.row.exact .value { color: var(--exact); }

.note {
  margin-top: 14px;
  padding: 10px 12px;
  font-size: 13px;
  background: var(--soft);
  border-left: 3px solid var(--probable);
  border-radius: 0 8px 8px 0;
}
.note b { display: block; font-weight: 600; }
.note span { color: var(--muted); }

.empty { padding: 8px 0 4px; font-size: 14px; color: var(--muted); }

footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 14px 20px;
  border-top: 1px solid var(--line);
}
footer .spacer { flex: 1; }
button {
  padding: 9px 15px;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
}
button:hover { background: var(--soft); }
button.primary { color: #fff; background: var(--accent); border-color: var(--accent); }
button.primary:hover { filter: brightness(1.08); }
button.danger { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
button[disabled] { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.error { padding: 4px 0 8px; font-size: 14px; color: var(--accent); }
`;
