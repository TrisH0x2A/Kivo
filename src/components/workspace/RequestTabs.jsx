import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pin, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils.js";
import { getMethodTone } from "@/lib/http-ui.js";
import { REQUEST_MODES, REQUEST_MODE_OPTIONS } from "@/lib/workspace-store.js";

const REQUEST_RENAME_EVENT = "kivo:request-rename-focus";
const REQUEST_IMPORT_EVENT = "kivo:request-import-open";
const CURL_IMPORT_EVENT = "kivo:curl-import-open";

export function RequestTabs({
  requestTabs,
  activeWorkspaceName,
  activeCollectionName,
  activeRequestName,
  selectRequest,
  closeRequestTab,
  createRequestRecord,
}) {
  const [createRequestMenu, setCreateRequestMenu] = useState(null);
  const [createRequestMenuStyle, setCreateRequestMenuStyle] = useState({
    left: 8,
    top: 8,
    maxHeight: "calc(100vh - 16px)"
  });
  const [pendingRenameTarget, setPendingRenameTarget] = useState(null);
  const createMenuRef = useRef(null);

  useEffect(() => {
    if (!createRequestMenu) return;

    function handlePointer(event) {
      if (createMenuRef.current && !createMenuRef.current.contains(event.target)) {
        setCreateRequestMenu(null);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setCreateRequestMenu(null);
      }
    }

    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [createRequestMenu]);

  useLayoutEffect(() => {
    if (!createRequestMenu) return;

    function updateMenuPosition() {
      const node = createMenuRef.current;
      const viewportPadding = 8;
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      const menuWidth = Math.max(220, node?.offsetWidth || 0);
      const menuHeight = Math.max(0, node?.offsetHeight || 0);

      let left = Number(createRequestMenu.x) || viewportPadding;
      let top = Number(createRequestMenu.y) || viewportPadding;

      if (left + menuWidth > viewportWidth - viewportPadding) {
        left = Math.max(viewportPadding, viewportWidth - menuWidth - viewportPadding);
      }
      if (top + menuHeight > viewportHeight - viewportPadding) {
        top = Math.max(viewportPadding, viewportHeight - menuHeight - viewportPadding);
      }

      setCreateRequestMenuStyle({
        left,
        top,
        maxHeight: "calc(100vh - 16px)"
      });
    }

    updateMenuPosition();
    window.addEventListener("resize", updateMenuPosition);
    return () => window.removeEventListener("resize", updateMenuPosition);
  }, [createRequestMenu]);

  useEffect(() => {
    if (!pendingRenameTarget) return;
    if (!activeRequestName) return;
    if (activeRequestName === pendingRenameTarget.previousActiveRequestName) return;

    window.dispatchEvent(new CustomEvent(REQUEST_RENAME_EVENT, {
      detail: {
        workspaceName: pendingRenameTarget.workspaceName,
        collectionName: pendingRenameTarget.collectionName,
        requestName: activeRequestName,
      },
    }));
    setPendingRenameTarget(null);
  }, [activeRequestName, pendingRenameTarget]);

  function openCreateRequestMenu(event) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setCreateRequestMenu({ x: rect.left, y: rect.bottom + 6 });
  }

  function handleCreateByMode(mode) {
    if (!activeWorkspaceName || !activeCollectionName) return;

    setPendingRenameTarget({
      workspaceName: activeWorkspaceName,
      collectionName: activeCollectionName,
      previousActiveRequestName: activeRequestName,
    });
    createRequestRecord(activeWorkspaceName, activeCollectionName, "", "", mode);
    setCreateRequestMenu(null);
  }

  function handleImportRequest() {
    if (!activeWorkspaceName || !activeCollectionName) return;
    window.dispatchEvent(new CustomEvent(REQUEST_IMPORT_EVENT, {
      detail: {
        workspaceName: activeWorkspaceName,
        collectionName: activeCollectionName,
        folderPath: ""
      }
    }));
    setCreateRequestMenu(null);
  }

  function handleImportCurl() {
    if (!activeWorkspaceName || !activeCollectionName) return;
    window.dispatchEvent(new CustomEvent(CURL_IMPORT_EVENT, {
      detail: {
        workspaceName: activeWorkspaceName,
        collectionName: activeCollectionName,
        folderPath: ""
      }
    }));
    setCreateRequestMenu(null);
  }

  return (
    <div className="flex items-stretch overflow-x-auto overflow-y-hidden px-1 thin-scrollbar lg:h-[44px]">
      {requestTabs.map((request) => (
        (() => {
          const isWebSocket = request.requestMode === REQUEST_MODES.WEBSOCKET;
          const isSse = request.requestMode === REQUEST_MODES.SSE;
          const isSocketIo = request.requestMode === REQUEST_MODES.SOCKET_IO;
          const isGraphql = request.requestMode === REQUEST_MODES.GRAPHQL
            || request.bodyType === "graphql";
          const isGrpc = request.requestMode === REQUEST_MODES.GRPC
            || Boolean(String(request.grpcMethodPath || "").trim())
            || Boolean(String(request.grpcProtoFilePath || "").trim())
            || (Array.isArray(request.headers) && request.headers.some((row) => String(row?.key || "").toLowerCase() === "content-type" && String(row?.value || "").toLowerCase().includes("application/grpc")));

          const displayMethod = isWebSocket
            ? "WS"
            : (isSse ? "SSE" : (isSocketIo ? "SIO" : (isGrpc ? "gRPC" : (isGraphql ? "GQL" : request.method))));
          const methodTone = isWebSocket
            ? "tone-ws-text tone-ws-bg"
            : (isSse
              ? "tone-get-text tone-get-bg"
              : (isSocketIo
                ? "tone-sio-text tone-sio-bg"
                : (isGrpc
              ? "tone-grpc-text tone-grpc-bg"
              : (isGraphql ? "tone-gql-text tone-gql-bg" : getMethodTone(request.method)))));

          return (
            <button
              key={request.name}
              type="button"
              onClick={() => selectRequest(activeWorkspaceName, activeCollectionName, request.name)}

              className={cn(
                "group relative flex min-w-[120px] items-center gap-2 px-3 text-[12px] transition-colors lg:text-[13.5px]",
                request.name === activeRequestName
                  ? "bg-primary/10 text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]"
                  : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <span className={cn("px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] lg:text-[11px]", methodTone)}>{displayMethod}</span>
              {request.pinned ? <Pin className="h-3 w-3 shrink-0 text-primary" /> : null}
              <span className={cn("truncate", request.name === activeRequestName && "font-semibold")}>{request.name}</span>
              <span
                className="ml-auto opacity-0 transition-opacity group-hover:opacity-100"

                onClick={(event) => {
                  event.stopPropagation();
                  closeRequestTab(request.name);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </span>
            </button>
          );
        })()
      ))}

      <button
        type="button"
        onClick={openCreateRequestMenu}
        className={cn(
          "flex w-9 items-center justify-center bg-transparent text-muted-foreground hover:text-foreground transition-opacity",
          !activeWorkspaceName && "opacity-0 pointer-events-none"
        )}
      >
        <Plus className="h-4 w-4" />
      </button>

      {createRequestMenu ? createPortal(
        <div
          ref={createMenuRef}
          className="thin-scrollbar fixed z-[220] min-w-[220px] max-w-[calc(100vw-16px)] overflow-y-auto border border-border/60 bg-popover p-1 shadow-2xl"
          style={createRequestMenuStyle}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {REQUEST_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}

              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
              onClick={() => handleCreateByMode(option.value)}
            >
              <Plus className="h-3.5 w-3.5" /> {option.label}
            </button>
          ))}
          <div className="my-1 border-t border-border/40" />
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
            onClick={handleImportRequest}
          >
            <Plus className="h-3.5 w-3.5" /> Import Request
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground hover:bg-accent/45"
            onClick={handleImportCurl}
          >
            <Plus className="h-3.5 w-3.5" /> From cURL
          </button>
        </div>,
        document.body
      ) : null}
    </div>
  );
}