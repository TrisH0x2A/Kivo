const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const equal = (a, b) => canonical(a) === canonical(b);

function identity(rows) {
  if (!rows.length || !rows.every(object)) return null;
  for (const key of ["id", "name", "key"]) {
    if (rows.every((row) => typeof row[key] === "string" && row[key])) return (row) => key === "name" ? `${row.folderPath || ""}/${row.name}` : row[key];
  }
  return null;
}

export function mergeStorage(base, local, remote, choices = {}) {
  const conflicts = [];
  const changes = [];
  function visit(base, local, remote, path) {
    if (equal(local, remote)) return local;
    if (equal(local, base)) { changes.push({ path, kind: remote === undefined ? "removed" : base === undefined ? "added" : "changed" }); return remote; }
    if (equal(remote, base)) return local;
    if ([base, local, remote].every(object)) {
      return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].map((key) => [key, visit(base[key], local[key], remote[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)]).filter(([, value]) => value !== undefined));
    }
    if ([base, local, remote].every(Array.isArray)) {
      const key = identity([...base, ...local, ...remote]);
      if (key && [base, local, remote].every((rows) => new Set(rows.map(key)).size === rows.length)) {
        const maps = [base, local, remote].map((rows) => new Map(rows.map((row) => [key(row), row])));
        return [...new Set([...local.map(key), ...remote.map(key), ...base.map(key)])].map((id) => visit(...maps.map((map) => map.get(id)), `${path}/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`)).filter((item) => item !== undefined);
      }
    }
    conflicts.push({ path: path || "/", base, local, remote });
    return choices[path || "/"] === "remote" ? remote : local;
  }
  return { value: visit(base, local, remote, ""), conflicts, changes };
}
