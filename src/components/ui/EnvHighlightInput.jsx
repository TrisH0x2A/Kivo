import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { DYNAMIC_TEMPLATE_VARIABLES, isDynamicTemplateVariable } from "@/lib/template-variables.js";
import { cn } from "@/lib/utils";

function renderHighlighted(text, envVars) {
  if (!text) return null;

  const parts = [];
  let lastIndex = 0;
  const regex = /\{\{([^}]*)\}\}/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={`t-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>
      );
    }

    const varName = match[1].trim();
    const merged = envVars?.merged ?? {};
    const isResolved = varName in merged || isDynamicTemplateVariable(varName);

    parts.push(
      <span
        key={`v-${match.index}`}
        className={cn("rounded-sm font-semibold")}
        style={{
          color: isResolved
            ? "hsl(var(--env-resolved))"
            : "hsl(var(--env-unresolved))",
          boxShadow: isResolved
            ? "0 0 0 2px hsl(var(--env-resolved) / 0.20), inset 0 0 0 12px hsl(var(--env-resolved) / 0.14)"
            : "0 0 0 2px hsl(var(--env-unresolved) / 0.22), inset 0 0 0 12px hsl(var(--env-unresolved) / 0.15)"
        }}
      >
        {match[0]}
      </span>
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return parts.length > 0 ? parts : text;
}

export function EnvHighlightInput({
  value = "",
  onChange,
  onValueChange,
  placeholder,
  type = "text",
  className,
  envVars,
  inputClassName,
  ...props
}) {
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  const optionRefs = useRef([]);
  const isPassword = type === "password";

  const hasVars = useMemo(() => value?.includes("{{") && value?.includes("}}"), [value]);

  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [suggestionFilter, setSuggestionFilter] = useState("");

  const allEnvKeys = useMemo(() => {
    const merged = envVars?.merged ?? {};
    const envKeys = Object.keys(merged);
    const dynamicKeys = DYNAMIC_TEMPLATE_VARIABLES.map((item) => item.key);
    return [...dynamicKeys, ...envKeys];
  }, [envVars]);

  const dynamicPreviewMap = useMemo(() => {
    return DYNAMIC_TEMPLATE_VARIABLES.reduce((acc, item) => {
      acc[item.key] = item.preview;
      return acc;
    }, {});
  }, []);

  const filteredKeys = useMemo(() => {
    if (!suggestionFilter) return allEnvKeys;
    const lower = suggestionFilter.toLowerCase();
    return allEnvKeys.filter((k) => k.toLowerCase().includes(lower));
  }, [allEnvKeys, suggestionFilter]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [filteredKeys.length, suggestionFilter]);

  const fireChange = useCallback(
    (newValue) => {
      if (onValueChange) {
        onValueChange(newValue);
      }
      const finalOnChange = onChange || props.onChange;
      if (finalOnChange) {
        const syntheticEvent = {
          target: { value: newValue, name: props.name },
          currentTarget: { value: newValue, name: props.name },
          preventDefault: () => { },
          stopPropagation: () => { }
        };
        finalOnChange(syntheticEvent);
      }
    },
    [onChange, onValueChange, props.onChange, props.name]
  );

  const insertSuggestion = useCallback(
    (key) => {
      const input = inputRef.current;
      if (!input) return;

      const cursorPos = input.selectionStart ?? value.length;
      const before = value.slice(0, cursorPos);
      const openIdx = before.lastIndexOf("{{");

      if (openIdx === -1) return;

      const prefix = value.slice(0, openIdx);
      const suffix = value.slice(cursorPos);
      const newValue = `${prefix}{{${key}}}${suffix}`;

      fireChange(newValue);
      setShowSuggestions(false);

      requestAnimationFrame(() => {
        const newPos = openIdx + key.length + 4;
        input.setSelectionRange(newPos, newPos);
        input.focus();
      });
    },
    [value, fireChange]
  );

  const handleChange = (e) => {
    const newValue = e.target.value;
    const cursorPos = e.target.selectionStart ?? newValue.length;
    const before = newValue.slice(0, cursorPos);

    const openIdx = before.lastIndexOf("{{");
    if (openIdx !== -1) {
      const afterOpen = before.slice(openIdx + 2);
      const hasClose = afterOpen.includes("}}");
      if (!hasClose) {
        setSuggestionFilter(afterOpen);
        setShowSuggestions(true);
      } else {
        setShowSuggestions(false);
      }
    } else {
      setShowSuggestions(false);
    }

    fireChange(newValue);
  };

  const handleKeyDown = (e) => {
    if (!showSuggestions || filteredKeys.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((prev) => (prev + 1) % filteredKeys.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((prev) =>
        prev <= 0 ? filteredKeys.length - 1 : prev - 1
      );
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      insertSuggestion(filteredKeys[selectedIdx]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target) &&
        inputRef.current && !inputRef.current.contains(e.target)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!showSuggestions) return;
    const activeOption = optionRefs.current[selectedIdx];
    if (activeOption) {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx, showSuggestions]);

  const finalInputClass = cn(
    "flex h-10 w-full border border-border/40 bg-transparent px-2.5 py-2 text-[13px] font-mono outline-none transition-colors",
    "focus-visible:border-primary/50 focus-visible:ring-1 focus-visible:ring-primary/20",
    "placeholder:text-muted-foreground/50",
    "[&::-ms-reveal]:hidden [&::-webkit-contacts-auto-fill-button]:hidden [&::-webkit-credentials-auto-fill-button]:hidden",
    hasVars && !isPassword && "text-transparent caret-foreground",
    inputClassName
  );

  return (
    <div className={cn("relative w-full group isolate", className)}>
      <input
        {...props}
        ref={inputRef}
        type={isPassword ? "password" : "text"}
        value={value ?? ""}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={finalInputClass}
        autoComplete="off"
        spellCheck="false"
      />

      {hasVars && !isPassword && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center px-2.5 font-mono overflow-hidden whitespace-nowrap",
            inputClassName
          )}
          aria-hidden="true"
          style={{
            borderWidth: 1,
            borderColor: "transparent",
            paddingTop: 0,
            paddingBottom: 0,
            background: "transparent"
          }}
        >
          {renderHighlighted(value, envVars)}
        </div>
      )}

      {showSuggestions && filteredKeys.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-[calc(100%+4px)] z-[500] min-w-[260px] max-w-full overflow-hidden rounded-md border border-border/40 bg-background shadow-2xl"
          style={{ maxHeight: 220, overflowY: "auto" }}
        >
          <div className="flex items-center justify-between border-b border-border/20 bg-background px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <span>Variables</span>
            <span className="opacity-50 font-normal">↑↓ to navigate</span>
          </div>
          {filteredKeys.map((key, idx) => (
            <button
              key={key}
              ref={(el) => {
                optionRefs.current[idx] = el;
              }}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertSuggestion(key);
              }}
              className={cn(
                "grid w-full grid-cols-[10px_minmax(0,1fr)_minmax(0,140px)] items-center gap-3 border-b border-border/10 px-3 py-2.5 text-left font-mono text-[12px] transition-colors last:border-0",
                idx === selectedIdx
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-secondary/20 hover:text-foreground"
              )}
              style={idx === selectedIdx
                ? {
                  backgroundColor: "hsl(var(--env-suggestion-active-bg))",
                  color: "hsl(var(--env-suggestion-active-text))",
                  boxShadow: "inset 2px 0 0 hsl(var(--env-suggestion-active-border))"
                }
                : undefined}
            >
              <div
                className="h-2 w-2 rounded-full shrink-0"
                style={
                  ((envVars?.merged && key in envVars.merged) || isDynamicTemplateVariable(key))
                    ? {
                      backgroundColor: "hsl(var(--env-resolved))",
                      boxShadow: "0 0 0 2px hsl(var(--env-resolved) / 0.16)",
                    }
                    : {
                      backgroundColor: "hsl(var(--env-unresolved))",
                      boxShadow: "0 0 0 2px hsl(var(--env-unresolved) / 0.16)",
                    }
                }
              />
              <span className="truncate font-bold">{key}</span>
              <span
                className="truncate text-right text-[10px] italic"
                style={{ color: "hsl(var(--env-suggestion-value))" }}
              >
                {dynamicPreviewMap[key] ?? envVars?.merged?.[key] ?? "undefined"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
