import test from "node:test";
import assert from "node:assert/strict";

import { applyRunnerDataRow, buildRunReport, getRunnableRequests, normalizeRunnerDelayMs, normalizeRunnerExpectedStatus, normalizeRunnerFolderPath, parseCsvTable, parseRunnerDataRows } from "../src/lib/collection-runner.js";

test("parseCsvTable supports quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsvTable('name,query\n"Ada, Lovelace","say ""hi"""'), [
    ["name", "query"],
    ["Ada, Lovelace", 'say "hi"'],
  ]);
});

test("parseRunnerDataRows reads JSON and CSV rows", () => {
  assert.deepEqual(parseRunnerDataRows('[{"id":42}]'), [{ id: "row-1", values: { id: 42 } }]);
  assert.deepEqual(parseRunnerDataRows("id,name\n42,Ada"), [{ id: "row-1", values: { id: "42", name: "Ada" } }]);
});

test("applyRunnerDataRow replaces request placeholders", () => {
  const request = {
    url: "https://api.example.com/users/{{ id }}",
    body: "{\"name\":\"{{name}}\"}",
    graphqlVariables: "{\"id\":\"{{id}}\"}",
    headers: [{ key: "X-Name", value: "{{ name }}", enabled: true }],
    queryParams: [{ key: "id", value: "{{id}}", enabled: true }],
  };

  assert.deepEqual(applyRunnerDataRow(request, { values: { id: 42, name: "Ada" } }), {
    ...request,
    url: "https://api.example.com/users/42",
    body: "{\"name\":\"Ada\"}",
    graphqlVariables: "{\"id\":\"42\"}",
    headers: [{ key: "X-Name", value: "Ada", enabled: true }],
    queryParams: [{ key: "id", value: "42", enabled: true }],
  });
});

test("getRunnableRequests normalizes folder filters", () => {
  const collection = {
    requests: [
      { name: "List", requestMode: "http", folderPath: " users / active " },
      { name: "Stream", requestMode: "sse", folderPath: "users/active" },
      { name: "Query", requestMode: "graphql", folderPath: "users/active" },
    ],
  };

  assert.equal(normalizeRunnerFolderPath(" users / active "), "users/active");
  assert.deepEqual(
    getRunnableRequests(collection, "users/active").map(({ request }) => request.name),
    ["List", "Query"]
  );
});

test("normalizeRunnerDelayMs clamps delay values", () => {
  assert.equal(normalizeRunnerDelayMs("250ms"), 250);
  assert.equal(normalizeRunnerDelayMs("-1"), 0);
  assert.equal(normalizeRunnerDelayMs("999999"), 60000);
  assert.equal(normalizeRunnerDelayMs(""), 0);
});

test("buildRunReport includes assertion and failure summary", () => {
  const report = buildRunReport({
    collectionName: "API",
    folderFilter: "",
    dataRows: [],
    summary: { total: 1, done: 1, passed: 0, failed: 1, tests: 2 },
    results: [{
      name: "Create",
      method: "POST",
      url: "https://api.example.com/users",
      status: "failed",
      statusCode: 500,
      duration: "20 ms",
      attempts: 2,
      tests: [{ name: "status", ok: false }, { name: "shape", ok: true }],
      error: "status failed",
    }],
  });

  assert.deepEqual(report.summary.assertions, { total: 2, passed: 1, failed: 1 });
  assert.equal(report.summary.failureCount, 1);
  assert.equal(report.failures[0].name, "Create");
});

test("runner expected statuses normalize to safe workflow rules", () => {
  assert.equal(normalizeRunnerExpectedStatus("200, 201 2XX nope 400-499"), "200,201,2XX,400-499");
  assert.equal(normalizeRunnerExpectedStatus(""), "");
});
