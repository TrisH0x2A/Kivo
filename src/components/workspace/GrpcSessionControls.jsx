import { useEffect, useState } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Textarea } from "@/components/ui/textarea.jsx";
import { finishGrpcInput, sendGrpcMessage } from "@/lib/http-client.js";

export function GrpcSessionControls({ requestId, inputOpen, onCancel }) {
  const [body, setBody] = useState("{}");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  useEffect(() => { setFinished(false); setError(""); }, [requestId]);
  async function submit(finish) {
    setBusy(true);
    setError("");
    try {
      if (finish) { await finishGrpcInput(requestId); setFinished(true); }
      else { await sendGrpcMessage(requestId, body); }
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  return <div className="shrink-0 space-y-2 border-b border-border/40 px-3 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span className="text-primary" role="status">Live gRPC session</span>
      <Button size="sm" variant="ghost" onClick={onCancel}><Square className="h-3 w-3" /> Cancel</Button>
    </div>
    {inputOpen && !finished && <>
      <Textarea aria-label="Next gRPC message" value={body} onChange={(event) => setBody(event.target.value)} className="h-20 min-h-0 resize-y font-mono text-xs" />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => submit(false)}><SendHorizontal className="h-3 w-3" /> Send message</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => submit(true)}>Finish input</Button>
      </div>
    </>}
    {finished && <p className="text-xs text-muted-foreground">Input finished. Waiting for server.</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
