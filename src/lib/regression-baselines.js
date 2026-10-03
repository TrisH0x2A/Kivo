import { compareResponses } from "./response-diff.js";

const MAX_BASELINES = 20;

export function buildRegressionBaseline(response, name, id = "") {
  const label = String(name || "").trim();
  if (!label || label.length > 80) throw new Error("Baseline names must be 1 to 80 characters.");
  if (!response || Number(response.status) <= 0 || response.badge === "Failed") throw new Error("A completed response is required.");
  const body = response.isBinary ? "" : String(response.rawBody ?? response.body ?? "");
  if (body.length > 1_000_000) throw new Error("Baseline responses are limited to 1 MB.");
  return { id: id || crypto.randomUUID(), name: label, capturedAt: new Date().toISOString(), response: {
    status: Number(response.status), statusText: String(response.statusText || ""), headers: structuredClone(response.headers || {}),
    body, rawBody: body, isBinary: Boolean(response.isBinary), bodyBase64: String(response.bodyBase64 || ""), contentType: String(response.contentType || ""),
  } };
}

export function upsertRegressionBaseline(baselines, baseline) {
  const current = Array.isArray(baselines) ? baselines : [];
  if (!current.some((entry) => entry.id === baseline.id) && current.length >= MAX_BASELINES) throw new Error("A request can have at most 20 baselines.");
  if (current.some((entry) => entry.id !== baseline.id && entry.name.toLowerCase() === baseline.name.toLowerCase())) throw new Error("A baseline with this name already exists.");
  return [...current.filter((entry) => entry.id !== baseline.id), baseline];
}

export function compareRegressionBaseline(baseline, response) {
  if (!baseline?.response) throw new Error("Select a baseline first.");
  return compareResponses(baseline.response, response);
}
