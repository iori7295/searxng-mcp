#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { ENABLE_VECTOR_STORE } from "./config.js";
import { logger } from "./logger.js";
import { registerTools } from "./tools.js";

// Phase 2: Health checks
if (ENABLE_VECTOR_STORE) {
  try {
    const { getVectorStore } = await import("./vectorstore.js");
    const store = await getVectorStore();
    if (store) logger.info("Vector store ready");
    else logger.warn("Vector store unavailable — running without it");
  } catch (e) {
    logger.warn("Vector store init failed: %s", (e as Error).message);
  }
  try {
    const { embedQuery } = await import("./embedder.js");
    await embedQuery("health check");
    logger.info("TEI embedder reachable");
  } catch (e) {
    logger.warn("TEI embedder unreachable: %s", (e as Error).message);
  }
}

const server = new McpServer({
  name: "searxng-mcp",
  version: pkg.version,
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
