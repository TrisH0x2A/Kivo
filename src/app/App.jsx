/* @refresh reset */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { WorkbenchHeader, WorkbenchSearch, WorkbenchStatusBar } from "@/components/workspace/WorkbenchChrome.jsx";
import { RequestTabs } from "@/components/workspace/RequestTabs.jsx";
import { SidebarResizer } from "@/components/workspace/SidebarResizer.jsx";
import { Updater } from "@/components/Updater.jsx";
import { WorkspaceModal } from "@/components/workspace/WorkspaceModal.jsx";
import { Button } from "@/components/ui/button.jsx";
import { useTheme } from "@/hooks/use-theme.js";
import { useWorkspaceStore } from "@/hooks/use-workspace-store.js";
import { useEnv } from "@/hooks/use-env.js";
import { useGithubStars } from "@/hooks/use-github-stars.js";
import { formatStarCount } from "@/lib/github-stars.js";
import { getResolvedStoragePath } from "@/lib/http-client.js";
import { doesEventMatchShortcut, isEditableEventTarget, KEYBINDING_ACTIONS, normalizeKeybindingMap } from "@/lib/keybindings.js";
import { Toaster } from "sonner";
import {
  AlertTriangle,
  Beaker,
  Building2,
  Code2,
  Flame,
  FlaskConical,
  GitBranch,
  Github,
  Layers,
  MoonStar,
  RefreshCw,
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

function ChromeActions({
  activeThemeMeta,
  ActiveThemeIcon,
  githubStars,
  onOpenGithub,
  onToggleTheme,
}) {
  const formattedStars = formatStarCount(githubStars);

  return (
    <div className="kivo-chrome-actions" aria-label="App utilities">
      <button
        type="button"
        className="kivo-chrome-action"
        onClick={onOpenGithub}
        title={githubStars === null ? "Kivo on GitHub (star count unavailable)" : `${githubStars.toLocaleString()} stars on GitHub`}
        aria-label={githubStars === null ? "Open Kivo on GitHub. Star count unavailable" : `Open Kivo on GitHub. ${githubStars} stars`}
      >
        <Github className="h-3.5 w-3.5" />
        <span className="min-w-[3ch] font-mono tabular-nums">{formattedStars}</span>
        <Star className="h-3 w-3 fill-current text-yellow-500/90" />
      </button>
      <button
        type="button"
        className="kivo-chrome-action"
        onClick={onToggleTheme}
        title={`Switch theme (current: ${activeThemeMeta.label})`}
        aria-label={`Switch theme. Current theme: ${activeThemeMeta.label}`}
      >
        <ActiveThemeIcon className="h-3.5 w-3.5" />
        <span>{activeThemeMeta.label}</span>
      </button>
    </div>
  );
}

export default function App() {
  const { theme, setTheme, toggleTheme, themeAppearance } = useTheme();
  const activeThemeMeta = getThemeMeta(theme);
  const ActiveThemeIcon = THEME_ICON_MAP[activeThemeMeta.icon] ?? SunMedium;
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const githubStars = useGithubStars();
  const [searchOpen, setSearchOpen] = useState(false);

  const [settingsConfig, setSettingsConfig] = useState({ tab: "Overview", envTab: "workspace" });
  const [appSettingsTab, setAppSettingsTab] = useState("Storage");

  const [forcedView, setForcedView] = useState(null);

  const {
    store,
    isSending,
    sendStartedAt,
    isSetupComplete,
    isHydrated,
    isRenaming,
    loadError,
    retryLoad,
    resizeRef,
    activeWorkspace,
    activeCollection,
    activeRequest,
    requestTabs,
    response,
    activeWebSocketState,
    activeStreamMessages,
    clearActiveStreamMessages,
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

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const onChange = () => { setCompactLayout(query.matches); setMobileNavigationOpen(false); };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

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
        case "app.search":
          setSearchOpen(true);
          break;
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
          if (compactLayout) {
            setMobileNavigationOpen((open) => !open);
            break;
          }
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
      if (!isHydrated || isRenaming || event.target.closest?.("dialog[open]")) return;
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
    compactLayout,
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
    isHydrated,
    isRenaming,
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

  if (loadError) {
    return (
      <main className="h-dvh overflow-auto bg-background p-8 text-foreground">
        <section className="max-w-xl space-y-4" role="alert">
          <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Unable to load your workspace</h1>
          <p className="text-sm text-muted-foreground">Editing and autosave are paused. Check that your storage folder is available, then try again.</p>
          <pre className="whitespace-pre-wrap break-words border-l-2 border-destructive/50 pl-3 text-xs text-muted-foreground">{loadError}</pre>
          <Button onClick={retryLoad}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
        </section>
      </main>
    );
  }

  if (isSetupComplete === false) {
    return (
      <Suspense fallback={<WorkspaceFallback />}>
        <SetupWizard onComplete={checkSetup} />
      </Suspense>
    );
  }

  if (!isHydrated) return <WorkspaceFallback />;

  const sidebarWidth = store.sidebarCollapsed ? 0 : store.sidebarWidth;
  function toggleSidebar() {
    if (window.matchMedia("(max-width: 720px)").matches) setMobileNavigationOpen((open) => !open);
    else updateStore((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed, sidebarWidth: Math.max(current.sidebarWidth, SIDEBAR_REOPEN_WIDTH) }));
  }

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
      {isRenaming && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60" role="status" aria-live="polite">
          <span className="flex items-center gap-2 text-sm text-foreground"><RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />Renaming...</span>
        </div>
      )}
      <div inert={isRenaming || undefined} aria-busy={isRenaming} className="kivo-app-shell flex h-full min-h-0 flex-col overflow-hidden border border-border/10">
        <WorkbenchHeader
          key={activeWorkspace?.name}
          workspaces={store.workspaces}
          workspaceName={activeWorkspace?.name}
          collectionName={activeCollection?.name}
          onWorkspaceChange={(name) => { setForcedView(null); handleSidebarTabChange("requests"); selectWorkspace(name); }}
          onCreateWorkspace={() => setShowWorkspaceModal(true)}
          onCollectionSettings={() => openCollectionSettings()}
          onEnvironments={() => openCollectionSettings("Environments", "workspace")}
          onEnvironmentChange={refreshEnvVars}
          onSearch={() => setSearchOpen(true)}
          onToggleSidebar={toggleSidebar}
          sidebarOpen={compactLayout ? mobileNavigationOpen : !store.sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          utilities={<ChromeActions activeThemeMeta={activeThemeMeta} ActiveThemeIcon={ActiveThemeIcon} githubStars={githubStars} onOpenGithub={() => openUrl("https://github.com/TrisH0x2A/Kivo")} onToggleTheme={toggleTheme} />}
        />
        {searchOpen && <WorkbenchSearch
          workspaces={store.workspaces} onClose={() => setSearchOpen(false)}
          onSelectRequest={handleSelectRequest}
          onSelectCollection={(workspace, collection) => { selectCollection(workspace, collection); openCollectionSettings(); }}
          onSettings={() => openAppSettings()}
          canCreateRequest={Boolean(activeWorkspace && activeCollection)}
          onNewRequest={() => { setForcedView(null); handleSidebarTabChange("requests"); createRequestRecord(activeWorkspace.name, activeCollection.name); }}
        />}
        {mobileNavigationOpen && <button type="button" className="kivo-navigation-backdrop" aria-label="Close collections" onClick={() => setMobileNavigationOpen(false)} />}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div style={{ width: `${sidebarWidth}px` }} data-mobile-open={mobileNavigationOpen} className="kivo-sidebar-slot min-h-0 shrink-0 overflow-hidden">
            <Suspense fallback={<WorkspaceFallback />}>
              <Sidebar
                iconSrc="/icon.ico"
                sidebarTab={store.sidebarTab}
                collapsed={store.sidebarCollapsed && !mobileNavigationOpen}
                workspaces={store.workspaces}
                activeWorkspaceName={store.activeWorkspaceName}
                activeCollectionName={store.activeCollectionName}
                activeRequestName={store.activeRequestName}
                onSidebarTabChange={handleSidebarTabChangeWithView}
                onSelectWorkspace={selectWorkspace}
                onSelectCollection={(wName, cName) => {
                  setMobileNavigationOpen(false);
                  selectCollection(wName, cName);
                  openCollectionSettings("Overview");
                }}
                onOpenCollectionSettings={() => openCollectionSettings("Overview")}
                onOpenAppSettings={() => { setMobileNavigationOpen(false); openAppSettings(); }}
                settingsActive={showAppSettings}
                onSelectRequest={(...args) => { setMobileNavigationOpen(false); handleSelectRequest(...args); }}
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

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
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
              <div className="min-h-0 flex-1 overflow-hidden bg-background">
                <Suspense fallback={<WorkspaceFallback />}>
                  <WorkspaceView
                    requestTabs={<RequestTabs activeWorkspaceName={activeWorkspace?.name} activeCollectionName={activeCollection?.name} activeRequestName={activeRequest?.name} requestTabs={requestTabs} selectRequest={handleSelectRequest} closeRequestTab={closeRequestTab} createRequestRecord={createRequestRecord} />}
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
                    collection={activeCollection}
                    workspaceName={activeWorkspace?.name}
                    collectionName={activeCollection?.name}
                  />
                </Suspense>
              </div>
            </>
          ) : null}
          </main>
        </div>
        <WorkbenchStatusBar request={activeRequest} response={response} isSending={isSending} connectionState={activeWebSocketState} onHistory={() => openAppSettings("History")} onSettings={() => openAppSettings()} onSearch={() => setSearchOpen(true)} onToggleSidebar={toggleSidebar} />
      </div>
    </div>
  );
}

