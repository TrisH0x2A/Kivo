const SENSITIVE_HISTORY_QUERY_KEYS = new Set([
  "access_token",
  "auth",
  "authorization",
  "apikey",
  "api_key",
  "api-key",
  "client_secret",
  "code",
  "key",
  "password",
  "refresh_token",
  "secret",
  "session",
  "token",
]);

const SENSITIVE_HISTORY_FIELD = /authorization|cookie|token|secret|password|credential|api[-_]?key|session|code_verifier/i;
const MAX_HISTORY_TEXT = 250_000;

function boundText(value, limit = MAX_HISTORY_TEXT) {
  const text = String(value ?? "");
  return { value: text.slice(0, limit), truncated: text.length > limit };
}

function redactBody(value) {
  const raw = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
  try {
    return JSON.stringify(JSON.parse(raw), (key, entry) => SENSITIVE_HISTORY_FIELD.test(key) ? "[redacted]" : entry, 2);
  } catch {
    return raw.replace(/(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*([^,\s&]+)/gi, "$1=[redacted]");
  }
}

function snapshotHeaders(headers = []) {
  return (Array.isArray(headers) ? headers : Object.entries(headers || {}).map(([key, value]) => ({ key, value })))
    .map((header) => {
      const key = String(header?.key ?? "");
      const value = SENSITIVE_HISTORY_FIELD.test(key) ? "[redacted]" : boundText(header?.value).value;
      return { key, value, enabled: header?.enabled !== false };
    })
    .filter((header) => header.key.trim());
}

export function buildHistorySnapshots({ request = {}, response = {}, url = "", workspaceName = "", collectionName = "" } = {}) {
  const execution = response?.execution?.kind === "execution" ? response.execution : null;
  const executionRequest = execution ? {
    method: execution.method,
    url: execution.url,
    finalUrl: execution.finalUrl,
    headers: execution.headers?.map(({ key, value, source }) => ({ key, value, source })) || [],
    body: execution.body,
    bodyOmitted: execution.bodyOmitted,
    bodyTruncated: execution.bodyTruncated,
    environment: execution.environment,
    scriptChanges: execution.scriptChanges,
  } : null;
  const rawBody = executionRequest?.body ?? request?.body ?? "";
  const responseBody = boundText(response?.isBinary ? "[binary response body omitted from preview]" : redactBody(response?.rawBody ?? response?.body ?? ""));
  const responseBase64 = boundText(response?.isBinary ? response?.bodyBase64 ?? "" : "");
  const requestBody = boundText(redactBody(rawBody));
  const requestSnapshot = {
    version: 1,
    requestMode: String(request.requestMode || "http"),
    method: String(executionRequest?.method || request.method || "GET"),
    url: redactHistoryUrl(executionRequest?.url || url || request.url || ""),
    finalUrl: redactHistoryUrl(executionRequest?.finalUrl || executionRequest?.url || url || request.url || ""),
    queryParams: executionRequest ? [] : Array.isArray(request.queryParams) ? request.queryParams.map((row) => ({ key: String(row?.key || ""), value: SENSITIVE_HISTORY_FIELD.test(row?.key || "") ? "[redacted]" : redactHistoryUrl(String(row?.value || "")), enabled: row?.enabled !== false })) : [],
    headers: snapshotHeaders(executionRequest?.headers || request.headers),
    bodyType: String(request.bodyType || "none"),
    body: requestBody.value,
    bodyOmitted: Boolean(executionRequest?.bodyOmitted),
    bodyTruncated: Boolean(executionRequest?.bodyTruncated || requestBody.truncated),
    graphqlVariables: boundText(redactBody(request.graphqlVariables || "{}")).value,
    grpcMethodPath: String(request.grpcMethodPath || ""),
    grpcProtoFilePath: String(request.grpcProtoFilePath || ""),
    grpcStreamingMode: String(request.grpcStreamingMode || "bidi"),
    environment: executionRequest?.environment || { name: "Default" },
    scriptChanges: Array.isArray(executionRequest?.scriptChanges) ? executionRequest.scriptChanges : [],
    replayWarning: "Review captured values, authentication, scripts, and file dependencies before sending this copy.",
    workspaceName: String(workspaceName || ""),
    collectionName: String(collectionName || ""),
  };
  // Native GraphQL captures contain the serialized HTTP envelope, not the query editor text.
  if (request.bodyType === "graphql" && executionRequest && !requestSnapshot.bodyTruncated) {
    try {
      const payload = JSON.parse(requestBody.value);
      if (typeof payload.query === "string") {
        requestSnapshot.body = payload.query;
        requestSnapshot.graphqlVariables = JSON.stringify(payload.variables || {}, null, 2);
      }
    } catch { /* Keep incomplete captures visible for manual review. */ }
  }
  const responseSnapshot = {
    version: 1,
    status: Number(response?.status || 0),
    statusText: String(response?.statusText || ""),
    headers: snapshotHeaders(response?.headers),
    body: responseBody.value,
    bodyTruncated: responseBody.truncated,
    bodyBase64: responseBase64.value,
    bodyBase64Truncated: responseBase64.truncated,
    isBinary: Boolean(response?.isBinary),
    contentType: String(response?.contentType || ""),
    duration: String(response?.duration || ""),
    size: String(response?.size || ""),
    error: String(response?.error || ""),
  };
  return { request: requestSnapshot, response: responseSnapshot, environment: execution?.environment || { name: "Default" } };
}

export function redactHistoryUrl(value) {
  const raw = String(value || "");
  if (!raw.trim()) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = "[redacted]";
    if (parsed.password) parsed.password = "[redacted]";
    for (const key of Array.from(parsed.searchParams.keys())) {
      const normalized = key.trim().toLowerCase();
      if (
        SENSITIVE_HISTORY_QUERY_KEYS.has(normalized)
        || normalized.includes("token")
        || normalized.includes("secret")
        || normalized.includes("password")
        || normalized.includes("apikey")
      ) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return raw.replace(/([?&][^=]*(?:token|secret|password|apikey|api_key|key|authorization|auth)[^=]*=)[^&]*/gi, "$1[redacted]");
  }
}

export function filterRequestHistory(requestHistory = [], query = "") {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) {
    return requestHistory;
  }
  return requestHistory.filter((entry) => [
    entry?.method,
    entry?.url,
    entry?.workspaceName,
    entry?.collectionName,
    entry?.requestName,
    entry?.status,
    entry?.error,
  ].some((value) => String(value ?? "").toLowerCase().includes(normalized)));
}

export function retainHistoryEntries(entries, limit = 500) {
  const count = Number.isFinite(Number(limit)) ? Math.min(5000, Math.max(50, Number(limit))) : 500;
  const pinned = entries.filter((entry) => entry.pinned).slice(0, 5000);
  return [...pinned, ...entries.filter((entry) => !entry.pinned).slice(0, Math.max(0, count - pinned.length))];
}
