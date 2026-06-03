import { useMemo, useState } from "react";
import { CheckCircle2, ListChecks, Play, RotateCcw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { buildRequestPayload } from "@/lib/http-ui.js";
import { formatSavedAt, REQUEST_MODES } from "@/lib/workspace-store.js";
import { sendHttpRequest } from "@/lib/http-client.js";
import { formatResponseBody, isJsonText } from "@/lib/formatters.js";
import { runRequestScript } from "@/lib/request-scripts.js";
import { cn } from "@/lib/utils.js";

function normalizeFolderPath(path) {
  return String(path ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function getRunnableRequests(collection, folderFilter) {
  const folder = normalizeFolderPath(folderFilter);
  return (collection?.requests || [])
    .filter((request) => request.requestMode === REQUEST_MODES.HTTP || request.requestMode === REQUEST_MODES.GRAPHQL)
    .filter((request) => !folder || normalizeFolderPath(request.folderPath) === folder)
    .map((request, index) => ({ request, index }));
}

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

export function CollectionRunner({ workspace, collection }) {
  const [folderFilter, setFolderFilter] = useState("");
  const [retryCount, setRetryCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState([]);

  const folders = useMemo(() => {
    const values = new Set();
    for (const request of collection?.requests || []) {
      const folder = normalizeFolderPath(request.folderPath);
      if (folder) values.add(folder);
    }
    return Array.from(values).sort();
  }, [collection?.requests]);

  const runnable = useMemo(
    () => getRunnableRequests(collection, folderFilter),
    [collection, folderFilter]
  );

  const summary = useMemo(() => {
    const done = results.filter((item) => item.status === "passed" || item.status === "failed");
    const passed = done.filter((item) => item.status === "passed").length;
    const failed = done.filter((item) => item.status === "failed").length;
    const tests = results.flatMap((item) => item.tests || []);
    return { total: runnable.length, done: done.length, passed, failed, tests: tests.length };
  }, [results, runnable.length]);

  function patchResult(id, patch) {
    setResults((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function runOne({ request, index }) {
    const id = `${index}-${request.name}`;
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

        const result = await sendHttpRequest({
          ...buildRequestPayload(requestForSend, workspace?.name || "", collection?.name || ""),
          requestId: `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
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
          error: failedTests.map((test) => `${test.name}: ${test.error || "failed"}`).join("\n"),
        });
        return;
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }

    patchResult(id, {
      status: "failed",
      statusCode: 0,
      duration: "-",
      attempts,
      tests: [],
      error: lastError,
    });
  }

  async function runCollection() {
    if (isRunning || runnable.length === 0) return;
    setIsRunning(true);
    setResults(runnable.map(({ request, index }) => ({
      id: `${index}-${request.name}`,
      name: request.name,
      method: request.method,
      url: request.url,
      folderPath: request.folderPath || "",
      status: "queued",
      attempts: 0,
      statusCode: 0,
      duration: "-",
      tests: [],
      error: "",
    })));

    try {
      for (const item of runnable) {
        await runOne(item);
      }
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4">
      <Card className="border border-border/35 bg-[hsl(var(--sidebar))]/98 p-4 shadow-[0_8px_22px_hsl(var(--background)/0.22)]">
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
              className="h-9 border border-border/35 bg-background/40 px-3 text-[12px] text-foreground outline-none"
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
              className="h-9 w-24 border-border/35 bg-background/40 text-[12px]"
              placeholder="Retries"
            />
            <Button type="button" className="h-9 gap-2" onClick={runCollection} disabled={isRunning || runnable.length === 0}>
              {isRunning ? <RotateCcw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {isRunning ? "Running" : "Run"}
            </Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-5 border border-border/25 bg-background/25 text-center text-[11px]">
          <div className="px-3 py-2 text-muted-foreground">Total <span className="font-semibold text-foreground">{summary.total}</span></div>
          <div className="px-3 py-2 text-muted-foreground">Done <span className="font-semibold text-foreground">{summary.done}</span></div>
          <div className="px-3 py-2 text-muted-foreground">Passed <span className="font-semibold text-emerald-500">{summary.passed}</span></div>
          <div className="px-3 py-2 text-muted-foreground">Failed <span className="font-semibold text-red-500">{summary.failed}</span></div>
          <div className="px-3 py-2 text-muted-foreground">Tests <span className="font-semibold text-foreground">{summary.tests}</span></div>
        </div>
      </Card>

      <Card className="min-h-0 overflow-hidden border border-border/35 bg-[hsl(var(--sidebar))]/98 shadow-[0_8px_22px_hsl(var(--background)/0.2)]">
        <div className="grid grid-cols-[52px_92px_minmax(0,1.4fr)_92px_92px_minmax(0,1fr)] border-b border-border/25 px-3 py-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <div>#</div>
          <div>Method</div>
          <div>Request</div>
          <div>Status</div>
          <div>Time</div>
          <div>Assertions</div>
        </div>
        <div className="thin-scrollbar h-full min-h-0 overflow-auto">
          {(results.length ? results : runnable.map(({ request, index }) => ({
            id: `${index}-${request.name}`,
            name: request.name,
            method: request.method,
            url: request.url,
            status: "queued",
            duration: "-",
            tests: [],
            error: "",
          }))).map((item, index) => (
            <div key={item.id} className="grid grid-cols-[52px_92px_minmax(0,1.4fr)_92px_92px_minmax(0,1fr)] items-center border-b border-border/12 px-3 py-2 text-[12px]">
              <div className="text-muted-foreground">{index + 1}</div>
              <div className="font-semibold text-foreground">{item.method || "GET"}</div>
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{item.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">{item.url || "-"}</div>
              </div>
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
          {runnable.length === 0 ? (
            <div className="p-8 text-center text-[12px] text-muted-foreground">
              No HTTP or GraphQL requests found for this scope.
            </div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
