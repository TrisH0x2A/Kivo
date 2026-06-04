import { useMemo, useState } from "react";
import { Copy, Download, Search } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { filterRequestHistory } from "@/lib/history-utils.js";

export function HistorySettingsPanel({ requestHistory = [], onClearHistory }) {
  const [historySearch, setHistorySearch] = useState("");
  const [historyCopied, setHistoryCopied] = useState(false);
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

  return (
    <Card className="rounded-none border border-border/35 bg-[hsl(var(--sidebar))]/98 p-5 shadow-[0_8px_20px_hsl(var(--background)/0.2)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-foreground">
        <div>
          <h3 className="text-[14px] font-semibold">Request History</h3>
          <div className="text-[11px] text-muted-foreground">{filteredHistory.length} of {requestHistory.length} runs</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={historySearch}
              onChange={(event) => setHistorySearch(event.target.value)}
              placeholder="Search history"
              className="h-8 w-48 border-border/40 bg-background/35 pl-7 text-[12px]"
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
        </div>
      </div>
      <div className="thin-scrollbar max-h-[520px] overflow-auto border border-border/20">
        {filteredHistory.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">No requests sent yet.</div>
        ) : (
          filteredHistory.map((entry) => (
            <div key={entry.id || `${entry.sentAt}-${entry.url}`} className="grid grid-cols-[88px_minmax(0,1fr)_92px_120px] gap-3 border-b border-border/10 px-3 py-2 text-[12px]">
              <div className={entry.ok ? "text-emerald-400" : "text-red-400"}>{entry.status || "ERR"}</div>
              <div className="min-w-0">
                <div className="truncate text-foreground">{entry.method} {entry.url}</div>
                <div className="truncate text-[11px] text-muted-foreground">{entry.workspaceName} / {entry.collectionName} / {entry.requestName}</div>
                {entry.error ? <div className="truncate text-[11px] text-red-400">{entry.error}</div> : null}
              </div>
              <div className="text-muted-foreground">{entry.duration || "-"}</div>
              <div className="text-right text-muted-foreground">{entry.sentAt ? new Date(entry.sentAt).toLocaleString() : "-"}</div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
