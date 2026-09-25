function displayValue(value) {
  if (value === undefined) return "<missing>";
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    return String(value);
  }
}

function walkJson(left, right, path = "$", entries = [], limit = 80) {
  if (entries.length >= limit) return entries;
  if (Object.is(left, right)) return entries;
  const leftObject = left && typeof left === "object";
  const rightObject = right && typeof right === "object";
  if (leftObject && rightObject && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (entries.length >= limit) break;
      walkJson(left[key], right[key], `${path}.${key}`, entries, limit);
    }
    return entries;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length && entries.length < limit; index += 1) {
      walkJson(left[index], right[index], `${path}[${index}]`, entries, limit);
    }
    return entries;
  }
  entries.push({ path, left: displayValue(left), right: displayValue(right) });
  return entries;
}

export function compareResponseBodies(leftBody, rightBody) {
  const leftText = String(leftBody ?? "");
  const rightText = String(rightBody ?? "");
  try {
    const left = JSON.parse(leftText);
    const right = JSON.parse(rightText);
    const entries = walkJson(left, right);
    return { mode: "json", changed: entries.length > 0, entries, truncated: entries.length >= 80 };
  } catch {
    return {
      mode: "text",
      changed: leftText !== rightText,
      entries: leftText === rightText ? [] : [{ path: "body", left: displayValue(leftText), right: displayValue(rightText) }],
      truncated: false,
    };
  }
}

export function compareResponses(left, right) {
  return {
    statusChanged: Number(left?.status || 0) !== Number(right?.status || 0),
    durationChanged: Number(left?.durationMs || 0) !== Number(right?.durationMs || 0),
    body: compareResponseBodies(left?.body || "", right?.body || ""),
  };
}
