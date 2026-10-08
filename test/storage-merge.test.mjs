import test from "node:test";
import assert from "node:assert/strict";
import { mergeStorage } from "../src/lib/storage-merge.js";

test("storage merge combines independent request edits by identity", () => {
  const base = [{ id: "workspace", name: "Demo", requests: [{ name: "Health", method: "GET", url: "/health" }] }];
  const local = structuredClone(base);
  const remote = structuredClone(base);
  local[0].requests[0].method = "POST";
  remote[0].requests[0].url = "/ready";
  remote[0].requests.push({ name: "Status", method: "GET" });
  const result = mergeStorage(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.value[0].requests[0].method, "POST");
  assert.equal(result.value[0].requests[0].url, "/ready");
  assert.equal(result.value[0].requests.length, 2);
});

test("storage merge requires explicit resolution for edit/delete and value conflicts", () => {
  const base = [{ key: "TOKEN", value: "old" }, { key: "URL", value: "old" }];
  const local = [{ key: "TOKEN", value: "local" }, { key: "URL", value: "local" }];
  const remote = [{ key: "TOKEN", value: "disk" }];
  const result = mergeStorage(base, local, remote);
  assert.deepEqual(result.conflicts.map((item) => item.path), ["/TOKEN/value", "/URL"]);
  assert.deepEqual(result.value, local);
  const resolved = mergeStorage(base, local, remote, { "/TOKEN/value": "remote", "/URL": "remote" });
  assert.deepEqual(resolved.value, remote);
  assert.deepEqual(base[0], { key: "TOKEN", value: "old" });
});

test("duplicate row keys produce a whole-list conflict without dropping values", () => {
  const base = [{ key: "X", value: "a" }, { key: "X", value: "b" }];
  const local = [...base, { key: "X", value: "local" }];
  const remote = [...base, { key: "X", value: "disk" }];
  const result = mergeStorage(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.value, local);
});

test("semantic comparison ignores object key order and retains local additions", () => {
  const result = mergeStorage({ a: 1, b: 2 }, { b: 2, a: 1, local: true }, { b: 3, a: 1 });
  assert.deepEqual(result.value, { a: 1, b: 3, local: true });
  assert.deepEqual(result.conflicts, []);
});
