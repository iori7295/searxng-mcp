import { logger } from "./logger.js";

export const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://localhost:8081";
export const FIRECRAWL_URL =
  process.env.FIRECRAWL_URL ?? "http://localhost:3002";
export const FIRECRAWL_API_KEY =
  process.env.FIRECRAWL_API_KEY ?? "placeholder-local";
export const RERANKER_URL = process.env.RERANKER_URL ?? "http://localhost:8787";
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
export const CACHE_TTL_SECONDS = Math.max(
  parseInt(process.env.CACHE_TTL_SECONDS ?? "3600", 10) || 3600,
  0,
);
export const FETCH_CACHE_TTL_SECONDS = Math.max(
  parseInt(process.env.FETCH_CACHE_TTL_SECONDS ?? "86400", 10) || 86400,
  0,
);
export const LLM_BASE_URL =
  process.env.LLM_BASE_URL ?? process.env.OLLAMA_URL ?? "";
export const LLM_API_KEY =
  process.env.LLM_API_KEY ?? process.env.OLLAMA_API_KEY ?? "";
export const LLM_MODEL_EXPAND =
  process.env.LLM_MODEL_EXPAND ?? "deepseek-v4-flash";
export const LLM_MODEL_SUMMARY =
  process.env.LLM_MODEL_SUMMARY ?? "deepseek-v4-flash";
export const EXPAND_QUERIES_DEFAULT = process.env.EXPAND_QUERIES === "true";
export const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? null;
export const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN;
export const CHUNK_MAX_SIZE = Math.max(
  Number.parseInt(process.env.CHUNK_MAX_SIZE ?? "800", 10) || 800,
  200,
);
export const SEARCH_MIN_INTERVAL_MS = Math.max(
  Number.parseInt(process.env.SEARCH_MIN_INTERVAL_MS ?? "2000", 10) || 2000,
  0,
);
export const RERANK_RECENCY_WEIGHT = (() => {
  const v = parseFloat(process.env.RERANK_RECENCY_WEIGHT ?? "0.15");
  if (Number.isNaN(v) || v < 0) {
    return 0;
  }
  if (v > 1) {
    logger.warn(
      "RERANK_RECENCY_WEIGHT=%d exceeds 1.0; recency may dominate relevance scores.",
      v,
    );
  }
  return v;
})();

// Phase 2: Vector store / embedding
export const EMBEDDING_URL =
  process.env.EMBEDDING_URL ?? "http://localhost:8080";
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ?? "intfloat/multilingual-e5-small";
export const EMBEDDING_DIM = Math.max(
  parseInt(process.env.EMBEDDING_DIM ?? "384", 10) || 384,
  1,
);
export const LANCEDB_PATH = process.env.LANCEDB_PATH ?? "./data/lancedb";
export const ENABLE_VECTOR_STORE = process.env.ENABLE_VECTOR_STORE === "true";
export const TOP_CHUNKS_PER_PAGE = Math.max(
  parseInt(process.env.TOP_CHUNKS_PER_PAGE ?? "3", 10) || 3,
  1,
);
export const VECTOR_CHUNK_SIZE = Math.max(
  Number.parseInt(process.env.VECTOR_CHUNK_SIZE ?? "500", 10) || 500,
  100,
);
export const VECTOR_CHUNK_OVERLAP = Math.max(
  Number.parseInt(process.env.VECTOR_CHUNK_OVERLAP ?? "80", 10) || 80,
  0,
);

// Phase 3: Context budget
export const LLM_CONTEXT_BUDGET = Math.max(
  parseInt(process.env.LLM_CONTEXT_BUDGET ?? "4000", 10) || 4000,
  256,
);
export const USE_CHUNKS_DEFAULT = process.env.USE_CHUNKS_DEFAULT === "true";
