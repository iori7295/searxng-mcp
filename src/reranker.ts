import type { TextChunk } from "./chunker.js";
import { RERANK_RECENCY_WEIGHT, RERANKER_URL } from "./config.js";
import type { RerankResponse, SearxResult } from "./types.js";

/** Exponential decay recency score. Returns 0 for missing/unparseable dates. */
export function recencyScore(date?: string): number {
  if (!date) return 0;
  const ms = Date.parse(date);
  if (Number.isNaN(ms)) return 0;
  const ageDays = (Date.now() - ms) / 86_400_000;
  if (ageDays < 0) return 0; // future dates treated as neutral
  return Math.exp(-ageDays / 90);
}

interface ScoredItem {
  index: number;
  score: number;
}

async function callJinaRerank(
  query: string,
  documents: string[],
): Promise<ScoredItem[]> {
  const res = await fetch(`${RERANKER_URL}/v1/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, documents, top_n: documents.length }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Jina reranker error: ${res.status}`);
  const data = (await res.json()) as RerankResponse;
  return data.results.map((r) => ({
    index: r.index,
    score: r.relevance_score,
  }));
}

async function callTeiRerank(
  query: string,
  documents: string[],
): Promise<ScoredItem[]> {
  const res = await fetch(`${RERANKER_URL}/rerank`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, texts: documents }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`TEI reranker error: ${res.status}`);
  const data = (await res.json()) as Array<{ index: number; score?: number }>;
  return data.map((r) => ({ index: r.index, score: r.score ?? 0 }));
}

async function callReranker(
  query: string,
  documents: string[],
): Promise<ScoredItem[]> {
  try {
    return await callJinaRerank(query, documents);
  } catch {
    // Jina not available — try TEI
  }
  return await callTeiRerank(query, documents);
}

async function rerank(
  query: string,
  results: SearxResult[],
  topN: number,
  applyRecency: boolean,
): Promise<SearxResult[]> {
  if (results.length === 0) return results;

  const documents = results.map((r) => `${r.title}. ${r.content ?? ""}`.trim());

  const scoredItems = await callReranker(query, documents);

  const scored = scoredItems
    .filter((r) => r.index >= 0 && r.index < results.length)
    .map((r) => {
      const result = results[r.index];
      const combined =
        applyRecency && RERANK_RECENCY_WEIGHT > 0
          ? r.score + RERANK_RECENCY_WEIGHT * recencyScore(result.publishedDate)
          : r.score;
      return { result, score: combined };
    });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.result);
}

export async function rerankWithFallback(
  query: string,
  results: SearxResult[],
  topN: number,
  timeRange?: string,
): Promise<SearxResult[]> {
  const applyRecency = !timeRange; // skip when caller already filtered by date
  try {
    return await rerank(query, results, topN, applyRecency);
  } catch {
    // Reranker unavailable — fall back to SearXNG order
    return results.slice(0, topN);
  }
}

function roundRobinFallback(chunks: TextChunk[], topN: number): TextChunk[] {
  const groups: TextChunk[][] = [];
  for (const c of chunks) {
    if (!groups[c.sourceIndex]) groups[c.sourceIndex] = [];
    groups[c.sourceIndex].push(c);
  }
  const pageCount = groups.length;
  const maxChunks = Math.max(...groups.map((g) => g.length));
  const result: TextChunk[] = [];
  for (let i = 0; result.length < topN && i < pageCount * maxChunks; i++) {
    const pageIdx = i % pageCount;
    const chunkIdx = Math.floor(i / pageCount);
    const pageChunks = groups[pageIdx];
    if (pageChunks && chunkIdx < pageChunks.length) {
      result.push(pageChunks[chunkIdx]);
    }
  }
  return result;
}

export async function rerankChunks(
  query: string,
  chunks: TextChunk[],
  topN = 5,
  pages?: Array<{ title: string; url: string; text: string }>,
  preserveOrder = true,
): Promise<TextChunk[]> {
  if (chunks.length === 0) return [];
  const documents = chunks.map((c) => {
    const prefix = pages
      ? `[Title: ${pages[c.sourceIndex]?.title ?? "Untitled"}]\n`
      : "";
    return prefix + c.text;
  });

  try {
    const scoredItems = await callReranker(query, documents);
    if (scoredItems.length === 0) return roundRobinFallback(chunks, topN);
    const result = scoredItems
      .filter((r) => r.index >= 0 && r.index < chunks.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    if (preserveOrder) {
      result.sort((a, b) => a.index - b.index);
    }
    return result.map((r) => chunks[r.index]);
  } catch {
    return roundRobinFallback(chunks, topN);
  }
}
