import test from "node:test";
import assert from "node:assert/strict";
import { createSaveQueue } from "../src/lib/save-queue.js";

test("saves finish in order even when an earlier operation is slow", async () => {
  const queue = createSaveQueue();
  const completed = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.enqueue(async () => { await gate; completed.push(1); });
  const second = queue.enqueue(async () => { completed.push(2); });
  await Promise.resolve();
  assert.deepEqual(completed, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(completed, [1, 2]);
});

test("a failed save is reported without blocking subsequent saves", async () => {
  const queue = createSaveQueue();
  const failed = queue.enqueue(() => { throw new Error("disk full"); });
  const next = queue.enqueue(() => "saved");
  await assert.rejects(failed, /disk full/);
  assert.equal(await next, "saved");
});
