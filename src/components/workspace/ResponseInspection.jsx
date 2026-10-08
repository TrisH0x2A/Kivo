import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, LoaderCircle } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { exportResponseFile } from "@/lib/http-client.js";

export function ResponseInspection({ response, mode }) {
  const [pointer, setPointer] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [exportError, setExportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [exportPath, setExportPath] = useState("");
  const body = String(response.rawBody ?? response.body ?? "");
  useEffect(() => { setPage(0); }, [body, response.bodyBase64, pointer, mode]);
  useEffect(() => {
    let worker;
    let deadline;
    let cancelled = false;
    setBusy(true); setError(""); setResult(null);
    const timer = setTimeout(() => {
      worker = new Worker(new URL("../../lib/response-inspection-worker.js", import.meta.url), { type: "module" });
      const fail = (message) => { clearTimeout(deadline); worker.terminate(); if (!cancelled) { (exportPath ? setExportError : setError)(message); setBusy(false); setExportPath(""); } };
      deadline = setTimeout(() => fail("Inspection took too long. Choose a smaller response."), 15000);
      worker.onerror = () => fail("Response inspection failed.");
      worker.onmessage = async ({ data }) => {
        clearTimeout(deadline); worker.terminate();
        if (cancelled) return;
        if (data.error) { fail(data.error); return; }
        if (exportPath) {
          try { await exportResponseFile(exportPath, { format: "csv", body: data.result.csv }); }
          catch (error) { if (!cancelled) setExportError(String(error.message || error)); }
          finally { if (!cancelled) { setExportPath(""); setBusy(false); } }
        } else { setResult(data.result); setBusy(false); }
      };
      worker.postMessage({ mode: exportPath ? "csv" : mode, body, bodyBase64: mode === "Hex" ? response.bodyBase64 : "", pointer, query, caseSensitive, page });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(deadline); worker?.terminate(); };
  }, [mode, body, response.bodyBase64, pointer, query, caseSensitive, page, exportPath]);

  async function exportCsv() {
    setExportError("");
    try { const path = await save({ defaultPath: "response.csv", filters: [{ name: "CSV", extensions: ["csv"] }] }); if (typeof path === "string") setExportPath(path); }
    catch (error) { setExportError(String(error.message || error)); }
  }
  return <div className="flex min-h-0 flex-col" aria-label={`${mode} response view`}>
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      {mode === "Table" && <><Input className="h-8 min-w-0 flex-1" aria-label="Table JSON pointer" value={pointer} onChange={(event) => setPointer(event.target.value)} placeholder="JSON path: /items (empty for root)" /><Button size="icon" variant="ghost" title="Export all rows to CSV" aria-label="Export all rows to CSV" disabled={busy || !result?.columns?.length} onClick={exportCsv}><Download className="h-4 w-4" /></Button></>}
      {mode === "Search" && <><Input className="h-8 min-w-0 flex-1" aria-label="Search full response body" placeholder="Find in full response body..." value={query} onChange={(event) => setQuery(event.target.value)} /><label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />Match case</label></>}
      {mode !== "Search" && <div className="flex items-center gap-2"><Button variant="ghost" size="icon" aria-label="Previous page" disabled={busy || page === 0} onClick={() => setPage((page) => page - 1)}><ChevronLeft className="h-4 w-4" /></Button><span>{page + 1} / {result?.pages || 1}</span><Button variant="ghost" size="icon" aria-label="Next page" disabled={busy || !result || page + 1 >= result.pages} onClick={() => setPage((page) => page + 1)}><ChevronRight className="h-4 w-4" /></Button></div>}
    </div>
    {(error || exportError) && <p role="alert" className="mb-2 text-xs text-destructive">{error || exportError}</p>}
    {busy && <div role="status" className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />{exportPath ? "Exporting..." : "Inspecting..."}</div>}
    {result && <div className="thin-scrollbar min-h-0 flex-1 overflow-auto text-xs">
      {mode === "Table" && <><p className="mb-2 text-muted-foreground">{result.count} rows</p><table className="w-full border-collapse text-left"><thead className="sticky top-0 bg-background"><tr>{result.columns.map((column) => <th key={column} className="border-b border-border/40 px-3 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className="max-w-sm border-b border-border/20 px-3 py-2 align-top"><div className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{cell}</div></td>)}</tr>)}</tbody></table></>}
      {mode === "Search" && <><p className="mb-2 text-muted-foreground">{result.count} matches{result.count > 200 ? " (first 200 shown)" : ""}</p>{result.matches.map((match) => <div key={match.offset} className="border-b border-border/20 py-3"><span className="text-muted-foreground">Character {match.offset + 1}</span><pre className="mt-1 whitespace-pre-wrap break-all font-mono">{match.before}<mark className="bg-primary/20 text-foreground">{match.match}</mark>{match.after}</pre></div>)}</>}
      {mode === "Hex" && <><p className="mb-2 text-muted-foreground">{result.bytes} bytes</p><table className="whitespace-pre font-mono"><thead><tr><th className="pr-4 text-left">Offset</th><th className="pr-4 text-left">Hex</th><th className="text-left">ASCII</th></tr></thead><tbody>{result.lines.map((line) => <tr key={line.offset}><td className="pr-4 text-muted-foreground">{line.offset}</td><td className="pr-4">{line.hex}</td><td>{line.ascii}</td></tr>)}</tbody></table></>}
    </div>}
  </div>;
}
