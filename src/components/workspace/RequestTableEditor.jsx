import { useEffect, useState } from "react";
import { FilePlus2, PenLine, Plus, Table2, Trash2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { cn } from "@/lib/utils.js";

function createRow() {
  return { id: `row-${Math.random().toString(36).slice(2, 8)}`, key: "", value: "", enabled: true };
}

export function TableEditor({
  rows,
  onChange,
  title,
  addLabel,
  keyLabel = "name",
  valueLabel = "value",
  disabled = false,
  allowFileRows = false
}) {
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [bulkText, setBulkText] = useState("");

  function updateRow(index, field, value) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  function addRow() {
    onChange([...rows, createRow()]);
  }

  async function chooseRowFile(index) {
    try {
      const selected = await open({ directory: false, multiple: false });
      if (typeof selected === "string") {
        onChange(rows.map((row, i) => (
          i === index ? { ...row, fieldType: "file", filePath: selected, value: selected } : row
        )));
      }
    } catch {
    }
  }

  function removeRow(index) {
    onChange(rows.filter((_, i) => i !== index));
  }

  function clearRows() {
    onChange([]);
  }

  useEffect(() => {
    if (isBulkMode) {
      setBulkText(
        rows
          .filter((row) => row.key.trim() || row.value.trim())
          .map((row) => `${row.enabled ? "" : "// "}${row.key}: ${row.value}`)
          .join("\n")
      );
    }
  }, [isBulkMode, rows]);

  function handleBulkChange(event) {
    const text = event.target.value;
    setBulkText(text);

    const parsedRows = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return null;

        const isEnabled = !trimmed.startsWith("//");
        const activeLine = isEnabled ? trimmed : trimmed.replace(/^\/\/\s*/, "");

        const colonIdx = activeLine.indexOf(":");
        const eqIdx = activeLine.indexOf("=");

        let sepIdx = -1;
        if (colonIdx !== -1 && eqIdx !== -1) sepIdx = Math.min(colonIdx, eqIdx);
        else if (colonIdx !== -1) sepIdx = colonIdx;
        else if (eqIdx !== -1) sepIdx = eqIdx;

        let key = activeLine;
        let value = "";
        if (sepIdx !== -1) {
          key = activeLine.slice(0, sepIdx).trim();
          value = activeLine.slice(sepIdx + 1).trim();
        }

        return { id: `row-${Math.random().toString(36).slice(2, 8)}`, key, value, enabled: isEnabled };
      })
      .filter(Boolean);

    onChange(parsedRows);
  }

  const activeCount = rows.filter((row) => row.enabled && row.key.trim()).length;
  const gridColumns = allowFileRows
    ? "grid-cols-[32px_minmax(0,1fr)_84px_minmax(0,1fr)_36px]"
    : "grid-cols-[32px_minmax(0,1fr)_minmax(0,1fr)_36px]";

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-card/35">
      <div className="flex items-center justify-between gap-3 border-b border-border/15 bg-card/70 px-3 py-2 text-[11px] text-muted-foreground lg:text-[12px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{title}</span>
          <span className="shrink-0 rounded-sm bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-primary">
            {activeCount} active
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsBulkMode(!isBulkMode)}
            disabled={disabled}
            className="inline-flex h-7 items-center gap-1.5 px-2 text-muted-foreground transition-colors hover:bg-card/45 hover:text-foreground disabled:opacity-40"
          >
            {isBulkMode ? (
              <>
                <Table2 className="h-3 w-3" />
                Key-Value
              </>
            ) : (
              <>
                <PenLine className="h-3 w-3" />
                Bulk
              </>
            )}
          </button>
          <button
            type="button"
            onClick={addRow}
            disabled={disabled || isBulkMode}
            className={cn("inline-flex h-7 items-center gap-1 px-2 text-muted-foreground transition-colors hover:bg-card/45 hover:text-foreground disabled:opacity-40", isBulkMode && "hidden")}
          >
            <Plus className="h-3.5 w-3.5" />
            {addLabel}
          </button>
          <button
            type="button"
            onClick={clearRows}
            disabled={disabled}
            className="inline-flex h-7 items-center px-2 text-muted-foreground transition-colors hover:bg-card/45 hover:text-foreground disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      {isBulkMode ? (
        <div className="relative min-h-0 overflow-hidden">
          <textarea
            value={bulkText}
            onChange={handleBulkChange}
            disabled={disabled}
            placeholder="key: value&#10;key2=value2"
            spellCheck={false}
            className="thin-scrollbar h-full w-full resize-none overflow-auto border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      ) : (
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <div className={cn("grid border-b border-border/12 px-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground lg:text-[11px]", gridColumns)}>
            <div className="px-2 py-2"></div>
            <div className="px-2 py-2">{keyLabel}</div>
            {allowFileRows ? <div className="px-2 py-2">Kind</div> : null}
            <div className="px-2 py-2">{valueLabel}</div>
            <div className="px-2 py-2"></div>
          </div>
          <div className="thin-scrollbar min-h-0 overflow-auto">
            {rows.length > 0 ? (
              rows.map((row, index) => (
                <div key={row.id || `row-${index}`} className={cn("grid px-1 transition-colors hover:bg-card/35", gridColumns)}>
                  <label className="flex items-center justify-center">
                    <input disabled={disabled} type="checkbox" checked={row.enabled ?? true} onChange={(event) => updateRow(index, "enabled", event.target.checked)} />
                  </label>
                  <Input disabled={disabled} className="h-10 border-0 bg-transparent text-[12px] focus-visible:ring-0 lg:text-[14px]" value={row.key} onChange={(event) => updateRow(index, "key", event.target.value)} placeholder={keyLabel} />
                  {allowFileRows ? (
                    <button
                      type="button"
                      disabled={disabled}
                      className="my-1 bg-card/35 px-2 text-[10px] text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground disabled:opacity-40"
                      onClick={() => updateRow(index, "fieldType", row.fieldType === "file" ? "text" : "file")}
                    >
                      {row.fieldType === "file" ? "File" : "Text"}
                    </button>
                  ) : null}
                  <div className="flex min-w-0 items-center">
                    <Input
                      disabled={disabled}
                      className="h-10 min-w-0 flex-1 border-0 bg-transparent text-[12px] focus-visible:ring-0 lg:text-[14px]"
                      value={row.fieldType === "file" ? (row.filePath || row.value || "") : row.value}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (row.fieldType === "file") {
                          onChange(rows.map((entry, i) => (i === index ? { ...entry, filePath: value, value } : entry)));
                        } else {
                          updateRow(index, "value", value);
                        }
                      }}
                      placeholder={row.fieldType === "file" ? "File path" : valueLabel}
                    />
                    {allowFileRows && row.fieldType === "file" ? (
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => chooseRowFile(index)} disabled={disabled}>
                        <FilePlus2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                  <button type="button" disabled={disabled} className="flex items-center justify-center text-muted-foreground transition-colors hover:bg-card/45 hover:text-foreground disabled:opacity-40" onClick={() => removeRow(index)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            ) : (
              <div className="flex h-full min-h-[150px] flex-col items-center justify-center bg-background/10 px-4 py-8 text-center text-muted-foreground/70">
                <p className="text-[11px] uppercase tracking-[0.14em]">No {title.toLowerCase()} defined</p>
                <button
                  type="button"
                  onClick={addRow}
                  className="mt-3 bg-card/40 px-3 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-card/70"
                >
                  Add {keyLabel}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
