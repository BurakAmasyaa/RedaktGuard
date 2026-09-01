import { GUARDED_SITES } from "../hosts.js";
import { CMD, ENGINE_PORT, MSG } from "../protocol.js";
import { DEVICE_KEY, readSettings, writeSettings } from "../settings.js";

// Koruma/otomatik maskeleme alanları kurumsal politikadır ve arayüzden
// gevşetilemez. Yalnız modelin promptlarda da kullanılması performans tercihidir.
const TOGGLES = ["promptModelScan"];
const el = (id) => document.getElementById(id);

function paintRules(cache, serverConfigured = true) {
  const box = el("rulesStatus");
  if (!serverConfigured) {
    box.className = "status warn";
    box.textContent = "Kural sunucusu bağlı değil. Yerel maskeleme etkin; audit kayıtları sunucu bağlanana kadar güvenli kuyrukta bekler.";
    return;
  }
  const stamp = cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleString("tr-TR") : null;
  if (cache.status === "ready") {
    box.className = "status ok";
    box.textContent = `${cache.rules.length} kurumsal kural etkin${stamp ? ` · ${stamp}` : ""}. Karşılaştırma yalnızca bu cihazda yapılır.`;
  } else if (cache.status === "stale") {
    box.className = "status warn";
    box.textContent = cache.message || "Kurallar tazelenemedi, son bilinen kopya kullanılıyor.";
  } else {
    box.className = "status bad";
    box.textContent = cache.message || "Kurumsal kural listesi yüklenemedi.";
  }
}

async function load() {
  const settings = await readSettings();
  el("serverUrl").value = settings.serverUrl;
  el("profile").value = settings.profile;
  for (const key of TOGGLES) el(key).checked = settings[key];

  el("sites").replaceChildren(
    ...GUARDED_SITES.map((site) => {
      const item = document.createElement("li");
      item.textContent = site.label;
      return item;
    })
  );

  const manifest = chrome.runtime.getManifest();
  el("version").textContent = `${manifest.name} ${manifest.version}`;

  paintRules(await chrome.runtime.sendMessage({ type: MSG.readRules }), Boolean(settings.serverUrl));

  const stored = await chrome.storage.session.get(DEVICE_KEY);
  const device = stored?.[DEVICE_KEY];
  const box = el("deviceStatus");
  if (!device) {
    box.className = "status";
    box.textContent = "Tarama motoru henüz başlatılmadı. Korunan bir sayfa aç, sonra buraya dön.";
  } else if (device === "webgpu") {
    box.className = "status ok";
    box.textContent = "Kişi/kurum modeli WebGPU üzerinde çalışıyor — en hızlı yol (~7.400 karakter/sn).";
  } else {
    box.className = "status warn";
    box.textContent = `Model ${device} üzerinde çalışıyor. WebGPU bulunamadı; tarama belirgin biçimde yavaş olur.`;
  }
}

for (const key of TOGGLES) {
  el(key).addEventListener("change", () => writeSettings({ [key]: el(key).checked }));
}
el("profile").addEventListener("change", () => writeSettings({ profile: el("profile").value }));

el("connect").addEventListener("click", async () => {
  const button = el("connect");
  const raw = el("serverUrl").value.trim().replace(/\/+$/u, "");
  const box = el("rulesStatus");

  if (!raw) {
    await writeSettings({ serverUrl: "" });
    box.className = "status warn";
    box.textContent = "Kural sunucusu bağlı değil. Yerel maskeleme etkin; audit kayıtları sunucu bağlanana kadar güvenli kuyrukta bekler.";
    return;
  }

  let origin = null;
  try {
    origin = `${new URL(raw).origin}/*`;
  } catch {
    box.className = "status bad";
    box.textContent = "Adres geçerli bir URL değil. Örnek: https://redakt.sirket.local";
    return;
  }

  button.disabled = true;
  try {
    // İzin isteği kullanıcı hareketi gerektirir; bu yüzden tıklama içinde durur.
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      box.className = "status bad";
      box.textContent = "Bu adrese erişim izni verilmedi; kurallar okunamaz.";
      return;
    }
    await writeSettings({ serverUrl: raw });
    box.className = "status";
    box.textContent = "Kurallar okunuyor…";
    paintRules(await chrome.runtime.sendMessage({ type: MSG.refreshRules }), true);
  } finally {
    button.disabled = false;
  }
});

load();


// ---------------------------------------------------------------- sorun giderme

function renderTrace(trace) {
  const box = el("trace");
  if (!trace.length) {
    box.textContent = "İz yok. Bir dosya taramayı dene, sonra \"İzi yenile\".";
    return;
  }
  const first = new Date(trace[0].at).getTime();
  box.textContent = trace
    .map((entry) => {
      const offset = ((new Date(entry.at).getTime() - first) / 1000).toFixed(1);
      return `+${offset.padStart(5)}s  ${entry.step}${entry.detail ? " · " + entry.detail : ""}`;
    })
    .join("\n");
}

async function loadTrace() {
  const result = await chrome.runtime.sendMessage({ type: MSG.readTrace });
  renderTrace(result?.trace || []);
}

el("refreshTrace").addEventListener("click", () => loadTrace());

// Gerçek yolu baştan sona koşturur: motoru kurdurur, portu açar, küçük bir
// belge gönderir ve yanıtı bekler. İçerik betiğiyle aynı yoldan geçer.
el("selftest").addEventListener("click", async () => {
  const status = el("selftestStatus");
  const button = el("selftest");
  status.hidden = false;
  button.disabled = true;
  const started = performance.now();
  const since = () => `${((performance.now() - started) / 1000).toFixed(1)} sn`;

  const fail = (message) => {
    status.className = "status bad";
    status.textContent = `${message} (${since()})`;
  };

  try {
    status.className = "status";
    status.textContent = "Motor kurduruluyor…";
    const ack = await chrome.runtime.sendMessage({ type: MSG.ensureEngine });
    if (!ack?.ok) return fail("Motor kurulamadı.");

    status.textContent = "Port açılıyor…";
    const port = chrome.runtime.connect({ name: ENGINE_PORT });
    const id = `selftest_${Date.now()}`;
    const sample = new TextEncoder().encode("Ahmet Yılmaz · ahmet@siskon.com.tr · 10000000146\n");

    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "timeout" }), 60000);
      let ready = false;
      port.onMessage.addListener((message) => {
        if (message.cmd === CMD.ready) {
          ready = true;
          status.textContent = `Motor yanıt verdi, deneme belgesi gönderiliyor… (${since()})`;
          port.postMessage({ cmd: CMD.scanBegin, id, filename: "sinama.txt", size: sample.length, chunks: 1 });
          port.postMessage({ cmd: CMD.scanChunk, id, seq: 0, data: btoa(String.fromCharCode(...sample)) });
          port.postMessage({ cmd: CMD.scanEnd, id });
          return;
        }
        if (message.cmd === CMD.progress) {
          status.textContent = `Taranıyor: ${message.phase} (${since()})`;
          return;
        }
        if (message.cmd === CMD.scanResult) {
          clearTimeout(timer);
          resolve({ kind: "ok", findings: message.findings?.length ?? 0 });
        } else if (message.cmd === CMD.failure) {
          clearTimeout(timer);
          resolve({ kind: "failure", message: message.message });
        }
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        resolve({ kind: ready ? "disconnected" : "no-receiver" });
      });
    });

    port.disconnect();

    if (outcome.kind === "ok") {
      status.className = "status ok";
      status.textContent = `Motor çalışıyor · ${outcome.findings} bulgu · ${since()}`;
    } else if (outcome.kind === "no-receiver") {
      fail("Port açıldı ama motor hiç yanıt vermedi (offscreen belge dinlemiyor).");
    } else if (outcome.kind === "disconnected") {
      fail("Motor bağlantısı taramanın ortasında koptu.");
    } else if (outcome.kind === "failure") {
      fail(`Motor hata verdi: ${outcome.message}`);
    } else {
      fail("Motor 60 saniyede yanıt vermedi.");
    }
  } catch (error) {
    fail(`Sınama başarısız: ${error?.message || error}`);
  } finally {
    button.disabled = false;
    await loadTrace();
  }
});

loadTrace();
