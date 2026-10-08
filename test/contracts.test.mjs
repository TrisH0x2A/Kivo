import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonAgainstSchema, selectResponseSchema } from "../src/lib/contract-validation.js";
import { validateResponseBodyAgainstRequest } from "../src/lib/api-design.js";
import { applyOpenApiSync, bundleResponseSchema, openApiOperations, parseOpenApi, planOpenApiSync } from "../src/lib/openapi-contract.js";
import { graphqlCompletions, graphqlDiagnostics, parseGraphqlSchema, schemaFromIntrospection, introspectionQuery } from "../src/lib/graphql-tools.js";
import { graphql } from "graphql";

test("response contracts never infer a response shape from request bodies", async () => {
  const result = await validateResponseBodyAgainstRequest({ bodyType: "json", body: '{"id":1}' }, '{"id":1}');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /No response contract/);
  assert.equal(selectResponseSchema({ responses: { 200: false, "2XX": true, default: {} } }, 200), false);
  assert.equal(selectResponseSchema({ responses: { "2XX": true } }, 201), true);
});

test("JSON Schema engine validates unions, formats, limits, and additional properties", async () => {
  const schema = { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" }, count: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1 }] } }, additionalProperties: false };
  assert.equal((await validateJsonAgainstSchema({ email: "a@example.com", count: null }, schema)).ok, true);
  const invalid = await validateJsonAgainstSchema({ email: "not-an-email", count: 0, extra: true }, schema);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 3);
  assert.equal((await validateJsonAgainstSchema({}, false)).ok, false);
  assert.equal((await validateJsonAgainstSchema({}, { type: "imaginary" })).ok, false);
});

test("validation supports local recursive references without network access", async () => {
  const schema = { type: "object", properties: { next: { $ref: "#" } } };
  assert.equal((await validateJsonAgainstSchema({ next: { next: {} } }, schema)).ok, true);
  assert.equal((await validateJsonAgainstSchema({ next: 1 }, schema)).ok, false);
  for (const ref of ["https://example.com/schema", "file:///private.json"]) {
    assert.match((await validateJsonAgainstSchema({}, { $ref: ref })).errors[0], /External references/);
  }
});

const spec = {
  openapi: "3.0.3", info: { title: "Users", version: "1" }, servers: [{ url: "https://api.example.com" }],
  paths: { "/users/{id}": { get: { parameters: [{ in: "query", name: "limit", schema: { default: 10 } }], responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } } } } },
  components: { schemas: { User: { type: "object", required: ["id"], properties: { id: { type: "integer" }, manager: { nullable: true, allOf: [{ $ref: "#/components/schemas/User" }] } } } } }
};

test("OpenAPI preview preserves user values and unrelated request settings", async () => {
  const parsed = parseOpenApi(JSON.stringify(spec));
  assert.equal(openApiOperations(parsed)[0].value, "get /users/{id}");
  const request = { method: "POST", auth: { token: "private" }, scriptPreRequest: "script", body: "unchanged", queryParams: [{ key: "limit", value: "50", enabled: false }], headers: [{ key: "X-Custom", value: "keep" }] };
  const { patch, changes } = planOpenApiSync(parsed, "get /users/{id}", request);
  assert.equal(patch.url, "https://api.example.com/users/{{id}}");
  assert.equal(patch.queryParams[0].value, "50");
  assert.equal(patch.queryParams[0].enabled, false);
  assert.equal(patch.headers[0].value, "keep");
  assert.equal(patch.auth, undefined);
  assert.equal(patch.body, undefined);
  assert.ok(changes.includes("contract"));
  assert.equal((await validateJsonAgainstSchema({ id: 1, manager: null }, patch.contract.responses[200])).ok, true);
  assert.equal((await validateJsonAgainstSchema({ id: 1, manager: { id: "wrong" } }, patch.contract.responses[200])).ok, false);
});

test("OpenAPI imports reject unsupported versions and unresolved references", () => {
  assert.throws(() => parseOpenApi('{"swagger":"2.0"}'), /OpenAPI 3/);
  assert.throws(() => bundleResponseSchema(spec, { $ref: "https://example.com/x" }), /External/);
  assert.throws(() => bundleResponseSchema(spec, { $ref: "#/components/missing" }), /Missing/);
  assert.equal(parseOpenApi('openapi: 3.1.0\npaths: {}').openapi, "3.1.0");
  assert.equal(planOpenApiSync({ ...spec, servers: [] }, "get /users/{id}", {}).patch.url, "{{base_url}}/users/{{id}}");
  assert.throws(() => bundleResponseSchema(spec, { $schema: "https://untrusted.example/schema", type: "string" }), /Unsupported/);
});

test("selective OpenAPI sync preserves local fields and reviews previously imported removals", () => {
  const request = { body: "local body", auth: { type: "bearer", token: "secret" }, headers: [{ key: "X-Local", value: "yes" }], queryParams: [{ key: "local", value: "keep" }], contract: { responses: { 418: true } } };
  const first = planOpenApiSync(spec, "get /users/{id}", request);
  const imported = { ...request, ...applyOpenApiSync(first, request, ["queryParams", "contract"]) };
  assert.equal(imported.body, "local body");
  assert.equal(imported.auth.token, "secret");
  assert.equal(imported.url, undefined);
  assert.equal(imported.contract.responses[418], true);
  const changed = structuredClone(spec);
  changed.paths["/users/{id}"].get.parameters = [];
  changed.paths["/users/{id}"].get.responses = {};
  const next = planOpenApiSync(changed, "get /users/{id}", imported);
  assert.deepEqual(next.removed.queryParams, ["limit"]);
  assert.deepEqual(next.removed.responses, ["200"]);
  const kept = { ...imported, ...applyOpenApiSync(next, imported, ["queryParams", "contract"]) };
  assert.ok(kept.queryParams.some((row) => row.key === "limit"));
  assert.deepEqual(planOpenApiSync(changed, "get /users/{id}", kept).removed.queryParams, ["limit"]);
  const removed = applyOpenApiSync(next, imported, ["queryParams", "contract"], { removeObsolete: true });
  assert.deepEqual(removed.queryParams, request.queryParams);
  assert.deepEqual(removed.contract.responses, { 418: true });
  const unselected = applyOpenApiSync(next, imported, ["url"], { removeObsolete: true });
  assert.equal(unselected.queryParams, undefined);
  assert.ok(unselected.contract.responses[200]);
});

test("OpenAPI bodies and authentication require selection and use the request model", () => {
  const changed = structuredClone(spec);
  const operation = changed.paths["/users/{id}"].get;
  operation.requestBody = { content: { "application/problem+json": { example: { title: "Example" } } } };
  operation.security = [{ key: [] }, { oauth: ["users:read"] }];
  changed.components.securitySchemes = {
    key: { type: "apiKey", in: "query", name: "api_key" },
    oauth: { type: "oauth2", flows: { authorizationCode: { authorizationUrl: "https://example.com/auth", tokenUrl: "https://example.com/token" } } }
  };
  const request = { body: "custom", headers: [{ key: "content-type", value: "text/plain" }, { key: "X-Local", value: "yes" }], auth: { type: "bearer", token: "secret" } };
  const plan = planOpenApiSync(changed, "get /users/{id}", request);
  const safe = applyOpenApiSync(plan, request, ["url"]);
  assert.equal(safe.body, undefined);
  assert.equal(safe.auth, undefined);
  const patch = applyOpenApiSync(plan, request, ["body", "auth"], { securityChoice: "0" });
  assert.equal(patch.bodyType, "json");
  assert.deepEqual(JSON.parse(patch.body), { title: "Example" });
  assert.deepEqual(patch.headers.map((row) => row.key), ["X-Local", "Content-Type"]);
  assert.equal(patch.headers[1].value, "application/problem+json");
  assert.deepEqual(patch.auth, { type: "apikey", apiKeyName: "api_key", apiKeyIn: "query", apiKeyValue: "" });
  const oauth = applyOpenApiSync(plan, request, ["auth"], { securityChoice: "1:authorizationCode" });
  assert.equal(oauth.auth.oauth2.scope, "users:read");
  assert.equal(oauth.auth.oauth2.tokenUrl, "https://example.com/token");
  assert.equal(oauth.auth.token, undefined);
  assert.throws(() => applyOpenApiSync(plan, request, ["auth"]), /Select an authentication/);
});

test("OpenAPI schema samples are bounded and form bodies leave multipart boundaries to the client", () => {
  const changed = structuredClone(spec);
  changed.paths["/users/{id}"].get.requestBody = { content: { "multipart/form-data": { schema: { type: "object", properties: { name: { type: "string", default: "Ada" }, id: { type: "integer", readOnly: true } } } } } };
  const request = { headers: [{ key: "Content-Type", value: "application/json" }] };
  const plan = planOpenApiSync(changed, "get /users/{id}", request);
  const patch = applyOpenApiSync(plan, request, ["body"]);
  assert.equal(patch.bodyType, "form-data");
  assert.deepEqual(patch.bodyRows.map((row) => [row.key, row.value]), [["name", "Ada"]]);
  assert.deepEqual(patch.headers, []);
  changed.paths["/users/{id}"].get.requestBody.content = { "application/json": { schema: { $ref: "#/components/schemas/User" } } };
  assert.doesNotThrow(() => planOpenApiSync(changed, "get /users/{id}", request));
  changed.paths["/users/{id}"].get.security = [{ missing: [] }, { a: [], b: [] }];
  const unsupported = planOpenApiSync(changed, "get /users/{id}", request);
  assert.equal(unsupported.security.length, 0);
  assert.ok(unsupported.warnings.some((warning) => warning.includes("manual configuration")));
});

test("GraphQL introspection, validation, and completions use the actual schema", async () => {
  const schema = parseGraphqlSchema("type Query { user: User } type User { name: String! age: Int }");
  const result = await graphql({ schema, source: introspectionQuery });
  const loaded = parseGraphqlSchema(schemaFromIntrospection(result));
  assert.deepEqual(graphqlDiagnostics(loaded, "{ user { name } }"), []);
  assert.match(graphqlDiagnostics(loaded, "{ user { missing } }")[0], /Cannot query field/);
  const source = "{ user { na";
  const candidates = graphqlCompletions(loaded, source, source.length);
  assert.ok(candidates.some((item) => item.label === "name"));
  assert.ok(!candidates.some((item) => item.label === "user"));
  assert.throws(() => schemaFromIntrospection({ errors: [{ message: "Denied" }] }), /Denied/);
});
