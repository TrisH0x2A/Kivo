import test from "node:test";
import assert from "node:assert/strict";
import { searchWorkbench } from "../src/lib/workbench-search.js";
const workspaces = [{ name: "Production", collections: [{ name: "Gateway", requests: [
  { name: "Health", method: "GET", requestMode: "http", url: "https://example.com/health" },
  { name: "Greeting", method: "POST", requestMode: "grpc", grpcMethodPath: "/Greeter/SayHello" },
] }] }, { name: "Staging", collections: [{ name: "Billing", requests: [{ name: "Health", method: "GET", requestMode: "http", url: "https://billing.example.com" }] }] }];

test("workbench search scopes repeated request names across workspaces", () => {
  const results = searchWorkbench(workspaces, "staging health");
  assert.equal(results.length, 1);
  assert.equal(results[0].collectionName, "Billing");
});
test("workbench search finds URL, protocol, and gRPC method", () => {
  assert.equal(searchWorkbench(workspaces, "GET example.com/health")[0].label, "Health");
  assert.equal(searchWorkbench(workspaces, "grpc sayhello")[0].label, "Greeting");
  assert.equal(searchWorkbench(workspaces, "missing").length, 0);
});
test("empty search contains collection and request destinations", () => {
  assert.equal(searchWorkbench(workspaces).length, 5);
  assert.equal(searchWorkbench([], "hello").length, 0);
});
