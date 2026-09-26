import test from "node:test";
import assert from "node:assert/strict";
import { appendRegressionScript, buildRegressionScript, getRegressionFields } from "../src/lib/response-regression.js";
import { validateScriptSource } from "../src/lib/script-sandbox.js";

test("regression fields preserve literal paths, limit traversal, and restrict sensitive values", () => {
  const response = { status: 200, body: '{"a.b":1,"nested":{"token":"secret"},"items":[true,false],"constructor":"hidden"}' };
  const fields = getRegressionFields(response);
  assert.ok(fields.some((field) => field.id === '["a.b"]'));
  assert.ok(fields.some((field) => field.id === '["items",0]'));
  assert.ok(!fields.some((field) => field.path.includes("constructor")));
  assert.throws(() => buildRegressionScript(response, { fields: [{ id: '["nested","token"]', mode: "value" }] }), /non-sensitive/);
  assert.equal(getRegressionFields({ body: JSON.stringify(Array(10000).fill({ a: 1 })) }).length, 3);
  assert.equal(getRegressionFields({ body: "x".repeat(1_000_001) }).length, 0);
});

test("generation handles sandbox tokens as data, validates ranges, and preserves existing scripts", () => {
  const response = { status: 200, body: '{"location":"document","count":2}' };
  const script = buildRegressionScript(response, { fields: [{ id: '["location"]', mode: "value" }] });
  assert.equal(validateScriptSource(script), "");
  assert.equal(appendRegressionScript("kivo.log(1);", script), `kivo.log(1);\n\n${script}`);
  assert.throws(() => buildRegressionScript(response, { fields: [{ id: '["count"]', mode: "range", min: 3, max: 1 }] }), /minimum/);
  assert.throws(() => appendRegressionScript("x".repeat(20000), script), /too large/);
  assert.throws(() => appendRegressionScript("", ""), /Select/);
});
