import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, ChevronDown, Clock3, Folder, Globe, History, Layers, PanelLeft, Plus, RefreshCw, Search, Settings, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceEnvironments } from "@/hooks/use-workspace-environments.js";
import { searchWorkbench } from "@/lib/workbench-search.js";
import { cn } from "@/lib/utils.js";

export function WorkbenchHeader({ workspaces, workspaceName, collectionName, onWorkspaceChange, onCreateWorkspace, onCollectionSettings, onEnvironments, onEnvironmentChange, onSearch, onToggleSidebar, sidebarOpen, utilities }) {
  const { workspaceEnvironments, workspaceEnvironmentsError, isWorkspaceEnvironmentsLoading, refreshWorkspaceEnvironments, setActiveEnvironment } = useWorkspaceEnvironments(workspaceName);
  const [switching, setSwitching] = useState(false);
  async function changeEnvironment(id) {
    setSwitching(true);
    try { await setActiveEnvironment(id); await onEnvironmentChange(); }
    catch (error) { toast.error(`Environment switch failed: ${error?.message || error}`); }
    finally { setSwitching(false); }
  }
  return (
    <header className="kivo-global-header">
      <button className="kivo-icon-button" type="button" aria-label="Toggle collections" title="Toggle collections" aria-expanded={sidebarOpen} onClick={onToggleSidebar}><PanelLeft /></button>
      <img src="/icon.ico" width="24" height="24" alt="Kivo" className="kivo-brand-mark" />
      <div className="kivo-workspace-picker">
        <select aria-label="Workspace" value={workspaceName || ""} onChange={(event) => onWorkspaceChange(event.target.value)}>
          {!workspaceName && <option value="">No workspace</option>}
          {workspaces.map((workspace) => <option key={workspace.name} value={workspace.name}>{workspace.name}</option>)}
        </select>
        <ChevronDown aria-hidden="true" />
      </div>
      <button type="button" className="kivo-icon-button kivo-new-workspace" title="New workspace" aria-label="New workspace" onClick={onCreateWorkspace}><Plus /></button>
      {collectionName && <button type="button" className="kivo-header-collection" title="Collection settings" onClick={onCollectionSettings}><span aria-hidden="true">/</span><span>{collectionName}</span></button>}
      <button type="button" className="kivo-command-trigger" onClick={onSearch} title="Search requests and commands" aria-label="Search requests and commands"><Search /><span>Search requests, collections, commands...</span></button>
      <div className="kivo-environment-picker">
        <button type="button" className="kivo-icon-button" title="Manage environments" aria-label="Manage environments" disabled={!collectionName} onClick={onEnvironments}><Globe /></button>
        <select aria-label="Active environment" title={workspaceEnvironmentsError || "Active environment"} value={workspaceEnvironmentsError ? "" : workspaceEnvironments.activeEnvironmentId} disabled={!workspaceName || isWorkspaceEnvironmentsLoading || switching || Boolean(workspaceEnvironmentsError)} onChange={(event) => changeEnvironment(event.target.value)}>
          {workspaceEnvironmentsError && <option value="">Unavailable</option>}
          {workspaceEnvironments.environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
        </select>
        <ChevronDown aria-hidden="true" />
      </div>
      {workspaceEnvironmentsError && <button type="button" className="kivo-icon-button" title="Retry loading environments" aria-label="Retry loading environments" onClick={refreshWorkspaceEnvironments}><RefreshCw /></button>}
      {utilities}
    </header>
  );
}

export function WorkbenchStatusBar({ request, response, isSending, connectionState, onHistory, onSettings, onSearch, onToggleSidebar }) {
  const connected = Boolean(connectionState?.connected);
  const state = isSending ? "Request in progress" : connected ? "Stream connected" : request ? response?.badge || "Ready" : "Ready";
  return (
    <footer className="kivo-statusbar" aria-label="Workbench status">
      <div className="kivo-status-primary" role="status"><span className={cn("kivo-status-dot", (isSending || connected) && "is-active")} /><span>{state}</span></div>
      {request && <span className="kivo-status-protocol">{request.requestMode === "http" ? request.method : request.requestMode?.toUpperCase()}</span>}
      {response?.savedAt && <span className="kivo-status-metric"><Clock3 />{response.duration}<span className="text-muted-foreground">{response.size}</span></span>}
      <div className="kivo-status-actions">
        <button type="button" title="Request history" onClick={onHistory}><History /><span>History</span></button>
        <button type="button" title="Command palette" onClick={onSearch}><Search /><span>Commands</span></button>
        <button type="button" title="Toggle collections" aria-label="Toggle sidebar" onClick={onToggleSidebar}><PanelLeft /></button>
        <button type="button" title="Preferences" aria-label="Preferences" onClick={onSettings}><Settings /></button>
      </div>
    </footer>
  );
}

export function WorkbenchSearch({ workspaces, onClose, onSelectRequest, onSelectCollection, onSettings, onNewRequest, canCreateRequest }) {
  const dialogRef = useRef(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const results = useMemo(() => searchWorkbench(workspaces, query), [workspaces, query]);
  const commands = [
    { kind: "command", label: "Preferences", detail: "App settings", run: onSettings, Icon: Settings },
    ...(canCreateRequest ? [{ kind: "command", label: "New HTTP request", detail: "Current collection", run: onNewRequest, Icon: Plus }] : []),
  ].filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase().trim()));
  const items = [...results.slice(0, 100), ...commands];
  const activeIndex = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [activeIndex, query]);
  function choose(item) {
    if (!item) return;
    onClose();
    if (item.run) item.run();
    else if (item.kind === "collection") onSelectCollection(item.workspaceName, item.collectionName);
    else onSelectRequest(item.workspaceName, item.collectionName, item.requestName);
  }
  return (
    <dialog ref={dialogRef} className="kivo-command-dialog" aria-label="Search requests and commands" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="kivo-command-search">
        <Search />
        <input autoFocus role="combobox" aria-label="Search workspace" aria-expanded="true" aria-controls="workbench-search-results" aria-autocomplete="list" aria-activedescendant={items.length ? `workbench-result-${activeIndex}` : undefined} value={query} placeholder="Search requests, URLs, methods, collections..." onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSelected((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % (items.length || 1)); }
          if (event.key === "Enter") { event.preventDefault(); choose(items[activeIndex]); }
        }} />
        <button type="button" className="kivo-icon-button" aria-label="Close search" title="Close search" onClick={onClose}><X /></button>
      </div>
      <div role="listbox" id="workbench-search-results" aria-label="Search results" className="kivo-command-results">
        {items.map((item, index) => {
          const Icon = item.Icon || (item.kind === "collection" ? Folder : Activity);
          return <div role="option" id={`workbench-result-${index}`} aria-selected={activeIndex === index} key={`${item.kind}:${item.workspaceName}:${item.collectionName}:${item.label}`} className="kivo-command-result" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>
            <Icon /><div><strong>{item.label}</strong><span>{item.detail}</span></div><span className="kivo-command-method">{item.method || (item.kind === "collection" ? "Collection" : "Action")}</span><ArrowUpRight />
          </div>;
        })}
        {!items.length && <p className="p-6 text-sm text-muted-foreground">No results for "{query}"</p>}
      </div>
      <div className="kivo-command-footer"><Layers />{results.length} matching requests and collections</div>
    </dialog>
  );
}
