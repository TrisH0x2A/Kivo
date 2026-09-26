import { createPortal } from "react-dom";
import { Download, Eye, X } from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { cn } from "@/lib/utils.js";

function Section({ title, children }) {
  return <section className="border border-border/45 bg-background/25 p-3">
    <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</h3>
    {children}
  </section>;
}

export function RequestExplainModal({ explanation, loading, error, exporting, onExport, onClose }) {
  if (!explanation && !loading && !error) return null;

  return createPortal(
    <div className="fixed inset-0 z-[270] flex items-center justify-center bg-background/75 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card className="grid h-[min(720px,92vh)] w-[min(920px,96vw)] grid-rows-[auto_minmax(0,1fr)_auto] border border-border/60 bg-card/96 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border/45 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="border border-primary/35 bg-primary/10 p-2 text-primary"><Eye className="h-4 w-4" /></div>
            <div className="min-w-0">
              <h2 className="truncate text-[16px] font-semibold text-foreground">Explain this request</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">Resolved preview only. Nothing is sent or changed.</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} aria-label="Close request explanation"><X className="h-4 w-4" /></Button>
        </div>

        <div className="thin-scrollbar min-h-0 overflow-auto p-5">
          {loading ? <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">Resolving request...</div> : null}
          {error ? <div role="alert" className="border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12px] text-red-200">{error}</div> : null}
          {explanation ? <div className="grid gap-3">
            <Section title="Outgoing request">
              <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground"><span className="text-primary">{explanation.method}</span><span className="text-muted-foreground">{explanation.url}</span></div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
                <span>Auth: <b className="font-medium text-foreground">{explanation.authSource}</b></span>
                <span>Body: <b className="font-medium text-foreground">{explanation.bodyType}</b></span>
                <span>Timeout: <b className="font-medium text-foreground">{explanation.settings.timeoutMs ? `${explanation.settings.timeoutMs} ms` : "Default"}</b></span>
                <span>Cookies: <b className="font-medium text-foreground">{explanation.settings.cookieJar ? "Enabled" : "Off"}</b></span>
              </div>
            </Section>

            <div className="grid gap-3 lg:grid-cols-2">
              <Section title={`Headers (${explanation.headers.length})`}>
                <div className="grid gap-1.5">
                  {explanation.headers.length ? explanation.headers.map((header) => <div key={`${header.key}-${header.source}`} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] gap-2 text-[11px]"><span className="truncate text-foreground">{header.key}</span><span className="truncate font-mono text-muted-foreground">{header.value}</span><span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/70">{header.source}</span></div>) : <span className="text-[11px] text-muted-foreground">No headers.</span>}
                </div>
              </Section>
              <Section title={`Variables (${explanation.variables.length})`}>
                <div className="grid gap-1.5">
                  {explanation.variables.length ? explanation.variables.map((variable) => <div key={variable.key} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,0.8fr)] gap-2 text-[11px]"><span className="truncate font-mono text-foreground">{`{{${variable.key}}}`}</span><span className={cn("text-[9px] uppercase tracking-[0.12em]", variable.source === "Unresolved" ? "text-amber-300" : "text-muted-foreground/70")}>{variable.source}</span><span className="truncate font-mono text-muted-foreground">{variable.value}</span></div>) : <span className="text-[11px] text-muted-foreground">No template variables.</span>}
                </div>
              </Section>
            </div>

            <Section title="Body preview">
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-foreground/90">{String(explanation.body || "(empty body)").slice(0, 12000)}</pre>
            </Section>
          </div> : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/45 px-5 py-3 text-[10px] text-muted-foreground"><span>Secrets are masked. Review bundles before sharing.</span><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={onExport} disabled={!explanation || exporting}><Download className="mr-2 h-3.5 w-3.5" />{exporting ? "Exporting..." : "Export bundle"}</Button><Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button></div></div>
      </Card>
    </div>,
    document.body
  );
}
