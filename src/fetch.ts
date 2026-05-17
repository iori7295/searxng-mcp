import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { Defuddle } from "defuddle/node";
import ipaddr from "ipaddr.js";
import { parseHTML } from "linkedom";
import { cacheDel, cacheGet, cacheSet, fetchCacheKey } from "./cache.js";
import { chunkPages } from "./chunker.js";
import { isCircuitOpen, recordFailure, recordSuccess } from "./circuit.js";
import {
  CRAWL4AI_API_TOKEN,
  CRAWL4AI_URL,
  ENABLE_VECTOR_STORE,
  FETCH_CACHE_TTL_SECONDS,
  FIRECRAWL_API_KEY,
  FIRECRAWL_URL,
  GITHUB_TOKEN,
  VECTOR_CHUNK_OVERLAP,
  VECTOR_CHUNK_SIZE,
} from "./config.js";
import { getBlockList, urlMatchesDomain } from "./domains.js";
import { embedPassages } from "./embedder.js";
import { logger } from "./logger.js";
import type {
  FirecrawlScrapeResponse,
  GitHubCommentResponse,
  GitHubIssueResponse,
  GitHubReadmeResponse,
} from "./types.js";
import { upsertChunks } from "./vectorstore.js";

const FETCH_BUFFER = 50_000;
const PDF_BINARY_LIMIT = 5_000_000; // 5MB max for PDF binary download

// Read response body as text, stopping at `limit` bytes to avoid buffering huge payloads
async function readBodyText(res: Response, limit: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let len = 0;
  try {
    while (len < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const s = decoder.decode(value, { stream: true });
        parts.push(s);
        len += s.length;
      }
    }
  } finally {
    reader.cancel();
  }
  return parts.join("").slice(0, limit);
}

// Read response body as binary Buffer, stopping at `limit` bytes
async function readBodyBuffer(res: Response, limit: number): Promise<Buffer> {
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let len = 0;
  try {
    while (len < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        len += value.length;
      }
    }
  } finally {
    reader.cancel();
  }
  return Buffer.concat(chunks);
}

async function resolveAndCheckIp(raw: string): Promise<void> {
  const addr = ipaddr.parse(raw);
  // Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1 → check embedded IPv4)
  const check =
    addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()
      ? (addr as ipaddr.IPv6).toIPv4Address()
      : addr;
  const ranges = [
    "loopback",
    "private",
    "linkLocal",
    "uniqueLocal",
    "unspecified",
  ] as const;
  for (const range of ranges) {
    if (check.range() === range) {
      throw new Error(`Internal/private addresses are not allowed`);
    }
  }
}

export async function assertPublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Only http/https URLs are supported`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  // Check known internal hostname patterns first (fast path)
  const blockedHosts = [/^localhost$/i, /^host\.docker\.internal$/i];
  if (blockedHosts.some((r) => r.test(hostname))) {
    throw new Error(`Internal/private addresses are not allowed`);
  }

  // Try parsing as IP — ipaddr handles all representations:
  // decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1),
  // IPv4-mapped IPv6 (::ffff:127.0.0.1), etc.
  let parsedOk = false;
  try {
    ipaddr.parse(hostname);
    parsedOk = true;
  } catch {
    // Not a parseable IP
  }
  if (parsedOk) {
    await resolveAndCheckIp(hostname);
    return;
  }

  // Resolve hostname to check for DNS rebinding
  try {
    const addresses = await dnsLookup(hostname, { all: true });
    for (const { address } of addresses) {
      await resolveAndCheckIp(address);
    }
  } catch {
    // DNS resolution failure — let fetch() decide
  }
}

async function githubFetch(
  url: string,
): Promise<{ title: string; url: string; text: string }> {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  // parts: [owner, repo] or [owner, repo, "blob"|"tree", branch, ...path]
  //           or [owner, repo, "issues"|"pull", N, ...]

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "searxng-mcp",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  if (parts.length >= 4 && parts[2] === "blob") {
    const [owner, repo, , ...rest] = parts;
    // Try to find the branch/file split via git/refs API
    let branch = rest[0];
    let filePath = rest.slice(1);
    if (rest.length > 1) {
      try {
        const refRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${rest.join("/")}`,
          { headers, signal: AbortSignal.timeout(5000) },
        );
        if (refRes.ok) {
          branch = rest.join("/");
          filePath = [];
        }
      } catch {
        // refs API failed — use simple split (branch=rest[0], path=rest[1..])
      }
    }
    try {
      const path = filePath.length ? filePath.join("/") : "";
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
      const res = await fetch(apiUrl, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const content = data.content as string | undefined;
      const encoding = data.encoding as string | undefined;
      if (content && encoding === "base64") {
        const text = Buffer.from(content, "base64")
          .toString("utf-8")
          .slice(0, FETCH_BUFFER);
        const fileName = (data.name as string) ?? url;
        return { title: fileName, url, text };
      }
    } catch {
      // Fallback to raw.githubusercontent.com
    }
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.join("/")}`;
    const rawHeaders: Record<string, string> = { "User-Agent": "searxng-mcp" };
    if (GITHUB_TOKEN) rawHeaders.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(rawUrl, {
      headers: rawHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok)
      throw new Error(
        `GitHub raw fetch error: ${res.status} ${res.statusText}`,
      );
    const text = (await res.text()).slice(0, FETCH_BUFFER);
    const fileName = filePath[filePath.length - 1] ?? url;
    return { title: fileName, url: rawUrl, text };
  }

  // GitHub Issues / Pull Requests — fetch body + comments + reactions via API
  if (parts.length >= 4 && (parts[2] === "issues" || parts[2] === "pull")) {
    const [owner, repo, , issueNumber] = parts;
    const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

    const reactionHeaders = {
      ...headers,
      Accept: "application/vnd.github.squirrel-girl-preview+json",
    };

    const issueRes = await fetch(`${apiBase}/issues/${issueNumber}`, {
      headers: reactionHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!issueRes.ok) throw new Error(`GitHub API error: ${issueRes.status}`);
    const issue = (await issueRes.json()) as GitHubIssueResponse;

    const formatReactions = (r?: GitHubIssueResponse["reactions"]): string => {
      if (!r) return "";
      const parts: string[] = [];
      if (r["+1"]) parts.push(`👍 ${r["+1"]}`);
      if (r["-1"]) parts.push(`👎 ${r["-1"]}`);
      if (r.laugh) parts.push(`😄 ${r.laugh}`);
      if (r.hooray) parts.push(`🎉 ${r.hooray}`);
      if (r.confused) parts.push(`😕 ${r.confused}`);
      if (r.heart) parts.push(`❤️ ${r.heart}`);
      if (r.rocket) parts.push(`🚀 ${r.rocket}`);
      if (r.eyes) parts.push(`👀 ${r.eyes}`);
      return parts.length ? `  Reactions: ${parts.join(" · ")}` : "";
    };

    // Build structured text
    const lines: string[] = [
      `# ${issue.title}`,
      `State: **${issue.state}** — by @${issue.user.login} on ${new Date(issue.created_at).toISOString().split("T")[0]}`,
      issue.reactions ? formatReactions(issue.reactions) : "",
      "",
      issue.body ?? "(no description)",
    ];

    // Fetch comments (PRs share the /issues/ endpoint for conversation comments)
    const label = "issues";
    const commentsRes = await fetch(
      `${apiBase}/${label}/${issueNumber}/comments`,
      { headers: reactionHeaders, signal: AbortSignal.timeout(10000) },
    );
    if (commentsRes.ok) {
      const comments = (await commentsRes.json()) as GitHubCommentResponse[];
      if (comments.length > 0) {
        lines.push("", `---\n## Comments (${comments.length})`);
        for (const c of comments) {
          const date = new Date(c.created_at).toISOString().split("T")[0];
          lines.push(
            "",
            `**@${c.user.login}** — ${date}`,
            c.reactions ? formatReactions(c.reactions) : "",
            c.body,
          );
        }
      }
    } else {
      logger.warn(`GitHub comments fetch failed: ${commentsRes.status}`);
    }

    const text = lines.join("\n").slice(0, FETCH_BUFFER);
    return {
      title: `${owner}/${repo}#${issueNumber} — ${issue.title}`,
      url: issue.html_url,
      text,
    };
  }

  // Repo root or tree — fetch README via GitHub API
  const [owner, repo] = parts;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok)
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as GitHubReadmeResponse;
  const text = Buffer.from(data.content, "base64")
    .toString("utf-8")
    .slice(0, FETCH_BUFFER);
  return { title: `${owner}/${repo} — ${data.name}`, url: data.html_url, text };
}

async function firecrawlScrape(
  url: string,
): Promise<{ title: string; url: string; text: string }> {
  const res = await fetch(`${FIRECRAWL_URL}/v1/scrape`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Firecrawl error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as FirecrawlScrapeResponse;

  if (!data.success || !data.data) {
    throw new Error(data.error ?? "Firecrawl returned no data");
  }

  const title = data.data.metadata?.title ?? url;
  const text = (data.data.markdown ?? "").slice(0, FETCH_BUFFER);

  return { title, url: data.data.metadata?.sourceURL ?? url, text };
}

async function pollCrawl4aiTask(
  taskId: string,
  url: string,
  signal: AbortSignal,
  depth = 1,
): Promise<{ title: string; url: string; text: string } | null> {
  const deadline = Date.now() + Math.min(40_000 * depth, 120_000);

  // Small initial delay (500ms) then poll every 2s (depth=1) or 5s (depth>=2)
  const pollInterval = depth >= 2 ? 5000 : 2000;
  let polled = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, polled ? pollInterval : 500));
    polled = true;
    if (signal.aborted) return null;

    try {
      const resp = await fetch(`${CRAWL4AI_URL}/task/${taskId}`, { signal });
      if (!resp.ok) return null;

      const data = (await resp.json()) as Record<string, unknown>;
      if (data.status === "completed") {
        const result = data.result as Record<string, unknown> | null;
        const md = result?.markdown as Record<string, string> | null;
        const text = (md?.raw_markdown ?? "").slice(0, FETCH_BUFFER);
        return text ? { title: url, url, text } : null;
      }
      if (data.status === "failed") return null;
    } catch {
      return null;
    }
  }

  return null;
}

async function crawl4aiFetch(
  url: string,
  depth = 1,
): Promise<{ title: string; url: string; text: string } | null> {
  if (!CRAWL4AI_URL) return null;

  const controller = new AbortController();
  const timeoutMs = Math.min(45_000 * depth, 120_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const crawlHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (CRAWL4AI_API_TOKEN)
      crawlHeaders.Authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
    const resp = await fetch(`${CRAWL4AI_URL}/crawl`, {
      method: "POST",
      headers: crawlHeaders,
      body: JSON.stringify({ urls: [url], depth }),
      signal: controller.signal,
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;

    // Synchronous response — results returned directly
    if (Array.isArray(data.results) && data.results.length > 0) {
      const result = data.results[0] as Record<string, unknown>;
      const md = result.markdown as Record<string, string> | null;
      const text = (md?.raw_markdown ?? "").slice(0, FETCH_BUFFER);
      if (!text) return null;
      return { title: url, url, text };
    }

    // Asynchronous response — poll for completion
    if (typeof data.task_id === "string") {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(data.task_id)) return null;
      return await pollCrawl4aiTask(
        data.task_id,
        url,
        controller.signal,
        depth,
      );
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36";

async function rawFetch(
  url: string,
  redirectDepth = 0,
): Promise<{ title: string; url: string; text: string }> {
  const MAX_REDIRECTS = 5;
  if (redirectDepth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects`);
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent": CHROME_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`Redirect with no Location: ${res.status}`);
    const target = new URL(location, url).href;
    await assertPublicUrl(target);
    return rawFetch(target, redirectDepth + 1);
  }
  if (!res.ok)
    throw new Error(`Raw fetch error: ${res.status} ${res.statusText}`);

  // PDF → extract text via pdf-parse
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf")) {
    const buf = await readBodyBuffer(res, PDF_BINARY_LIMIT);
    if (buf.length >= PDF_BINARY_LIMIT) {
      return {
        title: url,
        url,
        text: "[PDF content too large — download the file directly to view]",
      };
    }
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    const text = result.text.slice(0, FETCH_BUFFER);
    return text
      ? { title: url, url, text }
      : { title: url, url, text: "[PDF content could not be extracted]" };
  }

  let text = await readBodyText(res, FETCH_BUFFER);
  // Extract <title> before processing
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : url;

  // Tier 3a: Defuddle-based article extraction (markdown output)
  try {
    const { document } = parseHTML(text);
    const result = await Defuddle(document, url, { markdown: true });
    const content = result?.contentMarkdown ?? result?.content ?? "";
    if (content.length > 100) {
      title = result.title || title;
      text = content.trim().slice(0, FETCH_BUFFER);
      return { title, url, text };
    }
  } catch {
    // Defuddle unavailable or failed — fall through to regex strip
  }

  // Tier 3b: Readability-based article extraction (plain text fallback)
  try {
    const { document } = parseHTML(text);
    const article = new Readability(document).parse();
    if (article?.textContent && article.textContent.length > 100) {
      return {
        title: article.title || title,
        url,
        text: article.textContent.trim().slice(0, FETCH_BUFFER),
      };
    }
  } catch {
    // Readability unavailable or failed — use raw text
  }

  // Tier 3c: Raw text (both Defuddle and Readability failed)
  return { title, url, text };
}

export async function fetchPage(
  url: string,
  maxChars = 8000,
  domainProfile?: string,
  startIndex = 0,
  depth = 1,
): Promise<{
  title: string;
  url: string;
  text: string;
  totalLength: number;
}> {
  await assertPublicUrl(url);

  // Refuse to fetch blocked domains
  const blockList = getBlockList(domainProfile);
  if (blockList.some((pat) => urlMatchesDomain(url, pat))) {
    throw new Error(`Domain is blocked by domain filter configuration`);
  }

  // Check fetch cache
  const key = fetchCacheKey(url) + (depth > 1 ? `:d${depth}` : "");
  const cached = await cacheGet(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as {
        title: string;
        url: string;
        text: string;
      };
      return {
        title: parsed.title,
        url: parsed.url,
        text: parsed.text.slice(startIndex, startIndex + maxChars),
        totalLength: parsed.text.length,
      };
    } catch {
      logger.warn("Corrupted fetch cache entry, removing");
      cacheDel(key);
    }
  }

  const { hostname } = new URL(url);

  let result: { title: string; url: string; text: string };
  if (hostname === "github.com") {
    result = await githubFetch(url);
  } else {
    // Tier 1: Firecrawl (with circuit breaker)
    let fetched: { title: string; url: string; text: string } | null = null;
    if (!isCircuitOpen("firecrawl")) {
      try {
        fetched = await firecrawlScrape(url);
        if (!fetched?.text) fetched = null; // treat empty content as failure (bot-block, challenge pages)
        if (fetched) recordSuccess("firecrawl");
      } catch {
        recordFailure("firecrawl");
        fetched = null;
      }
    }

    // Tier 2: Crawl4AI (with circuit breaker, skipped if CRAWL4AI_URL not set)
    if (!fetched && !isCircuitOpen("crawl4ai")) {
      try {
        fetched = await crawl4aiFetch(url, depth);
        if (fetched) recordSuccess("crawl4ai");
      } catch {
        recordFailure("crawl4ai");
        fetched = null;
      }
    }

    // Tier 3: Raw HTTP fetch
    result = fetched ?? (await rawFetch(url));
  }

  await cacheSet(key, JSON.stringify(result), FETCH_CACHE_TTL_SECONDS);

  // Phase 2: Auto-index to LanceDB (fire-and-forget)
  if (ENABLE_VECTOR_STORE && result.text.length > 100) {
    indexToVectorStore(result, url).catch((e) => {
      logger.warn(
        "Auto-index to vector store failed: %s",
        (e as Error).message,
      );
    });
  }

  return {
    ...result,
    text: result.text.slice(startIndex, startIndex + maxChars),
    totalLength: result.text.length,
  };
}

async function indexToVectorStore(
  result: { title: string; url: string; text: string },
  originalUrl: string,
): Promise<void> {
  const chunks = await chunkPages(
    [result],
    VECTOR_CHUNK_SIZE,
    VECTOR_CHUNK_OVERLAP,
  );
  const texts = chunks.map((c) => c.text);
  const vectors = await embedPassages(texts);
  const urlHash = createHash("sha256").update(originalUrl).digest("hex");
  const records = chunks.map((c, i) => ({
    id: `${originalUrl}#${c.chunkIndex}`,
    url: originalUrl,
    url_hash: urlHash,
    title: result.title,
    chunk_text: c.text,
    chunk_index: c.chunkIndex,
    embedding: vectors[i],
    fetched_at: Date.now(),
    domain: new URL(originalUrl).hostname,
    token_count: 0,
  }));
  await upsertChunks(records);
}
