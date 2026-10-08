import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ArchiveRestore, Download, FileCheck2, FolderOpen, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { restoreStorageSnapshot } from "@/lib/http-client.js";

export function BackupRecoveryPanel() {
  const [entries, setEntries] = useState([]);
  const [password, setPassword] = useState("");
  const [filePath, setFilePath] = useState("");
  const [selection, setSelection] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    invoke("list_recovery_snapshots").then((rows) => { if (active) setEntries(rows); }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, []);

  async function run(label, action) {
    setBusy(label); setError(""); setMessage("");
    try { await action(); } catch (reason) { setError(String(reason?.message || reason)); }
    finally { setBusy(""); }
  }

  function resetPreview() { setSelection(null); setConfirmed(false); }

  async function exportBackup() {
    const path = await save({ defaultPath: "kivo-workspaces.kivobak", filters: [{ name: "Encrypted Kivo backup", extensions: ["kivobak"] }] });
    if (!path) return;
    await invoke("create_workspace_backup", { filePath: path, password });
    setMessage("Encrypted backup saved.");
  }

  async function chooseBackup() {
    const path = await open({ multiple: false, filters: [{ name: "Encrypted Kivo backup", extensions: ["kivobak"] }] });
    if (typeof path === "string") { setFilePath(path); resetPreview(); }
  }

  async function verifyBackup() {
    resetPreview();
    const preview = await invoke("preview_workspace_backup", { filePath, password });
    setSelection({ kind: "backup", filePath, preview });
  }

  async function previewSnapshot(id) {
    resetPreview();
    const preview = await invoke("preview_recovery_snapshot", { id });
    setSelection({ kind: "snapshot", id, preview });
  }

  async function restore() {
    if (!selection || !confirmed) return;
    const { preview, kind } = selection;
    await restoreStorageSnapshot(kind, {
      ...(kind === "backup" ? { filePath: selection.filePath, password } : { id: selection.id }),
      expectedDigest: preview.digest, expectedRevision: preview.storageRevision,
    });
    window.location.reload();
  }

  return (
    <div className="min-w-0 space-y-7 text-[12px]" aria-label="Backup and recovery" aria-busy={Boolean(busy)}>
      <section className="space-y-4 border-b border-border/30 pb-6">
        <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Encrypted workspace backup</h3></div>
        <p className="max-w-2xl text-muted-foreground">Saved requests, environments, and collection settings. App preferences, execution history, cookies, external files, and Git history are not included.</p>
        <div className="flex max-w-2xl flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 space-y-1.5">
            <span>Backup password</span>
            <Input type="password" autoComplete="new-password" value={password} disabled={Boolean(busy)} onChange={(event) => { setPassword(event.target.value); resetPreview(); }} placeholder="At least 12 characters to export" />
          </label>
          <Button variant="outline" disabled={Boolean(busy) || [...password].length < 12} onClick={() => run("Exporting backup", exportBackup)}><Download className="mr-2 h-3.5 w-3.5" />Export backup</Button>
        </div>
        <div className="flex max-w-2xl flex-wrap items-center gap-2">
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => run("Choosing backup", chooseBackup)}><FolderOpen className="mr-2 h-3.5 w-3.5" />Choose backup</Button>
          <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground">{filePath || "No backup selected"}</span>
          <Button variant="outline" disabled={Boolean(busy) || !filePath || !password} onClick={() => run("Verifying backup", verifyBackup)}><FileCheck2 className="mr-2 h-3.5 w-3.5" />Verify</Button>
        </div>
      </section>

      {selection && <section className="space-y-3 border-l-2 border-primary pl-4" aria-label="Restore preview">
        <h3 className="text-sm font-semibold">{selection.kind === "backup" ? "Verified backup" : "Retained files"}</h3>
        <p className="text-muted-foreground">{selection.preview.files.length} files; {selection.preview.overwriteCount} existing paths will be replaced. Other files remain unchanged.</p>
        {selection.preview.createdAt && <p className="text-muted-foreground">{new Date(selection.preview.createdAt).toLocaleString()}</p>}
        <ul className="thin-scrollbar max-h-48 overflow-auto border-y border-border/30 py-2 font-mono text-[11px]" aria-label="Files to restore">
          {selection.preview.files.map((path) => <li className="break-all py-1" key={path}>{path}</li>)}
        </ul>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 accent-primary" checked={confirmed} disabled={Boolean(busy)} onChange={(event) => setConfirmed(event.target.checked)} />Replace these files and reload Kivo. Unsaved edits will be discarded.</label>
        <div className="flex gap-2">
          <Button disabled={Boolean(busy) || !confirmed || !selection.preview.files.length} onClick={() => run("Restoring files", restore)}><ArchiveRestore className="mr-2 h-3.5 w-3.5" />Restore files</Button>
          <Button variant="ghost" disabled={Boolean(busy)} onClick={resetPreview}>Cancel</Button>
        </div>
      </section>}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Retained saves and deletions</h3><Button size="icon" variant="ghost" title="Refresh retained files" aria-label="Refresh retained files" disabled={Boolean(busy)} onClick={() => run("Refreshing retained files", async () => setEntries(await invoke("list_recovery_snapshots")))}><RefreshCw className="h-4 w-4" /></Button></div>
        {entries.length ? <ul className="divide-y divide-border/30 border-y border-border/30">
          {entries.map((entry) => <li className="flex flex-wrap items-center gap-3 py-3" key={entry.id}>
            <div className="min-w-0 flex-1"><div>{new Date(entry.createdAt).toLocaleString()}</div><div className="mt-1 text-[11px] text-muted-foreground">{entry.replacedFiles} previous files / {entry.deletedItems} deleted items</div></div>
            <Button variant="outline" size="sm" disabled={Boolean(busy) || !(entry.replacedFiles + entry.deletedItems)} onClick={() => run("Reading retained files", () => previewSnapshot(entry.id))}>Preview</Button>
          </li>)}
        </ul> : <p className="border-y border-border/30 py-6 text-muted-foreground">No retained saves or deletions.</p>}
      </section>
      {busy && <p role="status" className="text-muted-foreground">{busy}...</p>}
      {message && <p role="status" className="text-primary">{message}</p>}
      {error && <p role="alert" className="break-words text-[hsl(var(--danger))]">{error}</p>}
    </div>
  );
}
