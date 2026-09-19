export const GITHUB_STARS_CACHE_KEY = "kivo:github-stars:v1";
const CACHE_TTL = 60 * 60 * 1000;

export function readStarCache(storage, now = Date.now()) {
  try {
    const entry = JSON.parse(storage.getItem(GITHUB_STARS_CACHE_KEY));
    if (!Number.isSafeInteger(entry?.count) || entry.count < 0 || !Number.isFinite(entry.at)) return null;
    return { ...entry, fresh: entry.at <= now && now - entry.at < CACHE_TTL };
  } catch {
    return null;
  }
}

export async function fetchStarCount(fetcher, signal) {
  const response = await fetcher("https://api.github.com/repos/TrisH0x2A/Kivo", {
    signal,
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error("GitHub star count unavailable");
  const { stargazers_count: count } = await response.json();
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid GitHub star count");
  return count;
}

export function formatStarCount(count) {
  if (count === null) return "--";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}
