const SENSITIVE = /authorization|cookie|token|secret|password|credential|api[-_]?key|session|codeVerifier/i;
const MAX_TEXT = 100_000;

export function createExecutionRedactor(values = []) {
  const secrets = [...new Set(values.filter((value) => value != null && String(value).length > 0)
    .flatMap((value) => [String(value), encodeURIComponent(String(value)), JSON.stringify(String(value)).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  const pattern = secrets.length ? new RegExp(secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : null;
  function text(value) {
    return pattern ? String(value ?? "").replace(pattern, () => "[redacted]") : String(value ?? "");
  }
  function url(value) {
    try {
      const parsed = new URL(value);
      if (parsed.username) parsed.username = "[redacted]";
      if (parsed.password) parsed.password = "[redacted]";
      for (const key of [...parsed.searchParams.keys()]) {
        if (SENSITIVE.test(key)) parsed.searchParams.set(key, "[redacted]");
      }
      return text(parsed.toString());
    } catch { return text(value); }
  }
  function body(value, contentType = "") {
    const raw = String(value ?? "");
    try {
      return text(JSON.stringify(JSON.parse(raw), (key, entry) => SENSITIVE.test(key) ? "[redacted]" : entry, 2)).slice(0, MAX_TEXT);
    } catch {
      if (contentType.includes("x-www-form-urlencoded")) {
        const fields = new URLSearchParams(raw);
        for (const key of [...fields.keys()]) if (SENSITIVE.test(key)) fields.set(key, "[redacted]");
        return text(fields.toString()).slice(0, MAX_TEXT);
      }
      return text(raw).slice(0, MAX_TEXT);
    }
  }
  return { text, url, body, field: (key, value) => SENSITIVE.test(key) ? "[redacted]" : text(value) };
}

function authValues(auth = {}) {
  return [auth.token, auth.jwtToken, auth.username, auth.password, auth.apiKeyValue, auth.customValue,
    auth.oauth2?.accessToken, auth.oauth2?.refreshToken, auth.oauth2?.clientSecret, auth.oauth2?.password];
}

function headerLayers(original, scripted, collection, capture) {
  const layers = [];
  const add = (rows, source) => (rows || []).forEach((row) => {
    if (row.enabled !== false && row.key?.trim()) layers.push({ ...row, source });
  });
  add(capture.collectionHeaders, "Collection");
  const parts = String(original.folderPath || "").split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const path = parts.slice(0, index + 1).join("/");
    add(collection.folderSettings?.find((folder) => folder.path === path)?.defaultHeaders, `Folder: ${path}`);
  }
  add(original.headers, "Request");
  for (const row of scripted.headers || []) {
    if (!original.headers?.some((entry) => JSON.stringify(entry) === JSON.stringify(row))) add([row], "Pre-request script");
  }
  return layers;
}

export function buildExecutionRecord({ capture, original, scripted = original, prepared = scripted, collection = {}, workspaceName = "", scriptVars = {} }) {
  if (!capture?.id) return null;
  const environment = capture.variables || {};
  // Until variables have persistent secret classification, redact every resolved value.
  const values = [...Object.values(environment.merged || {}), ...Object.values(scriptVars),
    ...(capture.privateValues || []), ...authValues(original.auth), ...authValues(prepared.auth),
    ...(capture.headers || []).filter(({ key }) => SENSITIVE.test(key)).map(({ value }) => value)];
  const redact = createExecutionRedactor(values);
  const layers = headerLayers(original, scripted, collection, capture);
  const authSource = original.auth?.type !== "inherit" ? "Request"
    : prepared.auth?.type !== "inherit" ? "Folder" : "Collection";
  const headers = (capture.headers || []).map(({ key, value }) => {
    const matches = layers.filter((entry) => entry.key.toLowerCase() === key.toLowerCase());
    const source = key.toLowerCase() === "authorization" && capture.authType && capture.authType !== "none" ? `${authSource} authentication`
      : matches.at(-1)?.source || (key.toLowerCase() === "cookie" ? "Cookie jar" : "Transport");
    return { key, value: redact.field(key, value), source, configuredSources: [...new Set(matches.map((entry) => entry.source))] };
  });
  const requestFields = [scripted.url, scripted.queryParams, scripted.headers, scripted.body, scripted.graphqlVariables, scripted.auth];
  const variableKeys = new Set([...JSON.stringify(requestFields).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]));
  const variables = [...variableKeys].map((key) => {
    const collectionValue = environment.collection?.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
    const workspaceValue = environment.workspace?.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
    return { key, value: "[redacted]", source: collectionValue ? "Collection" : workspaceValue ? "Workspace" : "Dynamic or unresolved",
      overrides: collectionValue && workspaceValue ? "Workspace" : "" };
  });
  const scriptChanges = ["method", "url", "queryParams", "headers", "body", "graphqlVariables", "auth"]
    .filter((key) => JSON.stringify(original[key]) !== JSON.stringify(scripted[key]));
  const contentType = capture.headers?.find(({ key }) => key.toLowerCase() === "content-type")?.value || "";
  const actualResponse = capture.response && typeof capture.response === "object" ? capture.response : null;
  return {
    schemaVersion: 1, kind: "execution", id: capture.id, capturedAt: capture.capturedAt,
    requestId: original.id || "", requestName: original.name || "", workspaceName, collectionName: collection.name || "",
    environment: { id: capture.environment?.id || "", name: capture.environment?.name || "Default" },
    method: capture.method, url: redact.url(capture.url), finalUrl: redact.url(capture.finalUrl),
    bodyType: original.bodyType || "none", body: capture.bodyOmitted ? "[file or streaming body omitted]" : redact.body(capture.body, contentType),
    bodyOmitted: Boolean(capture.bodyOmitted), bodyTruncated: Boolean(capture.bodyTruncated),
    headers, variables, authSource, authType: capture.authType || "none", scriptChanges,
    scriptVariableNames: Object.keys(scriptVars), attempts: capture.attempts || 1,
    settings: {
      timeoutMs: capture.settings?.timeoutMs || 0,
      followRedirects: capture.settings?.followRedirects !== false,
      cookieJar: capture.settings?.cookieJar !== false,
      proxyMode: capture.settings?.proxyMode || "inherit",
      proxyConfigured: Boolean(capture.settings?.proxyConfigured),
    },
    actual: actualResponse ? {
      status: Number(actualResponse.status) || 0,
      statusText: String(actualResponse.statusText || ""),
      durationMs: Number(actualResponse.durationMs) || 0,
      protocol: String(actualResponse.protocol || ""),
      contentType: redact.text(actualResponse.contentType || ""),
      sizeBytes: Number(actualResponse.sizeBytes) || 0,
      redirected: Boolean(actualResponse.redirected),
      finalUrl: redact.url(actualResponse.finalUrl || capture.finalUrl),
    } : null,
  };
}

export function attachExecutionResponse(store, identity, response, responseBodyView = "Raw") {
  const matches = (entry, id, name) => id ? entry.id === id : entry.name === name;
  return { ...store, workspaces: store.workspaces.map((workspace) => !matches(workspace, identity.workspaceId, identity.workspaceName) ? workspace : {
    ...workspace, collections: workspace.collections.map((collection) => !matches(collection, identity.collectionId, identity.collectionName) ? collection : {
      ...collection, requests: collection.requests.map((request) => !matches(request, identity.requestId, identity.requestName) ? request : { ...request, lastResponse: response, responseBodyView }),
    }),
  }) };
}
