import { normalizeComparisonRules, pointerSegments } from "./comparison-rules.js";

function displayValue(value) {
  if (value === undefined) return "<missing>";
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    return String(value);
  }
}

function matches(rule, segments) {
  return rule.length === segments.length && rule.every((part, index) => part === "*" || part === String(segments[index]));
}

function keyedArray(array, key, path) {
  const indexed = new Map();
  for (const item of array) {
    const value = item && typeof item === "object" && Object.hasOwn(item, key) ? item[key] : undefined;
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`Array ${path}: every item needs a scalar ${key} key.`);
    const identity = JSON.stringify([typeof value, value]);
    if (indexed.has(identity)) throw new Error(`Array ${path}: duplicate ${key} key ${displayValue(value)}.`);
    indexed.set(identity, item);
  }
  return indexed;
}

function walkJson(left, right, context, segments = [], path = "$") {
  if (context.entries.length > 80) return;
  if (++context.visited > 200_000 || segments.length > 100) throw new Error("Comparison exceeds the 200,000-node or 100-level limit.");
  if (context.ignore.some((rule) => matches(rule, segments)) || Object.is(left, right)) return;
  if (typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)) {
    const tolerance = Math.max(context.rules.absoluteTolerance, context.rules.relativeTolerance * Math.max(Math.abs(left), Math.abs(right)));
    if (Math.abs(left - right) <= tolerance) return;
  }
  const leftObject = left && typeof left === "object";
  const rightObject = right && typeof right === "object";
  if (leftObject && rightObject && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (context.entries.length > 80) break;
      walkJson(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined, context, [...segments, key], /^[a-z_$][\w$]*$/i.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
    }
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const rule = context.arrays.find((entry) => matches(entry.segments, segments));
    if (rule) {
      const a = keyedArray(left, rule.key, path);
      const b = keyedArray(right, rule.key, path);
      for (const identity of new Set([...a.keys(), ...b.keys()])) {
        if (context.entries.length > 80) break;
        walkJson(a.get(identity), b.get(identity), context, [...segments, "*"], `${path}[${rule.key}=${JSON.stringify(JSON.parse(identity)[1])}]`);
      }
    } else {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length && context.entries.length <= 80; index += 1) {
        walkJson(left[index], right[index], context, [...segments, index], `${path}[${index}]`);
      }
    }
    return;
  }
  context.entries.push({ path, left: displayValue(left), right: displayValue(right) });
}

export function compareResponseBodies(leftBody, rightBody, options = {}) {
  const leftText = String(leftBody ?? "");
  const rightText = String(rightBody ?? "");
  if (leftText.length > 8_000_000 || rightText.length > 8_000_000) throw new Error("Semantic comparison supports responses up to 8 MB each.");
  const rules = normalizeComparisonRules(options);
  let left, right;
  try {
    left = JSON.parse(leftText);
    right = JSON.parse(rightText);
  } catch {
    return {
      mode: "text",
      changed: leftText !== rightText,
      entries: leftText === rightText ? [] : [{ path: "body", left: displayValue(leftText), right: displayValue(rightText) }],
      truncated: false,
    };
  }
  const context = { rules, ignore: rules.ignorePaths.map(pointerSegments), arrays: rules.arrayKeys.map((entry) => ({ ...entry, segments: pointerSegments(entry.path) })), entries: [], visited: 0 };
  walkJson(left, right, context);
  return { mode: "json", changed: context.entries.length > 0, entries: context.entries.slice(0, 80), truncated: context.entries.length > 80 };
}

export function compareResponseHeaders(left = {}, right = {}, ignored = []) {
  const ignore = new Set(ignored.map((key) => key.toLowerCase()));
  const normalize = (headers) => {
    const values = new Map();
    for (const [key, value] of Object.entries(headers)) {
      const name = key.toLowerCase();
      if (!ignore.has(name)) values.set(name, [...(values.get(name) || []), ...(Array.isArray(value) ? value : [String(value)])]);
    }
    return values;
  };
  const a = normalize(left), b = normalize(right);
  const entries = [...new Set([...a.keys(), ...b.keys()])].sort().filter((key) => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
    .map((key) => ({ path: key, left: displayValue(a.get(key)), right: displayValue(b.get(key)) }));
  return { changed: entries.length > 0, entries: entries.slice(0, 80), truncated: entries.length > 80 };
}

export function compareResponses(left, right, options = {}) {
  if (left?.error || right?.error) throw new Error("Both requests must complete before their responses can be compared.");
  const rules = normalizeComparisonRules(options);
  return {
    statusChanged: Number(left?.status || 0) !== Number(right?.status || 0),
    durationChanged: Number(left?.durationMs || 0) !== Number(right?.durationMs || 0),
    body: left?.isBinary || right?.isBinary
      ? { mode: "binary", changed: left?.bodyBase64 !== right?.bodyBase64, entries: [], truncated: false }
      : compareResponseBodies(left?.rawBody ?? left?.body ?? "", right?.rawBody ?? right?.body ?? "", rules),
    headers: rules.compareHeaders ? compareResponseHeaders(left?.headers, right?.headers, rules.ignoreHeaders) : null,
  };
}
