import { createHash } from "node:crypto";
import { Redis as Valkey } from "iovalkey";
import { VALKEY_URL } from "./config.js";
import { logger } from "./logger.js";

let valkey: Valkey | null = null;
let connecting: Promise<void> | null = null;

export async function getValkey(): Promise<Valkey | null> {
  if (valkey !== null) return valkey;
  if (connecting) {
    await connecting;
    return valkey;
  }
  connecting = (async () => {
    const client = new Valkey(VALKEY_URL, {
      lazyConnect: true,
      enableReadyCheck: false,
    });
    client.on("error", () => {
      // Silently disconnect on error — caching is best-effort
      try {
        client.disconnect();
      } catch {
        // Best-effort cleanup
      }
      valkey = null;
    });
    await client.connect();
    valkey = client;
    logger.info(`Cache connected to ${VALKEY_URL}`);
  })();
  try {
    await connecting;
  } catch {
    logger.warn("Cache unavailable — running without cache");
  } finally {
    connecting = null;
  }
  return valkey;
}

export function searchCacheKey(
  query: string,
  category: string,
  timeRange?: string,
  fetchCount?: number,
): string {
  const raw = `${query}|${category}|${timeRange ?? ""}|${fetchCount ?? 0}`;
  return `search:${createHash("sha256").update(raw).digest("hex")}`;
}

export function fetchCacheKey(url: string): string {
  return `fetch:${createHash("sha256").update(url).digest("hex")}`;
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const client = await getValkey();
    if (!client) return null;
    return await client.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: string,
  ttl: number,
): Promise<void> {
  try {
    const client = await getValkey();
    if (!client) return;
    await client.set(key, value, "EX", ttl);
  } catch {
    // Best-effort — never throw
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    const client = await getValkey();
    if (!client) return;
    await client.unlink(key);
  } catch {
    // Best-effort — never throw
  }
}

export async function cacheClear(pattern: string): Promise<number> {
  try {
    const client = await getValkey();
    if (!client) return 0;
    let cursor = "0";
    const keys: string[] = [];
    do {
      const result = (await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      )) as [string, string[]];
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== "0");
    if (keys.length === 0) return 0;
    // Batch UNLINK 100 keys at a time to avoid blocking Valkey
    for (let i = 0; i < keys.length; i += 100) {
      await client.unlink(keys.slice(i, i + 100));
    }
    return keys.length;
  } catch {
    return 0;
  }
}
