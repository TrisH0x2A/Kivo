import { useEffect, useRef, useState } from "react";
import { Check, FileUp, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { SelectMenu } from "./SelectMenu.jsx";
import { CodeEditor } from "./CodeEditor.jsx";
import { buildResponseJsonSchema } from "@/lib/api-design.js";
import { validateContract } from "@/lib/contract-client.js";
import { openApiOperations, parseOpenApi, planOpenApiSync } from "@/lib/openapi-contract.js";

export function RequestContractPanel({ request, onChange, response }) {
  const contract = request.contract || {};
  const savedResponse = response || request.lastResponse;
  const hasResponse = Boolean(savedResponse?.status && !savedResponse.isBinary);
  const responseStatus = String(savedResponse?.status || "");
  const initialStatus = [responseStatus, `${responseStatus[0]}XX`, "default", ...Object.keys(contract.responses || {})].find((key) => Object.hasOwn(contract.responses || {}, key)) || "default";
  const [status, setStatus] = useState(initialStatus);
  const [draft, setDraft] = useState(JSON.stringify(contract.responses?.[initialStatus] ?? {}, null, 2));
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [spec, setSpec] = useState(null);
  const [operation, setOperation] = useState("");
  const [plan, setPlan] = useState(null);
  const fileRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setResult(null); }, [savedResponse?.rawBody, savedResponse?.body, savedResponse?.status]);

  function readSchema() {
    const schema = JSON.parse(draft);
    if (schema === null || (typeof schema !== "boolean" && (typeof schema !== "object" || Array.isArray(schema)))) throw new Error("Enter a JSON Schema object or boolean.");
    return schema;
  }
  function saveSchema() {
    try {
      if (!/^(default|[1-5](\d{2}|XX))$/.test(status)) throw new Error("Use a status code, status range such as 2XX, or default.");
      const schema = readSchema();
      onChange("contract", { ...contract, responses: { ...contract.responses, [status]: schema } });
      setError(""); setResult({ ok: true, errors: [], label: "Contract saved" });
    } catch (error) { setError(error.message); }
  }
  async function checkResponse() {
    setError(""); setResult(null);
    try {
      const schema = readSchema();
      if (!savedResponse || savedResponse.isBinary) throw new Error("A JSON response is required.");
      const value = JSON.parse(savedResponse.rawBody ?? savedResponse.body);
      setBusy(true);
      const checked = await validateContract(value, schema);
      if (mounted.current) setResult({ ...checked, label: `Response ${savedResponse.status || ""} ${checked.ok ? "matches" : "does not match"}` });
    } catch (error) { if (mounted.current) setError(error.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function loadSpec(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPlan(null); setSpec(null); setError("");
    try {
      if (file.size > 2_000_000) throw new Error("OpenAPI documents must be smaller than 2 MB.");
      const parsed = parseOpenApi(await file.text());
      const operations = openApiOperations(parsed);
      if (!operations.length) throw new Error("No operations found.");
      if (mounted.current) { setSpec(parsed); setOperation(operations.some((item) => item.value === contract.source?.operation) ? contract.source.operation : operations[0].value); }
    } catch (error) { if (mounted.current) setError(error.message); }
  }
  const editDraft = (text) => { setDraft(text); setResult(null); };
  return <div className="flex h-full min-h-0 flex-col overflow-auto thin-scrollbar">
    <div className="flex flex-wrap items-center gap-2 border-b border-border/30 px-3 py-3">
      <label className="text-xs text-muted-foreground" htmlFor="contract-status">Response</label>
      <Input id="contract-status" aria-label="Contract response status" className="h-8 w-24" value={status} onChange={(event) => { setStatus(event.target.value); setResult(null); }} />
      {Object.keys(contract.responses || {}).length > 0 && <SelectMenu value={Object.hasOwn(contract.responses, status) ? status : ""} options={[{ value: "", label: "Saved schemas" }, ...Object.keys(contract.responses).map((key) => ({ value: key, label: key }))]} onChange={(key) => { if (key) { setStatus(key); editDraft(JSON.stringify(contract.responses[key], null, 2)); } }} />}
      <div className="ml-auto flex flex-wrap gap-2">
        <Button className="gap-2" size="sm" variant="ghost" onClick={() => { try { editDraft(JSON.stringify(buildResponseJsonSchema(savedResponse.rawBody ?? savedResponse.body), null, 2)); setError(""); } catch (error) { setError(error.message); } }} disabled={!hasResponse}>Infer response</Button>
        <Button className="gap-2" size="sm" variant="outline" onClick={saveSchema}><Save className="h-3.5 w-3.5" />Save</Button>
        <Button size="icon" variant="ghost" aria-label="Remove saved response schema" title="Remove saved response schema" disabled={!Object.hasOwn(contract.responses || {}, status)} onClick={() => { const responses = { ...contract.responses }; delete responses[status]; onChange("contract", { ...contract, responses }); setResult(null); }}><Trash2 className="h-3.5 w-3.5" /></Button>
        <Button className="gap-2" size="sm" onClick={checkResponse} disabled={busy || !hasResponse}><ShieldCheck className="h-3.5 w-3.5" />{busy ? "Checking..." : "Validate"}</Button>
      </div>
    </div>
    <div className="min-h-[220px] flex-1 basis-[260px]"><CodeEditor value={draft} onChange={editDraft} language="json" lineNumbers /></div>
    {(error || result) && <div role="status" className="max-h-36 shrink-0 overflow-auto border-t border-border/30 p-3 text-xs"><span className={error || !result?.ok ? "text-destructive" : "text-foreground"}>{error || result.label}</span>{result?.errors.map((message, index) => <div className="mt-1 break-words text-muted-foreground" key={index}>{message}</div>)}</div>}
    {(!request.requestMode || request.requestMode === "http") && <section className="shrink-0 space-y-3 border-t border-border/30 p-3">
      <div className="flex flex-wrap items-center gap-3"><h3 className="text-xs font-medium">OpenAPI synchronization</h3><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={contract.source?.operation}>{contract.source?.title} {contract.source?.operation}</span><Button className="gap-2" size="sm" variant="outline" onClick={() => fileRef.current?.click()}><FileUp className="h-3.5 w-3.5" />Load specification</Button><input ref={fileRef} type="file" accept=".json,.yaml,.yml" className="hidden" onChange={loadSpec} /></div>
      {spec && <div className="flex flex-wrap gap-2"><SelectMenu className="min-w-0 flex-1" value={operation} options={openApiOperations(spec)} onChange={(value) => { setOperation(value); setPlan(null); }} /><Button className="gap-2" size="sm" variant="outline" onClick={() => { try { setPlan(planOpenApiSync(spec, operation, request)); setError(""); } catch (error) { setError(error.message); } }}><RefreshCw className="h-3.5 w-3.5" />Preview changes</Button></div>}
      {plan && <div className="space-y-2 border-t border-border/30 pt-3 text-xs"><div className="break-all font-mono">{plan.patch.method} {plan.patch.url}</div><div className="text-muted-foreground">Changed: {plan.changes.join(", ") || "none"}</div><div className="text-muted-foreground">Body, authentication, scripts, and existing parameter values remain unchanged.</div>{plan.warnings.map((warning) => <div key={warning} className="text-muted-foreground">{warning}</div>)}<Button className="gap-2" size="sm" onClick={() => { const fresh = planOpenApiSync(spec, operation, request); for (const [key, value] of Object.entries(fresh.patch)) onChange(key, value); const first = Object.keys(fresh.patch.contract.responses)[0] || "default"; setStatus(first); editDraft(JSON.stringify(fresh.patch.contract.responses[first] ?? {}, null, 2)); setPlan(null); }}><Check className="h-3.5 w-3.5" />Apply synchronization</Button></div>}
    </section>}
  </div>;
}
