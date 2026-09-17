import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkspaceStartup } from "../src/lib/workspace-startup.js";

test("startup checks storage before loading a workspace", async () => {
  const calls = [];
  const store = { workspaces: [{ name: "Existing" }] };
  const result = await loadWorkspaceStartup({
    readConfig: async () => { calls.push("config"); return { storagePath: "vault" }; },
    readState: async () => { calls.push("state"); return store; },
    normalize: (value) => { calls.push("normalize"); return value; },
  });
  assert.deepEqual(calls, ["config", "state", "normalize"]);
  assert.equal(result.store, store);
  assert.equal(result.needsSetup, false);
});

test("unconfigured storage does not load or normalize a default snapshot", async () => {
  assert.deepEqual(await loadWorkspaceStartup({
    readConfig: async () => ({}),
    readState: () => assert.fail("must not load"),
    normalize: () => assert.fail("must not normalize"),
  }), { needsSetup: true });
});

test("configuration failures cannot proceed to loading", async () => {
  await assert.rejects(loadWorkspaceStartup({
    readConfig: async () => { throw new Error("Configuration unreadable"); },
    readState: () => assert.fail("must not load"),
    normalize: () => assert.fail("must not normalize"),
  }), /Configuration unreadable/);
});

test("failed loads never normalize an empty fallback and can be retried", async () => {
  let attempt = 0;
  const options = {
    readConfig: async () => ({ storagePath: "vault" }),
    readState: async () => {
      if (++attempt === 1) throw new Error("Storage unavailable");
      return { workspaces: [{ name: "Recovered" }] };
    },
    normalize: (value) => value,
  };
  await assert.rejects(loadWorkspaceStartup(options), /Storage unavailable/);
  assert.equal((await loadWorkspaceStartup(options)).store.workspaces[0].name, "Recovered");
});

test("invalid snapshots fail closed but an intentional empty workspace is valid", async () => {
  for (const snapshot of [null, undefined, {}, { workspaces: null }]) {
    await assert.rejects(loadWorkspaceStartup({
      readConfig: async () => ({ storagePath: "vault" }),
      readState: async () => snapshot,
      normalize: () => assert.fail("must not normalize"),
    }), /invalid workspace snapshot/);
  }
  const result = await loadWorkspaceStartup({
    readConfig: async () => ({ storagePath: "vault" }),
    readState: async () => ({ workspaces: [] }),
    normalize: (value) => value,
  });
  assert.deepEqual(result.store.workspaces, []);
});
