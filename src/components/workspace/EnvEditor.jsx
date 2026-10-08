import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { useEnv } from "@/hooks/use-env.js";
import { cn } from "@/lib/utils.js";
import { getEnvVars, saveEnvVars } from "@/lib/http-client.js";
import { mergeStorage } from "@/lib/storage-merge.js";
import { StorageConflictReview } from "./StorageConflictReview.jsx";

function createRow(key = "", value = "") {
  return { id: `env-${Math.random().toString(36).slice(2, 8)}`, key, value, secret: false };
}

function rowsFromVars(vars = []) {
  return vars.map((v) => ({ ...createRow(v.key, v.value), secret: false }));
}

function validateRows(rows) {
  const issues = [];
  const seen = new Set();
  const pattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

  rows.forEach((row) => {
    const key = row.key.trim();
    if (!key) return;
    if (!pattern.test(key)) {
      issues.push(`"${key}" is not a valid env key. Use letters, numbers, and underscores only.`);
    }
    if (seen.has(key)) {
      issues.push(`"${key}" is duplicated.`);
    }
    seen.add(key);
  });

  return issues;
}

function EnvTable({ rows, onChange, workspaceVarKeys = [] }) {
  function updateRow(id, field, value) {
    onChange(rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function removeRow(id) {
    const nextRows = rows.filter((r) => r.id !== id);
    onChange(nextRows);
  }

  function addRow() {
    onChange([...rows, createRow()]);
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_44px] border-b border-border/10 bg-transparent px-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        <div className="px-2 py-2.5 font-semibold">Variable</div>
        <div className="px-2 py-2.5 font-semibold">Initial Value</div>
        <div className="py-2.5 text-center font-semibold">Secret</div>
        <div className="py-2.5" />
      </div>

      <div className="thin-scrollbar overflow-auto">
        {rows.map((row) => {
          const overridesGlobal = workspaceVarKeys.includes(row.key.trim()) && row.key.trim();
          return (
            <div
              key={row.id}
              className="group grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_44px] items-center border-b border-border/5 bg-transparent px-2 transition-colors hover:bg-transparent"
            >
              <div className="relative flex h-10 items-center">
                <Input
                  value={row.key}
                  onChange={(e) => updateRow(row.id, "key", e.target.value)}
                  placeholder="e.g. API_URL"
                  className="h-full w-full rounded-none border-0 bg-transparent px-2 text-[13px] font-medium shadow-none focus-visible:bg-transparent focus-visible:ring-0"
                />
                {overridesGlobal ? (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border border-amber-500/20 bg-transparent px-1 text-[9px] uppercase tracking-wider text-amber-500/80 shadow-sm pointer-events-none">
                    overrides global
                  </span>
                ) : null}
              </div>
              <div className="relative flex h-10 items-center">
                <Input
                  value={row.value}
                  onChange={(e) => updateRow(row.id, "value", e.target.value)}
                  placeholder="e.g. localhost:8080"
                  type={row.secret ? "password" : "text"}
                  className="h-full w-full rounded-none border-0 bg-transparent px-2 font-mono text-[13px] text-muted-foreground shadow-none focus-visible:bg-transparent focus-visible:text-foreground focus-visible:ring-0"
                />
              </div>
              <div className="flex h-10 items-center justify-center">
                <button
                  type="button"
                  title={row.secret ? "Show value" : "Mask value"}
                  onClick={() => updateRow(row.id, "secret", !row.secret)}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                    row.secret
                      ? "bg-primary/10 text-primary hover:bg-primary/20"
                      : "text-muted-foreground hover:bg-transparent hover:text-foreground"
                  )}
                >
                  {row.secret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <div className="flex h-10 items-center justify-center">
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}

        <div className="p-2">
          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <span className="mb-0.5 text-lg leading-none">+</span> Add Variable
          </button>
        </div>
      </div>
    </div>
  );
}

export function EnvEditor({
  workspaceName,
  collectionName,
  workspaceEnvironmentId = null,
  initialTab = "workspace",
  onSave: onSaveProp,
}) {
  const { vars, isLoading } = useEnv(workspaceName, collectionName, workspaceEnvironmentId);

  const [activeTab, setActiveTab] = useState(initialTab);
  const [workspaceDraft, setWorkspaceDraft] = useState([]);
  const [collectionDraft, setCollectionDraft] = useState([]);
  const [baselineWorkspace, setBaselineWorkspace] = useState([]);
  const [baselineCollection, setBaselineCollection] = useState([]);
  const [isSaving, setIsSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const hasHydratedRef = useRef(false);
  const revisionsRef = useRef({});
  const [conflict, setConflict] = useState(null);
  const [error, setError] = useState("");

  const isDirty = useMemo(() => {
    if (!hasHydratedRef.current) return false;

    const cleanWorkspace = workspaceDraft.filter((r) => r.key.trim() || r.value.trim());
    const origWorkspace = baselineWorkspace || [];
    if (cleanWorkspace.length !== origWorkspace.length) return true;
    for (let i = 0; i < cleanWorkspace.length; i += 1) {
      if (cleanWorkspace[i].key !== origWorkspace[i].key || cleanWorkspace[i].value !== origWorkspace[i].value) return true;
    }

    const cleanCollection = collectionDraft.filter((r) => r.key.trim() || r.value.trim());
    const origCollection = baselineCollection || [];
    if (cleanCollection.length !== origCollection.length) return true;
    for (let i = 0; i < cleanCollection.length; i += 1) {
      if (cleanCollection[i].key !== origCollection[i].key || cleanCollection[i].value !== origCollection[i].value) return true;
    }

    return false;
  }, [workspaceDraft, collectionDraft, baselineWorkspace, baselineCollection]);

  const workspaceIssues = useMemo(() => validateRows(workspaceDraft), [workspaceDraft]);
  const collectionIssues = useMemo(() => validateRows(collectionDraft), [collectionDraft]);
  const activeIssues = activeTab === "workspace" ? workspaceIssues : collectionIssues;

  useLayoutEffect(() => {
    if (typeof vars.workspaceRevision !== "string") return;
    if (hasHydratedRef.current && isDirty) return;
    const nextWorkspace = vars.workspace || [];
    const nextCollection = vars.collection || [];
    setWorkspaceDraft(rowsFromVars(nextWorkspace));
    setCollectionDraft(rowsFromVars(nextCollection));
    setBaselineWorkspace(nextWorkspace);
    setBaselineCollection(nextCollection);
    hasHydratedRef.current = true;
    revisionsRef.current = { workspace: vars.workspaceRevision, collection: vars.collectionRevision };
  }, [vars.workspace, vars.collection]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const cleanRows = (rows) => rows.filter((row) => row.key.trim()).map(({ key, value }) => ({ key, value }));
  useEffect(() => {
    if (isLoading || isSaving || conflict || !hasHydratedRef.current) return;
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const remote = await getEnvVars(workspaceName, collectionName, workspaceEnvironmentId);
        if (cancelled) return;
        for (const scope of collectionName ? ["workspace", "collection"] : ["workspace"]) {
          if (revisionsRef.current[scope] && remote[`${scope}Revision`] !== revisionsRef.current[scope]) {
            setConflict({ scope, base: cleanRows(scope === "workspace" ? baselineWorkspace : baselineCollection), remote: remote[scope], revision: remote[`${scope}Revision`] });
            break;
          }
        }
      } catch (error) { if (!cancelled) setError(String(error?.message || error)); }
      finally { checking = false; }
    };
    const timer = window.setInterval(check, 8000);
    window.addEventListener("focus", check);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", check); };
  }, [workspaceName, collectionName, workspaceEnvironmentId, isLoading, isSaving, conflict, baselineWorkspace, baselineCollection]);

  async function handleSave() {
    setIsSaving(true);
    setError("");
    try {
      for (const scope of collectionName ? ["workspace", "collection"] : ["workspace"]) {
        const local = cleanRows(scope === "workspace" ? workspaceDraft : collectionDraft);
        const base = cleanRows(scope === "workspace" ? baselineWorkspace : baselineCollection);
        if (JSON.stringify(local) === JSON.stringify(base)) continue;
        if (!revisionsRef.current[scope]) throw new Error("Reload the environment before saving.");
        try {
          const revision = await saveEnvVars(workspaceName, scope === "collection" ? collectionName : null, local, workspaceEnvironmentId, revisionsRef.current[scope]);
          revisionsRef.current[scope] = revision;
          (scope === "workspace" ? setBaselineWorkspace : setBaselineCollection)(local);
        } catch (error) {
          if (String(error?.message || error).startsWith("KIVO_EXTERNAL_CHANGE:")) {
            const remote = await getEnvVars(workspaceName, collectionName, workspaceEnvironmentId);
            setConflict({ scope, base, remote: remote[scope], revision: remote[`${scope}Revision`] });
            return;
          }
          throw error;
        }
      }
      onSaveProp?.();
      setSavedFeedback(true);
      window.setTimeout(() => setSavedFeedback(false), 1800);
    } catch (error) { setError(String(error?.message || error)); }
    finally {
      setIsSaving(false);
    }
  }

  const localConflictRows = conflict ? cleanRows(conflict.scope === "workspace" ? workspaceDraft : collectionDraft) : [];
  const review = conflict ? mergeStorage(conflict.base, localConflictRows, conflict.remote) : null;
  function resolveConflict(choice, choices) {
    const rows = choice === "remote" ? conflict.remote : choice === "local" ? localConflictRows : mergeStorage(conflict.base, localConflictRows, conflict.remote, choices).value;
    (conflict.scope === "workspace" ? setWorkspaceDraft : setCollectionDraft)(rowsFromVars(rows));
    (conflict.scope === "workspace" ? setBaselineWorkspace : setBaselineCollection)(conflict.remote);
    revisionsRef.current[conflict.scope] = conflict.revision;
    setConflict(null);
  }

  const workspaceKeys = vars.workspace.map((v) => v.key);

  if (isLoading && !hasHydratedRef.current) {
    return (
      <div className="flex h-40 items-center justify-center text-[12px] text-muted-foreground animate-pulse">
        Loading variables...
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {review && <StorageConflictReview key={conflict.revision} title="Environment changed on disk" review={review} onResolve={resolveConflict} />}
      {error && <p role="alert" className="p-3 text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-between border-b border-border/25 bg-transparent px-4 pt-1">
        <div className="flex items-center gap-1">
          {[
            { id: "workspace", label: "Workspace Globals" },
            { id: "collection", label: "Collection Variables" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2.5 text-[12px] transition-colors",
                activeTab === tab.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span className="pr-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
          {activeTab === "workspace"
            ? `${workspaceDraft.filter((r) => r.key.trim()).length} workspace variables`
            : `${collectionDraft.filter((r) => r.key.trim()).length} collection variables`}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden bg-transparent">
        {activeIssues.length ? (
          <div className="border-b border-warning/20 bg-warning/10 px-4 py-2 text-[11px] text-warning">
            {activeIssues[0]}
          </div>
        ) : null}
        {activeTab === "workspace" ? (
          <EnvTable
            rows={workspaceDraft}
            onChange={setWorkspaceDraft}
          />
        ) : (
          <EnvTable
            rows={collectionDraft}
            onChange={setCollectionDraft}
            workspaceVarKeys={workspaceKeys}
          />
        )}
      </div>

      <div className="shrink-0 flex items-center justify-between border-t border-border/25 px-4 py-3">
        <div className="flex items-center gap-3 text-sm">
          {isDirty ? (
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-500">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500"></span>
              </span>
              Unsaved changes
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            className="h-8 gap-2 px-6 text-[12px] shadow-md transition-transform active:scale-95"
            onClick={() => handleSave()}
            disabled={isSaving || isLoading || !isDirty || Boolean(conflict) || workspaceIssues.length > 0 || collectionIssues.length > 0}
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? "Saving..." : savedFeedback ? "Saved!" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
