import { useEffect, useMemo, useRef, useState } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-yaml";

import { cn } from "@/lib/utils.js";
import { isJsonText } from "@/lib/formatters.js";

const SUGGESTION_LIMIT = 24;

if (Prism.languages.javascript && !Prism.languages.javascript["kivo-api"]) {
  Prism.languages.insertBefore("javascript", "keyword", {
    "kivo-api": /\bkivo\b/
  });
}

const tokenPattern = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:|"(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?|[{}\[\],:])/g;
const graphqlKeywords = new Set([
  "query",
  "mutation",
  "subscription",
  "fragment",
  "on",
  "true",
  "false",
  "null",
  "schema",
  "scalar",
  "type",
  "interface",
  "union",
  "enum",
  "input",
  "directive",
  "extend",
  "implements"
]);
const graphqlTokenPattern = /"""[\s\S]*?"""|"(?:\\.|[^"])*"|#[^\n]*|\.\.\.|@[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[!():=@\[\]{|},]/g;
const prismToScriptClassMap = {
  "kivo-api": "script-builtin",
  comment: "script-comment",
  string: "script-string",
  "template-string": "script-string",
  regex: "script-regex",
  keyword: "script-keyword",
  boolean: "script-keyword",
  number: "script-number",
  builtin: "script-builtin",
  function: "script-builtin",
  "function-variable": "script-builtin",
  "class-name": "script-builtin",
  operator: "script-punctuation",
  punctuation: "script-punctuation",
  interpolation: "script-punctuation",
  constant: "script-builtin",
  property: "script-identifier",
};

const prismToYamlClassMap = {
  comment: "yaml-comment",
  key: "yaml-key",
  atrule: "yaml-key",
  important: "yaml-key",
  property: "yaml-key",
  scalar: "yaml-string",
  string: "yaml-string",
  number: "yaml-number",
  datetime: "yaml-number",
  boolean: "yaml-boolean",
  null: "yaml-boolean",
  tag: "yaml-key",
  punctuation: "yaml-punctuation",
};

const prismToMarkupClassMap = {
  comment: "markup-comment",
  prolog: "markup-comment",
  doctype: "markup-comment",
  cdata: "markup-comment",
  tag: "markup-tag",
  "attr-name": "markup-attr-name",
  "attr-value": "markup-attr-value",
  entity: "markup-attr-value",
  punctuation: "markup-punctuation",
};

function getTokenPrefix(text, cursorPosition) {
  const safeText = String(text || "");
  const safeCursor = Number.isFinite(cursorPosition) ? cursorPosition : 0;
  const beforeCursor = safeText.slice(0, safeCursor);
  const match = beforeCursor.match(/[A-Za-z_$][A-Za-z0-9_$.]*$/);
  return match ? match[0] : "";
}

function getTextareaCaretPosition(element, cursorPosition) {
  if (!element) {
    return { top: 8, left: 8 };
  }

  const text = element.value || "";
  const safeCursor = Math.max(0, Math.min(text.length, Number(cursorPosition) || 0));
  const mirror = document.createElement("div");
  const style = window.getComputedStyle(element);
  const properties = [
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontFamily",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "tabSize",
    "MozTabSize",
    "whiteSpace",
    "wordWrap",
    "wordBreak",
  ];

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  for (const property of properties) {
    mirror.style[property] = style[property];
  }

  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.textContent = text.slice(0, safeCursor);

  const marker = document.createElement("span");
  marker.textContent = text.slice(safeCursor) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const top = marker.offsetTop - element.scrollTop;
  const left = marker.offsetLeft - element.scrollLeft;
  document.body.removeChild(mirror);

  return { top, left };
}

function tokenClassName(token) {
  if (/^".*":$/.test(token)) {
    return "json-key";
  }

  if (/^"/.test(token)) {
    return "json-string";
  }

  if (/^(true|false)$/.test(token)) {
    return "json-boolean";
  }

  if (token === "null") {
    return "json-null";
  }

  if (/^-?\d/.test(token)) {
    return "json-number";
  }

  return "json-punctuation";
}

function renderHighlightedJson(text) {
  const content = text || "";
  const nodes = [];
  let lastIndex = 0;
  let match;

  tokenPattern.lastIndex = 0;

  while ((match = tokenPattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index));
    }

    const token = match[0];
    nodes.push(
      <span key={`${match.index}-${token}`} className={tokenClassName(token)}>
        {token}
      </span>
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex));
  }

  return nodes;
}

function resolvePrismClass(token, classMap, fallbackClass) {
  const aliases = Array.isArray(token?.alias)
    ? token.alias
    : (token?.alias ? [token.alias] : []);
  const candidates = [token?.type, ...aliases].map((entry) => String(entry || "").toLowerCase());
  for (const candidate of candidates) {
    if (classMap[candidate]) {
      return classMap[candidate];
    }
  }
  return fallbackClass;
}

function renderPrismToken(token, keyPrefix, classMap, fallbackClass) {
  if (typeof token === "string") {
    return token;
  }

  if (Array.isArray(token)) {
    return token.map((item, index) => renderPrismToken(item, `${keyPrefix}-${index}`, classMap, fallbackClass));
  }

  const className = resolvePrismClass(token, classMap, fallbackClass);
  return (
    <span key={keyPrefix} className={className}>
      {renderPrismToken(token?.content, `${keyPrefix}-content`, classMap, fallbackClass)}
    </span>
  );
}

function renderHighlightedJavascript(text) {
  const content = text || "";
  const javascriptGrammar = Prism.languages.javascript || Prism.languages.js || Prism.languages.clike;
  if (!javascriptGrammar) {
    return content;
  }

  const tokens = Prism.tokenize(content, javascriptGrammar);
  return tokens.map((token, index) => renderPrismToken(token, `js-${index}`, prismToScriptClassMap, "script-identifier"));
}

function renderHighlightedYaml(text) {
  const content = text || "";
  const yamlGrammar = Prism.languages.yaml;
  if (!yamlGrammar) {
    return content;
  }

  const tokens = Prism.tokenize(content, yamlGrammar);
  return tokens.map((token, index) => renderPrismToken(token, `yaml-${index}`, prismToYamlClassMap, "yaml-string"));
}

function renderHighlightedMarkup(text) {
  const content = text || "";
  const markupGrammar = Prism.languages.markup || Prism.languages.xml;
  if (!markupGrammar) {
    return content;
  }

  const tokens = Prism.tokenize(content, markupGrammar);
  return tokens.map((token, index) => renderPrismToken(token, `xml-${index}`, prismToMarkupClassMap, "markup-punctuation"));
}

const AUTO_PAIRS = { "{": "}", "[": "]", "(": ")", "\"": "\"", "'": "'", "`": "`" };
const AUTO_CLOSERS = new Set([")", "]", "}", "\"", "'", "`"]);

function handleSmartTyping(event, textarea, value, onChange, pendingCursorRef, language) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = value || "";
  const isJsonLang = language === "json";

  if (isJsonLang && event.key === ":" && start === end) {
    const prevChar = val[start - 1];
    const nextChar = val[start];
    if (prevChar === "\"" && nextChar !== " ") {
      event.preventDefault();
      const insert = ": ";
      const updated = val.slice(0, start) + insert + val.slice(end);
      pendingCursorRef.current = start + insert.length;
      onChange?.(updated);
      return true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(AUTO_PAIRS, event.key)) {
    const close = AUTO_PAIRS[event.key];
    const selection = val.slice(start, end);
    if (selection) {
      event.preventDefault();
      const insert = event.key + selection + close;
      const next = val.slice(0, start) + insert + val.slice(end);
      pendingCursorRef.current = start + insert.length;
      onChange?.(next);
      return true;
    }
    const nextChar = val[start];
    const isQuote = event.key === "\"" || event.key === "'" || event.key === "`";
    if (isQuote && nextChar === event.key) {
      event.preventDefault();
      pendingCursorRef.current = null;
      textarea.setSelectionRange(start + 1, start + 1);
      return true;
    }
    const prevChar = val[start - 1];
    if (isQuote && prevChar && /[A-Za-z0-9_$]/.test(prevChar)) {
      return false;
    }
    event.preventDefault();
    const insert = event.key + close;
    const next = val.slice(0, start) + insert + val.slice(end);
    pendingCursorRef.current = start + 1;
    onChange?.(next);
    return true;
  }

  if (AUTO_CLOSERS.has(event.key) && start === end && val[start] === event.key) {
    event.preventDefault();
    pendingCursorRef.current = null;
    textarea.setSelectionRange(start + 1, start + 1);
    return true;
  }

  if (event.key === "Backspace" && start === end && start > 0) {
    const prev = val[start - 1];
    const next = val[start];
    if (AUTO_PAIRS[prev] === next) {
      event.preventDefault();
      const updated = val.slice(0, start - 1) + val.slice(start + 1);
      pendingCursorRef.current = start - 1;
      onChange?.(updated);
      return true;
    }
  }

  if (event.key === "Enter" && start === end) {
    const lineStart = val.lastIndexOf("\n", start - 1) + 1;
    const currentLine = val.slice(lineStart, start);
    const indentMatch = currentLine.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] : "";
    const prev = val[start - 1];
    const next = val[start];
    if ((prev === "{" && next === "}") || (prev === "[" && next === "]") || (prev === "(" && next === ")")) {
      event.preventDefault();
      const extra = "  ";
      const insert = `\n${indent}${extra}\n${indent}`;
      const updated = val.slice(0, start) + insert + val.slice(end);
      pendingCursorRef.current = start + 1 + indent.length + extra.length;
      onChange?.(updated);
      return true;
    }
    if (indent) {
      event.preventDefault();
      const insert = `\n${indent}`;
      const updated = val.slice(0, start) + insert + val.slice(end);
      pendingCursorRef.current = start + insert.length;
      onChange?.(updated);
      return true;
    }
  }

  if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (start === end) {
      event.preventDefault();
      const insert = "  ";
      const updated = val.slice(0, start) + insert + val.slice(end);
      pendingCursorRef.current = start + insert.length;
      onChange?.(updated);
      return true;
    }
    event.preventDefault();
    const lineStart = val.lastIndexOf("\n", start - 1) + 1;
    const selectedBlock = val.slice(lineStart, end);
    const indented = selectedBlock.replace(/^/gm, "  ");
    const updated = val.slice(0, lineStart) + indented + val.slice(end);
    pendingCursorRef.current = end + (indented.length - selectedBlock.length);
    onChange?.(updated);
    return true;
  }

  if (event.key === "Tab" && event.shiftKey && start === end) {
    const lineStart = val.lastIndexOf("\n", start - 1) + 1;
    const head = val.slice(lineStart, lineStart + 2);
    if (head === "  ") {
      event.preventDefault();
      const updated = val.slice(0, lineStart) + val.slice(lineStart + 2);
      pendingCursorRef.current = Math.max(lineStart, start - 2);
      onChange?.(updated);
      return true;
    }
  }

  return false;
}

function getLineCount(text) {
  const source = String(text ?? "");
  return Math.max(1, source.split("\n").length);
}

function graphqlTokenClassName(token) {
  if (token.startsWith("#")) {
    return "graphql-comment";
  }

  if (token.startsWith('"')) {
    return "graphql-string";
  }

  if (token.startsWith("$")) {
    return "graphql-variable";
  }

  if (token.startsWith("@")) {
    return "graphql-directive";
  }

  if (/^-?\d/.test(token)) {
    return "graphql-number";
  }

  if (graphqlKeywords.has(token)) {
    return "graphql-keyword";
  }

  if (/^\.{3}$|^[!():=@\[\]{|},]$/.test(token)) {
    return "graphql-punctuation";
  }

  return "graphql-field";
}

function renderHighlightedGraphql(text) {
  const content = text || "";
  const nodes = [];
  let lastIndex = 0;
  let match;

  graphqlTokenPattern.lastIndex = 0;

  while ((match = graphqlTokenPattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index));
    }

    const token = match[0];
    nodes.push(
      <span key={`${match.index}-${token}`} className={graphqlTokenClassName(token)}>
        {token}
      </span>
    );
    lastIndex = match.index + token.length;
  }

  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex));
  }

  return nodes;
}

export function CodeEditor({
  value,
  onChange,
  placeholder,
  readOnly = false,
  language = "text",
  disabled = false,
  wrapLines = false,
  className,
  lineNumbers = false,
  autocompleteItems = [],
  getAutocompleteItems
}) {
  const highlightRef = useRef(null);
  const lineNumbersRef = useRef(null);
  const textareaRef = useRef(null);
  const suggestionsRef = useRef(null);
  const suppressKeyUpRef = useRef(false);
  const pendingCursorRef = useRef(null);
  const [suggestions, setSuggestions] = useState([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [suggestionAnchor, setSuggestionAnchor] = useState({ top: 12, left: 12 });
  const isJson = language === "json" && isJsonText(value);
  const isGraphql = language === "graphql";
  const isJavascript = language === "javascript" || language === "js";
  const isYaml = language === "yaml" || language === "yml";
  const isXml = language === "xml" || language === "markup" || language === "html";
  const useOverlay = !readOnly && (language === "json" || language === "graphql" || isJavascript || isYaml || isXml);
  const displayValue = useMemo(() => value || "", [value]);
  const totalLines = useMemo(() => getLineCount(displayValue), [displayValue]);
  const suggestionEnabled = !readOnly && !disabled && (typeof getAutocompleteItems === "function" || Array.isArray(autocompleteItems) && autocompleteItems.length > 0);

  useEffect(() => {
    if (!textareaRef.current || pendingCursorRef.current == null) {
      return;
    }
    const nextCursor = pendingCursorRef.current;
    pendingCursorRef.current = null;
    textareaRef.current.setSelectionRange(nextCursor, nextCursor);
    textareaRef.current.focus();
  }, [value]);

  useEffect(() => {
    if (!suggestionsRef.current || suggestions.length === 0) {
      return;
    }

    const activeItem = suggestionsRef.current.querySelector(`[data-suggestion-index="${selectedSuggestionIndex}"]`);
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [selectedSuggestionIndex, suggestions]);

  function syncScroll(event) {
    if (highlightRef.current) {
      highlightRef.current.scrollTop = event.target.scrollTop;
      highlightRef.current.scrollLeft = event.target.scrollLeft;
    }
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = event.target.scrollTop;
    }
  }

  function updateSuggestionsByCursor(cursorPosition, sourceText = displayValue, force = false) {
    if (!suggestionEnabled) {
      setSuggestions([]);
      setSelectedSuggestionIndex(0);
      return;
    }

    const prefix = getTokenPrefix(sourceText, cursorPosition);
    if (!prefix && !force) {
      setSuggestions([]);
      setSelectedSuggestionIndex(0);
      return;
    }

    const prefixLower = prefix.toLowerCase();
    const candidates = getAutocompleteItems ? getAutocompleteItems(sourceText, cursorPosition) : autocompleteItems;
    const next = candidates
      .filter((item) => String(item?.label || "").toLowerCase().startsWith(prefixLower))
      .sort((left, right) => {
        const leftLabel = String(left?.label || "");
        const rightLabel = String(right?.label || "");
        const leftLower = leftLabel.toLowerCase();
        const rightLower = rightLabel.toLowerCase();
        const leftExact = leftLower === prefixLower ? 1 : 0;
        const rightExact = rightLower === prefixLower ? 1 : 0;
        if (leftExact !== rightExact) {
          return rightExact - leftExact;
        }

        const leftDepth = leftLabel.split(".").length;
        const rightDepth = rightLabel.split(".").length;
        if (leftDepth !== rightDepth) {
          return leftDepth - rightDepth;
        }

        if (leftLabel.length !== rightLabel.length) {
          return leftLabel.length - rightLabel.length;
        }

        return leftLabel.localeCompare(rightLabel);
      })
      .map((item) => {
        const label = String(item?.label || "");
        const lastDotIndex = prefix.lastIndexOf(".");
        const basePath = lastDotIndex >= 0 ? prefix.slice(0, lastDotIndex + 1) : "";
        const suffixLabel = basePath && label.toLowerCase().startsWith(basePath.toLowerCase())
          ? label.slice(basePath.length)
          : "";
        return {
          ...item,
          matchPrefix: prefix,
          displayLabel: suffixLabel || label,
        };
      })
      .slice(0, SUGGESTION_LIMIT);

    if (textareaRef.current) {
      const element = textareaRef.current;
      const computedStyle = window.getComputedStyle(element);
      const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 24;
      const caret = getTextareaCaretPosition(element, cursorPosition);
      const estimatedHeight = 220;
      const popupWidth = Math.min(320, Math.max(180, element.clientWidth - 16));

      let top = caret.top + lineHeight + 6;
      let left = caret.left + 4;

      const minLeft = 8;
      const maxLeft = Math.max(minLeft, element.clientWidth - popupWidth - 8);
      left = Math.min(Math.max(minLeft, left), maxLeft);

      if (top + estimatedHeight > element.clientHeight - 8) {
        top = top - estimatedHeight - lineHeight - 10;
      }

      top = Math.min(Math.max(8, top), Math.max(8, element.clientHeight - estimatedHeight - 8));
      setSuggestionAnchor({ top, left });
    }

    setSuggestions(next);
    setSelectedSuggestionIndex(0);
  }

  function applySuggestion(item) {
    if (!textareaRef.current || !item) {
      return;
    }

    const selectionStart = textareaRef.current.selectionStart;
    const selectionEnd = textareaRef.current.selectionEnd;
    const prefix = String(item.matchPrefix || getTokenPrefix(displayValue, selectionStart));
    const insertText = String(item.insertText || item.label || "");
    const from = Math.max(0, selectionStart - prefix.length);
    const to = Math.max(from, selectionEnd);
    const nextValue = `${displayValue.slice(0, from)}${insertText}${displayValue.slice(to)}`;

    pendingCursorRef.current = from + insertText.length;
    onChange?.(nextValue);
    setSuggestions([]);
    setSelectedSuggestionIndex(0);
  }

  function handleEditorScroll(event) {
    syncScroll(event);
    if (suggestions.length > 0) {
      updateSuggestionsByCursor(event.currentTarget.selectionStart, event.currentTarget.value);
    }
  }

  const lineNumbersColumn = lineNumbers ? (
    <pre
      ref={lineNumbersRef}
      aria-hidden="true"
      className="editor-overlay-scroll-hidden pointer-events-none h-full overflow-hidden border-r border-border/30 bg-muted/20 px-2 py-3 text-right font-mono text-[11px] leading-6 text-muted-foreground/70"
    >
      <code>
        {Array.from({ length: totalLines }, (_, index) => (
          <span key={`line-${index + 1}`} className="block">
            {index + 1}
          </span>
        ))}
      </code>
    </pre>
  ) : null;

  if (readOnly) {
    return (
      <div className={cn("relative grid h-full min-h-0 overflow-hidden bg-transparent", lineNumbers ? "grid-cols-[48px_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]", className)}>
        {lineNumbersColumn}
        <pre
          className={cn(
            "thin-scrollbar h-full px-4 py-3 font-mono text-[12px] leading-6 text-foreground",
            lineNumbers ? "col-start-2" : "",
            wrapLines ? "overflow-y-auto overflow-x-hidden whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-auto"
          )}
        >
          <code>
            {language === "json" && isJson
              ? renderHighlightedJson(displayValue)
              : isGraphql
                ? renderHighlightedGraphql(displayValue)
                : isJavascript
                  ? renderHighlightedJavascript(displayValue)
                  : isYaml
                    ? renderHighlightedYaml(displayValue)
                    : isXml
                      ? renderHighlightedMarkup(displayValue)
                : displayValue}
          </code>
        </pre>
      </div>
    );
  }

  if (!useOverlay) {
    return (
      <div className={cn("relative grid h-full min-h-0 overflow-hidden bg-transparent", lineNumbers ? "grid-cols-[48px_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]", className)}>
        {lineNumbersColumn}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onScroll={handleEditorScroll}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          className={cn(
            "thin-scrollbar h-full w-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-[12px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50",
            wrapLines
              ? "overflow-y-auto overflow-x-hidden whitespace-pre-wrap [overflow-wrap:anywhere]"
              : "overflow-auto"
          )}
        />
      </div>
    );
  }

  return (
    <div className={cn("relative grid h-full min-h-0 overflow-hidden bg-transparent", lineNumbers ? "grid-cols-[48px_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]", className)}>
      {lineNumbersColumn}
      <pre
        ref={highlightRef}
        aria-hidden="true"
        className={cn(
          "editor-overlay-scroll-hidden pointer-events-none row-start-1 h-full px-4 py-3 font-mono text-[12px] leading-6 text-foreground",
          lineNumbers ? "col-start-2" : "col-start-1",
          wrapLines
            ? "overflow-y-auto overflow-x-hidden whitespace-pre-wrap [overflow-wrap:anywhere]"
            : "overflow-auto"
        )}
      >
        <code>
          {displayValue
            ? isJson
              ? renderHighlightedJson(displayValue)
              : isGraphql
                ? renderHighlightedGraphql(displayValue)
                : isJavascript
                  ? renderHighlightedJavascript(displayValue)
                  : isYaml
                    ? renderHighlightedYaml(displayValue)
                    : isXml
                      ? renderHighlightedMarkup(displayValue)
                : displayValue
            : " "}
        </code>
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onChange?.(event.target.value);
          updateSuggestionsByCursor(event.target.selectionStart, event.target.value);
        }}
        onKeyDown={(event) => {
          const isArrowDown = event.key === "ArrowDown" || event.key === "Down" || event.code === "ArrowDown" || event.keyCode === 40;
          const isArrowUp = event.key === "ArrowUp" || event.key === "Up" || event.code === "ArrowUp" || event.keyCode === 38;
          if (suggestions.length === 0 && handleSmartTyping(event, event.currentTarget, displayValue, onChange, pendingCursorRef, language)) {
            suppressKeyUpRef.current = true;
            return;
          }
          if (suggestions.length > 0) {
            if (isArrowDown) {
              event.preventDefault();
              suppressKeyUpRef.current = true;
              setSelectedSuggestionIndex((current) => (current + 1) % suggestions.length);
              return;
            }

            if (isArrowUp) {
              event.preventDefault();
              suppressKeyUpRef.current = true;
              setSelectedSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
              return;
            }

            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              suppressKeyUpRef.current = true;
              applySuggestion(suggestions[selectedSuggestionIndex]);
              return;
            }

            if (event.key === "Escape") {
              suppressKeyUpRef.current = true;
              setSuggestions([]);
              setSelectedSuggestionIndex(0);
              return;
            }
          }

          if (suggestionEnabled && event.ctrlKey && event.key === " ") {
            event.preventDefault();
            suppressKeyUpRef.current = true;
            updateSuggestionsByCursor(event.currentTarget.selectionStart, event.currentTarget.value, true);
          }
        }}
        onClick={(event) => updateSuggestionsByCursor(event.currentTarget.selectionStart)}
        onKeyUp={(event) => {
          if (suppressKeyUpRef.current) {
            suppressKeyUpRef.current = false;
            return;
          }

          if (["ArrowDown", "ArrowUp", "Down", "Up", "Enter", "Tab", "Escape"].includes(event.key)) {
            return;
          }

          updateSuggestionsByCursor(event.currentTarget.selectionStart);
        }}
        onBlur={() => {
          window.setTimeout(() => {
            setSuggestions([]);
            setSelectedSuggestionIndex(0);
          }, 90);
        }}
        onScroll={handleEditorScroll}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className={cn(
          "thin-scrollbar row-start-1 h-full w-full resize-none border-0 bg-transparent px-4 py-3 font-mono text-[12px] leading-6 text-transparent caret-foreground outline-none placeholder:text-muted-foreground/0 disabled:cursor-not-allowed disabled:opacity-50",
          lineNumbers ? "col-start-2" : "col-start-1",
          wrapLines
            ? "overflow-y-auto overflow-x-hidden whitespace-pre-wrap [overflow-wrap:anywhere]"
            : "overflow-auto"
        )}
      />
      {!value ? <div className={cn("pointer-events-none row-start-1 pt-3 font-mono text-[12px] text-muted-foreground/60", lineNumbers ? "col-start-2 pl-4" : "col-start-1 pl-4")}>{placeholder}</div> : null}
      {suggestions.length > 0 ? (
        <div className={cn("pointer-events-none row-start-1 relative z-30", lineNumbers ? "col-start-2" : "col-start-1")}>
          <div
            ref={suggestionsRef}
            style={{ top: `${suggestionAnchor.top}px`, left: `${suggestionAnchor.left}px` }}
            className="editor-suggestion-scroll pointer-events-auto absolute max-h-56 w-80 max-w-[calc(100%-16px)] overflow-auto rounded-none border border-border/60 bg-popover/97 shadow-[0_16px_32px_rgba(0,0,0,0.35)] backdrop-blur-md"
          >
            {suggestions.map((item, index) => (
              <button
                key={`${item.label}-${index}`}
                data-suggestion-index={index}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applySuggestion(item)}
                aria-selected={index === selectedSuggestionIndex}
                className={cn(
                  "relative flex w-full items-center justify-between gap-3 border-b border-border/15 px-3 py-2 text-left text-[12px] transition-colors last:border-b-0",
                  index === selectedSuggestionIndex
                    ? "bg-primary/35 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.45)]"
                    : "text-muted-foreground hover:bg-accent/30 hover:text-foreground"
                )}
              >
                {index === selectedSuggestionIndex ? (
                  <span className="absolute inset-y-0 left-0 w-[2px] bg-primary" aria-hidden="true"></span>
                ) : null}
                <span className={cn("font-mono text-[12px] text-foreground", index === selectedSuggestionIndex ? "font-semibold" : "")}>{item.displayLabel || item.label}</span>
                <span className={cn("text-[10px] uppercase tracking-[0.12em]", index === selectedSuggestionIndex ? "text-primary" : "text-muted-foreground")}>tab</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
