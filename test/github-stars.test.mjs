import test from "node:test";
import assert from "node:assert/strict";
import { readStarCache, fetchStarCount, formatStarCount } from "../src/lib/github-stars.js";

test("star cache keeps a valid stale count for offline use", () => {
  const storage = { getItem: () => JSON.stringify({ count: 367, at: 1000 }) };
  assert.deepEqual(readStarCache(storage, 2000), { count: 367, at: 1000, fresh: true });
  assert.equal(readStarCache(storage, 7200000).fresh, false);
  assert.equal(readStarCache(storage, 7200000).count, 367);
});

test("star cache rejects malformed entries and tolerates unavailable storage", () => {
  for (const value of ["bad", "null", '{"count":-1,"at":1}', '{"count":"367","at":1}', '{"count":4}']) {
    assert.equal(readStarCache({ getItem: () => value }), null);
  }
  assert.equal(readStarCache(undefined), null);
  assert.equal(readStarCache({ getItem: () => { throw new Error("blocked"); } }), null);
});

test("star count accepts zero and formats large counts without a text fallback", () => {
  assert.equal(formatStarCount(0), "0");
  assert.equal(formatStarCount(367), "367");
  assert.equal(formatStarCount(1500), "1.5K");
  assert.equal(formatStarCount(null), "--");
});

test("star fetch validates HTTP status and numeric data", async () => {
  const signal = new AbortController().signal;
  assert.equal(await fetchStarCount(async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/TrisH0x2A/Kivo");
    assert.equal(options.signal, signal);
    return { ok: true, json: async () => ({ stargazers_count: 0 }) };
  }, signal), 0);
  await assert.rejects(fetchStarCount(async () => ({ ok: false })), /unavailable/);
  for (const count of [undefined, null, "367", -1, 1.5]) {
    await assert.rejects(fetchStarCount(async () => ({ ok: true, json: async () => ({ stargazers_count: count }) })), /Invalid/);
  }
});
