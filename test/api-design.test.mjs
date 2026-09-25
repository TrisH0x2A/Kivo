import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMockFromRequest,
  buildOpenApiOperation,
  buildRequestJsonSchema,
  validateResponseBodyAgainstRequest
} from "../src/lib/api-design.js";

test("buildRequestJsonSchema infers nested JSON request bodies", () => {
  const schema = buildRequestJsonSchema({
    bodyType: "json",
    body: "{\"id\":42,\"active\":true,\"profile\":{\"name\":\"Ada\"}}"
  });

  assert.deepEqual(schema.properties.id, { type: "integer" });
  assert.deepEqual(schema.properties.active, { type: "boolean" });
  assert.deepEqual(schema.properties.profile.properties.name, { type: "string" });
});

test("buildMockFromRequest creates a sample response from schema", () => {
  assert.deepEqual(buildMockFromRequest({
    bodyType: "json",
    body: "{\"id\":42,\"tags\":[\"api\"]}"
  }), {
    id: 1,
    tags: ["string"]
  });
});

test("buildOpenApiOperation includes params headers and request body", () => {
  const operation = buildOpenApiOperation({
    name: "Create user",
    method: "POST",
    bodyType: "json",
    body: "{\"name\":\"Ada\"}",
    queryParams: [{ key: "team", value: "core", enabled: true }],
    headers: [{ key: "X-Trace", value: "1", enabled: true }]
  });

  assert.equal(operation.summary, "Create user");
  assert.equal(operation.parameters.length, 2);
  assert.equal(operation.requestBody.content["application/json"].schema.properties.name.type, "string");
});

test("validateResponseBodyAgainstRequest passes explicit response contracts", async () => {
  const result = await validateResponseBodyAgainstRequest({
    contract: { responses: { default: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } },
    bodyType: "json",
    body: "{\"id\":42,\"profile\":{\"name\":\"Ada\"}}"
  }, "{\"id\":7,\"profile\":{\"name\":\"Grace\"}}");

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateResponseBodyAgainstRequest reports contract mismatches", async () => {
  const result = await validateResponseBodyAgainstRequest({
    contract: { responses: { default: { type: "object", required: ["active"], properties: { id: { type: "integer" } } } } },
    bodyType: "json",
    body: "{\"id\":42,\"active\":true}"
  }, "{\"id\":\"42\"}");

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("required")));
  assert.ok(result.errors.some((error) => error.includes("type")));
});
