import type { Table } from "@lancedb/lancedb";
import * as lancedb from "@lancedb/lancedb";
import { EMBEDDING_DIM, ENABLE_VECTOR_STORE, LANCEDB_PATH } from "./config.js";
import { logger } from "./logger.js";

interface ChunkRecord extends Record<string, unknown> {
  id: string;
  url: string;
  url_hash: string;
  title: string;
  chunk_text: string;
  chunk_index: number;
  embedding: number[];
  fetched_at: number;
  domain: string;
  token_count: number;
}

let db: lancedb.Connection | null = null;
let table: Table | null = null;

export async function getVectorStore(): Promise<Table | null> {
  if (!ENABLE_VECTOR_STORE) return null;
  if (table) return table;
  try {
    db = await lancedb.connect(LANCEDB_PATH);
    const names = await db.tableNames();
    if (names.includes("chunks")) {
      table = await db.openTable("chunks");
      return table;
    }
  } catch {
    // Connection failed
  }
  try {
    const initRecord: ChunkRecord = {
      id: "init",
      url: "",
      url_hash: "",
      title: "",
      chunk_text: "",
      chunk_index: 0,
      embedding: new Array(EMBEDDING_DIM).fill(0),
      fetched_at: 0,
      domain: "",
      token_count: 0,
    };
    if (!db) return null;
    table = await db.createTable("chunks", [initRecord]);
    await table.delete('id = "init"');
    // Create FTS index for hybrid search
    try {
      // biome-ignore lint/suspicious/noExplicitAny: fts() not typed on Index export
      const ftsIdx = (lancedb.Index as any).fts();
      await table.createIndex("chunk_text", { config: ftsIdx });
    } catch {
      // FTS index may already exist
    }
    logger.info(`Vector store created at ${LANCEDB_PATH}`);
    return table;
  } catch (e) {
    logger.warn("Failed to create vector store: %s", (e as Error).message);
    return null;
  }
}

export async function upsertChunks(chunks: ChunkRecord[]): Promise<void> {
  const tbl = await getVectorStore();
  if (!tbl || chunks.length === 0) return;
  try {
    const urlHashes = [...new Set(chunks.map((c) => c.url_hash))];
    for (const h of urlHashes) {
      await tbl.delete(`url_hash = '${h}'`);
    }
    await tbl.add(chunks);
  } catch (e) {
    logger.warn("Vector store upsert failed: %s", (e as Error).message);
  }
}

export async function hybridSearch(
  queryEmbedding: number[],
  queryText: string,
  topK = 10,
  filters?: { domain?: string; sinceDays?: number },
): Promise<Record<string, unknown>[]> {
  const tbl = await getVectorStore();
  if (!tbl) return [];
  try {
    // biome-ignore lint/suspicious/noExplicitAny: RRFReranker untyped in TS
    const Reranker = (lancedb as any).rerankers.RRFReranker as new () => any;
    let q = tbl
      .vectorSearch(queryEmbedding)
      .fullTextSearch(queryText, { columns: ["chunk_text", "title"] })
      .limit(topK * 4)
      .rerank(new Reranker());

    // Metadata filters
    if (filters?.domain) {
      // Strict validation: only allow valid hostname characters
      // to prevent SQL injection via the WHERE clause
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(filters.domain)) {
        logger.warn(
          "Invalid domain filter, returning empty: %s",
          filters.domain,
        );
        return [];
      }
      q = q.where(`domain = '${filters.domain.replace(/'/g, "''")}'`);
    }
    if (filters?.sinceDays) {
      const cutoff = Date.now() - filters.sinceDays * 86_400_000;
      q = q.where(`fetched_at > ${cutoff}`);
    }

    const results = await q.toArray();
    return results.slice(0, topK) as Record<string, unknown>[];
  } catch (e) {
    logger.warn("Hybrid search failed: %s", (e as Error).message);
    return [];
  }
}
