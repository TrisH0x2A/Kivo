import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let model;
before(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-ui-tests",
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ["@tauri-apps/api"] },
    server: { middlewareMode: true, hmr: false }, appType: "custom",
    plugins: [{
      name: "render-test-native-events",
      enforce: "pre",
      resolveId(id) { if (id === "@tauri-apps/api/event") return "\0test-native-events"; },
      load(id) { if (id === "\0test-native-events") return "export async function listen() { return () => {}; }"; },
    }],
  });
  model = await server.ssrLoadModule("/src/lib/workspace-store.js");
});
after(async () => { await server?.close(); });
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test("all request protocols retain their editor and response regions", async () => {
  const { WorkspaceView } = await server.ssrLoadModule("/src/components/workspace/WorkspaceView.jsx");
  for (const mode of Object.values(model.REQUEST_MODES)) {
    const html = render(WorkspaceView, {
      request: model.createRequest("Render fixture", mode),
      response: model.createEmptyResponse(), envVars: { merged: {} },
    });
    assert.match(html, /aria-label="Request editor"/, mode);
    assert.match(html, /aria-label="(Response|Stream) inspector"/, mode);
    assert.match(html, /kivo-workbench/, mode);
  }
});

test("request tab close actions are independent accessible buttons", async () => {
  const { RequestTabs } = await server.ssrLoadModule("/src/components/workspace/RequestTabs.jsx");
  const html = render(RequestTabs, {
    requestTabs: [model.createRequest("Health")], activeRequestName: "Health", activeWorkspaceName: "Demo",
  });
  assert.match(html, /aria-label="Close Health"/);
  assert.match(html, /aria-label="New request"/);
  assert.match(html, /aria-pressed="true"/);
  assert.equal((html.match(/<button/g) || []).length, 3);
});

test("disabled empty tables cannot add a row", async () => {
  const { TableEditor } = await server.ssrLoadModule("/src/components/workspace/RequestTableEditor.jsx");
  const html = render(TableEditor, { rows: [], onChange() {}, title: "Headers", addLabel: "Add", disabled: true });
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.ok(buttons.length > 0);
  assert.ok(buttons.every((button) => button.includes('disabled=""')));
});

test("workbench chrome uses real status and accessible command controls", async () => {
  const { WorkbenchHeader, WorkbenchStatusBar } = await server.ssrLoadModule("/src/components/workspace/WorkbenchChrome.jsx");
  const header = render(WorkbenchHeader, { workspaces: [{ name: "Demo" }], workspaceName: "Demo", collectionName: "Gateway" });
  assert.match(header, /aria-label="Active environment"/);
  assert.match(header, /aria-label="Search requests and commands"/);
  assert.match(header, /aria-label="New workspace"/);
  const footer = render(WorkbenchStatusBar, { request: { requestMode: "grpc" }, isSending: true });
  assert.match(footer, /Request in progress/);
  assert.doesNotMatch(footer, /Proxy Connected|TLS v1|Saved/);
});

test("workspace picker follows sidebar width and exposes a themed listbox trigger", async () => {
  const { WorkbenchHeader } = await server.ssrLoadModule("/src/components/workspace/WorkbenchChrome.jsx");
  const name = "Production workspace with a deliberately long name";
  const header = render(WorkbenchHeader, { workspaces: [{ name }], workspaceName: name, sidebarWidth: 220 });
  assert.match(header, /--workspace-region-width:220px/);
  assert.match(header, /<button[^>]*aria-label="Workspace"[^>]*aria-haspopup="listbox"/);
  assert.doesNotMatch(header, /<select[^>]*aria-label="Workspace"/);
  assert.ok(header.includes(`title="${name}"`));
  const collapsed = render(WorkbenchHeader, { workspaces: [], sidebarWidth: 0 });
  assert.match(collapsed, /--workspace-region-width:260px/);
  assert.match(collapsed, /No workspace/);
});

test("select menus handle empty options without losing their accessible label", async () => {
  const { SelectMenu } = await server.ssrLoadModule("/src/components/workspace/SelectMenu.jsx");
  const html = render(SelectMenu, { value: "", options: [], ariaLabel: "Workspace", constrainWidth: true });
  assert.match(html, /aria-label="Workspace"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /No options/);
});

test("command search retains keyboard semantics and scoped scrolling", async () => {
  const { WorkbenchSearch } = await server.ssrLoadModule("/src/components/workspace/WorkbenchChrome.jsx");
  const html = render(WorkbenchSearch, { workspaces: [], canCreateRequest: false });
  assert.match(html, /role="combobox" aria-label="Search workspace"/);
  assert.match(html, /aria-controls="workbench-search-results"/);
  assert.match(html, /kivo-command-results thin-scrollbar/);
});

test("collection config merges independent edits and reports conflicts", async () => {
  const { mergeConfig } = await server.ssrLoadModule("/src/hooks/use-collection-config.js");
  const base = { scripts: { preRequest: "", postResponse: "" }, mockServer: { port: 0 } };
  const local = { scripts: { preRequest: "local", postResponse: "" }, mockServer: { port: 0 } };
  const remote = { scripts: { preRequest: "", postResponse: "remote" }, mockServer: { port: 0 } };
  const merged = mergeConfig(base, local, remote);
  assert.equal(merged.value.scripts.preRequest, "local");
  assert.equal(merged.value.scripts.postResponse, "remote");
  assert.deepEqual(merged.conflicts, []);

  const conflict = mergeConfig(base, local, { ...remote, scripts: { preRequest: "remote", postResponse: "" } });
  assert.equal(conflict.value.scripts.preRequest, "local");
  assert.deepEqual(conflict.conflicts, ["scripts.preRequest"]);
});

test("gRPC message view requires stream metadata and paginates large message lists", async () => {
  const { ResponsePane } = await server.ssrLoadModule("/src/components/workspace/ResponsePane.jsx");
  const response = { ...model.createEmptyResponse(), isJson: true, body: JSON.stringify(Array.from({ length: 80 }, (_, id) => ({ id }))), headers: { "x-kivo-grpc-mode": "server_stream" } };
  const html = render(ResponsePane, { response, activeTab: "Body", bodyView: "Messages" });
  assert.match(html, /Received gRPC messages/);
  assert.match(html, /Message #50/);
  assert.doesNotMatch(html, /Message #51/);
  assert.match(html, /Show more messages/);
  const http = render(ResponsePane, { response: { ...response, headers: {} }, activeTab: "Body", bodyView: "Messages" });
  assert.doesNotMatch(http, /Received gRPC messages/);
});

test("stream inspectors expose accessible resizing and payload controls for every streaming protocol", async () => {
  const { StreamResponsePanel } = await server.ssrLoadModule("/src/components/workspace/StreamResponsePanel.jsx");
  for (const mode of ["sse", "websocket", "socketio"]) {
    const html = render(StreamResponsePanel, {
      mode,
      messages: [{ id: "event-1", direction: "in", event: "message", text: '{"ok":true}', size: 11, at: "2026-09-23T10:00:00Z" }],
    });
    assert.match(html, /role="separator"[^>]*aria-label="Resize payload inspector"/, mode);
    assert.match(html, /aria-valuemin="15" aria-valuemax="85" aria-valuenow="60"/, mode);
    assert.match(html, /aria-label="Collapse payload inspector"/, mode);
    assert.match(html, /aria-label="Word wrap" aria-pressed="true"/, mode);
    assert.match(html, /aria-label="Payload format"/, mode);
    assert.match(html, /aria-label="Copy payload"/, mode);
    assert.match(html, /&quot;ok&quot;/, mode);
    assert.doesNotMatch(html, /flex-basis:/, mode);
  }
});

test("collection sections retain their content in the flat settings layout", async () => {
  const { CollectionSettingsPage } = await server.ssrLoadModule("/src/components/workspace/CollectionSettingsPage.jsx");
  for (const initialTab of ["Overview", "Headers", "Environments", "Auth", "Docs", "Runner"]) {
    const html = render(CollectionSettingsPage, {
      workspace: { name: "Demo" }, collection: model.createCollection("Demo API"), initialTab,
    });
    assert.match(html, /kivo-settings-layout/, initialTab);
    assert.ok(html.includes(initialTab), initialTab);
  }
});

test("all app settings sections render directly without a Storage flash", async () => {
  const { AppSettingsPage } = await server.ssrLoadModule("/src/components/workspace/AppSettingsPage.jsx");
  for (const initialTab of ["Storage", "Theme", "Security", "Keybindings", "Proxy", "Cookie Jar", "History", "Updates", "Resources"]) {
    const html = render(AppSettingsPage, { initialTab });
    assert.match(html, /kivo-settings-layout/, initialTab);
    assert.ok(html.includes(`>${initialTab}</h2>`), initialTab);
  }
});
