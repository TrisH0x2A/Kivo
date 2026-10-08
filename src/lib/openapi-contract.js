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
  const patch = {
    method: method.toUpperCase(),
    url: `${base.replace(/\/$/, "")}${path.replace(/\{([^{}]+)\}/g, "{{$1}}")}`,
    queryParams: rows("query", request.queryParams),
    headers: rows("header", request.headers),
    contract: { ...request.contract, responses, source: { title: spec.info?.title || "OpenAPI", version: spec.info?.version || "", operation: operationKey } }
  };
  const sameOperation = request.contract?.source?.operation === operationKey;
  const previous = sameOperation ? request.contract.source.managed || {} : {};
  const managed = {
    queryParams: [...parameters.values()].filter((p) => p.in === "query").map((p) => p.name),
    headers: [...parameters.values()].filter((p) => p.in === "header").map((p) => p.name),
    responses: Object.keys(responses)
  };
  const removed = Object.fromEntries(Object.keys(managed).map((key) => [key, (previous[key] || []).filter((name) => !managed[key].some((next) => key === "headers" ? next.toLowerCase() === name.toLowerCase() : next === name))]));
  const body = mapRequestBody(spec, operation.requestBody, warnings);
  const security = mapSecurity(spec, operation.security ?? spec.security ?? [], warnings);
  return { patch, warnings, managed, removed, body, security, previous, changes: Object.keys(patch).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(request[key])) };
}

function sampleSchema(spec, raw, seen = new Set(), budget = { nodes: 0 }) {
  if (++budget.nodes > 2000 || seen.size > 30) throw new Error("Request schema is too complex to sample.");
  if (raw?.$ref && seen.has(raw.$ref)) return null;
  const next = new Set(seen);
  if (raw?.$ref) next.add(raw.$ref);
  const schema = dereference(spec, raw);
  if (!schema || typeof schema !== "object") return null;
  for (const key of ["example", "default", "const"]) if (own(schema, key)) return schema[key];
  if (schema.enum?.length) return schema.enum[0];
  if (schema.examples?.length) return schema.examples[0];
  if (schema.oneOf || schema.anyOf) return sampleSchema(spec, (schema.oneOf || schema.anyOf)[0], next, budget);
  if (schema.allOf) {
    const values = schema.allOf.map((part) => sampleSchema(spec, part, next, budget));
    return Object.assign(Object.create(null), ...values.filter((value) => value && typeof value === "object" && !Array.isArray(value)));
  }
  const type = Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;
  if (type === "object" || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).filter(([, child]) => !dereference(spec, child)?.readOnly).map(([key, child]) => [key, sampleSchema(spec, child, next, budget)]));
  if (type === "array") return [sampleSchema(spec, schema.items, next, budget)];
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return false;
  return "";
}

function mapRequestBody(spec, raw, warnings) {
  if (!raw) return null;
  const content = dereference(spec, raw)?.content || {};
  const entries = Object.entries(content);
  const entry = entries.find(([type]) => type === "application/json") || entries.find(([type]) => type.endsWith("+json")) || entries[0];
  if (!entry) return null;
  const [contentType, media] = entry;
  const json = contentType === "application/json" || contentType.endsWith("+json");
  const form = ["application/x-www-form-urlencoded", "multipart/form-data"].includes(contentType);
  if (!json && !form && !contentType.startsWith("text/") && !contentType.includes("xml")) {
    warnings.push(`${contentType}: configure the request body manually.`);
    return null;
  }
  const example = Object.values(media.examples || {})[0];
  const value = own(media, "example") ? media.example : example ? dereference(spec, example)?.value : sampleSchema(spec, media.schema);
  if (example && !own(dereference(spec, example), "value")) warnings.push("External body examples are not loaded.");
  if (!own(media, "example") && !example) warnings.push("The generated body is a starting example; review required fields and constraints.");
  if (entries.length > 1) warnings.push(`Using ${contentType}; ${entries.length - 1} other body formats are available in the specification.`);
  const patch = form ? {
    bodyType: contentType === "multipart/form-data" ? "form-data" : "form-urlencoded",
    bodyRows: Object.entries(value && typeof value === "object" ? value : {}).map(([key, item]) => ({ key, value: typeof item === "object" ? JSON.stringify(item) : String(item ?? ""), enabled: true, fieldType: "text" })), body: ""
  } : { bodyType: json ? "json" : contentType.includes("xml") ? "xml" : "text", body: json ? JSON.stringify(value, null, 2) : typeof value === "string" ? value : "" };
  return { contentType, patch };
}

function mapSecurity(spec, requirements, warnings) {
  if (!requirements.length) return [{ value: "none", label: "No authentication", auth: { type: "none" } }];
  return requirements.flatMap((requirement, index) => {
    const entries = Object.entries(requirement);
    if (!entries.length) return [{ value: String(index), label: "No authentication (optional)", auth: { type: "none" } }];
    if (entries.length > 1) {
      warnings.push(`Combined security (${entries.map(([name]) => name).join(" + ")}) requires manual configuration.`);
      return [];
    }
    const [name, scopes] = entries[0];
    const scheme = dereference(spec, spec.components?.securitySchemes?.[name]);
    let auth;
    if (scheme?.type === "http" && ["basic", "bearer", "digest"].includes(scheme.scheme?.toLowerCase())) auth = { type: scheme.scheme.toLowerCase() };
    if (scheme?.type === "apiKey" && ["header", "query"].includes(scheme.in)) auth = { type: "apikey", apiKeyName: scheme.name, apiKeyIn: scheme.in, apiKeyValue: "" };
    if (scheme?.type === "oauth2") {
      const grants = { authorizationCode: "authorization_code", clientCredentials: "client_credentials", password: "password" };
      return Object.entries(scheme.flows || {}).flatMap(([flow, value]) => {
        if (!grants[flow]) { warnings.push(`${name}: ${flow} requires manual configuration.`); return []; }
        return [{ value: `${index}:${flow}`, label: `${name} / ${grants[flow]}`, auth: { type: "oauth2", oauth2: { grantType: grants[flow], authUrl: value.authorizationUrl || "", tokenUrl: value.tokenUrl || "", scope: scopes.join(" ") } } }];
      });
    }
    if (!auth) { warnings.push(`${name}: ${scheme?.type || "unknown security scheme"} requires manual configuration.`); return []; }
    return [{ value: String(index), label: name, auth }];
  });
}

// Only fields explicitly selected by the user are changed; metadata tracks accepted imports.
export function applyOpenApiSync(plan, request, selected, { removeObsolete = false, securityChoice = "" } = {}) {
  const patch = {};
  const selectedSet = new Set(selected);
  for (const key of ["method", "url", "queryParams", "headers"]) if (selectedSet.has(key)) patch[key] = plan.patch[key];
  const responses = { ...request.contract?.responses };
  if (selectedSet.has("contract")) Object.assign(responses, plan.patch.contract.responses);
  for (const key of ["queryParams", "headers", "responses"]) {
    if (!removeObsolete || !selectedSet.has(key === "responses" ? "contract" : key)) continue;
    if (key === "responses") for (const name of plan.removed.responses) delete responses[name];
    else patch[key] = patch[key].filter((row) => !plan.removed[key].some((name) => key === "headers" ? name.toLowerCase() === row.key.toLowerCase() : name === row.key));
  }
  if (selectedSet.has("body") && plan.body) {
    Object.assign(patch, plan.body.patch);
    const headers = (patch.headers || request.headers || []).filter((row) => row.key.toLowerCase() !== "content-type");
    patch.headers = plan.body.contentType === "multipart/form-data" ? headers : [...headers, { key: "Content-Type", value: plan.body.contentType, enabled: true }];
  }
  if (selectedSet.has("auth")) {
    const choice = plan.security.find((item) => item.value === securityChoice);
    if (!choice) throw new Error("Select an authentication requirement.");
    patch.auth = choice.auth;
  }
  const managed = { ...plan.previous };
  for (const key of ["queryParams", "headers", "responses"]) {
    if (selectedSet.has(key === "responses" ? "contract" : key)) managed[key] = [...new Set([...plan.managed[key], ...(removeObsolete ? [] : plan.removed[key])])];
  }
  patch.contract = { ...request.contract, responses, source: { ...plan.patch.contract.source, managed } };
  return patch;
}
