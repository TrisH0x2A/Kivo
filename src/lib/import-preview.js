export function getImportPreview(imported, scope) {
  const collection = imported?.collection || null;
  const requests = scope === "collection"
    ? (Array.isArray(collection?.requests) ? collection.requests : [])
    : (Array.isArray(imported?.requests) ? imported.requests : []);
  const folders = scope === "collection"
    ? (Array.isArray(collection?.folders) ? collection.folders.filter(Boolean) : [])
    : [];
  const names = new Set();
  const duplicateNames = new Set();
  const relativeUrls = requests.filter((request) => {
    const url = String(request?.url || "").trim();
    return url && !/^[a-z][a-z\d+.-]*:\/\//i.test(url) && !url.startsWith("{{");
  }).length;

  requests.forEach((request) => {
    const name = String(request?.name || "Imported Request").trim().toLowerCase();
    if (names.has(name)) duplicateNames.add(name);
    names.add(name);
  });

  const warnings = [];
  if (requests.length === 0) warnings.push("No requests were found in this file.");
  if (duplicateNames.size > 0) warnings.push(`${duplicateNames.size} duplicate request name${duplicateNames.size === 1 ? "" : "s"} may be renamed to keep them addressable.`);
  if (relativeUrls > 0) warnings.push(`${relativeUrls} request${relativeUrls === 1 ? " uses" : "s use"} a relative URL. Add a base URL before sending.`);
  if (imported?.detectedFormat && imported.detectedFormat !== "kivo" && requests.some((request) => !["http", "graphql"].includes(String(request?.requestMode || "http")))) {
    warnings.push("Some protocol-specific settings could not be represented by this source format.");
  }

  return {
    format: String(imported?.detectedFormat || "unknown").toUpperCase(),
    name: String(collection?.name || "Imported requests"),
    requestCount: requests.length,
    folderCount: folders.length,
    warnings,
  };
}
