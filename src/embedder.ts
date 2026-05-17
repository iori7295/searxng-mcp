import { EMBEDDING_MODEL, EMBEDDING_URL } from "./config.js";
import { isCircuitOpen, recordFailure, recordSuccess } from "./fetch.js";

const E5_QUERY_PREFIX = "query: ";
const E5_PASSAGE_PREFIX = "passage: ";

export interface EmbeddingResult {
  vector: number[];
  text: string;
}

async function embed(
  inputs: string[],
  prefix: string,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (isCircuitOpen("tei-embed")) throw new Error("Circuit open for tei-embed");
  const url = `${EMBEDDING_URL}/embed`;
  let res: Response | undefined;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: inputs.map((t) => prefix + t),
        model: EMBEDDING_MODEL,
      }),
      signal: signal ?? AbortSignal.timeout(10000),
    });
  } catch (e) {
    recordFailure("tei-embed");
    throw e;
  }
  if (!res.ok) {
    recordFailure("tei-embed");
    throw new Error(`Embedding error: ${res.status}`);
  }
  recordSuccess("tei-embed");
  const data = (await res.json()) as number[][] | { embeddings?: number[][] };
  if (Array.isArray(data)) return data;
  if (data.embeddings) return data.embeddings;
  throw new Error("Unexpected embedding response format");
}

export async function embedQuery(query: string): Promise<number[]> {
  const vecs = await embed([query], E5_QUERY_PREFIX);
  return vecs[0];
}

export async function embedPassages(
  texts: string[],
  batchSize = 32,
): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vecs = await embed(batch, E5_PASSAGE_PREFIX);
    results.push(...vecs);
  }
  return results;
}
