import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { deriveAuthKey } from "../src/lib/auth-crypto.js";
import { transformHistorySnapshots } from "../src/lib/history-crypto.js";

test("history snapshot encryption preserves metadata and rejects the wrong key", async () => {
  const key = await deriveAuthKey(async () => "history-test-seed", webcrypto);
  const entries = [{ id: "run-1", pinned: true, environment: { id: "staging" }, requestSnapshot: { body: "private-request" }, responseSnapshot: { bodyBase64: "private-response" } }, { id: "legacy" }];
  const encrypted = await transformHistorySnapshots(entries, key, "encrypt", webcrypto);
  assert.match(encrypted[0].requestSnapshot, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(encrypted), /private-request|private-response/);
  assert.deepEqual(await transformHistorySnapshots(encrypted, key, "decrypt", webcrypto), entries);
  assert.deepEqual(await transformHistorySnapshots(entries, key, "decrypt", webcrypto), entries);
  assert.equal(entries[0].requestSnapshot.body, "private-request");
  const wrong = await deriveAuthKey(async () => "wrong-key", webcrypto);
  await assert.rejects(transformHistorySnapshots(encrypted, wrong, "decrypt", webcrypto), /could not be decrypted/);
});
