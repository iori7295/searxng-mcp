import { chunkPages, type TextChunk } from "./chunker.js";
import {
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_CONTEXT_BUDGET,
  LLM_MODEL_EXPAND,
  LLM_MODEL_SUMMARY,
} from "./config.js";
import { logger } from "./logger.js";
import { rerankChunks } from "./reranker.js";
import { countTokens, truncateToBudget } from "./tokenizer.js";
import type { Citation, OpenAIChatResponse, SummaryResult } from "./types.js";
import { SummarySchema } from "./types.js";

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({ model, messages, stream: false }),
    signal,
  });

  if (!res.ok) throw new Error(`LLM error: ${res.status}`);

  const data = (await res.json()) as OpenAIChatResponse;
  return data.choices[0]?.message?.content ?? "";
}

export async function expandQuery(query: string): Promise<string[]> {
  if (!LLM_BASE_URL) return [];
  const prompt =
    `Generate 2-3 search query variants for the query below. ` +
    `Output ONLY the variant queries, one per line. No numbering, no explanations, no extra text.\n\n` +
    `Original query: ${query}\n\n` +
    `Variant types:\n` +
    `- Technical rephrasing: use precise technical terms\n` +
    `- Product/specific: include product names or version numbers if applicable\n` +
    `- Community: how someone would phrase it in a forum or community\n\n` +
    `Output 2 or 3 variants only:`;

  try {
    const content = await chatCompletion(
      LLM_BASE_URL,
      LLM_API_KEY,
      LLM_MODEL_EXPAND,
      [{ role: "user", content: prompt }],
      AbortSignal.timeout(12000),
    );
    return content
      .split("\n")
      .map((line) => line.trim())
      .map((line) =>
        line.replace(/^\d+[.)]\s*/, "").replace(/^["']|["']$/g, ""),
      )
      .filter((line) => line.length > 0 && line !== query)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Extract first valid JSON object from LLM response text.
 *  Scans for balanced braces with string literal awareness:
 *  braces inside "..." are ignored so e.g. {"k": "} "} parses correctly. */
function extractJson(content: string): Record<string, unknown> | null {
  let start = 0;
  for (;;) {
    start = content.indexOf("{", start);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    for (let i = start; i < content.length; i++) {
      const c = content[i];
      if (c === '"' && (i === start || content[i - 1] !== "\\")) {
        inString = !inString;
      }
      if (inString) continue;
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(content.slice(start, i + 1));
          if (typeof parsed === "object" && parsed !== null) return parsed;
        } catch {
          // Not valid JSON — continue to next {
        }
        break;
      }
    }
    start++;
  }
}

export async function summarizePages(
  query: string,
  pages: Array<{ title: string; url: string; text: string }>,
): Promise<SummaryResult> {
  if (!LLM_BASE_URL) return { summary: "", citations: [] };
  if (pages.length === 0) {
    return { summary: "No content to summarize.", citations: [] };
  }

  // Chunk pages → rerank → top chunks only (avoids lost-in-the-middle)
  const chunks = await chunkPages(pages);
  let selectedChunks: TextChunk[];
  try {
    selectedChunks = await rerankChunks(query, chunks, 5, pages);
  } catch {
    selectedChunks = pages.map((p, i) => ({
      text: p.text.slice(0, 1000),
      sourceIndex: i,
      chunkIndex: 0,
    }));
  }

  const pageBlocks = selectedChunks
    .filter((c) => c.text.trim().length > 0)
    .map((c) => {
      const page = pages[c.sourceIndex];
      return `[Source: ${page.title}]\nURL: ${page.url}\n\n${c.text}`;
    })
    .join("\n\n---\n\n");
  // Phase 3: Enforce LLM context budget (token-aware truncation)
  const budgetTokens = LLM_CONTEXT_BUDGET - countTokens(query) - 500;
  const trimmed =
    budgetTokens > 0
      ? truncateToBudget(pageBlocks, budgetTokens)
      : pageBlocks.slice(0, 16000);

  try {
    const content = await chatCompletion(
      LLM_BASE_URL,
      LLM_API_KEY,
      LLM_MODEL_SUMMARY,
      [
        {
          role: "system",
          content:
            "You are a research assistant. Synthesize the provided sources to answer the query. " +
            "Respond with JSON only, no markdown fences, matching this exact schema: " +
            '{"summary":"<synthesized answer>","citations":[{"url":"<url>","title":"<title>","key_facts":["<fact>"]}]} ' +
            "Include only sources that contributed to the answer. key_facts: 1-3 short phrases per source.",
        },
        {
          role: "user",
          content: `Query: ${query}\n\nSources:\n${trimmed}`,
        },
      ],
      AbortSignal.timeout(45000),
    );

    const raw = extractJson(content);
    if (!raw) {
      logger.warn(
        "No JSON found in LLM summary response: %s",
        content.slice(0, 100),
      );
      return { summary: "", citations: [] };
    }
    const parsed = SummarySchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("Summary schema validation failed: %s", parsed.error.message);
      return { summary: "", citations: [] };
    }
    return parsed.data;
  } catch {
    return { summary: "", citations: [] };
  }
}

export function formatSummaryResult(result: SummaryResult): string {
  if (!result.summary) return "";
  const citationText = result.citations
    .map((c: Citation) => {
      const facts = c.key_facts.map((f) => `     - ${f}`).join("\n");
      return `  - ${c.title}\n    URL: ${c.url}\n${facts}`;
    })
    .join("\n\n");
  return `## Summary\n\n${result.summary}\n\n## Sources\n\n${citationText}`;
}
