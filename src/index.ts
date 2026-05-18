#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Agent, setGlobalDispatcher } from "undici";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));
import { ENABLE_VECTOR_STORE } from "./config.js";
import { logger } from "./logger.js";
import { registerTools } from "./tools.js";

// Global HTTP keep-alive: reduces TCP/TLS handshake overhead for repeated calls
// to SearXNG, Firecrawl, TEI, LLM, etc.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 32,
    pipelining: 1,
  }),
);

// Phase 2: Health checks (fire-and-forget — don't block startup)
if (ENABLE_VECTOR_STORE) {
  import("./vectorstore.js")
    .then(({ getVectorStore }) =>
      getVectorStore().then(
        (store) => {
          if (store) logger.info("Vector store ready");
          else logger.warn("Vector store unavailable — running without it");
        },
        (e) =>
          logger.warn("Vector store init failed: %s", (e as Error).message),
      ),
    )
    .catch((e) =>
      logger.warn("Vector store module load failed: %s", (e as Error).message),
    );
  import("./embedder.js")
    .then(({ embedQuery }) =>
      embedQuery("health check").then(
        () => logger.info("TEI embedder reachable"),
        (e) =>
          logger.warn("TEI embedder unreachable: %s", (e as Error).message),
      ),
    )
    .catch((e) =>
      logger.warn("Embedder module load failed: %s", (e as Error).message),
    );
}

const server = new McpServer({
  name: "searxng-mcp",
  version: pkg.version,
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
