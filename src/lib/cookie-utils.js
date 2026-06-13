export function splitSetCookieHeader(value) {
  const source = String(value ?? "");
  const cookies = [];
  let start = 0;
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '"' && source[index - 1] !== "\\") {
      quoted = !quoted;
      continue;
    }
    if (source[index] !== "," || quoted) continue;

    const remainder = source.slice(index + 1);
    if (!/^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=/.test(remainder)) continue;

    const cookie = source.slice(start, index).trim();
    if (cookie) cookies.push(cookie);
    start = index + 1;
  }

  const tail = source.slice(start).trim();
  if (tail) cookies.push(tail);
  return cookies;
}

export function parseCookies(headers) {
  const cookieHeader = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "set-cookie");
  return cookieHeader ? splitSetCookieHeader(cookieHeader[1]) : [];
}
