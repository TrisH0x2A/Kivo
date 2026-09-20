import React from "react";
import { createRoot } from "react-dom/client";
import { createCollection, createDefaultStore, createEmptyResponse, createRequest, createWorkspace, REQUEST_MODES } from "../../src/lib/workspace-store.js";
import "../../src/index.css";

// This standalone Vite fixture never connects to native storage or transports.
if (!import.meta.env.DEV || window.__TAURI_INTERNALS__) throw new Error("UI fixture requires a development browser");
const collection = createCollection("Gateway Services");
collection.requests = Object.values(REQUEST_MODES).map((mode) => ({
  ...createRequest(`${mode.toUpperCase()} Request`, mode),
  url: mode === REQUEST_MODES.GRPC ? "grpcb.in:9000" : "https://api.example.com/v1/users",
  activeEditorTab: "Headers",
  body: mode === REQUEST_MODES.GRPC ? '{"name":"Kivo","count":2}' : "",
  responseBodyView: mode === REQUEST_MODES.GRPC ? "Messages" : "Tree",
  lastResponse: [REQUEST_MODES.GRPC, REQUEST_MODES.HTTP].includes(mode) ? {
    ...createEmptyResponse(), status: 200, badge: "200 OK", statusText: "OK", duration: "42 ms", size: "96 B", savedAt: "UI fixture",
    isJson: true, body: '[{"id":1,"message":"Synthetic preview response"},{"id":2,"message":"Second preview message"}]',
    rawBody: '[{"id":1,"message":"Synthetic preview response"},{"id":2,"message":"Second preview message"}]',
    headers: mode === REQUEST_MODES.GRPC ? { "x-kivo-grpc-mode": "server_stream", "content-type": "application/json" } : { "content-type": "application/json" },
  } : null,
  headers: [{ id: "accept", key: "Accept", value: "application/json", enabled: true }, { id: "trace", key: "X-Correlation-Id", value: "fixture-123", enabled: true }],
}));
collection.openRequestNames = collection.requests.slice(0, 3).map((request) => request.name);
const workspace = { ...createWorkspace("UI Fixture"), collections: [collection], activeCollectionName: collection.name };
let state = { ...createDefaultStore(), storagePath: "fixture-only", workspaces: [workspace], activeWorkspaceName: workspace.name, activeCollectionName: collection.name, activeRequestName: collection.requests[0].name };
let config = { defaultHeaders: [], defaultAuth: { type: "none" }, scripts: { preRequest: "", postResponse: "" } };
const env = { workspace: [{ key: "baseUrl", value: "https://api.example.com" }], collection: [], merged: { baseUrl: "https://api.example.com" } };
let callbackId = 0;
let activeEnvironmentId = "default";
const environments = [{ id: "default", name: "Default" }, { id: "staging", name: "Staging" }];
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback: () => ++callbackId,
  unregisterCallback() {},
  async invoke(command, args = {}) {
    switch (command) {
      case "get_app_config": return { storagePath: "fixture-only" };
      case "load_app_state": return structuredClone(state);
      case "save_app_state": state = structuredClone(args.payload); return;
      case "get_or_create_auth_secret_seed": return "synthetic-ui-fixture-seed";
      case "get_resolved_storage_path": return "fixture-only";
      case "get_app_settings": return state.appSettings;
      case "set_app_settings": state.appSettings = args.settings; return args.settings;
      case "get_env_vars": return structuredClone(env);
      case "get_collection_config": return structuredClone(config);
      case "save_collection_config": config = structuredClone(args.config); return;
      case "get_workspace_environments_cmd": return { activeEnvironmentId, environments };
      case "set_active_workspace_environment_cmd": activeEnvironmentId = args.environmentId; return { activeEnvironmentId, environments };
      case "get_cookie_jar": return [];
      case "plugin:event|listen": return ++callbackId;
      case "plugin:event|unlisten": return;
      case "plugin:app|version": return "0.4.1";
      case "plugin:updater|check": return null;
      default: throw new Error(`Native action disabled in UI fixture: ${command}`);
    }
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
const { default: App } = await import("../../src/app/App.jsx");
createRoot(document.getElementById("root")).render(<App />);
