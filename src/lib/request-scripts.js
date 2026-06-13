import { validateScriptSource } from "@/lib/script-sandbox.js";

const SCRIPT_TIMEOUT_MS = 5000;
const MAX_WAIT_MS = 30000;

function stringifyLogPart(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeScriptVars(vars) {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    return {};
  }

  return Object.entries(vars).reduce((accumulator, [key, value]) => {
    accumulator[String(key)] = value;
    return accumulator;
  }, {});
}

function cloneRows(rows = []) {
  return Array.isArray(rows)
    ? rows.map((row) => ({
      key: String(row?.key ?? ""),
      value: String(row?.value ?? ""),
      enabled: row?.enabled ?? true,
    }))
    : [];
}

function cloneRequestForScript(request = {}) {
  return {
    ...request,
    method: String(request?.method ?? "GET"),
    url: String(request?.url ?? ""),
    body: typeof request?.body === "string" ? request.body : String(request?.body ?? ""),
    graphqlVariables: typeof request?.graphqlVariables === "string"
      ? request.graphqlVariables
      : JSON.stringify(request?.graphqlVariables ?? {}, null, 2),
    queryParams: cloneRows(request?.queryParams),
    headers: cloneRows(request?.headers),
  };
}

function upsertRow(rows, key, value, enabled = true) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) return;
  const nextValue = String(value ?? "");
  const existingIndex = rows.findIndex((row) => String(row?.key || "").toLowerCase() === normalizedKey.toLowerCase());
  if (existingIndex >= 0) {
    rows[existingIndex] = { ...rows[existingIndex], key: normalizedKey, value: nextValue, enabled: Boolean(enabled) };
    return;
  }
  rows.push({ key: normalizedKey, value: nextValue, enabled: Boolean(enabled) });
}

function removeRowsByKey(rows, key) {
  const normalizedKey = String(key ?? "").trim().toLowerCase();
  if (!normalizedKey) return;
  let index = rows.length - 1;
  while (index >= 0) {
    if (String(rows[index]?.key || "").trim().toLowerCase() === normalizedKey) {
      rows.splice(index, 1);
    }
    index -= 1;
  }
}

function createExpect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
      }
    },
    toEqual(expected) {
      const left = JSON.stringify(actual);
      const right = JSON.stringify(expected);
      if (left !== right) {
        throw new Error(`Expected ${left} to equal ${right}`);
      }
    },
    toContain(expected) {
      if (typeof actual === "string" && actual.includes(String(expected))) {
        return;
      }
      if (Array.isArray(actual) && actual.includes(expected)) {
        return;
      }
      throw new Error(`Expected value to contain ${JSON.stringify(expected)}`);
    },
    toBeTruthy() {
      if (!actual) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be truthy`);
      }
    },
    toHaveProperty(key) {
      if (!actual || typeof actual !== "object" || !(key in actual)) {
        throw new Error(`Expected object to have property ${String(key)}`);
      }
    },
  };
}

function canUseWorkerSandbox() {
  return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined";
}

function buildWorkerSource() {
  return `
const MAX_WAIT_MS = ${MAX_WAIT_MS};
function stringifyLogPart(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
}
function upsertRow(rows, key, value, enabled = true) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) return;
  const nextValue = String(value ?? "");
  const existingIndex = rows.findIndex((row) => String(row?.key || "").toLowerCase() === normalizedKey.toLowerCase());
  if (existingIndex >= 0) {
    rows[existingIndex] = { ...rows[existingIndex], key: normalizedKey, value: nextValue, enabled: Boolean(enabled) };
    return;
  }
  rows.push({ key: normalizedKey, value: nextValue, enabled: Boolean(enabled) });
}
function removeRowsByKey(rows, key) {
  const normalizedKey = String(key ?? "").trim().toLowerCase();
  if (!normalizedKey) return;
  let index = rows.length - 1;
  while (index >= 0) {
    if (String(rows[index]?.key || "").trim().toLowerCase() === normalizedKey) rows.splice(index, 1);
    index -= 1;
  }
}
function createExpect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(\`Expected \${JSON.stringify(actual)} to be \${JSON.stringify(expected)}\`);
    },
    toEqual(expected) {
      const left = JSON.stringify(actual);
      const right = JSON.stringify(expected);
      if (left !== right) throw new Error(\`Expected \${left} to equal \${right}\`);
    },
    toContain(expected) {
      if (typeof actual === "string" && actual.includes(String(expected))) return;
      if (Array.isArray(actual) && actual.includes(expected)) return;
      throw new Error(\`Expected value to contain \${JSON.stringify(expected)}\`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(\`Expected \${JSON.stringify(actual)} to be truthy\`);
    },
    toHaveProperty(key) {
      if (!actual || typeof actual !== "object" || !(key in actual)) throw new Error(\`Expected object to have property \${String(key)}\`);
    },
  };
}
self.onmessage = async (event) => {
  const { source, phase, requestDraft, response, vars } = event.data || {};
  const logs = [];
  const tests = [];
  const varsStore = new Map(Object.entries(vars || {}));
  const requestApi = {
    get method() { return requestDraft.method; },
    set method(value) { requestDraft.method = String(value ?? "GET").toUpperCase(); },
    get url() { return requestDraft.url; },
    set url(value) { requestDraft.url = String(value ?? ""); },
    get body() { return requestDraft.body; },
    set body(value) { requestDraft.body = String(value ?? ""); },
    get graphqlVariables() { return requestDraft.graphqlVariables; },
    set graphqlVariables(value) { requestDraft.graphqlVariables = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2); },
    addQueryParam(key, value, enabled = true) { upsertRow(requestDraft.queryParams, key, value, enabled); },
    removeQueryParam(key) { removeRowsByKey(requestDraft.queryParams, key); },
    addHeader(key, value, enabled = true) { upsertRow(requestDraft.headers, key, value, enabled); },
    removeHeader(key) { removeRowsByKey(requestDraft.headers, key); },
    setBody(value) { requestDraft.body = String(value ?? ""); },
    setGraphqlVariables(value) { requestDraft.graphqlVariables = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2); },
    setMethod(value) { requestDraft.method = String(value ?? "GET").toUpperCase(); },
    setUrl(value) { requestDraft.url = String(value ?? ""); },
  };
  const responseApi = {
    status: Number(response?.status ?? 0),
    statusText: String(response?.statusText ?? ""),
    headers: response?.headers && typeof response.headers === "object" ? response.headers : {},
    body: String(response?.rawBody ?? response?.body ?? ""),
    json() {
      const text = String(response?.rawBody ?? response?.body ?? "").trim();
      if (!text) return null;
      return JSON.parse(text);
    },
  };
  const kivo = {
    execution: { location: phase, phase },
    request: requestApi,
    response: responseApi,
    vars: {
      get(key) { return varsStore.get(String(key)); },
      set(key, value) { varsStore.set(String(key), value); },
      unset(key) { varsStore.delete(String(key)); },
      has(key) { return varsStore.has(String(key)); },
      all() { return Object.fromEntries(varsStore.entries()); },
    },
    expect: createExpect,
    assert(condition, message = "Assertion failed") {
      if (!condition) throw new Error(String(message));
    },
    async test(name, fn) {
      const label = String(name || "Unnamed test");
      try {
        await fn();
        tests.push({ name: label, ok: true });
      } catch (error) {
        tests.push({ name: label, ok: false, error: error?.message || String(error) });
      }
    },
    log(...parts) { logs.push(parts.map(stringifyLogPart).join(" ")); },
    wait(ms) {
      const timeout = Number(ms);
      const delay = Math.min(Number.isFinite(timeout) && timeout > 0 ? timeout : 0, MAX_WAIT_MS);
      return new Promise((resolve) => setTimeout(resolve, delay));
    },
  };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction(
      "kivo",
      "window",
      "document",
      "globalThis",
      "self",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "caches",
      "navigator",
      "location",
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "Worker",
      "SharedWorker",
      "importScripts",
      "eval",
      "Function",
      \`"use strict";\\n\${source}\`
    );
    await execute(kivo);
    self.postMessage({ ok: true, request: requestDraft, logs, tests, vars: Object.fromEntries(varsStore.entries()), error: "" });
  } catch (error) {
    self.postMessage({ ok: false, request: requestDraft, logs, tests, vars: Object.fromEntries(varsStore.entries()), error: error?.message || String(error) });
  }
};
`;
}

function runScriptInWorker({ source, phase, requestDraft, responseApi, vars }) {
  return new Promise((resolve) => {
    const blob = new Blob([buildWorkerSource()], { type: "text/javascript" });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      resolve(result);
    };
    const timeoutId = setTimeout(() => {
      finish({
        ok: false,
        request: requestDraft,
        logs: [],
        tests: [],
        vars,
        error: `Script timed out after ${SCRIPT_TIMEOUT_MS} ms.`,
      });
    }, SCRIPT_TIMEOUT_MS);
    worker.onmessage = (event) => finish(event.data);
    worker.onerror = (event) => finish({
      ok: false,
      request: requestDraft,
      logs: [],
      tests: [],
      vars,
      error: event?.message || "Script worker failed.",
    });
    worker.postMessage({ source, phase, requestDraft, response: responseApi, vars });
  });
}

export async function runRequestScript({
  phase,
  script,
  request,
  response,
  context,
}) {
  const source = String(script ?? "").trim();
  const requestDraft = cloneRequestForScript(request);
  const logs = [];
  const tests = [];
  const varsStore = new Map(Object.entries(normalizeScriptVars(context?.vars)));

  if (!source) {
    return {
      ok: true,
      request: requestDraft,
      logs,
      tests,
      context: {
        vars: Object.fromEntries(varsStore.entries()),
      },
      error: "",
    };
  }

  const validationError = validateScriptSource(source);
  if (validationError) {
    return {
      ok: false,
      request: requestDraft,
      logs,
      tests,
      context: {
        vars: Object.fromEntries(varsStore.entries()),
      },
      error: validationError,
    };
  }

  const responseApi = {
    status: Number(response?.status ?? 0),
    statusText: String(response?.statusText ?? ""),
    headers: response?.headers && typeof response.headers === "object" ? response.headers : {},
    body: String(response?.rawBody ?? response?.body ?? ""),
    json() {
      const text = String(response?.rawBody ?? response?.body ?? "").trim();
      if (!text) return null;
      return JSON.parse(text);
    },
  };

  try {
    if (!canUseWorkerSandbox()) {
      throw new Error("Secure script workers are unavailable. Script execution was blocked.");
    }

    const workerResult = await runScriptInWorker({
      source,
      phase,
      requestDraft,
      responseApi,
      vars: Object.fromEntries(varsStore.entries()),
    });
    return {
      ok: Boolean(workerResult?.ok),
      request: workerResult?.request || requestDraft,
      logs: Array.isArray(workerResult?.logs) ? workerResult.logs : [],
      tests: Array.isArray(workerResult?.tests) ? workerResult.tests : [],
      context: {
        vars: workerResult?.vars && typeof workerResult.vars === "object" ? workerResult.vars : Object.fromEntries(varsStore.entries()),
      },
      error: String(workerResult?.error || ""),
    };
  } catch (error) {
    return {
      ok: false,
      request: requestDraft,
      logs,
      tests,
      context: {
        vars: Object.fromEntries(varsStore.entries()),
      },
      error: error?.message || String(error),
    };
  }
}
