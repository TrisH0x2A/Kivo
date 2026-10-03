import test from "node:test";
import assert from "node:assert/strict";
import { buildExecutionRecord, attachExecutionResponse, createExecutionRedactor } from "../src/lib/execution-record.js";

test("execution records use native values and never retain private transport inputs", () => {
  const original = { id: "req", name: "Login", method: "GET", url: "{{host}}", headers: [{ key: "X-Version", value: "1", enabled: true }], auth: { type: "inherit" } };
  const scripted = { ...original, method: "POST", headers: [{ key: "X-Version", value: "2", enabled: true }] };
  const capture = { id: "exec-1", capturedAt: "2026-10-04T00:00:00Z", method: "POST", url: "https://api.test/login", finalUrl: "https://api.test/login", environment: { id: "staging", name: "Staging" },
    headers: [{ key: "authorization", value: "Bearer fixture-secret" }, { key: "x-version", value: "2" }, { key: "content-type", value: "application/x-www-form-urlencoded" }],
    body: "password=fixture-pass&session=fixture-session", privateValues: ["fixture-secret"], variables: { merged: { host: "https://api.test" }, workspace: [{ key: "host", value: "https://old.test" }], collection: [{ key: "host", value: "https://api.test" }] } };
  const record = buildExecutionRecord({ capture, original, scripted });
  assert.equal(record.id, "exec-1");
  assert.equal(record.environment.name, "Staging");
  assert.deepEqual(record.scriptChanges, ["method", "headers"]);
  assert.equal(record.headers[1].source, "Pre-request script");
  assert.deepEqual(record.headers[1].configuredSources, ["Request", "Pre-request script"]);
  assert.equal(record.variables[0].source, "Collection");
  assert.equal(record.variables[0].overrides, "Workspace");
  assert.doesNotMatch(JSON.stringify(record), /fixture-secret|fixture-pass|fixture-session|privateValues|https:\/\/api.test/);
  capture.method = "DELETE";
  original.name = "Edited";
  assert.equal(record.method, "POST");
  assert.equal(record.requestName, "Login");
});

test("redaction handles encoded values, credentials and JSON without reprocessing replacement text", () => {
  const redact = createExecutionRedactor(["a", "long password"]);
  assert.equal(redact.text("a"), "[redacted]");
  assert.equal(redact.text("long%20password"), "[redacted]");
  assert.doesNotMatch(createExecutionRedactor().url("https://user:secret@example.test/?token=hidden"), /user|secret|hidden/);
  assert.doesNotMatch(createExecutionRedactor().body('{"password":"hidden"}'), /hidden/);
});

test("manual authorization keeps its source and previous responses do not contribute variables", () => {
  const original = { headers: [{ key: "Authorization", value: "Basic private" }], lastResponse: { body: "{{old}}" } };
  const record = buildExecutionRecord({ original, capture: { id: "exec", authType: "none", headers: [{ key: "authorization", value: "Basic private" }] } });
  assert.equal(record.headers[0].source, "Request");
  assert.deepEqual(record.variables, []);
});

test("responses attach to captured IDs after switching and renaming, never a same-named request", () => {
  const store = { activeWorkspaceName: "B", workspaces: [
    { id: "wa", name: "Renamed", collections: [{ id: "ca", name: "Renamed", requests: [{ id: "ra", name: "Renamed" }] }] },
    { id: "wb", name: "B", collections: [{ id: "cb", name: "Collection", requests: [{ id: "rb", name: "Request" }] }] },
  ] };
  const next = attachExecutionResponse(store, { workspaceId: "wa", collectionId: "ca", requestId: "ra" }, { status: 200 });
  assert.equal(next.workspaces[0].collections[0].requests[0].lastResponse.status, 200);
  assert.equal(next.workspaces[1], store.workspaces[1]);
  assert.equal(store.workspaces[0].collections[0].requests[0].lastResponse, undefined);
  assert.equal(attachExecutionResponse(store, { workspaceId: "deleted" }, {}).workspaces[0], store.workspaces[0]);
});
