import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Code2, Copy, Folder, FolderKanban, FolderPlus, Layers, MoreVertical, Pencil, Pin, Plus, Search, Settings, SquareKanban, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import { CodeEditor } from "@/components/workspace/CodeEditor.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Card } from "@/components/ui/card.jsx";
import { Input } from "@/components/ui/input.jsx";
import { EnvHighlightInput } from "@/components/ui/EnvHighlightInput.jsx";
import { OAuth2Panel } from "@/components/workspace/OAuth2Panel.jsx";
import { exportCollectionFile, exportRequestFile, getCollectionConfig, getEnvVars, importCollectionFile, importRequestFile } from "@/lib/http-client.js";
import { buildCurlCommand, codegenLanguageOptions, generateCodeSnippet, getMethodTone, parseCurlCommand } from "@/lib/http-ui.js";
import { createDefaultAuthState, normalizeAuthState } from "@/lib/oauth.js";
import { cn } from "@/lib/utils.js";
import { getUniqueName, REQUEST_MODE_OPTIONS, REQUEST_MODES } from "@/lib/workspace-store.js";
import { WorkspaceModal } from "./WorkspaceModal.jsx";

const AUTH_MODES = [
  { value: "inherit", label: "Inherit" },
  { value: "none", label: "No Auth" },
  { value: "basic", label: "Basic Auth" },
  { value: "bearer", label: "Bearer Token" },
  { value: "apikey", label: "API Key" },
  { value: "oauth2", label: "OAuth 2.0" },
];

function normalizeFolderPath(path) {
  return String(path ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

function useFloatingMenuPosition(menu, { minWidth = 220, viewportPadding = 8 } = {}) {
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState({
    left: viewportPadding,
    top: viewportPadding,
    maxHeight: `calc(100vh - ${viewportPadding * 2}px)`
  });

  useLayoutEffect(() => {
    if (!menu) return;

    function updatePosition() {
      const node = menuRef.current;
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      const menuWidth = Math.max(minWidth, node?.offsetWidth || 0);
      const menuHeight = Math.max(0, node?.offsetHeight || 0);

      let left = Number(menu.x) || viewportPadding;
      let top = Number(menu.y) || viewportPadding;

      if (left + menuWidth > viewportWidth - viewportPadding) {
        left = Math.max(viewportPadding, viewportWidth - menuWidth - viewportPadding);
      }
      if (top + menuHeight > viewportHeight - viewportPadding) {
        top = Math.max(viewportPadding, viewportHeight - menuHeight - viewportPadding);
      }

      setMenuStyle({
        left,
        top,
        maxHeight: `calc(100vh - ${viewportPadding * 2}px)`
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [menu, minWidth, viewportPadding]);

  return { menuRef, menuStyle };
}

const IMPORT_EXPORT_FORMATS = [
  { value: "kivo", label: "Kivo (JSON)", extension: "json" },
  { value: "postman", label: "Postman (JSON)", extension: "json" },
  { value: "openapi3.0", label: "OpenAPI 3.0", extension: "json" },
  { value: "swagger2.0", label: "Swagger 2.0", extension: "json" },
  { value: "bruno", label: "Bruno (YAML)", extension: "yml" },
];

const REQUEST_RENAME_EVENT = "kivo:request-rename-focus";
const REQUEST_IMPORT_EVENT = "kivo:request-import-open";
const CURL_IMPORT_EVENT = "kivo:curl-import-open";

const SUPPORTED_IMPORT_FORMATS_LABEL = "Supported formats: Kivo JSON, Postman, OpenAPI 3.0, Swagger 2.0, Bruno (JSON/YAML).";

const CURL_IMPORT_TARGETS = [
  { value: REQUEST_MODES.HTTP, label: "HTTP" },
  { value: REQUEST_MODES.GRAPHQL, label: "GraphQL" }
];

const COLLECTION_EXPORT_EXCLUDED_MODE_META = [
  { value: REQUEST_MODES.GRPC, label: "gRPC" },
  { value: REQUEST_MODES.WEBSOCKET, label: "WebSocket" },
  { value: REQUEST_MODES.SOCKET_IO, label: "Socket.IO" },
  { value: REQUEST_MODES.SSE, label: "Event Stream" }
];

function buildCollectionExportExclusionNotice(collection) {
  if (!collection || !Array.isArray(collection.requests) || collection.requests.length === 0) {
    return "";
  }

  const countsByMode = new Map();
  for (const request of collection.requests) {
    const mode = String(request?.requestMode || "").trim().toLowerCase();
    if (!mode) continue;
    countsByMode.set(mode, (countsByMode.get(mode) || 0) + 1);
  }

  const modeParts = COLLECTION_EXPORT_EXCLUDED_MODE_META
    .map((item) => {
      const count = countsByMode.get(item.value);
      if (!count) return null;
      return count > 1 ? `${item.label} (${count})` : item.label;
    })
    .filter(Boolean);

  if (modeParts.length === 0) {
    return "";
  }

  const totalExcluded = COLLECTION_EXPORT_EXCLUDED_MODE_META
    .reduce((sum, item) => sum + (countsByMode.get(item.value) || 0), 0);

  const requestWord = totalExcluded === 1 ? "request" : "requests";
  return `This collection contains unsupported request types: ${modeParts.join(", ")}. ${totalExcluded} ${requestWord} will be excluded from export.`;
}

function ImportExportModal({ open: isOpen, mode, scope, targetName, defaultFileName, collectionExportNotice, onClose, onConfirm }) {
  const [filePath, setFilePath] = useState("");
  const [format, setFormat] = useState("postman");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFormatMenuOpen, setIsFormatMenuOpen] = useState(false);
  const [exportEnvMode, setExportEnvMode] = useState("exclude");
  const formatMenuRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    setFilePath("");
    setFormat("postman");
    setIsSubmitting(false);
    setIsFormatMenuOpen(false);
    setExportEnvMode("exclude");
  }, [isOpen]);

  useEffect(() => {
    if (mode !== "export") return;
    if (format !== "kivo" && exportEnvMode === "preserve") {
      setExportEnvMode("exclude");
    }
  }, [mode, format, exportEnvMode]);

  useEffect(() => {
    if (!isFormatMenuOpen) return;
    function handlePointer(event) {
      if (formatMenuRef.current && !formatMenuRef.current.contains(event.target)) {
        setIsFormatMenuOpen(false);
      }
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsFormatMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isFormatMenuOpen]);

  if (!isOpen) return null;

  const modeLabel = mode === "import" ? "Import" : "Export";
  const scopeLabel = scope === "request" ? "Request" : "Collection";

  async function handleBrowse() {
    if (mode === "import") {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Collection/Request files", extensions: ["json", "yaml", "yml"] }],
      });
      if (typeof selected === "string") {
        setFilePath(selected);
      }
      return;
    }

    const selectedFormat = IMPORT_EXPORT_FORMATS.find((item) => item.value === format) || IMPORT_EXPORT_FORMATS[0];
    const selected = await save({
      defaultPath: `${defaultFileName || targetName || scopeLabel}.${selectedFormat.extension}`,
      filters: [{ name: selectedFormat.label, extensions: [selectedFormat.extension] }],
    });
    if (typeof selected === "string") {
      setFilePath(selected);
    }
  }

  async function handleSubmit() {
    if (!filePath.trim()) return;
    setIsSubmitting(true);
    try {
      await onConfirm({
        filePath,
        format,
        excludeEnvContainedFields: exportEnvMode === "exclude",
        replaceEnvVarsWithValues: exportEnvMode === "replace",
      });
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[240] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card className="w-[min(680px,92vw)] border border-border/50 bg-card/95 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-[17px] font-semibold text-foreground">{modeLabel} {scopeLabel}</h3>
            <p className="text-[12px] text-muted-foreground">{targetName || `Selected ${scopeLabel.toLowerCase()}`}</p>
            {mode === "import" ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{SUPPORTED_IMPORT_FORMATS_LABEL}</p>
            ) : null}
            {mode === "export" && scope === "collection" && format !== "kivo" && collectionExportNotice ? (
              <p className="mt-1 text-[11px] text-amber-300">{collectionExportNotice}</p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        {mode === "export" ? (
          <div className="mb-3 grid gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Format</label>
            <div ref={formatMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setIsFormatMenuOpen((open) => !open)}
                className="flex h-10 w-full items-center justify-between border border-border/40 bg-background/50 px-3 text-[13px] text-foreground outline-none transition-colors hover:bg-accent/35"
              >
                <span>{IMPORT_EXPORT_FORMATS.find((item) => item.value === format)?.label || "Select format"}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", isFormatMenuOpen && "rotate-180")} />
              </button>
              {isFormatMenuOpen && (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 border border-border/60 bg-popover p-1 shadow-2xl">
                  {IMPORT_EXPORT_FORMATS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors",
                        item.value === format ? "bg-accent/55 text-foreground" : "text-foreground hover:bg-accent/35"
                      )}
                      onClick={() => {
                        setFormat(item.value);
                        setIsFormatMenuOpen(false);
                      }}
                    >
                      <span>{item.label}</span>
                      {item.value === format ? <Check className="h-3.5 w-3.5" /> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-2 grid gap-2 border border-border/35 bg-background/30 p-3">
              <label className="flex items-center gap-2 text-[12px] text-foreground">
                <input
                  type="checkbox"
                  checked={exportEnvMode === "exclude"}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setExportEnvMode("exclude");
                    }
                  }}
                />
                Exclude env contained fields
              </label>
              <label className="flex items-center gap-2 text-[12px] text-foreground">
                <input
                  type="checkbox"
                  checked={exportEnvMode === "replace"}
                  onChange={(event) => {
                    if (event.target.checked) {
                      setExportEnvMode("replace");
                    }
                  }}
                />
                Replace env vars with values
              </label>
              {format === "kivo" ? (
                <label className="flex items-center gap-2 text-[12px] text-foreground">
                  <input
                    type="checkbox"
                    checked={exportEnvMode === "preserve"}
                    onChange={(event) => {
                      if (event.target.checked) {
                        setExportEnvMode("preserve");
                      }
                    }}
                  />
                  {"Export with env variables as-is (e.g. https://{{base_url}}/todo)"}
                </label>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="mb-3 grid gap-2">
          <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{mode === "import" ? "File" : "Save location"}</label>
          <div className="flex gap-2">
            <Input
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
              placeholder={mode === "import" ? "Choose a JSON/YAML file" : "Choose output file path"}
              className="h-10"
            />
            <Button variant="outline" type="button" className="h-10" onClick={handleBrowse}>Browse</Button>
          </div>
        </div>

        {mode === "import" ? (
          <div
            className="mb-4 flex h-28 items-center justify-center border border-dashed border-border/40 bg-accent/10 text-[12px] text-muted-foreground"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const droppedPath = event.dataTransfer?.files?.[0]?.path;
              if (droppedPath) setFilePath(droppedPath);
            }}
          >
            Drop file here or use Browse
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" type="button" className="h-9" onClick={onClose}>Cancel</Button>
          <Button type="button" className="h-9" onClick={handleSubmit} disabled={isSubmitting || !filePath.trim()}>
            {isSubmitting ? "Processing..." : `${modeLabel} ${scopeLabel}`}
          </Button>
        </div>
      </Card>
    </div>,
    document.body
  );
}

function CurlImportModal({ open: isOpen, targetName, onClose, onConfirm }) {
  const [curlCommand, setCurlCommand] = useState("");
  const [targetMode, setTargetMode] = useState(REQUEST_MODES.HTTP);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTargetMenuOpen, setIsTargetMenuOpen] = useState(false);
  const targetMenuRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    setCurlCommand("");
    setTargetMode(REQUEST_MODES.HTTP);
    setError("");
    setIsSubmitting(false);
    setIsTargetMenuOpen(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isTargetMenuOpen) return;
    function handlePointer(event) {
      if (targetMenuRef.current && !targetMenuRef.current.contains(event.target)) {
        setIsTargetMenuOpen(false);
      }
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsTargetMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isTargetMenuOpen]);

  if (!isOpen) return null;

  async function handleSubmit() {
    const trimmed = curlCommand.trim();
    if (!trimmed) {
      setError("Paste a cURL command first.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    try {
      await onConfirm({ curlCommand: trimmed, targetMode });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to import cURL command.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[240] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card className="w-[min(760px,94vw)] border border-border/50 bg-card/95 p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[17px] font-semibold text-foreground">Import Request from cURL</h3>
            <p className="text-[12px] text-muted-foreground">{targetName || "Selected collection"}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="mb-3 grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">cURL Command</label>
            <div ref={targetMenuRef} className="relative min-w-[150px]">
              <button
                type="button"
                onClick={() => setIsTargetMenuOpen((open) => !open)}
                className="flex h-9 w-full items-center justify-between border border-border/40 bg-background/50 px-3 text-[13px] text-foreground outline-none transition-colors hover:bg-accent/35"
              >
                <span>{CURL_IMPORT_TARGETS.find((item) => item.value === targetMode)?.label || "HTTP"}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", isTargetMenuOpen && "rotate-180")} />
              </button>
              {isTargetMenuOpen ? (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 border border-border/60 bg-popover p-1 shadow-2xl">
                  {CURL_IMPORT_TARGETS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors",
                        item.value === targetMode ? "bg-accent/55 text-foreground" : "text-foreground hover:bg-accent/35"
                      )}
                      onClick={() => {
                        setTargetMode(item.value);
                        setIsTargetMenuOpen(false);
                      }}
                    >
                      <span>{item.label}</span>
                      {item.value === targetMode ? <Check className="h-3.5 w-3.5" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <textarea
            value={curlCommand}
            onChange={(event) => {
              setCurlCommand(event.target.value);
              if (error) setError("");
            }}
            placeholder="Enter cURL request here..."
            className="h-40 w-full resize-none border border-border/40 bg-background/40 p-3 text-[12.5px] text-foreground outline-none transition-colors focus:border-border/70"
          />
        </div>

        {error ? <div className="mb-3 text-[12px] text-red-400">{error}</div> : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" type="button" className="h-9" onClick={onClose}>Cancel</Button>
          <Button type="button" className="h-9" onClick={handleSubmit} disabled={isSubmitting || !curlCommand.trim()}>
            {isSubmitting ? "Importing..." : "Import Request"}
          </Button>
        </div>
      </Card>
    </div>,
    document.body
  );
}

function getFolderParentPath(path) {
  const normalized = normalizeFolderPath(path);
  if (!normalized.includes("/")) return "";
  return normalized.split("/").slice(0, -1).join("/");
}

function getFolderLabel(path) {
  const normalized = normalizeFolderPath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || normalized;
}

function getRequestRecord(workspaces, workspaceName, collectionName, requestName) {
  return workspaces
    .find((w) => w.name === workspaceName)
    ?.collections?.find((c) => c.name === collectionName)
    ?.requests?.find((r) => r.name === requestName) ?? null;
}

function getRequestBaseNameByMode(mode) {
  switch (mode) {
    case REQUEST_MODES.SSE:
      return "SSE Request";
    case REQUEST_MODES.GRAPHQL:
      return "GraphQL Request";
    case REQUEST_MODES.GRPC:
      return "gRPC Request";
    case REQUEST_MODES.WEBSOCKET:
      return "WebSocket Request";
    case REQUEST_MODES.SOCKET_IO:
      return "Socket.IO Request";
    case REQUEST_MODES.HTTP:
    default:
      return "HTTP Request";
  }
}

function isRequestExportSupported(mode) {
  return mode === REQUEST_MODES.HTTP || mode === REQUEST_MODES.GRAPHQL;
}

function getRequestBadgeMeta(request) {
  const mode = request?.requestMode ?? REQUEST_MODES.HTTP;
  switch (mode) {
    case REQUEST_MODES.GRAPHQL:
      return { label: "GQL", tone: "tone-gql-text" };
    case REQUEST_MODES.GRPC:
      return { label: "gRPC", tone: "tone-grpc-text" };
    case REQUEST_MODES.WEBSOCKET:
      return { label: "WS", tone: "tone-ws-text" };
    case REQUEST_MODES.SOCKET_IO:
      return { label: "SIO", tone: "tone-sio-text" };
    case REQUEST_MODES.SSE:
      return { label: "SSE", tone: "tone-get-text" };
    case REQUEST_MODES.HTTP:
    default:
      return {
        label: String(request?.method || "GET").toUpperCase(),
        tone: getMethodTone(request?.method || "GET").split(" ")[0]
      };
  }
}

function FolderContextMenu({ menu, onCreateRequest, onCreateFolder, onOpenSettings, onCopyFolder, onPasteIntoFolder, onRevealFolder, onRename, onDelete, onClose, canPaste }) {
  const { menuRef, menuStyle } = useFloatingMenuPosition(menu, { minWidth: 180 });

  useEffect(() => {
    if (!menu) return;
    function handlePointer() { onClose(); }
    function handleEscape(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => { window.removeEventListener("mousedown", handlePointer); window.removeEventListener("keydown", handleEscape); };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div ref={menuRef} className="thin-scrollbar fixed z-[210] min-w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto border border-border/60 bg-popover p-1 shadow-2xl" style={menuStyle} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCreateRequest(menu); onClose(); }}>
        <Plus className="h-3.5 w-3.5" /> New Request
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCreateFolder(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); }}>
        <FolderPlus className="h-3.5 w-3.5" /> New Folder
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onOpenSettings(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); }}>
        <Settings className="h-3.5 w-3.5" /> Settings
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCopyFolder(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); }}>
        <Copy className="h-3.5 w-3.5" /> Copy Folder
      </button>
      <button type="button" disabled={!canPaste} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors", canPaste ? "text-foreground hover:bg-accent/45" : "text-muted-foreground opacity-50 cursor-not-allowed")} onClick={() => { if (canPaste) { onPasteIntoFolder(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); } }}>
        <Copy className="h-3.5 w-3.5" /> Paste
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onRevealFolder(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); }}>
        <FolderKanban className="h-3.5 w-3.5" /> Show in Files
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onRename(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); }}>
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-red-500 hover:bg-accent/45" onClick={() => { onDelete(menu.workspaceName, menu.collectionName, menu.folderPath); onClose(); }}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>,
    document.body
  );
}

function FolderSettingsModal({
  open,
  target,
  currentSetting,
  envVars,
  onClose,
  onSave,
}) {
  const [activeTab, setActiveTab] = useState("Headers");
  const [draft, setDraft] = useState({ defaultHeaders: [], defaultAuth: { type: "inherit" } });

  useEffect(() => {
    if (!open) return;
    setDraft({
      defaultHeaders: Array.isArray(currentSetting?.defaultHeaders) ? currentSetting.defaultHeaders : [],
      defaultAuth: normalizeAuthState(currentSetting?.defaultAuth ?? { type: "inherit" })
    });
    setActiveTab("Headers");
  }, [open, currentSetting]);

  if (!open || !target) return null;

  const auth = normalizeAuthState(draft.defaultAuth ?? { type: "inherit" });

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <Card className="grid h-[min(720px,92vh)] w-[min(860px,92vw)] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 border border-border/50 bg-card/95 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Folder Settings</div>
            <div className="mt-1 text-[18px] font-semibold text-foreground">{getFolderLabel(target.folderPath)}</div>
            <div className="text-[11px] text-muted-foreground">{target.folderPath}</div>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-8 px-3" onClick={onClose}>Close</Button>
        </div>

        <div className="flex items-center gap-1 border-b border-border/30 pb-2">
          {["Headers", "Auth"].map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "border border-transparent px-3 py-1.5 text-[12px] transition-colors",
                activeTab === tab
                  ? "border-primary/45 bg-primary/12 text-primary"
                  : "text-muted-foreground hover:border-border/35 hover:bg-accent/35 hover:text-foreground"
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="min-h-0 overflow-auto">
          {activeTab === "Headers" ? (
            <div className="space-y-2">
              {(draft.defaultHeaders || []).map((row, index) => (
                <div key={`folder-hdr-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <Input
                    className="h-8"
                    value={row.key ?? ""}
                    onChange={(event) => {
                      const next = [...(draft.defaultHeaders || [])];
                      next[index] = { ...next[index], key: event.target.value };
                      setDraft((prev) => ({ ...prev, defaultHeaders: next }));
                    }}
                    placeholder="Header name"
                  />
                  <Input
                    className="h-8"
                    value={row.value ?? ""}
                    onChange={(event) => {
                      const next = [...(draft.defaultHeaders || [])];
                      next[index] = { ...next[index], value: event.target.value };
                      setDraft((prev) => ({ ...prev, defaultHeaders: next }));
                    }}
                    placeholder="Header value"
                  />
                  <button
                    type="button"
                    className="h-8 px-2 text-red-500 hover:bg-accent/35"
                    onClick={() => {
                      const next = [...(draft.defaultHeaders || [])];
                      next.splice(index, 1);
                      setDraft((prev) => ({ ...prev, defaultHeaders: next }));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="h-8 text-[12px]"
                onClick={() => setDraft((prev) => ({ ...prev, defaultHeaders: [...(prev.defaultHeaders || []), { key: "", value: "", enabled: true }] }))}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Add Header
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex w-fit flex-wrap items-center gap-2 border border-border/35 bg-background/20 p-1">
                {AUTH_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, type: mode.value } }))}
                    className={cn(
                      "border border-transparent px-3 py-1.5 text-[12px] font-medium transition-colors",
                      auth.type === mode.value
                        ? "border-primary/45 bg-primary/12 text-primary"
                        : "text-muted-foreground hover:border-border/35 hover:bg-accent/45 hover:text-foreground"
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              {auth.type === "bearer" ? (
                <EnvHighlightInput
                  value={auth.token ?? ""}
                  onValueChange={(value) => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, token: value } }))}
                  placeholder="Bearer token"
                  inputClassName="h-10"
                  envVars={envVars}
                />
              ) : null}

              {auth.type === "basic" ? (
                <div className="grid grid-cols-1 gap-2">
                  <EnvHighlightInput value={auth.username ?? ""} onValueChange={(value) => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, username: value } }))} placeholder="Username" inputClassName="h-10" envVars={envVars} />
                  <EnvHighlightInput value={auth.password ?? ""} onValueChange={(value) => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, password: value } }))} placeholder="Password" inputClassName="h-10" envVars={envVars} />
                </div>
              ) : null}

              {auth.type === "apikey" ? (
                <div className="grid grid-cols-1 gap-2">
                  <EnvHighlightInput value={auth.apiKeyName ?? ""} onValueChange={(value) => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, apiKeyName: value } }))} placeholder="API key name" inputClassName="h-10" envVars={envVars} />
                  <EnvHighlightInput value={auth.apiKeyValue ?? ""} onValueChange={(value) => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, apiKeyValue: value } }))} placeholder="API key value" inputClassName="h-10" envVars={envVars} />
                  <div className="flex items-center gap-2">
                    {["header", "query"].map((position) => (
                      <button
                        key={position}
                        type="button"
                        onClick={() => setDraft((prev) => ({ ...prev, defaultAuth: { ...auth, apiKeyIn: position } }))}
                        className={cn(
                          "border border-transparent px-3 py-1.5 text-[12px] transition-colors",
                          (auth.apiKeyIn ?? "header") === position
                            ? "border-primary/45 bg-primary/12 text-primary"
                            : "bg-accent/30 text-muted-foreground hover:border-border/35"
                        )}
                      >
                        {position === "header" ? "Header" : "Query"}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {auth.type === "oauth2" ? (
                <OAuth2Panel
                  auth={auth}
                  envVars={envVars}
                  workspaceName={target.workspaceName}
                  collectionName={target.collectionName}
                  scopeLabel="folder"
                  onChange={(nextAuth) => setDraft((prev) => ({ ...prev, defaultAuth: nextAuth }))}
                  onPersist={async (nextAuth) => setDraft((prev) => ({ ...prev, defaultAuth: nextAuth }))}
                />
              ) : null}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" className="h-9 px-4 text-[12px]" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            className="h-9 px-4 text-[12px]"
            onClick={() => {
              onSave({
                defaultHeaders: (draft.defaultHeaders || []).map((row) => ({
                  key: String(row.key ?? "").trim(),
                  value: String(row.value ?? ""),
                  enabled: row.enabled ?? true
                })).filter((row) => row.key),
                defaultAuth: normalizeAuthState(draft.defaultAuth ?? createDefaultAuthState())
              });
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </Card>
    </div>,
    document.body
  );
}

function WorkspaceForm({ initialValues, submitLabel, onSubmit, onCancel }) {
  const [name, setName] = useState(initialValues?.name ?? "");
  const [description, setDescription] = useState(initialValues?.description ?? "");

  function handleSubmit(event) {
    event.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-2 border border-border/35 bg-card/45 p-3">
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Workspace name" />
      <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" className="h-8 px-3 text-[11px]">
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-3 text-[11px]" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RenameField({ value, onSubmit, onCancel, placeholder = "Name" }) {
  const [name, setName] = useState(value);

  return (
    <form
      className="flex items-center gap-2 px-2 py-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) {
          onSubmit(name.trim());
        }
      }}
    >
      <Input className="h-7 text-[12px]" autoFocus value={name} onChange={(event) => setName(event.target.value)} onBlur={() => onCancel()} placeholder={placeholder} />
    </form>
  );
}

function CreationField({ initialValue, existingNames, onSubmit, onCancel, placeholder = "Name" }) {
  const [name, setName] = useState(() => getUniqueName(initialValue, existingNames));
  const isDuplicate = useMemo(() => existingNames.includes(name.trim()), [name, existingNames]);
  const isValid = name.trim().length > 0 && !isDuplicate;

  function handleSubmit(e) {
    e?.preventDefault();
    if (isValid) {
      onSubmit(name.trim());
    }
  }

  return (
    <form
      className="flex items-center gap-1.5 px-1 py-1"
      onSubmit={handleSubmit}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative flex-1">
        <Input
          className={cn(
            "h-7 text-[12px] pr-7",
            isDuplicate && "border-red-500 focus-visible:ring-red-500"
          )}
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          placeholder={placeholder}
        />
        {isDuplicate && (
          <div className="absolute left-0 -bottom-4 text-[9px] text-red-500 whitespace-nowrap">
            Name already exists
          </div>
        )}
      </div>
      <button
        type="submit"
        disabled={!isValid}
        className={cn(
          "p-1 rounded hover:bg-accent transition-colors",
          isValid ? "text-green-500" : "text-muted-foreground opacity-50 cursor-not-allowed"
        )}
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="p-1 rounded hover:bg-accent text-red-500 transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}

function GenerateCodeModal({ request, language, context, isLoadingContext, onLanguageChange, onClose }) {
  const [copied, setCopied] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const languageMenuRef = useRef(null);
  const selectedLanguage = useMemo(
    () => codegenLanguageOptions.find((option) => option.value === language) ?? codegenLanguageOptions[0],
    [language]
  );
  const codeSnippet = useMemo(
    () => {
      if (!request) return "";
      if (isLoadingContext) {
        return "// Resolving environment and auth context...";
      }
      return generateCodeSnippet(request, language, context);
    },
    [context, isLoadingContext, language, request]
  );

  useEffect(() => {
    if (!request) return;
    setCopied(false);
    function handleEscape(event) {
      if (event.key === "Escape") {
        if (languageOpen) {
          setLanguageOpen(false);
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [language, languageOpen, onClose, request]);

  useEffect(() => {
    if (!languageOpen) return;
    function handlePointer(event) {
      if (languageMenuRef.current && !languageMenuRef.current.contains(event.target)) {
        setLanguageOpen(false);
      }
    }
    window.addEventListener("mousedown", handlePointer);
    return () => window.removeEventListener("mousedown", handlePointer);
  }, [languageOpen]);

  if (!request) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codeSnippet);
      setCopied(true);
    } catch (e) {
      console.error("Failed to copy", e);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Card className="grid h-[min(720px,92vh)] w-[min(920px,92vw)] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4 border border-border/50 bg-card/95 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Generate Code</div>
            <div className="mt-1 truncate text-[18px] font-semibold text-foreground">{request.name}</div>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-8 px-3" onClick={onClose}>Close</Button>
        </div>
        <div className="grid gap-2 sm:max-w-[260px]">
          <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Language</label>
          <div ref={languageMenuRef} className="relative">
            <button type="button" onClick={() => setLanguageOpen((c) => !c)} className="flex h-9 w-full items-center justify-between border border-border/40 bg-background/70 px-3 text-[12px] text-foreground outline-none transition-colors hover:bg-accent/35 focus-visible:ring-1 focus-visible:ring-ring">
              <span>{selectedLanguage.label}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", languageOpen && "rotate-180")} />
            </button>
            {languageOpen && (
              <div className="thin-scrollbar absolute left-0 right-0 top-[calc(100%+6px)] z-20 max-h-64 overflow-auto border border-border/60 bg-popover shadow-2xl">
                {codegenLanguageOptions.map((option) => {
                  const active = option.value === language;
                  return (
                    <button key={option.value} type="button" onClick={() => { onLanguageChange(option.value); setLanguageOpen(false); }} className={cn("flex w-full items-center justify-between px-3 py-2 text-left text-[12px] transition-colors", active ? "bg-accent/55 text-foreground" : "text-foreground hover:bg-accent/35")}>
                      <span>{option.label}</span>
                      {active && <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Selected</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <CodeEditor value={codeSnippet} readOnly language="text" className="border border-border/30" />
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] text-muted-foreground">{copied ? "Code copied to clipboard." : "Choose a language and copy the generated snippet."}</div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" className="h-9 px-4 text-[12px]" onClick={handleCopy}>{copied ? "Copied" : "Copy Code"}</Button>
            <Button type="button" className="h-9 px-4 text-[12px]" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Card>
    </div>,
    document.body
  );
}

function RequestContextMenu({ menu, onGenerateCode, onCopyCurl, onRename, onDuplicate, onCopy, onPaste, onExportRequest, onReveal, onTogglePin, onDelete, onClose, canPaste, canExport }) {
  const { menuRef, menuStyle } = useFloatingMenuPosition(menu, { minWidth: 180 });

  useEffect(() => {
    if (!menu) return;
    function handlePointer() { onClose(); }
    function handleEscape(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => { window.removeEventListener("mousedown", handlePointer); window.removeEventListener("keydown", handleEscape); };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div ref={menuRef} className="thin-scrollbar fixed z-[210] min-w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto border border-border/60 bg-popover p-1 shadow-2xl" style={menuStyle} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onGenerateCode(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Code2 className="h-3.5 w-3.5" /> Generate Code
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCopyCurl(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Copy className="h-3.5 w-3.5" /> Copy as cURL
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onTogglePin(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Pin className="h-3.5 w-3.5" /> {menu.pinned ? "Unpin" : "Pin"}
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCopy(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Copy className="h-3.5 w-3.5" /> Copy Request
      </button>
      <button type="button" disabled={!canPaste} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors", canPaste ? "text-foreground hover:bg-accent/45" : "text-muted-foreground opacity-50 cursor-not-allowed")} onClick={() => { if (canPaste) { onPaste(menu.workspaceName, menu.collectionName); onClose(); } }}>
        <Copy className="h-3.5 w-3.5" /> Paste
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onRename(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onDuplicate(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Copy className="h-3.5 w-3.5" /> Duplicate
      </button>
      <button
        type="button"
        disabled={!canExport}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
          canExport ? "text-foreground hover:bg-accent/45" : "text-muted-foreground opacity-50 cursor-not-allowed"
        )}
        onClick={() => {
          if (!canExport) return;
          onExportRequest(menu.workspaceName, menu.collectionName, menu.requestName);
          onClose();
        }}
      >
        <Copy className="h-3.5 w-3.5" /> Export Request
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onReveal(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <FolderKanban className="h-3.5 w-3.5" /> Show in Files
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-red-500 hover:bg-accent/45" onClick={() => { onDelete(menu.workspaceName, menu.collectionName, menu.requestName); onClose(); }}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>,
    document.body
  );
}

function CollectionContextMenu({ menu, onCreateRequest, onCreateFolder, onRename, onDuplicate, onPaste, onImportRequest, onExportCollection, onReveal, onDelete, onClose, canPaste, onOpenSettings }) {
  const { menuRef, menuStyle } = useFloatingMenuPosition(menu, { minWidth: 180 });

  useEffect(() => {
    if (!menu) return;
    function handlePointer() { onClose(); }
    function handleEscape(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => { window.removeEventListener("mousedown", handlePointer); window.removeEventListener("keydown", handleEscape); };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div ref={menuRef} className="thin-scrollbar fixed z-[210] min-w-[180px] max-w-[calc(100vw-16px)] overflow-y-auto border border-border/60 bg-popover p-1 shadow-2xl" style={menuStyle} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCreateRequest(menu.workspaceName, menu.collectionName); onClose(); }}>
        <Plus className="h-3.5 w-3.5" /> New Request
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onCreateFolder(menu.workspaceName, menu.collectionName); onClose(); }}>
        <FolderPlus className="h-3.5 w-3.5" /> New Folder
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onOpenSettings?.(); onClose(); }}>
        <Settings className="h-3.5 w-3.5" /> Settings
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" disabled={!canPaste} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors", canPaste ? "text-foreground hover:bg-accent/45" : "text-muted-foreground opacity-50 cursor-not-allowed")} onClick={() => { if (canPaste) { onPaste(menu.workspaceName, menu.collectionName); onClose(); } }}>
        <Copy className="h-3.5 w-3.5" /> Paste
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onRename(menu.workspaceName, menu.collectionName); onClose(); }}>
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onDuplicate(menu.workspaceName, menu.collectionName); onClose(); }}>
        <Copy className="h-3.5 w-3.5" /> Duplicate
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onImportRequest(menu.workspaceName, menu.collectionName, ""); onClose(); }}>
        <Plus className="h-3.5 w-3.5" /> Import Request
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onExportCollection(menu.workspaceName, menu.collectionName); onClose(); }}>
        <Copy className="h-3.5 w-3.5" /> Export Collection
      </button>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45" onClick={() => { onReveal(menu.workspaceName, menu.collectionName); onClose(); }}>
        <FolderKanban className="h-3.5 w-3.5" /> Show in Files
      </button>
      <div className="my-1 border-t border-border/40" />
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-red-500 hover:bg-accent/45" onClick={() => { onDelete(menu.workspaceName, menu.collectionName); onClose(); }}>
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </div>,
    document.body
  );
}

function RequestTypeMenu({ menu, onSelect, onImportRequest, onImportCurl, onClose }) {
  const { menuRef, menuStyle } = useFloatingMenuPosition(menu, { minWidth: 220 });

  useEffect(() => {
    if (!menu) return;
    function handlePointer() { onClose(); }
    function handleEscape(event) { if (event.key === "Escape") onClose(); }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="thin-scrollbar fixed z-[215] min-w-[220px] max-w-[calc(100vw-16px)] overflow-y-auto border border-border/60 bg-popover p-1 shadow-2xl"
      style={menuStyle}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {REQUEST_MODE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
          onClick={() => {
            onSelect(option.value, menu);
            onClose();
          }}
        >
          <Plus className="h-3.5 w-3.5" /> {option.label}
        </button>
      ))}
      <div className="my-1 border-t border-border/40" />
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
        onClick={() => {
          onImportRequest(menu);
          onClose();
        }}
      >
        <Plus className="h-3.5 w-3.5" /> Import Request
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
        onClick={() => {
          onImportCurl(menu);
          onClose();
        }}
      >
        <Plus className="h-3.5 w-3.5" /> From cURL
      </button>
    </div>,
    document.body
  );
}

export function RequestsView({
  workspaces, activeWorkspaceName, activeCollectionName, activeRequestName,
  onSelectWorkspace, onSelectCollection, onSelectRequest,
  onOpenCollectionSettings,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onDuplicateCollection,
  onImportCollection,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  onCreateRequest,
  onRenameRequest,
  onDeleteRequest,
  onDuplicateRequest,
  onImportRequests,
  onPasteRequest,
  onPasteFolder,
  onTogglePinRequest
}) {
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [editingWorkspaceName, setEditingWorkspaceName] = useState(null);
  const [editingItemId, setEditingItemId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [codegenTarget, setCodegenTarget] = useState(null);
  const [codegenContext, setCodegenContext] = useState(null);
  const [isCodegenContextLoading, setIsCodegenContextLoading] = useState(false);
  const [codegenLanguage, setCodegenLanguage] = useState("shell");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [expandedWorkspaceNames, setExpandedWorkspaceNames] = useState(() => workspaces.map((w) => w.name));
  const [expandedCollectionNames, setExpandedCollectionNames] = useState([]);
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [creatingRequestInCollection, setCreatingRequestInCollection] = useState(null);
  const [creatingFolderTarget, setCreatingFolderTarget] = useState(null);
  const [creatingRequestInFolder, setCreatingRequestInFolder] = useState(null);
  const [expandedFolderKeys, setExpandedFolderKeys] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchVisible, setIsSearchVisible] = useState(false);
  const [isWorkspaceSwitcherOpen, setIsWorkspaceSwitcherOpen] = useState(false);
  const [duplicationTarget, setDuplicationTarget] = useState(null);
  const [clipboard, setClipboard] = useState(null);
  const [collectionContextMenu, setCollectionContextMenu] = useState(null);
  const [folderContextMenu, setFolderContextMenu] = useState(null);
  const [folderSettingsTarget, setFolderSettingsTarget] = useState(null);
  const [folderSettingsEnv, setFolderSettingsEnv] = useState({ merged: {} });
  const [sidebarOptionsOpen, setSidebarOptionsOpen] = useState(false);
  const [importExportState, setImportExportState] = useState(null);
  const [curlImportState, setCurlImportState] = useState(null);
  const [createRequestMenu, setCreateRequestMenu] = useState(null);
  const sidebarOptionsRef = useRef(null);

  const activeWorkspace = useMemo(() => workspaces.find(w => w.name === activeWorkspaceName), [workspaces, activeWorkspaceName]);
  const effectiveWorkspaceName = activeWorkspace?.name ?? "";
  const collectionExportNotice = useMemo(() => {
    if (importExportState?.mode !== "export" || importExportState?.scope !== "collection") {
      return "";
    }

    const collection = workspaces
      .find((workspace) => workspace.name === importExportState.workspaceName)
      ?.collections?.find((item) => item.name === importExportState.collectionName);

    return buildCollectionExportExclusionNotice(collection);
  }, [importExportState, workspaces]);

  useEffect(() => {
    function handleRequestRename(event) {
      const detail = event?.detail || {};
      const workspaceName = String(detail.workspaceName || "");
      const collectionName = String(detail.collectionName || "");
      const requestName = String(detail.requestName || "");
      if (!workspaceName || !collectionName || !requestName) return;

      onSelectRequest(workspaceName, collectionName, requestName);
      setExpandedCollectionNames((names) => Array.from(new Set([...names, collectionName])));
      setEditingItemId(`req:${collectionName}:${requestName}`);
    }

    window.addEventListener(REQUEST_RENAME_EVENT, handleRequestRename);
    return () => {
      window.removeEventListener(REQUEST_RENAME_EVENT, handleRequestRename);
    };
  }, [onSelectRequest]);

  useEffect(() => {
    function handleImportRequestEvent(event) {
      const detail = event?.detail || {};
      const workspaceName = String(detail.workspaceName || "");
      const collectionName = String(detail.collectionName || "");
      const folderPath = normalizeFolderPath(detail.folderPath || "");
      if (!workspaceName || !collectionName) return;
      handleImportRequest(workspaceName, collectionName, folderPath);
    }

    function handleCurlImportEvent(event) {
      const detail = event?.detail || {};
      const workspaceName = String(detail.workspaceName || "");
      const collectionName = String(detail.collectionName || "");
      const folderPath = normalizeFolderPath(detail.folderPath || "");
      if (!workspaceName || !collectionName) return;
      setCurlImportState({
        workspaceName,
        collectionName,
        targetFolderPath: folderPath
      });
    }

    window.addEventListener(REQUEST_IMPORT_EVENT, handleImportRequestEvent);
    window.addEventListener(CURL_IMPORT_EVENT, handleCurlImportEvent);
    return () => {
      window.removeEventListener(REQUEST_IMPORT_EVENT, handleImportRequestEvent);
      window.removeEventListener(CURL_IMPORT_EVENT, handleCurlImportEvent);
    };
  }, []);

  useEffect(() => {
    if (!sidebarOptionsOpen) return;
    function handlePointer(event) {
      if (sidebarOptionsRef.current && !sidebarOptionsRef.current.contains(event.target)) {
        setSidebarOptionsOpen(false);
      }
    }
    function handleEscape(event) {
      if (event.key === "Escape") {
        setSidebarOptionsOpen(false);
      }
    }
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [sidebarOptionsOpen]);

  const codegenRequest = useMemo(() => {
    if (!codegenTarget) return null;
    return getRequestRecord(workspaces, codegenTarget.workspaceName, codegenTarget.collectionName, codegenTarget.requestName);
  }, [workspaces, codegenTarget]);

  async function loadExportContext(workspaceName, collectionName) {
    const [envVars, collectionConfig] = await Promise.all([
      getEnvVars(workspaceName, collectionName),
      collectionName ? getCollectionConfig(workspaceName, collectionName) : Promise.resolve({ defaultHeaders: [], defaultAuth: { type: "none" } }),
    ]);

    return {
      envVars,
      collectionConfig: {
        defaultHeaders: collectionConfig?.defaultHeaders ?? [],
        defaultAuth: collectionConfig?.defaultAuth ?? { type: "none" },
      },
    };
  }

  useEffect(() => {
    if (!codegenTarget) {
      setCodegenContext(null);
      setIsCodegenContextLoading(false);
      return;
    }

    let cancelled = false;
    setIsCodegenContextLoading(true);

    loadExportContext(codegenTarget.workspaceName, codegenTarget.collectionName)
      .then((context) => {
        if (!cancelled) {
          setCodegenContext(context);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCodegenContext(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCodegenContextLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [codegenTarget]);

  function handleGenerateCode(workspaceName, collectionName, requestName) {
    setCodegenTarget({ workspaceName, collectionName, requestName });
  }

  async function handleCopyCurl(workspaceName, collectionName, requestName) {
    const request = getRequestRecord(workspaces, workspaceName, collectionName, requestName);
    if (!request) return;
    try {
      const context = await loadExportContext(workspaceName, collectionName);
      const curl = buildCurlCommand(request, context);
      await navigator.clipboard.writeText(curl);
      setFeedbackMessage("cURL command copied to clipboard.");
      setTimeout(() => setFeedbackMessage(""), 2000);
    } catch (error) {
      console.error("Failed to copy cURL:", error);
    }
  }

  function startRenameRequest(workspaceName, collectionName, requestName) {
    onSelectRequest(workspaceName, collectionName, requestName);
    setEditingItemId(`req:${collectionName}:${requestName}`);
  }

  function openRequestContextMenu(event, workspaceName, collectionName, request) {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      workspaceName,
      collectionName,
      requestName: request.name,
      pinned: request.pinned,
      requestMode: request.requestMode
    });
  }

  function handleTogglePin(workspaceName, collectionName, requestName) {
    onTogglePinRequest(workspaceName, collectionName, requestName);
  }

  function handleDuplicateCollection(workspaceName, collectionName) {
    setDuplicationTarget({ type: 'col', workspaceName, collectionName });
  }

  function handleDuplicateRequest(workspaceName, collectionName, requestName) {
    setDuplicationTarget({ type: 'req', workspaceName, collectionName, requestName });
  }

  function handleCopyRequest(workspaceName, collectionName, requestName) {
    const request = getRequestRecord(workspaces, workspaceName, collectionName, requestName);
    if (request) {
      setClipboard({ type: 'req', request, workspaceName, collectionName });
      setFeedbackMessage(`Copied ${request.name} to clipboard.`);
      setTimeout(() => setFeedbackMessage(""), 2000);
    }
  }

  function buildFolderSnapshot(workspaceName, collectionName, folderPath) {
    const workspace = workspaces.find((item) => item.name === workspaceName);
    const collection = workspace?.collections?.find((item) => item.name === collectionName);
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    if (!collection || !normalizedFolderPath) {
      return null;
    }

    const rootName = getFolderLabel(normalizedFolderPath);
    const subtreeFolders = (Array.isArray(collection.folders) ? collection.folders : [])
      .map((path) => normalizeFolderPath(path))
      .filter((path) => path === normalizedFolderPath || path.startsWith(`${normalizedFolderPath}/`));
    const allFolders = Array.from(new Set([normalizedFolderPath, ...subtreeFolders]));

    const requests = collection.requests
      .filter((request) => {
        const requestFolder = normalizeFolderPath(request.folderPath);
        return requestFolder === normalizedFolderPath || requestFolder.startsWith(`${normalizedFolderPath}/`);
      })
      .map((request) => {
        const requestFolder = normalizeFolderPath(request.folderPath);
        const relativePath = requestFolder === normalizedFolderPath
          ? ""
          : requestFolder.slice(normalizedFolderPath.length + 1);
        return {
          relativePath,
          request
        };
      });

    const settings = (Array.isArray(collection.folderSettings) ? collection.folderSettings : [])
      .filter((setting) => {
        const path = normalizeFolderPath(setting.path);
        return path === normalizedFolderPath || path.startsWith(`${normalizedFolderPath}/`);
      })
      .map((setting) => {
        const path = normalizeFolderPath(setting.path);
        const relativePath = path === normalizedFolderPath ? "" : path.slice(normalizedFolderPath.length + 1);
        return {
          relativePath,
          defaultHeaders: Array.isArray(setting.defaultHeaders) ? setting.defaultHeaders.map((row) => ({ ...row })) : [],
          defaultAuth: normalizeAuthState(setting.defaultAuth ?? { type: "inherit" })
        };
      });

    const folders = allFolders.map((path) => (
      path === normalizedFolderPath ? "" : path.slice(normalizedFolderPath.length + 1)
    ));

    return {
      rootName,
      folders,
      requests,
      settings
    };
  }

  function handleCopyFolder(workspaceName, collectionName, folderPath) {
    const snapshot = buildFolderSnapshot(workspaceName, collectionName, folderPath);
    if (!snapshot) {
      return;
    }

    setClipboard({
      type: "folder",
      snapshot,
      workspaceName,
      collectionName
    });
    setFeedbackMessage(`Copied folder ${snapshot.rootName}.`);
    setTimeout(() => setFeedbackMessage(""), 2000);
  }

  function handlePasteIntoFolder(workspaceName, collectionName, folderPath) {
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    if (!clipboard) {
      return;
    }

    if (clipboard.type === "req") {
      onPasteRequest(workspaceName, collectionName, clipboard.request, normalizedFolderPath);
      setFeedbackMessage(`Pasted ${clipboard.request.name} into ${getFolderLabel(normalizedFolderPath)}.`);
      setTimeout(() => setFeedbackMessage(""), 2000);
      return;
    }

    if (clipboard.type === "folder") {
      onPasteFolder(workspaceName, collectionName, clipboard.snapshot, normalizedFolderPath);
      setFeedbackMessage(`Pasted folder ${clipboard.snapshot.rootName} into ${getFolderLabel(normalizedFolderPath)}.`);
      setTimeout(() => setFeedbackMessage(""), 2000);
    }
  }

  function handlePasteRequest(workspaceName, collectionName) {
    if (clipboard?.type === 'req') {

      if (clipboard.workspaceName === workspaceName && clipboard.collectionName === collectionName) {
        setFeedbackMessage("Cannot paste in the same collection.");
        setTimeout(() => setFeedbackMessage(""), 2000);
        return;
      }
      onPasteRequest(workspaceName, collectionName, clipboard.request);
      setFeedbackMessage(`Pasted ${clipboard.request.name} into ${collectionName}.`);
      setTimeout(() => setFeedbackMessage(""), 2000);
    }
  }

  function handlePasteCollectionRoot(workspaceName, collectionName) {
    if (!clipboard) {
      return;
    }

    if (clipboard.type === "req") {
      onPasteRequest(workspaceName, collectionName, clipboard.request);
      setFeedbackMessage(`Pasted ${clipboard.request.name} into ${collectionName}.`);
      setTimeout(() => setFeedbackMessage(""), 2000);
      return;
    }

    if (clipboard.type === "folder") {
      onPasteFolder(workspaceName, collectionName, clipboard.snapshot, "");
      setFeedbackMessage(`Pasted folder ${clipboard.snapshot.rootName} into ${collectionName}.`);
      setTimeout(() => setFeedbackMessage(""), 2000);
    }
  }

  async function handleImportCollection(workspaceName) {
    setImportExportState({ mode: "import", scope: "collection", workspaceName, collectionName: null, requestName: null, targetFolderPath: "" });
  }

  function handleImportRequest(workspaceName, collectionName, folderPath = "") {
    setImportExportState({ mode: "import", scope: "request", workspaceName, collectionName, requestName: null, targetFolderPath: normalizeFolderPath(folderPath) });
  }

  function handleExportCollection(workspaceName, collectionName) {
    setImportExportState({ mode: "export", scope: "collection", workspaceName, collectionName, requestName: null, targetFolderPath: "" });
  }

  function handleExportRequest(workspaceName, collectionName, requestName) {
    const request = getRequestRecord(workspaces, workspaceName, collectionName, requestName);
    if (!request || !isRequestExportSupported(request.requestMode)) {
      setFeedbackMessage("Export is available only for HTTP and GraphQL requests.");
      setTimeout(() => setFeedbackMessage(""), 2200);
      return;
    }
    setImportExportState({ mode: "export", scope: "request", workspaceName, collectionName, requestName, targetFolderPath: "" });
  }

  async function handleSubmitImportExport(payload) {
    if (!importExportState) return;
    const { mode, scope, workspaceName, collectionName, requestName, targetFolderPath } = importExportState;

    if (mode === "import" && scope === "collection") {
      const imported = await importCollectionFile(payload.filePath);
      onImportCollection(workspaceName, imported.collection);
      setFeedbackMessage(`Imported collection (${imported.detectedFormat || "auto"}).`);
      setTimeout(() => setFeedbackMessage(""), 2200);
      return;
    }

    if (mode === "import" && scope === "request") {
      const imported = await importRequestFile(payload.filePath);
      onImportRequests(workspaceName, collectionName, imported.requests || [], targetFolderPath);
      setFeedbackMessage(`Imported ${(imported.requests || []).length} request(s).`);
      setTimeout(() => setFeedbackMessage(""), 2200);
      return;
    }

    if (mode === "export" && scope === "collection") {
      const collection = workspaces
        .find((w) => w.name === workspaceName)
        ?.collections?.find((c) => c.name === collectionName);
      if (!collection) return;
      const envVars = await getEnvVars(workspaceName, collectionName);
      const exportOptions = {
        excludeEnvContainedFields: payload.excludeEnvContainedFields ?? true,
        replaceEnvVarsWithValues: payload.replaceEnvVarsWithValues ?? false,
        envVars: envVars?.merged || {},
      };
      await exportCollectionFile(payload.filePath, payload.format, collection.name, collection, exportOptions);
      setFeedbackMessage(`Exported collection (${payload.format}).`);
      setTimeout(() => setFeedbackMessage(""), 2200);
      return;
    }

    if (mode === "export" && scope === "request") {
      const request = getRequestRecord(workspaces, workspaceName, collectionName, requestName);
      if (!request) return;
      const envVars = await getEnvVars(workspaceName, collectionName);
      const exportOptions = {
        excludeEnvContainedFields: payload.excludeEnvContainedFields ?? true,
        replaceEnvVarsWithValues: payload.replaceEnvVarsWithValues ?? false,
        envVars: envVars?.merged || {},
      };
      await exportRequestFile(payload.filePath, payload.format, request.name, request, exportOptions);
      setFeedbackMessage(`Exported request (${payload.format}).`);
      setTimeout(() => setFeedbackMessage(""), 2200);
    }
  }

  async function handleSubmitCurlImport(payload) {
    if (!curlImportState) return;

    const parsed = parseCurlCommand(payload?.curlCommand || "", payload?.targetMode || REQUEST_MODES.HTTP);
    if (!parsed || !String(parsed.url || "").trim()) {
      throw new Error("Could not parse URL from the cURL command.");
    }

    onImportRequests(
      curlImportState.workspaceName,
      curlImportState.collectionName,
      [parsed],
      curlImportState.targetFolderPath
    );

    setFeedbackMessage("Imported request from cURL.");
    setTimeout(() => setFeedbackMessage(""), 2200);
  }

  async function handleReveal(workspaceName, collectionName, requestName) {
    try {
      await invoke("reveal_item", {
        workspaceName,
        collectionName: collectionName || null,
        requestName: requestName || null
      });
      setFeedbackMessage("Opening in File Explorer...");
      setTimeout(() => setFeedbackMessage(""), 2000);
    } catch (e) {
      console.error("Failed to reveal:", e);
    }
  }

  function openCollectionContextMenu(event, workspaceName, collectionName) {
    event.preventDefault();
    setCollectionContextMenu({
      x: event.clientX,
      y: event.clientY,
      workspaceName,
      collectionName
    });
  }

  function handleStartCreateFolder(workspaceName, collectionName) {
    setExpandedCollectionNames((names) => Array.from(new Set([...names, collectionName])));
    setCreatingFolderTarget({ workspaceName, collectionName, parentPath: "" });
  }

  function handleStartCreateSubfolder(workspaceName, collectionName, parentPath) {
    const folderKey = makeFolderKey(collectionName, parentPath);
    setExpandedCollectionNames((names) => Array.from(new Set([...names, collectionName])));
    setExpandedFolderKeys((keys) => Array.from(new Set([...keys, folderKey])));
    setCreatingFolderTarget({ workspaceName, collectionName, parentPath: normalizeFolderPath(parentPath) });
  }

  function handleStartCreateFolderRequest(workspaceName, collectionName, folderPath) {
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const folderKey = makeFolderKey(collectionName, normalizedFolderPath);
    setExpandedCollectionNames((names) => Array.from(new Set([...names, collectionName])));
    setExpandedFolderKeys((keys) => Array.from(new Set([...keys, folderKey])));
    setCreatingRequestInFolder(folderKey);
  }

  function handleOpenFolderCreateRequestMenu(menu) {
    if (!menu) return;
    setCreateRequestMenu({
      x: Number(menu.x || 0) + 6,
      y: Number(menu.y || 0) + 6,
      workspaceName: menu.workspaceName,
      collectionName: menu.collectionName,
      folderPath: normalizeFolderPath(menu.folderPath)
    });
  }

  function openCreateRequestMenu(event, workspaceName, collectionName, folderPath = "") {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setCreateRequestMenu({
      x: rect.left,
      y: rect.bottom + 6,
      workspaceName,
      collectionName,
      folderPath: normalizeFolderPath(folderPath)
    });
  }

  function handleCreateRequestByMode(mode, menu) {
    if (!menu) return;
    handleCreateRequestAndRename(menu.workspaceName, menu.collectionName, menu.folderPath, mode);
  }

  function handleCreateMenuImportRequest(menu) {
    if (!menu) return;
    handleImportRequest(menu.workspaceName, menu.collectionName, menu.folderPath);
  }

  function handleCreateMenuImportCurl(menu) {
    if (!menu) return;
    setCurlImportState({
      workspaceName: menu.workspaceName,
      collectionName: menu.collectionName,
      targetFolderPath: normalizeFolderPath(menu.folderPath)
    });
  }

  function handleCreateRequestAndRename(workspaceName, collectionName, folderPath = "", mode = REQUEST_MODES.HTTP) {
    const collection = workspaces
      .find((workspace) => workspace.name === workspaceName)
      ?.collections?.find((item) => item.name === collectionName);
    const existingNames = collection?.requests?.map((request) => request.name) ?? [];
    const baseName = getRequestBaseNameByMode(mode);
    const nextName = getUniqueName(baseName, existingNames);

    setExpandedCollectionNames((names) => Array.from(new Set([...names, collectionName])));
    onCreateRequest(workspaceName, collectionName, nextName, folderPath, mode);
    setEditingItemId(`req:${collectionName}:${nextName}`);
  }

  function openFolderContextMenu(event, workspaceName, collectionName, folderPath) {
    event.preventDefault();
    setFolderContextMenu({
      x: event.clientX,
      y: event.clientY,
      workspaceName,
      collectionName,
      folderPath: normalizeFolderPath(folderPath)
    });
  }

  function startRenameFolder(collectionName, folderPath) {
    setEditingItemId(`fld:${collectionName}:${normalizeFolderPath(folderPath)}`);
  }

  async function handleOpenFolderSettings(workspaceName, collectionName, folderPath) {
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    setFolderSettingsTarget({ workspaceName, collectionName, folderPath: normalizedFolderPath });
    try {
      const vars = await getEnvVars(workspaceName, collectionName);
      setFolderSettingsEnv(vars ?? { merged: {} });
    } catch {
      setFolderSettingsEnv({ merged: {} });
    }
  }

  function makeFolderKey(collectionName, folderPath) {
    return `${collectionName}::${folderPath}`;
  }

  const filteredCollections = useMemo(() => {
    if (!activeWorkspace) return [];
    if (!searchQuery.trim()) return activeWorkspace.collections;

    const query = searchQuery.toLowerCase();
    return activeWorkspace.collections.map(col => {
      const matchesCol = col.name.toLowerCase().includes(query);
      const matchedRequests = col.requests.filter(req => req.name.toLowerCase().includes(query));

      if (matchesCol) {
        return col;
      }
      if (matchedRequests.length > 0) {
        return { ...col, requests: matchedRequests };
      }
      return null;
    }).filter(Boolean);
  }, [activeWorkspace, searchQuery]);

  useEffect(() => {
    if (activeWorkspaceName) {
      setExpandedWorkspaceNames((c) => Array.from(new Set([...c, activeWorkspaceName])));
    }
  }, [activeWorkspaceName]);

  useEffect(() => {
    if (activeCollectionName) {
      setExpandedCollectionNames((c) => Array.from(new Set([...c, activeCollectionName])));
    }
  }, [activeCollectionName]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">

      <div className="relative mb-4">
        <button
          onClick={() => setIsWorkspaceSwitcherOpen(!isWorkspaceSwitcherOpen)}
          className="flex w-full items-center justify-between gap-2 border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border/35 hover:bg-accent/35"
        >
          <div className="flex items-center gap-2 min-w-0">
            <SquareKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-[14px] font-semibold text-foreground">
              {activeWorkspace?.name ?? "No workspace"}
            </span>
          </div>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isWorkspaceSwitcherOpen && "rotate-180")} />
        </button>

        {isWorkspaceSwitcherOpen && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 border border-border/60 bg-popover p-1 shadow-xl">
            {workspaces.map((w) => (
              <button
                key={w.name}
                onClick={() => {
                  onSelectWorkspace(w.name);
                  setIsWorkspaceSwitcherOpen(false);
                }}
                className={cn(
                  "flex w-full items-center border border-transparent px-3 py-2 text-left text-[12px] transition-colors hover:border-border/35 hover:bg-accent/45",
                  w.name === activeWorkspaceName ? "border-border/35 bg-accent text-foreground" : "text-foreground/80"
                )}
              >
                {w.name}
              </button>
            ))}
            <div className="my-1 border-t border-border/40" />
            <button
              onClick={() => {
                setEditingWorkspaceName(null);
                setShowWorkspaceForm(true);
                setIsWorkspaceSwitcherOpen(false);
              }}
              className="flex w-full items-center gap-2 border border-transparent px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:border-border/35 hover:bg-accent/45"
            >
              <Plus className="h-3.5 w-3.5" /> Create Workspace
            </button>
          </div>
        )}
      </div>

      {showWorkspaceForm && (
        <WorkspaceModal
          title={editingWorkspaceName ? "Rename Workspace" : "New Workspace"}
          submitLabel={editingWorkspaceName ? "Save" : "Create"}
          initialValues={editingWorkspaceName ? workspaces.find(w => w.name === editingWorkspaceName) : null}
          existingNames={workspaces.filter(w => w.name !== editingWorkspaceName).map(w => w.name)}
          onSubmit={(v) => {
            if (editingWorkspaceName) {
              onRenameWorkspace(editingWorkspaceName, v);
            } else {
              onCreateWorkspace(v);
            }
            setShowWorkspaceForm(false);
            setEditingWorkspaceName(null);
          }}
          onCancel={() => {
            setShowWorkspaceForm(false);
            setEditingWorkspaceName(null);
          }}
        />
      )}


      {activeWorkspace && (
        <>
          <div className="flex items-center justify-between px-1 mb-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <span className="text-[12px] font-semibold text-foreground">Collections</span>
            </div>
            <div className="relative flex items-center gap-1" ref={sidebarOptionsRef}>
              <button
                onClick={() => setIsSearchVisible(!isSearchVisible)}
                className={cn(
                  "border border-transparent p-1 text-muted-foreground transition-colors hover:border-border/35 hover:bg-accent hover:text-foreground",
                  isSearchVisible && "border-border/35 bg-accent text-foreground"
                )}
                title="Search"
              >
                <Search className="h-4 w-4" />
              </button>
              <button
                onClick={() => setIsCreatingCollection(true)}
                className="border border-transparent p-1 text-muted-foreground transition-colors hover:border-border/35 hover:bg-accent hover:text-foreground"
                title="Create collection"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                onClick={() => setSidebarOptionsOpen((prev) => !prev)}
                className="border border-transparent p-1 text-muted-foreground transition-colors hover:border-border/35 hover:bg-accent hover:text-foreground"
                title="Options"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {sidebarOptionsOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[210px] border border-border/60 bg-popover p-1 shadow-2xl">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
                    onClick={() => {
                      setSidebarOptionsOpen(false);
                      setIsCreatingCollection(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" /> Create New Collection
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
                    onClick={() => {
                      setSidebarOptionsOpen(false);
                      handleImportCollection(effectiveWorkspaceName);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" /> Import Collection
                  </button>
                </div>
              )}
            </div>
          </div>

          {isSearchVisible && (
            <div className="px-1 mb-3">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  autoFocus
                  className="h-8 pl-8 text-[12px] bg-background/50 border-border/40 focus:border-border/60"
                  placeholder="Search collections..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>
          )}
        </>
      )}


      <div className="flex-1 thin-scrollbar overflow-auto pr-1">
        {!activeWorkspace ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 space-y-4 opacity-80">
            <div className="border border-border/35 bg-accent/20 p-3">
              <SquareKanban className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-[13px] font-medium text-foreground">No workspace selected</p>
              <p className="text-[11px] text-muted-foreground">Select or create a workspace to start managing your collections.</p>
            </div>
            <Button
              size="sm"
              className="h-8 text-[11px]"
              onClick={() => {
                setEditingWorkspaceName(null);
                setShowWorkspaceForm(true);
              }}
            >
              <Plus className="mr-2 h-3.5 w-3.5" /> Create Workspace
            </Button>
          </div>
        ) : (
          <div className="space-y-0.5">
            {isCreatingCollection && (
              <div className="mb-2">
                <CreationField
                  initialValue="New Collection"
                  existingNames={activeWorkspace?.collections.map(c => c.name) || []}
                  onSubmit={(name) => {
                    onCreateCollection(effectiveWorkspaceName, name);
                    setIsCreatingCollection(false);
                  }}
                  onCancel={() => setIsCreatingCollection(false)}
                  placeholder="Collection name"
                />
              </div>
            )}
            {filteredCollections.map((col) => {
              const isColExpanded = expandedCollectionNames.includes(col.name) || searchQuery.trim() !== "";
              const isColEditing = editingItemId === `col:${col.name}`;
              const isActive = col.name === activeCollectionName;

              return (
                <div
                  key={`col-container-${col.name}`}
                  className="space-y-0.5 rounded transition-colors"
                >
                  {isColEditing ? (
                    <RenameField value={col.name} onSubmit={(n) => { onRenameCollection(effectiveWorkspaceName, col.name, n); setEditingItemId(null); }} onCancel={() => setEditingItemId(null)} />
                  ) : (
                    <div
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectCollection(effectiveWorkspaceName, col.name);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingItemId(`col:${col.name}`);
                      }}
                      onContextMenu={(e) => openCollectionContextMenu(e, effectiveWorkspaceName, col.name)}
                      className={cn(
                        "group flex items-center gap-1 px-1 py-1 rounded transition-colors cursor-pointer select-none",
                        isActive ? "bg-accent/40 text-foreground" : "text-foreground/80 hover:bg-accent/20"
                      )}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedCollectionNames((c) =>
                            c.includes(col.name) ? c.filter((n) => n !== col.name) : [...c, col.name]
                          );
                        }}
                        className="text-muted-foreground hover:text-foreground p-0.5"
                      >
                        {isColExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <div className="truncate text-[12.5px] font-medium flex-1 text-left">
                        {col.name}
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(event) => openCreateRequestMenu(event, effectiveWorkspaceName, col.name, "")}
                          className="p-1 text-muted-foreground hover:text-foreground"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" onClick={(e) => {
                          e.stopPropagation();
                          setEditingWorkspaceName(null);
                          setEditingItemId(`col:${col.name}`);
                        }} className="p-1 text-muted-foreground hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                        <button type="button" onClick={() => onDeleteCollection(effectiveWorkspaceName, col.name)} className="p-1 text-muted-foreground hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  )}
                  {isColExpanded && (
                    <div className="space-y-0.5 ml-3 pl-2 border-l border-border/30">
                      {(() => {
                        const folders = Array.from(
                          new Set([
                            ...(Array.isArray(col.folders) ? col.folders : []),
                            ...col.requests
                              .map((request) => normalizeFolderPath(request.folderPath))
                              .filter(Boolean)
                          ])
                        )
                          .map((path) => normalizeFolderPath(path))
                          .filter(Boolean)
                          .sort((left, right) => left.localeCompare(right));

                        const childFoldersByParent = folders.reduce((accumulator, folderPath) => {
                          const parentPath = getFolderParentPath(folderPath);
                          if (!accumulator[parentPath]) {
                            accumulator[parentPath] = [];
                          }
                          accumulator[parentPath].push(folderPath);
                          return accumulator;
                        }, {});

                        Object.values(childFoldersByParent).forEach((folderList) => folderList.sort((left, right) => left.localeCompare(right)));

                        const requestsByFolder = col.requests.reduce((accumulator, request) => {
                          const path = normalizeFolderPath(request.folderPath);
                          if (!accumulator[path]) {
                            accumulator[path] = [];
                          }
                          accumulator[path].push(request);
                          return accumulator;
                        }, {});

                        const rootRequests = requestsByFolder[""] ?? [];

                        function renderRequestRow(req, reqIdx) {
                          const isReqEditing = editingItemId === `req:${col.name}:${req.name}`;
                          const isReqActive = req.name === activeRequestName && col.name === activeCollectionName;
                          const badge = getRequestBadgeMeta(req);
                          return (
                            <div key={`req-${col.name}-${req.name}-${reqIdx}`}>
                              {isReqEditing ? (
                                <RenameField
                                  value={req.name}
                                  onSubmit={(n) => {
                                    onRenameRequest(effectiveWorkspaceName, col.name, req.name, n);
                                    setEditingItemId(null);
                                  }}
                                  onCancel={() => setEditingItemId(null)}
                                />
                              ) : (
                                <div
                                  onClick={() => onSelectRequest(effectiveWorkspaceName, col.name, req.name)}
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    setEditingItemId(`req:${col.name}:${req.name}`);
                                  }}
                                  className={cn(
                                    "group flex items-center gap-2 px-2 py-1 text-[12px] rounded transition-colors cursor-pointer select-none",
                                    isReqActive ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent/35 hover:text-foreground"
                                  )}
                                  onContextMenu={(e) => openRequestContextMenu(e, effectiveWorkspaceName, col.name, req)}
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                    <span className={cn("text-[10px] font-bold uppercase w-8 shrink-0", badge.tone)}>{badge.label}</span>
                                    {req.pinned && <Pin className="h-3 w-3 text-primary shrink-0" />}
                                    <span className="truncate">{req.name}</span>
                                  </div>
                                  <div className="flex items-center opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                                    <button type="button" className="p-1 text-muted-foreground hover:text-red-500" onClick={() => onDeleteRequest(effectiveWorkspaceName, col.name, req.name)}><Trash2 className="h-3.5 w-3.5" /></button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        }

                        return (
                          <>
                            {(childFoldersByParent[""] || []).map((folderPath) => {
                              function renderFolderNode(path) {
                                const folderPath = normalizeFolderPath(path);
                                const folderKey = makeFolderKey(col.name, folderPath);
                                const isFolderExpanded = expandedFolderKeys.includes(folderKey) || searchQuery.trim() !== "";
                                const isFolderEditing = editingItemId === `fld:${col.name}:${folderPath}`;
                                const childFolders = childFoldersByParent[folderPath] || [];
                                const folderRequests = requestsByFolder[folderPath] || [];

                                return (
                                  <div key={`folder-${folderKey}`}>
                                    {isFolderEditing ? (
                                      <RenameField
                                        value={getFolderLabel(folderPath)}
                                        onSubmit={(newName) => {
                                          onRenameFolder(effectiveWorkspaceName, col.name, folderPath, newName);
                                          setEditingItemId(null);
                                        }}
                                        onCancel={() => setEditingItemId(null)}
                                      />
                                    ) : (
                                      <div
                                        className="group flex items-center gap-1 px-1.5 py-1 text-[11.5px] text-muted-foreground rounded hover:bg-accent/25"
                                        onContextMenu={(event) => openFolderContextMenu(event, effectiveWorkspaceName, col.name, folderPath)}
                                        onDoubleClick={(event) => {
                                          event.stopPropagation();
                                          startRenameFolder(col.name, folderPath);
                                        }}
                                      >
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setExpandedFolderKeys((keys) =>
                                              keys.includes(folderKey) ? keys.filter((key) => key !== folderKey) : [...keys, folderKey]
                                            );
                                          }}
                                          className="text-muted-foreground hover:text-foreground p-0.5"
                                        >
                                          {isFolderExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                        </button>
                                        <Folder className="h-3.5 w-3.5 shrink-0" />
                                        <span className="truncate flex-1">{getFolderLabel(folderPath)}</span>
                                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100" onClick={(event) => event.stopPropagation()}>
                                          <button
                                            type="button"
                                            onClick={() => handleStartCreateFolderRequest(effectiveWorkspaceName, col.name, folderPath)}
                                            className="p-0.5 text-muted-foreground hover:text-foreground"
                                            title="New request"
                                          >
                                            <Plus className="h-3.5 w-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => startRenameFolder(col.name, folderPath)}
                                            className="p-0.5 text-muted-foreground hover:text-foreground"
                                            title="Rename"
                                          >
                                            <Pencil className="h-3.5 w-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => onDeleteFolder(effectiveWorkspaceName, col.name, folderPath)}
                                            className="p-0.5 text-muted-foreground hover:text-red-500"
                                            title="Delete"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      </div>
                                    )}

                                    {isFolderExpanded ? (
                                      <div className="ml-3 space-y-0.5 border-l border-border/20 pl-2">
                                        {childFolders.map((childPath) => renderFolderNode(childPath))}
                                        {folderRequests.map((request, index) => renderRequestRow(request, index))}

                                        {creatingRequestInFolder === folderKey ? (
                                          <CreationField
                                            initialValue="New Request"
                                            existingNames={col.requests.map((request) => request.name)}
                                            onSubmit={(name) => {
                                              onCreateRequest(effectiveWorkspaceName, col.name, name, folderPath);
                                              setEditingItemId(`req:${col.name}:${name}`);
                                              setCreatingRequestInFolder(null);
                                            }}
                                            onCancel={() => setCreatingRequestInFolder(null)}
                                            placeholder="Request name"
                                          />
                                        ) : null}

                                        {creatingFolderTarget?.collectionName === col.name && creatingFolderTarget?.parentPath === folderPath ? (
                                          <CreationField
                                            initialValue="New Folder"
                                            existingNames={folders.filter((existingPath) => getFolderParentPath(existingPath) === folderPath).map((existingPath) => getFolderLabel(existingPath))}
                                            onSubmit={(folderName) => {
                                              const fullPath = normalizeFolderPath(`${folderPath}/${folderName}`);
                                              onCreateFolder(effectiveWorkspaceName, col.name, fullPath);
                                              setCreatingFolderTarget(null);
                                              setExpandedFolderKeys((keys) => Array.from(new Set([...keys, makeFolderKey(col.name, fullPath)])));
                                            }}
                                            onCancel={() => setCreatingFolderTarget(null)}
                                            placeholder="Folder name"
                                          />
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                );
                              }

                              return renderFolderNode(folderPath);
                            })}

                            {rootRequests.map((req, reqIdx) => renderRequestRow(req, reqIdx))}
                          </>
                        );
                      })()}

                      {creatingFolderTarget?.collectionName === col.name && creatingFolderTarget?.parentPath === "" ? (
                        <CreationField
                          initialValue="New Folder"
                          existingNames={Array.from(new Set((Array.isArray(col.folders) ? col.folders : []).map((folderPath) => getFolderLabel(folderPath))))}
                          onSubmit={(folderName) => {
                            const fullPath = normalizeFolderPath(folderName);
                            onCreateFolder(effectiveWorkspaceName, col.name, fullPath);
                            setCreatingFolderTarget(null);
                            setExpandedFolderKeys((keys) => Array.from(new Set([...keys, makeFolderKey(col.name, fullPath)])));
                          }}
                          onCancel={() => setCreatingFolderTarget(null)}
                          placeholder="Folder name"
                        />
                      ) : null}

                      {creatingRequestInCollection === col.name && (
                        <CreationField
                          initialValue="New Request"
                          existingNames={col.requests.map(r => r.name)}
                          onSubmit={(name) => {
                            onCreateRequest(effectiveWorkspaceName, col.name, name);
                            setEditingItemId(`req:${col.name}:${name}`);
                            setCreatingRequestInCollection(null);
                          }}
                          onCancel={() => setCreatingRequestInCollection(null)}
                          placeholder="Request name"
                        />
                      )}
                      {!col.requests.length && !searchQuery && !creatingRequestInCollection && (
                        <button
                          type="button"
                          onClick={(event) => openCreateRequestMenu(event, effectiveWorkspaceName, col.name, "")}
                          className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Plus className="h-3 w-3" /> New Request
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!filteredCollections.length && searchQuery && (
              <div className="text-center py-8 text-muted-foreground text-[12px]">
                No results found for "{searchQuery}"
              </div>
            )}
          </div>
        )}
      </div>

      <RequestContextMenu
        menu={contextMenu}
        onGenerateCode={handleGenerateCode}
        onCopyCurl={handleCopyCurl}
        onRename={startRenameRequest}
        onDuplicate={handleDuplicateRequest}
        onCopy={handleCopyRequest}
        onPaste={handlePasteRequest}
        onExportRequest={handleExportRequest}
        onReveal={handleReveal}
        onTogglePin={handleTogglePin}
        onDelete={onDeleteRequest}
        onClose={() => setContextMenu(null)}
        canPaste={Boolean(clipboard) && (clipboard.workspaceName !== contextMenu?.workspaceName || clipboard.collectionName !== contextMenu?.collectionName)}
        canExport={isRequestExportSupported(contextMenu?.requestMode)}
      />
      <CollectionContextMenu
        menu={collectionContextMenu}
        onCreateRequest={(workspaceName, collectionName) => handleCreateRequestAndRename(workspaceName, collectionName)}
        onCreateFolder={handleStartCreateFolder}
        onRename={(workspaceName, collectionName) => setEditingItemId(`col:${collectionName}`)}
        onDuplicate={handleDuplicateCollection}
        onPaste={handlePasteCollectionRoot}
        onImportRequest={handleImportRequest}
        onExportCollection={handleExportCollection}
        onReveal={handleReveal}
        onDelete={onDeleteCollection}
        onOpenSettings={onOpenCollectionSettings}
        onClose={() => setCollectionContextMenu(null)}
        canPaste={Boolean(clipboard)}
      />
      <FolderContextMenu
        menu={folderContextMenu}
        onCreateRequest={handleOpenFolderCreateRequestMenu}
        onCreateFolder={handleStartCreateSubfolder}
        onOpenSettings={handleOpenFolderSettings}
        onCopyFolder={handleCopyFolder}
        onPasteIntoFolder={handlePasteIntoFolder}
        onRevealFolder={(workspaceName, collectionName) => handleReveal(workspaceName, collectionName, null)}
        onRename={(workspaceName, collectionName, folderPath) => startRenameFolder(collectionName, folderPath)}
        onDelete={onDeleteFolder}
        onClose={() => setFolderContextMenu(null)}
        canPaste={Boolean(clipboard)}
      />
      <FolderSettingsModal
        open={Boolean(folderSettingsTarget)}
        target={folderSettingsTarget}
        envVars={folderSettingsEnv}
        currentSetting={
          folderSettingsTarget
            ? workspaces
              .find((workspace) => workspace.name === folderSettingsTarget.workspaceName)
              ?.collections?.find((collection) => collection.name === folderSettingsTarget.collectionName)
              ?.folderSettings?.find((setting) => normalizeFolderPath(setting.path) === folderSettingsTarget.folderPath)
            : null
        }
        onClose={() => setFolderSettingsTarget(null)}
        onSave={(settings) => {
          if (!folderSettingsTarget) return;
          onUpdateFolderSettings(
            folderSettingsTarget.workspaceName,
            folderSettingsTarget.collectionName,
            folderSettingsTarget.folderPath,
            settings
          );
        }}
      />
      <ImportExportModal
        open={Boolean(importExportState)}
        mode={importExportState?.mode}
        scope={importExportState?.scope}
        collectionExportNotice={collectionExportNotice}
        targetName={importExportState?.scope === "request"
          ? importExportState?.requestName
          : importExportState?.collectionName}
        defaultFileName={
          importExportState?.scope === "request"
            ? importExportState?.requestName || "request"
            : importExportState?.collectionName || "collection"
        }
        onClose={() => setImportExportState(null)}
        onConfirm={handleSubmitImportExport}
      />
      <RequestTypeMenu
        menu={createRequestMenu}
        onSelect={handleCreateRequestByMode}
        onImportRequest={handleCreateMenuImportRequest}
        onImportCurl={handleCreateMenuImportCurl}
        onClose={() => setCreateRequestMenu(null)}
      />
      <CurlImportModal
        open={Boolean(curlImportState)}
        targetName={curlImportState ? `${curlImportState.collectionName}${curlImportState.targetFolderPath ? ` / ${curlImportState.targetFolderPath}` : ""}` : ""}
        onClose={() => setCurlImportState(null)}
        onConfirm={handleSubmitCurlImport}
      />
      {duplicationTarget && (
        <WorkspaceModal
          title={duplicationTarget.type === 'col' ? "Duplicate Collection" : "Duplicate Request"}
          submitLabel="Duplicate"
          initialValues={{
            name: getUniqueName((duplicationTarget.type === 'col' ? duplicationTarget.collectionName : duplicationTarget.requestName) + " Copy",
              duplicationTarget.type === 'col'
                ? workspaces.find(w => w.name === duplicationTarget.workspaceName)?.collections.map(c => c.name) || []
                : workspaces.find(w => w.name === duplicationTarget.workspaceName)?.collections.find(c => c.name === duplicationTarget.collectionName)?.requests.map(r => r.name) || []
            )
          }}
          existingNames={
            duplicationTarget.type === 'col'
              ? workspaces.find(w => w.name === duplicationTarget.workspaceName)?.collections.map(c => c.name) || []
              : workspaces.find(w => w.name === duplicationTarget.workspaceName)?.collections.find(c => c.name === duplicationTarget.collectionName)?.requests.map(r => r.name) || []
          }
          onSubmit={(v) => {
            if (duplicationTarget.type === 'col') {
              onDuplicateCollection(duplicationTarget.workspaceName, duplicationTarget.collectionName, v.name);
            } else {
              onDuplicateRequest(duplicationTarget.workspaceName, duplicationTarget.collectionName, duplicationTarget.requestName, v.name);
            }
            setDuplicationTarget(null);
          }}
          onCancel={() => setDuplicationTarget(null)}
        />
      )}
      {feedbackMessage && <div className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 border border-border/50 bg-card/95 px-3 py-2 text-[12px] text-foreground shadow-xl">{feedbackMessage}</div>}
      <GenerateCodeModal request={codegenRequest} language={codegenLanguage} context={codegenContext} isLoadingContext={isCodegenContextLoading} onLanguageChange={setCodegenLanguage} onClose={() => setCodegenTarget(null)} />
    </div>
  );
}

export function Sidebar({
  iconSrc, sidebarTab, collapsed, workspaces, activeWorkspaceName, activeCollectionName, activeRequestName,
  onSidebarTabChange, onSelectWorkspace, onSelectCollection, onSelectRequest,
  onCreateWorkspace, onRenameWorkspace, onDeleteWorkspace,
  onCreateCollection, onRenameCollection, onDeleteCollection, onDuplicateCollection, onImportCollection,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  onCreateRequest, onRenameRequest, onDeleteRequest, onDuplicateRequest, onImportRequests, onPasteRequest, onPasteFolder, onTogglePinRequest,
  onOpenCollectionSettings,
  onOpenAppSettings,
}) {
  return (
    <aside className={cn("grid h-full min-h-0 overflow-hidden border-r border-border/30 bg-border/20", collapsed ? "grid-cols-[52px]" : "grid-cols-[52px_minmax(0,1fr)] gap-px")}>
      <Card data-tauri-drag-region className="flex min-h-0 flex-col items-center gap-2 bg-[hsl(var(--sidebar))]/96 p-2.5 shadow-none">
        <div className="flex h-8 w-8 items-center justify-center overflow-hidden bg-card/85"><img src={iconSrc} alt="Kivo" className="h-6 w-6 object-contain" /></div>
        <Button variant={sidebarTab === "requests" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" onClick={() => onSidebarTabChange("requests")}><SquareKanban className="h-4 w-4" /></Button>
        <Button variant={sidebarTab === "settings" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" onClick={() => onOpenAppSettings?.()}><Settings className="h-4 w-4" /></Button>
        <div className="mt-auto" />
      </Card>
      {!collapsed && (
        <Card className="flex min-h-0 flex-col gap-3 overflow-hidden bg-[hsl(var(--sidebar))]/98 p-2 text-[12px] text-[hsl(var(--sidebar-foreground))] shadow-none">
          <RequestsView
            workspaces={workspaces}
            activeWorkspaceName={activeWorkspaceName}
            activeCollectionName={activeCollectionName}
            activeRequestName={activeRequestName}
            onSelectWorkspace={onSelectWorkspace}
            onSelectCollection={onSelectCollection}
            onSelectRequest={onSelectRequest}
            onOpenCollectionSettings={onOpenCollectionSettings}
            onCreateWorkspace={onCreateWorkspace}
            onRenameWorkspace={onRenameWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            onCreateCollection={onCreateCollection}
            onRenameCollection={onRenameCollection}
            onDeleteCollection={onDeleteCollection}
            onDuplicateCollection={onDuplicateCollection}
            onImportCollection={onImportCollection}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onUpdateFolderSettings={onUpdateFolderSettings}
            onCreateRequest={onCreateRequest}
            onRenameRequest={onRenameRequest}
            onDeleteRequest={onDeleteRequest}
            onDuplicateRequest={onDuplicateRequest}
            onImportRequests={onImportRequests}
            onPasteRequest={onPasteRequest}
            onPasteFolder={onPasteFolder}
            onTogglePinRequest={onTogglePinRequest}
          />
        </Card>
      )}
    </aside>
  );
}
