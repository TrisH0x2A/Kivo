import assert from "node:assert/strict";
import test from "node:test";
import { buildReproductionBundle } from "../src/lib/reproduction-bundle.js";

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
