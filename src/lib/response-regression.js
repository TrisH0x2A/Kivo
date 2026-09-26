import { FORBIDDEN_SCRIPT_TOKENS, validateScriptSource } from "./script-sandbox.js";

const sensitive = /authorization|cookie|token|secret|password|credential|api[-_]?key/i;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

// Quoted data must not trigger the sandbox's conservative token filter.
function literal(value) {
  let source = JSON.stringify(value);
  if (typeof value !== "string") return source;
  for (const token of FORBIDDEN_SCRIPT_TOKENS) {
    source = source.replace(new RegExp(`\\b${token}\\b`, "g"), (match) => `\\u${match.charCodeAt(0).toString(16).padStart(4, "0")}${match.slice(1)}`);
  }
  return source;
}

export function getRegressionFields(response) {
  const body = String(response?.rawBody ?? response?.body ?? "");
  if (response?.isBinary || body.length > 1_000_000) return [];
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const fields = [];
  function visit(value, path) {
    if (fields.length >= 50 || path.length > 8) return;
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    fields.push({ id: JSON.stringify(path), path, label: path.length ? path.map((part) => `[${JSON.stringify(part)}]`).join("") : "$", type, value, sensitive: path.some((part) => sensitive.test(part)) });
    if (type === "array" && value.length) visit(value[0], [...path, 0]);
    else if (type === "object") {
      for (const key of Object.keys(value)) {
        if (fields.length >= 50) break;
        if (!unsafeKeys.has(key)) visit(value[key], [...path, key]);
      }
    }
  }
  visit(data, []);
  return fields;
}

export function buildRegressionScript(response, { status = true, contentType = true, fields = [] } = {}) {
  if (!(Number(response?.status) > 0) || response?.badge === "Failed") throw new Error("A completed response is required.");
  const blocks = [];
  function add(name, lines) {
    blocks.push(`await kivo.test(${literal(name)}, () => {\n${lines.map((line) => `  ${line}`).join("\n")}\n});`);
  }
  if (status) add(`Status is ${Number(response.status)}`, [`kivo.expect(kivo.response.status).toBe(${Number(response.status)});`]);
  const type = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === "content-type")?.[1]?.split(";")[0].trim().toLowerCase();
  if (contentType && type) add("Content type matches", [
    'const header = Object.entries(kivo.response.headers).find(([key]) => key.toLowerCase() === "content-type");',
    `kivo.expect(String(header?.[1] || "").split(";")[0].trim().toLowerCase()).toBe(${literal(type)});`,
  ]);
  const available = getRegressionFields(response);
  for (const selection of fields) {
    const field = available.find(({ id }) => id === selection.id);
    if (!field) throw new Error("The selected response field is no longer available.");
    const path = `[${field.path.map(literal).join(", ")}]`;
    const lines = [
      `const value = ${path}.reduce((current, key) => current != null && Object.hasOwn(current, key) ? current[key] : undefined, kivo.response.json());`,
    ];
    if (selection.mode === "value") {
      if (field.sensitive || ["object", "array"].includes(field.type)) throw new Error("Exact values are only available for non-sensitive scalar fields.");
      lines.push(`kivo.expect(value).toBe(${literal(field.value)});`);
    } else if (selection.mode === "range") {
      const min = Number(selection.min), max = Number(selection.max);
      if (field.type !== "number" || String(selection.min ?? "").trim() === "" || String(selection.max ?? "").trim() === "" || !Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error("Enter a valid minimum and maximum for each numeric range.");
      lines.push(`kivo.assert(typeof value === "number" && value >= ${min} && value <= ${max}, "Number is outside the expected range");`);
    } else {
      lines.push('const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;', `kivo.expect(type).toBe(${literal(field.type)});`);
    }
    add(`${field.label} ${selection.mode || "type"}`, lines);
  }
  return blocks.join("\n\n");
}

export function appendRegressionScript(existing, generated) {
  if (!generated.trim()) throw new Error("Select at least one assertion.");
  const combined = existing?.trim() ? `${existing}\n\n${generated}` : generated;
  const error = validateScriptSource(combined);
  if (error) throw new Error(error);
  return combined;
}
