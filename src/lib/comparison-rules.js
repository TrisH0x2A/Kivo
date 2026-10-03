export const DEFAULT_COMPARISON_RULES = {
  ignorePaths: [], arrayKeys: [], absoluteTolerance: 0, relativeTolerance: 0,
  compareHeaders: false, ignoreHeaders: [], validateContracts: false,
};

export function pointerSegments(path) {
  if (path === "") return [];
  if (!path.startsWith("/") || /~(?![01])/.test(path)) throw new Error(`Invalid JSON pointer: ${path}`);
  return path.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function normalizeComparisonRules(input = {}) {
  const list = (value) => [...new Set((Array.isArray(value) ? value : []).map(String).map((entry) => entry.trim()).filter(Boolean))];
  const ignorePaths = list(input.ignorePaths);
  const arrayKeys = (Array.isArray(input.arrayKeys) ? input.arrayKeys : []).map((row) => ({ path: String(row.path || "").trim(), key: String(row.key || "").trim() }));
  if (ignorePaths.length + arrayKeys.length > 100) throw new Error("Use at most 100 comparison rules.");
  for (const path of [...ignorePaths, ...arrayKeys.map((row) => row.path)]) pointerSegments(path);
  if (arrayKeys.some((row) => !row.key)) throw new Error("Every array matching rule needs a key.");
  if (new Set(arrayKeys.map((row) => row.path)).size !== arrayKeys.length) throw new Error("Use one matching key per array path.");
  const tolerance = (value) => {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error("Tolerances must be finite, non-negative numbers.");
    return number;
  };
  return { ignorePaths, arrayKeys, absoluteTolerance: tolerance(input.absoluteTolerance), relativeTolerance: tolerance(input.relativeTolerance),
    compareHeaders: Boolean(input.compareHeaders), ignoreHeaders: list(input.ignoreHeaders).map((key) => key.toLowerCase()), validateContracts: Boolean(input.validateContracts) };
}

export function saveComparisonProfile(profiles, { id, name, rules }) {
  const cleanName = String(name || "").trim();
  if (!cleanName || cleanName.length > 80) throw new Error("Enter a profile name of 1 to 80 characters.");
  const current = Array.isArray(profiles) ? profiles : [];
  if (current.some((profile) => profile.id !== id && profile.name.toLowerCase() === cleanName.toLowerCase())) throw new Error("A profile with this name already exists.");
  if (!id && current.length >= 30) throw new Error("A request can have at most 30 comparison profiles.");
  const profile = { id: id || crypto.randomUUID(), name: cleanName, rules: normalizeComparisonRules(rules) };
  return { profile, profiles: [...current.filter((entry) => entry.id !== profile.id), profile] };
}
