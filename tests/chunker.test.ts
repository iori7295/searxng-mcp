import { describe, expect, it } from "vitest";
import { chunkPages } from "../src/chunker.js";

describe("chunkPages", () => {
  it("splits long text into multiple chunks", async () => {
    const pages = [
      {
        title: "Test",
        url: "https://example.com",
        text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. `).join(
          "",
        ),
      },
    ];
    const chunks = await chunkPages(pages, 150, 0);
    expect(chunks.length).toBeGreaterThan(1);
    const totalChars = chunks.reduce((s, c) => s + c.text.length, 0);
    expect(totalChars).toBeGreaterThanOrEqual(pages[0].text.length - 20);
  });

  it("passes short text as single chunk", async () => {
    const pages = [
      { title: "Short", url: "https://example.com", text: "Short text" },
    ];
    const chunks = await chunkPages(pages, 800, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Short text");
    expect(chunks[0].sourceIndex).toBe(0);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it("assigns correct sourceIndex and chunkIndex", async () => {
    const pages = [
      {
        title: "A",
        url: "https://a.com",
        text: Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1}. `).join(
          "",
        ),
      },
      {
        title: "B",
        url: "https://b.com",
        text: Array.from({ length: 20 }, (_, i) => `Word ${i + 1}. `).join(""),
      },
    ];
    const chunks = await chunkPages(pages, 100, 0);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    const aChunks = chunks.filter((c) => c.sourceIndex === 0);
    const bChunks = chunks.filter((c) => c.sourceIndex === 1);
    expect(aChunks.length).toBeGreaterThanOrEqual(1);
    expect(bChunks.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < aChunks.length; i++) {
      expect(aChunks[i].chunkIndex).toBe(i);
    }
  });

  it("handles empty page text", async () => {
    const pages = [{ title: "Empty", url: "https://example.com", text: "" }];
    const chunks = await chunkPages(pages, 800, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("");
  });

  it("produces overlapping chunks", async () => {
    const pages = [
      {
        title: "Overlap",
        url: "https://example.com",
        text: Array.from({ length: 30 }, (_, i) => `Word ${i + 1}. `).join(""),
      },
    ];
    const chunks = await chunkPages(pages, 150, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].text.slice(-50);
      const curHead = chunks[i].text.slice(0, 50);
      const overlap = prevTail
        .split(" ")
        .filter((w) => curHead.includes(w)).length;
      expect(overlap).toBeGreaterThan(0);
    }
  });
});
