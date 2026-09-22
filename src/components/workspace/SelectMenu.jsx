import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils.js";

export function SelectMenu({ value, options, onChange, className, renderValue, renderOption, buttonClassName, disabled = false, ariaLabel, constrainWidth = false }) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0] ?? { label: "No options" };
  const unavailable = disabled || !options.length;

  function closeAndFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function showOptions(index = Math.max(0, options.findIndex((option) => option.value === value))) {
    if (unavailable) return;
    setFocusedIndex(index);
    setOpen(true);
  }

  function handleKeyDown(event) {
    if (unavailable) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const last = options.length - 1;
      if (event.key === "Home") showOptions(0);
      else if (event.key === "End") showOptions(last);
      else if (!open) showOptions();
      else setFocusedIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    }
  }

  useEffect(() => {
    if (open && !unavailable) rootRef.current?.querySelectorAll('[role="option"]')[focusedIndex]?.focus();
  }, [open, focusedIndex, unavailable]);

  useEffect(() => {
    if (!open) return;
    function handlePointer(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointer);

    return () => {
      document.removeEventListener("mousedown", handlePointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} onKeyDown={handleKeyDown} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} className={cn("relative min-w-0", open && !unavailable && "z-[320]", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open && !unavailable}
        aria-controls={open && !unavailable ? listId : undefined}
        title={typeof selected.label === "string" ? selected.label : undefined}
        onClick={() => {
          if (open) setOpen(false);
          else showOptions();
        }}
        disabled={unavailable}
        className={cn(
          "kivo-select-trigger kivo-field flex h-8 w-full items-center justify-between gap-2 px-3 text-left text-[12px] text-foreground outline-none transition-colors hover:border-primary/30 hover:bg-input/80 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70",
          buttonClassName
        )}
      >
        <span className="truncate">{renderValue ? renderValue(selected) : selected.label}</span>
        <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !unavailable && open && "rotate-180")} />
      </button>

      {open && !unavailable ? (
        <div id={listId} role="listbox" aria-label={ariaLabel} className={cn("kivo-glass thin-scrollbar absolute left-0 top-[calc(100%+6px)] z-[330] max-h-64 overflow-y-auto p-1 shadow-xl", constrainWidth ? "kivo-bounded-select w-full" : "min-w-full")}>
          {options.map((option, index) => {
            const active = option.value === value;

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={focusedIndex === index ? 0 : -1}
                title={typeof option.label === "string" ? option.label : undefined}
                onFocus={() => setFocusedIndex(index)}
                onClick={() => {
                  onChange(option.value);
                  closeAndFocus();
                }}
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-2 px-3 py-2 text-left text-[12px] transition-colors",
                  active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                )}
              >
                {renderOption ? renderOption(option, active) : <><span className={constrainWidth ? "truncate" : undefined}>{option.label}</span>{active && <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-primary" />}</>}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
