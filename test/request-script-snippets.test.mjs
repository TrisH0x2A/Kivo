import test from "node:test";
import assert from "node:assert/strict";

import { SCRIPT_AUTOCOMPLETE_ITEMS, SCRIPT_SNIPPET_GROUPS } from "../src/lib/request-script-snippets.js";

test("request script snippets expose grouped inserts", () => {
  assert.ok(SCRIPT_SNIPPET_GROUPS.length >= 3);
  assert.ok(SCRIPT_SNIPPET_GROUPS.every((group) => group.key && group.label && group.items.length));
  assert.ok(SCRIPT_AUTOCOMPLETE_ITEMS.some((item) => item.label === "kivo.test"));
});
