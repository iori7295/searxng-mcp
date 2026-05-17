import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { PDFParse } from "pdf-parse";
import { afterEach, describe, expect, it } from "vitest";
import {
  circuitState,
  isCircuitOpen,
  recordFailure,
  recordSuccess,
} from "../src/circuit.js";
import { assertPublicUrl } from "../src/fetch.js";
import type {
  GitHubCommentResponse,
  GitHubIssueResponse,
} from "../src/types.js";

describe("pdf-parse integration", () => {
  it("can import and instantiate PDFParse", () => {
    const parser = new PDFParse({
      data: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]),
    });
    expect(parser).toBeInstanceOf(PDFParse);
  });
});

describe("GitHubIssueResponse type", () => {
  it("accepts a valid issue response", () => {
    const issue: GitHubIssueResponse = {
      title: "Test issue",
      body: "This is a test body",
      html_url: "https://github.com/owner/repo/issues/1",
      state: "open",
      user: { login: "testuser" },
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      comments: 3,
      reactions: {
        "+1": 5,
        "-1": 0,
        laugh: 2,
        hooray: 0,
        confused: 0,
        heart: 1,
        rocket: 0,
        eyes: 0,
      },
    };
    expect(issue.title).toBe("Test issue");
    expect(issue.user.login).toBe("testuser");
    expect(issue.reactions?.["+1"]).toBe(5);
  });
});

describe("GitHubCommentResponse type", () => {
  it("accepts a valid comment response", () => {
    const comment: GitHubCommentResponse = {
      body: "This is a comment",
      html_url: "https://github.com/owner/repo/issues/1#issuecomment-123",
      user: { login: "commenter" },
      created_at: "2024-01-01T12:00:00Z",
      reactions: {
        "+1": 1,
        "-1": 0,
        laugh: 0,
        hooray: 0,
        confused: 0,
        heart: 0,
        rocket: 0,
        eyes: 0,
      },
    };
    expect(comment.body).toBe("This is a comment");
    expect(comment.user.login).toBe("commenter");
  });
});

describe("assertPublicUrl", () => {
  it("accepts a normal public HTTPS URL", async () => {
    await expect(
      assertPublicUrl("https://example.com/page"),
    ).resolves.not.toThrow();
  });

  it("accepts a normal public HTTP URL", async () => {
    await expect(
      assertPublicUrl("http://example.com/page"),
    ).resolves.not.toThrow();
  });

  it("throws on localhost", async () => {
    await expect(assertPublicUrl("http://localhost/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 127.0.0.1", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 0.0.0.0", async () => {
    await expect(assertPublicUrl("http://0.0.0.0/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 10.x.x.x", async () => {
    await expect(assertPublicUrl("http://10.0.0.1/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 192.168.x.x", async () => {
    await expect(assertPublicUrl("http://192.168.1.1/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 172.16.x.x (RFC 1918 range)", async () => {
    await expect(assertPublicUrl("http://172.16.0.1/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 172.31.x.x (RFC 1918 range boundary)", async () => {
    await expect(assertPublicUrl("http://172.31.255.255/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("accepts 172.15.x.x (just outside RFC 1918 range)", async () => {
    await expect(
      assertPublicUrl("http://172.15.0.1/page"),
    ).resolves.not.toThrow();
  });

  it("throws on host.docker.internal", async () => {
    await expect(
      assertPublicUrl("http://host.docker.internal/page"),
    ).rejects.toThrow("Internal/private addresses are not allowed");
  });

  it("throws on ::1 (IPv6 loopback)", async () => {
    await expect(assertPublicUrl("http://[::1]/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [0:0:0:0:0:0:0:1] (IPv6 full-form loopback)", async () => {
    await expect(
      assertPublicUrl("http://[0:0:0:0:0:0:0:1]/page"),
    ).rejects.toThrow("Internal/private addresses are not allowed");
  });

  it("throws on [fc00::] (IPv6 ULA fc range)", async () => {
    await expect(assertPublicUrl("http://[fc00::]/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [fd00::] (IPv6 ULA fd range)", async () => {
    await expect(assertPublicUrl("http://[fd00::]/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on [fe80::] (IPv6 link-local)", async () => {
    await expect(assertPublicUrl("http://[fe80::]/page")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on non-http protocol", async () => {
    await expect(assertPublicUrl("ftp://example.com/page")).rejects.toThrow(
      "Only http/https URLs are supported",
    );
  });

  // New SSRF bypass tests
  it("throws on decimal IP representation (2130706433 = 127.0.0.1)", async () => {
    await expect(assertPublicUrl("http://2130706433/")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on hex IP representation (0x7f000001 = 127.0.0.1)", async () => {
    await expect(assertPublicUrl("http://0x7f000001/")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on octal IPv4 (0177.0.0.1 = 127.0.0.1)", async () => {
    await expect(assertPublicUrl("http://0177.0.0.1/")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on IPv4-mapped IPv6 (::ffff:127.0.0.1)", async () => {
    await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on link-local 169.254.x.x", async () => {
    await expect(assertPublicUrl("http://169.254.169.254/")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });

  it("throws on 0.0.0.0/8 range (0.1.2.3)", async () => {
    await expect(assertPublicUrl("http://0.1.2.3/")).rejects.toThrow(
      "Internal/private addresses are not allowed",
    );
  });
});

describe("rawFetch Defuddle integration", () => {
  const articleHtml = `<!DOCTYPE html>
<html><head><title>Test Article</title></head>
<body>
<nav>Navigation links</nav>
<article>
<h1>Main Article Title</h1>
<p>This is the first paragraph of the article. It contains meaningful content that should be extracted.</p>
<p>This is the second paragraph with additional information about the topic.</p>
</article>
<footer>Footer spam</footer>
</body></html>`;

  it("extracts article text from HTML with navigation noise", async () => {
    const { document } = parseHTML(articleHtml);
    const result = await Defuddle(document, "https://example.com", {
      markdown: true,
    });
    expect(result.content.length).toBeGreaterThan(100);
    expect(result.title).toBe("Test Article");
    expect(result.content).toContain("first paragraph");
    expect(result.content).toContain("second paragraph");
    expect(result.content).not.toContain("Navigation links");
    expect(result.content).not.toContain("Footer spam");
  });

  it("falls back to short content for non-article HTML", async () => {
    const minimalHtml = "<html><body><p>Short text.</p></body></html>";
    const { document } = parseHTML(minimalHtml);
    const result = await Defuddle(document, "https://example.com", {
      markdown: true,
    });
    // Non-article content should be short (< 100 chars)
    expect(result.content.length).toBeLessThan(100);
  });

  it("handles broken HTML without throwing", async () => {
    const brokenHtml =
      "<html><head><title>Broken</title></head><body><p>Unclosed tag<div>Nested<button></body>";
    await expect(async () => {
      const { document } = parseHTML(brokenHtml);
      const result = await Defuddle(document, "https://example.com", {
        markdown: true,
      });
      expect(typeof result.content).toBe("string");
    }).not.toThrow();
  });
});

describe("circuit breaker", () => {
  afterEach(() => {
    circuitState.clear();
  });

  it("starts closed for a fresh service", () => {
    expect(isCircuitOpen("firecrawl")).toBe(false);
  });

  it("opens after 3 consecutive failures", () => {
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    expect(isCircuitOpen("firecrawl")).toBe(false);
    recordFailure("firecrawl");
    expect(isCircuitOpen("firecrawl")).toBe(true);
  });

  it("skips service while circuit is open", () => {
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    expect(isCircuitOpen("firecrawl")).toBe(true);
  });

  it("resets on successful call", () => {
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    expect(isCircuitOpen("firecrawl")).toBe(true);
    recordSuccess("firecrawl");
    expect(isCircuitOpen("firecrawl")).toBe(false);
  });

  it("resets after cooldown period", () => {
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    recordFailure("firecrawl");
    expect(isCircuitOpen("firecrawl")).toBe(true);
    // Manually expire by setting openUntil in the past
    const state = circuitState.get("firecrawl");
    expect(state).toBeDefined();
    if (state) state.openUntil = Date.now() - 1;
    circuitState.set("firecrawl", state);
    expect(isCircuitOpen("firecrawl")).toBe(false);
    // Should be fully cleaned up
    expect(circuitState.has("firecrawl")).toBe(false);
  });

  it("tracks failures independently per service", () => {
    recordFailure("firecrawl");
    recordFailure("crawl4ai");
    recordFailure("crawl4ai");
    recordFailure("crawl4ai");
    expect(isCircuitOpen("firecrawl")).toBe(false);
    expect(isCircuitOpen("crawl4ai")).toBe(true);
  });
});
