import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, ENABLE_VECTOR_STORE } from "../src/config.js";

describe("embedder interface", () => {
  it("exports embedQuery and embedPassages functions", async () => {
    const mod = await import("../src/embedder.js");
    expect(typeof mod.embedQuery).toBe("function");
    expect(typeof mod.embedPassages).toBe("function");
  });
});

describe("vectorstore interface", () => {
  it("returns null when ENABLE_VECTOR_STORE is false", async () => {
    if (!ENABLE_VECTOR_STORE) {
      const { getVectorStore } = await import("../src/vectorstore.js");
      const store = await getVectorStore();
      expect(store).toBeNull();
    }
  });

  it("EMBEDDING_DIM is a positive integer", () => {
    expect(Number.isInteger(EMBEDDING_DIM)).toBe(true);
    expect(EMBEDDING_DIM).toBeGreaterThan(0);
  });
});

describe("tokenizer", () => {
  it("counts tokens for simple text", async () => {
    const { countTokens } = await import("../src/tokenizer.js");
    const n = countTokens("Hello, world!");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(10);
  });

  it("truncateToBudget shortens long text", async () => {
    const { truncateToBudget } = await import("../src/tokenizer.js");
    const long = "hello world ".repeat(200);
    const short = truncateToBudget(long, 10);
    expect(short.length).toBeLessThan(long.length);
  });
});
