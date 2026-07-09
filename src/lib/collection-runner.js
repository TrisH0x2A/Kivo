const RUNNABLE_REQUEST_MODES = new Set(["http", "graphql"]);

export function normalizeRunnerFolderPath(path) {
  return String(path ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

export function getRunnableRequests(collection, folderFilter) {
  const folder = normalizeRunnerFolderPath(folderFilter);
  return (collection?.requests || [])
    .filter((request) => RUNNABLE_REQUEST_MODES.has(request.requestMode))
    .filter((request) => !folder || normalizeRunnerFolderPath(request.folderPath) === folder)
    .map((request, index) => ({ request, index }));
}

export function parseCsvTable(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows.filter((entry) => entry.some((value) => String(value || "").trim()));
}

export function parseRunnerDataRows(source) {
  const text = String(source || "").trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((row) => row && typeof row === "object" && !Array.isArray(row))
        .map((row, index) => ({ id: `row-${index + 1}`, values: row }));
    }
    if (parsed && typeof parsed === "object") {
      return [{ id: "row-1", values: parsed }];
    }
  } catch {}

  const csvRows = parseCsvTable(text);
  if (csvRows.length < 2) return [];
  const headers = csvRows[0].map((part) => part.trim()).filter(Boolean);
  if (!headers.length) return [];
  return csvRows.slice(1).map((cells, index) => {
    const values = {};
    headers.forEach((header, cellIndex) => {
      values[header] = String(cells[cellIndex] ?? "").trim();
    });
    return { id: `row-${index + 1}`, values };
  });
}

export function applyRunnerDataRow(request, row) {
  if (!row?.values) return request;
  const variables = Object.fromEntries(
    Object.entries(row.values).map(([key, value]) => [String(key), String(value ?? "")])
  );
  const replaceVars = (value) => String(value ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(variables, key.trim()) ? variables[key.trim()] : match
  ));
  const patchRows = (rows) => Array.isArray(rows)
    ? rows.map((item) => ({ ...item, value: replaceVars(item?.value) }))
    : rows;
  return {
    ...request,
    url: replaceVars(request.url),
    body: replaceVars(request.body),
    graphqlVariables: typeof request.graphqlVariables === "string"
      ? replaceVars(request.graphqlVariables)
      : request.graphqlVariables,
    headers: patchRows(request.headers),
    queryParams: patchRows(request.queryParams),
  };
}

export function buildRunReport({ collectionName, folderFilter, dataRows, summary, results }) {
  return {
    collection: collectionName || "",
    folder: folderFilter || "All folders",
    dataRows: dataRows.length,
    summary,
    generatedAt: new Date().toISOString(),
    results: results.map((item) => ({
      name: item.name,
      method: item.method,
      url: item.url,
      dataRow: item.dataRowName || "",
      status: item.status,
      statusCode: item.statusCode,
      duration: item.duration,
      attempts: item.attempts,
      tests: item.tests || [],
      error: item.error || "",
    })),
  };
}
