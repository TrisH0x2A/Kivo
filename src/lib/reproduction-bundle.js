function isSensitiveKey(key) {
  return /authorization|cookie|set-cookie|token|secret|password|credential|api[-_]?key/i.test(String(key || ""));
}

function redactText(text, secrets) {
  return secrets.reduce((result, secret) => secret ? result.split(secret).join("[redacted]") : result, String(text ?? ""));
}

function redactBody(body, secrets) {
  const text = String(body ?? "");
  try {
    return redactText(JSON.stringify(JSON.parse(text), (key, value) => isSensitiveKey(key) ? "[redacted]" : value, 2), secrets);
  } catch {
    return redactText(text, secrets);
  }
}

function redactUrl(value, secrets) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, "[redacted]");
    }
    return redactText(url.toString(), secrets);
  } catch {
    return redactText(value, secrets);
  }
}

export function buildReproductionBundle({ request, response, explanation, envVars = {}, workspaceName = "", collectionName = "", environmentName = "" }) {
  const auth = request?.auth || {};
  const secrets = [
    auth.token,
    auth.jwtToken,
    auth.username,
    auth.password,
    auth.apiKeyValue,
    auth.customValue,
    auth.oauth2?.accessToken,
    auth.oauth2?.refreshToken,
    auth.oauth2?.clientSecret,
    ...Object.entries(envVars.merged || {}).filter(([key]) => isSensitiveKey(key)).map(([, value]) => value),
    ...(request?.headers || []).filter(({ key }) => isSensitiveKey(key)).map(({ value }) => value),
  ].map((value) => String(value ?? "")).filter(Boolean);
  const safeResponseBody = response?.isBinary ? "[binary body omitted]" : redactBody(response?.rawBody ?? response?.body ?? "", secrets);
  const safeRequestBody = redactBody(explanation?.body, secrets);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    client: { name: "Kivo", version: "0.4.1" },
    workspace: workspaceName,
    collection: collectionName,
    environment: environmentName || "Active environment",
    request: {
      name: redactText(request?.name || "Untitled Request", secrets),
      method: explanation?.method || request?.method || "GET",
      url: redactUrl(explanation?.url || request?.url || "", secrets),
      bodyType: explanation?.bodyType || request?.bodyType || "none",
      headers: (explanation?.headers || []).map(({ key, value, source }) => ({ key, value: isSensitiveKey(key) ? "[redacted]" : redactText(value, secrets), source })),
      body: safeRequestBody.slice(0, 12000),
      truncated: safeRequestBody.length > 12000,
      variables: (explanation?.variables || []).map(({ key, source }) => ({ key, source })),
      settings: {
        timeoutMs: explanation?.settings?.timeoutMs ?? 0,
        followRedirects: explanation?.settings?.followRedirects !== false,
        cookieJar: explanation?.settings?.cookieJar !== false,
      },
    },
    assertions: (request?.scriptLastTests || []).map((entry, index) => ({
      index: index + 1,
      passed: entry.ok === true,
    })),
    response: response ? {
      status: response.status || 0,
      statusText: redactText(response.statusText, secrets),
      duration: response.duration || "",
      size: response.size || "",
      headers: Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key, isSensitiveKey(key) ? "[redacted]" : redactText(value, secrets)])),
      body: safeResponseBody.slice(0, 100000),
      truncated: safeResponseBody.length > 100000,
    } : null,
    notes: [
      "Generated locally by Kivo.",
      "Request is a resolved editor preview; response is the currently selected result and may be from an earlier run.",
      "Authorization and other known credential values were redacted.",
      "Review the bundle before sharing it externally.",
    ],
  };
}
