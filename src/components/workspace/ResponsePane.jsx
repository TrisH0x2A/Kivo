import { BadgeCheck, Clock3, Cookie, Copy, Download, FileJson2, FlaskConical, ListTree, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import { CodeEditor } from "@/components/workspace/CodeEditor.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { cn } from "@/lib/utils.js";
import { filterJson } from "@/lib/json-filter.js";
import { exportResponseFile } from "@/lib/http-client.js";
import { getHeaderValue, getResponseDownloadName } from "@/lib/response-utils.js";
import { CookieManagerModal, parseSetCookieString } from "@/components/workspace/CookieManagerModal.jsx";

import { JsonTree } from "@/components/ui/JsonTree.jsx";
import { GrpcSessionControls } from "@/components/workspace/GrpcSessionControls.jsx";
import { ResponseRegressionDialog } from "@/components/workspace/ResponseRegressionDialog.jsx";

const responseTabs = ["Body", "Headers", "Cookies", "Meta"];
const MAX_EDITOR_PREVIEW_CHARS = 1_000_000;
const MAX_JSON_TREE_CHARS = 2_000_000;

function getTone(status) {
  if (status >= 200 && status < 400) {
    return "success";
  }

  if (status >= 400) {
    return "danger";
  }

  return "muted";
}

function detectResponseLanguage(contentType, bodyText, isJson) {
  if (isJson) {
    return "json";
  }

  const normalizedType = String(contentType || "").toLowerCase();
  const source = String(bodyText || "").trim();

  if (normalizedType.includes("graphql")) {
    return "graphql";
  }

  if (normalizedType.includes("application/xml") || normalizedType.includes("text/xml") || normalizedType.includes("+xml")) {
    return "xml";
  }

  if (normalizedType.includes("yaml") || normalizedType.includes("yml")) {
    return "yaml";
  }

  if (source.startsWith("<?xml") || (source.startsWith("<") && source.endsWith(">"))) {
    return "xml";
  }

  if (source.startsWith("---") || /\n\s*[A-Za-z0-9_-]+\s*:\s*/.test(source)) {
    return "yaml";
  }

  return "text";
}

export function ResponsePane({
  response,
  isSending = false,
  sendStartedAt = 0,
  onCancelSend,
  workspaceName = "",
  collectionName = "",
  activeTab,
  onTabChange,
  bodyView,
  onBodyViewChange,
  onClearResponse,
  regressionScript = "",
  onAddRegression,
}) {
  const tone = getTone(response.status);

  const contentType = getHeaderValue(response.headers, "content-type").toLowerCase();
  const isHtml = contentType.includes("text/html");
  const isJson = response.isJson;
  const isBinary = Boolean(response.isBinary);
  const responseBodyLanguage = detectResponseLanguage(contentType, response.body || response.rawBody, isJson);
  const jsonTreeTooLarge = isJson && String(response.body || "").length > MAX_JSON_TREE_CHARS;

  const parsedJson = useMemo(() => {
    if (!isJson || jsonTreeTooLarge) return null;
    try { return JSON.parse(response.body); } catch { return null; }
  }, [response.body, isJson, jsonTreeTooLarge]);
  const grpcMode = getHeaderValue(response.headers, "x-kivo-grpc-mode");
  const grpcMessages = ["server_stream", "bidi"].includes(grpcMode) && Array.isArray(parsedJson) ? parsedJson : null;
  const isGrpc = Boolean(grpcMode);
  const tabs = isGrpc ? ["Body", "Headers", "Trailers", "Meta"] : responseTabs;
  const liveGrpc = isSending && Boolean(response.meta?.requestId);
  function metadataRows(kind) {
    try { return JSON.parse(getHeaderValue(response.headers, `x-kivo-grpc-${kind}`) || "[]"); }
    catch { return []; }
  }
  const [messageLimit, setMessageLimit] = useState(50);
  useEffect(() => { setMessageLimit(50); }, [response.body]);

  let bodyViews = ["Raw"];
  if (isJson) {
    bodyViews = ["Tree", "JSON", "Raw"];
    if (grpcMessages) bodyViews.unshift("Messages");
  } else if (isHtml) {
    bodyViews = ["Preview", "Raw"];
  }

  let currentView = bodyView;
  if (!bodyViews.includes(currentView)) {
    currentView = bodyViews[0];
  }

  const [inputValue, setInputValue] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const [regressionOpen, setRegressionOpen] = useState(false);

  useEffect(() => {
    if (!isSending || !sendStartedAt) {
      setElapsedMs(0);
      return undefined;
    }

    const updateElapsed = () => {
      setElapsedMs(Math.max(0, Date.now() - sendStartedAt));
    };

    updateElapsed();
    const interval = window.setInterval(updateElapsed, 100);
    return () => window.clearInterval(interval);
  }, [isSending, sendStartedAt]);

  useEffect(() => {
    if (!inputValue.trim()) {
      setSearchQuery("");
      return;
    }

    const isStructured = /[=!<>]/.test(inputValue);
    if (!isStructured && inputValue.trim().length < 2) {
      setSearchQuery("");
      return;
    }

    const timer = setTimeout(() => {
      setSearchQuery(inputValue);
    }, 300);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const filteredJson = useMemo(() => {
    if (!parsedJson || !searchQuery) return parsedJson;
    return filterJson(parsedJson, searchQuery);
  }, [parsedJson, searchQuery]);

  const MAX_DISPLAY = 50;
  const displayJson = useMemo(() => {
    if (!filteredJson || !searchQuery) return filteredJson;
    if (Array.isArray(filteredJson) && filteredJson.length > MAX_DISPLAY) {
      return filteredJson.slice(0, MAX_DISPLAY);
    }
    return filteredJson;
  }, [filteredJson, searchQuery]);

  const totalMatches = filteredJson ? (Array.isArray(filteredJson) ? filteredJson.length : Object.keys(filteredJson).length) : 0;
  const isResultCapped = searchQuery && Array.isArray(filteredJson) && filteredJson.length > MAX_DISPLAY;
  const elapsedLabel = `${(elapsedMs / 1000).toFixed(1)}s`;
  const editorBodyValue = currentView === "JSON" && isJson ? response.body : response.rawBody;
  const editorPreviewValue = String(editorBodyValue || "").length > MAX_EDITOR_PREVIEW_CHARS
    ? `${String(editorBodyValue || "").slice(0, MAX_EDITOR_PREVIEW_CHARS)}\n\n[Preview truncated by Kivo. Save or copy the response to inspect the full body.]`
    : editorBodyValue;
  const isEditorPreviewCapped = String(editorBodyValue || "").length > MAX_EDITOR_PREVIEW_CHARS;

  const responseCookiesPreview = useMemo(() => {
    return (response.cookies || [])
      .map((cookie) => parseSetCookieString(cookie))
      .filter(Boolean);
  }, [response.cookies]);

  function openManager() {
    setIsManageOpen(true);
  }

  function closeManager() {
    setIsManageOpen(false);
  }

  function buildResponseExportPayload() {
    return {
      status: response.status,
      badge: response.badge,
      statusText: response.statusText,
      duration: response.duration,
      size: response.size,
      headers: response.headers,
      cookies: response.cookies,
      body: response.body,
      rawBody: response.rawBody,
      bodyBase64: response.bodyBase64 || "",
      isBinary,
      contentType: response.contentType || contentType || "",
      isJson: response.isJson,
      meta: response.meta,
      savedAt: response.savedAt,
    };
  }

  async function handleCopyResponse() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildResponseExportPayload(), null, 2));
    } catch {
    }
  }

  async function handleSaveResponseFile() {
    try {
      const selected = await save({
        defaultPath: getResponseDownloadName({ ...response, isBinary, contentType }, response.headers),
        filters: isBinary
          ? [{ name: "Binary", extensions: ["bin"] }, { name: "All Files", extensions: ["*"] }]
          : [{ name: "Response", extensions: ["json", "txt", "html", "xml", "yaml", "csv"] }, { name: "All Files", extensions: ["*"] }],
      });
      if (!selected || typeof selected !== "string") {
        return;
      }
      await exportResponseFile(selected, buildResponseExportPayload());
    } catch {
    }
  }

  function handleClearResponse() {
    onClearResponse?.();
  }

  return (
    <Card role="region" aria-label="Response inspector" className="kivo-response-pane flex h-full min-h-0 flex-col gap-0 overflow-hidden p-0">
      {regressionOpen && <ResponseRegressionDialog response={response} existingScript={regressionScript} onClose={() => setRegressionOpen(false)} onAdd={(script) => { onAddRegression(script); setRegressionOpen(false); }} />}
      <div className="kivo-response-metrics flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-[12px] text-muted-foreground">
        <div className="order-2 flex items-center gap-3 font-mono">
          <div className="flex items-center gap-1.5">
            <Clock3 className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
            <span>{response.duration}</span>
          </div>
          <div className="text-foreground">{response.size}</div>
        </div>
        <div
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 font-medium lg:px-3 lg:py-1.5",
            tone === "success" && "status-success",
            tone === "danger" && "status-danger",
            tone === "muted" && "status-muted"
          )}
        >
          <BadgeCheck className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
          <span>{response.badge}</span>
        </div>
      </div>

      <div className="kivo-editor-tabs border-b px-3 text-[12px]">
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <div className="thin-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-1">
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => onTabChange(tab)}
                aria-pressed={activeTab === tab}
                className={cn("kivo-editor-tab shrink-0 whitespace-nowrap px-2 text-[12px] text-muted-foreground hover:text-foreground", activeTab === tab && "kivo-tab-active")}
              >
                {tab}
                {tab === "Headers" || tab === "Cookies" ? <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{tab === "Headers" ? Object.keys(response.headers).length : response.cookies.length}</span> : null}
              </button>
            ))}
          </div>
          <div className="ml-1 flex shrink-0 items-center gap-0.5 text-muted-foreground">
            {onAddRegression && <button type="button" title="Create regression tests" aria-label="Create regression tests" disabled={isSending || response.status <= 0 || response.badge === "Failed"} onClick={() => setRegressionOpen(true)} className="inline-flex h-7 w-7 items-center justify-center transition-colors hover:text-foreground disabled:opacity-40"><FlaskConical className="h-3.5 w-3.5" /></button>}
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center transition-colors hover:text-foreground"
              onClick={handleCopyResponse}
              title="Copy response"
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center transition-colors hover:text-foreground"
              onClick={handleSaveResponseFile}
              title="Save response to file"
            >
              <Download className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center transition-colors hover:text-red-400"
              onClick={handleClearResponse}
              title="Clear response"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {liveGrpc && <GrpcSessionControls requestId={response.meta.requestId} inputOpen={response.meta.inputOpen} onCancel={onCancelSend} />}
      {Number(response.headers?.["x-kivo-grpc-dropped"]) > 0 && <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Older messages omitted from the bounded preview: {response.headers["x-kivo-grpc-dropped"]}</p>}
      <div className="relative min-h-0 flex-1 overflow-hidden p-3">
        {activeTab === "Body" ? (
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <FileJson2 className="h-3 w-3" />
                  <span>{grpcMessages ? `${grpcMessages.length} messages` : "Body"}</span>
                </div>
                {currentView === "Tree" && (
                  <div className="kivo-field ml-2 flex w-48 items-center gap-1.5 py-[3px] pl-2.5 pr-1.5 normal-case tracking-normal transition-colors">
                    <Search className="h-[11px] w-[11px] text-muted-foreground shrink-0" />
                    <input
                      type="text"
                      placeholder="e.g. age > 20 && status == active"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      className="w-full bg-transparent text-[11px] font-medium outline-none placeholder:text-muted-foreground/60 text-foreground"
                    />
                    {inputValue && (
                      <button onClick={() => setInputValue("")} className="text-muted-foreground hover:text-foreground shrink-0 focus:outline-none">
                        <X className="h-[11px] w-[11px]" />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {bodyViews.map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => onBodyViewChange(view)}
                    className={cn(
                      "px-2 py-1 text-muted-foreground disabled:opacity-40 transition-colors hover:bg-accent/20 hover:text-foreground",
                      currentView === view && "kivo-tab-active"
                    )}
                  >
                    {view}
                  </button>
                ))}
              </div>
            </div>
            {currentView === "Messages" && grpcMessages ? (
              <div className="thin-scrollbar min-h-0 overflow-auto" aria-label="Received gRPC messages">
                {grpcMessages.slice(0, messageLimit).map((message, index) => (
                  <article key={index} className="kivo-grpc-message">
                    <div className="mb-3 flex items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground"><h3 className="text-primary">Message #{index + 1}</h3><span>{new TextEncoder().encode(JSON.stringify(message)).length} B JSON</span></div>
                    <JsonTree data={message} />
                  </article>
                ))}
                {grpcMessages.length === 0 && <p className="p-4 text-[12px] text-muted-foreground">No messages received</p>}
                {grpcMessages.length > messageLimit && <Button variant="ghost" onClick={() => setMessageLimit((limit) => limit + 50)}>Show more messages</Button>}
              </div>
            ) : isBinary ? (
              <div className="kivo-field flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                <Download className="h-8 w-8 text-primary/70" />
                <div className="text-[13px] font-medium text-foreground">Binary response</div>
                <div className="max-w-sm text-[12px]">Preview is unavailable for this content type. Save the response to inspect the original bytes.</div>
              </div>
            ) : currentView === "Tree" && parsedJson !== null ? (
              <div className="kivo-response-body thin-scrollbar h-full overflow-auto p-3">
                {(Array.isArray(displayJson) ? displayJson.length > 0 : Object.keys(displayJson || {}).length > 0) ? (
                  <div className="flex flex-col gap-0">
                    {searchQuery && (
                      <div className="text-[11px] text-muted-foreground mb-3 font-medium">
                        {isResultCapped
                          ? `Showing ${MAX_DISPLAY} of ${totalMatches} matches`
                          : `${totalMatches} match${totalMatches !== 1 ? "es" : ""}`}
                      </div>
                    )}
                    <JsonTree data={displayJson} searchQuery={searchQuery} />
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-muted-foreground/70">
                    <Search className="h-8 w-8 mb-2 opacity-20" />
                    <span className="text-[12px]">No matching keys or values found</span>
                  </div>
                )}
              </div>
            ) : currentView === "Tree" && isJson && jsonTreeTooLarge ? (
              <div className="kivo-field flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                <FileJson2 className="h-8 w-8 text-primary/70" />
                <div className="text-[13px] font-medium text-foreground">JSON tree paused for this response</div>
                <div className="max-w-md text-[12px]">The body is large enough that parsing it into the interactive tree could slow the app. Use JSON or Raw preview, or save the full response to a file.</div>
              </div>
            ) : currentView === "Preview" ? (
              <div className="h-full overflow-hidden border border-border/10 bg-white shadow-inner">
                <iframe
                  srcDoc={response.body || response.rawBody}
                  title="HTML Preview"
                  sandbox="allow-same-origin"
                  className="w-full h-full border-0"
                />
              </div>
            ) : (
              <CodeEditor
                readOnly
                value={editorPreviewValue}
                language={currentView === "Raw" ? "text" : (currentView === "JSON" && isJson ? "json" : responseBodyLanguage)}
                wrapLines
                placeholder={isEditorPreviewCapped ? "Large response preview is truncated" : "Response body will appear here"}
              />
            )}
          </div>
        ) : null}

        {isGrpc && ["Headers", "Trailers"].includes(activeTab) ? (
          <div className="thin-scrollbar h-full overflow-auto text-xs" aria-label={`gRPC ${activeTab.toLowerCase()}`}>
            {metadataRows(activeTab.toLowerCase()).map((row, index) => <div key={index} className="grid grid-cols-[minmax(100px,1fr)_minmax(0,2fr)] gap-4 border-b border-border/30 px-2 py-3"><span className="break-all text-muted-foreground">{row.key}</span><span className="break-all font-mono">{row.value}</span></div>)}
            {metadataRows(activeTab.toLowerCase()).length === 0 && <p className="p-3 text-muted-foreground">No {activeTab.toLowerCase()} received</p>}
          </div>
        ) : null}
        {activeTab === "Headers" && !isGrpc ? (
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Headers</div>
            <div className="thin-scrollbar min-h-0 overflow-auto bg-transparent">
              {Object.entries(response.headers).length ? (
                Object.entries(response.headers).map(([key, value]) => (
                  <div key={key} className="kivo-row-hover kivo-quiet-divider grid grid-cols-[220px_minmax(0,1fr)] border-b text-[12px]">
                    <div className="px-3 py-2 text-muted-foreground">{key}</div>
                    <div className="px-3 py-2 text-foreground">{String(value)}</div>
                  </div>
                ))
              ) : (
                <div className="p-3 text-[12px] text-muted-foreground">No response headers</div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === "Cookies" ? (
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                <Cookie className="h-3 w-3" />
                <span>Cookies</span>
              </div>
              <Button type="button" variant="secondary" size="sm" className="h-7 border border-border/35 bg-accent/30 text-[11px]" onClick={openManager}>
                Manage Cookies
              </Button>
            </div>
            <div className="thin-scrollbar min-h-0 overflow-auto bg-transparent">
              {responseCookiesPreview.length ? (
                responseCookiesPreview.map((cookie, index) => (
                  <div key={`${cookie.name}-${index}`} className="kivo-row-hover kivo-quiet-divider grid grid-cols-[220px_minmax(0,1fr)] border-b text-[12px]">
                    <div className="px-3 py-2 text-foreground">{cookie.name}</div>
                    <div className="px-3 py-2 text-muted-foreground">{cookie.value}</div>
                  </div>
                ))
              ) : (
                <div className="p-3 text-[12px] text-muted-foreground">No cookies were returned by this response.</div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === "Meta" ? (
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              <ListTree className="h-3 w-3" />
              <span>Meta</span>
            </div>
            <div className="kivo-field p-3 text-[12px] text-muted-foreground">
              <div className="grid gap-2">
                <div className="flex items-center justify-between">
                  <span>Method</span>
                  <span className="text-foreground">{response.meta.method}</span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <span>Final URL</span>
                  <span className="max-w-[70%] truncate text-right text-foreground">{response.meta.url}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Status</span>
                  <span className="text-foreground">{response.statusText}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Size</span>
                  <span className="text-foreground">{response.size}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {isSending && !liveGrpc ? (
          <div className="absolute inset-0 z-30 flex items-center justify-center backdrop-blur-md">
            <div className="flex flex-col items-center gap-3 text-center">
              <LoaderCircle className="h-7 w-7 animate-spin text-primary" />
              <div className="text-sm font-semibold text-foreground">Sending request...</div>
              <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                <span>{elapsedLabel}</span>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={onCancelSend}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

      </div>

      <CookieManagerModal
        open={isManageOpen}
        onClose={closeManager}
        workspaceName={workspaceName}
        collectionName={collectionName}
      />

    </Card>
  );
}
