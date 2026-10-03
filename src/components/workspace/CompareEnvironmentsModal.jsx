import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitCompareArrows, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { SelectMenu } from "./SelectMenu.jsx";
import { DEFAULT_COMPARISON_RULES, normalizeComparisonRules, saveComparisonProfile } from "@/lib/comparison-rules.js";

function Differences({ title, diff }) {
  if (!diff) return null;
  return <section className="min-w-0 border-t border-border/40 pt-3">
    <h3 className="mb-2 text-xs font-medium">{title} <span className="text-muted-foreground">{diff.changed ? "Changed" : "Match"}</span></h3>
    {diff.entries.map((entry) => <div key={entry.path} className="grid gap-2 border-b border-border/25 py-2 text-xs sm:grid-cols-3">
      <span className="break-all font-mono">{entry.path}</span><span className="break-all text-muted-foreground">{entry.left}</span><span className="break-all">{entry.right}</span>
    </div>)}
    {diff.truncated && <p className="mt-2 text-xs text-muted-foreground">First 80 differences shown.</p>}
  </section>;
}

export function CompareEnvironmentsModal({ open, request, environments, loading, running, result, error, onRun, onClose, onProfilesChange }) {
  const dialog = useRef(null);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [allowMutation, setAllowMutation] = useState(false);
  const [rules, setRules] = useState(DEFAULT_COMPARISON_RULES);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [notice, setNotice] = useState("");
  const [ruleError, setRuleError] = useState("");
  const profiles = request?.comparisonProfiles || [];
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    node.showModal(); setAllowMutation(false);
    return () => node.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setLeftId(environments[0]?.id || ""); setRightId(environments[1]?.id || "");
  }, [open, environments]);
  const readOnly = ["GET", "HEAD", "OPTIONS"].includes(String(request?.method || "GET").toUpperCase());
  const canRun = leftId && rightId && leftId !== rightId && !running && (readOnly || allowMutation);
  const edit = (key, value) => { setRules((current) => ({ ...current, [key]: value })); setNotice(""); setRuleError(""); };
  const pickProfile = (id) => {
    try {
      const profile = profiles.find((item) => item.id === id);
      setRules(normalizeComparisonRules(profile?.rules)); setProfileId(id); setProfileName(profile?.name || ""); setRuleError(""); setNotice("");
    } catch (error) { setRuleError(error.message); }
  };
  const saveProfile = () => {
    try {
      const saved = saveComparisonProfile(profiles, { id: profileId, name: profileName, rules });
      onProfilesChange(saved.profiles); setProfileId(saved.profile.id); setNotice("Profile saved"); setRuleError("");
    } catch (error) { setRuleError(error.message); }
  };
  const run = () => {
    try { const normalized = normalizeComparisonRules(rules); setRuleError(""); onRun(leftId, rightId, normalized); }
    catch (error) { setRuleError(error.message); }
  };
  if (!open) return null;
  return createPortal(<dialog ref={dialog} aria-labelledby="compare-title" onCancel={(event) => { event.preventDefault(); if (!running) onClose(); }} className="m-auto h-[min(820px,94dvh)] max-h-none w-[min(1040px,96vw)] max-w-none overflow-hidden rounded border border-border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/50">
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
      <header className="flex items-center gap-3 border-b border-border/50 px-5 py-4"><GitCompareArrows className="h-4 w-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><h2 id="compare-title" className="text-base font-semibold">Compare environments</h2><p className="truncate text-xs text-muted-foreground">{request?.name}</p></div><Button size="icon" variant="ghost" aria-label="Close environment comparison" disabled={running} onClick={onClose}><X className="h-4 w-4" /></Button></header>
      <div className="thin-scrollbar min-h-0 overflow-auto p-5">
        {loading && <p role="status" className="text-xs">Loading environments...</p>}
        {!loading && environments.length < 2 && <p className="text-xs text-muted-foreground">Two workspace environments are required.</p>}
        <fieldset disabled={running || loading} className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">{[{ label: "Baseline environment", value: leftId, onChange: setLeftId }, { label: "Comparison environment", value: rightId, onChange: setRightId }].map((side) => <div key={side.label} className="grid min-w-0 gap-2"><span className="text-xs text-muted-foreground">{side.label}</span><SelectMenu ariaLabel={side.label} value={side.value} onChange={side.onChange} options={environments.map(({ id, name }) => ({ value: id, label: name }))} disabled={running || loading} constrainWidth /></div>)}</div>
          {!readOnly && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={allowMutation} onChange={(event) => setAllowMutation(event.target.checked)} />Allow this {request?.method} request to change data in both environments.</label>}
          <div className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-4">
            <div className="min-w-[150px] flex-1"><SelectMenu ariaLabel="Comparison profile" value={profileId} onChange={pickProfile} options={[{ value: "", label: "Unsaved rules" }, ...profiles.map(({ id, name }) => ({ value: id, label: name }))]} disabled={running} constrainWidth /></div>
            <Input aria-label="Profile name" className="h-8 min-w-0 flex-1" maxLength={80} placeholder="Profile name" value={profileName} onChange={(event) => { setProfileName(event.target.value); setNotice(""); }} />
            <Button size="icon" variant="ghost" aria-label="Save comparison profile" title="Save comparison profile" onClick={saveProfile}><Save className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" aria-label="Delete comparison profile" title="Delete comparison profile" disabled={!profileId} onClick={() => { onProfilesChange(profiles.filter((item) => item.id !== profileId)); pickProfile(""); setNotice("Profile removed"); }}><Trash2 className="h-4 w-4" /></Button>
            {notice && <span role="status" className="text-xs text-muted-foreground">{notice}</span>}
          </div>
          <details className="border-b border-border/40 pb-4" open>
            <summary className="cursor-pointer text-xs font-medium">Comparison rules</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-xs text-muted-foreground">Ignored JSON paths<textarea aria-label="Ignored JSON paths" className="thin-scrollbar min-h-20 resize-y rounded border border-border bg-input p-2 font-mono text-foreground focus:outline-primary" placeholder={"/timestamp\n/items/*/updatedAt"} value={rules.ignorePaths.join("\n")} onChange={(event) => edit("ignorePaths", event.target.value.split("\n"))} /></label>
              <div className="grid content-start gap-3"><label className="grid gap-2 text-xs text-muted-foreground">Absolute tolerance<Input aria-label="Absolute tolerance" type="number" min="0" step="any" value={rules.absoluteTolerance} onChange={(event) => edit("absoluteTolerance", event.target.value)} /></label><label className="grid gap-2 text-xs text-muted-foreground">Relative tolerance (fraction)<Input aria-label="Relative tolerance" type="number" min="0" step="any" value={rules.relativeTolerance} onChange={(event) => edit("relativeTolerance", event.target.value)} /></label></div>
              <section className="min-w-0 sm:col-span-2"><div className="mb-2 flex items-center justify-between gap-2 text-xs"><h3>Match array items by key</h3><Button size="icon" variant="ghost" title="Add array matching rule" aria-label="Add array matching rule" onClick={() => edit("arrayKeys", [...rules.arrayKeys, { path: "", key: "id" }])}><Plus className="h-4 w-4" /></Button></div>{rules.arrayKeys.map((rule, index) => <div key={index} className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2"><Input aria-label={`Array path ${index + 1}`} placeholder="/items (blank = root)" value={rule.path} onChange={(event) => edit("arrayKeys", rules.arrayKeys.map((row, i) => i === index ? { ...row, path: event.target.value } : row))} /><Input aria-label={`Array key ${index + 1}`} placeholder="id" value={rule.key} onChange={(event) => edit("arrayKeys", rules.arrayKeys.map((row, i) => i === index ? { ...row, key: event.target.value } : row))} /><Button size="icon" variant="ghost" aria-label={`Remove array rule ${index + 1}`} onClick={() => edit("arrayKeys", rules.arrayKeys.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button></div>)}</section>
              <div className="space-y-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rules.compareHeaders} onChange={(event) => edit("compareHeaders", event.target.checked)} />Compare response headers</label>{rules.compareHeaders && <Input aria-label="Ignored response headers" placeholder="date, x-request-id" value={rules.ignoreHeaders.join(",")} onChange={(event) => edit("ignoreHeaders", event.target.value.split(","))} />}</div>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={rules.validateContracts} onChange={(event) => edit("validateContracts", event.target.checked)} />Validate both response contracts</label>
            </div>
          </details>
        </fieldset>
        {(error || ruleError) && <p role="alert" className="my-3 break-words text-xs text-destructive">{ruleError || error}</p>}
        {result && <section className="mt-4 space-y-4" aria-label="Comparison results">
          <div className="text-xs font-medium" role="status">{!result.diff ? "Comparison incomplete" : result.diff.statusChanged || result.diff.body.changed || result.diff.headers?.changed ? "Response differences found" : "Responses match the applied rules"}{result.contracts?.some((item) => !item.ok) ? " / Contract checks failed" : ""}</div>
          <div className="grid gap-4 sm:grid-cols-2">{["left", "right"].map((side, index) => { const response = result[side]; const checked = result.contracts?.[index]; return <div key={side} className="min-w-0"><div className="flex flex-wrap items-center justify-between gap-2 text-xs"><h3 className="font-medium">{environments.find((item) => item.id === result[`${side}Id`])?.name || side}</h3><span>{response?.status || "Failed"} {response?.statusText} {response?.durationMs != null ? `/ ${response.durationMs} ms` : ""}</span></div><pre className="thin-scrollbar mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{String(response?.error || (response?.isBinary ? "Binary response" : response?.body) || "(empty body)").slice(0, 6000)}</pre>{checked && <div className="mt-2 text-xs"><span>{checked.ok ? "Contract passed" : "Contract failed"}</span>{checked.errors.map((message, i) => <p className="mt-1 break-all text-muted-foreground" key={i}>{message}</p>)}</div>}</div>; })}</div>
          <Differences title={`${result.diff?.body.mode || "Body"} body`} diff={result.diff?.body} />
          <Differences title="Response headers" diff={result.diff?.headers} />
        </section>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 px-5 py-3"><span className="text-xs text-muted-foreground">Comparison uses saved auth. Request scripts are not run.</span><Button size="sm" className="gap-2" disabled={!canRun} onClick={run}><GitCompareArrows className="h-4 w-4" />{running ? "Comparing..." : "Run comparison"}</Button></footer>
    </div>
  </dialog>, document.body);
}
