import test from "node:test";
import assert from "node:assert/strict";

import { buildMockFromRequest, buildOpenApiOperation, buildRequestJsonSchema } from "../src/lib/api-design.js";

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
