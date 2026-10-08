import test from "node:test";
import assert from "node:assert/strict";

import { buildHistorySnapshots, filterRequestHistory, redactHistoryUrl, retainHistoryEntries } from "../src/lib/history-utils.js";

test("redactHistoryUrl redacts sensitive query values", () => {
  const out = redactHistoryUrl("https://api.example.com/users?token=abc&limit=10&client_secret=s3");
  assert.equal(out, "https://api.example.com/users?token=%5Bredacted%5D&limit=10&client_secret=%5Bredacted%5D");
});

test("redactHistoryUrl handles non-URL strings", () => {
  assert.equal(
    redactHistoryUrl("/users?api_key=secret&visible=yes"),
    "/users?api_key=[redacted]&visible=yes"
  );
});

test("filterRequestHistory searches request metadata", () => {
  const rows = [
    { method: "GET", url: "https://api.example.com/users", workspaceName: "Core", collectionName: "Public", requestName: "List users" },
    { method: "POST", url: "https://billing.example.com/invoices", workspaceName: "Billing", collectionName: "Private", requestName: "Create invoice" },
  ];
  assert.deepEqual(filterRequestHistory(rows, "invoice"), [rows[1]]);
  assert.deepEqual(filterRequestHistory(rows, "core"), [rows[0]]);
  assert.equal(filterRequestHistory(rows, "").length, 2);
});

test("history snapshots preserve execution identity while redacting and bounding data", () => {
  const snapshots = buildHistorySnapshots({
    workspaceName: "Core",
    collectionName: "Users",
    request: { name: "Create", requestMode: "http", method: "POST", url: "https://api.test/users", headers: [{ key: "Authorization", value: "Bearer secret", enabled: true }], bodyType: "json", body: '{"name":"Ada"}' },
    response: { status: 201, statusText: "Created", rawBody: '{"token":"private","id":1}', headers: { "content-type": "application/json", "set-cookie": "session=private" }, duration: "42 ms", size: "32 B", execution: { kind: "execution", method: "POST", url: "https://api.test/users", finalUrl: "https://api.test/users", headers: [{ key: "authorization", value: "[redacted]", source: "Request" }], body: '{"name":"Ada"}', environment: { id: "staging", name: "Staging" }, scriptChanges: ["body"] } }
  });
  assert.equal(snapshots.request.environment.name, "Staging");
  assert.equal(snapshots.request.headers[0].value, "[redacted]");
  assert.match(snapshots.response.body, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(snapshots), /private|Bearer secret/);
});

test("fallback snapshots use the request body, bound it, and redact query credentials", () => {
  const snapshots = buildHistorySnapshots({
    request: { body: "x".repeat(250001), queryParams: [{ key: "api_key", value: "synthetic-secret", enabled: true }] },
    response: { body: "different-response", bodyBase64: "raw-unredacted" },
  });
  assert.equal(snapshots.request.body.length, 250000);
  assert.equal(snapshots.request.bodyTruncated, true);
  assert.equal(snapshots.request.queryParams[0].value, "[redacted]");
  assert.equal(snapshots.response.body, "different-response");
  assert.equal(snapshots.response.bodyBase64, "");
  assert.doesNotMatch(redactHistoryUrl("https://someone:secret@api.test/path"), /someone|secret/);
});

test("GraphQL history rehydrates its captured envelope without duplicating query parameters", () => {
  const snapshots = buildHistorySnapshots({
    request: { bodyType: "graphql", queryParams: [{ key: "a", value: "1" }], graphqlVariables: '{"id":"old"}' },
    response: { execution: { kind: "execution", url: "https://api.test/graphql?a=1", body: '{"query":"query { user { id } }","variables":{"id":"new","token":"private"}}' } },
  });
  assert.equal(snapshots.request.body, "query { user { id } }");
  assert.deepEqual(JSON.parse(snapshots.request.graphqlVariables), { id: "new", token: "[redacted]" });
  assert.deepEqual(snapshots.request.queryParams, []);
});

test("retention respects configured limits while preserving pinned runs", () => {
  const entries = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), pinned: i >= 1195 }));
  const retained = retainHistoryEntries(entries, 1000);
  assert.equal(retained.length, 1000);
  assert.equal(retained[0].id, "1195");
  assert.equal(retainHistoryEntries(entries, 50).length, 50);
  assert.equal(retainHistoryEntries(entries.filter((item) => item.pinned), 50).length, 5);
});
