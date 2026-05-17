import { cacheGet, cacheSet, searchCacheKey } from "./cache.js";
import {
  CACHE_TTL_SECONDS,
  EXPAND_QUERIES_DEFAULT,
  SEARCH_MIN_INTERVAL_MS,
  SEARXNG_URL,
} from "./config.js";
import { applyDomainFilters } from "./domains.js";
import { expandQuery } from "./llm.js";
import { logger } from "./logger.js";
import type { SearxResponse, SearxResult } from "./types.js";

let nextAvailable = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextAvailable - now);
  nextAvailable = Math.max(now, nextAvailable) + SEARCH_MIN_INTERVAL_MS;
  if (wait > 0) {
    await new Promise<void>((r) => setTimeout(r, wait));
  }
}

export async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
): Promise<SearxResult[]> {
  await throttle();
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: category,
    pageno: "1",
  });
  if (timeRange) params.set("time_range", timeRange);

  const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`SearXNG error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as SearxResponse;
  return data.results.slice(0, fetchCount);
}

export async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
  domainProfile?: string,
  expand?: boolean,
): Promise<SearxResult[]> {
  const shouldExpand = expand ?? EXPAND_QUERIES_DEFAULT;

  // Fetch more than needed so reranker has a larger pool to work with
  const fetchCount = Math.min(numResults * 3, 30);

  // Check cache first (key includes fetchCount to avoid stale partial results)
  const key = searchCacheKey(query, category, timeRange, fetchCount);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
    try {
      const results = JSON.parse(cached) as SearxResult[];
      // Domain filtering applied after cache retrieval so profile changes take effect immediately
      return applyDomainFilters(results, domainProfile);
    } catch {
      logger.warn("Corrupted cache entry, removing");
      cacheSet(key, "", 0).catch(() => {}); // best-effort cleanup
    }
  }

  if (shouldExpand) {
    // Run original query + expanded variants in parallel, merge, deduplicate by URL
    const [variants, originalResults] = await Promise.all([
      expandQuery(query),
      searxSearchSingle(query, category, fetchCount, timeRange),
    ]);

    const variantResults = await Promise.allSettled(
      variants.map((v) =>
        searxSearchSingle(v, category, fetchCount, timeRange),
      ),
    );

    // RRF merge: Reciprocal Rank Fusion with k=60
    const lists = [
      originalResults,
      ...variantResults
        .filter((s) => s.status === "fulfilled")
        .map((s) => s.value),
    ];
    const urlRanks = new Map<string, { score: number; result: SearxResult }>();
    const K = 60;
    for (const list of lists) {
      for (let rank = 0; rank < list.length; rank++) {
        const r = list[rank];
        const entry = urlRanks.get(r.url);
        if (entry) {
          entry.score += 1 / (K + rank);
        } else {
          urlRanks.set(r.url, { score: 1 / (K + rank), result: r });
        }
      }
    }
    const merged = [...urlRanks.values()]
      .sort((a, b) => b.score - a.score)
      .map((e) => e.result);

    // Cache only the original query results (not the expanded pool)
    await cacheSet(key, JSON.stringify(originalResults), CACHE_TTL_SECONDS);

    return applyDomainFilters(merged, domainProfile);
  }

  // Non-expanded path
  const raw = await searxSearchSingle(query, category, fetchCount, timeRange);

  // Cache pre-filter results so domain config changes apply retroactively on cache hits
  await cacheSet(key, JSON.stringify(raw), CACHE_TTL_SECONDS);

  return applyDomainFilters(raw, domainProfile);
}
