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
  workspaceName,
  collectionName,
  streamMessages = [],
  onClearStreamMessages,
}) {
  if (!request) return null;

  const streamMode = STREAM_MODE_BY_REQUEST[request.requestMode];

  return (
    <div className="grid h-full min-h-0 gap-2 overflow-hidden bg-transparent lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)] xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.75fr)]">
      <RequestPane
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
      />
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
