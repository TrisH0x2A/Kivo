export const FORBIDDEN_SCRIPT_TOKENS = [
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
  "process",
  "require",
  "module",
  "import",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "Worker",
  "SharedWorker",
  "importScripts",
  "eval",
  "Function",
  "constructor",
  "__proto__",
  "prototype",
];

export function validateScriptSource(source) {
  for (const token of FORBIDDEN_SCRIPT_TOKENS) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_$]|$)`);
    if (pattern.test(source)) {
      return `Blocked unsafe script token: ${token}`;
    }
  }
  return "";
}
