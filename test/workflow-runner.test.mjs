import test from "node:test";
import assert from "node:assert/strict";
import { executeWorkflowStep, extractRunVariables, inheritRunRequest, resolveRunVariables } from "../src/lib/workflow-runner.js";
const request = { method: "GET", requestMode: "http", url: "https://example.test/{{id}}" };
const response = { status: 200, duration: "1 ms", rawBody: '{"data":{"id":42}}' };
const options = { request, context: { vars: {} }, stopped: () => false, send: async () => response, script: async () => ({ ok: true }), sleep: async () => {} };

test("extraction chains into URL, headers, body and auth without prototype access", async () => {
  const context = { vars: {} };
  const first = await executeWorkflowStep({ ...options, context, rules: [{ variable: "id", pointer: "/data/id" }] });
  assert.equal(first.status, "passed");
  const next = resolveRunVariables({ ...request, auth: { token: "{{id}}" }, headers: [{ key: "{{id}}", value: "{{id}}" }] }, context.vars);
  assert.equal(next.url, "https://example.test/42");
  assert.equal(next.auth.token, "42");
  assert.throws(() => extractRunVariables('{}', [{ variable: "x", pointer: "/constructor" }]));
  assert.throws(() => extractRunVariables('{}', [{ variable: "__proto__", pointer: "" }]));
  assert.deepEqual(extractRunVariables('{"a/b":{"~":[9]}}', [{ variable: "value", pointer: "/a~1b/~0/0" }]), { value: "9" });
});

test("script variables persist only on a successful step and are visible to next request", async () => {
  const context = { vars: {} };
  const result = await executeWorkflowStep({ ...options, context, request: { ...request, scriptAfterResponse: "extract" }, script: async () => ({ ok: true, context: { vars: { token: "secret" } } }) });
  assert.equal(result.status, "passed");
  assert.equal(context.vars.token, "secret");
  await executeWorkflowStep({ ...options, context, request: { ...request, scriptAfterResponse: "fail" }, script: async () => ({ ok: true, tests: [{ ok: false }], context: { vars: { token: "wrong" } } }) });
  assert.equal(context.vars.token, "secret");
});

test("retry policy skips unsafe methods and assertions but retries transient safe requests", async () => {
  let calls = 0;
  const send = async () => { calls++; return { ...response, status: 503 }; };
  const failed = await executeWorkflowStep({ ...options, retries: 2, send });
  assert.equal(calls, 3);
  assert.equal(failed.status, "failed");
  calls = 0;
  await executeWorkflowStep({ ...options, request: { ...request, method: "POST" }, retries: 2, send });
  assert.equal(calls, 1);
  calls = 0;
  await executeWorkflowStep({ ...options, request: { ...request, scriptAfterResponse: "test" }, retries: 2, send: async () => { calls++; return response; }, script: async () => ({ ok: false, error: "assertion" }) });
  assert.equal(calls, 1);
});

test("stop during retry and pre-script prevents another network call", async () => {
  let stopped = false, calls = 0;
  const result = await executeWorkflowStep({ ...options, retries: 5, stopped: () => stopped, sleep: async () => { stopped = true; }, send: async () => { calls++; throw new Error("network"); } });
  assert.equal(calls, 1);
  assert.equal(result.status, "cancelled");
  stopped = false;
  await executeWorkflowStep({ ...options, request: { ...request, scriptPreRequest: "prepare" }, stopped: () => stopped, script: async () => { stopped = true; return { ok: true }; }, send: async () => { calls++; return response; } });
  assert.equal(calls, 1);
});

test("folder auth and disabled request headers override inherited configuration", () => {
  const resolved = inheritRunRequest({ ...request, folderPath: "one/two", auth: { type: "inherit" }, inheritHeaders: true, headers: [{ key: "x-off", enabled: false }] }, { folderSettings: [{ path: "one", defaultHeaders: [{ key: "x-off", value: "yes", enabled: true }], defaultAuth: { type: "bearer", token: "parent" } }] }, { defaultHeaders: [{ key: "x-base", value: "1", enabled: true }] });
  assert.equal(resolved.auth.token, "parent");
  assert.equal(resolved.headers.filter((row) => row.key === "x-off").length, 1);
  assert.equal(resolved.headers.find((row) => row.key === "x-off").enabled, false);
  assert.equal(resolved.inheritHeaders, false);
});
