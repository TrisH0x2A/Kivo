import { useEffect, useMemo, useRef, useState } from "react";
import { FlaskConical, X } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { appendRegressionScript, buildRegressionScript, getRegressionFields } from "@/lib/response-regression.js";

export function ResponseRegressionDialog({ response, existingScript, onAdd, onClose }) {
  const dialog = useRef(null);
  const fields = useMemo(() => getRegressionFields(response), [response]);
  const [status, setStatus] = useState(true);
  const [contentType, setContentType] = useState(true);
  const [selected, setSelected] = useState({});
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
  const { script, error } = useMemo(() => {
    try {
      const generated = buildRegressionScript(response, { status, contentType, fields: Object.entries(selected).map(([id, options]) => ({ id, ...options })) });
      appendRegressionScript(existingScript, generated);
      return { script: generated, error: "" };
    } catch (error) { return { script: "", error: error.message }; }
  }, [response, status, contentType, selected, existingScript]);
  function update(id, patch) { setSelected((current) => ({ ...current, [id]: { ...current[id], ...patch } })); }
  return <dialog ref={dialog} aria-labelledby="regression-title" onCancel={onClose} className="m-auto w-[min(900px,94vw)] max-w-none rounded border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50">
    <div className="flex max-h-[88dvh] min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 id="regression-title" className="text-sm font-semibold">Response to regression test</h2>
        <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close regression tests"><X className="h-4 w-4" /></Button>
      </header>
      <div className="thin-scrollbar min-h-0 overflow-auto p-5">
        <div className="mb-4 flex flex-wrap gap-5 text-xs">
          <label className="flex items-center gap-2"><input type="checkbox" checked={status} onChange={(event) => setStatus(event.target.checked)} />Status {response.status}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={contentType} onChange={(event) => setContentType(event.target.checked)} />Content type</label>
        </div>
        {fields.length > 0 && <><p className="mb-2 text-xs text-muted-foreground">JSON fields (up to 50; first item of each array)</p>
          <div className="divide-y divide-border border-y border-border">
            {fields.map((field) => <div key={field.id} className="flex flex-wrap items-center gap-3 py-2 text-xs">
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input type="checkbox" checked={Boolean(selected[field.id])} onChange={(event) => {
                  if (event.target.checked) update(field.id, { mode: "type", min: field.value, max: field.value });
                  else setSelected((current) => { const next = { ...current }; delete next[field.id]; return next; });
                }} />
                <span className="break-all font-mono">{field.label}</span><span className="text-muted-foreground">{field.type}</span>
              </label>
              {selected[field.id] && <select aria-label={`Assertion for ${field.label}`} className="h-8 rounded-sm border border-border bg-background px-2" value={selected[field.id].mode} onChange={(event) => update(field.id, { mode: event.target.value })}>
                <option value="type">Type</option>
                {!field.sensitive && !["object", "array"].includes(field.type) && <option value="value">Exact value</option>}
                {field.type === "number" && <option value="range">Range</option>}
              </select>}
              {selected[field.id]?.mode === "range" && <div className="flex gap-2">
                {['min', 'max'].map((bound) => <input key={bound} aria-label={`${bound} for ${field.label}`} type="number" step="any" className="h-8 w-24 rounded-sm border border-border bg-background px-2" value={selected[field.id][bound]} onChange={(event) => update(field.id, { [bound]: event.target.value })} />)}
              </div>}
            </div>)}
          </div></>}
        <h3 className="mb-2 mt-4 text-xs font-medium">After-response script</h3>
        <pre className="thin-scrollbar max-h-64 overflow-auto border border-border p-3 font-mono text-xs leading-5">{script || "No assertions selected."}</pre>
        {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs">
        <span className="text-muted-foreground">Existing scripts are preserved.</span>
        <Button size="sm" disabled={Boolean(error) || !script} onClick={() => onAdd(script)}><FlaskConical className="mr-2 h-4 w-4" />Add assertions</Button>
      </footer>
    </div>
  </dialog>;
}
