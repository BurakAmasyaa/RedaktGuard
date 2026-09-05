import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// Gerçek ner.js ve ner-client.js kodlarını ayrı worker bağlamlarında yürütür.
// Sadece tarayıcı Worker taşıması ve ağır ONNX pipeline bağımlılığı değiştirilir;
// runtime ayarı, hata yayılımı, worker yenileme ve retry kararı üretim kodudur.
const nerSource = await fs.readFile(new URL("../src/ner.js", import.meta.url), "utf8");
const clientSource = await fs.readFile(new URL("../src/ner-client.js", import.meta.url), "utf8");
function executable(source) {
  return source.replace(/^import .*;$/gmu, "")
    .replace(/\bexport /gu, "")
    .replace(/import\.meta/gu, "({env: {}, url: 'https://extension.test/assets/ner.js'})");
}

function harness({ gpu = false, fail = ({ threads }) => threads > 1, hold = false } = {}) {
  const attempts = [];
  const workers = [];
  class WorkerMock {
    constructor() {
      this.listeners = new Map();
      this.terminated = false;
      this.id = workers.length;
      workers.push(this);
      const env = { backends: { onnx: { wasm: {} } } };
      this.scope = vm.createContext({
        URL, DOMException, WorkerGlobalScope: function () {},
        location: { origin: "https://extension.test" },
        navigator: { hardwareConcurrency: 8, ...(gpu ? { gpu: { requestAdapter: async () => ({}) } } : {}) },
        crossOriginIsolated: true, env,
        ortCpuModuleUrl: "/cpu.mjs", ortCpuWasmUrl: "/cpu.wasm",
        ortWebGpuModuleUrl: "/gpu.mjs", ortWebGpuWasmUrl: "/gpu.wasm",
        createModelDownloadAggregator: () => ({ update() {}, complete: () => ({}) }),
        pipeline: async (_task, _model, options) => {
          const attempt = { worker: this.id, device: options.device, threads: env.backends.onnx.wasm.numThreads,
            wasm: env.backends.onnx.wasm.wasmPaths.wasm };
          attempts.push(attempt);
          if (hold) await new Promise(() => {});
          if (fail(attempt)) throw new Error("Simulated runtime startup failure");
          return async () => [];
        },
      });
      vm.runInContext(executable(nerSource) + "\nglobalThis.api = { configureNerRuntime, preloadNerModel };", this.scope);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    terminate() { this.terminated = true; }
    postMessage(message) {
      if (message.type === "cancel") return;
      this.scope.api.configureNerRuntime(message);
      this.scope.api.preloadNerModel().then(
        (device) => this.reply({ requestId: message.requestId, type: "complete", device, findings: [] }),
        (error) => this.reply({ requestId: message.requestId, type: "error", name: error.name, message: error.message })
      );
    }
    reply(data) { if (!this.terminated) this.listeners.get("message")?.({ data }); }
  }
  const scope = vm.createContext({ URL, DOMException, Worker: WorkerMock, document: { baseURI: "https://extension.test/offscreen.html" } });
  vm.runInContext(executable(clientSource) + "\nglobalThis.api = { warmUpNerWorker, detectNamedEntitiesInWorker, releaseNerWorker };", scope);
  return { attempts, workers, api: scope.api };
}

test("WASM worker başlatılamazsa yeni worker'da 8 → 1; sonraki istekte 1 korunur", async () => {
  const { attempts, workers, api } = harness();
  await api.warmUpNerWorker();
  await api.warmUpNerWorker();
  assert.deepEqual(attempts.map(({ threads }) => threads), [8, 1]);
  assert.deepEqual(attempts.map(({ worker }) => worker), [0, 1]);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(attempts[1].wasm, "https://extension.test/cpu.wasm");
  api.releaseNerWorker();
});

test("WebGPU başarısızsa yeni worker'da saf CPU/WASM ve bir iş parçacığı seçilir", async () => {
  const { attempts, api } = harness({ gpu: true, fail: ({ device }) => device === "webgpu" });
  await api.warmUpNerWorker();
  assert.deepEqual(attempts.map(({ device, threads }) => [device, threads]), [["webgpu", 1], ["wasm", 1]]);
  assert.notEqual(attempts[0].worker, attempts[1].worker);
  api.releaseNerWorker();
});

test("güvenli mod GPU'yu atlar; başarısız olursa sonsuz yeniden deneme yapmaz", async () => {
  const { attempts, api } = harness({ gpu: true, fail: () => true });
  await assert.rejects(api.warmUpNerWorker({ preferDevice: "wasm" }), /startup failure/u);
  assert.deepEqual(attempts.map(({ device, threads }) => [device, threads]), [["wasm", 1]]);
});

test("iki runtime da bozuksa hata döner ve deneme sayısı ikiyle sınırlıdır", async () => {
  const { attempts, workers, api } = harness({ fail: () => true });
  await assert.rejects(api.warmUpNerWorker(), /startup failure/u);
  assert.deepEqual(attempts.map(({ threads }) => threads), [8, 1]);
  assert.ok(workers.every((worker) => worker.terminated));
});

test("kullanıcının iptali CPU kurtarma denemesi başlatmaz", async () => {
  const { workers, api } = harness({ hold: true });
  const controller = new AbortController();
  const pending = api.detectNamedEntitiesInWorker(["Sentetik"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(workers.length, 1);
  api.releaseNerWorker();
});
