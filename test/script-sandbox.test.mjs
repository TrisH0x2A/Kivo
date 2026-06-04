import test from "node:test";
import assert from "node:assert/strict";

import { validateScriptSource } from "../src/lib/script-sandbox.js";

test("validateScriptSource allows kivo api usage", () => {
  assert.equal(validateScriptSource("kivo.request.addHeader('X-Test', '1');"), "");
});

test("validateScriptSource blocks renderer globals", () => {
  assert.equal(validateScriptSource("window.localStorage.clear();"), "Blocked unsafe script token: window");
});

test("validateScriptSource blocks constructor escape attempts", () => {
  assert.equal(validateScriptSource("kivo.log(({}).constructor);"), "Blocked unsafe script token: constructor");
});

test("validateScriptSource blocks module runtime probes", () => {
  assert.equal(validateScriptSource("process.env"), "Blocked unsafe script token: process");
  assert.equal(validateScriptSource("await import('node:fs')"), "Blocked unsafe script token: import");
});
