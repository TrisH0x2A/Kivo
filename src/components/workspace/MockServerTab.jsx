import { useEffect, useMemo, useState } from "react";
import { CircleStop, Copy, Play, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { SelectMenu } from "@/components/workspace/SelectMenu.jsx";
import { mockServerStatus, startMockServer, stopMockServer } from "@/lib/http-client.js";

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

function newRoute() {
  return { id: `mock-${crypto.randomUUID()}`, method: "GET", path: "/health", scenario: "", status: 200, headers: [], body: '{\n  "ok": true\n}', delayMs: 0, enabled: true };
}

function headersText(rows) {
  return (rows || []).map((row) => `${row.key}: ${row.value}`).join("\n");
}

function parseHeaders(value) {
  return String(value || "").split(/\r?\n/).map((line) => {
    const [key, ...rest] = line.split(":");
    return { key: key.trim(), value: rest.join(":").trim(), enabled: true };
  }).filter((row) => row.key);
}

export function MockServerTab({ config, updateConfig, isDirty, onSave }) {
  const mockServer = config.mockServer || { port: 0, routes: [] };
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const routes = Array.isArray(mockServer.routes) ? mockServer.routes : [];
  const scenarios = useMemo(() => Array.from(new Set(routes.map((route) => String(route.scenario || "").trim()).filter(Boolean))), [routes]);

  useEffect(() => { mockServerStatus().then(setInfo).catch(() => {}); }, []);

  function updateMockServer(patch) { updateConfig({ mockServer: { ...mockServer, ...patch } }); }
  function updateRoute(index, patch) { updateMockServer({ routes: routes.map((route, routeIndex) => routeIndex === index ? { ...route, ...patch } : route) }); }
  async function start() {
    setBusy(true); setError("");
    try { const next = await startMockServer(mockServer); setInfo(next); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError("");
    try { setInfo(await stopMockServer()); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function copyUrl() { if (info?.url) await navigator.clipboard?.writeText(info.url); }

  return <div className="flex min-h-0 flex-1 flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-lg font-semibold tracking-tight">Local mock server</h3><p className="mt-1 max-w-2xl text-[12px] text-muted-foreground">Replay realistic API states locally with deterministic routes, scenarios, delays, and error responses.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onSave} disabled={!isDirty}><RefreshCw className="h-3.5 w-3.5" />Save routes</Button>
        {info?.running ? <Button type="button" variant="outline" size="sm" onClick={stop} disabled={busy}><CircleStop className="h-3.5 w-3.5" />Stop</Button> : <Button type="button" size="sm" onClick={start} disabled={busy || routes.length === 0}><Play className="h-3.5 w-3.5" />Start server</Button>}
      </div>
    </div>
    <Card className="kivo-soft-panel flex flex-wrap items-center gap-3 p-3 text-xs">
      <Server className={info?.running ? "h-4 w-4 text-emerald-400" : "h-4 w-4 text-muted-foreground"} />
      <span className="font-medium">{info?.running ? "Running" : "Stopped"}</span>
      <Input aria-label="Mock server port" type="number" min="0" max="65535" value={mockServer.port || 0} onChange={(event) => updateMockServer({ port: Math.max(0, Math.min(65535, Number(event.target.value) || 0)) })} className="h-8 w-28" title="Use 0 for an available port" />
      {info?.url && <><code className="min-w-0 flex-1 truncate text-muted-foreground" title={info.url}>{info.url}</code><Button type="button" size="icon" variant="ghost" aria-label="Copy mock server URL" title="Copy URL" onClick={copyUrl}><Copy className="h-3.5 w-3.5" /></Button></>}
      <span className="text-muted-foreground">{routes.length} routes{scenarios.length ? ` · ${scenarios.length} scenarios` : ""}</span>
    </Card>
    {error && <div role="alert" className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
    <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
      <div className="grid gap-2">
        {routes.map((route, index) => <Card key={route.id || index} className="kivo-soft-panel p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input type="checkbox" checked={route.enabled !== false} aria-label={`Enable mock route ${index + 1}`} onChange={(event) => updateRoute(index, { enabled: event.target.checked })} className="h-3.5 w-3.5" />
            <SelectMenu ariaLabel={`Mock method ${index + 1}`} value={route.method} options={methods.map((method) => ({ value: method, label: method }))} onChange={(method) => updateRoute(index, { method })} className="w-28" />
            <Input aria-label={`Mock path ${index + 1}`} value={route.path} onChange={(event) => updateRoute(index, { path: event.target.value })} placeholder="/users/{id}" className="h-8 min-w-[180px] flex-1 font-mono text-xs" />
            <Input aria-label={`Mock scenario ${index + 1}`} value={route.scenario || ""} onChange={(event) => updateRoute(index, { scenario: event.target.value })} placeholder="Scenario (optional)" className="h-8 w-40 text-xs" />
            <Input aria-label={`Mock status ${index + 1}`} type="number" min="100" max="599" value={route.status} onChange={(event) => updateRoute(index, { status: Math.max(100, Math.min(599, Number(event.target.value) || 200)) })} className="h-8 w-20 text-xs" />
            <Input aria-label={`Mock delay ${index + 1}`} type="number" min="0" max="60000" value={route.delayMs || 0} onChange={(event) => updateRoute(index, { delayMs: Math.max(0, Math.min(60000, Number(event.target.value) || 0)) })} className="h-8 w-24 text-xs" title="Delay in milliseconds" />
            <Button type="button" size="icon" variant="ghost" aria-label={`Duplicate mock route ${index + 1}`} title="Duplicate route" onClick={() => updateMockServer({ routes: [...routes.slice(0, index + 1), { ...route, id: `mock-${crypto.randomUUID()}` }, ...routes.slice(index + 1)] })}><Copy className="h-3.5 w-3.5" /></Button>
            <Button type="button" size="icon" variant="ghost" aria-label={`Delete mock route ${index + 1}`} title="Delete route" onClick={() => updateMockServer({ routes: routes.filter((_, routeIndex) => routeIndex !== index) })}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></Button>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <textarea aria-label={`Mock response body ${index + 1}`} value={route.body || ""} onChange={(event) => updateRoute(index, { body: event.target.value })} placeholder="Response body" className="kivo-field thin-scrollbar min-h-24 resize-y p-2 font-mono text-xs outline-none" />
            <textarea aria-label={`Mock response headers ${index + 1}`} value={headersText(route.headers)} onChange={(event) => updateRoute(index, { headers: parseHeaders(event.target.value) })} placeholder="Response headers\nX-Mock: true" className="kivo-field thin-scrollbar min-h-24 resize-y p-2 font-mono text-xs outline-none" />
          </div>
        </Card>)}
        {routes.length === 0 && <div className="flex min-h-40 items-center justify-center border border-dashed border-border/40 text-xs text-muted-foreground">Add a route to start a local mock.</div>}
      </div>
    </div>
    <Button type="button" variant="outline" className="self-start" onClick={() => updateMockServer({ routes: [...routes, newRoute()] })}><Plus className="h-3.5 w-3.5" />Add route</Button>
  </div>;
}
