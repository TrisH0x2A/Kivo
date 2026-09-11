import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils.js";

export function SelectMenu({ value, options, onChange, className, renderValue, renderOption, buttonClassName, disabled = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    function handlePointer(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  return (
    <div ref={rootRef} className={cn("relative", open && !disabled && "z-[320]", className)}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
        }}
        disabled={disabled}
        className={cn(
          "kivo-field flex h-8 w-full items-center justify-between px-3 text-left text-[12px] text-foreground outline-none transition-colors hover:border-primary/30 hover:bg-input/80 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70",
          buttonClassName
        )}
      >
        <span className="truncate">{renderValue ? renderValue(selected) : selected.label}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !disabled && open && "rotate-180")} />
      </button>

      {open && !disabled ? (
        <div className="kivo-glass absolute left-0 top-[calc(100%+6px)] z-[330] min-w-full overflow-hidden p-1 shadow-xl">
          {options.map((option) => {
            const active = option.value === value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors",
                  active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                )}
              >
                {renderOption ? renderOption(option, active) : <span>{option.label}</span>}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
