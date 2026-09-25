import { buildResolvedRequestExport } from "@/lib/http-ui.js";
import { isDynamicTemplateVariable } from "@/lib/template-variables.js";
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

function hasHeader(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function isSensitiveKey(key) {
  return /authorization|cookie|set-cookie|token|secret|password|credential|api[-_]?key/i.test(String(key || ""));
}

function maskValue(key, value) {
  return isSensitiveKey(key) && String(value || "").trim() ? "[hidden]" : String(value ?? "");
}

function maskText(text, envValues) {
  let result = String(text ?? "");
  for (const [key, value] of Object.entries(envValues)) {
    if (!isSensitiveKey(key) || !String(value ?? "")) continue;
    result = result.split(String(value)).join("[hidden]");
  }
  return result;
}

function collectPlaceholders(request) {
  const text = [
    request?.url,
    ...(request?.queryParams || []).flatMap((row) => [row?.key, row?.value]),
    ...(request?.headers || []).flatMap((row) => [row?.key, row?.value]),
    request?.body,
    request?.graphqlVariables,
  ].map((value) => String(value ?? "")).join("\n");
  return [...new Set([...text.matchAll(/\{\{+\s*([^{}]+?)\s*\}\}+/g)].map((match) => match[1].trim()).filter(Boolean))];
}

export function buildRequestExplanation(request, { envVars = {}, collectionConfig = {}, collection = {} } = {}) {
  const mergedEnv = envVars?.merged ?? {};
  const folderSettings = Array.isArray(collection?.folderSettings) ? collection.folderSettings : [];
  const ancestors = folderAncestors(request?.folderPath);
  const folderHeaders = ancestors.flatMap((path) => {
    const setting = folderSettings.find((entry) => normalizeFolderPath(entry?.path) === path);
    return Array.isArray(setting?.defaultHeaders) ? setting.defaultHeaders : [];
  });
  const disabledHeaderKeys = new Set((request?.headers || [])
    .filter((row) => row?.enabled === false && String(row?.key || "").trim())
    .map((row) => String(row.key).trim().toLowerCase()));
  const inheritedHeaders = folderHeaders.filter((row) => !disabledHeaderKeys.has(String(row?.key || "").trim().toLowerCase()));
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
  const effectiveAuth = requestAuth.type === "inherit" && inheritedAuth.type !== "inherit" ? inheritedAuth : requestAuth;
  const effectiveRequest = {
    ...request,
    headers: [...inheritedHeaders, ...(request?.headers || [])],
    auth: effectiveAuth,
  };
  const resolved = buildResolvedRequestExport(effectiveRequest, {
    envVars: { merged: mergedEnv },
    collectionConfig,
  });
  const headers = Object.entries(resolved.headers || {}).map(([key, value]) => ({
    key,
    value: maskValue(key, value),
    source: key.toLowerCase() === "content-type" ? "Kivo" : inheritedHeaders.some((row) => row?.key?.toLowerCase() === key.toLowerCase()) ? "Inherited" : "Request",
  }));
  const variables = collectPlaceholders(request).map((key) => {
    const exact = Object.prototype.hasOwnProperty.call(mergedEnv, key);
    const normalizedKey = Object.keys(mergedEnv).find((entry) => entry.toLowerCase() === key.toLowerCase());
    return {
      key,
      source: exact || normalizedKey ? "Environment" : isDynamicTemplateVariable(key) ? "Dynamic" : "Unresolved",
      value: exact || normalizedKey ? maskValue(key, mergedEnv[exact ? key : normalizedKey]) : "-",
    };
  });
  const authSource = requestAuth.type !== "inherit"
    ? "Request"
    : inheritedAuth.type !== "inherit"
      ? "Folder"
      : normalizeAuthState(collectionConfig?.defaultAuth).type !== "none" ? "Collection" : "None";

  return {
    ...resolved,
    url: maskText(resolved.url, Object.fromEntries(Object.entries(mergedEnv).filter(([key]) => isSensitiveKey(key)))),
    body: maskText(resolved.body, Object.fromEntries(Object.entries(mergedEnv).filter(([key]) => isSensitiveKey(key)))),
    headers,
    variables,
    authSource,
    settings: {
      timeoutMs: Number(request?.timeoutMs || 0),
      followRedirects: request?.followRedirects !== false,
      cookieJar: request?.useCookieJar !== false,
      inheritedHeaders: inheritedHeaders.length + (request?.inheritHeaders ? (collectionConfig?.defaultHeaders || []).length : 0),
    },
    hasAuthorization: hasHeader(resolved.headers || {}, "authorization"),
  };
}
