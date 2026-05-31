import { createDefaultAuthState, normalizeAuthState } from "@/lib/oauth.js";
import { createDefaultKeybindings } from "@/lib/keybindings.js";

export const REQUEST_MODES = {
  HTTP: "http",
  SSE: "sse",
  GRAPHQL: "graphql",
  GRPC: "grpc",
  WEBSOCKET: "websocket",
  SOCKET_IO: "socketio"
};

export const REQUEST_MODE_OPTIONS = [
  { value: REQUEST_MODES.HTTP, label: "HTTP Request" },
  { value: REQUEST_MODES.SSE, label: "Event Stream Request (SSE)" },
  { value: REQUEST_MODES.GRAPHQL, label: "GraphQL Request" },
  { value: REQUEST_MODES.GRPC, label: "gRPC Request" },
  { value: REQUEST_MODES.WEBSOCKET, label: "WebSocket Request" },
  { value: REQUEST_MODES.SOCKET_IO, label: "Socket.IO Request" }
];

export const DEFAULT_USER_AGENT_VALUE = "kivo/0.4.1";

export function createDefaultAppSettings() {
  return {
    clearOAuthSessionOnStart: false,
    validateCertificatesDuringAuthentication: true,
    sslTlsCertificateVerification: true,
    useCustomCaCertificate: false,
    customCaCertificatePath: "",
    keepDefaultCaCertificates: true,
    storeLastResponseByDefault: false,
    storeCookiesAutomatically: true,
    sendCookiesAutomatically: true,
    useSystemBrowserForOauth2Authorization: true,
    requestTimeoutMs: 0,
    proxyEnabled: false,
    proxyHttp: "",
    proxyHttps: "",
    noProxy: "",
    proxyUsername: "",
    proxyPassword: "",
    useClientCertificate: false,
    clientCertificatePath: "",
    clientKeyPath: "",
    keybindings: createDefaultKeybindings(),
  };
}

function withDefaultUserAgent(headers = [], options = {}) {
  const normalized = Array.isArray(headers) ? headers.map((row) => ({ ...row })) : [];
  if (!options.injectMissing) {
    return normalized;
  }

  const hasUserAgent = normalized.some((row) => String(row?.key || "").trim().toLowerCase() === "user-agent");
  if (hasUserAgent) {
    return normalized;
  }

  return [...normalized, { key: "User-Agent", value: DEFAULT_USER_AGENT_VALUE, enabled: false }];
}

function createSocketIoEvent(name = "message") {
  return {
    id: `sio-${Math.random().toString(36).slice(2, 10)}`,
    name,
    enabled: true,
    listen: true,
    emit: true,
    description: "",
    payloadType: "json",
    payload: "{\n\n}",
    ackTimeoutMs: null
  };
}

function getRequestModeTemplate(mode) {
  switch (mode) {
    case REQUEST_MODES.GRAPHQL:
      return {
        method: "POST",
        bodyType: "graphql",
        body: "",
        graphqlVariables: "{\n\n}",
        activeEditorTab: "Body",
        headers: withDefaultUserAgent([], { injectMissing: true })
      };
    case REQUEST_MODES.SSE:
      return {
        method: "GET",
        bodyType: "none",
        activeEditorTab: "Params",
        sseWithCredentials: false,
        sseLastEventId: "",
        sseRetryMs: 3000,
        headers: withDefaultUserAgent([{ key: "Accept", value: "text/event-stream", enabled: true }], { injectMissing: true })
      };
    case REQUEST_MODES.GRPC:
      return {
        method: "POST",
        bodyType: "json",
        activeEditorTab: "Body",
        headers: withDefaultUserAgent([{ key: "Content-Type", value: "application/grpc", enabled: true }], { injectMissing: true })
      };
    case REQUEST_MODES.WEBSOCKET:
      return {
        method: "GET",
        bodyType: "json",
        activeEditorTab: "Body",
        webSocketKeepAliveIntervalMs: 0,
        headers: withDefaultUserAgent([], { injectMissing: true })
      };
    case REQUEST_MODES.SOCKET_IO:
      {
        const defaultEvent = createSocketIoEvent("message");
      return {
        method: "GET",
        bodyType: "json",
        body: defaultEvent.payload,
        activeEditorTab: "Body",
        socketIoEventName: defaultEvent.name,
        socketIoNamespace: "/",
        socketIoAckTimeoutMs: 0,
        socketIoEvents: [defaultEvent],
        socketIoSelectedEventId: defaultEvent.id,
        headers: withDefaultUserAgent([], { injectMissing: true })
      };
      }
    case REQUEST_MODES.HTTP:
    default:
      return {
        method: "GET",
        bodyType: "json",
        headers: withDefaultUserAgent([], { injectMissing: true })
      };
  }
}

export function formatSavedAt() {
  return new Date().toLocaleString();
}

export function createRow() {
  return { key: "", value: "", enabled: true, fieldType: "text", filePath: "" };
}

export function createEmptyResponse() {
  return {
    status: 0,
    badge: "Waiting",
    statusText: "No response yet",
    duration: "0 ms",
    size: "0 B",
    headers: {},
    cookies: [],
    body: "Send a request to inspect the response.",
    rawBody: "Send a request to inspect the response.",
    isJson: false,
    meta: {
      url: "-",
      method: "-"
    },
    savedAt: ""
  };
}

export function getUniqueName(baseName, existingNames = []) {
  if (!existingNames.includes(baseName)) {
    return baseName;
  }

  let counter = 1;
  while (existingNames.includes(`${baseName} (${counter})`)) {
    counter++;
  }
  return `${baseName} (${counter})`;
}

export function createRequest(name = "New Request", mode = REQUEST_MODES.HTTP) {
  const requestMode = Object.values(REQUEST_MODES).includes(mode) ? mode : REQUEST_MODES.HTTP;
  const template = getRequestModeTemplate(requestMode);

  return {
    name,
    requestMode,
    pinned: false,
    method: template.method,
    url: "",
    queryParams: [],
    headers: template.headers ?? [],
    auth: createDefaultAuthState(),
    bodyType: template.bodyType,
    body: template.body ?? "",
    bodyRows: [],
    bodyFilePath: "",
    graphqlVariables: template.graphqlVariables ?? "{\n\n}",
    grpcProtoFilePath: "",
    grpcMethodPath: "",
    grpcStreamingMode: "bidi",
    grpcDirectProtoFiles: [],
    grpcProtoDirectories: [],
    docs: "",
    activeEditorTab: template.activeEditorTab ?? "Params",
    activeResponseTab: "Body",
    responseBodyView: "JSON",
    inheritHeaders: false,
    tags: [],
    urlEncoding: true,
    followRedirects: true,
    maxRedirects: 5,
    timeoutMs: 0,
    useCookieJar: true,
    proxyMode: "inherit",
    proxyHttp: "",
    proxyHttps: "",
    noProxy: "",
    clientCertificatePath: "",
    clientKeyPath: "",
    webSocketKeepAliveIntervalMs: Number.isFinite(template.webSocketKeepAliveIntervalMs)
      ? Number(template.webSocketKeepAliveIntervalMs)
      : 0,
    sseWithCredentials: template.sseWithCredentials ?? false,
    sseLastEventId: template.sseLastEventId ?? "",
    sseRetryMs: Number.isFinite(template.sseRetryMs) ? Number(template.sseRetryMs) : 3000,
    socketIoEventName: template.socketIoEventName ?? "message",
    socketIoNamespace: template.socketIoNamespace ?? "/",
    socketIoAckTimeoutMs: Number.isFinite(template.socketIoAckTimeoutMs) ? Number(template.socketIoAckTimeoutMs) : 0,
    socketIoEvents: Array.isArray(template.socketIoEvents) ? template.socketIoEvents.map((event) => ({ ...event })) : [],
    socketIoSelectedEventId: template.socketIoSelectedEventId ?? "",
    folderPath: "",
    scriptPreRequest: "",
    scriptAfterResponse: "",
    scriptActivePhase: "pre-request",
    scriptLastRunAt: "",
    scriptLastPhase: "",
    scriptLastStatus: "",
    scriptLastError: "",
    scriptLastLogs: [],
    scriptLastTests: [],
    scriptLastVars: {},
    lastResponse: null
  };
}

export function createCollection(name = "New Collection") {
  return {
    name,
    folders: [],
    folderSettings: [],
    requests: [],
    openRequestNames: []
  };
}

export function createWorkspace(name, description = "") {
  return {
    name,
    description,
    collections: [],
    activeCollectionName: ""
  };
}

export function createDefaultStore() {
  return {
    version: 1,
    storagePath: null,
    appSettings: createDefaultAppSettings(),
    activeWorkspaceName: "",
    activeCollectionName: "",
    activeRequestName: "",
    sidebarTab: "requests",
    sidebarCollapsed: false,
    sidebarWidth: 260,
    workspaces: [],
    requestHistory: []
  };
}

export function getActiveWorkspace(store) {
  return store.workspaces.find((workspace) => workspace.name === store.activeWorkspaceName) ?? store.workspaces[0] ?? null;
}

export function getActiveCollection(store) {
  const workspace = getActiveWorkspace(store);
  if (!workspace) return null;
  return workspace.collections.find((c) => c.name === store.activeCollectionName) ?? workspace.collections[0] ?? null;
}

export function getActiveRequest(store) {
  const collection = getActiveCollection(store);
  if (!collection || !collection.openRequestNames?.includes(store.activeRequestName)) {
    return null;
  }

  return collection.requests.find((request) => request.name === store.activeRequestName) ?? null;
}

export function orderRequests(requests = []) {
  return [...requests]
    .map((request, index) => ({ request, index }))
    .sort((left, right) => {
      if (Boolean(left.request.pinned) === Boolean(right.request.pinned)) {
        return left.index - right.index;
      }

      return left.request.pinned ? -1 : 1;
    })
    .map(({ request }) => request);
}

export function normalizeRequestRecord(request) {
  let normalizedBody = "";
  if (typeof request?.body === "string") {
    normalizedBody = request.body;
  } else if (request?.body && typeof request.body === "object") {
    try {
      normalizedBody = JSON.stringify(request.body, null, 2);
    } catch {
      normalizedBody = "";
    }
  }

  let normalizedGraphqlVariables = "{\n\n}";
  if (typeof request?.graphqlVariables === "string") {
    normalizedGraphqlVariables = request.graphqlVariables;
  } else if (request?.graphqlVariables && typeof request.graphqlVariables === "object") {
    try {
      normalizedGraphqlVariables = JSON.stringify(request.graphqlVariables, null, 2);
    } catch {
      normalizedGraphqlVariables = "{\n\n}";
    }
  }

  const allowedModes = Object.values(REQUEST_MODES);
  let requestMode;
  if (allowedModes.includes(request?.requestMode)) {
    requestMode = request.requestMode;
  } else {
    const url = String(request?.url || "").trim().toLowerCase();
    const bodyType = String(request?.bodyType || "").trim().toLowerCase();
    const headers = Array.isArray(request?.headers) ? request.headers : [];
    const acceptHeader = headers.find((h) => String(h?.key || "").trim().toLowerCase() === "accept");
    const contentTypeHeader = headers.find((h) => String(h?.key || "").trim().toLowerCase() === "content-type");
    const acceptValue = String(acceptHeader?.value || "").toLowerCase();
    const contentTypeValue = String(contentTypeHeader?.value || "").toLowerCase();
    const hasSocketIoEvents = Array.isArray(request?.socketIoEvents) && request.socketIoEvents.length > 0;

    if (url.startsWith("ws://") || url.startsWith("wss://")) {
      requestMode = REQUEST_MODES.WEBSOCKET;
    } else if (bodyType === "graphql" || url.includes("/graphql")) {
      requestMode = REQUEST_MODES.GRAPHQL;
    } else if (bodyType === "grpc" || url.startsWith("grpc://") || url.startsWith("grpcs://") || contentTypeValue.includes("application/grpc")) {
      requestMode = REQUEST_MODES.GRPC;
    } else if (acceptValue.includes("text/event-stream")) {
      requestMode = REQUEST_MODES.SSE;
    } else if (hasSocketIoEvents || url.includes("socket.io")) {
      requestMode = REQUEST_MODES.SOCKET_IO;
    } else {
      requestMode = REQUEST_MODES.HTTP;
    }
  }

  const socketIoEvents = Array.isArray(request?.socketIoEvents)
    ? request.socketIoEvents
      .map((event) => ({
        id: String(event?.id || `sio-${Math.random().toString(36).slice(2, 10)}`),
        name: String(event?.name || "message").trim() || "message",
        enabled: event?.enabled ?? true,
        listen: event?.listen ?? true,
        emit: event?.emit ?? true,
        description: String(event?.description || ""),
        payloadType: event?.payloadType === "text" ? "text" : "json",
        payload: typeof event?.payload === "string"
          ? event.payload
          : (event?.payload && typeof event.payload === "object" ? JSON.stringify(event.payload, null, 2) : "{\n\n}"),
        ackTimeoutMs: Number.isFinite(event?.ackTimeoutMs) ? Number(event.ackTimeoutMs) : null
      }))
    : [];

  if (requestMode === REQUEST_MODES.SOCKET_IO && socketIoEvents.length === 0) {
    const defaultEvent = createSocketIoEvent(
      typeof request?.socketIoEventName === "string" && request.socketIoEventName.trim()
        ? request.socketIoEventName.trim()
        : "message"
    );
    if (typeof request?.body === "string" && request.body.trim()) {
      defaultEvent.payload = request.body;
    }
    if (request?.bodyType === "text" || request?.bodyType === "json") {
      defaultEvent.payloadType = request.bodyType;
    }
    socketIoEvents.push(defaultEvent);
  }

  const defaultSocketIoEvent = socketIoEvents[0] || null;
  const selectedSocketIoEventId = String(request?.socketIoSelectedEventId || "");
  const hasSelectedSocketIoEvent = socketIoEvents.some((event) => event.id === selectedSocketIoEventId);

  return {
    ...request,
    requestMode,
    pinned: Boolean(request?.pinned),
    inheritHeaders: request?.inheritHeaders ?? false,
    queryParams: Array.isArray(request?.queryParams) ? request.queryParams : [],
    headers: withDefaultUserAgent(Array.isArray(request?.headers) ? request.headers : []),
    body: normalizedBody,
    bodyRows: Array.isArray(request?.bodyRows)
      ? request.bodyRows.map((row) => ({
        key: String(row?.key ?? ""),
        value: String(row?.value ?? ""),
        enabled: row?.enabled ?? true,
        fieldType: row?.fieldType === "file" ? "file" : "text",
        filePath: String(row?.filePath ?? ""),
      }))
      : [],
    bodyFilePath: typeof request?.bodyFilePath === "string" ? request.bodyFilePath : "",
    graphqlVariables: normalizedGraphqlVariables,
    grpcProtoFilePath: typeof request?.grpcProtoFilePath === "string" ? request.grpcProtoFilePath : "",
    grpcMethodPath: typeof request?.grpcMethodPath === "string" ? request.grpcMethodPath : "",
    grpcStreamingMode: ["unary", "server_stream", "client_stream", "bidi"].includes(request?.grpcStreamingMode)
      ? request.grpcStreamingMode
      : "bidi",
    grpcDirectProtoFiles: Array.isArray(request?.grpcDirectProtoFiles)
      ? request.grpcDirectProtoFiles.map((path) => String(path || "").trim()).filter(Boolean)
      : [],
    grpcProtoDirectories: Array.isArray(request?.grpcProtoDirectories)
      ? request.grpcProtoDirectories
        .map((group) => ({
          path: String(group?.path || "").trim(),
          files: Array.isArray(group?.files)
            ? group.files.map((path) => String(path || "").trim()).filter(Boolean)
            : []
        }))
        .filter((group) => group.path)
      : [],
    tags: Array.isArray(request?.tags) ? request.tags.map((tag) => String(tag)) : [],
    urlEncoding: request?.urlEncoding ?? true,
    followRedirects: request?.followRedirects ?? true,
    maxRedirects: Number.isFinite(request?.maxRedirects) ? Number(request.maxRedirects) : 5,
    timeoutMs: Number.isFinite(request?.timeoutMs) ? Number(request.timeoutMs) : 0,
    useCookieJar: request?.useCookieJar ?? true,
    proxyMode: typeof request?.proxyMode === "string" ? request.proxyMode : "inherit",
    proxyHttp: typeof request?.proxyHttp === "string" ? request.proxyHttp : "",
    proxyHttps: typeof request?.proxyHttps === "string" ? request.proxyHttps : "",
    noProxy: typeof request?.noProxy === "string" ? request.noProxy : "",
    clientCertificatePath: typeof request?.clientCertificatePath === "string" ? request.clientCertificatePath : "",
    clientKeyPath: typeof request?.clientKeyPath === "string" ? request.clientKeyPath : "",
    webSocketKeepAliveIntervalMs: Number.isFinite(request?.webSocketKeepAliveIntervalMs)
      ? Number(request.webSocketKeepAliveIntervalMs)
      : 0,
    sseWithCredentials: request?.sseWithCredentials ?? false,
    sseLastEventId: typeof request?.sseLastEventId === "string" ? request.sseLastEventId : "",
    sseRetryMs: Number.isFinite(request?.sseRetryMs) ? Number(request.sseRetryMs) : 3000,
    socketIoEventName: typeof request?.socketIoEventName === "string"
      ? request.socketIoEventName
      : (defaultSocketIoEvent?.name || "message"),
    socketIoNamespace: typeof request?.socketIoNamespace === "string" ? request.socketIoNamespace : "/",
    socketIoAckTimeoutMs: Number.isFinite(request?.socketIoAckTimeoutMs) ? Number(request.socketIoAckTimeoutMs) : 0,
    socketIoEvents,
    socketIoSelectedEventId: hasSelectedSocketIoEvent ? selectedSocketIoEventId : (defaultSocketIoEvent?.id || ""),
    folderPath: typeof request?.folderPath === "string" ? request.folderPath : "",
    scriptPreRequest: typeof request?.scriptPreRequest === "string" ? request.scriptPreRequest : "",
    scriptAfterResponse: typeof request?.scriptAfterResponse === "string" ? request.scriptAfterResponse : "",
    scriptActivePhase: request?.scriptActivePhase === "after-response" ? "after-response" : "pre-request",
    scriptLastRunAt: typeof request?.scriptLastRunAt === "string" ? request.scriptLastRunAt : "",
    scriptLastPhase: typeof request?.scriptLastPhase === "string" ? request.scriptLastPhase : "",
    scriptLastStatus: typeof request?.scriptLastStatus === "string" ? request.scriptLastStatus : "",
    scriptLastError: typeof request?.scriptLastError === "string" ? request.scriptLastError : "",
    scriptLastLogs: Array.isArray(request?.scriptLastLogs)
      ? request.scriptLastLogs.map((entry) => String(entry ?? ""))
      : [],
    scriptLastTests: Array.isArray(request?.scriptLastTests)
      ? request.scriptLastTests.map((entry) => ({
        name: String(entry?.name ?? "Unnamed test"),
        ok: Boolean(entry?.ok),
        error: typeof entry?.error === "string" ? entry.error : "",
      }))
      : [],
    scriptLastVars: request?.scriptLastVars && typeof request.scriptLastVars === "object" && !Array.isArray(request.scriptLastVars)
      ? request.scriptLastVars
      : {},
    auth: normalizeAuthState(request?.auth)
  };
}

export function cloneRequest(request) {
  return {
    ...normalizeRequestRecord(request),
    pinned: false,
    queryParams: (request.queryParams || []).map((row) => ({ ...row })),
    headers: (request.headers || []).map((row) => ({ ...row })),
    bodyRows: (request.bodyRows || []).map((row) => ({ ...row })),
    socketIoEvents: (request.socketIoEvents || []).map((event) => ({ ...event })),
    grpcDirectProtoFiles: (request.grpcDirectProtoFiles || []).map((path) => String(path)),
    grpcProtoDirectories: (request.grpcProtoDirectories || []).map((group) => ({
      path: String(group?.path || ""),
      files: Array.isArray(group?.files) ? group.files.map((path) => String(path)) : []
    })),
    tags: (request.tags || []).map((tag) => String(tag)),
    scriptPreRequest: String(request.scriptPreRequest || ""),
    scriptAfterResponse: String(request.scriptAfterResponse || ""),
    scriptActivePhase: request.scriptActivePhase === "after-response" ? "after-response" : "pre-request",
    scriptLastRunAt: String(request.scriptLastRunAt || ""),
    scriptLastPhase: String(request.scriptLastPhase || ""),
    scriptLastStatus: String(request.scriptLastStatus || ""),
    scriptLastError: String(request.scriptLastError || ""),
    scriptLastLogs: Array.isArray(request.scriptLastLogs) ? request.scriptLastLogs.map((entry) => String(entry || "")) : [],
    scriptLastTests: Array.isArray(request.scriptLastTests)
      ? request.scriptLastTests.map((entry) => ({
        name: String(entry?.name || "Unnamed test"),
        ok: Boolean(entry?.ok),
        error: String(entry?.error || ""),
      }))
      : [],
    scriptLastVars: request.scriptLastVars && typeof request.scriptLastVars === "object" && !Array.isArray(request.scriptLastVars)
      ? { ...request.scriptLastVars }
      : {},
    auth: normalizeAuthState(request.auth),
    lastResponse: request.lastResponse ? { ...request.lastResponse } : null
  };
}
