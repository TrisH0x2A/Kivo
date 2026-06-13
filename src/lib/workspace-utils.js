import { createDefaultAppSettings, createDefaultStore, normalizeRequestRecord, orderRequests } from "./workspace-store.js";
import { normalizeAuthState } from "./oauth.js";
export { parseCookies, splitSetCookieHeader } from "./cookie-utils.js";

export const SIDEBAR_COLLAPSED_WIDTH = 52;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_REOPEN_WIDTH = 260;

export function clampSidebarWidth(value) {
  return Math.min(420, Math.max(SIDEBAR_MIN_WIDTH, value));
}

export function normalizeStore(store) {
  const fallback = createDefaultStore();
  const fallbackSettings = createDefaultAppSettings();
  const nextStore = store && typeof store === "object" ? store : fallback;
  const validSidebarTabs = new Set(["requests", "settings"]);
  const workspaces = Array.isArray(nextStore.workspaces)
    ? nextStore.workspaces.map((workspace) => ({
      ...workspace,
      collections: Array.isArray(workspace.collections)
        ? workspace.collections.map((collection) => ({
          ...collection,
          folders: Array.isArray(collection.folders) ? collection.folders.map((folder) => String(folder)) : [],
          folderSettings: Array.isArray(collection.folderSettings)
            ? collection.folderSettings
              .map((setting) => ({
                path: String(setting?.path ?? "").trim(),
                defaultHeaders: Array.isArray(setting?.defaultHeaders) ? setting.defaultHeaders : [],
                defaultAuth: normalizeAuthState(setting?.defaultAuth ?? { type: "inherit" })
              }))
              .filter((setting) => Boolean(setting.path))
            : [],
          requests: orderRequests((collection.requests ?? []).map((request) => normalizeRequestRecord(request))),
          openRequestNames: Array.isArray(collection.openRequestNames) ? collection.openRequestNames : []
        }))
        : []
    }))
    : [];
  const activeWorkspace = workspaces.find((workspace) => workspace.name === nextStore.activeWorkspaceName) ?? workspaces[0] ?? null;
  const activeCollection = activeWorkspace?.collections?.find((c) => c.name === nextStore.activeCollectionName) ?? activeWorkspace?.collections?.[0] ?? null;
  const activeRequestByName = activeCollection?.requests?.find((request) => request.name === nextStore.activeRequestName) ?? null;
  const activeRequestFromOpenTabs = activeCollection?.requests?.find((request) => activeCollection.openRequestNames.includes(request.name)) ?? null;
  const activeRequest = activeRequestByName ?? activeRequestFromOpenTabs ?? activeCollection?.requests?.[0] ?? null;
  const normalizedWorkspaces = workspaces.map((workspace) => {
    if (!activeRequest || workspace.name !== activeWorkspace?.name) {
      return workspace;
    }
    return {
      ...workspace,
      collections: workspace.collections.map((collection) => {
        if (collection.name !== activeCollection?.name) {
          return collection;
        }
        const openRequestNames = Array.isArray(collection.openRequestNames) ? collection.openRequestNames : [];
        if (openRequestNames.includes(activeRequest.name)) {
          return collection;
        }
        return {
          ...collection,
          openRequestNames: [...openRequestNames, activeRequest.name],
        };
      }),
    };
  });
  const requestHistory = Array.isArray(nextStore.requestHistory)
    ? nextStore.requestHistory
      .map((entry) => ({
        id: String(entry?.id || ""),
        workspaceName: String(entry?.workspaceName || ""),
        collectionName: String(entry?.collectionName || ""),
        requestName: String(entry?.requestName || ""),
        requestMode: String(entry?.requestMode || "http"),
        method: String(entry?.method || ""),
        url: String(entry?.url || ""),
        status: Number.isFinite(entry?.status) ? Number(entry.status) : 0,
        statusText: String(entry?.statusText || ""),
        duration: String(entry?.duration || ""),
        size: String(entry?.size || ""),
        ok: Boolean(entry?.ok),
        error: String(entry?.error || ""),
        sentAt: String(entry?.sentAt || "")
      }))
      .filter((entry) => entry.id || entry.sentAt)
      .slice(0, 500)
    : [];

  return {
    version: 1,
    sidebarTab: validSidebarTabs.has(nextStore.sidebarTab) ? nextStore.sidebarTab : "requests",
    storagePath: nextStore.storagePath || null,
    appSettings: {
      ...fallbackSettings,
      ...(nextStore.appSettings && typeof nextStore.appSettings === "object" ? nextStore.appSettings : {}),
      requestTimeoutMs: Number.isFinite(nextStore?.appSettings?.requestTimeoutMs) ? Number(nextStore.appSettings.requestTimeoutMs) : fallbackSettings.requestTimeoutMs,
    },
    sidebarCollapsed: Boolean(nextStore.sidebarCollapsed),
    activeWorkspaceName: activeWorkspace?.name ?? "",
    activeCollectionName: activeCollection?.name ?? "",
    activeRequestName: activeRequest?.name ?? "",
    sidebarWidth: clampSidebarWidth(Number(nextStore.sidebarWidth || fallback.sidebarWidth)),
    workspaces: normalizedWorkspaces,
    requestHistory
  };
}
