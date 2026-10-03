import test from "node:test";
import assert from "node:assert/strict";

import { compareResponseBodies, compareResponses } from "../src/lib/response-diff.js";
import { normalizeComparisonRules, saveComparisonProfile } from "../src/lib/comparison-rules.js";
import { checkComparisonContract } from "../src/lib/response-comparison.js";

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

test("semantic rules ignore volatile fields and match reordered arrays with numeric tolerance", () => {
  const a = { timestamp: 1, items: [{ id: "a", n: 20, updatedAt: "old" }, { id: "b", n: 10 }] };
  const b = { timestamp: 2, items: [{ id: "b", n: 10 }, { id: "a", n: 20.01, updatedAt: "new" }] };
  const rules = { ignorePaths: ["/timestamp", "/items/*/updatedAt"], arrayKeys: [{ path: "/items", key: "id" }], absoluteTolerance: 0.02 };
  assert.equal(compareResponseBodies(JSON.stringify(a), JSON.stringify(b), rules).changed, false);
  b.items[1].n = 21;
  assert.equal(compareResponseBodies(JSON.stringify(a), JSON.stringify(b), rules).entries[0].path, '$.items[id="a"].n');
});

test("array matching reports additions, deletions and rejects ambiguous keys", () => {
  const rules = { arrayKeys: [{ path: "", key: "id" }] };
  const diff = compareResponseBodies('[{"id":1}]', '[{"id":"1"}]', rules);
  assert.equal(diff.entries.length, 2);
  assert.throws(() => compareResponseBodies('[{"id":1},{"id":1}]', '[]', rules), /duplicate/);
  assert.throws(() => compareResponseBodies('[{}]', '[]', rules), /scalar/);
});

test("relative tolerance never coerces strings and supports JSON pointer escaping", () => {
  assert.equal(compareResponseBodies('{"n":100}', '{"n":101}', { relativeTolerance: 0.02 }).changed, false);
  assert.equal(compareResponseBodies('{"n":100}', '{"n":"100"}', { absoluteTolerance: 2 }).changed, true);
  assert.equal(compareResponseBodies('{"a/b":{"~x":1}}', '{"a/b":{"~x":2}}', { ignorePaths: ["/a~1b/~0x"] }).changed, false);
  assert.throws(() => normalizeComparisonRules({ ignorePaths: ["$.foo"] }), /pointer/);
  assert.throws(() => normalizeComparisonRules({ absoluteTolerance: -1 }), /non-negative/);
});

test("headers are case insensitive with explicit ignore rules, not value insensitive", () => {
  const left = { headers: { "Content-Type": "application/json", Date: "a" } };
  const right = { headers: { "content-type": "application/json", date: "b" } };
  assert.equal(compareResponses(left, right, { compareHeaders: true, ignoreHeaders: ["DATE"] }).headers.changed, false);
  assert.equal(compareResponses(left, right, { compareHeaders: true }).headers.entries[0].path, "date");
});

test("diff limits are truthful and special object keys do not access prototypes", () => {
  const body = (size, value) => JSON.stringify(Object.fromEntries(Array.from({ length: size }, (_, index) => [`a${index}`, value])));
  assert.equal(compareResponseBodies(body(80, 0), body(80, 1)).truncated, false);
  assert.equal(compareResponseBodies(body(81, 0), body(81, 1)).truncated, true);
  assert.equal(compareResponseBodies('{}', '{"__proto__":1}').entries[0].left, "<missing>");
  assert.throws(() => compareResponseBodies("x".repeat(8_000_001), ""), /8 MB/);
  assert.throws(() => compareResponseBodies("[".repeat(102) + "0" + "]".repeat(102), "[".repeat(102) + "1" + "]".repeat(102)), /100-level/);
});

test("binary differences and transport failures cannot be reported as matching text", () => {
  assert.equal(compareResponses({ isBinary: true, bodyBase64: "YQ==" }, { isBinary: true, bodyBase64: "Yg==" }).body.changed, true);
  assert.throws(() => compareResponses({ error: "timeout" }, {}), /complete/);
});

test("named profiles update without mutating previous rules and reject duplicate names", () => {
  const saved = saveComparisonProfile([], { name: "Stable", rules: { ignorePaths: ["/time"] } });
  const changed = saveComparisonProfile(saved.profiles, { id: saved.profile.id, name: "Stable", rules: {} });
  assert.equal(changed.profiles.length, 1);
  assert.deepEqual(saved.profile.rules.ignorePaths, ["/time"]);
  assert.throws(() => saveComparisonProfile(saved.profiles, { name: "stable", rules: {} }), /already exists/);
  assert.throws(() => saveComparisonProfile([], { name: "", rules: {} }), /profile name/);
});

test("contract comparison selects status ranges, preserves false schemas and flags missing schemas", async () => {
  let schema;
  const validate = async (_body, value) => { schema = value; return { ok: value !== false, errors: [] }; };
  assert.equal((await checkComparisonContract({ status: 200, body: "{}" }, { responses: { "200": false, "2XX": {} } }, validate)).ok, false);
  assert.equal(schema, false);
  assert.equal((await checkComparisonContract({ status: 201, body: "{}" }, { responses: { "2XX": true } }, validate)).ok, true);
  assert.equal((await checkComparisonContract({ status: 500, body: "{}" }, {}, validate)).checked, false);
  assert.equal((await checkComparisonContract({ status: 200, body: "invalid" }, { responses: { default: true } }, validate)).ok, false);
});
