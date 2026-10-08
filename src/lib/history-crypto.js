import { encryptSensitiveText, decryptSensitiveText } from "./auth-crypto.js";

export async function transformHistorySnapshots(entries, key, mode, cryptoApi = globalThis.crypto) {
  if (!Array.isArray(entries)) return [];
  const output = [];
  for (const entry of entries) {
    const next = { ...entry };
    for (const field of ["requestSnapshot", "responseSnapshot"]) {
      const snapshot = entry[field];
      if (snapshot == null) continue;
      if (mode === "encrypt") {
        next[field] = await encryptSensitiveText(typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot), key, cryptoApi);
      } else if (typeof snapshot === "string") {
        next[field] = JSON.parse(await decryptSensitiveText(snapshot, key, cryptoApi));
      }
    }
    output.push(next);
  }
  return output;
}
