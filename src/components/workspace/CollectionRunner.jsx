import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, CheckCircle2, Copy, Download, FileText, ListChecks, Play, RotateCcw, Square, Table2, TimerReset, Trash2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { buildRequestPayload } from "@/lib/http-ui.js";
import { formatSavedAt } from "@/lib/workspace-store.js";
import { cancelHttpRequest, sendHttpRequest, getCollectionConfig, exchangeOAuthToken } from "@/lib/http-client.js";
import { executeWorkflowStep, inheritRunRequest, interruptibleDelay } from "@/lib/workflow-runner.js";
import { formatResponseBody, isJsonText } from "@/lib/formatters.js";
import { runRequestScript } from "@/lib/request-scripts.js";
import { applyRunnerDataRow, buildRunReport, getRunnableRequests, normalizeRunnerDelayMs, normalizeRunnerFolderPath, parseRunnerDataRows } from "@/lib/collection-runner.js";
import { cn } from "@/lib/utils.js";

const RUNNER_ROW_RENDER_LIMIT = 800;

function buildRunnerResponse(result, request) {
  const rawBody = String(result?.body || "");
  const status = Number(result?.status || 0);
  const statusText = String(result?.statusText || "");
  return {
    status,
    badge: `${status} ${statusText}`,
    statusText: `${status} ${statusText}`,
    duration: `${Number(result?.durationMs || 0)} ms`,
    size: `${new TextEncoder().encode(rawBody).length} B`,
    headers: result?.headers || {},
    cookies: Array.isArray(result?.cookies) ? result.cookies : [],
    body: formatResponseBody(rawBody),
    rawBody,
    isJson: isJsonText(rawBody),
    meta: {
      url: request.url || "-",
      method: request.method || "GET",
    },
    savedAt: formatSavedAt(),
  };
}

function runStatusTone(status) {
  if (status === "passed") return "text-emerald-500";
  if (status === "failed") return "text-red-500";
  if (status === "running") return "text-primary";
  return "text-muted-foreground";
}

function getDataSourceMeta(source, rows) {
  const text = String(source || "").trim();
  if (!text) {
    return { label: "Empty", detail: "Optional data rows", tone: "text-muted-foreground", icon: FileText };
  }
  try {
    JSON.parse(text);
    return rows.length
      ? { label: "JSON", detail: `${rows.length} row${rows.length === 1 ? "" : "s"} ready`, tone: "text-emerald-500", icon: Braces }
      : { label: "JSON", detail: "Use an object or array of objects", tone: "text-amber-500", icon: Braces };
  } catch {
    return rows.length
      ? { label: "CSV", detail: `${rows.length} row${rows.length === 1 ? "" : "s"} ready`, tone: "text-emerald-500", icon: Table2 }
      : { label: "Invalid", detail: "Paste JSON array/object or CSV with headers", tone: "text-red-500", icon: XCircle };
  }
}

export function CollectionRunner({ workspace, collection }) {
  const [folderFilter, setFolderFilter] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [allowUnsafeRetries, setAllowUnsafeRetries] = useState(false);
  const [extractionRules, setExtractionRules] = useState([]);
  const [variableNames, setVariableNames] = useState([]);
  const [runError, setRunError] = useState("");
  const [delayMs, setDelayMs] = useState(0);
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [dataSource, setDataSource] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [runHistory, setRunHistory] = useState([]);
  const stopRequestedRef = useRef(false);
  const currentRequestIdRef = useRef("");
  useEffect(() => () => {
    stopRequestedRef.current = true;
    if (currentRequestIdRef.current) cancelHttpRequest(currentRequestIdRef.current).catch(() => {});
  }, []);
  const runHistoryKey = useMemo(() => `kivo.runnerHistory.${workspace?.name || "workspace"}.${collection?.name || "collection"}`, [workspace?.name, collection?.name]);

  const folders = useMemo(() => {
    const values = new Set();
    for (const request of collection?.requests || []) {
      const folder = normalizeRunnerFolderPath(request.folderPath);
      if (folder) values.add(folder);
    }
    return Array.from(values).sort();
  }, [collection?.requests]);

  const runnable = useMemo(
    () => getRunnableRequests(collection, folderFilter),
    [collection, folderFilter]
  );

  const dataRows = useMemo(() => parseRunnerDataRows(dataSource), [dataSource]);
  const dataMeta = useMemo(() => getDataSourceMeta(dataSource, dataRows), [dataRows, dataSource]);
  const DataMetaIcon = dataMeta.icon;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(runHistoryKey);
      const parsed = JSON.parse(raw || "[]");
      setRunHistory(Array.isArray(parsed) ? parsed.slice(0, 8) : []);
    } catch {
      setRunHistory([]);
    }
  }, [runHistoryKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(runHistoryKey, JSON.stringify(runHistory.slice(0, 8)));
    } catch {
    }
  }, [runHistory, runHistoryKey]);

  const runItems = useMemo(() => {
    const rows = dataRows.length ? dataRows : [{ id: "default", values: null }];
    return rows.flatMap((row, rowIndex) => runnable.map(({ request, index }) => ({
      request: applyRunnerDataRow(request, row),
      index,
      id: `${row.id}-${index}-${request.name}`,
      dataRowName: dataRows.length ? `Row ${rowIndex + 1}` : "",
      contextKey: row.id,
      dataValues: row.values,
    })));
  }, [dataRows, runnable]);

  const summary = useMemo(() => {
    const done = results.filter((item) => item.status === "passed" || item.status === "failed");
    const passed = done.filter((item) => item.status === "passed").length;
    const failed = done.filter((item) => item.status === "failed").length;
    const tests = results.flatMap((item) => item.tests || []);
    return { total: runItems.length, done: done.length, passed, failed, tests: tests.length };
  }, [results, runItems.length]);
  const previewRows = useMemo(() => {
    const rows = results.length ? results : runItems.map(({ request, index, id, dataRowName }) => ({
      id,
      name: request.name,
      method: request.method,
      url: request.url,
      dataRowName,
      status: "queued",
      duration: "-",
      tests: [],
      error: "",
    }));
    return rows.length > RUNNER_ROW_RENDER_LIMIT ? rows.slice(0, RUNNER_ROW_RENDER_LIMIT) : rows;
  }, [results, runItems]);
  const hiddenPreviewRows = Math.max(0, (results.length || runItems.length) - previewRows.length);

  function patchResult(id, patch) {
    setResults((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function runOne({ request, id, dataValues, dataRowName }, context, config) {
    patchResult(id, { status: "running", error: "", attempts: 0 });
    const outcome = await executeWorkflowStep({
      request: inheritRunRequest(request, collection, config), context, data: dataValues || {},
      rules: extractionRules.filter((rule) => rule.request === request.name && rule.variable.trim()),
      retries: retryCount, allowUnsafeRetries, stopped: () => stopRequestedRef.current,
      script: runRequestScript,
      prepare: async (draft) => {
        const oauth = draft.auth?.type === "oauth2" && draft.auth.oauth2;
        if (oauth?.refreshToken && oauth.expiresAt && Date.parse(oauth.expiresAt) <= Date.now() + 30000) {
          const refreshed = await exchangeOAuthToken({ workspaceName: workspace?.name || "", collectionName: collection?.name || "", oauth: { ...oauth, grantType: "refresh_token" } });
          return { ...draft, auth: { ...draft.auth, oauth2: { ...oauth, ...refreshed } } };
        }
        return draft;
      },
      send: async (draft) => {
        const requestId = `runner-${crypto.randomUUID()}`;
        currentRequestIdRef.current = requestId;
        try {
          return buildRunnerResponse(await sendHttpRequest({ ...buildRequestPayload(draft, workspace?.name || "", collection?.name || ""), requestId }), draft);
        } finally { if (currentRequestIdRef.current === requestId) currentRequestIdRef.current = ""; }
      },
    });
    patchResult(id, { ...outcome, dataRowName, dataValues });
    setVariableNames(Object.keys(context.vars).sort());
    return outcome.status === "passed";
  }

  async function runCollection() {
    if (isRunning || runItems.length === 0) return;
    stopRequestedRef.current = false;
    setVariableNames([]);
    setRunError("");
    setIsRunning(true);
    const queued = runItems.map(({ request, index, id, dataRowName, dataValues }) => ({
      id,
      name: request.name,
      method: request.method,
      url: request.url,
      folderPath: request.folderPath || "",
      dataRowName,
      dataValues,
      status: "queued",
      attempts: 0,
      statusCode: 0,
      duration: "-",
      tests: [],
      error: "",
    }));
    setResults(queued);

    try {
      const config = await getCollectionConfig(workspace?.name || "", collection?.name || "");
      const contexts = new Map();
      for (let itemIndex = 0; itemIndex < runItems.length; itemIndex += 1) {
        const item = runItems[itemIndex];
        if (stopRequestedRef.current) {
          setResults((current) => current.map((result) => result.status === "queued" ? { ...result, status: "skipped" } : result));
          break;
        }
        if (!contexts.has(item.contextKey)) contexts.set(item.contextKey, { vars: {} });
        const passed = await runOne(item, contexts.get(item.contextKey), config || {});
        if (!passed && stopOnFailure) {
          setResults((current) => current.map((result) => result.status === "queued" ? { ...result, status: "skipped" } : result));
          break;
        }
        if (delayMs > 0 && itemIndex < runItems.length - 1 && !stopRequestedRef.current) {
          await interruptibleDelay(delayMs, () => stopRequestedRef.current);
        }
      }
    } catch (error) {
      setRunError(String(error));
      setResults((current) => current.map((result) => result.status === "queued" ? { ...result, status: "skipped" } : result));
    } finally {
      setIsRunning(false);
      setRunHistory((current) => [{
        id: `run-${Date.now()}`,
        ranAt: new Date().toISOString(),
                collectionName: collection?.name || "",
                folderFilter,
                dataRows: dataRows.length,
        delayMs,
      }, ...current].slice(0, 8));
    }
  }

  function stopRun() {
    stopRequestedRef.current = true;
    if (currentRequestIdRef.current) {
      cancelHttpRequest(currentRequestIdRef.current).catch(() => {});
    }
  }

  async function copyReport() {
    const report = buildRunReport({ collectionName: collection?.name, folderFilter, dataRows, summary, results });
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  }

  function downloadReport() {
    const report = buildRunReport({ collectionName: collection?.name, folderFilter, dataRows, summary, results });
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${collection?.name || "collection"}-run-report.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function insertJsonSample() {
    setDataSource('[\n  { "userId": "42", "postId": "12" },\n  { "userId": "43", "postId": "13" }\n]');
  }

  function insertCsvSample() {
    setDataSource("userId,postId\n42,12\n43,13");
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
      <Card className="kivo-soft-panel overflow-hidden">
        <div className="kivo-quiet-divider border-b bg-background/12 px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-foreground">
              <ListChecks className="h-4 w-4 text-primary" />
              <h3 className="text-[15px] font-semibold tracking-tight">Collection Runner</h3>
            </div>
            <div className="mt-1 text-[12px] text-muted-foreground">
              Runs HTTP and GraphQL requests in collection order with script assertions.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={folderFilter}
              onChange={(event) => setFolderFilter(event.target.value)}
              className="kivo-field h-9 px-3 text-[12px] text-foreground outline-none transition-colors hover:border-primary/35"
            >
              <option value="">All folders</option>
              {folders.map((folder) => (
                <option key={folder} value={folder}>{folder}</option>
              ))}
            </select>
            <Input
              type="text"
              inputMode="numeric"
              value={String(retryCount)}
              aria-label="Retries"
              disabled={isRunning}
              onChange={(event) => setRetryCount(Math.min(10, Math.max(0, Number.parseInt(event.target.value.replace(/\D/g, ""), 10) || 0)))}
              className="kivo-field h-9 w-24 text-[12px]"
              placeholder="Retries"
            />
            <Input
              type="text"
              inputMode="numeric"
              value={String(delayMs)}
              onChange={(event) => setDelayMs(normalizeRunnerDelayMs(event.target.value))}
              className="kivo-field h-9 w-28 text-[12px]"
              placeholder="Delay ms"
              title="Delay between runner requests in milliseconds"
            />
            <label className="kivo-field flex h-9 items-center gap-2 px-3 text-[12px] text-foreground transition-colors hover:border-primary/35">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={stopOnFailure}
                onChange={(event) => setStopOnFailure(event.target.checked)}
              />
              Stop on fail
            </label>
            {isRunning ? (
              <Button type="button" variant="outline" className="h-9 gap-2" onClick={stopRun}>
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : null}
            <Button type="button" className="h-9 gap-2" onClick={runCollection} disabled={isRunning || runItems.length === 0}>
              {isRunning ? <RotateCcw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {isRunning ? "Running" : "Run"}
            </Button>
          </div>
        </div>
        </div>
        <div className="space-y-3 border-b border-border/30 px-4 py-3">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={allowUnsafeRetries} disabled={isRunning} onChange={(event) => setAllowUnsafeRetries(event.target.checked)} className="accent-primary" />Retry non-idempotent requests (may repeat side effects)</label>
          <details>
            <summary className="cursor-pointer text-xs font-medium">Response extraction ({extractionRules.length})</summary>
            <div className="mt-3 space-y-2">
              {extractionRules.map((rule, index) => <div key={rule.id} className="flex flex-wrap gap-2">
                <select aria-label="Extraction request" disabled={isRunning} value={rule.request} className="kivo-field h-8 min-w-0 flex-1 text-xs" onChange={(event) => setExtractionRules((rules) => rules.map((entry, i) => i === index ? { ...entry, request: event.target.value } : entry))}>
                  {runnable.map(({ request }) => <option key={request.name} value={request.name}>{request.name}</option>)}
                </select>
                <Input aria-label="Variable name" placeholder="Variable name" disabled={isRunning} value={rule.variable} onChange={(event) => setExtractionRules((rules) => rules.map((entry, i) => i === index ? { ...entry, variable: event.target.value } : entry))} className="h-8 min-w-0 flex-1 text-xs" />
                <Input aria-label="Response JSON pointer" placeholder="/data/id" disabled={isRunning} value={rule.pointer} onChange={(event) => setExtractionRules((rules) => rules.map((entry, i) => i === index ? { ...entry, pointer: event.target.value } : entry))} className="h-8 min-w-0 flex-1 text-xs" />
                <Button variant="ghost" size="icon" title="Remove extraction" disabled={isRunning} onClick={() => setExtractionRules((rules) => rules.filter((entry) => entry.id !== rule.id))}><Trash2 className="h-3 w-3" /></Button>
              </div>)}
              <Button variant="ghost" size="sm" disabled={isRunning || !runnable.length} onClick={() => setExtractionRules((rules) => [...rules, { id: crypto.randomUUID(), request: runnable[0].request.name, variable: "", pointer: "" }])}>Add extraction</Button>
            </div>
          </details>
          {variableNames.length > 0 && <p className="break-all text-xs text-muted-foreground">Run variables: {variableNames.join(", ")}</p>}
          {runError && <p role="alert" className="text-xs text-destructive">{runError}</p>}
        </div>
        <div className="kivo-quiet-divider grid grid-cols-2 border-b bg-background/8 text-[11px] sm:grid-cols-5">
          <div className="kivo-quiet-divider border-r px-4 py-2.5 text-muted-foreground">Total <span className="ml-1 font-semibold text-foreground">{summary.total}</span></div>
          <div className="kivo-quiet-divider border-r px-4 py-2.5 text-muted-foreground">Done <span className="ml-1 font-semibold text-foreground">{summary.done}</span></div>
          <div className="kivo-quiet-divider border-r px-4 py-2.5 text-muted-foreground">Passed <span className="ml-1 font-semibold text-emerald-500">{summary.passed}</span></div>
          <div className="kivo-quiet-divider border-r px-4 py-2.5 text-muted-foreground">Failed <span className="ml-1 font-semibold text-red-500">{summary.failed}</span></div>
          <div className="px-4 py-2.5 text-muted-foreground">Tests <span className="ml-1 font-semibold text-foreground">{summary.tests}</span></div>
        </div>
        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="kivo-field min-h-[132px] overflow-hidden">
            <div className="kivo-quiet-divider flex flex-wrap items-center justify-between gap-2 border-b bg-background/18 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <DataMetaIcon className={cn("h-3.5 w-3.5 shrink-0", dataMeta.tone)} />
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Data Input</div>
                  <div className={cn("truncate text-[10px]", dataMeta.tone)}>{dataMeta.label} · {dataMeta.detail}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={insertJsonSample}>
                  <Braces className="h-3 w-3" />
                  JSON
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={insertCsvSample}>
                  <Table2 className="h-3 w-3" />
                  CSV
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDataSource("")} disabled={!dataSource}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <textarea
              value={dataSource}
              onChange={(event) => setDataSource(event.target.value)}
              spellCheck={false}
              placeholder={'Paste JSON array/object or CSV with headers. Use {{userId}} etc in requests.'}
              className="thin-scrollbar min-h-[94px] w-full resize-none border-0 bg-transparent px-3 py-2.5 font-mono text-[11px] leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <div className="kivo-field grid content-start gap-2 p-3">
            <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <DataMetaIcon className={cn("h-3.5 w-3.5", dataMeta.tone)} />
              {dataRows.length ? `${dataRows.length} data row(s) loaded` : "No data rows loaded"}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="h-8 flex-1 gap-1.5 text-[11px]" onClick={copyReport} disabled={!results.length}>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              <Button type="button" variant="outline" className="h-8 flex-1 gap-1.5 text-[11px]" onClick={downloadReport} disabled={!results.length}>
                <Download className="h-3.5 w-3.5" />
                Report
              </Button>
            </div>
            <div className="kivo-quiet-divider flex min-w-0 items-start gap-2 border-t pt-2 text-[10px] text-muted-foreground">
              <TimerReset className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
              <span className="min-w-0 truncate">Recent: {runHistory.length ? runHistory.map((run) => new Date(run.ranAt).toLocaleTimeString()).join(", ") : "none"}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card className="kivo-soft-panel min-h-0 overflow-hidden">
        <div className="kivo-quiet-divider grid grid-cols-[52px_92px_minmax(0,1.4fr)_86px_92px_92px_minmax(0,1fr)] border-b bg-background/12 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <div>#</div>
          <div>Method</div>
          <div>Request</div>
          <div>Data</div>
          <div>Status</div>
          <div>Time</div>
          <div>Assertions</div>
        </div>
        <div className="thin-scrollbar h-full min-h-0 overflow-auto">
          {previewRows.map((item, index) => (
            <div key={item.id} className="kivo-row-hover kivo-quiet-divider grid grid-cols-[52px_92px_minmax(0,1.4fr)_86px_92px_92px_minmax(0,1fr)] items-center border-b px-3 py-2 text-[12px]">
              <div className="text-muted-foreground">{index + 1}</div>
              <div className="font-semibold text-foreground">{item.method || "GET"}</div>
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{item.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{item.url || "-"}</div>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">{item.dataRowName || "-"}</div>
              <div className={cn("flex items-center gap-1.5 font-medium", runStatusTone(item.status))}>
                {item.status === "passed" ? <CheckCircle2 className="h-3.5 w-3.5" /> : item.status === "failed" ? <XCircle className="h-3.5 w-3.5" /> : null}
                {item.statusCode || item.status}
              </div>
              <div className="text-muted-foreground">{item.duration || "-"}</div>
              <div className="min-w-0">
                <div className="truncate text-muted-foreground">
                  {item.tests?.length ? `${item.tests.filter((test) => test.ok).length}/${item.tests.length} passed` : "No tests"}
                </div>
                {item.error ? <div className="truncate text-[11px] text-red-500">{item.error}</div> : null}
              </div>
            </div>
          ))}
          {hiddenPreviewRows ? (
            <div className="px-3 py-3 text-[11px] text-muted-foreground">
              Showing {previewRows.length} rows. Reports still include all {results.length || runItems.length} runner items.
            </div>
          ) : null}
          {runItems.length === 0 ? (
            <div className="p-8 text-center text-[12px] text-muted-foreground">
              No HTTP or GraphQL requests found for this scope.
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
