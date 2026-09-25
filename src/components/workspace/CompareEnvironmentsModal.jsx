import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { GitCompareArrows, X } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";

function SelectField({ label, value, options, onChange }) {
  return <label className="grid gap-1.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
    {label}
    <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 border border-border/50 bg-background px-2 text-[12px] normal-case tracking-normal text-foreground outline-none focus:border-primary/70">
      {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>
  </label>;
}

export function CompareEnvironmentsModal({ open, request, environments, loading, running, result, error, onRun, onClose }) {
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [allowMutation, setAllowMutation] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLeftId(environments[0]?.id || "");
    setRightId(environments[1]?.id || environments[0]?.id || "");
    setAllowMutation(false);
  }, [open, environments]);

  const isReadOnly = ["GET", "HEAD", "OPTIONS"].includes(String(request?.method || "GET").toUpperCase());
  const canRun = Boolean(leftId && rightId && leftId !== rightId && (!running && (isReadOnly || allowMutation)));
  const diff = result?.diff;
  const leftEnvironment = environments.find((environment) => environment.id === result?.leftId);
  const rightEnvironment = environments.find((environment) => environment.id === result?.rightId);
  const summary = useMemo(() => {
    if (!diff) return "Run a comparison to inspect differences.";
    if (!diff.statusChanged && !diff.body.changed) return "Responses match for status and body.";
    return `${diff.body.entries.length} body difference${diff.body.entries.length === 1 ? "" : "s"}${diff.statusChanged ? " and a status difference" : ""}.`;
  }, [diff]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[275] flex items-center justify-center bg-background/75 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card className="grid h-[min(700px,92vh)] w-[min(980px,96vw)] grid-rows-[auto_minmax(0,1fr)_auto] border border-border/60 bg-card/96 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border/45 px-5 py-4">
          <div className="flex items-start gap-3"><div className="border border-primary/35 bg-primary/10 p-2 text-primary"><GitCompareArrows className="h-4 w-4" /></div><div><h2 className="text-[16px] font-semibold text-foreground">Compare environments</h2><p className="mt-1 text-[11px] text-muted-foreground">Send {request?.name || "this request"} twice and compare the responses.</p></div></div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close environment comparison"><X className="h-4 w-4" /></Button>
        </div>
        <div className="thin-scrollbar min-h-0 overflow-auto p-5">
          {loading ? <p className="text-[12px] text-muted-foreground">Loading environments...</p> : null}
          {!loading && environments.length < 2 ? <div className="border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-100">Create at least two workspace environments to compare this request.</div> : null}
          {!loading && environments.length >= 2 ? <div className="grid gap-4">
            <div className="grid gap-3 border border-border/45 bg-background/25 p-3 sm:grid-cols-2">
              <SelectField label="Baseline" value={leftId} options={environments} onChange={setLeftId} />
              <SelectField label="Compare with" value={rightId} options={environments} onChange={setRightId} />
              {!isReadOnly ? <label className="flex items-start gap-2 text-[11px] text-amber-200/80 sm:col-span-2"><input type="checkbox" checked={allowMutation} onChange={(event) => setAllowMutation(event.target.checked)} className="mt-0.5" />This is a {String(request?.method || "").toUpperCase()} request. I understand it will run against both environments.</label> : null}
              {leftId === rightId ? <p className="text-[11px] text-amber-200 sm:col-span-2">Choose two different environments.</p> : null}
            </div>
            {error ? <div role="alert" className="border border-red-400/30 bg-red-400/10 px-3 py-2 text-[11px] text-red-200">{error}</div> : null}
            {result ? <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3 border-b border-border/45 pb-3 text-[12px]"><span className="text-muted-foreground">{summary}</span><span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{diff?.body.mode} diff</span></div>
              <div className="grid gap-3 sm:grid-cols-2">
                {[{ side: "left", label: leftEnvironment?.name || "Baseline", response: result.left }, { side: "right", label: rightEnvironment?.name || "Compare", response: result.right }].map((item) => <div key={item.side} className="border border-border/45 bg-background/25 p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-[12px] font-medium text-foreground">{item.label}</span><span className={`text-[11px] ${Number(item.response?.status || 0) >= 400 ? "text-red-300" : "text-emerald-300"}`}>{item.response?.status || "ERR"} {item.response?.statusText || ""}</span></div><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-muted-foreground">{String(item.response?.body || item.response?.error || "(empty body)").slice(0, 6000)}</pre></div>)}
              </div>
              {diff?.body.entries.length ? <div className="border border-border/45 bg-background/25 p-3"><h3 className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Changed fields</h3><div className="grid gap-1.5">{diff.body.entries.map((entry) => <div key={entry.path} className="grid gap-1 border-b border-border/25 pb-1.5 text-[10px] sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)]"><span className="font-mono text-foreground">{entry.path}</span><span className="break-words text-red-200/80">{entry.left}</span><span className="break-words text-emerald-200/80">{entry.right}</span></div>)}</div>{diff.body.truncated ? <p className="mt-2 text-[10px] text-muted-foreground">Showing the first 80 changed fields.</p> : null}</div> : null}
            </div> : null}
          </div> : null}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/45 px-5 py-3"><span className="text-[10px] text-muted-foreground">Environment values stay local to each request.</span><div className="flex gap-2"><Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button><Button type="button" size="sm" onClick={() => onRun(leftId, rightId)} disabled={!canRun}>{running ? "Comparing..." : "Run comparison"}</Button></div></div>
      </Card>
    </div>,
    document.body
  );
}
