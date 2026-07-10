import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, CheckCircle2, Copy, Download, FileText, ListChecks, Play, RotateCcw, Square, Table2, TimerReset, Trash2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { buildRequestPayload } from "@/lib/http-ui.js";
import { formatSavedAt } from "@/lib/workspace-store.js";
import { cancelHttpRequest, sendHttpRequest } from "@/lib/http-client.js";
import { formatResponseBody, isJsonText } from "@/lib/formatters.js";
import { runRequestScript } from "@/lib/request-scripts.js";
import { applyRunnerDataRow, buildRunReport, getRunnableRequests, normalizeRunnerFolderPath, parseRunnerDataRows } from "@/lib/collection-runner.js";
import { cn } from "@/lib/utils.js";

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
  const [stopOnFailure, setStopOnFailure] = useState(false);
  const [dataSource, setDataSource] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [runHistory, setRunHistory] = useState([]);
  const stopRequestedRef = useRef(false);
  const currentRequestIdRef = useRef("");
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

  function patchResult(id, patch) {
    setResults((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function runOne({ request, index, id, dataRowName, dataValues }) {
    patchResult(id, { status: "running", error: "", attempts: 0 });
    let attempts = 0;
    let lastError = "";

    while (attempts <= retryCount) {
      attempts += 1;
      try {
        let requestForSend = request;
        let scriptContext = { vars: {} };
        const preSource = String(request.scriptPreRequest || "").trim();
        if (preSource) {
          const preRun = await runRequestScript({
            phase: "pre-request",
            script: preSource,
            request,
            response: null,
            context: scriptContext,
          });
          scriptContext = preRun.context || scriptContext;
          if (!preRun.ok) {
            throw new Error(preRun.error || "Pre-request script failed.");
          }
          requestForSend = preRun.request || request;
        }

        const requestId = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        currentRequestIdRef.current = requestId;
        const result = await sendHttpRequest({
          ...buildRequestPayload(requestForSend, workspace?.name || "", collection?.name || ""),
          requestId,
        });
        if (currentRequestIdRef.current === requestId) {
          currentRequestIdRef.current = "";
        }
        const response = buildRunnerResponse(result, requestForSend);
        const afterSource = String(request.scriptAfterResponse || "").trim();
        let tests = [];
        if (afterSource) {
          const postRun = await runRequestScript({
            phase: "after-response",
            script: afterSource,
            request: requestForSend,
            response,
            context: scriptContext,
          });
          tests = Array.isArray(postRun.tests) ? postRun.tests : [];
          if (!postRun.ok) {
            throw new Error(postRun.error || "After-response script failed.");
          }
        }

        const failedTests = tests.filter((test) => !test.ok);
        const passed = response.status >= 200 && response.status < 400 && failedTests.length === 0;
        patchResult(id, {
          status: passed ? "passed" : "failed",
          statusCode: response.status,
          duration: response.duration,
          attempts,
          tests,
          dataRowName,
          dataValues,
          error: failedTests.map((test) => `${test.name}: ${test.error || "failed"}`).join("\n"),
        });
        return passed;
      } catch (error) {
        lastError = error?.message || String(error);
      } finally {
        if (currentRequestIdRef.current.startsWith("runner-")) {
          currentRequestIdRef.current = "";
        }
      }
    }

    patchResult(id, {
      status: "failed",
      statusCode: 0,
      duration: "-",
      attempts,
      tests: [],
      dataRowName,
      dataValues,
      error: lastError,
    });
    return false;
  }

  async function runCollection() {
    if (isRunning || runItems.length === 0) return;
    stopRequestedRef.current = false;
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
      for (const item of runItems) {
        if (stopRequestedRef.current) {
          setResults((current) => current.map((result) => result.status === "queued" ? { ...result, status: "skipped" } : result));
          break;
        }
        const passed = await runOne(item);
        if (!passed && stopOnFailure) {
          setResults((current) => current.map((result) => result.status === "queued" ? { ...result, status: "skipped" } : result));
          break;
        }
      }
    } finally {
      setIsRunning(false);
      setRunHistory((current) => [{
        id: `run-${Date.now()}`,
        ranAt: new Date().toISOString(),
        collectionName: collection?.name || "",
        folderFilter,
        dataRows: dataRows.length,
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
      <Card className="overflow-hidden border border-border/40 bg-[hsl(var(--sidebar))]/95 shadow-[0_18px_38px_hsl(0_0%_0%/0.16)]">
        <div className="border-b border-border/20 bg-background/22 px-4 py-3">
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
              className="h-9 border border-border/45 bg-background/45 px-3 text-[12px] text-foreground outline-none transition-colors hover:border-primary/35 focus:border-primary/55"
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
              onChange={(event) => setRetryCount(Math.max(0, Number.parseInt(event.target.value.replace(/\D/g, ""), 10) || 0))}
              className="h-9 w-24 border-border/45 bg-background/45 text-[12px]"
              placeholder="Retries"
            />
            <label className="flex h-9 items-center gap-2 border border-border/45 bg-background/35 px-3 text-[12px] text-foreground transition-colors hover:border-primary/35">
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
        <div className="grid grid-cols-2 border-b border-border/20 bg-background/12 text-[11px] sm:grid-cols-5">
          <div className="border-r border-border/15 px-4 py-2.5 text-muted-foreground">Total <span className="ml-1 font-semibold text-foreground">{summary.total}</span></div>
          <div className="border-r border-border/15 px-4 py-2.5 text-muted-foreground">Done <span className="ml-1 font-semibold text-foreground">{summary.done}</span></div>
          <div className="border-r border-border/15 px-4 py-2.5 text-muted-foreground">Passed <span className="ml-1 font-semibold text-emerald-500">{summary.passed}</span></div>
          <div className="border-r border-border/15 px-4 py-2.5 text-muted-foreground">Failed <span className="ml-1 font-semibold text-red-500">{summary.failed}</span></div>
          <div className="px-4 py-2.5 text-muted-foreground">Tests <span className="ml-1 font-semibold text-foreground">{summary.tests}</span></div>
        </div>
        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-h-[132px] overflow-hidden border border-border/35 bg-background/24">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/18 bg-background/28 px-3 py-2">
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
          <div className="grid content-start gap-2 border border-border/25 bg-background/18 p-3">
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
            <div className="flex min-w-0 items-start gap-2 border-t border-border/15 pt-2 text-[10px] text-muted-foreground">
              <TimerReset className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/80" />
              <span className="min-w-0 truncate">Recent: {runHistory.length ? runHistory.map((run) => new Date(run.ranAt).toLocaleTimeString()).join(", ") : "none"}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card className="min-h-0 overflow-hidden border border-border/40 bg-[hsl(var(--sidebar))]/95 shadow-[0_18px_38px_hsl(0_0%_0%/0.14)]">
        <div className="grid grid-cols-[52px_92px_minmax(0,1.4fr)_86px_92px_92px_minmax(0,1fr)] border-b border-border/25 bg-background/22 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <div>#</div>
          <div>Method</div>
          <div>Request</div>
          <div>Data</div>
          <div>Status</div>
          <div>Time</div>
          <div>Assertions</div>
        </div>
        <div className="thin-scrollbar h-full min-h-0 overflow-auto">
          {(results.length ? results : runItems.map(({ request, index, id, dataRowName }) => ({
            id,
            name: request.name,
            method: request.method,
            url: request.url,
            dataRowName,
            status: "queued",
            duration: "-",
            tests: [],
            error: "",
          }))).map((item, index) => (
            <div key={item.id} className="grid grid-cols-[52px_92px_minmax(0,1.4fr)_86px_92px_92px_minmax(0,1fr)] items-center border-b border-border/12 px-3 py-2 text-[12px] transition-colors hover:bg-primary/[0.045]">
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
