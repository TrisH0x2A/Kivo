import test from "node:test";
import assert from "node:assert/strict";
import { hexPage, responseTable, searchResponse, tableCell, tableCsv } from "../src/lib/response-inspection.js";

test("JSON table discovers later columns, nested paths and scalar values", () => {
  const table = responseTable('{"items":[{"id":1},{"id":2,"label":"later"}]}', "/items");
  assert.deepEqual(table.columns, ["id", "label"]);
  assert.equal(tableCell(table.rows[0], "label"), "");
  assert.equal(tableCell(null, "(value)"), "null");
  assert.equal(tableCell(false, "(value)"), "false");
  assert.deepEqual(responseTable('{"a/b":[1,2]}', "/a~1b").rows, [1, 2]);
  assert.throws(() => responseTable('{}', '/__proto__'), /does not exist/);
});

test("CSV exports all rows, escapes strings and neutralizes spreadsheet formulas", () => {
  const table = responseTable(JSON.stringify([{ name: 'A,"B"\nC', nested: { id: 1 }, formula: "=SUM(A1)" }, { name: "tail" }]));
  const csv = tableCsv(table);
  assert.ok(csv.includes('"A,""B""\nC"'));
  assert.ok(csv.includes('"\'=SUM(A1)"'));
  assert.ok(csv.endsWith('"tail","",""'));
  assert.equal(tableCsv(responseTable('[-2]')), '"(value)"\r\n"-2"');
});

test("full-body literal search finds text beyond editor limits and keeps bounded snippets", () => {
  const text = "x".repeat(1_000_005) + "[Needle]. [needle].";
  const result = searchResponse(text, "[needle].");
  assert.equal(result.count, 2);
  assert.equal(result.matches[0].offset, 1_000_005);
  assert.equal(searchResponse(text, "[needle].", true).count, 1);
  const many = searchResponse("a ".repeat(1000), "a");
  assert.equal(many.count, 1000);
  assert.equal(many.matches.length, 200);
  assert.equal(searchResponse("anything", "").count, 0);
});

test("hex view preserves binary bytes and paginates with absolute offsets", () => {
  const bytes = Buffer.alloc(1050, 255); bytes[0] = 65; bytes[1] = 0;
  const first = hexPage({ bodyBase64: bytes.toString("base64") }, 0);
  assert.equal(first.bytes, 1050);
  assert.equal(first.pages, 2);
  assert.ok(first.lines[0].hex.startsWith("41 00 ff"));
  assert.ok(first.lines[0].ascii.startsWith("A.."));
  assert.equal(hexPage({ bodyBase64: bytes.toString("base64") }, 1).lines[0].offset, "00000400");
  assert.equal(hexPage({ body: "a" }).lines[0].hex, "61");
});
