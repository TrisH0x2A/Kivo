import { useEffect, useState } from "react";
import {
  BookOpen, Code2, Copy, Download, FileJson, FlaskConical, FolderOpen, Globe, Layers,
  Save, Share2, Trash2, Eye, EyeOff
} from "lucide-react";

import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { EnvHighlightInput } from "@/components/ui/EnvHighlightInput.jsx";
import { EnvEditor } from "@/components/workspace/EnvEditor.jsx";
import { WorkspaceEnvironmentSelector } from "@/components/workspace/WorkspaceEnvironmentSelector.jsx";
import { OAuth2Panel } from "@/components/workspace/OAuth2Panel.jsx";
import { CollectionRunner } from "@/components/workspace/CollectionRunner.jsx";
import { useCollectionConfig } from "@/hooks/use-collection-config.js";
import { useEnv } from "@/hooks/use-env.js";
import { useWorkspaceEnvironments } from "@/hooks/use-workspace-environments.js";
import { cn } from "@/lib/utils.js";

const TABS = [
  { id: "Overview", label: "Overview", description: "Path, requests, and collection health", icon: Layers },
  { id: "Headers", label: "Headers", description: "Shared request headers", icon: Code2 },
  { id: "Environments", label: "Environments", description: "Variables and active state", icon: Globe },
  { id: "Auth", label: "Auth", description: "Inherited authentication", icon: Share2 },
  { id: "Docs", label: "Docs", description: "Generated Markdown docs", icon: BookOpen },
  { id: "Runner", label: "Runner", description: "Run the full collection", icon: FlaskConical },
];

function createHeaderRow() {
  return { id: `hdr-${Math.random().toString(36).slice(2, 8)}`, key: "", value: "", enabled: true };
}

function HeadersTable({ rows, onChange, onDelete }) {
  function update(id, field, value) {
    onChange(rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function addRow() {
    onChange([...rows, createHeaderRow()]);
  }

  function removeRow(id) {
    const nextRows = rows.filter((row) => row.id !== id);
    onChange(nextRows);
    onDelete?.(nextRows);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/30">
      <div className="grid grid-cols-[32px_minmax(0,1fr)_minmax(0,1fr)_40px] items-center gap-2 border-b border-border/20 bg-background/25 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        <span>On</span>
        <span>Header</span>
        <span>Value</span>
        <span></span>
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-auto bg-background/10 px-1">
        {rows.length > 0 ? (
          <div className="grid">
            {rows.map((row) => (
              <div key={row.id} className="grid grid-cols-[32px_minmax(0,1fr)_minmax(0,1fr)_40px] items-center border-b border-border/10 px-1">
                <label className="flex h-9 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={row.enabled !== false}
                    onChange={(event) => update(row.id, "enabled", event.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                </label>
                <Input
                  value={row.key ?? ""}
                  onChange={(event) => update(row.id, "key", event.target.value)}
                  placeholder="Header name"
                  className="h-10 border-0 bg-transparent text-[12px] focus-visible:ring-0 lg:text-[14px]"
                />
                <Input
                  value={row.value ?? ""}
                  onChange={(event) => update(row.id, "value", event.target.value)}
                  placeholder="Header value"
                  className="h-10 border-0 bg-transparent text-[12px] focus-visible:ring-0 lg:text-[14px]"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(row.id)}
                  className="h-9 w-9 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full min-h-[220px] items-center justify-center text-[12px] text-muted-foreground/60">
            No default headers yet.
          </div>
        )}
      </div>

      <div className="border-t border-border/20 bg-background/25 px-3 py-2">
        <Button type="button" variant="outline" className="h-8 text-[12px]" onClick={addRow}>
          Add Header
        </Button>
      </div>
    </div>
  );
}

function OverviewTab({ workspace, collection, storagePath, envVars, onNavigate }) {

  const isWindowsPath = /^[A-Za-z]:[/\\]/.test(storagePath ?? "");
  const sep = isWindowsPath ? "\\" : "/";
  const collectionPath =
    storagePath && workspace && collection
      ? [storagePath, workspace.name, "collections", collection.name].join(sep)
      : "Loading...";

  const globalCount = envVars?.workspace?.length ?? 0;
  const collectionCount = envVars?.collection?.length ?? 0;
  const requestCount = collection?.requests?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight text-foreground">Collection Overview</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">Manage everything shared across requests in {collection?.name}.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <Card className="kivo-soft-panel flex min-h-[134px] flex-col p-4 transition-colors xl:col-span-2">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center border border-primary/15 bg-primary/10 text-primary">
              <FolderOpen className="h-4 w-4" />
            </div>
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Storage Path</h3>
          </div>
          <div className="mt-auto flex cursor-pointer items-center justify-between border border-border/20 bg-background/30 px-3 py-2.5 transition-colors hover:border-primary/30 hover:bg-primary/10" onClick={() => invoke("reveal_item", { workspaceName: workspace?.name, collectionName: collection?.name }).catch(console.error)}>
            <p className="font-mono text-[11px] text-muted-foreground truncate w-full group-hover:text-foreground transition-colors" title={collectionPath}>
              {collectionPath}
            </p>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/60 ml-2 whitespace-nowrap">Open</div>
          </div>
        </Card>

        <Card className="kivo-soft-panel flex min-h-[134px] flex-col justify-between p-4 transition-colors">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center border border-primary/15 bg-primary/10 text-primary">
                <Layers className="h-4 w-4" />
              </div>
              <h3 className="text-[12px] font-semibold text-foreground">Requests</h3>
            </div>
          </div>
          <div className="text-3xl font-semibold tracking-tight text-foreground">{requestCount}</div>
          <p className="text-[11px] text-muted-foreground">Saved in this collection</p>
        </Card>

        <Card className="kivo-soft-panel flex min-h-[134px] flex-col justify-between p-4 transition-colors">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center border border-primary/15 bg-primary/10 text-primary">
              <Globe className="h-4 w-4" />
            </div>
            <h3 className="text-[12px] font-semibold text-foreground">Variables</h3>
          </div>
          <div className="flex items-end gap-3">
            <span className="text-3xl font-semibold tracking-tight text-foreground">{globalCount + collectionCount}</span>
            <span className="pb-1 text-[11px] text-muted-foreground">{globalCount} workspace / {collectionCount} collection</span>
          </div>
        </Card>
      </div>

    </div>
  );
}

function HeadersTab({ config, updateConfig, onSave, onReset, isDirty, isSaving }) {
  const rows = (config.defaultHeaders ?? []).map((h, i) => ({
    ...h,
    id: h.id ?? `hdr-${i}`,
  }));

  return (
    <div className="flex min-h-[560px] flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground tracking-tight">Default Headers</h3>
        <p className="text-[13px] text-muted-foreground mt-1">
          Automatically attached to every request in this collection. Per-request headers will override these.
        </p>
      </div>
      <Card className="kivo-panel flex min-h-0 flex-1 flex-col overflow-hidden p-1">
        <HeadersTable
          rows={rows}
          onChange={(nextRows) => updateConfig({ defaultHeaders: nextRows })}
          onDelete={(nextRows) => onSave({ defaultHeaders: nextRows })}
        />
      </Card>
      <div className="flex shrink-0 items-center justify-between border-t border-border/10 pt-4">
        <div className="flex items-center gap-3 text-sm">
          {isDirty && (
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-500">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              Unsaved changes
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button className="h-9 px-6 text-[13px] gap-2 shadow-md transition-transform active:scale-95" onClick={() => onSave()} disabled={isSaving || !isDirty}>
            <Save className="h-4 w-4" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const AUTH_MODES = [
  { value: "none", label: "No Auth" },
  { value: "basic", label: "Basic Auth" },
  { value: "bearer", label: "Bearer Token" },
  { value: "jwt", label: "JWT" },
  { value: "digest", label: "Digest" },
  { value: "custom", label: "Custom" },
  { value: "apikey", label: "API Key" },
  { value: "oauth2", label: "OAuth 2.0" },
];

const API_KEY_IN_OPTIONS = [
  { value: "header", label: "Header" },
  { value: "query", label: "Query Param" },
];

function AuthTab({ workspace, collection, config, updateConfig, onSave, onReset, isDirty, isSaving, envVars }) {
  const auth = config.defaultAuth ?? { type: "none", token: "" };
  const [showToken, setShowToken] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="flex min-h-[560px] flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground tracking-tight">Collection Auth</h3>
        <p className="text-[13px] text-muted-foreground mt-1">
          Requests set to <em>"Inherit"</em> will use this authentication.
        </p>
      </div>

      <Card className={cn("kivo-soft-panel flex min-h-0 flex-col gap-5 p-4", auth.type === "oauth2" ? "flex-1 overflow-hidden p-0" : "")}>
        <div className={cn("grid gap-3 text-left w-full", auth.type === "oauth2" && "border-b border-border/20 px-5 py-4") }>
          <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Authentication Type</label>
          <div className="mt-1 grid w-full grid-cols-2 gap-1 border border-border/20 bg-background/30 p-1 sm:grid-cols-4 xl:inline-grid xl:w-fit xl:grid-cols-8">
            {AUTH_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => updateConfig({ defaultAuth: { ...auth, type: m.value } })}
                className={cn(
                  "border border-transparent px-3 py-1.5 text-[12px] font-medium transition-all",
                  auth.type === m.value
                    ? "border-primary/30 bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {auth.type === "bearer" && (
          <div className="grid gap-2 text-left w-full" style={{ animation: "fadeIn 0.2s ease-out" }}>
            <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Access Token</label>
            <div className="relative">
              <EnvHighlightInput
                value={auth.token ?? ""}
                onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, token: val } })}
                placeholder="eyJhbG..."
                type={showToken ? "text" : "password"}
                inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20 pr-10"
                envVars={envVars}
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Supports {'{{variables}}'} resolution at runtime.</p>
          </div>
        )}

        {auth.type === "jwt" && (
          <div className="grid gap-2 text-left w-full" style={{ animation: "fadeIn 0.2s ease-out" }}>
            <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">JWT Token</label>
            <EnvHighlightInput
              value={auth.jwtToken ?? auth.token ?? ""}
              onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, jwtToken: val } })}
              placeholder="Paste signed JWT"
              inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20"
              envVars={envVars}
            />
            <p className="text-[11px] text-muted-foreground mt-1">Sends <code className="text-[10px] bg-primary/10 text-primary px-1 py-0.5">Authorization: Bearer &lt;jwt&gt;</code>. Supports {'{{variables}}'}.</p>
          </div>
        )}

        {auth.type === "basic" && (
          <div className="grid gap-4 text-left w-full" style={{ animation: "fadeIn 0.2s ease-out" }}>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Username</label>
              <EnvHighlightInput
                value={auth.username ?? ""}
                onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, username: val } })}
                placeholder="Enter username"
                inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20"
                envVars={envVars}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Password</label>
              <div className="relative">
                <EnvHighlightInput
                  value={auth.password ?? ""}
                  onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, password: val } })}
                  placeholder="Enter password"
                  type={showPassword ? "text" : "password"}
                  inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20 pr-10"
                  envVars={envVars}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Generates <code className="text-[10px] bg-primary/10 text-primary px-1 py-0.5">Authorization: Basic base64(user:pass)</code>. Supports {'{{variables}}'}.
            </p>
          </div>
        )}

        {auth.type === "digest" && (
          <div className="grid gap-4 text-left w-full" style={{ animation: "fadeIn 0.2s ease-out" }}>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Username</label>
                <EnvHighlightInput value={auth.username ?? ""} onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, username: val } })} placeholder="Digest username" envVars={envVars} />
              </div>
              <div className="grid gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Password</label>
                <EnvHighlightInput value={auth.password ?? ""} onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, password: val } })} placeholder="Digest password" type={showPassword ? "text" : "password"} envVars={envVars} />
              </div>
              <div className="grid gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Realm</label>
                <EnvHighlightInput value={auth.digestRealm ?? ""} onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, digestRealm: val } })} placeholder="Server realm" envVars={envVars} />
              </div>
              <div className="grid gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Nonce</label>
                <EnvHighlightInput value={auth.digestNonce ?? ""} onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, digestNonce: val } })} placeholder="Server nonce" envVars={envVars} />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Generates a SHA-256 preemptive Digest header when realm and nonce are known.</p>
          </div>
        )}

        {auth.type === "custom" && (
          <div className="grid gap-4 text-left w-full" style={{ animation: "fadeIn 0.2s ease-out" }}>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Scheme</label>
              <EnvHighlightInput
                value={auth.customScheme ?? ""}
                onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, customScheme: val } })}
                placeholder="e.g. Token, SharedKey, ApiToken"
                inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20"
                envVars={envVars}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Credential</label>
              <EnvHighlightInput
                value={auth.customValue ?? ""}
                onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, customValue: val } })}
                placeholder="Credential value"
                inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20"
                envVars={envVars}
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Sends a custom Authorization header. Leave scheme empty to send the credential as-is.</p>
          </div>
        )}

        {auth.type === "apikey" && (
          <div className="grid gap-4 text-left w-full" style={{ animation: "fadeIn 0.2s ease-out" }}>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Key Name</label>
              <EnvHighlightInput
                value={auth.apiKeyName ?? ""}
                onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, apiKeyName: val } })}
                placeholder="e.g. X-API-Key"
                inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20"
                envVars={envVars}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Key Value</label>
              <EnvHighlightInput
                value={auth.apiKeyValue ?? ""}
                onValueChange={(val) => updateConfig({ defaultAuth: { ...auth, apiKeyValue: val } })}
                placeholder="Enter API key value"
                inputClassName="h-10 border-border/40 bg-background/35 font-mono text-[12px] focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20"
                envVars={envVars}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Add To</label>
              <div className="mt-1 inline-flex w-fit flex-wrap items-center gap-1 border border-border/20 bg-background/30 p-1">
                {API_KEY_IN_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateConfig({ defaultAuth: { ...auth, apiKeyIn: opt.value } })}
                    className={cn(
                      "border border-transparent px-4 py-1.5 text-[12px] font-medium transition-all",
                      (auth.apiKeyIn ?? "header") === opt.value
                        ? "border-primary/30 bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {(auth.apiKeyIn ?? "header") === "query"
                ? "Key-value pair will be appended to the URL query string."
                : "Key-value pair will be sent as an HTTP header."}
              {" "}Supports {'{{variables}}'}.
            </p>
          </div>
        )}

        {auth.type === "oauth2" && (
          <div className="min-h-0 flex-1 px-1 pb-1">
            <OAuth2Panel
              auth={auth}
              envVars={envVars}
              workspaceName={workspace?.name}
              collectionName={collection?.name}
              scopeLabel="collection"
              onChange={(nextAuth) => updateConfig({ defaultAuth: nextAuth })}
              onPersist={async (nextAuth) => {
                const nextConfig = { ...config, defaultAuth: nextAuth };
                updateConfig(nextConfig);
                await onSave(nextConfig);
              }}
            />
          </div>
        )}

        {auth.type === "none" && (
          <p className="px-5 pb-5 text-[12px] text-muted-foreground/70">No authentication will be applied to inherited requests.</p>
        )}
      </Card>
      <div className="flex items-center justify-between border-t border-border/10 pt-6">
        <div className="flex items-center gap-3 text-sm">
          {isDirty && (
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-500">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              Unsaved changes
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button className="h-9 px-6 text-[13px] gap-2 shadow-md transition-transform active:scale-95" onClick={() => onSave()} disabled={isSaving || !isDirty}>
            <Save className="h-4 w-4" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function buildCollectionDocs(collection, config) {
  const requests = Array.isArray(collection?.requests) ? collection.requests : [];
  const lines = [
    `# ${collection?.name || "Collection"} API`,
    "",
    `Generated by Kivo on ${new Date().toISOString()}.`,
    "",
    "## Defaults",
    "",
    `- Auth: ${config?.defaultAuth?.type || "none"}`,
    `- Default headers: ${(config?.defaultHeaders || []).filter((row) => row?.enabled !== false && String(row?.key || "").trim()).length}`,
    "",
    "## Requests",
    "",
  ];

  for (const request of requests) {
    lines.push(`### ${request.name || "Untitled request"}`);
    lines.push("");
    lines.push(`- Method: ${request.method || "GET"}`);
    lines.push(`- URL: ${request.url || "-"}`);
    lines.push(`- Type: ${request.requestMode || "http"}`);
    lines.push(`- Auth: ${request.auth?.type || "inherit"}`);
    if (request.folderPath) lines.push(`- Folder: ${request.folderPath}`);
    if (request.docs) {
      lines.push("");
      lines.push(String(request.docs).trim());
    }
    const headers = (request.headers || []).filter((row) => row?.enabled !== false && String(row?.key || "").trim());
    if (headers.length) {
      lines.push("");
      lines.push("Headers:");
      for (const row of headers) {
        lines.push(`- ${row.key}: ${row.value || ""}`);
      }
    }
    if (request.body && request.bodyType !== "none") {
      lines.push("");
      lines.push("Body:");
      lines.push("```");
      lines.push(String(request.body).slice(0, 4000));
      lines.push("```");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function DocsTab({ collection, config }) {
  const [copied, setCopied] = useState(false);
  const markdown = buildCollectionDocs(collection, config);

  async function copyDocs() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  function downloadDocs() {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${collection?.name || "collection"}-api-docs.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
      <Card className="kivo-soft-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-foreground tracking-tight">API Documentation</h3>
            <p className="mt-1 text-[12px] text-muted-foreground">Generated Markdown from collection requests, docs, headers, body samples, and auth metadata.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="h-9 gap-2" onClick={copyDocs}>
              <Copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" className="h-9 gap-2" onClick={downloadDocs}>
              <Download className="h-4 w-4" />
              Export
            </Button>
          </div>
        </div>
      </Card>
      <textarea
        value={markdown}
        readOnly
        className="kivo-field thin-scrollbar h-full min-h-0 resize-none p-4 font-mono text-[12px] leading-6 text-foreground outline-none"
      />
    </div>
  );
}

export function CollectionSettingsPage({
  workspace,
  collection,
  storagePath,
  initialTab = "Overview",
  initialEnvTab = "workspace",
  onEnvSave,
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [isSaving, setIsSaving] = useState(false);
  const {
    workspaceEnvironments,
    isWorkspaceEnvironmentsLoading,
    createEnvironment,
    setActiveEnvironment,
    deleteEnvironment,
  } = useWorkspaceEnvironments(workspace?.name);
  const activeWorkspaceEnvironmentId = workspaceEnvironments?.activeEnvironmentId || "default";

  const { vars: envVars } = useEnv(workspace?.name, collection?.name, activeWorkspaceEnvironmentId);
  const { config, isDirty, updateConfig, save, reset } = useCollectionConfig(
    workspace?.name,
    collection?.name
  );

  async function handleSave(overrideConfig) {
    setIsSaving(true);
    try {
      if (overrideConfig) {
        await save({ ...config, ...overrideConfig });
      } else {
        await save();
      }
    } catch {

    } finally {
      setIsSaving(false);
    }
  }

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, workspace?.name, collection?.name]);

  function handleNavigate(tab, envTab) {
    setActiveTab(tab);
  }

  const activeTabMeta = TABS.find((tab) => tab.id === activeTab) ?? TABS[0];
  const ActiveTabIcon = activeTabMeta.icon;
  const activeHeaderCount = (config.defaultHeaders || []).filter((row) => row?.enabled !== false && String(row?.key || "").trim()).length;

  return (
    <div className="kivo-settings-layout h-full min-h-0 overflow-hidden bg-background">
      <aside className="kivo-settings-rail kivo-scrollbar-none flex min-h-0 flex-col overflow-y-auto overflow-x-hidden px-3 py-4">
        <div className="mb-4 flex items-center gap-3 px-2">
          <div className="flex h-9 w-9 items-center justify-center border border-primary/20 bg-primary/10 text-primary">
            <FileJson className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight text-foreground">{collection?.name ?? "Collection"}</div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/75">Collection settings</p>
          </div>
        </div>

        <div className="grid gap-1">
          {TABS.map((tab) => {
            const TabIcon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                data-active={selected}
                className="kivo-settings-nav-item group flex w-full items-center gap-3 px-2.5 py-2.5 text-left"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-border/15 bg-background/25 text-muted-foreground transition-colors group-hover:text-foreground group-data-[active=true]:border-primary/25 group-data-[active=true]:bg-primary/10 group-data-[active=true]:text-primary">
                  <TabIcon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[12px] font-medium text-foreground">{tab.label}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">{tab.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-auto grid gap-2 px-2 pt-4">
          <div className="kivo-settings-stat">
            <span>Requests</span>
            <strong>{collection?.requests?.length ?? 0}</strong>
          </div>
          <div className="kivo-settings-stat">
            <span>Headers</span>
            <strong>{activeHeaderCount}</strong>
          </div>
        </div>
      </aside>

      <section className="flex min-h-0 flex-col overflow-hidden">
        <div className="kivo-settings-header flex shrink-0 items-center justify-between gap-4 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center border border-primary/20 bg-primary/10 text-primary">
              <ActiveTabIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Collection Settings</div>
              <h2 className="truncate text-[20px] font-semibold tracking-tight text-foreground">{activeTabMeta.label}</h2>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{activeTabMeta.description}</p>
            </div>
          </div>
          <div className={cn("kivo-settings-pill", isDirty && "border-amber-400/30 bg-amber-400/10 text-amber-200")}>
            {isSaving ? "Saving..." : isDirty ? "Unsaved" : "Saved"}
          </div>
        </div>

        <div className="thin-scrollbar min-h-0 flex-1 overflow-auto bg-background px-6 py-5">
          <div className="flex h-full min-h-0 w-full max-w-6xl flex-col">
        {activeTab === "Overview" && (
          <OverviewTab
            workspace={workspace}
            collection={collection}
            storagePath={storagePath}
            envVars={envVars}
            onNavigate={handleNavigate}
          />
        )}

        {activeTab === "Headers" && (
          <HeadersTab
            config={config}
            updateConfig={updateConfig}
            isDirty={isDirty}
            isSaving={isSaving}
            onSave={handleSave}
            onReset={reset}
          />
        )}

        {activeTab === "Environments" && (
          <div className="flex min-h-[560px] w-full flex-col gap-4">
            <div>
              <h3 className="text-lg font-semibold text-foreground tracking-tight">Environments</h3>
              <p className="text-[13px] text-muted-foreground mt-1">
                Define reusable state values. Use <code className="text-[11px] bg-primary/10 text-primary px-1.5 py-0.5">{"{{KEY}}"}</code> in
                URLs, headers, and payloads to interpolate them dynamically. Collection keys take priority.
              </p>
            </div>
            <WorkspaceEnvironmentSelector
              environments={workspaceEnvironments?.environments || []}
              activeEnvironmentId={activeWorkspaceEnvironmentId}
              isLoading={isWorkspaceEnvironmentsLoading}
              onCreate={createEnvironment}
              onSetActive={setActiveEnvironment}
              onDelete={deleteEnvironment}
            />
            <Card className="kivo-panel mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
              <EnvEditor
                workspaceName={workspace?.name}
                collectionName={collection?.name}
                workspaceEnvironmentId={activeWorkspaceEnvironmentId}
                initialTab={initialEnvTab}
                onSave={onEnvSave}
              />
            </Card>
          </div>
        )}

        {activeTab === "Auth" && (
          <AuthTab
            workspace={workspace}
            collection={collection}
            config={config}
            updateConfig={updateConfig}
            isDirty={isDirty}
            isSaving={isSaving}
            onSave={handleSave}
            onReset={reset}
            envVars={envVars}
          />
        )}

        {activeTab === "Docs" && (
          <DocsTab collection={collection} config={config} />
        )}

        {activeTab === "Runner" && (
          <CollectionRunner workspace={workspace} collection={collection} />
        )}
          </div>
        </div>
      </section>
      </div>
  );
}


