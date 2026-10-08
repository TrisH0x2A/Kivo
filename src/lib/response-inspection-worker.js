import { hexPage, responseTable, searchResponse, tableCell, tableCsv } from "./response-inspection.js";

self.onmessage = ({ data }) => {
  try {
    const { mode, body, pointer, page, query, caseSensitive } = data;
    let result;
    if (mode === "Search") result = searchResponse(body, query, caseSensitive);
    else if (mode === "Hex") result = hexPage(data, page);
    else {
      const table = responseTable(body, pointer);
      if (mode === "csv") result = { csv: tableCsv(table) };
      else result = { columns: table.columns, count: table.rows.length, pages: Math.max(1, Math.ceil(table.rows.length / 100)), rows: table.rows.slice(page * 100, (page + 1) * 100).map((row) => table.columns.map((column) => tableCell(row, column).slice(0, 4000))) };
    }
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: String(error.message || error) }); }
};
