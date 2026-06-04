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
