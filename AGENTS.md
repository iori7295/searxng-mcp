# AGENTS.md — searxng-mcp

MCP server for private web search via a self-hosted SearXNG instance. Reranks results with a local ML model, fetches full-page content via a three-tier cascade (Firecrawl → Crawl4AI → raw HTTP with PDF support), GitHub Issues/PRs via the GitHub API (body + comments + reactions), and optionally expands queries and synthesizes summaries via an OpenAI-compatible LLM.

## What it does

Exposes six MCP tools:

- **`search`** — queries SearXNG, reranks results with a local ML model, returns top N structured results with optional infoboxes/answers/suggestions
- **`search_and_fetch`** — same as `search` but also fetches full content of the top result(s) via the fetch cascade
- **`search_and_summarize`** — search, fetch, then synthesize a summary with citations via an OpenAI-compatible LLM
- **`fetch_url`** — fetch and extract readable markdown from any public URL; GitHub URLs use the GitHub API (Issues/PRs include body + comments + reactions); PDF URLs are parsed via `pdf-parse`
- **`vector_search`** — search previously fetched pages by semantic similarity (hybrid BM25+vector); requires `ENABLE_VECTOR_STORE=true`
- **`clear_cache`** — purge the Valkey result cache (search, fetch, or both)

## Structure

```
src/
  index.ts        # Entry point — creates MCP server, registers tools
  tools.ts        # Tool definitions (schemas + handlers)
  search.ts       # SearXNG client
  fetch.ts        # Fetch cascade (Firecrawl → Crawl4AI → raw HTTP with PDF) + GitHub API (Issues/PRs structured)
  reranker.ts     # Jina-compatible reranker client + recency weighting + MMR diversity
  llm.ts          # OpenAI-compatible LLM client (query expansion + summarization)
  cache.ts        # Valkey/Redis caching layer
  domains.ts      # Domain boost/block filtering + profiles
  config.ts       # Environment variable configuration
  types.ts        # Shared type definitions
  logger.ts       # Pino stderr logger
  circuit.ts      # Circuit breaker (shared across firecrawl, crawl4ai, tei-embed)
  embedder.ts     # TEI embedding client (query + passage embedding)
  vectorstore.ts  # LanceDB hybrid search (BM25+vector+RRF)
  chunker.ts      # @langchain/textsplitters with Japanese-friendly separators
  tokenizer.ts    # js-tiktoken token counter (lazy-initialized cl100k_base)
tests/
  *.test.ts       # Vitest unit tests (78 tests across 7 files)
```

## Dependencies

Required services:

| Service | Env var | Purpose |
|---|---|---|
| SearXNG | `SEARXNG_URL` | Meta-search engine |
| Firecrawl | `FIRECRAWL_URL` | JS-aware page scraping (tier 1) |

Optional services (server degrades gracefully without these):

| Service | Env var | Purpose |
|---|---|---|
| Reranker | `RERANKER_URL` | ML relevance reranking |
| Crawl4AI | `CRAWL4AI_URL` | Fetch fallback for bot-blocked pages (tier 2) |
| Valkey/Redis | `VALKEY_URL` | Result caching |
| LLM (OpenAI-compatible) | `LLM_BASE_URL` | Query expansion + summarization |
| TEI Embedding | `EMBEDDING_URL` | Vector embeddings for `vector_search` + auto-indexing |
| LanceDB | `LANCEDB_PATH` | Hybrid vector store (BM25+vector) |

## Build and run

```bash
# Option 1: npx (no install)
npx @iori7295/searxng-mcp

# Option 2: npm global install
npm install -g @iori7295/searxng-mcp
searxng-mcp

# Option 3: from source
git clone https://github.com/iori7295/searxng-mcp.git
cd searxng-mcp
docker compose up -d        # SearXNG (required)
pnpm install
pnpm build                  # tsc → build/
node build/src/index.js
```

Transport: stdio (MCP standard).

## Testing

```bash
pnpm test         # vitest run --typecheck
```

## URL safety

`fetch_url` and `search_and_fetch` block requests to private/internal IP ranges (localhost, RFC1918, link-local, IPv6 private). Redirects to internal addresses are also blocked. Do not remove these checks — they prevent SSRF against internal services.

## Git workflow

Branch before editing — do not commit directly to `main`.
