import { buildRequestPayload, buildResolvedRequestExport } from "@/lib/http-ui.js";
import { normalizeAuthState } from "@/lib/oauth.js";

function normalizeFolderPath(path) {
  return String(path ?? "").split("/").map((part) => part.trim()).filter(Boolean).join("/");
}

function folderAncestors(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return [];
  const parts = normalized.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function buildComparisonRequestPayload(request, envVars, collectionConfig, collection, workspaceName, collectionName, requestId) {
  const folderSettings = Array.isArray(collection?.folderSettings) ? collection.folderSettings : [];
  const ancestors = folderAncestors(request?.folderPath);
  const folderHeaders = ancestors.flatMap((path) => {
    const setting = folderSettings.find((entry) => normalizeFolderPath(entry?.path) === path);
    return Array.isArray(setting?.defaultHeaders) ? setting.defaultHeaders : [];
  });
  const disabledKeys = new Set((request?.headers || [])
    .filter((row) => row?.enabled === false && String(row?.key || "").trim())
    .map((row) => String(row.key).trim().toLowerCase()));
  let inheritedAuth = { type: "inherit" };
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const setting = folderSettings.find((entry) => normalizeFolderPath(entry?.path) === ancestors[index]);
    const auth = normalizeAuthState(setting?.defaultAuth ?? { type: "inherit" });
    if (setting && auth.type !== "inherit") {
      inheritedAuth = auth;
      break;
    }
  }
  const requestAuth = normalizeAuthState(request?.auth ?? { type: "none" });
  const effectiveRequest = {
    ...request,
    headers: [
      ...folderHeaders.filter((row) => !disabledKeys.has(String(row?.key || "").trim().toLowerCase())),
      ...(request?.headers || []),
    ],
    auth: requestAuth.type === "inherit" && inheritedAuth.type !== "inherit" ? inheritedAuth : requestAuth,
  };
  const resolved = buildResolvedRequestExport(effectiveRequest, { envVars, collectionConfig });
  const headers = Object.entries(resolved.headers || {}).map(([key, value]) => ({
    key,
    value,
    enabled: true,
    fieldType: "",
    filePath: "",
  }));
  return {
    ...buildRequestPayload({
      ...request,
      url: resolved.url,
      queryParams: [],
      headers,
      auth: { type: "none" },
      bodyType: "text",
      body: resolved.body,
      inheritHeaders: false,
    }, workspaceName, collectionName),
    requestId,
  };
}
