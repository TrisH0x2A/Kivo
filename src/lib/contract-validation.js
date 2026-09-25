import { registerSchema, unregisterSchema, validate, setShouldValidateFormat } from "@hyperjump/json-schema/draft-2020-12";
import "@hyperjump/json-schema/draft-07";
import "@hyperjump/json-schema/formats-lite";
import { BASIC } from "@hyperjump/json-schema/experimental";

const DIALECTS = new Set(["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema"]);
setShouldValidateFormat(true);

// Contracts are deliberately offline: importing a schema must not fetch its references.
function checkOffline(value, depth = 0) {
  if (depth > 100) throw new Error("Schema nesting exceeds 100 levels.");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["$ref", "$dynamicRef", "$recursiveRef"].includes(key) && (typeof child !== "string" || !child.startsWith("#"))) {
      throw new Error("External references are disabled. Import a bundled schema with local references.");
    }
    if (key === "$schema" && !DIALECTS.has(child)) throw new Error(`Unsupported schema dialect: ${child}`);
    if (key === "$id") throw new Error("Nested schema identifiers are unsupported. Import a bundle using local references.");
    checkOffline(child, depth + 1);
  }
}

export async function validateJsonAgainstSchema(value, schema) {
  const uri = `https://kivo.invalid/contracts/${crypto.randomUUID()}`;
  let registered = false;
  try {
    if (schema === null || (typeof schema !== "object" && typeof schema !== "boolean")) throw new Error("A JSON Schema object or boolean is required.");
    if (JSON.stringify(schema).length > 2_000_000 || JSON.stringify(value).length > 8_000_000) throw new Error("Contract validation exceeds the size limit (2 MB schema, 8 MB response).");
    const clean = typeof schema === "boolean" ? schema : structuredClone(schema);
    if (typeof clean === "object") delete clean.$id;
    checkOffline(clean);
    registerSchema(clean, uri, "https://json-schema.org/draft/2020-12/schema");
    registered = true;
    const output = await validate(uri, value, BASIC);
    return {
      ok: output.valid,
      errors: (output.errors || []).slice(0, 100).map((entry) => `${entry.instanceLocation || "#"}: ${entry.keyword?.split("/").pop() || "schema"} constraint failed`)
    };
  } catch (error) {
    return { ok: false, errors: [String(error.message || error)] };
  } finally {
    if (registered) unregisterSchema(uri);
  }
}

export function selectResponseSchema(contract, status) {
  if (!contract?.responses) return undefined;
  const key = String(status || 0);
  return contract.responses[key] ?? contract.responses[`${key[0]}XX`] ?? contract.responses.default;
}
