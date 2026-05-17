import {
  cacheDel,
  cacheGet,
  cacheSet,
  fetchCacheKey,
  searchCacheKey,
} from "./cache.js";
import {
  CACHE_TTL_SECONDS,
  EXPAND_QUERIES_DEFAULT,
  SEARCH_MIN_INTERVAL_MS,
  SEARXNG_URL,
} from "./config.js";
import { applyDomainFilters } from "./domains.js";
import { expandQuery } from "./llm.js";
import { logger } from "./logger.js";
import type { SearxResponse, SearxResult, SearxSearchReturn } from "./types.js";

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

async function searxSearchSingleRaw(
  query: string,
  category: string,
  _fetchCount: number,
  timeRange?: string,
): Promise<SearxResponse> {
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

  return (await res.json()) as SearxResponse;
}

export async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
  domainProfile?: string,
  expand?: boolean,
): Promise<SearxSearchReturn> {
  const shouldExpand = expand ?? EXPAND_QUERIES_DEFAULT;

  // Fetch more than needed so reranker has a larger pool to work with
  const fetchCount = Math.min(numResults * 3, 30);

  // Check cache first (key includes fetchCount to avoid stale partial results)
  const key = searchCacheKey(query, category, timeRange, fetchCount);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
    try {
      const parsed = JSON.parse(cached) as SearxSearchReturn;
      // Domain filtering applied after cache retrieval so profile changes take effect immediately
      const filtered = applyDomainFilters(parsed.results, domainProfile);
      const enriched = await enrichWithFetchedContent(filtered);
      return {
        results: enriched,
        infoboxes: parsed.infoboxes,
        answers: parsed.answers,
        suggestions: parsed.suggestions,
        corrections: parsed.corrections,
      };
    } catch {
      logger.warn("Corrupted cache entry, removing");
      cacheDel(key); // best-effort cleanup
    }
  }

  // Fetch raw SearXNG response for extra fields (infoboxes, answers, suggestions)
  async function fetchRaw(
    query: string,
  ): Promise<{ results: SearxResult[]; response: SearxResponse }> {
    const data = await searxSearchSingleRaw(
      query,
      category,
      fetchCount,
      timeRange,
    );
    return { results: data.results.slice(0, fetchCount), response: data };
  }

  if (shouldExpand) {
    // Run original query + expanded variants in parallel, merge, deduplicate by URL
    const [variants, original] = await Promise.all([
      expandQuery(query),
      fetchRaw(query),
    ]);

    // Skip RRF if no variants were generated
    if (variants.length === 0) {
      const filtered = applyDomainFilters(original.results, domainProfile);
      const enriched = await enrichWithFetchedContent(filtered);
      return {
        results: enriched,
        infoboxes: original.response.infoboxes,
        answers: original.response.answers,
        suggestions: original.response.suggestions,
        corrections: original.response.corrections,
      };
    }

    const variantResults = await Promise.allSettled(
      variants.map((v) =>
        searxSearchSingleRaw(v, category, fetchCount, timeRange),
      ),
    );

    // RRF merge: Reciprocal Rank Fusion with k=60
    const lists: SearxResult[][] = [
      original.results,
      ...variantResults
        .filter((s) => s.status === "fulfilled")
        .map((s) => s.value.results.slice(0, fetchCount)),
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
    const cacheEntry: SearxSearchReturn = {
      results: original.results,
      infoboxes: original.response.infoboxes,
      answers: original.response.answers,
      suggestions: original.response.suggestions,
      corrections: original.response.corrections,
    };
    await cacheSet(key, JSON.stringify(cacheEntry), CACHE_TTL_SECONDS);

    const filtered = applyDomainFilters(merged, domainProfile);
    const enriched = await enrichWithFetchedContent(filtered);
    return {
      results: enriched,
      infoboxes: original.response.infoboxes,
      answers: original.response.answers,
      suggestions: original.response.suggestions,
      corrections: original.response.corrections,
    };
  }

  // Non-expanded path
  const raw = await fetchRaw(query);

  // Cache pre-filter results so domain config changes apply retroactively on cache hits
  const cacheEntry: SearxSearchReturn = {
    results: raw.results,
    infoboxes: raw.response.infoboxes,
    answers: raw.response.answers,
    suggestions: raw.response.suggestions,
    corrections: raw.response.corrections,
  };
  await cacheSet(key, JSON.stringify(cacheEntry), CACHE_TTL_SECONDS);

  const filtered = applyDomainFilters(raw.results, domainProfile);
  const enriched = await enrichWithFetchedContent(filtered);
  return {
    results: enriched,
    infoboxes: raw.response.infoboxes,
    answers: raw.response.answers,
    suggestions: raw.response.suggestions,
    corrections: raw.response.corrections,
  };
}

/** For each result, check if we already have full content in the fetch cache.
 *  If so, replace the snippet with "[Previously fetched]" + cached text. */
async function enrichWithFetchedContent(
  results: SearxResult[],
): Promise<SearxResult[]> {
  return Promise.all(
    results.map(async (r) => {
      const cached = await cacheGet(fetchCacheKey(r.url));
      if (!cached) return r;
      try {
        const parsed = JSON.parse(cached) as { text?: string };
        if (parsed.text && parsed.text.length > 100) {
          return {
            ...r,
            content: `[Previously fetched]\n${parsed.text.slice(0, 800).replace(/[\uD800-\uDBFF]$/, "")}`,
          };
        }
      } catch {
        // Corrupted entry — skip enrichment
      }
      return r;
    }),
  );
}
