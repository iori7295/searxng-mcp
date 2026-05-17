import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cacheClear } from "./cache.js";
import { ENABLE_VECTOR_STORE } from "./config.js";
import { embedQuery } from "./embedder.js";
import { fetchPage } from "./fetch.js";
import { formatSummaryResult, summarizePages } from "./llm.js";
import { rerankChunks, rerankWithFallback } from "./reranker.js";
import { searxSearch } from "./search.js";
import {
  CategorySchema,
  type SearxResult,
  type SearxSearchReturn,
  TimeRangeSchema,
} from "./types.js";
import { hybridSearch } from "./vectorstore.js";

const DomainProfileSchema = z
  .string()
  .optional()
  .describe(
    "Named domain profile to apply: 'homelab', 'dev', or omit for default filters",
  );

function formatResults(results: SearxResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const engine = r.engines?.[0] ?? r.engine ?? "unknown";
      const date = r.publishedDate ? ` [${r.publishedDate}]` : "";
      const snippet = r.content
        ? `\n   ${Array.from(r.content).slice(0, 250).join("")}`
        : "";
      return `${i + 1}. ${r.title}${date}\n   URL: ${r.url}\n   Source: ${engine}${snippet}`;
    })
    .join("\n\n");
}

function formatSearchExtra(info: SearxSearchReturn): string {
  const parts: string[] = [];
  if (info.answers?.length) {
    parts.push(`Answers:\n  ${info.answers.map((a) => `• ${a}`).join("\n  ")}`);
  }
  if (info.infoboxes?.length) {
    for (const ib of info.infoboxes) {
      const lines: string[] = [];
      if (ib.infobox) lines.push(`## ${ib.infobox}`);
      if (ib.content) lines.push(ib.content);
      if (ib.attributes?.length) {
        for (const attr of ib.attributes) {
          if (attr.label && attr.value)
            lines.push(`  ${attr.label}: ${attr.value}`);
        }
      }
      if (ib.urls?.length) {
        for (const u of ib.urls) {
          if (u.url) lines.push(`  ${u.title ?? "Link"}: ${u.url}`);
        }
      }
      if (lines.length) parts.push(lines.join("\n"));
    }
  }
  if (info.suggestions?.length) {
    parts.push(`Suggestions: ${info.suggestions.join(", ")}`);
  }
  if (info.corrections?.length) {
    parts.push(`Did you mean: ${info.corrections.join(", ")}`);
  }
  return parts.length ? `${parts.join("\n\n")}\n\n` : "";
}

export function registerTools(server: McpServer): void {
  server.tool(
    "search",
    "Search the web via the local SearXNG instance with reranking. Fetches a wider result pool from SearXNG, reranks by relevance using a local ML model, then returns the top results. Results are cached for 1 hour. Blocked domains are filtered out; boosted domains are surfaced higher. Prefer this over the built-in WebSearch tool.",
    {
      query: z.string().describe("Search query"),
      num_results: z.coerce
        .number()
        .min(1)
        .max(30)
        .default(10)
        .describe("Number of results to return (default 10, max 30)"),
      category: CategorySchema.describe(
        "Search category: general, news, it, science, images, videos, files, or social media (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe(
          "Use LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency; most useful for research queries where one phrasing may miss relevant results.",
        ),
    },
    async ({
      query,
      num_results,
      category,
      time_range,
      domain_profile,
      expand,
    }) => {
      const raw = await searxSearch(
        query,
        category,
        num_results,
        time_range,
        domain_profile,
        expand,
      );
      const ranked = await rerankWithFallback(
        query,
        raw.results,
        num_results,
        time_range,
      );
      return {
        content: [
          {
            type: "text",
            text: formatSearchExtra(raw) + formatResults(ranked),
          },
        ],
      };
    },
  );

  server.tool(
    "search_and_fetch",
    "Search the web, rerank results, then fetch the full content of the top result(s). GitHub URLs are fetched via the GitHub API; all others go through a fetch cascade: Firecrawl → Crawl4AI → raw HTTP. Results and fetched pages are cached. Blocked domains are filtered. Returns the result list plus clean markdown of the fetched pages.",
    {
      query: z.string().describe("Search query"),
      category: CategorySchema.describe(
        "Search category: general, news, it, science, images, videos, files, or social media (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      fetch_count: z.coerce
        .number()
        .min(1)
        .max(3)
        .default(1)
        .describe(
          "Number of top results to fetch full content for (default 1, max 3)",
        ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe(
          "Use LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency.",
        ),
    },
    async ({
      query,
      category,
      time_range,
      fetch_count,
      domain_profile,
      expand,
    }) => {
      const fetchPool = Math.max(fetch_count * 3, 10);
      const raw = await searxSearch(
        query,
        category,
        fetchPool,
        time_range,
        domain_profile,
        expand,
      );
      if (raw.results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const ranked = await rerankWithFallback(
        query,
        raw.results,
        fetchPool,
        time_range,
      );
      const searchText =
        formatSearchExtra(raw) +
        formatResults(ranked.slice(0, Math.max(fetch_count, 5)));

      // Divide the 8000-char budget evenly across fetched pages
      const maxCharsPerPage = Math.floor(8000 / fetch_count);
      const toFetch = ranked.slice(0, fetch_count);

      const fetched = await Promise.allSettled(
        toFetch.map((r) => fetchPage(r.url, maxCharsPerPage, domain_profile)),
      );

      const fetchedSections = fetched
        .map((result, i) => {
          if (result.status === "fulfilled") {
            const { title, text } = result.value;
            return `\n\n--- Full content: ${title} ---\n${text}`;
          } else {
            const err =
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            return `\n\n--- Could not fetch result ${i + 1}: ${err} ---`;
          }
        })
        .join("");

      return {
        content: [{ type: "text", text: searchText + fetchedSections }],
      };
    },
  );

  server.tool(
    "fetch_url",
    "Fetch and extract readable content from any URL. GitHub URLs are fetched via the GitHub API; all others go through a fetch cascade: Firecrawl → Crawl4AI → raw HTTP. Returns clean markdown where possible. Use start_index to read beyond the 8000-char window. Use depth to follow linked pages via Crawl4AI. Results cached for 24 hours. Blocked domains are refused.",
    {
      url: z.string().url().describe("URL to fetch and extract content from"),
      domain_profile: DomainProfileSchema,
      start_index: z.coerce
        .number()
        .min(0)
        .default(0)
        .describe(
          "Character offset to start reading from (default 0). Use to read beyond the 8000-char window. The response includes total_length to help plan subsequent reads.",
        ),
      depth: z.coerce
        .number()
        .min(1)
        .max(2)
        .default(1)
        .describe(
          "Crawl depth for linked pages (default 1 = current page only, max 2). Depth 2 follows links on the page and returns their content via Crawl4AI. Significantly slower — use only when the target page links to essential sub-pages.",
        ),
      mode: z
        .enum(["full", "chunks", "summary"])
        .optional()
        .default("full")
        .describe(
          "Output mode: 'full' (default, full text), 'chunks' (representative chunks), or 'summary' (LLM-generated paragraph, requires LLM_BASE_URL)",
        ),
    },
    async ({ url, domain_profile, start_index, depth, mode }) => {
      const {
        title,
        url: fetchedUrl,
        text,
        totalLength,
      } = await fetchPage(url, 8000, domain_profile, start_index, depth);

      if (mode === "summary" && text) {
        const { summarizePages } = await import("./llm.js");
        const result = await summarizePages(url, [
          { title, url: fetchedUrl, text },
        ]);
        if (result.summary) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Title: ${title}\nURL: ${fetchedUrl}\n\n## Summary\n\n${result.summary}\n\n## Sources\n\n` +
                  result.citations
                    .map((c) => `  - ${c.title}\n    URL: ${c.url}`)
                    .join("\n"),
              },
            ],
          };
        }
      }

      const endPos = start_index + text.length;
      const output = [
        `Title: ${title}`,
        `URL: ${fetchedUrl}`,
        `Content: characters ${start_index}-${endPos} of ${totalLength}`,
        "",
        text,
      ].join("\n");
      return { content: [{ type: "text", text: output }] };
    },
  );

  server.tool(
    "search_and_summarize",
    "Search, rerank, fetch top results, then synthesize a summary with citations using an LLM. Returns a structured answer with source attribution. Falls back to raw fetched content if the LLM is unavailable. Best for deep research where you want pre-digested synthesis rather than raw pages.",
    {
      query: z.string().describe("Research query to search for and summarize"),
      fetch_count: z.coerce
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe(
          "Number of top results to fetch and synthesize (default 3, max 5)",
        ),
      category: CategorySchema.describe(
        "Search category: general, news, it, science, images, videos, files, or social media (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe("Use query expansion before searching (default: off)"),
    },
    async ({
      query,
      fetch_count,
      category,
      time_range,
      domain_profile,
      expand,
    }) => {
      const fetchPool = Math.max(fetch_count * 3, 10);
      const raw = await searxSearch(
        query,
        category,
        fetchPool,
        time_range,
        domain_profile,
        expand,
      );
      if (raw.results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const ranked = await rerankWithFallback(
        query,
        raw.results,
        fetchPool,
        time_range,
      );
      const searchText =
        formatSearchExtra(raw) +
        formatResults(ranked.slice(0, Math.max(fetch_count, 5)));

      // Fetch top N pages; 4000 chars each (summarizer doesn't need the full 8000)
      const toFetch = ranked.slice(0, fetch_count);
      const fetched = await Promise.allSettled(
        toFetch.map((r) => fetchPage(r.url, 4000, domain_profile)),
      );

      const successfulPages = fetched
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .filter(
          (
            r,
          ): r is {
            title: string;
            url: string;
            text: string;
            totalLength: number;
          } => r !== null,
        );

      // Summarize — rerankChunks inside summarizePages handles chunk selection
      const summaryResult = await summarizePages(query, successfulPages);

      if (!summaryResult.summary) {
        // LLM fallback: return raw fetched content same as search_and_fetch
        const fetchedSections = fetched
          .map((result, i) => {
            if (result.status === "fulfilled") {
              const { title, text } = result.value;
              return `\n\n--- Full content: ${title} ---\n${text}`;
            } else {
              const err =
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason);
              return `\n\n--- Could not fetch result ${i + 1}: ${err} ---`;
            }
          })
          .join("");
        return {
          content: [{ type: "text", text: searchText + fetchedSections }],
        };
      }

      const output = formatSummaryResult(summaryResult);
      return { content: [{ type: "text", text: output }] };
    },
  );

  server.tool(
    "vector_search",
    "Search previously fetched pages by semantic similarity. Uses hybrid BM25+vector search with reranking. Returns the most relevant chunks (not full pages), reducing token usage. Requires ENABLE_VECTOR_STORE=true and running TEI services.",
    {
      query: z.string().describe("Search query"),
      top_k: z.coerce
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Number of relevant chunks to return (default 5, max 20)"),
      domain: z
        .string()
        .optional()
        .describe("Filter results to a specific domain (e.g. github.com)"),
      since_days: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only return results fetched within this many days"),
    },
    async ({ query, top_k, domain, since_days }) => {
      if (!ENABLE_VECTOR_STORE) {
        return {
          content: [
            {
              type: "text",
              text: "Vector store disabled. Set ENABLE_VECTOR_STORE=true and restart.",
            },
          ],
        };
      }
      const queryVec = await embedQuery(query);
      const candidates = await hybridSearch(queryVec, query, top_k * 4, {
        domain,
        sinceDays: since_days,
      });
      if (candidates.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No matching chunks found. Fetch some pages first via search_and_fetch or fetch_url.",
            },
          ],
        };
      }

      // Rerank via TEI/Jina for final ordering (score order, not source order)
      const reranked = await rerankChunks(
        query,
        candidates.map((c, i) => ({
          text: (c.chunk_text as string) ?? "",
          sourceIndex: i,
          chunkIndex: (c.chunk_index as number) ?? 0,
        })),
        top_k,
        undefined,
        false,
      );

      const resultMap = new Map(candidates.map((c, i) => [i, c]));
      const output = reranked
        .map((chunk) => {
          const r = resultMap.get(chunk.sourceIndex);
          if (!r) return "";
          return `${chunk.sourceIndex + 1}. ${(r.title as string) ?? "Untitled"}\n   URL: ${(r.url as string) ?? ""}\n   ${chunk.text.slice(0, 500)}`;
        })
        .filter(Boolean)
        .join("\n\n");
      return { content: [{ type: "text", text: output }] };
    },
  );

  server.tool(
    "clear_cache",
    "Purge the search and/or fetch result cache. Useful when researching fast-moving topics where cached results from the past hour may be stale.",
    {
      target: z
        .enum(["search", "fetch", "all"])
        .default("all")
        .describe(
          "Which cache to clear: search results, fetched pages, or all (default all)",
        ),
    },
    async ({ target }) => {
      let cleared = 0;
      if (target === "search" || target === "all") {
        cleared += await cacheClear("search:*");
      }
      if (target === "fetch" || target === "all") {
        cleared += await cacheClear("fetch:*");
      }
      return {
        content: [
          {
            type: "text",
            text: `Cleared ${cleared} cache ${cleared === 1 ? "entry" : "entries"}.`,
          },
        ],
      };
    },
  );
}
