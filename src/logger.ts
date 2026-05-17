import pino from "pino";

export const logger = pino({
  name: "searxng-mcp",
  level: (process.env.LOG_LEVEL ?? "info").toLowerCase(),
  redact: {
    paths: [
      "headers.authorization",
      "Authorization",
      "*.apiKey",
      "api_key",
      "token",
      "secret",
    ],
    censor: "[REDACTED]",
  },
  transport: {
    target: "pino/file",
    options: { destination: 2 }, // stderr (stdout is occupied by MCP JSON-RPC)
  },
});
