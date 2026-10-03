import assert from "node:assert/strict";
import test from "node:test";
import { buildRegressionBaseline, compareRegressionBaseline, upsertRegressionBaseline } from "../src/lib/regression-baselines.js";

const response = { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, rawBody: '{"ok":true}', body: '{"ok":true}', contentType: "application/json" };

test("baselines snapshot response content without mutating the live response", () => {
  const baseline = buildRegressionBaseline(response, "Release 1");
  response.headers["x-live"] = "changed";
  assert.equal(baseline.name, "Release 1");
  assert.equal(baseline.response.headers["x-live"], undefined);
  assert.equal(compareRegressionBaseline(baseline, { ...response, rawBody: '{"ok":false}', body: '{"ok":false}' }).body.changed, true);
});

test("baseline versions are named, bounded, and reject collisions", () => {
  const first = buildRegressionBaseline(response, "Stable");
  const next = buildRegressionBaseline({ ...response, status: 201 }, "Stable", first.id);
  assert.equal(upsertRegressionBaseline([first], next).length, 1);
  assert.throws(() => upsertRegressionBaseline([first], buildRegressionBaseline(response, "stable")), /already exists/);
  assert.throws(() => buildRegressionBaseline({ status: 0 }, "Empty"), /completed/);
  assert.throws(() => buildRegressionBaseline(response, ""), /names/);
});
