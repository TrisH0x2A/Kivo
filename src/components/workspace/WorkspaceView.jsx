import { RequestPane } from "@/components/workspace/RequestPane.jsx";
import { ResponsePane } from "@/components/workspace/ResponsePane.jsx";
import { StreamResponsePanel } from "@/components/workspace/StreamResponsePanel.jsx";
import { REQUEST_MODES } from "@/lib/workspace-store.js";

const STREAM_MODE_BY_REQUEST = {
  [REQUEST_MODES.WEBSOCKET]: "websocket",
  [REQUEST_MODES.SSE]: "sse",
  [REQUEST_MODES.SOCKET_IO]: "socketio",
};

export function WorkspaceView({
  request,
  requestTabs,
  isSending,
  sendStartedAt,
  onSend,
  wsState,
  onWebSocketConnect,
  onWebSocketDisconnect,
  onWebSocketSend,
  onCancelSend,
  onFieldChange,
  onUpdateActiveRequest,
  onClearResponse,
  response,
  envVars,
  collection,
  workspaceName,
  collectionName,
  streamMessages = [],
  onClearStreamMessages,
}) {
  if (!request) return null;

  const streamMode = STREAM_MODE_BY_REQUEST[request.requestMode];

  return (
    <div className="kivo-workbench">
      <div className="kivo-request-column flex min-h-0 min-w-0 flex-col overflow-hidden">
      {requestTabs && <div className="kivo-quiet-divider flex shrink-0 overflow-hidden border-b">{requestTabs}</div>}
      <div className="min-h-0 flex-1 overflow-hidden">
      <RequestPane
        key={`${workspaceName}:${collectionName}:${request.name}`}
        state={request}
        isSending={isSending}
        onSend={onSend}
        wsState={wsState}
        onWebSocketConnect={onWebSocketConnect}
        onWebSocketDisconnect={onWebSocketDisconnect}
        onWebSocketSend={onWebSocketSend}
        onChange={onFieldChange}
        onTabChange={(tab) => onUpdateActiveRequest((r) => ({ ...r, activeEditorTab: tab }))}
        onParamsChange={(queryParams) => onUpdateActiveRequest((r) => ({ ...r, queryParams }))}
        onHeadersChange={(headers) => onUpdateActiveRequest((r) => ({ ...r, headers }))}
        onAuthChange={(auth) => onUpdateActiveRequest((r) => ({ ...r, auth }))}
        envVars={envVars}
        response={response}
        workspaceName={workspaceName}
        collectionName={collectionName}
        collection={collection}
      />
      </div>
      </div>
      {streamMode ? (
        <StreamResponsePanel
          mode={streamMode}
          request={request}
          connectionState={wsState}
          messages={streamMessages}
          onClear={onClearStreamMessages}
          onCancelSend={onCancelSend}
          isSending={isSending}
          workspaceName={workspaceName}
          collectionName={collectionName}
        />
      ) : (
        <ResponsePane
          response={response}
          isSending={isSending}
          sendStartedAt={sendStartedAt}
          onCancelSend={onCancelSend}
          workspaceName={workspaceName}
          collectionName={collectionName}
          activeTab={request.activeResponseTab ?? "Body"}
          onTabChange={(tab) => onUpdateActiveRequest((r) => ({ ...r, activeResponseTab: tab }))}
          bodyView={request.responseBodyView ?? "Raw"}
          onBodyViewChange={(view) => onUpdateActiveRequest((r) => ({ ...r, responseBodyView: view }))}
          onClearResponse={onClearResponse}
        />
      )}
    </div>
  );
}
