import test from "node:test";
import assert from "node:assert/strict";

import { parseCookies, splitSetCookieHeader } from "../src/lib/cookie-utils.js";

test("splitSetCookieHeader preserves expires dates", () => {
  assert.deepEqual(
    splitSetCookieHeader("session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, theme=dark; Path=/"),
    [
      "session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
      "theme=dark; Path=/",
    ]
  );
});

test("splitSetCookieHeader preserves quoted commas", () => {
  assert.deepEqual(splitSetCookieHeader('prefs="compact,quiet"; Path=/, token=xyz'), [
    'prefs="compact,quiet"; Path=/',
    "token=xyz",
  ]);
});

test("parseCookies finds set-cookie case insensitively", () => {
  assert.deepEqual(parseCookies({ "Set-Cookie": "a=1, b=2" }), ["a=1", "b=2"]);
});
