import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";

import {
  cancelHttpRequest,
  exchangeOAuthToken,
  getCollectionConfig,
  loadAppState,
  realtimeConnectSocketIo,
  realtimeConnectSse,
  realtimeConnectWebSocket,
  realtimeDisconnect,
  realtimeEmitSocketIo,
  realtimeSend,
  saveAppState,
  saveCollectionConfig,
  sendGrpcRequest,
  sendHttpRequest,
  subscribeRealtime,
} from "@/lib/http-client.js";
import { buildRequestPayload, buildUrlWithParams, serializeHeaders } from "@/lib/http-ui.js";
import {
  cloneRequest,
  createCollection,
  createDefaultStore,
  createEmptyResponse,
  createRequest,
  REQUEST_MODES,
  createWorkspace,
  formatSavedAt,
  getActiveCollection,
  getActiveRequest,
  getActiveWorkspace,
  getUniqueName,
  orderRequests
} from "@/lib/workspace-store.js";
import { clampSidebarWidth, normalizeStore, parseCookies } from "@/lib/workspace-utils.js";
import { formatResponseBody, isJsonText } from "@/lib/formatters.js";
import { normalizeUrl } from "@/lib/http-ui.js";
import { normalizeAuthState } from "@/lib/oauth.js";
import { runRequestScript } from "@/lib/request-scripts.js";
import { redactHistoryUrl } from "@/lib/history-utils.js";

const SIDEBAR_COLLAPSED_WIDTH = 52;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_REOPEN_WIDTH = 260;

function buildRealtimeAuthPayload(auth) {
  const next = auth && typeof auth === "object" ? auth : { type: "none" };
  return {
    type: String(next.type || "none"),
    token: String(next.token ?? ""),
    username: String(next.username ?? ""),
    password: String(next.password ?? ""),
    apiKeyName: String(next.apiKeyName ?? ""),
    apiKeyValue: String(next.apiKeyValue ?? ""),
    apiKeyIn: String(next.apiKeyIn ?? "header"),
    accessToken: String(next?.oauth2?.accessToken ?? ""),
    tokenType: String(next?.oauth2?.tokenType ?? ""),
  };
}

function buildRealtimeHeadersObject(headerRows = []) {
  const headers = {};
  for (const row of Array.isArray(headerRows) ? headerRows : []) {
    if (!row || !row.enabled) continue;
    const key = String(row.key || "").trim();
    if (!key) continue;
    headers[key] = String(row.value ?? "");
  }
  return headers;
}

function buildRealtimePayload(request, workspaceName, collectionName, extras = {}) {
  return {
    url: String(request?.url ?? ""),
    headers: buildRealtimeHeadersObject(request?.headers),
    auth: buildRealtimeAuthPayload(request?.auth),
    workspaceName: String(workspaceName ?? ""),
    collectionName: String(collectionName ?? ""),
    useCookieJar: request?.useCookieJar ?? true,
    timeoutMs: Number.isFinite(request?.timeoutMs) ? Number(request.timeoutMs) : null,
    disableUserAgent: false,
    ...extras,
  };
}

function realtimeMessageBytes(text) {
  try {
    return new TextEncoder().encode(String(text ?? "")).length;
  } catch {
    return String(text ?? "").length;
  }
}

function normalizeFolderPath(path) {
  return String(path ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function toErrorText(error) {
  if (typeof error === "string") return error;
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  if (typeof error?.toString === "function") return error.toString();
  return "";
}

function buildFriendlyRequestErrorMessage(error, fallbackMessage = "Request failed") {
  const raw = String(toErrorText(error) || "").trim();
  const normalized = raw.replace(/^error:\s*/i, "").trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return `Error: ${fallbackMessage}`;
  }

  if (
    lower.includes("connection refused")
    || lower.includes("actively refused")
    || lower.includes("tcp connect error")
    || lower.includes("failed to connect")
    || lower.includes("couldn't connect")
    || lower.includes("could not connect")
  ) {
    return "Error: Couldn't connect to server";
  }

  if (
    lower.includes("timed out")
    || lower.includes("timeout")
    || lower.includes("deadline has elapsed")
  ) {
    return "Error: Request timed out";
  }

  if (
    lower.includes("failed to lookup address")
    || lower.includes("could not resolve host")
    || lower.includes("no such host")
    || lower.includes("name or service not known")
    || lower.includes("dns")
  ) {
    return "Error: Couldn't resolve host";
  }

  if (
    lower.includes("certificate")
    || lower.includes("tls")
    || lower.includes("ssl")
    || lower.includes("x509")
  ) {
    return "Error: TLS/SSL certificate error";
  }

  if (lower.includes("proxy") || lower.includes("tunnel")) {
    return "Error: Proxy connection failed";
  }

  if (lower.includes("invalid url") || lower.includes("relative url without a base")) {
    return "Error: Invalid request URL";
  }

  if (
    lower.includes("network is unreachable")
    || lower.includes("connection reset")
    || lower.includes("broken pipe")
  ) {
    return "Error: Network connection failed";
  }

  const causedByIndex = lower.indexOf("caused by:");
  const detailSource = causedByIndex >= 0
    ? normalized.slice(causedByIndex + "caused by:".length).trim()
    : normalized;
  const detail = detailSource
    .split(/\r?\n/)[0]
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s*->\s*/g, " -> ")
    .replace(/\(os error\s+\d+\)/ig, "")
    .trim();

  if (!detail) {
    return `Error: ${fallbackMessage}`;
  }

  return `Error: ${detail}`;
}

function clearOAuthTokensFromAuth(auth) {
  if (!auth || typeof auth !== "object") return auth;
  if (auth.type !== "oauth2" || !auth.oauth2 || typeof auth.oauth2 !== "object") {
    return auth;
  }
  return {
    ...auth,
    oauth2: {
      ...auth.oauth2,
      accessToken: "",
      refreshToken: "",
      authorizationCode: "",
      expiresAt: "",
      lastStatus: "token-cleared",
      lastError: "",
      lastWarning: "",
    },
  };
}

function clearOAuthSessionsInStore(store) {
  if (!store || typeof store !== "object") return store;
  return {
    ...store,
    workspaces: Array.isArray(store.workspaces)
      ? store.workspaces.map((workspace) => ({
        ...workspace,
        collections: Array.isArray(workspace?.collections)
          ? workspace.collections.map((collection) => ({
            ...collection,
            folderSettings: Array.isArray(collection?.folderSettings)
              ? collection.folderSettings.map((setting) => ({
                ...setting,
                defaultAuth: clearOAuthTokensFromAuth(setting?.defaultAuth),
              }))
              : collection?.folderSettings,
            requests: Array.isArray(collection?.requests)
              ? collection.requests.map((request) => ({
                ...request,
                auth: clearOAuthTokensFromAuth(request?.auth),
              }))
              : collection?.requests,
          }))
          : workspace?.collections,
      }))
      : store.workspaces,
  };
}

function shouldAutoRefreshOAuth(oauth) {
  if (!oauth || typeof oauth !== "object") return false;
  if (!String(oauth.accessToken || "").trim()) return false;
  if (!String(oauth.refreshToken || "").trim()) return false;
  if (!String(oauth.tokenUrl || "").trim()) return false;
  const expiresAtMs = Date.parse(String(oauth.expiresAt || ""));
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs <= Date.now() + 15000;
}

function normalizeScriptVarsForState(vars) {
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
    return {};
  }

  function toSerializable(value) {
    if (typeof value === "function") {
      return "[Function]";
    }
    if (typeof value === "symbol") {
      return String(value);
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value === undefined) {
      return "undefined";
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  return Object.entries(vars).reduce((accumulator, [key, value]) => {
    accumulator[String(key)] = toSerializable(value);
    return accumulator;
  }, {});
}

function normalizeScriptTestsForState(tests) {
  if (!Array.isArray(tests)) {
    return [];
  }

  return tests.map((entry) => ({
    name: String(entry?.name || "Unnamed test"),
    ok: Boolean(entry?.ok),
    error: String(entry?.error || ""),
  }));
}

function buildScriptStatePatch(phase, run, savedAt) {
  const phaseLabel = phase === "after-response" ? "After-response" : "Pre-request";
  const tests = normalizeScriptTestsForState(run?.tests);
  const failedTests = tests.filter((entry) => !entry.ok);
  const testFailureMessage = failedTests.length > 0
    ? failedTests.map((entry) => `${entry.name}: ${entry.error || "Failed"}`).join("\n")
    : "";
  const runtimeError = !run?.ok ? `${phaseLabel} script failed: ${run?.error || "Unknown error"}` : "";
  const testError = run?.ok && testFailureMessage ? `${phaseLabel} tests failed:\n${testFailureMessage}` : "";
  const scriptLastError = runtimeError || testError;

  return {
    scriptLastRunAt: savedAt,
    scriptLastPhase: phase,
    scriptLastStatus: scriptLastError ? "error" : "success",
    scriptLastError,
    scriptLastLogs: Array.isArray(run?.logs) ? run.logs.map((entry) => String(entry || "")) : [],
    scriptLastTests: tests,
    scriptLastVars: normalizeScriptVarsForState(run?.context?.vars),
  };
}

function parseSocketIoEventPacket(rawMessage) {
  const message = String(rawMessage ?? "");
  if (!message.startsWith("42")) return null;

  let payloadText = message.slice(2);
  let namespace = "/";

  if (payloadText.startsWith("/")) {
    const commaIndex = payloadText.indexOf(",");
    if (commaIndex <= 0) return null;
    namespace = payloadText.slice(0, commaIndex) || "/";
    payloadText = payloadText.slice(commaIndex + 1);
  }

  try {
    const payload = JSON.parse(payloadText);
    if (!Array.isArray(payload) || payload.length === 0) return null;
    const eventName = String(payload[0] || "message").trim() || "message";
    return {
      namespace,
      eventName,
      payload,
      pretty: JSON.stringify(payload, null, 2)
    };
  } catch {
    return null;
  }
}

function buildSseUrl(rawUrl, queryParams = []) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return "";

  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const parsed = new URL(normalized);
    queryParams.forEach((row) => {
      if (row?.enabled && String(row.key || "").trim()) {
        parsed.searchParams.append(String(row.key).trim(), String(row.value || ""));
      }
    });
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function buildSocketIoWebSocketUrl(rawUrl, queryParams = []) {
  const baseUrl = buildWebSocketUrl(rawUrl, queryParams);
  if (!baseUrl) return "";

  try {
    const parsed = new URL(baseUrl);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/socket.io/";
    }
    if (!parsed.searchParams.has("EIO")) {
      parsed.searchParams.set("EIO", "4");
    }
    parsed.searchParams.set("transport", "websocket");
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

function getFolderAncestors(folderPath) {
  const normalized = normalizeFolderPath(folderPath);
  if (!normalized) return [];
  const segments = normalized.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

function renamePathPrefix(path, oldPrefix, newPrefix) {
  if (path === oldPrefix) return newPrefix;
  if (path.startsWith(`${oldPrefix}/`)) {
    return `${newPrefix}${path.slice(oldPrefix.length)}`;
  }
  return path;
}

function resolveFolderHeaderRows(collection, folderPath) {
  const folderSettings = Array.isArray(collection?.folderSettings) ? collection.folderSettings : [];
  return getFolderAncestors(folderPath).flatMap((path) => {
    const setting = folderSettings.find((entry) => normalizeFolderPath(entry?.path) === path);
    return Array.isArray(setting?.defaultHeaders) ? setting.defaultHeaders : [];
  });
}

function resolveFolderAuth(collection, folderPath) {
  const folderSettings = Array.isArray(collection?.folderSettings) ? collection.folderSettings : [];
  const ancestors = getFolderAncestors(folderPath);

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const setting = folderSettings.find((entry) => normalizeFolderPath(entry?.path) === ancestors[index]);
    if (!setting) continue;
    const auth = normalizeAuthState(setting.defaultAuth ?? { type: "inherit" });
    if (auth.type && auth.type !== "inherit") {
      return auth;
    }
  }

  return { type: "inherit" };
}

function getFolderParentPath(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized.includes("/")) return "";
  return normalized.split("/").slice(0, -1).join("/");
}

function getFolderLabel(path) {
  const normalized = normalizeFolderPath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || normalized;
}

function getRequestBaseNameByMode(mode) {
  switch (mode) {
    case REQUEST_MODES.SSE:
      return "SSE Request";
    case REQUEST_MODES.GRAPHQL:
      return "GraphQL Request";
    case REQUEST_MODES.GRPC:
      return "gRPC Request";
    case REQUEST_MODES.WEBSOCKET:
      return "WebSocket Request";
    case REQUEST_MODES.SOCKET_IO:
      return "Socket.IO Request";
    case REQUEST_MODES.HTTP:
    default:
      return "HTTP Request";
  }
}

function updateRequestWithLocalResponse(current, requestName, savedResponse, responseBodyView = "Raw") {
  return {
    ...current,
    workspaces: current.workspaces.map((workspace) => {
      if (workspace.name !== current.activeWorkspaceName) return workspace;
      return {
        ...workspace,
        collections: workspace.collections.map((collection) => {
          if (collection.name !== current.activeCollectionName) return collection;
          return {
            ...collection,
            requests: collection.requests.map((request) => (
              request.name === requestName
                ? { ...request, responseBodyView, lastResponse: savedResponse }
                : request
            ))
          };
        })
      };
    })
  };
}

function updateRequestScriptStateByIdentity(current, workspaceName, collectionName, requestName, patch = {}) {
  return {
    ...current,
    workspaces: current.workspaces.map((workspace) => {
      if (workspace.name !== workspaceName) return workspace;
      return {
        ...workspace,
        collections: workspace.collections.map((collection) => {
          if (collection.name !== collectionName) return collection;
          return {
            ...collection,
            requests: collection.requests.map((request) => (
              request.name === requestName
                ? { ...request, ...patch }
                : request
            ))
          };
        })
      };
    })
  };
}

function updateRequestWithLocalResponseByIdentity(current, workspaceName, collectionName, requestName, savedResponse, responseBodyView = "Raw") {
  return {
    ...current,
    workspaces: current.workspaces.map((workspace) => {
      if (workspace.name !== workspaceName) return workspace;
      return {
        ...workspace,
        collections: workspace.collections.map((collection) => {
          if (collection.name !== collectionName) return collection;
          return {
            ...collection,
            requests: collection.requests.map((request) => (
              request.name === requestName
                ? { ...request, responseBodyView, lastResponse: savedResponse }
                : request
            ))
          };
        })
      };
    })
  };
}

function buildRequestKey(workspaceName, collectionName, requestName) {
  return `${workspaceName}::${collectionName}::${requestName}`;
}

function toWebSocketUrl(url) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return "";

  if (/^wss?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^http/i, "ws");
  }
  return `wss://${trimmed}`;
}

function buildWebSocketUrl(rawUrl, queryParams = []) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return "";

  const baseUrl = toWebSocketUrl(trimmed);
  try {
    const parsed = new URL(baseUrl);
    queryParams.forEach((row) => {
      if (row?.enabled && String(row.key || "").trim()) {
        parsed.searchParams.append(String(row.key).trim(), String(row.value || ""));
      }
    });
    return parsed.toString();
  } catch {
    return baseUrl;
  }
}

export function useWorkspaceStore() {
  const [store, setStore] = useState(createDefaultStore());
  const [isSending, setIsSending] = useState(false);
  const [sendStartedAt, setSendStartedAt] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isSetupComplete, setIsSetupComplete] = useState(true);
  const [starCount, setStarCount] = useState(null);
  const saveTimerRef = useRef(null);
  const resizeRef = useRef({ active: false, startX: 0, startWidth: 304 });
  const activeHttpRequestIdRef = useRef("");
  const wsConnectionsRef = useRef(new Map());
  const wsKeepAliveTimersRef = useRef(new Map());
  const wsConnectTimeoutsRef = useRef(new Map());
  const sseConnectionsRef = useRef(new Map());
  const socketIoConnectionsRef = useRef(new Map());
  const [wsStates, setWsStates] = useState({});
  const [streamMessages, setStreamMessages] = useState({});
  const streamKeyByIdRef = useRef(new Map());
  const messageIdCounterRef = useRef(0);

  useEffect(() => {
    async function checkSetup() {
      try {
        const config = await invoke("get_app_config");
        setIsSetupComplete(!!config.storagePath);
      } catch (error) {
        console.error("Failed to check setup status:", error);
      }
    }
    checkSetup();
  }, []);

  const activeWorkspace = useMemo(() => getActiveWorkspace(store), [store]);
  const activeCollection = useMemo(() => getActiveCollection(store), [store]);
  const activeRequest = useMemo(() => getActiveRequest(store), [store]);

  const requestTabs = useMemo(() => {
    if (!activeCollection) {
      return [];
    }

    const openNames = new Set(activeCollection.openRequestNames || []);
    return activeCollection.requests.filter((request) => openNames.has(request.name));
  }, [activeCollection]);

  const response = activeRequest?.lastResponse ?? createEmptyResponse();

  useEffect(() => {
    async function fetchStars() {
      try {
        const res = await fetch("https://api.github.com/repos/DevlogZz/Kivo");
        const data = await res.json();
        if (data.stargazers_count !== undefined) {
          setStarCount(data.stargazers_count);
        }
      } catch (error) {
        console.error("Failed to fetch star count:", error);
      }
    }

    fetchStars();
  }, []);

  useEffect(() => {
    if (!isSetupComplete) return;
    let cancelled = false;

    async function hydrate() {
      try {
        const persisted = await loadAppState();
        let normalized = normalizeStore(persisted);

        if (normalized?.appSettings?.clearOAuthSessionOnStart) {
          normalized = clearOAuthSessionsInStore(normalized);

          const collectionPairs = [];
          for (const workspace of normalized.workspaces || []) {
            for (const collection of workspace?.collections || []) {
              if (workspace?.name && collection?.name) {
                collectionPairs.push({ workspaceName: workspace.name, collectionName: collection.name });
              }
            }
          }

          await Promise.all(collectionPairs.map(async ({ workspaceName, collectionName }) => {
            try {
              const config = await getCollectionConfig(workspaceName, collectionName);
              if (!config || typeof config !== "object") return;
              const nextConfig = {
                ...config,
                defaultAuth: clearOAuthTokensFromAuth(config.defaultAuth),
              };
              await saveCollectionConfig(workspaceName, collectionName, nextConfig);
            } catch {
            }
          }));
        }

        normalized = {
          ...normalized,
          sidebarTab: "requests",
        };

        if (!cancelled) {
          setStore(normalized);
        }
      } catch {
        if (!cancelled) {
          setStore(createDefaultStore());
        }
      } finally {
        if (!cancelled) {
          setIsHydrated(true);
        }
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [isSetupComplete]);

  useEffect(() => {
    function handleMove(event) {
      if (!resizeRef.current.active) {
        return;
      }

      const rawWidth = resizeRef.current.startWidth + (event.clientX - resizeRef.current.startX);

      setStore((current) => {
        if (rawWidth <= SIDEBAR_MIN_WIDTH) {
          return {
            ...current,
            sidebarCollapsed: true,
            sidebarWidth: Math.max(current.sidebarWidth, SIDEBAR_REOPEN_WIDTH)
          };
        }

        return {
          ...current,
          sidebarCollapsed: false,
          sidebarWidth: clampSidebarWidth(rawWidth)
        };
      });
    }

    function handleUp() {
      resizeRef.current.active = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);

    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return undefined;
    }

    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveAppState(store).catch((err) => { console.error("saveAppState failed:", err); });
    }, 300);

    return () => {
      window.clearTimeout(saveTimerRef.current);
    };
  }, [isHydrated, store]);

  useEffect(() => {
    function handleAppSettingsUpdated(event) {
      const nextSettings = event?.detail;
      if (!nextSettings || typeof nextSettings !== "object") {
        return;
      }
      setStore((current) => ({
        ...current,
        appSettings: {
          ...(current?.appSettings || {}),
          ...nextSettings,
        },
      }));
    }

    window.addEventListener("kivo-app-settings-updated", handleAppSettingsUpdated);
    return () => {
      window.removeEventListener("kivo-app-settings-updated", handleAppSettingsUpdated);
    };
  }, []);

  useEffect(() => () => {
    const maps = [wsConnectionsRef, sseConnectionsRef, socketIoConnectionsRef];
    for (const ref of maps) {
      ref.current.forEach((handle) => {
        try { handle?.unsubscribe?.(); } catch {}
        if (handle?.keepAliveTimer) {
          try { clearInterval(handle.keepAliveTimer); } catch {}
        }
        if (handle?.streamId) {
          realtimeDisconnect(handle.streamId).catch(() => {});
        }
      });
      ref.current.clear();
    }
    wsKeepAliveTimersRef.current.forEach((timer) => clearInterval(timer));
    wsKeepAliveTimersRef.current.clear();
    wsConnectTimeoutsRef.current.forEach((timer) => clearTimeout(timer));
    wsConnectTimeoutsRef.current.clear();
    streamKeyByIdRef.current.clear();
  }, []);

  function updateStore(updater) {
    setStore((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      return next && typeof next === "object" ? next : current;
    });
  }

  function recordRequestHistory({ request, workspaceName, collectionName, response: savedResponse, url, error = "" }) {
    const sentAt = new Date().toISOString();
    const status = Number(savedResponse?.status || 0);
    const entry = {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      workspaceName: String(workspaceName || ""),
      collectionName: String(collectionName || ""),
      requestName: String(request?.name || ""),
      requestMode: String(request?.requestMode || REQUEST_MODES.HTTP),
      method: String(request?.requestMode === REQUEST_MODES.GRPC ? request?.grpcMethodPath || "gRPC" : request?.method || ""),
      url: redactHistoryUrl(url || request?.url || ""),
      status,
      statusText: String(savedResponse?.statusText || ""),
      duration: String(savedResponse?.duration || ""),
      size: String(savedResponse?.size || ""),
      ok: status >= 200 && status < 400 && !error,
      error: String(error || ""),
      sentAt,
    };
    updateStore((current) => ({
      ...current,
      requestHistory: [entry, ...(current.requestHistory || [])].slice(0, 500),
    }));
  }

  function handleSidebarTabChange(sidebarTab) {
    updateStore((current) => ({
      ...current,
      sidebarTab,
      sidebarCollapsed: false,
      sidebarWidth: clampSidebarWidth(Math.max(current.sidebarWidth, SIDEBAR_REOPEN_WIDTH))
    }));
  }

  function clearWebSocketRuntimeTimers(requestKey) {
    const keepAliveTimer = wsKeepAliveTimersRef.current.get(requestKey);
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      wsKeepAliveTimersRef.current.delete(requestKey);
    }

    const connectTimeout = wsConnectTimeoutsRef.current.get(requestKey);
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      wsConnectTimeoutsRef.current.delete(requestKey);
    }
  }

  function updateActiveRequest(updater) {
    updateStore((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.name !== current.activeWorkspaceName) {
          return workspace;
        }

        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== current.activeCollectionName) {
              return collection;
            }

            return {
              ...collection,
              requests: collection.requests.map((request) => {
                if (request.name !== current.activeRequestName) {
                  return request;
                }

                return typeof updater === "function" ? updater(request) : { ...request, ...updater };
              })
            };
          })
        };
      })
    }));
  }

  function handleRequestFieldChange(field, value) {
    updateActiveRequest((request) => ({ ...request, [field]: value }));
  }

  function updateWsState(requestKey, patch) {
    setWsStates((current) => ({
      ...current,
      [requestKey]: {
        connected: false,
        connecting: false,
        messageCount: 0,
        lastMessage: "",
        lastEventAt: "",
        error: "",
        ...(current[requestKey] || {}),
        ...patch
      }
    }));
  }

  function nextMessageId() {
    messageIdCounterRef.current += 1;
    return `rtm_${Date.now()}_${messageIdCounterRef.current}`;
  }

  function appendStreamMessage(requestKey, message) {
    if (!requestKey || !message) return;
    const enriched = {
      id: message.id || nextMessageId(),
      direction: message.direction || "in",
      kind: message.kind || "text",
      event: message.event || "",
      text: typeof message.text === "string" ? message.text : "",
      raw: message.raw ?? null,
      size: Number.isFinite(message.size) ? Number(message.size) : realtimeMessageBytes(message.text),
      at: message.at || formatSavedAt(),
    };
    setStreamMessages((current) => {
      const list = current[requestKey] ? current[requestKey].slice() : [];
      list.push(enriched);
      if (list.length > 2000) {
        list.splice(0, list.length - 2000);
      }
      return { ...current, [requestKey]: list };
    });
  }

  function clearStreamMessagesForKey(requestKey) {
    if (!requestKey) return;
    setStreamMessages((current) => {
      if (!current[requestKey]) return current;
      const { [requestKey]: _removed, ...rest } = current;
      return rest;
    });
  }

  function dispatchRealtimeEvent(requestKey, eventPayload) {
    if (!requestKey || !eventPayload) return;
    const { kind, event, data, at, streamId } = eventPayload;

    if (kind === "open") {
      updateWsState(requestKey, {
        connecting: false,
        connected: true,
        error: "",
        lastEventAt: at || formatSavedAt(),
      });
      appendStreamMessage(requestKey, {
        direction: "system",
        kind: "system",
        event: "open",
        text: `Connected to ${data?.url ?? ""}`,
        raw: data,
        size: 0,
        at,
      });
      return;
    }

    if (kind === "close") {
      updateWsState(requestKey, {
        connecting: false,
        connected: false,
        lastEventAt: at || formatSavedAt(),
      });
      appendStreamMessage(requestKey, {
        direction: "system",
        kind: "system",
        event: "close",
        text: data?.reason ? `Closed (${data.code}): ${data.reason}` : `Closed (${data?.code ?? ""})`,
        raw: data,
        size: 0,
        at,
      });
      streamKeyByIdRef.current.delete(streamId);
      return;
    }

    if (kind === "error") {
      const detail = data?.message ? String(data.message) : "Stream error";
      updateWsState(requestKey, {
        connecting: false,
        connected: false,
        error: detail,
        lastEventAt: at || formatSavedAt(),
      });
      appendStreamMessage(requestKey, {
        direction: "system",
        kind: "error",
        event: "error",
        text: detail,
        raw: data,
        size: realtimeMessageBytes(detail),
        at,
      });
      return;
    }

    // message / event
    let displayText = "";
    if (event === "binary") {
      displayText = `<binary ${data?.bytes?.length ?? 0} chars base64>`;
    } else if (event === "ping" || event === "pong") {
      displayText = event;
    } else if (typeof data === "string") {
      displayText = data;
    } else if (data?.text != null) {
      displayText = String(data.text);
    } else if (data?.data != null && typeof data.data !== "object") {
      displayText = String(data.data);
    } else {
      try {
        displayText = JSON.stringify(data, null, 2);
      } catch {
        displayText = String(data);
      }
    }

    setWsStates((current) => ({
      ...current,
      [requestKey]: {
        ...(current[requestKey] || { connected: true, connecting: false, messageCount: 0, lastMessage: "", lastEventAt: "", error: "" }),
        connected: true,
        connecting: false,
        messageCount: (current[requestKey]?.messageCount ?? 0) + 1,
        lastMessage: displayText,
        lastEventAt: at || formatSavedAt(),
        error: "",
      },
    }));

    appendStreamMessage(requestKey, {
      direction: "in",
      kind: kind === "event" ? "event" : event || "text",
      event: event || "message",
      text: displayText,
      raw: data,
      size: realtimeMessageBytes(displayText),
      at,
    });
  }

  function setRequestLocalMessage(workspaceName, collectionName, requestName, method, url, text, statusText = "Realtime") {
    const savedAt = formatSavedAt();
    updateStore((current) => updateRequestWithLocalResponseByIdentity(current, workspaceName, collectionName, requestName, {
      status: 0,
      badge: statusText,
      statusText,
      duration: "-",
      size: `${new TextEncoder().encode(String(text || "")).length} B`,
      headers: {},
      cookies: [],
      body: String(text || ""),
      rawBody: String(text || ""),
      isJson: isJsonText(String(text || "")),
      meta: {
        url: url || "-",
        method
      },
      savedAt
    }));
  }

  function teardownStreamHandle(ref, requestKey) {
    const handle = ref.current.get(requestKey);
    if (!handle) return null;
    ref.current.delete(requestKey);
    try { handle.unsubscribe?.(); } catch {}
    if (handle.keepAliveTimer) {
      try { clearInterval(handle.keepAliveTimer); } catch {}
    }
    return handle;
  }

  async function connectActiveWebSocket() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.WEBSOCKET) return;

    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);

    const existing = teardownStreamHandle(wsConnectionsRef, requestKey);
    if (existing?.streamId) {
      try { await realtimeDisconnect(existing.streamId); } catch {}
      streamKeyByIdRef.current.delete(existing.streamId);
    }

    let finalUrl = "";
    try {
      finalUrl = buildWebSocketUrl(activeRequest.url, activeRequest.queryParams);
    } catch {
      finalUrl = toWebSocketUrl(activeRequest.url);
    }

    if (!finalUrl) {
      updateWsState(requestKey, { connected: false, connecting: false, error: "Enter a valid WebSocket URL." });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Enter a valid WebSocket URL before connecting.", "Connection error");
      return;
    }

    clearStreamMessagesForKey(requestKey);
    updateWsState(requestKey, { connecting: true, connected: false, error: "", messageCount: 0, lastMessage: "" });
    setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, finalUrl, `Connecting to ${finalUrl}`, "Connecting");

    const payload = buildRealtimePayload(activeRequest, workspaceName, collectionName, { url: finalUrl });

    try {
      const streamId = await realtimeConnectWebSocket(payload);
      if (!streamId) throw new Error("Backend did not return a stream id.");

      streamKeyByIdRef.current.set(streamId, requestKey);
      const unsubscribe = subscribeRealtime(streamId, (eventPayload) => {
        dispatchRealtimeEvent(requestKey, eventPayload);
      });

      const keepAliveIntervalMs = Number.isFinite(activeRequest.webSocketKeepAliveIntervalMs)
        ? Number(activeRequest.webSocketKeepAliveIntervalMs)
        : 0;
      let keepAliveTimer = null;
      if (keepAliveIntervalMs > 0) {
        keepAliveTimer = setInterval(() => {
          realtimeSend(streamId, "ping", "ping").catch(() => {});
        }, keepAliveIntervalMs);
      }

      wsConnectionsRef.current.set(requestKey, { streamId, unsubscribe, keepAliveTimer });
    } catch (error) {
      const detail = toErrorText(error) || `Failed to connect to ${finalUrl}.`;
      updateWsState(requestKey, { connecting: false, connected: false, error: detail, lastEventAt: formatSavedAt() });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, finalUrl, detail, "Connection error");
    }
  }

  async function disconnectActiveWebSocket() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.WEBSOCKET) return;
    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);

    const handle = teardownStreamHandle(wsConnectionsRef, requestKey);
    if (handle?.streamId) {
      try { await realtimeDisconnect(handle.streamId, 1000, "client"); } catch {}
      streamKeyByIdRef.current.delete(handle.streamId);
    }

    updateWsState(requestKey, { connected: false, connecting: false, lastEventAt: formatSavedAt() });
    setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Disconnected from WebSocket.", "Disconnected");
  }

  async function sendActiveWebSocketMessage() {
    if (!activeRequest) return;

    if (activeRequest.requestMode === REQUEST_MODES.SOCKET_IO) {
      sendActiveSocketIoMessage();
      return;
    }

    if (activeRequest.requestMode !== REQUEST_MODES.WEBSOCKET) return;
    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);
    const handle = wsConnectionsRef.current.get(requestKey);

    if (!handle?.streamId) {
      updateWsState(requestKey, { error: "Connect first before sending a message." });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Connect first before sending a message.", "Send blocked");
      return;
    }

    let payloadText = String(activeRequest.body ?? "");
    if (activeRequest.bodyType === "json") {
      try {
        payloadText = JSON.stringify(JSON.parse(payloadText), null, 2);
      } catch {
        updateWsState(requestKey, { error: "Invalid JSON payload" });
        setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Invalid JSON payload.", "Send blocked");
        return;
      }
    }

    try {
      await realtimeSend(handle.streamId, "text", payloadText);
      updateWsState(requestKey, { error: "", lastEventAt: formatSavedAt() });
      appendStreamMessage(requestKey, {
        direction: "out",
        kind: "text",
        event: "send",
        text: payloadText,
        raw: { text: payloadText },
        size: realtimeMessageBytes(payloadText),
      });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, payloadText, "Message sent");
    } catch (error) {
      const detail = toErrorText(error) || "Failed to send WebSocket message";
      updateWsState(requestKey, { error: detail });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, detail, "Send failed");
    }
  }

  async function connectActiveSse() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.SSE) return;

    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);

    const existing = teardownStreamHandle(sseConnectionsRef, requestKey);
    if (existing?.streamId) {
      try { await realtimeDisconnect(existing.streamId); } catch {}
      streamKeyByIdRef.current.delete(existing.streamId);
    }

    const finalUrl = buildSseUrl(activeRequest.url, activeRequest.queryParams);
    if (!finalUrl) {
      updateWsState(requestKey, { connected: false, connecting: false, error: "Enter a valid SSE URL." });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Enter a valid SSE URL before connecting.", "Connection error");
      return;
    }

    clearStreamMessagesForKey(requestKey);
    updateWsState(requestKey, { connecting: true, connected: false, error: "", messageCount: 0, lastMessage: "" });
    setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, finalUrl, `Connecting to ${finalUrl}`, "Connecting");

    const payload = buildRealtimePayload(activeRequest, workspaceName, collectionName, {
      url: finalUrl,
      method: activeRequest.method || "GET",
      body: activeRequest.body || null,
    });

    try {
      const streamId = await realtimeConnectSse(payload);
      if (!streamId) throw new Error("Backend did not return a stream id.");

      streamKeyByIdRef.current.set(streamId, requestKey);
      const unsubscribe = subscribeRealtime(streamId, (eventPayload) => {
        dispatchRealtimeEvent(requestKey, eventPayload);
      });

      sseConnectionsRef.current.set(requestKey, { streamId, unsubscribe });
    } catch (error) {
      const detail = toErrorText(error) || `Failed to connect to ${finalUrl}.`;
      updateWsState(requestKey, { connecting: false, connected: false, error: detail, lastEventAt: formatSavedAt() });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, finalUrl, detail, "Connection error");
    }
  }

  async function disconnectActiveSse() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.SSE) return;
    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);

    const handle = teardownStreamHandle(sseConnectionsRef, requestKey);
    if (handle?.streamId) {
      try { await realtimeDisconnect(handle.streamId, 1000, "client"); } catch {}
      streamKeyByIdRef.current.delete(handle.streamId);
    }

    updateWsState(requestKey, { connected: false, connecting: false, lastEventAt: formatSavedAt() });
    setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Disconnected from SSE stream.", "Disconnected");
  }

  async function connectActiveSocketIo() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.SOCKET_IO) return;

    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);

    const existing = teardownStreamHandle(socketIoConnectionsRef, requestKey);
    if (existing?.streamId) {
      try { await realtimeDisconnect(existing.streamId); } catch {}
      streamKeyByIdRef.current.delete(existing.streamId);
    }

    const finalUrl = buildSocketIoWebSocketUrl(activeRequest.url, activeRequest.queryParams);
    const namespace = String(activeRequest.socketIoNamespace || "/").trim() || "/";
    const normalizedNamespace = namespace.startsWith("/") ? namespace : `/${namespace}`;
    if (!finalUrl) {
      updateWsState(requestKey, { connected: false, connecting: false, error: "Enter a valid Socket.IO URL." });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Enter a valid Socket.IO URL before connecting.", "Connection error");
      return;
    }

    clearStreamMessagesForKey(requestKey);
    updateWsState(requestKey, { connecting: true, connected: false, error: "", messageCount: 0, lastMessage: "" });
    setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, finalUrl, `Connecting to ${finalUrl}`, "Connecting");

    const payload = buildRealtimePayload(activeRequest, workspaceName, collectionName, {
      url: finalUrl,
      namespace: normalizedNamespace,
    });

    try {
      const streamId = await realtimeConnectSocketIo(payload);
      if (!streamId) throw new Error("Backend did not return a stream id.");

      streamKeyByIdRef.current.set(streamId, requestKey);
      const unsubscribe = subscribeRealtime(streamId, (eventPayload) => {
        dispatchRealtimeEvent(requestKey, eventPayload);
      });

      socketIoConnectionsRef.current.set(requestKey, { streamId, unsubscribe });
    } catch (error) {
      const detail = toErrorText(error) || `Failed to connect to Socket.IO at ${finalUrl}.`;
      updateWsState(requestKey, { connecting: false, connected: false, error: detail, lastEventAt: formatSavedAt() });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, finalUrl, detail, "Connection error");
    }
  }

  async function disconnectActiveSocketIo() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.SOCKET_IO) return;
    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);

    const handle = teardownStreamHandle(socketIoConnectionsRef, requestKey);
    if (handle?.streamId) {
      try { await realtimeDisconnect(handle.streamId, 1000, "client"); } catch {}
      streamKeyByIdRef.current.delete(handle.streamId);
    }

    updateWsState(requestKey, { connected: false, connecting: false, lastEventAt: formatSavedAt() });
    setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Disconnected from Socket.IO.", "Disconnected");
  }

  async function sendActiveSocketIoMessage() {
    if (!activeRequest || activeRequest.requestMode !== REQUEST_MODES.SOCKET_IO) return;
    const workspaceName = activeWorkspace?.name ?? "";
    const collectionName = activeCollection?.name ?? "";
    const requestName = activeRequest.name;
    const requestMethod = activeRequest.method;
    const requestKey = buildRequestKey(workspaceName, collectionName, requestName);
    const handle = socketIoConnectionsRef.current.get(requestKey);

    if (!handle?.streamId) {
      updateWsState(requestKey, { error: "Connect first before sending a Socket.IO event." });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Connect first before sending a Socket.IO event.", "Send blocked");
      return;
    }

    const configuredEvents = Array.isArray(activeRequest.socketIoEvents)
      ? activeRequest.socketIoEvents
      : [];
    const selectedEvent = configuredEvents.find((row) => row?.id === activeRequest.socketIoSelectedEventId)
      || configuredEvents[0]
      || null;

    const eventName = String(selectedEvent?.name || activeRequest.socketIoEventName || "message").trim() || "message";
    if (selectedEvent && (selectedEvent.enabled === false || selectedEvent.emit === false)) {
      updateWsState(requestKey, { error: `Event \"${eventName}\" is disabled for emit.` });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, `Event \"${eventName}\" is disabled for emit.`, "Send blocked");
      return;
    }

    const selectedPayloadType = selectedEvent?.payloadType === "text" ? "text" : (activeRequest.bodyType || "json");
    let payloadText = String(selectedEvent?.payload ?? activeRequest.body ?? "");

    if (selectedPayloadType === "json") {
      try {
        payloadText = JSON.stringify(JSON.parse(payloadText));
      } catch {
        updateWsState(requestKey, { error: "Invalid JSON payload" });
        setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, "Invalid JSON payload.", "Send blocked");
        return;
      }
    }

    try {
      await realtimeEmitSocketIo(handle.streamId, eventName, payloadText);
      updateWsState(requestKey, { error: "", lastEventAt: formatSavedAt() });
      appendStreamMessage(requestKey, {
        direction: "out",
        kind: "event",
        event: eventName,
        text: payloadText,
        raw: { event: eventName, data: payloadText },
        size: realtimeMessageBytes(payloadText),
      });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, JSON.stringify({ event: eventName, data: payloadText }, null, 2), "Event sent");
    } catch (error) {
      const detail = toErrorText(error) || "Failed to send Socket.IO event";
      updateWsState(requestKey, { error: detail });
      setRequestLocalMessage(workspaceName, collectionName, requestName, requestMethod, activeRequest.url, detail, "Send failed");
    }
  }

  function createWorkspaceRecord(values) {
    updateStore((current) => {
      const existingNames = current.workspaces.map(w => w.name);
      const uniqueName = getUniqueName(values.name || "New Workspace", existingNames);
      const workspace = createWorkspace(uniqueName, values.description);

      return {
        ...current,
        activeWorkspaceName: workspace.name,
        activeCollectionName: "",
        activeRequestName: "",
        sidebarTab: "requests",
        workspaces: [...current.workspaces, workspace]
      };
    });
  }

  function importCollectionRecord(workspaceName, importedCollection) {
    updateStore((current) => {
      const workspace = current.workspaces.find((w) => w.name === workspaceName);
      if (!workspace || !importedCollection) return current;

      const existingNames = workspace.collections.map((c) => c.name);
      const nextName = getUniqueName(
        String(importedCollection.name || "Imported Collection").trim() || "Imported Collection",
        existingNames
      );

      const normalizedRequests = Array.isArray(importedCollection.requests)
        ? importedCollection.requests.map((request) => ({
          ...request,
          folderPath: normalizeFolderPath(request.folderPath)
        }))
        : [];

      const folderSet = new Set(
        Array.isArray(importedCollection.folders)
          ? importedCollection.folders.map((path) => normalizeFolderPath(path)).filter(Boolean)
          : []
      );
      for (const request of normalizedRequests) {
        if (request.folderPath) {
          getFolderAncestors(request.folderPath).forEach((path) => folderSet.add(path));
        }
      }

      const orderedRequests = orderRequests(normalizedRequests);
      const nextCollection = {
        ...createCollection(nextName),
        ...importedCollection,
        name: nextName,
        requests: orderedRequests,
        folders: Array.from(folderSet),
        folderSettings: Array.isArray(importedCollection.folderSettings) ? importedCollection.folderSettings : [],
        openRequestNames: orderedRequests[0] ? [orderedRequests[0].name] : [],
      };

      return {
        ...current,
        activeWorkspaceName: workspaceName,
        activeCollectionName: nextCollection.name,
        activeRequestName: nextCollection.requests[0]?.name || "",
        workspaces: current.workspaces.map((ws) => {
          if (ws.name !== workspaceName) return ws;
          return {
            ...ws,
            collections: [...ws.collections, nextCollection]
          };
        })
      };
    });
  }

  function importRequestRecords(workspaceName, collectionName, importedRequests, targetFolderPath = "") {
    const normalizedTargetFolderPath = normalizeFolderPath(targetFolderPath);
    updateStore((current) => {
      const workspace = current.workspaces.find((w) => w.name === workspaceName);
      const collection = workspace?.collections.find((c) => c.name === collectionName);
      if (!collection || !Array.isArray(importedRequests) || importedRequests.length === 0) {
        return current;
      }

      const existingNames = collection.requests.map((request) => request.name);
      const requestsToInsert = importedRequests.map((request) => {
        const name = getUniqueName(String(request?.name || "Imported Request").trim() || "Imported Request", existingNames);
        existingNames.push(name);
        const importedFolderPath = normalizeFolderPath(request?.folderPath);
        const folderPath = normalizedTargetFolderPath || importedFolderPath;
        return {
          ...createRequest(name),
          ...request,
          name,
          folderPath,
        };
      });

      const folderSet = new Set(Array.isArray(collection.folders) ? collection.folders : []);
      for (const req of requestsToInsert) {
        if (req.folderPath) {
          getFolderAncestors(req.folderPath).forEach((path) => folderSet.add(path));
        }
      }

      return {
        ...current,
        activeWorkspaceName: workspaceName,
        activeCollectionName: collectionName,
        activeRequestName: requestsToInsert[0]?.name || current.activeRequestName,
        workspaces: current.workspaces.map((ws) => {
          if (ws.name !== workspaceName) return ws;
          return {
            ...ws,
            collections: ws.collections.map((col) => {
              if (col.name !== collectionName) return col;
              return {
                ...col,
                requests: orderRequests([...(col.requests || []), ...requestsToInsert]),
                folders: Array.from(folderSet),
                openRequestNames: requestsToInsert[0]
                  ? [...(col.openRequestNames || []), requestsToInsert[0].name]
                  : (col.openRequestNames || [])
              };
            })
          };
        })
      };
    });
  }

  function pasteFolderRecord(workspaceName, collectionName, folderSnapshot, targetParentPath = "") {
    const snapshot = folderSnapshot && typeof folderSnapshot === "object" ? folderSnapshot : null;
    if (!snapshot?.rootName) {
      return;
    }

    updateStore((current) => {
      const targetWorkspaceName = workspaceName || current.activeWorkspaceName;
      const workspace = current.workspaces.find((w) => w.name === targetWorkspaceName);
      const targetCollectionName = collectionName || current.activeCollectionName || workspace?.collections?.[0]?.name;
      if (!workspace || !targetCollectionName) {
        return current;
      }

      let nextActiveRequestName = current.activeRequestName;
      const normalizedTargetParent = normalizeFolderPath(targetParentPath);

      const nextWorkspaces = current.workspaces.map((w) => {
        if (w.name !== targetWorkspaceName) return w;
        return {
          ...w,
          collections: w.collections.map((c) => {
            if (c.name !== targetCollectionName) return c;

            const existingFolders = (Array.isArray(c.folders) ? c.folders : []).map((path) => normalizeFolderPath(path));
            const siblingNames = existingFolders
              .filter((path) => getFolderParentPath(path) === normalizedTargetParent)
              .map((path) => getFolderLabel(path));
            const uniqueRootName = getUniqueName(String(snapshot.rootName).trim() || "New Folder", siblingNames);
            const pastedRootPath = normalizeFolderPath(normalizedTargetParent ? `${normalizedTargetParent}/${uniqueRootName}` : uniqueRootName);

            const relativeFolders = Array.isArray(snapshot.folders) ? snapshot.folders : [""];
            const nextFolderSet = new Set(existingFolders);
            relativeFolders.forEach((relativePath) => {
              const normalizedRelative = normalizeFolderPath(relativePath);
              const fullPath = normalizedRelative ? `${pastedRootPath}/${normalizedRelative}` : pastedRootPath;
              nextFolderSet.add(normalizeFolderPath(fullPath));
            });

            const existingRequestNames = c.requests.map((request) => request.name);
            const nextRequests = [...c.requests];
            const pastedRequests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
            pastedRequests.forEach((entry) => {
              const sourceRequest = entry?.request;
              if (!sourceRequest) return;
              const normalizedRelative = normalizeFolderPath(entry.relativePath);
              const fullPath = normalizedRelative ? `${pastedRootPath}/${normalizedRelative}` : pastedRootPath;
              const requestName = getUniqueName(sourceRequest.name || "New Request", existingRequestNames);
              existingRequestNames.push(requestName);
              const cloned = cloneRequest({ ...sourceRequest, name: requestName, folderPath: normalizeFolderPath(fullPath) });
              nextRequests.push(cloned);
              if (!nextActiveRequestName) {
                nextActiveRequestName = cloned.name;
              }
            });

            const existingSettings = Array.isArray(c.folderSettings) ? c.folderSettings : [];
            const settingsByPath = new Map();
            existingSettings.forEach((setting) => {
              settingsByPath.set(normalizeFolderPath(setting.path), {
                ...setting,
                path: normalizeFolderPath(setting.path)
              });
            });

            const pastedSettings = Array.isArray(snapshot.settings) ? snapshot.settings : [];
            pastedSettings.forEach((setting) => {
              const normalizedRelative = normalizeFolderPath(setting?.relativePath);
              const fullPath = normalizedRelative ? `${pastedRootPath}/${normalizedRelative}` : pastedRootPath;
              const normalizedPath = normalizeFolderPath(fullPath);
              settingsByPath.set(normalizedPath, {
                path: normalizedPath,
                defaultHeaders: Array.isArray(setting?.defaultHeaders) ? setting.defaultHeaders.map((row) => ({ ...row })) : [],
                defaultAuth: normalizeAuthState(setting?.defaultAuth ?? { type: "inherit" })
              });
            });

            return {
              ...c,
              folders: Array.from(nextFolderSet),
              folderSettings: Array.from(settingsByPath.values()),
              requests: orderRequests(nextRequests)
            };
          })
        };
      });

      return {
        ...current,
        activeWorkspaceName: targetWorkspaceName,
        activeCollectionName: targetCollectionName,
        activeRequestName: nextActiveRequestName,
        workspaces: nextWorkspaces
      };
    });
  }

  function renameWorkspaceRecord(oldName, values) {
    updateStore((current) => {
      const nextName = values.name.trim();
      if (!nextName) return current;


      if (nextName !== oldName) {
        const existingNames = current.workspaces.map(w => w.name);
        if (existingNames.includes(nextName)) {

          return current;
        }
      }

      return {
        ...current,
        activeWorkspaceName: current.activeWorkspaceName === oldName ? nextName : current.activeWorkspaceName,
        workspaces: current.workspaces.map((workspace) =>
          workspace.name === oldName ? { ...workspace, name: nextName, description: values.description } : workspace
        )
      };
    });
  }

  function deleteWorkspaceRecord(name) {
    updateStore((current) => {
      const nextWorkspaces = current.workspaces.filter((workspace) => workspace.name !== name);
      const nextWorkspace = nextWorkspaces.find((workspace) => workspace.name === current.activeWorkspaceName && workspace.name !== name) ?? nextWorkspaces[0] ?? null;
      const nextCollection = nextWorkspace?.collections?.[0] ?? null;
      const nextRequest = nextCollection?.requests?.[0] ?? null;

      return {
        ...current,
        activeWorkspaceName: nextWorkspace?.name ?? "",
        activeCollectionName: nextCollection?.name ?? "",
        activeRequestName: nextRequest?.name ?? "",
        workspaces: nextWorkspaces
      };
    });
  }

  function createCollectionRecord(workspaceName, name) {
    updateStore((current) => {
      const workspace = current.workspaces.find(w => w.name === workspaceName);
      if (!workspace) return current;

      const existingNames = workspace.collections.map(c => c.name);
      const uniqueName = getUniqueName(name || "New Collection", existingNames);
      const nextCollection = createCollection(uniqueName);

      return {
        ...current,
        activeWorkspaceName: workspaceName,
        activeCollectionName: uniqueName,
        activeRequestName: "",
        workspaces: current.workspaces.map((w) =>
          w.name === workspaceName
            ? { ...w, collections: [...w.collections, nextCollection] }
            : w
        )
      };
    });
  }

  function renameCollectionRecord(workspaceName, oldName, newName) {
    updateStore((current) => {
      const nextName = newName.trim();
      if (!nextName) return current;

      if (nextName !== oldName) {
        const workspace = current.workspaces.find(w => w.name === workspaceName);
        if (workspace?.collections.some(c => c.name === nextName)) {
          return current;
        }
      }

      return {
        ...current,
        activeCollectionName: current.activeCollectionName === oldName ? nextName : current.activeCollectionName,
        workspaces: current.workspaces.map((workspace) =>
          workspace.name === workspaceName
            ? {
              ...workspace,
              collections: workspace.collections.map((c) =>
                c.name === oldName ? { ...c, name: nextName } : c
              )
            }
            : workspace
        )
      };
    });
  }

  function deleteCollectionRecord(workspaceName, name) {
    updateStore((current) => {
      let nextActiveCollectionName = current.activeCollectionName;
      let nextActiveRequestName = current.activeRequestName;

      const nextWorkspaces = current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) {
          return workspace;
        }

        const nextCollections = workspace.collections.filter((c) => c.name !== name);
        if (current.activeCollectionName === name) {
          nextActiveCollectionName = nextCollections[0]?.name ?? "";
          nextActiveRequestName = nextCollections[0]?.requests?.[0]?.name ?? "";
        }

        return { ...workspace, collections: nextCollections };
      });

      return {
        ...current,
        activeCollectionName: nextActiveCollectionName,
        activeRequestName: nextActiveRequestName,
        workspaces: nextWorkspaces
      };
    });
  }

  function duplicateCollectionRecord(workspaceName, collectionName, newName) {
    updateStore((current) => {
      let duplicatedName = "";
      const nextWorkspaces = current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        const source = workspace.collections.find((c) => c.name === collectionName);
        if (!source) return workspace;

        const existingNames = workspace.collections.map((c) => c.name);
        const uniqueName = newName ? newName.trim() : getUniqueName(`${source.name} Copy`, existingNames);
        if (newName && existingNames.includes(uniqueName)) return workspace;

        const duplicated = {
          ...source,
          name: uniqueName,
          requests: source.requests.map(r => cloneRequest(r))
        };
        duplicatedName = duplicated.name;

        return {
          ...workspace,
          collections: [...workspace.collections, duplicated]
        };
      });

      return {
        ...current,
        activeCollectionName: duplicatedName || current.activeCollectionName,
        workspaces: nextWorkspaces
      };
    });
  }

  function createFolderRecord(workspaceName, collectionName, folderPath) {
    const nextFolderPath = normalizeFolderPath(folderPath);
    if (!nextFolderPath) {
      return;
    }

    updateStore((current) => {
      const targetWorkspaceName = workspaceName || current.activeWorkspaceName;
      const workspace = current.workspaces.find((w) => w.name === targetWorkspaceName);
      const targetCollectionName = collectionName || current.activeCollectionName || workspace?.collections?.[0]?.name;
      if (!workspace || !targetCollectionName) {
        return current;
      }

      const collection = workspace.collections.find((c) => c.name === targetCollectionName);
      const existingFolders = (Array.isArray(collection?.folders) ? collection.folders : []).map((path) => normalizeFolderPath(path));
      if (existingFolders.includes(nextFolderPath)) {
        return current;
      }

      return {
        ...current,
        activeWorkspaceName: targetWorkspaceName,
        activeCollectionName: targetCollectionName,
        workspaces: current.workspaces.map((w) => {
          if (w.name !== targetWorkspaceName) return w;
          return {
            ...w,
            collections: w.collections.map((c) => {
              if (c.name !== targetCollectionName) return c;
              return {
                ...c,
                folders: [...existingFolders, nextFolderPath]
              };
            })
          };
        })
      };
    });
  }

  function renameFolderRecord(workspaceName, collectionName, oldFolderPath, newFolderName) {
    const oldPath = normalizeFolderPath(oldFolderPath);
    const newName = String(newFolderName ?? "").trim();
    if (!oldPath || !newName) {
      return;
    }

    const parts = oldPath.split("/");
    parts[parts.length - 1] = newName;
    const newPath = normalizeFolderPath(parts.join("/"));
    if (!newPath || newPath === oldPath) {
      return;
    }

    updateStore((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;

            const folders = Array.isArray(collection.folders) ? collection.folders.map((path) => normalizeFolderPath(path)) : [];
            if (folders.includes(newPath)) {
              return collection;
            }

            const nextFolders = Array.from(new Set(
              folders.map((path) => renamePathPrefix(path, oldPath, newPath))
            ));

            const nextFolderSettings = (collection.folderSettings || []).map((setting) => ({
              ...setting,
              path: renamePathPrefix(normalizeFolderPath(setting.path), oldPath, newPath)
            }));

            const nextRequests = collection.requests.map((request) => ({
              ...request,
              folderPath: renamePathPrefix(normalizeFolderPath(request.folderPath), oldPath, newPath)
            }));

            return {
              ...collection,
              folders: nextFolders,
              folderSettings: nextFolderSettings,
              requests: nextRequests
            };
          })
        };
      })
    }));
  }

  function deleteFolderRecord(workspaceName, collectionName, folderPath) {
    const targetPath = normalizeFolderPath(folderPath);
    if (!targetPath) {
      return;
    }

    updateStore((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;

            const shouldDrop = (path) => path === targetPath || path.startsWith(`${targetPath}/`);

            return {
              ...collection,
              folders: (collection.folders || []).filter((path) => !shouldDrop(normalizeFolderPath(path))),
              folderSettings: (collection.folderSettings || []).filter((setting) => !shouldDrop(normalizeFolderPath(setting.path))),
              requests: collection.requests.map((request) => {
                const requestFolderPath = normalizeFolderPath(request.folderPath);
                if (shouldDrop(requestFolderPath)) {
                  return { ...request, folderPath: "" };
                }
                return request;
              })
            };
          })
        };
      })
    }));
  }

  function updateFolderSettingsRecord(workspaceName, collectionName, folderPath, nextSettings) {
    const targetPath = normalizeFolderPath(folderPath);
    if (!targetPath) {
      return;
    }

    updateStore((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;

            const settings = Array.isArray(collection.folderSettings) ? collection.folderSettings : [];
            const normalizedSetting = {
              path: targetPath,
              defaultHeaders: Array.isArray(nextSettings?.defaultHeaders) ? nextSettings.defaultHeaders : [],
              defaultAuth: normalizeAuthState(nextSettings?.defaultAuth ?? { type: "inherit" })
            };

            const exists = settings.some((setting) => normalizeFolderPath(setting.path) === targetPath);
            const nextFolderSettings = exists
              ? settings.map((setting) => (
                normalizeFolderPath(setting.path) === targetPath ? normalizedSetting : setting
              ))
              : [...settings, normalizedSetting];

            const folders = Array.isArray(collection.folders) ? collection.folders : [];
            const nextFolders = folders.includes(targetPath) ? folders : [...folders, targetPath];

            return {
              ...collection,
              folders: nextFolders,
              folderSettings: nextFolderSettings
            };
          })
        };
      })
    }));
  }

  function createRequestRecord(workspaceName, collectionName, name, folderPath = "", requestMode = REQUEST_MODES.HTTP) {
    updateStore((current) => {
      const targetWorkspaceName = workspaceName || current.activeWorkspaceName;
      const workspace = current.workspaces.find(w => w.name === targetWorkspaceName);
      

      const targetCollectionName = collectionName || current.activeCollectionName || workspace?.collections?.[0]?.name;

      if (!targetCollectionName) {
        console.warn("Cannot create request: no collection found in workspace", targetWorkspaceName);
        return current;
      }

      const collection = workspace.collections.find(c => c.name === targetCollectionName);
      const existingNames = collection?.requests.map(r => r.name) || [];
      const baseName = getRequestBaseNameByMode(requestMode);
      const uniqueName = name ? name.trim() : getUniqueName(baseName, existingNames);
      
      if (name && existingNames.includes(uniqueName)) {
        return current;
      }
      
      const nextFolderPath = normalizeFolderPath(folderPath);
      const nextRequest = {
        ...createRequest(uniqueName, requestMode),
        folderPath: nextFolderPath
      };

      return {
        ...current,
        activeWorkspaceName: targetWorkspaceName,
        activeCollectionName: targetCollectionName,
        activeRequestName: nextRequest.name,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.name !== targetWorkspaceName) return workspace;
          return {
            ...workspace,
            collections: workspace.collections.map((collection) => {
              if (collection.name !== targetCollectionName) return collection;
              const folders = Array.isArray(collection.folders) ? collection.folders : [];
              const nextFolders = nextFolderPath && !folders.includes(nextFolderPath)
                ? [...folders, nextFolderPath]
                : folders;
              return {
                ...collection,
                folders: nextFolders,
                requests: orderRequests([...collection.requests, nextRequest]),
                openRequestNames: [...(collection.openRequestNames || []), nextRequest.name]
              };
            })
          };
        })
      };
    });
  }

  function duplicateRequestRecord(workspaceName, collectionName, requestName, newName) {
    updateStore((current) => {
      let duplicatedName = "";

      const nextWorkspaces = current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;
            const source = collection.requests.find((r) => r.name === requestName);
            if (!source) return collection;

            const existingNames = collection.requests.map(r => r.name);
            const uniqueName = newName ? newName.trim() : getUniqueName(`${source.name} Copy`, existingNames);
            if (newName && existingNames.includes(uniqueName)) return collection;

            const duplicated = cloneRequest({ ...source, name: uniqueName });
            duplicatedName = duplicated.name;

            return {
              ...collection,
              requests: orderRequests([...collection.requests, duplicated]),
              openRequestNames: [...(collection.openRequestNames || []), duplicated.name]
            };
          })
        };
      });

      return {
        ...current,
        activeRequestName: duplicatedName || current.activeRequestName,
        workspaces: nextWorkspaces
      };
    });
  }

  function pasteRequestRecord(workspaceName, collectionName, request, folderPath = "") {
    updateStore((current) => {
      const targetWorkspaceName = workspaceName || current.activeWorkspaceName;
      const workspace = current.workspaces.find(w => w.name === targetWorkspaceName);
      const targetCollectionName = collectionName || current.activeCollectionName || workspace?.collections?.[0]?.name;

      if (!targetCollectionName) return current;

      const collection = workspace.collections.find(c => c.name === targetCollectionName);
      const existingNames = collection?.requests.map(r => r.name) || [];
      const uniqueName = getUniqueName(request.name, existingNames);
      const nextFolderPath = normalizeFolderPath(folderPath);

      const pastedRequest = cloneRequest({ ...request, name: uniqueName, folderPath: nextFolderPath });

      return {
        ...current,
        activeWorkspaceName: targetWorkspaceName,
        activeCollectionName: targetCollectionName,
        activeRequestName: pastedRequest.name,
        workspaces: current.workspaces.map((w) => {
          if (w.name !== targetWorkspaceName) return w;
          return {
            ...w,
            collections: w.collections.map((c) => {
              if (c.name !== targetCollectionName) return c;
              const folders = Array.isArray(c.folders) ? c.folders : [];
              const nextFolders = nextFolderPath && !folders.includes(nextFolderPath)
                ? [...folders, nextFolderPath]
                : folders;
              return {
                ...c,
                folders: nextFolders,
                requests: orderRequests([...c.requests, pastedRequest]),
                openRequestNames: [...(c.openRequestNames || []), pastedRequest.name]
              };
            })
          };
        })
      };
    });
  }

  function renameRequestRecord(workspaceName, collectionName, oldName, nextName) {
    updateStore((current) => {
      const targetName = nextName.trim();
      if (!targetName) return current;

      if (targetName !== oldName) {
        const workspace = current.workspaces.find(w => w.name === workspaceName);
        const collection = workspace?.collections.find(c => c.name === collectionName);
        if (collection?.requests.some(r => r.name === targetName)) {
          return current;
        }
      }

      return {
        ...current,
        activeRequestName: current.activeRequestName === oldName ? targetName : current.activeRequestName,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.name !== workspaceName) return workspace;
          return {
            ...workspace,
            collections: workspace.collections.map((collection) => {
              if (collection.name !== collectionName) return collection;
              return {
                ...collection,
                requests: collection.requests.map((r) =>
                  r.name === oldName ? { ...r, name: targetName } : r
                ),
                openRequestNames: (collection.openRequestNames || []).map((n) => n === oldName ? targetName : n)
              };
            })
          };
        })
      };
    });
  }

  function deleteRequestRecord(workspaceName, collectionName, requestName) {
    updateStore((current) => {
      let nextActiveRequestName = current.activeRequestName;

      const nextWorkspaces = current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;
            const nextRequests = collection.requests.filter((r) => r.name !== requestName);
            const nextOpenNames = (collection.openRequestNames || []).filter((n) => n !== requestName);

            if (current.activeRequestName === requestName) {
              nextActiveRequestName = nextOpenNames[0] ?? "";
            }

            return {
              ...collection,
              requests: nextRequests,
              openRequestNames: nextOpenNames
            };
          })
        };
      });

      return {
        ...current,
        activeRequestName: nextActiveRequestName,
        workspaces: nextWorkspaces
      };
    });
  }

  function selectWorkspace(name) {
    updateStore((current) => {
      const workspace = current.workspaces.find((w) => w.name === name) ?? current.workspaces[0] ?? null;
      const firstCol = workspace?.collections?.[0] ?? null;
      const firstReq = firstCol?.requests?.[0] ?? null;

      return {
        ...current,
        activeWorkspaceName: workspace?.name ?? "",
        activeCollectionName: firstCol?.name ?? "",
        activeRequestName: firstReq?.name ?? "",
        sidebarTab: "requests",
        workspaces: current.workspaces.map((w) => {
          if (w.name !== workspace?.name || !firstCol || !firstReq) return w;
          return {
            ...w,
            collections: w.collections.map((c) => {
              if (c.name !== firstCol.name) return c;
              const openNames = Array.isArray(c.openRequestNames) ? c.openRequestNames : [];
              if (openNames.includes(firstReq.name)) return c;
              return { ...c, openRequestNames: [...openNames, firstReq.name] };
            })
          };
        })
      };
    });
  }

  function selectCollection(workspaceName, collectionName) {
    updateStore((current) => ({
      ...current,
      activeWorkspaceName: workspaceName,
      activeCollectionName: collectionName,
      activeRequestName: ""
    }));
  }

  function selectRequest(workspaceName, collectionName, requestName) {
    updateStore((current) => ({
      ...current,
      activeWorkspaceName: workspaceName,
      activeCollectionName: collectionName,
      activeRequestName: requestName,
      sidebarTab: "requests",
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;
            const openNames = Array.isArray(collection.openRequestNames) ? collection.openRequestNames : [];
            if (openNames.includes(requestName)) return collection;
            return {
              ...collection,
              openRequestNames: [...openNames, requestName]
            };
          })
        };
      })
    }));
  }

  function togglePinRequestRecord(workspaceName, collectionName, requestName) {
    updateStore((current) => ({
      ...current,
      workspaces: current.workspaces.map((workspace) => {
        if (workspace.name !== workspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== collectionName) return collection;
            return {
              ...collection,
              requests: orderRequests(
                collection.requests.map((r) =>
                  r.name === requestName ? { ...r, pinned: !r.pinned } : r
                )
              )
            };
          })
        };
      })
    }));
  }

  function closeRequestTab(requestName) {
    if (!activeCollection) return;

    updateStore((current) => {
      let nextActiveRequestName = current.activeRequestName;

      const nextWorkspaces = current.workspaces.map((workspace) => {
        if (workspace.name !== current.activeWorkspaceName) return workspace;
        return {
          ...workspace,
          collections: workspace.collections.map((collection) => {
            if (collection.name !== current.activeCollectionName) return collection;
            const nextOpenNames = (collection.openRequestNames || []).filter((n) => n !== requestName);
            if (current.activeRequestName === requestName) {
              nextActiveRequestName = nextOpenNames[0] ?? "";
            }
            return { ...collection, openRequestNames: nextOpenNames };
          })
        };
      });

      return {
        ...current,
        activeRequestName: nextActiveRequestName,
        workspaces: nextWorkspaces
      };
    });
  }

  async function handleSend() {
    if (!activeRequest) {
      console.warn("No active request to send");
      return;
    }

    if (activeRequest.requestMode === REQUEST_MODES.WEBSOCKET) {
      const requestKey = buildRequestKey(
        activeWorkspace?.name ?? "",
        activeCollection?.name ?? "",
        activeRequest.name
      );
      const wsState = wsStates[requestKey] ?? { connected: false, connecting: false };
      if (wsState.connected || wsState.connecting) {
        disconnectActiveWebSocket();
      } else {
        connectActiveWebSocket();
      }
      return;
    }

    if (activeRequest.requestMode === REQUEST_MODES.SOCKET_IO) {
      const requestKey = buildRequestKey(
        activeWorkspace?.name ?? "",
        activeCollection?.name ?? "",
        activeRequest.name
      );
      const wsState = wsStates[requestKey] ?? { connected: false, connecting: false };
      if (wsState.connected || wsState.connecting) {
        disconnectActiveSocketIo();
      } else {
        connectActiveSocketIo();
      }
      return;
    }

    if (activeRequest.requestMode === REQUEST_MODES.SSE) {
      const requestKey = buildRequestKey(
        activeWorkspace?.name ?? "",
        activeCollection?.name ?? "",
        activeRequest.name
      );
      const wsState = wsStates[requestKey] ?? { connected: false, connecting: false };
      if (wsState.connected || wsState.connecting) {
        disconnectActiveSse();
      } else {
        connectActiveSse();
      }
      return;
    }

    if (activeRequest.requestMode === REQUEST_MODES.GRPC) {
      const resolvedUrl = normalizeUrl(activeRequest.url || "");
      if (!resolvedUrl) {
        const savedAt = formatSavedAt();
        const message = "Enter a valid gRPC server URL before sending.";
        updateStore((current) => updateRequestWithLocalResponse(current, activeRequest.name, {
          status: 0,
          badge: "Request warning",
          statusText: "Request warning",
          duration: "-",
          size: "0 B",
          headers: {},
          cookies: [],
          body: message,
          rawBody: message,
          isJson: false,
          meta: {
            url: activeRequest.url || "-",
            method: activeRequest.method
          },
          savedAt
        }));
        return;
      }

      if (!String(activeRequest.grpcProtoFilePath || "").trim()) {
        const savedAt = formatSavedAt();
        const message = "Select a .proto file before sending a gRPC request.";
        updateStore((current) => updateRequestWithLocalResponse(current, activeRequest.name, {
          status: 0,
          badge: "Request warning",
          statusText: "Request warning",
          duration: "-",
          size: "0 B",
          headers: {},
          cookies: [],
          body: message,
          rawBody: message,
          isJson: false,
          meta: {
            url: resolvedUrl,
            method: activeRequest.method
          },
          savedAt
        }));
        return;
      }

      if (!String(activeRequest.grpcMethodPath || "").trim()) {
        const savedAt = formatSavedAt();
        const message = "Select a gRPC method before sending.";
        updateStore((current) => updateRequestWithLocalResponse(current, activeRequest.name, {
          status: 0,
          badge: "Request warning",
          statusText: "Request warning",
          duration: "-",
          size: "0 B",
          headers: {},
          cookies: [],
          body: message,
          rawBody: message,
          isJson: false,
          meta: {
            url: resolvedUrl,
            method: activeRequest.method
          },
          savedAt
        }));
        return;
      }

      const requestId = `grpc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      activeHttpRequestIdRef.current = requestId;
      setIsSending(true);
      setSendStartedAt(Date.now());

      try {
        const result = await sendGrpcRequest({
          requestId,
          url: resolvedUrl,
          grpcProtoFilePath: activeRequest.grpcProtoFilePath,
          grpcMethodPath: activeRequest.grpcMethodPath,
          grpcStreamingMode: activeRequest.grpcStreamingMode || "bidi",
          headers: serializeHeaders(activeRequest.headers ?? [], { type: "none" }, "none", ""),
          body: String(activeRequest.body || ""),
          workspaceName: activeWorkspace?.name ?? "",
          collectionName: activeCollection?.name ?? ""
        });

        if (activeHttpRequestIdRef.current !== requestId) {
          return;
        }

        const rawBody = String(result?.body || "");
        const formattedBody = formatResponseBody(rawBody);
        const bodySize = new TextEncoder().encode(rawBody).length;
        const responseIsJson = isJsonText(rawBody);
        const savedAt = formatSavedAt();
        const statusCode = Number(result?.status || 0);
        const statusText = String(result?.statusText || "OK");
        const savedResponse = {
          status: statusCode,
          badge: `${statusCode} ${statusText}`,
          statusText: `${statusCode} ${statusText}`,
          duration: `${Number(result?.durationMs || 0)} ms`,
          size: `${bodySize} B`,
          headers: result?.headers || {},
          cookies: [],
          body: formattedBody,
          rawBody,
          isJson: responseIsJson,
          meta: {
            url: resolvedUrl,
            method: activeRequest.grpcMethodPath
          },
          savedAt
        };

        updateStore((current) => ({
          ...current,
          workspaces: current.workspaces.map((workspace) => {
            if (workspace.name !== current.activeWorkspaceName) return workspace;
            return {
              ...workspace,
              collections: workspace.collections.map((collection) => {
                if (collection.name !== current.activeCollectionName) return collection;
                return {
                  ...collection,
                  requests: collection.requests.map((request) =>
                    request.name === activeRequest.name
                      ? {
                        ...request,
                        responseBodyView: responseIsJson ? "JSON" : "Raw",
                        lastResponse: savedResponse
                      }
                      : request
                  )
                };
              })
            };
          })
        }));
        recordRequestHistory({
          request: activeRequest,
          workspaceName: activeWorkspace?.name ?? "",
          collectionName: activeCollection?.name ?? "",
          response: savedResponse,
          url: resolvedUrl,
        });
      } catch (error) {
        if (activeHttpRequestIdRef.current !== requestId) {
          return;
        }

        const message = buildFriendlyRequestErrorMessage(error, "gRPC request failed");
        const savedAt = formatSavedAt();
        updateStore((current) => updateRequestWithLocalResponse(current, activeRequest.name, {
          status: 500,
          badge: "Failed",
          statusText: "Request failed",
          duration: "-",
          size: "0 B",
          headers: {},
          cookies: [],
          body: message,
          rawBody: message,
          isJson: false,
          meta: {
            url: resolvedUrl,
            method: activeRequest.grpcMethodPath
          },
          savedAt
        }));
        recordRequestHistory({
          request: activeRequest,
          workspaceName: activeWorkspace?.name ?? "",
          collectionName: activeCollection?.name ?? "",
          response: {
            status: 500,
            statusText: "Request failed",
            duration: "-",
            size: "0 B",
          },
          url: resolvedUrl,
          error: message,
        });
      } finally {
        if (activeHttpRequestIdRef.current === requestId) {
          activeHttpRequestIdRef.current = "";
          setIsSending(false);
          setSendStartedAt(0);
        }
      }

      return;
    }

    const activeWorkspaceName = activeWorkspace?.name ?? "";
    const activeCollectionName = activeCollection?.name ?? "";
    const activeRequestName = activeRequest.name;
    const supportsScripts = activeRequest.requestMode === REQUEST_MODES.HTTP || activeRequest.requestMode === REQUEST_MODES.GRAPHQL;
    let scriptedRequest = activeRequest;
    let scriptContext = { vars: {} };

    async function runAfterResponseScript(savedResponse) {
      if (!supportsScripts) {
        return;
      }

      const postScriptSource = String(activeRequest.scriptAfterResponse || "").trim();
      if (!postScriptSource) {
        return;
      }

      const postRun = await runRequestScript({
        phase: "after-response",
        script: postScriptSource,
        request: scriptedRequest,
        response: savedResponse,
        context: scriptContext,
      });

      scriptContext = postRun.context || scriptContext;
      const scriptPatch = buildScriptStatePatch("after-response", postRun, formatSavedAt());
      updateStore((current) => updateRequestScriptStateByIdentity(current, activeWorkspaceName, activeCollectionName, activeRequestName, scriptPatch));
    }

    if (supportsScripts) {
      const preScriptSource = String(activeRequest.scriptPreRequest || "").trim();
      if (preScriptSource) {
        const preRun = await runRequestScript({
          phase: "pre-request",
          script: preScriptSource,
          request: activeRequest,
          response: null,
          context: scriptContext,
        });

        scriptContext = preRun.context || scriptContext;
        const scriptPatch = buildScriptStatePatch("pre-request", preRun, formatSavedAt());

        if (!preRun.ok) {
          const savedAt = formatSavedAt();
          const preError = scriptPatch.scriptLastError || "Pre-request script failed: Unknown error";
          const warningResponse = {
            status: 0,
            badge: "Script error",
            statusText: "Script error",
            duration: "-",
            size: "0 B",
            headers: {},
            cookies: [],
            body: preError,
            rawBody: preError,
            isJson: false,
            meta: {
              url: activeRequest.url || "-",
              method: activeRequest.method || "GET"
            },
            savedAt
          };

          updateStore((current) => updateRequestWithLocalResponseByIdentity(
            updateRequestScriptStateByIdentity(current, activeWorkspaceName, activeCollectionName, activeRequestName, {
              ...scriptPatch,
              scriptLastRunAt: savedAt,
            }),
            activeWorkspaceName,
            activeCollectionName,
            activeRequestName,
            warningResponse,
            "Raw"
          ));
          return;
        }

        scriptedRequest = preRun.request;
        updateStore((current) => updateRequestScriptStateByIdentity(current, activeWorkspaceName, activeCollectionName, activeRequestName, scriptPatch));
      }
    }

    let finalUrl = "";
    try {
      finalUrl = buildUrlWithParams(scriptedRequest.url, scriptedRequest.queryParams);
    } catch (error) {
      console.error("Failed to build URL:", error);
    }

    if (!finalUrl) {
      updateStore((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.name !== current.activeWorkspaceName) return workspace;
          return {
            ...workspace,
            collections: workspace.collections.map((collection) => {
              if (collection.name !== current.activeCollectionName) return collection;
              return {
                ...collection,
                requests: collection.requests.map((request) =>
                  request.name === activeRequest.name
                    ? {
                        ...request,
                        responseBodyView: "Raw",
                        lastResponse: {
                          status: 0,
                          badge: "Request warning",
                          statusText: "Request warning",
                          duration: "-",
                          size: "0 B",
                          headers: {},
                          cookies: [],
                          body: "Enter a valid URL before sending the request.",
                          rawBody: "Enter a valid URL before sending the request.",
                          isJson: false,
                          meta: { url: scriptedRequest.url || "-", method: scriptedRequest.method },
                          savedAt: formatSavedAt()
                        }
                      }
                    : request
                )
              };
            })
          };
        })
      }));
      return;
    }

    const requestId = `http-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    activeHttpRequestIdRef.current = requestId;
    setIsSending(true);
    setSendStartedAt(Date.now());

    try {
      const folderHeaderRows = resolveFolderHeaderRows(activeCollection, scriptedRequest.folderPath);
      const resolvedFolderAuth = resolveFolderAuth(activeCollection, scriptedRequest.folderPath);
      const disabledRequestHeaderKeys = new Set(
        (scriptedRequest.headers || [])
          .filter((row) => row?.enabled === false && String(row?.key || "").trim())
          .map((row) => String(row.key).trim().toLowerCase())
      );
      const inheritedHeaderRows = folderHeaderRows.filter((row) => {
        const key = String(row?.key || "").trim().toLowerCase();
        return !key || !disabledRequestHeaderKeys.has(key);
      });
      const effectiveRequest = {
        ...scriptedRequest,
        headers: [...inheritedHeaderRows, ...(scriptedRequest.headers || [])],
        auth: scriptedRequest?.auth?.type === "inherit" ? resolvedFolderAuth : scriptedRequest.auth
      };

      let requestForSend = effectiveRequest;
      const effectiveOAuth = requestForSend?.auth?.type === "oauth2" ? requestForSend.auth.oauth2 : null;
      if (shouldAutoRefreshOAuth(effectiveOAuth)) {
        const refreshRequestId = `oauth-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        try {
          const refreshed = await exchangeOAuthToken({
            workspaceName: activeWorkspaceName,
            collectionName: activeCollectionName,
            requestId: refreshRequestId,
            oauth: {
              ...effectiveOAuth,
              grantType: "refresh_token",
            },
          });

          const refreshedAuth = {
            ...requestForSend.auth,
            oauth2: {
              ...requestForSend.auth.oauth2,
              accessToken: refreshed.accessToken || requestForSend.auth.oauth2.accessToken,
              refreshToken: refreshed.refreshToken || requestForSend.auth.oauth2.refreshToken,
              tokenType: refreshed.tokenType || requestForSend.auth.oauth2.tokenType || "Bearer",
              expiresAt: refreshed.expiresAt || requestForSend.auth.oauth2.expiresAt,
              lastStatus: "token-ready",
              lastError: "",
              lastWarning: "",
            },
          };

          requestForSend = {
            ...requestForSend,
            auth: refreshedAuth,
          };

          if (scriptedRequest?.auth?.type === "oauth2") {
            updateStore((current) => updateRequestByIdentity(current, activeWorkspaceName, activeCollectionName, activeRequestName, {
              auth: refreshedAuth,
            }));
          }
        } catch (refreshError) {
          const refreshMessage = refreshError?.toString?.() || "OAuth token refresh failed before request.";
          if (scriptedRequest?.auth?.type === "oauth2") {
            updateStore((current) => updateRequestByIdentity(current, activeWorkspaceName, activeCollectionName, activeRequestName, {
              auth: {
                ...scriptedRequest.auth,
                oauth2: {
                  ...scriptedRequest.auth.oauth2,
                  lastStatus: "token-error",
                  lastError: refreshMessage,
                },
              },
            }));
          }
        }
      }

      const requestPayload = buildRequestPayload(
        requestForSend,
        activeWorkspaceName,
        activeCollectionName
      );
      const result = await sendHttpRequest({ ...requestPayload, requestId });

      if (activeHttpRequestIdRef.current !== requestId) {
        return;
      }

      const isBinary = Boolean(result?.isBinary);
      const rawBody = isBinary ? "" : (result.body || "");
      const formattedBody = isBinary ? "Binary response body. Use Save response to export the original bytes." : formatResponseBody(rawBody);
      const bodySize = result?.bodyBase64
        ? Math.floor((String(result.bodyBase64).length * 3) / 4)
        : new TextEncoder().encode(rawBody).length;
      const responseIsJson = !isBinary && isJsonText(rawBody);
      const savedAt = formatSavedAt();
      const savedResponse = {
        status: result.status,
        badge: `${result.status} ${result.statusText}`,
        statusText: `${result.status} ${result.statusText}`,
        duration: `${result.durationMs} ms`,
        size: `${bodySize} B`,
        headers: result.headers,
        cookies: Array.isArray(result.cookies) ? result.cookies : parseCookies(result.headers),
        body: formattedBody,
        rawBody,
        bodyBase64: String(result?.bodyBase64 || ""),
        isBinary,
        contentType: String(result?.contentType || ""),
        isJson: responseIsJson,
        meta: {
          url: finalUrl,
          method: scriptedRequest.method
        },
        savedAt
      };

      updateStore((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.name !== current.activeWorkspaceName) return workspace;
          return {
            ...workspace,
            collections: workspace.collections.map((collection) => {
              if (collection.name !== current.activeCollectionName) return collection;
              return {
                ...collection,
                requests: collection.requests.map((request) =>
                  request.name === activeRequest.name
                    ? {
                      ...request,
                      url: normalizeUrl(request.url),
                      responseBodyView: responseIsJson ? "JSON" : "Raw",
                      lastResponse: savedResponse
                    }
                    : request
                )
              };
            })
          };
        })
      }));
      recordRequestHistory({
        request: scriptedRequest,
        workspaceName: activeWorkspaceName,
        collectionName: activeCollectionName,
        response: savedResponse,
        url: finalUrl,
      });

      await runAfterResponseScript(savedResponse);
    } catch (error) {
      if (activeHttpRequestIdRef.current !== requestId) {
        return;
      }

      const message = buildFriendlyRequestErrorMessage(error, "Request failed");

      const savedAt = formatSavedAt();
      const savedResponse = {
        status: 500,
        badge: "Failed",
        statusText: "Request failed",
        duration: "-",
        size: "0 B",
        headers: {},
        cookies: [],
        body: message,
        rawBody: message,
        isJson: false,
        meta: {
          url: finalUrl,
          method: activeRequest.method
        },
        savedAt
      };

      updateStore((current) => ({
        ...current,
        workspaces: current.workspaces.map((workspace) => {
          if (workspace.name !== current.activeWorkspaceName) return workspace;
          return {
            ...workspace,
            collections: workspace.collections.map((collection) => {
              if (collection.name !== current.activeCollectionName) return collection;
              return {
                ...collection,
                requests: collection.requests.map((request) =>
                  request.name === activeRequest.name
                    ? { ...request, responseBodyView: "Raw", lastResponse: savedResponse }
                    : request
                )
              };
            })
          };
        })
      }));
      recordRequestHistory({
        request: activeRequest,
        workspaceName: activeWorkspaceName,
        collectionName: activeCollectionName,
        response: savedResponse,
        url: finalUrl,
        error: message,
      });

      await runAfterResponseScript(savedResponse);
    } finally {
      if (activeHttpRequestIdRef.current === requestId) {
        activeHttpRequestIdRef.current = "";
        setIsSending(false);
        setSendStartedAt(0);
      }
    }
  }

  async function cancelSend() {
    const requestId = activeHttpRequestIdRef.current;
    if (!requestId) {
      setIsSending(false);
      setSendStartedAt(0);
      return;
    }

    activeHttpRequestIdRef.current = "";
    setIsSending(false);
    setSendStartedAt(0);

    try {
      await cancelHttpRequest(requestId);
    } catch {
    }
  }

  return {
    store,
    isSending,
    sendStartedAt,
    isHydrated,
    isSetupComplete,
    starCount,
    saveTimerRef,
    resizeRef,
    activeWorkspace,
    activeCollection,
    activeRequest,
    requestTabs,
    response,
    activeWebSocketState: activeRequest
      ? (wsStates[buildRequestKey(activeWorkspace?.name ?? "", activeCollection?.name ?? "", activeRequest.name)] || {
        connected: false,
        connecting: false,
        messageCount: 0,
        lastMessage: "",
        lastEventAt: "",
        error: ""
      })
      : {
        connected: false,
        connecting: false,
        messageCount: 0,
        lastMessage: "",
        lastEventAt: "",
        error: ""
      },
    activeStreamMessages: activeRequest
      ? (streamMessages[buildRequestKey(activeWorkspace?.name ?? "", activeCollection?.name ?? "", activeRequest.name)] || [])
      : [],
    clearActiveStreamMessages: () => {
      if (!activeRequest) return;
      clearStreamMessagesForKey(buildRequestKey(activeWorkspace?.name ?? "", activeCollection?.name ?? "", activeRequest.name));
    },
    SIDEBAR_COLLAPSED_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_REOPEN_WIDTH,
    updateStore,
    handleSidebarTabChange,
    updateActiveRequest,
    handleRequestFieldChange,
    createWorkspaceRecord,
    renameWorkspaceRecord,
    deleteWorkspaceRecord,
    createCollectionRecord,
    renameCollectionRecord,
    deleteCollectionRecord,
    duplicateCollectionRecord,
    importCollectionRecord,
    importRequestRecords,
    createFolderRecord,
    renameFolderRecord,
    deleteFolderRecord,
    updateFolderSettingsRecord,
    createRequestRecord,
    duplicateRequestRecord,
    pasteRequestRecord,
    pasteFolderRecord,
    renameRequestRecord,
    deleteRequestRecord,
    selectWorkspace,
    selectCollection,
    selectRequest,
    togglePinRequestRecord,
    closeRequestTab,
    handleSend,
    connectActiveWebSocket,
    disconnectActiveWebSocket,
    sendActiveWebSocketMessage,
    connectActiveSse,
    disconnectActiveSse,
    connectActiveSocketIo,
    disconnectActiveSocketIo,
    sendActiveSocketIoMessage,
    streamMessages,
    clearStreamMessagesForKey,
    cancelSend,
    checkSetup: async () => {
      try {
        const config = await invoke("get_app_config");
        setIsSetupComplete(!!config.storagePath);
      } catch (error) {
        console.error("Failed to check setup status:", error);
      }
    },
  };
}
