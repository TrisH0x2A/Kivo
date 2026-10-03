import assert from "node:assert/strict";
import test from "node:test";
import { buildReproductionBundle, prepareReproductionReplay, validateReproductionBundle } from "../src/lib/reproduction-bundle.js";

test("reproduction bundles redact credentials in URL, bodies and headers without mutating inputs", () => {
  const input = {
    request: { auth: { token: "private-bearer" } },
    envVars: { merged: { API_KEY: "private-env" } },
    explanation: {
      url: "https://user:private-password@example.com?api_key=private-query",
      headers: [{ key: "Authorization", value: "private-header" }],
      body: '{"password":"private-body","echo":"private-bearer"}',
    },
    response: { headers: { "set-cookie": "private-cookie", "x-echo": "private-env" }, body: '{"token":"private-response","echo":"private-bearer"}' },
  };
  const before = JSON.stringify(input);
  const bundle = buildReproductionBundle(input);
  assert.doesNotMatch(JSON.stringify(bundle), /private-/);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.parse(bundle.response.body).token, "[redacted]");
});

test("bundle body limits are explicit and binary data is omitted", () => {
  const bundle = buildReproductionBundle({ explanation: { body: "x".repeat(12001) }, response: { body: "y".repeat(100001) } });
  assert.equal(bundle.request.body.length, 12000);
  assert.equal(bundle.request.truncated, true);
  assert.equal(bundle.response.body.length, 100000);
  assert.equal(bundle.response.truncated, true);
  assert.equal(buildReproductionBundle({ response: { isBinary: true, body: "private-binary" } }).response.body, "[binary body omitted]");
  assert.equal(buildReproductionBundle({}).response, null);
});

test("execution bundles preserve provenance and distinguish editor previews", () => {
  const execution = buildReproductionBundle({ workspaceName: "Dev", collectionName: "API", explanation: { kind: "execution", id: "exec-1", capturedAt: "2026-10-04T00:00:00Z", environment: { name: "Staging" }, method: "GET", url: "https://api.test/users", headers: [], body: "" } });
  assert.equal(execution.schemaVersion, 2);
  assert.deepEqual(execution.execution, { id: "exec-1", capturedAt: "2026-10-04T00:00:00Z", attempts: 1, actualRequest: true, scriptChanges: [], runtimeVariables: [] });
  assert.equal(execution.environment, "Staging");
  assert.equal(buildReproductionBundle({ explanation: { method: "GET", url: "https://api.test" } }).execution.actualRequest, false);
});

test("bundle validation and replay require explicit replacement of redactions", () => {
  const bundle = buildReproductionBundle({ explanation: { method: "GET", url: "https://api.test", headers: [{ key: "Authorization", value: "Bearer private" }], body: "" } });
  const replay = prepareReproductionReplay(bundle);
  assert.equal(replay.safe, false);
  assert.match(replay.warnings[0], /Redacted/);
  assert.throws(() => validateReproductionBundle({ ...bundle, schemaVersion: 1 }), /version/);
  assert.throws(() => validateReproductionBundle({ ...bundle, request: { ...bundle.request, url: "file:///secret" } }), /HTTP/);
  assert.throws(() => validateReproductionBundle({ ...bundle, request: { ...bundle.request, body: "[file or streaming body omitted]" } }), /omitted/);
});
