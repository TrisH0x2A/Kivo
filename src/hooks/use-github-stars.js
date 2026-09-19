import { useEffect, useState } from "react";
import { fetchStarCount, GITHUB_STARS_CACHE_KEY, readStarCache } from "@/lib/github-stars.js";

export function useGithubStars() {
  const [count, setCount] = useState(null);
  useEffect(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Storage is optional. */ }
    const cached = readStarCache(storage);
    if (cached) setCount(cached.count);
    if (cached?.fresh) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    fetchStarCount(window.fetch.bind(window), controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setCount(next);
      try { storage?.setItem(GITHUB_STARS_CACHE_KEY, JSON.stringify({ count: next, at: Date.now() })); } catch { /* Keep the live count when storage is unavailable. */ }
    }).catch(() => {}).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, []);
  return count;
}
