import pino from "pino";

export const logger = pino({
  name: "searxng-mcp",
  level: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  transport: {
    target: "pino/file",
    options: { destination: 2 }, // stderr (stdout is occupied by MCP JSON-RPC)
  },
});
