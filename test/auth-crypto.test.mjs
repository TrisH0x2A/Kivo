import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { deriveAuthKey, encryptSensitiveText, decryptSensitiveText } from "../src/lib/auth-crypto.js";

const key = await deriveAuthKey(async () => "synthetic-test-seed", webcrypto);

test("frontend encryption matches the Rust compatibility vector", async () => {
  const vectorKey = await deriveAuthKey(async () => "synthetic-seed", webcrypto);
  const ciphertext = await encryptSensitiveText("synthetic-token", vectorKey, {
    subtle: webcrypto.subtle,
    getRandomValues: (bytes) => bytes.fill(7),
  });
  assert.equal(ciphertext, "enc:v1:BwcHBwcHBwcHBwcH:HwpAEswax305AYS/i8m2T2Dp8W5/YFLwT5OkFj+eoQ==");
});

test("credential encryption roundtrips using fresh nonces", async () => {
  const first = await encryptSensitiveText("synthetic-token", key, webcrypto);
  const second = await encryptSensitiveText("synthetic-token", key, webcrypto);
  assert.match(first, /^enc:v1:/);
  assert.notEqual(first, second);
  assert.ok(!first.includes("synthetic-token"));
  assert.equal(await decryptSensitiveText(first, key, webcrypto), "synthetic-token");
});

test("vault and Web Crypto failures cannot return a null key", async () => {
  await assert.rejects(deriveAuthKey(async () => { throw new Error("locked"); }, webcrypto), /Secure storage is unavailable/);
  await assert.rejects(deriveAuthKey(async () => "", webcrypto), /Secure storage is unavailable/);
  await assert.rejects(deriveAuthKey(async () => "seed", {}), /Secure storage is unavailable/);
});

test("encryption failures never return the plaintext input", async () => {
  await assert.rejects(encryptSensitiveText("synthetic-token", null, webcrypto), /encryption failed/);
  await assert.rejects(encryptSensitiveText("synthetic-token", key, {
    getRandomValues: (value) => webcrypto.getRandomValues(value),
    subtle: { encrypt: async () => { throw new Error("failed"); } },
  }), /encryption failed/);
});

test("wrong keys and malformed ciphertext fail instead of returning empty credentials", async () => {
  const otherKey = await deriveAuthKey(async () => "wrong-seed", webcrypto);
  const encrypted = await encryptSensitiveText("synthetic-token", key, webcrypto);
  await assert.rejects(decryptSensitiveText(encrypted, otherKey, webcrypto), /could not be decrypted/);
  await assert.rejects(decryptSensitiveText(encrypted, null, webcrypto), /could not be decrypted/);
  for (const invalid of ["enc:v1:", "enc:v1:invalid:base64", `${encrypted}:extra`]) {
    await assert.rejects(decryptSensitiveText(invalid, key, webcrypto), /could not be decrypted/);
  }
});

test("legacy plaintext can be read and then encrypted without mutating the source", async () => {
  const legacy = "synthetic-legacy-token";
  assert.equal(await decryptSensitiveText(legacy, key, webcrypto), legacy);
  const encrypted = await encryptSensitiveText(legacy, key, webcrypto);
  assert.equal(await decryptSensitiveText(encrypted, key, webcrypto), legacy);
  assert.equal(await encryptSensitiveText(encrypted, key, webcrypto), encrypted);
  await assert.rejects(encryptSensitiveText("enc:v1:invalid", key, webcrypto), /encryption failed/);
});
