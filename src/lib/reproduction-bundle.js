function isSensitiveKey(key) {
  return /authorization|cookie|set-cookie|token|secret|password|credential|api[-_]?key/i.test(String(key || ""));
}

function redactText(text, secrets) {
  return secrets.reduce((result, secret) => secret ? result.split(secret).join("[redacted]") : result, String(text ?? ""));
}

function countRedactions(value) {
  return (JSON.stringify(value).match(/\[redacted\]/g) || []).length;
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

  const actual = explanation?.kind === "execution";
  const safeRequest = {
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
  };
  const bundle = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    client: { name: "Kivo", version: "0.4.1" },
    workspace: workspaceName,
    collection: collectionName,
    environment: environmentName || explanation?.environment?.name || "Active environment",
    execution: actual ? {
      id: explanation.id,
      capturedAt: explanation.capturedAt,
      attempts: explanation.attempts || 1,
      actualRequest: true,
      scriptChanges: explanation.scriptChanges || [],
      runtimeVariables: explanation.scriptVariableNames || [],
    } : { actualRequest: false },
    request: safeRequest,
    replay: {
      safe: !safeRequest.url.includes("[redacted]") && !safeRequest.body.includes("[redacted]") && !safeRequest.truncated,
      requiresReview: true,
      unsupported: safeRequest.body.includes("file or streaming") ? ["file or streaming body"] : [],
    },
    redactions: countRedactions(safeRequest),
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
      actual ? "Request fields and environment identity came from a native execution capture." : "This bundle is an editor preview and has not been sent by the native client.",
      "Authorization and other known credential values were redacted.",
      "Import is review-only until the destination request is explicitly applied.",
    ],
  };
  return bundle;
}

export function validateReproductionBundle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A reproduction bundle object is required.");
  if (value.schemaVersion !== 2) throw new Error("Unsupported reproduction bundle version.");
  if (!value.request || typeof value.request !== "object") throw new Error("Bundle request data is missing.");
  const request = value.request;
  if (!/^[A-Z]+$/.test(String(request.method || ""))) throw new Error("Bundle method is invalid.");
  if (!/^https?:\/\//i.test(String(request.url || "")) && !String(request.url || "").includes("{{")) throw new Error("Only HTTP(S) bundle URLs can be imported.");
  if (String(request.body || "").length > 12000 || JSON.stringify(value).length > 2_000_000) throw new Error("Reproduction bundle exceeds the import size limit.");
  if (String(request.body || "").includes("[file or streaming body omitted]")) throw new Error("Bundles with omitted file or streaming bodies cannot be replayed.");
  if (!Array.isArray(request.headers) || request.headers.some((header) => !header?.key || String(header.key).length > 512 || String(header.value || "").length > 100000)) throw new Error("Bundle headers are invalid.");
  return structuredClone(value);
}

export function prepareReproductionReplay(bundle) {
  const safe = validateReproductionBundle(bundle);
  const request = safe.request;
  const warnings = [];
  if (safe.redactions > 0 || JSON.stringify(request).includes("[redacted]")) warnings.push("Redacted values must be replaced before sending.");
  if (request.truncated) warnings.push("The request body was truncated.");
  return {
    safe: warnings.length === 0 && safe.replay?.safe === true,
    warnings,
    request: { method: request.method, url: request.url, bodyType: request.bodyType, body: request.body, headers: request.headers, auth: { type: "none" } },
  };
}
