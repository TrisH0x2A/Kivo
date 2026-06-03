import test from "node:test";
import assert from "node:assert/strict";

import { redactHistoryUrl } from "../src/lib/history-utils.js";

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
