import test from "node:test";
import assert from "node:assert/strict";

import { buildHistorySnapshots, filterRequestHistory, redactHistoryUrl } from "../src/lib/history-utils.js";

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
