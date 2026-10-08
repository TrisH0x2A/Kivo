import { useMemo, useState } from "react";
import { Copy, Download, Eye, GitCompare, Pin, RotateCcw, Search, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { filterRequestHistory } from "@/lib/history-utils.js";
import { compareResponsesAsync } from "@/lib/response-comparison.js";

function snapshotResponse(entry) {
  const snapshot = entry?.responseSnapshot || {};
  const durationMs = Number(String(snapshot.duration || "").match(/\d+/)?.[0] || 0);
  return { status: snapshot.status, durationMs, rawBody: snapshot.body || "", body: snapshot.body || "", bodyBase64: snapshot.bodyBase64 || "", isBinary: snapshot.isBinary, headers: Object.fromEntries((snapshot.headers || []).map((header) => [header.key, header.value])) };
}

export function HistorySettingsPanel({ requestHistory = [], onClearHistory, historyLimit = 500, onHistoryLimitChange, onToggleHistoryPin, onDeleteHistory, onReplayHistory }) {
  const [historySearch, setHistorySearch] = useState("");
  const [historyCopied, setHistoryCopied] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [viewingEntry, setViewingEntry] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [comparing, setComparing] = useState(false);
  const filteredHistory = useMemo(
    () => filterRequestHistory(requestHistory, historySearch),
    [historySearch, requestHistory]
  );

  async function copyHistory() {
    await navigator.clipboard.writeText(JSON.stringify(filteredHistory, null, 2));
    setHistoryCopied(true);
    setTimeout(() => setHistoryCopied(false), 1400);
  }

  function exportHistory() {
    const blob = new Blob([JSON.stringify(filteredHistory, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "kivo-request-history.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  function toggleSelected(id) {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id].slice(-2));
    setComparison(null);
  }

  async function compareSelected() {
    const entries = selectedIds.map((id) => requestHistory.find((entry) => entry.id === id)).filter(Boolean);
    if (entries.length !== 2) return;
    setComparing(true);
    try {
      const diff = await compareResponsesAsync(snapshotResponse(entries[0]), snapshotResponse(entries[1]), { compareHeaders: true });
      setComparison({ entries, diff });
    } catch (error) {
      setComparison({ entries, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setComparing(false);
    }
  }

  return (
    <Card className="kivo-soft-panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-foreground">
        <div>
          <h3 className="text-[14px] font-semibold">Request History</h3>
          <div className="text-[11px] text-muted-foreground">{filteredHistory.length} of {requestHistory.length} runs</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            Retain
            <select value={historyLimit} onChange={(event) => onHistoryLimitChange?.(Number(event.target.value))} className="kivo-field h-8 border-border/25 bg-background/35 px-2 text-[11px] text-foreground">
              {[50, 100, 250, 500, 1000, 2500, 5000].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={historySearch}
              onChange={(event) => setHistorySearch(event.target.value)}
              placeholder="Search history"
              className="kivo-field h-8 w-48 border-border/25 bg-background/35 pl-7 text-[12px]"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 border border-border/40 bg-background/35"
            disabled={!filteredHistory.length}
            onClick={copyHistory}
          >
            <Copy className="h-3.5 w-3.5" />
            {historyCopied ? "Copied" : "Copy"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8 gap-1.5 border border-border/40 bg-background/35"
            disabled={!filteredHistory.length}
            onClick={exportHistory}
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 border border-border/40 bg-background/35" onClick={onClearHistory}>
            Clear
          </Button>
          <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 border border-border/40 bg-background/35" disabled={selectedIds.length !== 2 || comparing} onClick={compareSelected}>
            <GitCompare className="h-3.5 w-3.5" /> {comparing ? "Comparing" : "Compare"}
          </Button>
        </div>
      </div>
      {comparison && <section className="mb-4 border border-border/30 bg-background/20 p-3 text-[12px]" aria-label="History comparison">
        <div className="flex items-center justify-between gap-2"><h4 className="font-semibold">Snapshot comparison</h4><button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setComparison(null)} aria-label="Close comparison"><X className="h-3.5 w-3.5" /></button></div>
        {comparison.error ? <p className="mt-2 text-destructive">{comparison.error}</p> : <>
          <p className="mt-2 text-muted-foreground">{comparison.entries[0].sentAt} vs {comparison.entries[1].sentAt}</p>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px]"><span>{comparison.diff.statusChanged ? "Status changed" : "Status unchanged"}</span><span>{comparison.diff.durationChanged ? "Timing changed" : "Timing unchanged"}</span><span>{comparison.diff.body.changed ? "Body changed" : "Body unchanged"}</span><span>{comparison.diff.headers?.changed ? "Headers changed" : "Headers unchanged"}</span></div>
          {comparison.diff.body.entries?.slice(0, 4).map((item) => <div key={item.path} className="mt-2 grid gap-1 border-t border-border/20 pt-2 font-mono text-[11px] sm:grid-cols-3"><span>{item.path}</span><span className="break-all text-muted-foreground">{item.left}</span><span className="break-all text-primary">{item.right}</span></div>)}
        </>}
      </section>}
      <div className="thin-scrollbar max-h-[520px] overflow-auto border border-border/20 bg-background/20">
        {filteredHistory.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">No requests sent yet.</div>
        ) : (
          filteredHistory.map((entry) => (
            <div key={entry.id || `${entry.sentAt}-${entry.url}`} className="grid grid-cols-[24px_76px_minmax(0,1fr)_92px_120px_auto] items-center gap-3 border-b border-border/10 px-3 py-2 text-[12px] transition-colors hover:bg-accent/20">
              <input type="checkbox" aria-label={`Select ${entry.requestName || entry.url} for comparison`} checked={selectedIds.includes(entry.id)} onChange={() => toggleSelected(entry.id)} className="accent-primary" />
              <div className={entry.ok ? "text-emerald-400" : "text-red-400"}>{entry.status || "ERR"}{entry.pinned ? <Pin className="ml-1 inline h-3 w-3" /> : null}</div>
              <div className="min-w-0">
                <div className="truncate text-foreground">{entry.method} {entry.url}</div>
                <div className="truncate text-[11px] text-muted-foreground">{entry.workspaceName} / {entry.collectionName} / {entry.requestName} · {entry.environment?.name || "Default"}</div>
                {entry.error ? <div className="truncate text-[11px] text-red-400">{entry.error}</div> : null}
              </div>
              <div className="text-muted-foreground">{entry.duration || "-"}</div>
              <div className="text-right text-muted-foreground">{entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "-"}</div>
              <div className="flex items-center justify-end gap-1">
                <button type="button" title="View snapshot" aria-label="View snapshot" className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => setViewingEntry(entry)}><Eye className="h-3.5 w-3.5" /></button>
                <button type="button" title="Open snapshot as a new request" aria-label="Replay snapshot" disabled={!entry.requestSnapshot || !onReplayHistory} className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40" onClick={() => onReplayHistory?.(entry)}><RotateCcw className="h-3.5 w-3.5" /></button>
                <button type="button" title={entry.pinned ? "Unpin snapshot" : "Pin snapshot"} aria-label={entry.pinned ? "Unpin snapshot" : "Pin snapshot"} className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => onToggleHistoryPin?.(entry.id)}><Pin className={entry.pinned ? "h-3.5 w-3.5 fill-current text-primary" : "h-3.5 w-3.5"} /></button>
                <button type="button" title="Delete snapshot" aria-label="Delete snapshot" className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-destructive" onClick={() => onDeleteHistory?.(entry.id)}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))
        )}
      </div>
      {viewingEntry && <section className="mt-4 border border-border/30 bg-background/20 p-3" aria-label="History snapshot">
        <div className="flex items-center justify-between gap-2"><h4 className="font-semibold">Immutable snapshot</h4><button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setViewingEntry(null)} aria-label="Close snapshot"><X className="h-3.5 w-3.5" /></button></div>
        <p className="mt-1 text-[11px] text-muted-foreground">{viewingEntry.environment?.name || "Default"} · {viewingEntry.sentAt}</p>
        <pre className="thin-scrollbar mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{JSON.stringify({ request: viewingEntry.requestSnapshot, response: viewingEntry.responseSnapshot }, null, 2)}</pre>
      </section>}
    </Card>
  );
}
