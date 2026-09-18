const PREFIX = "enc:v1:";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encode(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decode(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function deriveAuthKey(readSeed, cryptoApi = globalThis.crypto) {
  try {
    if (!cryptoApi?.subtle) throw new Error("Web Crypto unavailable");
    const seed = await readSeed();
    if (typeof seed !== "string" || !seed.trim()) throw new Error("Vault seed unavailable");
    const material = await cryptoApi.subtle.importKey("raw", encoder.encode(seed), "PBKDF2", false, ["deriveKey"]);
    return await cryptoApi.subtle.deriveKey({
      name: "PBKDF2",
      salt: encoder.encode("kivo-auth-encryption-salt-v1"),
      iterations: 100_000,
      hash: "SHA-256",
    }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } catch (cause) {
    throw new Error("Secure storage is unavailable. Unlock your system keychain and retry. Credentials have not been saved.", { cause });
  }
}

export async function decryptSensitiveText(value, key, cryptoApi = globalThis.crypto) {
  const raw = String(value ?? "");
  if (!raw.startsWith(PREFIX)) return raw;
  try {
    if (!key || !cryptoApi?.subtle) throw new Error("Missing encryption key");
    const parts = raw.slice(PREFIX.length).split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid encrypted value");
    const iv = decode(parts[0]);
    const ciphertext = decode(parts[1]);
    if (iv.length !== 12 || ciphertext.length < 16) throw new Error("Invalid encrypted value");
    return decoder.decode(await cryptoApi.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
  } catch (cause) {
    throw new Error("A saved credential could not be decrypted. Restore access to the original keychain before saving changes.", { cause });
  }
}

export async function encryptSensitiveText(value, key, cryptoApi = globalThis.crypto) {
  const raw = String(value ?? "");
  if (!raw) return raw;
  try {
    if (!key || !cryptoApi?.subtle) throw new Error("Missing encryption key");
    if (raw.startsWith(PREFIX)) {
      await decryptSensitiveText(raw, key, cryptoApi);
      return raw;
    }
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoApi.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(raw));
    return `${PREFIX}${encode(iv)}:${encode(new Uint8Array(ciphertext))}`;
  } catch (cause) {
    throw new Error("Credential encryption failed. No plaintext fallback was saved. Unlock your system keychain and retry.", { cause });
  }
}
