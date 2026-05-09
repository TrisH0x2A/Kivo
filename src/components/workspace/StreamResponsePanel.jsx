import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  Braces,
  Check,
  Cookie,
  Copy,
  CornerDownLeft,
  Eraser,
  FileText,
  Filter,
  Info,
  Loader2,
  Pause,
  Play,
  Radio,
  Search,
  ServerCrash,
  Wifi,
  WifiOff,
  WrapText,
} from "lucide-react";

import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { JsonTree } from "@/components/ui/JsonTree.jsx";
import { cn } from "@/lib/utils.js";
import { CookieManagerModal } from "@/components/workspace/CookieManagerModal.jsx";

const DIRECTION_OPTIONS = [
  { id: "all", label: "All" },
  { id: "in", label: "Received" },
  { id: "out", label: "Sent" },
  { id: "system", label: "System" },
];

const MAX_INLINE_TEXT = 64_000;

function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(at) {
  if (!at) return "";
  try {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return String(at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return String(at);
  }
}

function tryParseJson(text) {
  if (typeof text !== "string") return { ok: false, value: null };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, value: null };
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, value: null };
  }
}

function directionIcon(direction) {
  if (direction === "out") return <ArrowUpRight className="h-3.5 w-3.5" />;
  if (direction === "system") return <Info className="h-3.5 w-3.5" />;
  return <ArrowDownLeft className="h-3.5 w-3.5" />;
}

function directionTone(direction, kind, event) {
  if (kind === "error") return "text-[hsl(var(--danger))]";
  if (direction === "out") return "text-[hsl(var(--ring))]";
  if (direction === "system") {
    if (event === "close" || event === "disconnect") return "text-muted-foreground";
    if (event === "open" || event === "connect") return "text-[hsl(var(--success))]";
    return "text-[hsl(var(--ring))]";
  }
  return "text-[hsl(var(--success))]";
}

function modeLabel(mode) {
  if (mode === "websocket") return "WebSocket";
  if (mode === "sse") return "Server-Sent Events";
  if (mode === "socketio") return "Socket.IO";
  return "Stream";
}

function statusPill({ connected, connecting, error }) {
  if (error) {
    return {
      icon: <ServerCrash className="h-3.5 w-3.5" />,
      label: "Error",
      className: "border-[hsl(var(--danger))]/40 bg-[hsl(var(--danger))]/10 text-[hsl(var(--danger))]",
    };
  }
  if (connected) {
    return {
      icon: <Wifi className="h-3.5 w-3.5" />,
      label: "Live",
      className: "border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]",
    };
  }
  if (connecting) {
    return {
      icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
      label: "Connecting",
      className: "border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]",
    };
  }
  return {
    icon: <WifiOff className="h-3.5 w-3.5" />,
    label: "Disconnected",
    className: "border-border/40 bg-muted/20 text-muted-foreground",
  };
}

export function StreamResponsePanel({
  mode = "websocket",
  request,
  connectionState = {},
  messages = [],
  onClear,
  onCancelSend,
  isSending = false,
  workspaceName = "",
  collectionName = "",
}) {
  const [filter, setFilter] = useState("");
  const [direction, setDirection] = useState("all");
  const [autoscroll, setAutoscroll] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [view, setView] = useState("json");
  const [wrap, setWrap] = useState(true);
  const listRef = useRef(null);
  const splitRef = useRef(null);
  const [timelinePct, setTimelinePct] = useState(60);
  const draggingRef = useRef(false);
  const [isCookiesOpen, setIsCookiesOpen] = useState(false);

  useEffect(() => {
    function handleMove(event) {
      if (!draggingRef.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = ((event.clientY - rect.top) / rect.height) * 100;
      setTimelinePct(Math.min(85, Math.max(15, pct)));
    }
    function handleUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  function startDrag(event) {
    event.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return messages.filter((m) => {
      if (direction !== "all" && m.direction !== direction) return false;
      if (!term) return true;
      const haystack = `${m.event || ""} ${m.text || ""}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [messages, filter, direction]);

  const latest = filtered[filtered.length - 1] || null;
  const selected = useMemo(() => {
    if (followLatest || !selectedId) return latest;
    return filtered.find((m) => m.id === selectedId) || latest;
  }, [filtered, selectedId, followLatest, latest]);

  useEffect(() => {
    if (!autoscroll) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoscroll, filtered.length]);

  const pill = statusPill(connectionState);
  const totals = useMemo(() => {
    const counts = { all: messages.length, in: 0, out: 0, system: 0 };
    for (const m of messages) {
      if (m.direction === "in") counts.in += 1;
      else if (m.direction === "out") counts.out += 1;
      else counts.system += 1;
    }
    return counts;
  }, [messages]);

  function handleSelectRow(id) {
    setSelectedId(id);
    setFollowLatest(false);
  }

  function handleFollowLatest() {
    setFollowLatest(true);
    setSelectedId(null);
  }

  return (
    <Card className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-none border-border/40 bg-card/40">
      <header className="flex flex-col gap-2 border-b border-border/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Radio className="h-4 w-4 shrink-0 text-primary" />
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {modeLabel(mode)} Stream
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-none border px-2 py-0.5 text-[11px] font-medium",
              pill.className,
            )}
          >
            {pill.icon}
            {pill.label}
          </span>
          {connectionState.lastEventAt ? (
            <span className="text-[11px] text-muted-foreground">
              last event {formatTime(connectionState.lastEventAt).replace(/\.\d+$/, "")}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => setAutoscroll((v) => !v)}
              title={autoscroll ? "Pause autoscroll" : "Resume autoscroll"}
            >
              {autoscroll ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => setIsCookiesOpen(true)}
              title="Manage cookies for this workspace/collection"
            >
              <Cookie className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => {
                onClear?.();
                setSelectedId(null);
                setFollowLatest(true);
              }}
              disabled={!messages.length}
              title="Clear timeline"
            >
              <Eraser className="h-3.5 w-3.5" />
            </Button>
            {isSending && onCancelSend ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-[11px] text-[hsl(var(--danger))] hover:opacity-80"
                onClick={onCancelSend}
              >
                <Ban className="h-3.5 w-3.5" />
                Cancel
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[160px] max-w-full flex-1 basis-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter messages…"
              className="h-8 border-border/35 pl-8 text-[12px] focus-visible:border-primary focus-visible:ring-0"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-0.5 rounded-none border border-border/35 p-0.5">
            <Filter className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
            {DIRECTION_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDirection(opt.id)}
                className={cn(
                  "h-7 rounded-none px-2 text-[11px] font-medium transition-colors",
                  direction === opt.id
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {opt.id === "all" ? totals.all : totals[opt.id] ?? 0}
                </span>
              </button>
            ))}
          </div>
        </div>

        {connectionState.error ? (
          <div className="rounded-none border border-[hsl(var(--danger))]/30 bg-[hsl(var(--danger))]/5 px-3 py-1.5 text-[11px] text-[hsl(var(--danger))]">
            {connectionState.error}
          </div>
        ) : null}
      </header>

      <div ref={splitRef} className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div
          ref={listRef}
          className="thin-scrollbar min-h-0 w-full overflow-y-auto overflow-x-hidden"
          style={{ flexBasis: `${timelinePct}%`, flexGrow: 0, flexShrink: 0 }}
        >
          {filtered.length === 0 ? (
            <EmptyState
              mode={mode}
              url={request?.url}
              connecting={connectionState.connecting}
              connected={connectionState.connected}
            />
          ) : (
            <ul className="divide-y divide-border/25">
              {filtered.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  active={selected?.id === message.id && !followLatest}
                  onSelect={() => handleSelectRow(message.id)}
                />
              ))}
            </ul>
          )}
        </div>

        <div
          role="separator"
          aria-orientation="horizontal"
          onMouseDown={startDrag}
          onDoubleClick={() => setTimelinePct(60)}
          className="group relative h-1.5 shrink-0 cursor-row-resize border-y border-border/40 bg-border/20 transition-colors hover:bg-primary/30"
          title="Drag to resize — double click to reset"
        >
          <span className="pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 rounded-none bg-muted-foreground/40 group-hover:bg-primary/60" />
        </div>

        <div
          className="flex min-h-0 flex-col"
          style={{ flexBasis: `${100 - timelinePct}%`, flexGrow: 0, flexShrink: 0 }}
        >
          <InspectorBar
            message={selected}
            view={view}
            onViewChange={setView}
            wrap={wrap}
            onWrapChange={setWrap}
            followLatest={followLatest}
            onFollowLatest={handleFollowLatest}
          />
          <MessageInspector message={selected} view={view} wrap={wrap} />
        </div>
      </div>

      <CookieManagerModal
        open={isCookiesOpen}
        onClose={() => setIsCookiesOpen(false)}
        workspaceName={workspaceName}
        collectionName={collectionName}
      />
    </Card>
  );
}

function MessageRow({ message, active, onSelect }) {
  const tone = directionTone(message.direction, message.kind, message.event);
  const preview = (message.text || "").replace(/\s+/g, " ").slice(0, 240);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/15",
          active ? "bg-primary/5 ring-1 ring-inset ring-primary/30" : "",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-5 w-5 items-center justify-center rounded-none border border-border/40",
            tone,
          )}
        >
          {directionIcon(message.direction)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("text-[12px] font-semibold", tone)}>
              {message.event || (message.direction === "out" ? "send" : "message")}
            </span>
            {message.kind && message.kind !== "text" && message.kind !== "event" ? (
              <span className="rounded-none bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                {message.kind}
              </span>
            ) : null}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {formatTime(message.at)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {preview || "<empty>"}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground/80">
            {formatBytes(message.size)}
          </p>
        </div>
      </button>
    </li>
  );
}

function InspectorBar({ message, view, onViewChange, wrap, onWrapChange, followLatest, onFollowLatest }) {
  const [copied, setCopied] = useState(false);

  function copyPayload() {
    if (!message) return;
    const text = String(message.text ?? "");
    try {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-y border-border/40 bg-card/60 px-3 py-1.5 text-[11px] text-muted-foreground">
      {message ? (
        <>
          <span className={cn("font-semibold", directionTone(message.direction, message.kind, message.event))}>
            {message.direction === "out"
              ? "→ Sent"
              : message.direction === "system"
                ? "● System"
                : "← Received"}
          </span>
          <span className="text-border">·</span>
          <span className="truncate">{message.event || "message"}</span>
          <span className="text-border">·</span>
          <span>{formatTime(message.at)}</span>
          <span className="text-border">·</span>
          <span>{formatBytes(message.size)}</span>
        </>
      ) : (
        <span>Select a message to inspect its payload.</span>
      )}

      <div className="ml-auto flex items-center gap-1">
        {!followLatest ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[10px]"
            onClick={onFollowLatest}
            title="Jump to latest message"
          >
            <CornerDownLeft className="h-3 w-3" />
            Latest
          </Button>
        ) : null}
        <button
          type="button"
          onClick={() => onWrapChange(!wrap)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-none px-1.5 text-[10px] transition-colors",
            wrap ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
          )}
          title={wrap ? "Disable word wrap" : "Enable word wrap"}
        >
          <WrapText className="h-3 w-3" />
          Wrap
        </button>
        <div className="ml-1 flex items-center gap-0.5 rounded-none border border-border/40 p-0.5">
          <button
            type="button"
            onClick={() => onViewChange("json")}
            className={cn(
              "flex h-5 items-center gap-1 rounded-none px-1.5 text-[10px] font-medium transition-colors",
              view === "json"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Braces className="h-3 w-3" />
            JSON
          </button>
          <button
            type="button"
            onClick={() => onViewChange("raw")}
            className={cn(
              "flex h-5 items-center gap-1 rounded-none px-1.5 text-[10px] font-medium transition-colors",
              view === "raw"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileText className="h-3 w-3" />
            Raw
          </button>
        </div>
        <button
          type="button"
          onClick={copyPayload}
          disabled={!message}
          className="flex h-6 items-center gap-1 rounded-none px-1.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          title="Copy payload"
        >
          {copied ? (
            <Check className="h-3 w-3" style={{ color: "hsl(var(--success))" }} />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function MessageInspector({ message, view, wrap }) {
  if (!message) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 py-6 text-center text-muted-foreground">
        <Info className="h-4 w-4 opacity-60" />
        <p className="text-[11px]">No payload selected.</p>
      </div>
    );
  }

  const text = message.text || "";
  const truncated = text.length > MAX_INLINE_TEXT;
  const display = truncated
    ? `${text.slice(0, MAX_INLINE_TEXT)}\n\n… (${text.length - MAX_INLINE_TEXT} more chars)`
    : text;
  const parsed = tryParseJson(display);
  const showJson = view === "json" && parsed.ok;

  return (
    <div className="thin-scrollbar min-h-0 flex-1 overflow-auto bg-background/15 p-3 font-mono text-[12px] leading-relaxed">
      {showJson ? (
        <JsonTree data={parsed.value} />
      ) : (
        <pre
          className={cn(
            "min-w-0 text-foreground",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {display || <span className="text-muted-foreground">&lt;empty&gt;</span>}
        </pre>
      )}
      {view === "json" && !parsed.ok ? (
        <p className="mt-3 border-t border-border/30 pt-2 text-[10px] text-muted-foreground/70">
          Payload is not valid JSON — showing raw text. Switch to{" "}
          <span className="font-semibold text-foreground">Raw</span> for the unmodified view.
        </p>
      ) : null}
    </div>
  );
}

function EmptyState({ mode, url, connecting, connected }) {
  let hint = "Connect to start receiving messages.";
  if (connecting) hint = "Establishing connection…";
  else if (connected) hint = "Connected. Waiting for messages.";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center text-muted-foreground">
      <span className="flex h-9 w-9 items-center justify-center rounded-none border border-border/40">
        {connecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : connected ? (
          <Radio className="h-4 w-4 text-primary" />
        ) : (
          <WifiOff className="h-4 w-4" />
        )}
      </span>
      <div>
        <p className="text-[12px] font-medium text-foreground">{modeLabel(mode)} timeline</p>
        <p className="mt-1 text-[11px]">{hint}</p>
        {url ? <p className="mt-2 break-all text-[10px] text-muted-foreground/80">{url}</p> : null}
      </div>
    </div>
  );
}
