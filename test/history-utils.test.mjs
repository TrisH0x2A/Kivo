import test from "node:test";
import assert from "node:assert/strict";

import { filterRequestHistory, redactHistoryUrl } from "../src/lib/history-utils.js";

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
