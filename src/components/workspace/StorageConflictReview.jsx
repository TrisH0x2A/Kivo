import { useState } from "react";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";

export function StorageConflictReview({ title = "External changes detected", review, onResolve }) {
  const [choices, setChoices] = useState({});
  const [expanded, setExpanded] = useState(false);
  return <section aria-label={title} className="shrink-0 border-b border-primary/30 bg-background px-4 py-3 text-xs">
    <div className="flex flex-wrap items-center gap-3"><GitMerge className="h-4 w-4 text-primary" /><strong>{title}</strong><span className="text-muted-foreground">{review.changes.length} independent changes, {review.conflicts.length} conflicts. Saving paused.</span><Button variant="outline" size="sm" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? "Hide review" : "Review changes"}</Button></div>
    {expanded && <div className="mt-3 max-h-64 space-y-2 overflow-auto thin-scrollbar">
      {review.changes.map((change) => <p className="break-all text-muted-foreground" key={change.path}>{change.kind}: {change.path}</p>)}
      {review.conflicts.map((conflict) => <div key={conflict.path} className="space-y-2 border-t border-border/30 py-2">
        <p className="break-all font-mono">{conflict.path}</p>
        <div className="flex gap-4">{["local", "remote"].map((choice) => <label className="flex items-center gap-2" key={choice}><input type="radio" name={`conflict-${conflict.path}`} className="accent-primary" checked={choices[conflict.path] === choice} onChange={() => setChoices((previous) => ({ ...previous, [conflict.path]: choice }))} />{choice === "local" ? "Keep local" : "Use disk"}</label>)}</div>
        <details className="text-muted-foreground"><summary className="cursor-pointer">Compare values (may contain secrets)</summary><div className="grid gap-3 py-2 sm:grid-cols-2">{["local", "remote"].map((choice) => <div className="min-w-0" key={choice}><p>{choice === "local" ? "Local" : "Disk"}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(conflict[choice], null, 2) ?? "Deleted"}</pre></div>)}</div></details>
      </div>)}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={review.conflicts.some((item) => !choices[item.path])} onClick={() => onResolve("merge", choices)}>Apply reviewed merge</Button><Button size="sm" variant="outline" onClick={() => onResolve("remote")}>Use disk version</Button><Button size="sm" variant="outline" onClick={() => onResolve("local")}>Keep local version</Button></div>
    </div>}
  </section>;
}
