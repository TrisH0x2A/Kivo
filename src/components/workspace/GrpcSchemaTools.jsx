import { useEffect, useRef, useState } from "react";
import { Braces, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { inspectGrpcMethod } from "@/lib/http-client.js";

export function GrpcSchemaTools({ request, onChange }) {
  const [schema, setSchema] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSchema((current) => current ? { ...current, validated: false } : null); }, [request.body]);
  async function inspect(check) {
    setBusy(true); setError("");
    try {
      const result = await inspectGrpcMethod(request.grpcProtoFilePath, request.grpcMethodPath, check ? request.body : null);
      if (alive.current) setSchema(result);
    } catch (error) { if (alive.current) setError(String(error)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="shrink-0 border-b border-border/30">
    <div className="flex flex-wrap items-center gap-2 px-3 py-2"><Button className="gap-2" size="sm" variant="ghost" onClick={() => inspect(false)} disabled={busy}><Braces className="h-3.5 w-3.5" />Message schema</Button><Button className="gap-2" size="sm" variant="ghost" onClick={() => inspect(true)} disabled={busy}><ShieldCheck className="h-3.5 w-3.5" />Validate message</Button>{schema && <Button className="gap-2" size="sm" variant="ghost" disabled={Boolean(request.body?.trim())} onClick={() => onChange("body", JSON.stringify(schema.example, null, 2))}>Insert example</Button>}</div>
    {error && <div role="alert" className="px-3 pb-2 text-xs text-destructive">{error}</div>}
    {schema && <details className="px-3 pb-2 text-xs" open><summary className="cursor-pointer break-all text-muted-foreground">{schema.inputType}</summary><div className="max-h-32 overflow-auto py-2 thin-scrollbar">{schema.fields.map((field) => <div key={field.name} className="grid grid-cols-2 gap-3 border-b border-border/20 py-1"><code className="break-all">{field.name}</code><span className="break-all text-muted-foreground">{field.type}{field.repeated ? "[]" : ""}{field.map ? " (map)" : ""}{field.oneof ? ` (oneof ${field.oneof})` : ""}</span></div>)}</div>{schema.validated && <p role="status" className={schema.validationError ? "text-destructive" : "text-muted-foreground"}>{schema.validationError || "Message matches descriptor"}</p>}</details>}
  </div>;
}
