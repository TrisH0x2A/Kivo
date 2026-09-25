import test from "node:test";
import assert from "node:assert/strict";

import { compareResponseBodies, compareResponses } from "../src/lib/response-diff.js";

test("response diff finds nested JSON changes without dumping whole payloads", () => {
  const diff = compareResponseBodies('{"user":{"name":"Ava","roles":["user"]}}', '{"user":{"name":"Mia","roles":["user","admin"]}}');
  assert.equal(diff.mode, "json");
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.entries.map((entry) => entry.path), ["$.user.name", "$.user.roles[1]"]);
});

test("response comparison reports status and body changes", () => {
  const diff = compareResponses({ status: 200, body: '{"ok":true}' }, { status: 500, body: '{"ok":false}' });
  assert.equal(diff.statusChanged, true);
  assert.equal(diff.body.changed, true);
});
