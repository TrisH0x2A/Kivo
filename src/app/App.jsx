/* @refresh reset */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { RequestTabs } from "@/components/workspace/RequestTabs.jsx";
import { SidebarResizer } from "@/components/workspace/SidebarResizer.jsx";
import { Updater } from "@/components/Updater.jsx";
import { WorkspaceModal } from "@/components/workspace/WorkspaceModal.jsx";
import { Button } from "@/components/ui/button.jsx";
import { useTheme } from "@/hooks/use-theme.js";
import { useWorkspaceStore } from "@/hooks/use-workspace-store.js";
import { useEnv } from "@/hooks/use-env.js";
import { getResolvedStoragePath } from "@/lib/http-client.js";
import { doesEventMatchShortcut, isEditableEventTarget, KEYBINDING_ACTIONS, normalizeKeybindingMap } from "@/lib/keybindings.js";
import { SIDEBAR_COLLAPSED_WIDTH } from "@/lib/workspace-utils.js";
import { Toaster } from "sonner";
import {
  Beaker,
  Building2,
  Code2,
  Flame,
  FlaskConical,
  GitBranch,
  Github,
  Globe,
  Layers,
  MoonStar,
  Settings,
  Snowflake,
  SquareKanban,
  Star,
  SunMedium,
  Sunrise,
  TerminalSquare,
  Wheat,
  Zap,
} from "lucide-react";
import { getThemeMeta } from "@/lib/themes.js";

const SetupWizard = lazy(() => import("@/components/workspace/SetupWizard.jsx").then((module) => ({ default: module.SetupWizard })));
const Sidebar = lazy(() => import("@/components/workspace/Sidebar.jsx").then((module) => ({ default: module.Sidebar })));
const WorkspaceView = lazy(() => import("@/components/workspace/WorkspaceView.jsx").then((module) => ({ default: module.WorkspaceView })));
const CollectionSettingsPage = lazy(() => import("@/components/workspace/CollectionSettingsPage.jsx").then((module) => ({ default: module.CollectionSettingsPage })));
const AppSettingsPage = lazy(() => import("@/components/workspace/AppSettingsPage.jsx").then((module) => ({ default: module.AppSettingsPage })));

function WorkspaceFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-background text-[12px] text-muted-foreground">
      Loading...
    </div>
  );
}

const THEME_ICON_MAP = {
  sun: SunMedium,
  flask: FlaskConical,
  github: Github,
  sunrise: Sunrise,
  wheat: Wheat,
  moon: MoonStar,
  beaker: Beaker,
  "git-branch": GitBranch,
  terminal: TerminalSquare,
  flame: Flame,
  snowflake: Snowflake,
  building: Building2,
  zap: Zap,
  code2: Code2,
};

function EnvChip({ globalCount, collectionCount, onClick }) {
  const total = globalCount + collectionCount;

  return (
    <button
      type="button"
      onClick={onClick}
      title={`Workspace Globals: ${globalCount}\nCollection Variables: ${collectionCount}`}
      className="group flex h-7 items-center gap-2 border border-border/40 bg-accent/30 px-2 text-[10px] font-semibold text-muted-foreground shadow-sm transition-all hover:border-primary/40 hover:bg-primary/10 hover:text-foreground"
    >
      <span className="flex items-center gap-1.5 opacity-80 group-hover:opacity-100">
        <Globe className="h-3 w-3 text-primary/80 group-hover:text-primary transition-colors" />
        <span className="uppercase tracking-[0.1em]">ENV</span>
      </span>
      {total > 0 && (
        <span className="flex h-4 min-w-[16px] items-center justify-center border border-primary/25 bg-primary/20 text-[9px] font-bold text-primary">
          {total}
        </span>
      )}
    </button>
  );
}

export default function App() {
  const { theme, setTheme, toggleTheme, themeAppearance } = useTheme();
  const activeThemeMeta = getThemeMeta(theme);
  const ActiveThemeIcon = THEME_ICON_MAP[activeThemeMeta.icon] ?? SunMedium;
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);

  const [settingsConfig, setSettingsConfig] = useState({ tab: "Overview", envTab: "workspace" });
  const [appSettingsTab, setAppSettingsTab] = useState("Storage");

  const [forcedView, setForcedView] = useState(null);

  const {
    store,
    isSending,
    sendStartedAt,
    isSetupComplete,
    resizeRef,
    activeWorkspace,
    activeCollection,
    activeRequest,
    requestTabs,
    response,
    activeWebSocketState,
    activeStreamMessages,
    clearActiveStreamMessages,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_REOPEN_WIDTH,
    updateStore,
    handleSidebarTabChange,
    handleRequestFieldChange,
    createWorkspaceRecord,
    renameWorkspaceRecord,
    deleteWorkspaceRecord,
    createCollectionRecord,
    renameCollectionRecord,
    deleteCollectionRecord,
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
    cancelSend,
    updateActiveRequest,
    checkSetup,
    duplicateCollectionRecord,
    importCollectionRecord,
    importRequestRecords,
  } = useWorkspaceStore();

  const [resolvedPath, setResolvedPath] = useState(null);
  useEffect(() => {
    if (store?.storagePath) {
      setResolvedPath(store.storagePath);
    } else {
      getResolvedStoragePath().then(setResolvedPath).catch(() => { });
    }
  }, [store?.storagePath]);
  const storagePath = resolvedPath;
  const zoomLevelRef = useRef(1);
  const requestClipboardRef = useRef(null);
  const keybindingMap = useMemo(
    () => normalizeKeybindingMap(store?.appSettings?.keybindings),
    [store?.appSettings?.keybindings]
  );

  const applyZoom = useCallback((value) => {
    const MIN_ZOOM = 0.6;
    const MAX_ZOOM = 2;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
    zoomLevelRef.current = next;
    document.documentElement.style.zoom = String(next);
  }, []);

  useEffect(() => {
    if (/Macintosh/.test(navigator.userAgent)) {
      document.body.classList.add("macos");
    }
  }, []);

  useEffect(() => {
    const ZOOM_STEP = 0.1;

    function selectTabByOffset(offset) {
      if (!activeWorkspace || !activeCollection || !activeRequest || requestTabs.length < 2) {
        return;
      }
      const currentIndex = requestTabs.findIndex((item) => item.name === activeRequest.name);
      if (currentIndex < 0) return;
      const nextIndex = (currentIndex + offset + requestTabs.length) % requestTabs.length;
      const nextTab = requestTabs[nextIndex];
      if (!nextTab) return;
      selectRequest(activeWorkspace.name, activeCollection.name, nextTab.name);
    }

    function runShortcutAction(actionId) {
      switch (actionId) {
        case "app.openSettings":
          openAppSettings();
          break;
        case "app.openKeybindings":
          openAppSettings("Keybindings");
          break;
        case "app.openCollectionSettings":
          if (activeWorkspace && activeCollection) {
            openCollectionSettings("Overview");
          }
          break;
        case "view.toggleTheme":
          toggleTheme();
          break;
        case "collection.duplicate":
          if (activeWorkspace && activeCollection) {
            duplicateCollectionRecord(activeWorkspace.name, activeCollection.name);
          }
          break;
        case "collection.delete":
          if (activeWorkspace && activeCollection) {
            deleteCollectionRecord(activeWorkspace.name, activeCollection.name);
          }
          break;
        case "request.send":
          if (activeRequest) {
            handleSend();
          }
          break;
        case "request.cancel":
          if (isSending) {
            cancelSend();
          }
          break;
        case "request.new":
          if (activeWorkspace) {
            createRequestRecord(activeWorkspace.name, activeCollection?.name ?? "");
          }
          break;
        case "request.duplicate":
          if (activeWorkspace && activeCollection && activeRequest) {
            duplicateRequestRecord(activeWorkspace.name, activeCollection.name, activeRequest.name);
          }
          break;
        case "request.copy":
          if (activeRequest) {
            requestClipboardRef.current = JSON.parse(JSON.stringify(activeRequest));
          }
          break;
        case "request.paste":
          if (activeWorkspace && activeCollection && requestClipboardRef.current) {
            pasteRequestRecord(activeWorkspace.name, activeCollection.name, requestClipboardRef.current);
          }
          break;
        case "request.delete":
          if (activeWorkspace && activeCollection && activeRequest) {
            deleteRequestRecord(activeWorkspace.name, activeCollection.name, activeRequest.name);
          }
          break;
        case "tab.close":
          if (activeRequest) {
            closeRequestTab(activeRequest.name);
          }
          break;
        case "tab.next":
          selectTabByOffset(1);
          break;
        case "tab.previous":
          selectTabByOffset(-1);
          break;
        case "sidebar.toggle":
          updateStore((current) => ({
            ...current,
            sidebarCollapsed: !current.sidebarCollapsed,
            sidebarWidth: Math.max(current.sidebarWidth, SIDEBAR_REOPEN_WIDTH),
          }));
          break;
        case "view.zoomIn":
          applyZoom(zoomLevelRef.current + ZOOM_STEP);
          break;
        case "view.zoomOut":
          applyZoom(zoomLevelRef.current - ZOOM_STEP);
          break;
        case "view.zoomReset":
          applyZoom(1);
          break;
        default:
          break;
      }
    }

    function handleGlobalKeydown(event) {
      for (const action of KEYBINDING_ACTIONS) {
        const shortcut = keybindingMap[action.id];
        if (!shortcut) continue;
        if (!doesEventMatchShortcut(event, shortcut)) continue;
        if (isEditableEventTarget(event.target) && !action.allowInInput) return;
        event.preventDefault();
        runShortcutAction(action.id);
        return;
      }
    }

    window.addEventListener("keydown", handleGlobalKeydown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
    };
  }, [
    activeCollection,
    activeRequest,
    activeWorkspace,
    applyZoom,
    cancelSend,
    closeRequestTab,
    createRequestRecord,
    deleteRequestRecord,
    deleteCollectionRecord,
    duplicateCollectionRecord,
    duplicateRequestRecord,
    handleSend,
    isSending,
    keybindingMap,
    pasteRequestRecord,
    requestTabs,
    selectRequest,
    toggleTheme,
    updateStore,
    SIDEBAR_REOPEN_WIDTH,
  ]);

  const { vars: envVars, refresh: refreshEnvVars } = useEnv(activeWorkspace?.name, activeCollection?.name);

  function handleSelectRequest(workspaceName, collectionName, requestName) {
    setForcedView(null);
    handleSidebarTabChange("requests");
    refreshEnvVars();
    selectRequest(workspaceName, collectionName, requestName);
  }

  function openCollectionSettings(tab = "Overview", envTab = "workspace") {
    setSettingsConfig({ tab, envTab });
    handleSidebarTabChange("requests");
    setForcedView("collectionSettings");

  }

  function openAppSettings(tab = "Storage") {
    setAppSettingsTab(tab);
    handleSidebarTabChange("settings");
    setForcedView("appSettings");
  }

  function handleSidebarTabChangeWithView(sidebarTab) {
    handleSidebarTabChange(sidebarTab);
    if (sidebarTab === "settings") {
      setForcedView("appSettings");
      return;
    }
    if (sidebarTab === "requests") {
      setForcedView(null);
    }
  }

  if (!isSetupComplete) {
    return (
      <Suspense fallback={<WorkspaceFallback />}>
        <SetupWizard onComplete={checkSetup} />
      </Suspense>
    );
  }

  const sidebarWidth = store.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : store.sidebarWidth;

  const showNoWorkspaceState = !activeWorkspace;
  const showNoCollectionsState = activeWorkspace && activeWorkspace.collections.length === 0;

  const showAppSettings = forcedView === "appSettings";

  const showCollectionSettings =
    !showAppSettings &&
    !showNoWorkspaceState &&
    !showNoCollectionsState &&
    activeCollection &&
    (forcedView === "collectionSettings" || !activeRequest);

  const showWorkspaceView = !showAppSettings && activeRequest && forcedView !== "collectionSettings";

  const globalVarCount = envVars?.workspace?.length ?? 0;
  const collectionVarCount = envVars?.collection?.length ?? 0;

  return (
    <div className="h-full overflow-hidden">
      <Updater />
      <Toaster
        position="top-right"
        closeButton
        richColors
        theme={themeAppearance}
        toastOptions={{
          className: "border border-border/50 bg-card/96 text-foreground shadow-xl",
        }}
      />
      {showWorkspaceModal && (
        <WorkspaceModal
          title="New Workspace"
          submitLabel="Create"
          existingNames={store.workspaces.map((w) => w.name)}
          onSubmit={(v) => {
            createWorkspaceRecord(v);
            setShowWorkspaceModal(false);
          }}
          onCancel={() => setShowWorkspaceModal(false)}
        />
      )}
      <div className="kivo-app-shell flex h-full min-h-0 overflow-hidden border border-border/40">
        <div style={{ width: `${sidebarWidth}px` }} className="min-h-0 shrink-0 overflow-hidden">
          <Suspense fallback={<WorkspaceFallback />}>
            <Sidebar
              iconSrc="/icon.ico"
              sidebarTab={store.sidebarTab}
              collapsed={store.sidebarCollapsed}
              workspaces={store.workspaces}
              activeWorkspaceName={store.activeWorkspaceName}
              activeCollectionName={store.activeCollectionName}
              activeRequestName={store.activeRequestName}
              onSidebarTabChange={handleSidebarTabChangeWithView}
              onSelectWorkspace={selectWorkspace}
              onSelectCollection={(wName, cName) => {
                selectCollection(wName, cName);
                openCollectionSettings("Overview");
              }}
              onOpenCollectionSettings={() => openCollectionSettings("Overview")}
              onOpenAppSettings={openAppSettings}
              onSelectRequest={handleSelectRequest}
              onCreateWorkspace={createWorkspaceRecord}
              onRenameWorkspace={renameWorkspaceRecord}
              onDeleteWorkspace={deleteWorkspaceRecord}
              onCreateCollection={createCollectionRecord}
              onRenameCollection={renameCollectionRecord}
              onDeleteCollection={deleteCollectionRecord}
              onDuplicateCollection={duplicateCollectionRecord}
              onImportCollection={importCollectionRecord}
              onCreateFolder={createFolderRecord}
              onRenameFolder={renameFolderRecord}
              onDeleteFolder={deleteFolderRecord}
              onUpdateFolderSettings={updateFolderSettingsRecord}
              onCreateRequest={createRequestRecord}
              onRenameRequest={renameRequestRecord}
              onDeleteRequest={deleteRequestRecord}
              onDuplicateRequest={duplicateRequestRecord}
              onImportRequests={importRequestRecords}
              onPasteRequest={pasteRequestRecord}
              onPasteFolder={pasteFolderRecord}
              onTogglePinRequest={togglePinRequestRecord}
            />
          </Suspense>
        </div>

        <SidebarResizer
          onMouseDown={(event) => {
            resizeRef.current = { active: true, startX: event.clientX, startWidth: sidebarWidth };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
        />

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {showAppSettings ? (
            <Suspense fallback={<WorkspaceFallback />}>
              <AppSettingsPage
                initialTab={appSettingsTab}
                storagePath={storagePath}
                theme={theme}
                onThemeChange={setTheme}
                onStoragePathChanged={(nextPath) => {
                  setResolvedPath(nextPath);
                  window.location.reload();
                }}
                requestHistory={store.requestHistory || []}
                onClearHistory={() => updateStore((current) => ({ ...current, requestHistory: [] }))}
              />
            </Suspense>
          ) : showNoWorkspaceState ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
              <div className="mb-6 flex h-16 w-16 items-center justify-center border border-primary/30 bg-primary/10">
                <SquareKanban className="h-8 w-8 text-primary" />
              </div>
              <div className="max-w-md space-y-2">
                <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">No Workspace Yet</div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">Create a workspace to get started</h2>
                <p className="text-muted-foreground">Start with your own workspace and build it the way you want.</p>
              </div>
              <Button className="mt-8 h-11 px-8" onClick={() => setShowWorkspaceModal(true)}>
                Create workspace
              </Button>
            </div>
          ) : showNoCollectionsState ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
              <div className="mb-6 flex h-16 w-16 items-center justify-center border border-primary/30 bg-primary/10">
                <Layers className="h-8 w-8 text-primary" />
              </div>
              <div className="max-w-md space-y-2">
                <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">No Collections Yet</div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">Create your first collection</h2>
                <p className="text-muted-foreground">Organize your requests by creating a collection first.</p>
              </div>
              <Button className="mt-8 h-11 px-8" onClick={() => createCollectionRecord(activeWorkspace.name, "New Collection")}>
                Create collection
              </Button>
            </div>
          ) : showCollectionSettings ? (

            <>
              { }
              <div data-tauri-drag-region className="kivo-topbar flex shrink-0 items-center justify-between border-b border-border/25 px-5 py-3 backdrop-blur-md">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="text-[17px] font-semibold tracking-tight text-foreground truncate">
                    {activeCollection?.name ?? "Collection"}
                  </div>
                </div>
                { }
                <div className="flex items-center gap-2">
                  {activeWorkspace && (
                    <>
                      <EnvChip
                        globalCount={globalVarCount}
                        collectionCount={collectionVarCount}
                        onClick={() => openCollectionSettings("Environments", "workspace")}
                      />
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <button
                    type="button"
                    className="kivo-command flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-muted-foreground transition-all hover:text-foreground"
                    onClick={() => openUrl("https://github.com/DevlogZz/Kivo")}
                  >
                    <Github className="h-[16px] w-[16px]" />
                    <span className="text-[11px] font-semibold">GitHub</span>
                    <Star className="h-[14px] w-[14px] fill-current text-yellow-500/80" />
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    onClick={toggleTheme}
                    title={`Switch theme (current: ${activeThemeMeta.label})`}
                  >
                    <ActiveThemeIcon className="h-[18px] w-[18px]" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    onClick={() => openCollectionSettings("Overview")}
                    title="Collection Settings"
                  >
                    <Settings className="h-[18px] w-[18px]" />
                  </Button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-hidden">
                <Suspense fallback={<WorkspaceFallback />}>
                  <CollectionSettingsPage
                    key={`${activeWorkspace?.name}-${activeCollection?.name}-${settingsConfig.tab}-${settingsConfig.envTab}`}
                    workspace={activeWorkspace}
                    collection={activeCollection}
                    storagePath={storagePath}
                    initialTab={settingsConfig.tab}
                    initialEnvTab={settingsConfig.envTab}
                    onEnvSave={refreshEnvVars}
                  />
                </Suspense>
              </div>
            </>
          ) : showWorkspaceView ? (

            <>
              <div data-tauri-drag-region className="kivo-topbar flex shrink-0 items-center justify-between border-b border-border/25 px-5 py-3.5 backdrop-blur-md">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <div className="text-[18px] font-semibold tracking-tight text-foreground">
                      {activeCollection?.name ?? "No Collection"}
                    </div>
                  </div>
                </div>
                { }
                <div className="flex items-center gap-2">
                  {activeCollection && (
                    <>
                      <EnvChip
                        globalCount={globalVarCount}
                        collectionCount={collectionVarCount}
                        onClick={() => openCollectionSettings("Environments", "workspace")}
                      />
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <button
                    type="button"
                    className="kivo-command flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-muted-foreground transition-all hover:text-foreground"
                    onClick={() => openUrl("https://github.com/DevlogZz/Kivo")}
                  >
                    <Github className="h-[16px] w-[16px]" />
                    <span className="text-[11px] font-semibold">GitHub</span>
                    <Star className="h-[14px] w-[14px] fill-current text-yellow-500/80" />
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    onClick={toggleTheme}
                    title={`Switch theme (current: ${activeThemeMeta.label})`}
                  >
                    <ActiveThemeIcon className="h-[18px] w-[18px]" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    onClick={() => openCollectionSettings("Overview")}
                    title="Collection Settings"
                  >
                    <Settings className="h-[18px] w-[18px]" />
                  </Button>
                </div>
              </div>

              <div className="flex min-h-0 shrink-0 border-b border-border/25 bg-background/25">
                <RequestTabs
                  activeWorkspaceName={activeWorkspace?.name}
                  activeCollectionName={activeCollection?.name}
                  activeRequestName={activeRequest?.name}
                  requestTabs={requestTabs}
                  selectRequest={handleSelectRequest}
                  closeRequestTab={closeRequestTab}
                  createRequestRecord={createRequestRecord}
                />
              </div>

              <div className="min-h-0 flex-1 overflow-hidden bg-background/20">
                <Suspense fallback={<WorkspaceFallback />}>
                  <WorkspaceView
                    request={activeRequest}
                    isSending={isSending}
                    sendStartedAt={sendStartedAt}
                    onSend={handleSend}
                    wsState={activeWebSocketState}
                    onWebSocketConnect={connectActiveWebSocket}
                    onWebSocketDisconnect={disconnectActiveWebSocket}
                    onWebSocketSend={sendActiveWebSocketMessage}
                    streamMessages={activeStreamMessages}
                    onClearStreamMessages={clearActiveStreamMessages}
                    onCancelSend={cancelSend}
                    onFieldChange={handleRequestFieldChange}
                    onUpdateActiveRequest={updateActiveRequest}
                    onClearResponse={() => updateActiveRequest({ lastResponse: null })}
                    response={response}
                    envVars={envVars}
                    workspaceName={activeWorkspace?.name}
                    collectionName={activeCollection?.name}
                  />
                </Suspense>
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

