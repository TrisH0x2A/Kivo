import { parseDocument } from "yaml";

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const own = (value, key) => value && Object.hasOwn(value, key);

export function parseOpenApi(text) {
  if (text.length > 2_000_000) throw new Error("OpenAPI documents must be smaller than 2 MB.");
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  const spec = document.toJS({ maxAliasCount: 30 });
  if (!/^3\.[01]\./.test(spec?.openapi || "")) throw new Error("Choose an OpenAPI 3.0 or 3.1 document.");
  if (!spec.paths || typeof spec.paths !== "object") throw new Error("The document has no paths.");
  return spec;
}

function pointer(spec, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("External references must be bundled before importing.");
  let node = spec;
  for (const part of decodeURIComponent(ref.slice(2)).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!own(node, key)) throw new Error(`Missing reference: ${ref}`);
    node = node[key];
  }
  return node;
}

function dereference(spec, node, seen = new Set()) {
  if (!node?.$ref) return node;
  if (seen.has(node.$ref)) throw new Error("Circular non-schema reference.");
  seen.add(node.$ref);
  return dereference(spec, pointer(spec, node.$ref), seen);
}

export function openApiOperations(spec) {
  return Object.entries(spec.paths).flatMap(([path, raw]) => {
    const item = dereference(spec, raw);
    return Object.keys(item || {}).filter((method) => METHODS.has(method)).map((method) => ({ value: `${method} ${path}`, label: `${method.toUpperCase()} ${path}` }));
  });
}

// Move referenced schemas into a closed bundle, retaining recursive references.
export function bundleResponseSchema(spec, schema) {
  const definitions = Object.create(null);
  const references = new Map();
  const legacy = spec.openapi.startsWith("3.0.");
  let nodes = 0;
  function visit(node, depth = 0) {
    if (++nodes > 20000 || depth > 100) throw new Error("Schema is too complex to import.");
    if (typeof node === "boolean") return node;
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("Invalid response schema.");
    if (node.$schema && !["https://json-schema.org/draft/2020-12/schema", "https://spec.openapis.org/oas/3.1/dialect/base"].includes(node.$schema)) throw new Error(`Unsupported OpenAPI schema dialect: ${node.$schema}`);
    const result = Object.create(null);
    for (const [key, value] of Object.entries(node)) {
      if (key === "$id" || key === "$schema" || (legacy && key === "nullable")) continue;
      if (key === "$ref") {
        if (!references.has(value)) {
          let name = `kivoReference${references.size}`;
          while (Object.hasOwn(schema.$defs || {}, name)) name += "_";
          references.set(value, name);
          definitions[name] = visit(pointer(spec, value), depth + 1);
        }
        result.$ref = `#/$defs/${references.get(value)}`;
      } else if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key)) {
        result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child, depth + 1)]));
      } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        result[key] = value.map((child) => visit(child, depth + 1));
      } else if (["items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames"].includes(key)) {
        result[key] = visit(value, depth + 1);
      } else if (legacy && ["exclusiveMinimum", "exclusiveMaximum"].includes(key) && typeof value === "boolean") {
        if (value) result[key] = node[key === "exclusiveMinimum" ? "minimum" : "maximum"];
      } else result[key] = value;
    }
    return legacy && node.nullable ? { anyOf: [result, { type: "null" }] } : result;
  }
  const root = visit(schema);
  if (typeof root === "boolean") return root;
  return { ...root, $schema: "https://json-schema.org/draft/2020-12/schema", ...(Object.keys(definitions).length ? { $defs: { ...root.$defs, ...definitions } } : {}) };
}

export function planOpenApiSync(spec, operationKey, request) {
  const separator = operationKey.indexOf(" ");
  const method = operationKey.slice(0, separator);
  const path = operationKey.slice(separator + 1);
  const item = dereference(spec, spec.paths[path]);
  const operation = item?.[method];
  if (!METHODS.has(method) || !operation) throw new Error("Select an operation.");
  const server = operation.servers?.[0] || item.servers?.[0] || spec.servers?.[0];
  const base = server?.url ? String(server.url).replace(/\{([^{}]+)\}/g, (_, key) => server.variables?.[key]?.default ?? `{{${key}}}`) : "{{base_url}}";
  const parameters = new Map();
  for (const raw of [...(item.parameters || []), ...(operation.parameters || [])]) {
    const parameter = dereference(spec, raw);
    parameters.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  const rows = (location, current = []) => {
    const added = [...parameters.values()].filter((parameter) => parameter.in === location).map((parameter) => {
      const existing = current.find((row) => location === "header" ? row.key.toLowerCase() === parameter.name.toLowerCase() : row.key === parameter.name);
      return existing || { key: parameter.name, value: String(parameter.example ?? parameter.schema?.default ?? ""), enabled: true };
    });
    return [...current.filter((row) => !added.some((entry) => location === "header" ? entry.key.toLowerCase() === row.key.toLowerCase() : entry.key === row.key)), ...added];
  };
  const responses = Object.create(null);
  const warnings = [];
  for (const [status, raw] of Object.entries(operation.responses || {})) {
    const response = dereference(spec, raw);
    const media = response?.content?.["application/json"] || Object.entries(response?.content || {}).find(([type]) => type.endsWith("+json"))?.[1];
    if (media?.schema !== undefined) responses[status] = bundleResponseSchema(spec, media.schema);
    else warnings.push(`${status}: no JSON response schema`);
  }
  if ([...parameters.values()].some((parameter) => ["cookie", "path"].includes(parameter.in))) warnings.push("Path and cookie values need explicit configuration.");
  if (operation.security || spec.security) warnings.push("Existing authentication is preserved; security requirements are not imported.");
  const patch = {
    method: method.toUpperCase(),
    url: `${base.replace(/\/$/, "")}${path.replace(/\{([^{}]+)\}/g, "{{$1}}")}`,
    queryParams: rows("query", request.queryParams),
    headers: rows("header", request.headers),
    contract: { ...request.contract, responses, source: { title: spec.info?.title || "OpenAPI", version: spec.info?.version || "", operation: operationKey } }
  };
  return { patch, warnings, changes: Object.keys(patch).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(request[key])) };
}
