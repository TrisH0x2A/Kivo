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
