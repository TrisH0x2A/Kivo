const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "QUERY", "PUT", "DELETE"]);
const TRANSIENT = new Set([408, 429, 502, 503, 504]);

export function resolveRunVariables(request, variables) {
  function visit(value) {
    if (typeof value === "string") return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) => {
      key = key.trim();
      return !UNSAFE_KEYS.has(key) && Object.hasOwn(variables, key) ? String(variables[key] ?? "") : match;
    });
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key)).map(([key, entry]) => [key, visit(entry)]));
    return value;
  }
  return visit(request);
}

export function extractRunVariables(body, rules) {
  const values = {};
  if (!rules.length) return values;
  const parsed = JSON.parse(body);
  for (const rule of rules) {
    const name = String(rule.variable || "").trim();
    if (!name || UNSAFE_KEYS.has(name)) throw new Error("Invalid extraction variable name");
    const pointer = String(rule.pointer || "");
    if (pointer && (!pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer))) throw new Error(`Invalid JSON pointer: ${pointer}`);
    const parts = pointer ? pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~")) : [];
    let value = parsed;
    for (const part of parts) {
      value = value && typeof value === "object" && !UNSAFE_KEYS.has(part) && Object.hasOwn(value, part) ? value[part] : undefined;
    }
    if (value === undefined) throw new Error(`Extraction ${name}: ${pointer} was not found`);
    values[name] = value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  }
  return values;
}

export function inheritRunRequest(request, collection, config) {
  const parts = String(request.folderPath || "").split("/").filter(Boolean);
  const settings = parts.map((_, index) => (collection.folderSettings || []).find((entry) => entry.path === parts.slice(0, index + 1).join("/"))).filter(Boolean);
  const disabled = new Set((request.headers || []).filter((row) => row.enabled === false).map((row) => String(row.key).toLowerCase()));
  const inherited = [...(request.inheritHeaders ? config.defaultHeaders || [] : []), ...settings.flatMap((setting) => setting.defaultHeaders || [])];
  const headers = [...inherited.filter((row) => !disabled.has(String(row.key).toLowerCase())), ...(request.headers || [])];
  let auth = request.auth;
  if (auth?.type === "inherit") auth = [...settings].reverse().find((setting) => setting.defaultAuth?.type && setting.defaultAuth.type !== "inherit")?.defaultAuth || config.defaultAuth || { type: "none" };
  return { ...request, headers, auth, inheritHeaders: false };
}

export async function interruptibleDelay(ms, stopped, sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))) {
  for (let remaining = ms; remaining > 0 && !stopped(); remaining -= 50) await sleep(Math.min(50, remaining));
}

export async function executeWorkflowStep({ request, context, data = {}, rules = [], retries = 0, allowUnsafeRetries = false, stopped, send, script, prepare = async (request) => request, sleep }) {
  const maxRetries = Math.min(10, Math.max(0, Number(retries) || 0));
  const retryAllowed = SAFE_METHODS.has(String(request.method || "GET").toUpperCase()) && request.requestMode !== "graphql" || allowUnsafeRetries;
  let attempts = 0;
  let lastError = "";
  while (attempts <= maxRetries && !stopped()) {
    attempts++;
    let stage = "prepare";
    let retryable = false;
    let response;
    let tests = [];
    try {
      let draftContext = { vars: { ...context.vars, ...data } };
      let draft = resolveRunVariables(request, draftContext.vars);
      if (draft.scriptPreRequest?.trim()) {
        const pre = await script({ phase: "pre-request", script: draft.scriptPreRequest, request: draft, response: null, context: draftContext });
        if (!pre.ok) throw new Error(pre.error || "Pre-request script failed");
        draftContext = pre.context || draftContext;
        draft = resolveRunVariables(pre.request || draft, draftContext.vars);
      }
      if (stopped()) break;
      draft = await prepare(draft);
      if (stopped()) break;
      stage = "transport";
      response = await send(draft);
      stage = "response";
      if (stopped()) break;
      retryable = TRANSIENT.has(response.status);
      if (retryable && retryAllowed && attempts <= maxRetries) throw new Error(`HTTP ${response.status}`);
      if (draft.scriptAfterResponse?.trim()) {
        const post = await script({ phase: "after-response", script: draft.scriptAfterResponse, request: draft, response, context: draftContext });
        tests = post.tests || [];
        if (!post.ok) throw new Error(post.error || "After-response script failed");
        draftContext = post.context || draftContext;
      }
      const passed = response.status >= 200 && response.status < 400 && tests.every((test) => test.ok);
      if (passed) {
        Object.assign(draftContext.vars, extractRunVariables(response.rawBody ?? response.body, rules));
        context.vars = draftContext.vars;
      }
      return { status: passed ? "passed" : "failed", attempts, statusCode: response.status, duration: response.duration, tests, error: tests.filter((test) => !test.ok).map((test) => `${test.name}: ${test.error || "failed"}`).join("\n") || (passed ? "" : `HTTP ${response.status}`) };
    } catch (error) {
      lastError = error?.message || String(error);
      if (stopped()) break;
      if (!retryAllowed || attempts > maxRetries || !(stage === "transport" || retryable)) return { status: "failed", attempts, statusCode: response?.status || 0, duration: response?.duration || "-", tests, error: lastError };
      await interruptibleDelay(Math.min(5000, 250 * 2 ** (attempts - 1)), stopped, sleep);
    }
  }
  return { status: "cancelled", attempts, statusCode: 0, tests: [], duration: "-", error: "Run stopped" };
}
