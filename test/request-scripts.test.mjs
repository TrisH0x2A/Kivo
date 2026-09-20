import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { resolveObjectURL } from "node:buffer";
import { createServer } from "vite";

let server;
let runRequestScript;
const originalWorker = globalThis.Worker;
let terminated = 0;

// Execute the browser worker in a real thread, adapting only blob-module loading for Node.
class BrowserWorker {
  constructor(url) {
    this.ready = resolveObjectURL(url).text().then((source) => {
      source = source.replace("import(moduleUrl)", "import('data:text/javascript;base64,' + Buffer.from(await require('node:buffer').resolveObjectURL(moduleUrl).text()).toString('base64'))");
      this.worker = new NodeWorker(`
        const { parentPort } = require('node:worker_threads');
        const self = { postMessage: (data) => parentPort.postMessage(data) };
        ${source}
        parentPort.on('message', (data) => self.onmessage({ data }));
      `, { eval: true });
      this.worker.on("message", (data) => this.onmessage?.({ data }));
      this.worker.on("error", (error) => this.onerror?.(error));
    });
  }
  postMessage(data) {
    const clone = structuredClone(data);
    this.ready.then(() => this.worker.postMessage(clone));
  }
  terminate() { terminated++; this.ready.then(() => this.worker.terminate()); }
}

before(async () => {
  server = await createServer({ cacheDir: "node_modules/.vite-script-tests", optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ runRequestScript } = await server.ssrLoadModule("/src/lib/request-scripts.js"));
  globalThis.Worker = BrowserWorker;
});
after(async () => { globalThis.Worker = originalWorker; await server?.close(); });

test("pre-request scripts cross the worker boundary and modify requests", async () => {
  const result = await runRequestScript({ phase: "pre-request", script: 'kivo.request.addHeader("X-Test", "yes"); kivo.vars.set("token", "abc");', request: { url: "https://example.com" } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.request.headers[0].value, "yes");
  assert.equal(result.context.vars.token, "abc");
});

test("after-response scripts parse JSON and report assertions", async () => {
  const result = await runRequestScript({ phase: "after-response", response: { status: 200, rawBody: '{"message":"success"}' }, script: 'await kivo.test("body", () => kivo.expect(kivo.response.json().message).toBe("success")); await kivo.test("failure", () => kivo.expect(kivo.response.status).toBe(404));' });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.tests.map((entry) => entry.ok), [true, false]);
});

test("synchronous transfer failures terminate workers immediately", async () => {
  const before = terminated;
  const result = await runRequestScript({ script: 'kivo.log("hello");', context: { vars: { invalid() {} } } });
  assert.equal(result.ok, false);
  assert.match(result.error, /cloned/);
  assert.equal(terminated, before + 1);
});

test("unsafe eval remains rejected before execution", async () => {
  const result = await runRequestScript({ script: 'eval("1")' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Blocked unsafe script token: eval/);
});
