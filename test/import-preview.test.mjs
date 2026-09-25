import test from "node:test";
import assert from "node:assert/strict";

import { getImportPreview } from "../src/lib/import-preview.js";

test("import preview summarizes collections and compatibility warnings", () => {
  const preview = getImportPreview({
    detectedFormat: "postman",
    collection: {
      name: "Payments",
      folders: ["billing"],
      requests: [
        { name: "Create", url: "/payments", requestMode: "http" },
        { name: "Create", url: "https://api.example.com/payments", requestMode: "http" },
      ],
    },
  }, "collection");

  assert.deepEqual(preview, {
    format: "POSTMAN",
    name: "Payments",
    requestCount: 2,
    folderCount: 1,
    warnings: [
      "1 duplicate request name may be renamed to keep them addressable.",
      "1 request uses a relative URL. Add a base URL before sending.",
    ],
  });
});

test("request previews flag empty imports", () => {
  assert.deepEqual(getImportPreview({ detectedFormat: "openapi3", requests: [] }, "request").warnings, [
    "No requests were found in this file.",
  ]);
});
