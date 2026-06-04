import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { redactHistoryUrl } from "@/lib/history-utils.js";

const AUTH_ENCRYPTION_PREFIX = "enc:v1:";
const AUTH_SENSITIVE_KEYS = new Set([
  "token",
  "password",
  "jwtToken",
  "proxyPassword",
  "apiKeyValue",
  "clientSecret",
  "accessToken",
  "refreshToken",
  "authorizationCode",
  "codeVerifier",
  "clientCertificatePath",
  "clientKeyPath",
  "customCaCertificatePath",
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64Encode(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function getAuthCryptoKey() {
  try {
    if (!window?.crypto?.subtle) return null;
    const seed = await invoke("get_or_create_auth_secret_seed");
    if (!seed) return null;

    const keyMaterial = await window.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(seed),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: textEncoder.encode("kivo-auth-encryption-salt-v1"),
        iterations: 100_000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } catch {
    return null;
  }
}

async function encryptSensitiveText(value, key) {
  const raw = String(value ?? "");
  if (!raw || raw.startsWith(AUTH_ENCRYPTION_PREFIX) || !key) return raw;

  try {
    const iv = new Uint8Array(12);
    window.crypto.getRandomValues(iv);
    const encrypted = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      textEncoder.encode(raw)
    );
    return `${AUTH_ENCRYPTION_PREFIX}${base64Encode(iv)}:${base64Encode(new Uint8Array(encrypted))}`;
  } catch {
    return raw;
  }
}

async function decryptSensitiveText(value, key) {
  const raw = String(value ?? "");
  if (!raw.startsWith(AUTH_ENCRYPTION_PREFIX) || !key) return raw;

  try {
    const payload = raw.slice(AUTH_ENCRYPTION_PREFIX.length);
    const [ivB64, cipherB64] = payload.split(":");
    if (!ivB64 || !cipherB64) return "";
    const iv = base64Decode(ivB64);
    const cipher = base64Decode(cipherB64);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      cipher
    );
    return textDecoder.decode(decrypted);
  } catch {
    return "";
  }
}

async function transformAuthNode(value, key, mode) {
  if (Array.isArray(value)) {
    const result = [];
    for (const entry of value) {
      result.push(await transformAuthNode(entry, key, mode));
    }
    return result;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue === "string" && AUTH_SENSITIVE_KEYS.has(field)) {
      output[field] = mode === "encrypt"
        ? await encryptSensitiveText(fieldValue, key)
        : await decryptSensitiveText(fieldValue, key);
    } else if (fieldValue && typeof fieldValue === "object") {
      output[field] = await transformAuthNode(fieldValue, key, mode);
    } else {
      output[field] = fieldValue;
    }
  }
  return output;
}

async function transformCollectionAuth(collection, key, mode) {
  return {
    ...collection,
    folderSettings: Array.isArray(collection?.folderSettings)
      ? await Promise.all(collection.folderSettings.map(async (setting) => ({
        ...setting,
        defaultAuth: setting?.defaultAuth
          ? await transformAuthNode(setting.defaultAuth, key, mode)
          : setting?.defaultAuth,
      })))
      : collection?.folderSettings,
    requests: Array.isArray(collection?.requests)
      ? await Promise.all(collection.requests.map(async (request) => ({
        ...request,
        auth: request?.auth ? await transformAuthNode(request.auth, key, mode) : request?.auth,
      })))
      : collection?.requests,
  };
}

async function transformStateAuth(payload, mode) {
  const key = await getAuthCryptoKey();
  if (!payload || typeof payload !== "object") return payload;

  return {
    ...payload,
    appSettings: payload.appSettings
      ? await transformAuthNode(payload.appSettings, key, mode)
      : payload.appSettings,
    workspaces: Array.isArray(payload.workspaces)
      ? await Promise.all(payload.workspaces.map(async (workspace) => ({
        ...workspace,
        collections: Array.isArray(workspace?.collections)
          ? await Promise.all(workspace.collections.map((collection) => transformCollectionAuth(collection, key, mode)))
          : workspace?.collections,
      })))
      : payload.workspaces,
  };
}

async function transformCollectionConfigAuth(config, mode) {
  const key = await getAuthCryptoKey();
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    defaultAuth: config.defaultAuth ? await transformAuthNode(config.defaultAuth, key, mode) : config.defaultAuth,
  };
}

export function sendHttpRequest(payload) {
  return invoke("send_http_request", { payload });
}

export function sendGrpcRequest(payload) {
  return invoke("send_grpc_request", { payload });
}

export function reflectGrpcServer(payload) {
  return invoke("reflect_grpc_server", { payload });
}

function sanitizeLastResponseForSave(lastResponse) {
  if (!lastResponse || typeof lastResponse !== "object") {
    return null;
  }

  const headers = lastResponse.headers && typeof lastResponse.headers === "object" && !Array.isArray(lastResponse.headers)
    ? Object.fromEntries(Object.entries(lastResponse.headers).map(([k, v]) => [String(k), String(v ?? "")]))
    : {};

  const cookies = Array.isArray(lastResponse.cookies)
    ? lastResponse.cookies.map((cookie) => String(cookie ?? ""))
    : [];

  const meta = lastResponse.meta && typeof lastResponse.meta === "object"
    ? {
      url: redactHistoryUrl(lastResponse.meta.url ?? "-"),
      method: String(lastResponse.meta.method ?? "-"),
    }
    : { url: "-", method: "-" };

  return {
    status: Number.isFinite(lastResponse.status) ? Number(lastResponse.status) : 0,
    badge: String(lastResponse.badge ?? ""),
    statusText: String(lastResponse.statusText ?? ""),
    duration: String(lastResponse.duration ?? "-"),
    size: String(lastResponse.size ?? "0 B"),
    headers,
    cookies,
    body: String(lastResponse.body ?? ""),
    rawBody: String(lastResponse.rawBody ?? ""),
    bodyBase64: String(lastResponse.bodyBase64 ?? ""),
    isBinary: Boolean(lastResponse.isBinary),
    contentType: String(lastResponse.contentType ?? ""),
    isJson: Boolean(lastResponse.isJson),
    meta,
    savedAt: String(lastResponse.savedAt ?? ""),
  };
}

function sanitizeRequestForSave(request, options = {}) {
  const bodyType = String(request?.bodyType ?? "json");
  const requestMode = String(request?.requestMode ?? "http");
  const persistLastResponse = Boolean(options.persistLastResponse);

  const sanitized = {
    name: String(request?.name ?? ""),
    requestMode,
    pinned: Boolean(request?.pinned),
    method: String(request?.method ?? "GET"),
    url: String(request?.url ?? ""),
    queryParams: Array.isArray(request?.queryParams) ? request.queryParams : [],
    headers: Array.isArray(request?.headers) ? request.headers : [],
    auth: sanitizeAuthForSave(request?.auth),
    bodyType,
    docs: String(request?.docs ?? ""),
    activeEditorTab: String(request?.activeEditorTab ?? "Params"),
    activeResponseTab: String(request?.activeResponseTab ?? "Body"),
    responseBodyView: String(request?.responseBodyView ?? "JSON"),
    inheritHeaders: request?.inheritHeaders ?? false,
    tags: Array.isArray(request?.tags) ? request.tags.map((tag) => String(tag)) : [],
    urlEncoding: request?.urlEncoding ?? true,
    followRedirects: request?.followRedirects ?? true,
    maxRedirects: Number.isFinite(request?.maxRedirects) ? Number(request.maxRedirects) : 5,
    timeoutMs: Number.isFinite(request?.timeoutMs) ? Number(request.timeoutMs) : 0,
    useCookieJar: request?.useCookieJar ?? true,
    proxyMode: String(request?.proxyMode ?? "inherit"),
    proxyHttp: String(request?.proxyHttp ?? ""),
    proxyHttps: String(request?.proxyHttps ?? ""),
    noProxy: String(request?.noProxy ?? ""),
    clientCertificatePath: String(request?.clientCertificatePath ?? ""),
    clientKeyPath: String(request?.clientKeyPath ?? ""),
    folderPath: String(request?.folderPath ?? ""),
    scriptPreRequest: String(request?.scriptPreRequest ?? ""),
    scriptAfterResponse: String(request?.scriptAfterResponse ?? ""),
    scriptActivePhase: request?.scriptActivePhase === "after-response" ? "after-response" : "pre-request",
    scriptLastRunAt: String(request?.scriptLastRunAt ?? ""),
    scriptLastPhase: String(request?.scriptLastPhase ?? ""),
    scriptLastStatus: String(request?.scriptLastStatus ?? ""),
    scriptLastError: String(request?.scriptLastError ?? ""),
    scriptLastLogs: Array.isArray(request?.scriptLastLogs)
      ? request.scriptLastLogs.map((entry) => String(entry ?? ""))
      : [],
    scriptLastTests: Array.isArray(request?.scriptLastTests)
      ? request.scriptLastTests.map((entry) => ({
        name: String(entry?.name ?? "Unnamed test"),
        ok: Boolean(entry?.ok),
        error: String(entry?.error ?? ""),
      }))
      : [],
    scriptLastVars: request?.scriptLastVars && typeof request.scriptLastVars === "object" && !Array.isArray(request.scriptLastVars)
      ? request.scriptLastVars
      : {},
    lastResponse: persistLastResponse ? sanitizeLastResponseForSave(request?.lastResponse) : null
  };

  if (requestMode === "grpc") {
    sanitized.grpcProtoFilePath = String(request?.grpcProtoFilePath ?? "");
    sanitized.grpcMethodPath = String(request?.grpcMethodPath ?? "");
    sanitized.grpcStreamingMode = String(request?.grpcStreamingMode ?? "bidi");
    sanitized.grpcDirectProtoFiles = Array.isArray(request?.grpcDirectProtoFiles)
      ? request.grpcDirectProtoFiles.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    sanitized.grpcProtoDirectories = Array.isArray(request?.grpcProtoDirectories)
      ? request.grpcProtoDirectories
        .map((group) => ({
          path: String(group?.path || "").trim(),
          files: Array.isArray(group?.files)
            ? group.files.map((path) => String(path || "").trim()).filter(Boolean)
            : []
        }))
        .filter((group) => group.path)
      : [];
  }

  if (bodyType === "form-data" || bodyType === "form-urlencoded") {
    sanitized.bodyRows = Array.isArray(request?.bodyRows) ? request.bodyRows : [];
  } else if (bodyType === "file") {
    sanitized.bodyFilePath = String(request?.bodyFilePath ?? "");
  } else if (bodyType === "graphql") {
    sanitized.body = sanitizeRequestBodyForSave(request);
    sanitized.graphqlVariables = sanitizeGraphqlVariablesForSave(request);
  } else if (bodyType !== "none") {
    sanitized.body = sanitizeRequestBodyForSave(request);
  }

  return sanitized;
}

export function cancelHttpRequest(requestId) {
  return invoke("cancel_http_request", { requestId });
}

export function getCookieJar(workspaceName, collectionName) {
  return invoke("get_cookie_jar", {
    workspaceName: workspaceName || null,
    collectionName: collectionName || null,
  });
}

export function deleteCookieJarEntry(id) {
  return invoke("delete_cookie_jar_entry", { id });
}

export function clearCookieJar(workspaceName, collectionName) {
  return invoke("clear_cookie_jar", {
    workspaceName: workspaceName || null,
    collectionName: collectionName || null,
  });
}

export function upsertCookieJarEntry(payload) {
  return invoke("upsert_cookie_jar_entry", { payload });
}

export function exchangeOAuthToken(payload) {
  return invoke("oauth_exchange_token", { payload });
}

export function waitForOAuthCallback(payload) {
  return invoke("wait_for_oauth_callback", { payload });
}

export function cancelOAuthExchange(requestId) {
  return invoke("cancel_oauth_exchange", { requestId });
}

export async function loadAppState() {
  const state = await invoke("load_app_state");
  return transformStateAuth(state, "decrypt");
}

export async function getAppSettings() {
  const key = await getAuthCryptoKey();
  const settings = await invoke("get_app_settings");
  return transformAuthNode(settings, key, "decrypt");
}

export async function setAppSettings(settings) {
  const key = await getAuthCryptoKey();
  const encryptedSettings = await transformAuthNode(settings, key, "encrypt");
  return invoke("set_app_settings", { settings: encryptedSettings })
    .then((saved) => transformAuthNode(saved, key, "decrypt"));
}

function sanitizeAuthForSave(auth) {
  const authType = String(auth?.type || "none");

  if (authType === "none" || authType === "inherit") {
    return { type: authType };
  }

  if (authType === "bearer") {
    return {
      type: "bearer",
      token: String(auth?.token ?? "")
    };
  }

  if (authType === "jwt") {
    return {
      type: "jwt",
      jwtToken: String(auth?.jwtToken ?? auth?.token ?? "")
    };
  }

  if (authType === "basic") {
    return {
      type: "basic",
      username: String(auth?.username ?? ""),
      password: String(auth?.password ?? "")
    };
  }

  if (authType === "digest") {
    return {
      type: "digest",
      username: String(auth?.username ?? ""),
      password: String(auth?.password ?? ""),
      digestRealm: String(auth?.digestRealm ?? ""),
      digestNonce: String(auth?.digestNonce ?? ""),
      digestQop: String(auth?.digestQop ?? "auth"),
      digestAlgorithm: String(auth?.digestAlgorithm ?? "SHA-256")
    };
  }

  if (authType === "apikey") {
    return {
      type: "apikey",
      apiKeyName: String(auth?.apiKeyName ?? ""),
      apiKeyValue: String(auth?.apiKeyValue ?? ""),
      apiKeyIn: String(auth?.apiKeyIn ?? "header")
    };
  }

  if (authType === "oauth2") {
    return {
      type: "oauth2",
      oauth2: auth?.oauth2 && typeof auth.oauth2 === "object" ? auth.oauth2 : {}
    };
  }

  return { type: "none" };
}

function sanitizeGraphqlVariablesForSave(request) {
  const raw = request?.graphqlVariables;

  if (request?.bodyType !== "graphql") {
    return "";
  }

  if (typeof raw !== "string") {
    return raw;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function sanitizeRequestBodyForSave(request) {
  const raw = request?.body;
  const bodyType = request?.bodyType;

  if (bodyType === "graphql" || bodyType === "json") {
    return raw;
  }

  return raw;
}

export async function saveAppState(payload) {
  const persistLastResponse = Boolean(payload?.appSettings?.storeLastResponseByDefault);
  const cleanPayload = {
    ...payload,
    requestHistory: Array.isArray(payload.requestHistory) ? payload.requestHistory.slice(0, 500) : [],
    workspaces: payload.workspaces?.map((workspace) => ({
      ...workspace,
      collections: workspace.collections?.map((collection) => ({
        ...collection,
        requests: collection.requests?.map((request) => sanitizeRequestForSave(request, { persistLastResponse }))
      }))
    }))
  };

  const encryptedPayload = await transformStateAuth(cleanPayload, "encrypt");
  return invoke("save_app_state", { payload: encryptedPayload });
}

export function getEnvVars(workspaceName, collectionName, workspaceEnvironmentId = null) {
  return invoke("get_env_vars", {
    workspaceName,
    collectionName: collectionName || null,
    workspaceEnvironmentId: workspaceEnvironmentId || null,
  });
}

export function parseGrpcProtoFile(filePath) {
  return invoke("parse_grpc_proto_file", { filePath });
}

export function listGrpcProtoFilesInDirectory(dirPath) {
  return invoke("list_grpc_proto_files_in_directory", { dirPath });
}

export function saveEnvVars(workspaceName, collectionName, vars, workspaceEnvironmentId = null) {
  return invoke("save_env_vars", {
    workspaceName,
    collectionName: collectionName || null,
    workspaceEnvironmentId: workspaceEnvironmentId || null,
    vars,
  });
}

export function getWorkspaceEnvironments(workspaceName) {
  return invoke("get_workspace_environments_cmd", {
    workspaceName,
  });
}

export function createWorkspaceEnvironment(workspaceName, name) {
  return invoke("create_workspace_environment_cmd", {
    workspaceName,
    name,
  });
}

export function setActiveWorkspaceEnvironment(workspaceName, environmentId) {
  return invoke("set_active_workspace_environment_cmd", {
    workspaceName,
    environmentId,
  });
}

export function deleteWorkspaceEnvironment(workspaceName, environmentId) {
  return invoke("delete_workspace_environment_cmd", {
    workspaceName,
    environmentId,
  });
}

export function getCollectionConfig(workspaceName, collectionName) {
  return invoke("get_collection_config", { workspaceName, collectionName })
    .then((config) => transformCollectionConfigAuth(config, "decrypt"));
}

export async function saveCollectionConfig(workspaceName, collectionName, config) {
  const encryptedConfig = await transformCollectionConfigAuth(config, "encrypt");
  return invoke("save_collection_config", { workspaceName, collectionName, config: encryptedConfig });
}

export function getResolvedStoragePath() {
  return invoke("get_resolved_storage_path");
}

export function validateStoragePath(path) {
  return invoke("validate_storage_path", { path });
}

export function switchStoragePath(path, mode) {
  return invoke("switch_storage_path", { payload: { path, mode } });
}

export function importCollectionFile(filePath) {
  return invoke("import_collection_file", { filePath });
}

export function importRequestFile(filePath) {
  return invoke("import_request_file", { filePath });
}

export function exportCollectionFile(filePath, format, name, collection, options = null) {
  return invoke("export_collection_file", {
    filePath,
    format,
    name,
    collection,
    options,
  });
}

export function exportRequestFile(filePath, format, name, request, options = null) {
  return invoke("export_request_file", {
    filePath,
    format,
    name,
    request,
    options,
  });
}

export function exportResponseFile(filePath, response) {
  return invoke("export_response_file", {
    filePath,
    response,
  });
}

const REALTIME_EVENT_CHANNEL = "realtime:event";
const realtimeListenersByStream = new Map();
const realtimePendingEventsByStream = new Map();
const REALTIME_PENDING_CAP = 500;
const REALTIME_PENDING_TTL_MS = 30_000;
let realtimeUnlistenPromise = null;

function dropPendingEvents(streamId) {
  realtimePendingEventsByStream.delete(streamId);
}

function ensureRealtimeBridge() {
  if (realtimeUnlistenPromise) return realtimeUnlistenPromise;
  realtimeUnlistenPromise = listen(REALTIME_EVENT_CHANNEL, (envelope) => {
    const payload = envelope?.payload;
    if (!payload || typeof payload !== "object") return;
    const streamId = String(payload.streamId || "");
    if (!streamId) return;
    const handlers = realtimeListenersByStream.get(streamId);
    if (handlers && handlers.size > 0) {
      handlers.forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          console.error("[realtime] handler error:", error);
        }
      });
      return;
    }
    let queue = realtimePendingEventsByStream.get(streamId);
    if (!queue) {
      queue = { events: [], timer: null };
      realtimePendingEventsByStream.set(streamId, queue);
    }
    queue.events.push(payload);
    if (queue.events.length > REALTIME_PENDING_CAP) {
      queue.events.splice(0, queue.events.length - REALTIME_PENDING_CAP);
    }
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
    queue.timer = setTimeout(() => dropPendingEvents(streamId), REALTIME_PENDING_TTL_MS);
  }).catch((error) => {
    console.error("[realtime] failed to attach listener:", error);
    realtimeUnlistenPromise = null;
    return () => {};
  });
  return realtimeUnlistenPromise;
}

// Eagerly attach the bridge so events emitted before the first subscriber are not lost.
ensureRealtimeBridge();

export function subscribeRealtime(streamId, handler) {
  const id = String(streamId || "").trim();
  if (!id || typeof handler !== "function") return () => {};
  ensureRealtimeBridge();
  let handlers = realtimeListenersByStream.get(id);
  if (!handlers) {
    handlers = new Set();
    realtimeListenersByStream.set(id, handlers);
  }
  handlers.add(handler);

  const queue = realtimePendingEventsByStream.get(id);
  if (queue) {
    if (queue.timer) {
      clearTimeout(queue.timer);
    }
    realtimePendingEventsByStream.delete(id);
    for (const payload of queue.events) {
      try {
        handler(payload);
      } catch (error) {
        console.error("[realtime] handler error replaying buffered event:", error);
      }
    }
  }

  return () => {
    const current = realtimeListenersByStream.get(id);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      realtimeListenersByStream.delete(id);
    }
  };
}

export function realtimeConnectWebSocket(payload) {
  return invoke("realtime_connect_websocket", { payload });
}

export function realtimeConnectSse(payload) {
  return invoke("realtime_connect_sse", { payload });
}

export function realtimeConnectSocketIo(payload) {
  return invoke("realtime_connect_socketio", { payload });
}

export function realtimeSend(streamId, kind, data) {
  return invoke("realtime_send", {
    payload: {
      streamId: String(streamId || ""),
      kind: String(kind || "text"),
      data: data == null ? "" : String(data),
    },
  });
}

export function realtimeEmitSocketIo(streamId, event, data) {
  return invoke("realtime_emit_socketio", {
    payload: {
      streamId: String(streamId || ""),
      event: String(event || ""),
      data: data == null ? "" : String(data),
    },
  });
}

export function realtimeDisconnect(streamId, code, reason) {
  return invoke("realtime_disconnect", {
    payload: {
      streamId: String(streamId || ""),
      code: typeof code === "number" ? code : null,
      reason: reason == null ? null : String(reason),
    },
  });
}

