import { useEffect, useRef, useState } from "react";
import { Activity, Check, CircleMinus, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { diagnoseConnection } from "@/lib/http-client.js";
import { buildUrlWithParams } from "@/lib/http-ui.js";

export function ConnectionDiagnosticsDialog({ request, workspaceName, collectionName, onClose }) {
  const dialog = useRef(null);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
  async function run() {
    setRunning(true);
    setError("");
    setReport(null);
    try {
      setReport(await diagnoseConnection({
        url: buildUrlWithParams(request.url, request.queryParams),
        workspaceName, collectionName,
        proxyMode: request.proxyMode || "inherit",
        proxyHttp: request.proxyHttp || "",
        proxyHttps: request.proxyHttps || "",
        noProxy: request.noProxy || "",
        clientCertificatePath: request.clientCertificatePath || "",
        clientKeyPath: request.clientKeyPath || "",
      }));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setRunning(false); }
  }
  return <dialog ref={dialog} aria-labelledby="diagnostics-title" onCancel={onClose} className="m-auto w-[min(760px,94vw)] max-w-none rounded border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="flex max-h-[88dvh] min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 id="diagnostics-title" className="text-sm font-semibold">Connection diagnostics</h2>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close diagnostics"><X className="h-4 w-4" /></Button>
      </header>
      <div className="thin-scrollbar min-h-0 overflow-auto px-5 py-4">
        <p className="mb-4 text-xs leading-5 text-muted-foreground">Checks DNS, TCP and TLS, then sends a separate HEAD request with your proxy and certificate settings. Request headers, cookies and body are excluded. Redirects are reported without following them.</p>
        {running && <p role="status" className="flex items-center gap-2 py-6 text-sm"><LoaderCircle className="h-4 w-4 animate-spin" />Checking connection...</p>}
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {report && <>
          <p className="mb-3 break-all font-mono text-xs">{report.target}</p>
          <ol className="divide-y divide-border border-y border-border">
            {report.steps.map((step, index) => {
              const Icon = step.status === "passed" ? Check : step.status === "failed" || step.status === "warning" ? TriangleAlert : CircleMinus;
              return <li key={`${step.stage}-${index}`} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Icon className="h-4 w-4 shrink-0 text-primary" /><span className="font-semibold">{step.stage}</span>
                  <span className="text-muted-foreground">{step.status}</span>
                  <span className="ml-auto font-mono text-muted-foreground">{step.durationMs == null ? "Not measured" : `${step.durationMs} ms`}</span>
                </div>
                <p className="mt-2 break-words text-xs leading-5">{step.detail}</p>
                {step.hint && <p className="mt-1 text-xs leading-5 text-muted-foreground">{step.hint}</p>}
              </li>;
            })}
          </ol>
        </>}
      </div>
      <footer className="flex justify-end border-t border-border px-5 py-3">
        <Button size="sm" onClick={run} disabled={running}><Activity className="mr-2 h-4 w-4" />{report ? "Run again" : "Run checks"}</Button>
      </footer>
    </div>
  </dialog>;
}
