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
  const raw = String(value ?? "");
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
  const rawBody = executionRequest?.body ?? redactBody(response?.rawBody ?? response?.body ?? request?.body ?? "");
  const boundedBody = boundText(rawBody);
  const responseBody = boundText(response?.isBinary ? "[binary response body omitted from preview]" : redactBody(response?.rawBody ?? response?.body ?? ""));
  const responseBase64 = boundText(response?.bodyBase64 ?? "");
  const requestBody = boundText(boundedBody.value);
  const requestSnapshot = {
    version: 1,
    requestMode: String(request.requestMode || "http"),
    method: String(executionRequest?.method || request.method || "GET"),
    url: String(executionRequest?.url || redactHistoryUrl(url || request.url || "")),
    finalUrl: String(executionRequest?.finalUrl || executionRequest?.url || redactHistoryUrl(url || request.url || "")),
    queryParams: Array.isArray(request.queryParams) ? request.queryParams.map((row) => ({ key: String(row?.key || ""), value: redactHistoryUrl(String(row?.value || "")), enabled: row?.enabled !== false })) : [],
    headers: executionRequest?.headers || snapshotHeaders(request.headers),
    bodyType: String(request.bodyType || "none"),
    body: requestBody.value,
    bodyOmitted: Boolean(executionRequest?.bodyOmitted),
    bodyTruncated: Boolean(executionRequest?.bodyTruncated || requestBody.truncated),
    environment: executionRequest?.environment || { name: "Default" },
    scriptChanges: Array.isArray(executionRequest?.scriptChanges) ? executionRequest.scriptChanges : [],
    replayWarning: executionRequest?.bodyOmitted || requestBody.value.includes("[redacted]") || snapshotHeaders(request.headers).some((header) => header.value.includes("[redacted]"))
      ? "Review redacted or omitted values before replaying."
      : "",
    workspaceName: String(workspaceName || ""),
    collectionName: String(collectionName || ""),
  };
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
