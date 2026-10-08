export function responseTable(body, pointer = "") {
  if (body.length > 16_000_000) throw new Error("Table view supports JSON bodies up to 16 MB.");
  let value = JSON.parse(body);
  if (pointer && !pointer.startsWith("/")) throw new Error("Use a JSON pointer such as /items.");
  for (const segment of pointer ? pointer.slice(1).split("/") : []) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("The selected JSON path does not exist.");
    value = value[key];
  }
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length > 200_000) throw new Error("Table view supports up to 200,000 rows. Select a narrower JSON path.");
  const columns = new Set();
  for (const row of rows) {
    const keys = row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : ["(value)"];
    keys.forEach((key) => columns.add(key));
    if (columns.size > 200) throw new Error("Table view supports up to 200 columns. Select a narrower JSON path.");
  }
  return { columns: [...columns], rows };
}

export function tableCell(row, column) {
  const value = row && typeof row === "object" && !Array.isArray(row) ? (Object.hasOwn(row, column) ? row[column] : undefined) : column === "(value)" ? row : undefined;
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function tableCsv(table) {
  // Spreadsheet programs interpret formula-like strings even inside CSV quotes.
  const escape = (value, number = false) => `"${(!number && /^[\s]*[=+@\-\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const lines = [table.columns.map((column) => escape(column)).join(",")];
  let length = lines[0].length;
  for (const row of table.rows) {
    const line = table.columns.map((column) => escape(tableCell(row, column), typeof (row && typeof row === "object" && !Array.isArray(row) ? row[column] : row) === "number")).join(",");
    length += line.length + 2;
    if (length > 32_000_000) throw new Error("CSV output exceeds 32 MB. Select a narrower JSON path.");
    lines.push(line);
  }
  return lines.join("\r\n");
}

export function searchResponse(body, query, caseSensitive = false) {
  if (!query) return { count: 0, matches: [] };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
  const matches = [];
  let count = 0;
  for (let match; (match = pattern.exec(body));) {
    count++;
    if (matches.length < 200) matches.push({ offset: match.index, before: body.slice(Math.max(0, match.index - 60), match.index), match: match[0], after: body.slice(match.index + match[0].length, match.index + match[0].length + 100) });
  }
  return { count, matches };
}

export function hexPage({ body = "", bodyBase64 = "" }, page = 0) {
  const bytes = bodyBase64 ? Uint8Array.from(atob(bodyBase64), (char) => char.charCodeAt(0)) : new TextEncoder().encode(body);
  const pages = Math.max(1, Math.ceil(bytes.length / 1024));
  const offset = Math.max(0, Math.min(pages - 1, page)) * 1024;
  const lines = [];
  for (let start = offset; start < Math.min(bytes.length, offset + 1024); start += 16) {
    const row = bytes.slice(start, start + 16);
    lines.push({ offset: start.toString(16).padStart(8, "0"), hex: [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" "), ascii: [...row].map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("") });
  }
  return { lines, pages, bytes: bytes.length };
}
