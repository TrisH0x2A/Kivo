import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonAgainstSchema, selectResponseSchema } from "../src/lib/contract-validation.js";
import { validateResponseBodyAgainstRequest } from "../src/lib/api-design.js";
import { bundleResponseSchema, openApiOperations, parseOpenApi, planOpenApiSync } from "../src/lib/openapi-contract.js";
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
