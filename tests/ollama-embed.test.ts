import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaEmbeddingProvider } from "../src/embeddings/providers/ollama.js";

// Small dimensions keep the mocked vectors tiny; the provider validates every
// vector against modelInfo.dimensions, so this still exercises the real path.
const modelInfo = {
  provider: "ollama" as const,
  model: "nomic-embed-text",
  dimensions: 3,
  maxTokens: 2048,
  costPer1MTokens: 0,
};

function makeProvider() {
  return new OllamaEmbeddingProvider(
    { provider: "ollama", baseUrl: "http://localhost:11434" },
    modelInfo,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OllamaEmbeddingProvider.embedBatch", () => {
  it("sends all texts to /api/embed in one request and parses embeddings in order", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        const body = JSON.parse(String(init?.body));
        expect(body.input).toEqual(["aaa", "bbb"]);
        expect(body.truncate).toBe(false);
        expect(body.model).toBe("nomic-embed-text");
        return new Response(JSON.stringify({
          embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
        }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch(["aaa", "bbb"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
    // estimateTokens = ceil(len / 4): "aaa" -> 1, "bbb" -> 1
    expect(result.totalTokensUsed).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty result for an empty batch without calling ollama", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(""));

    const result = await makeProvider().embedBatch([]);

    expect(result).toEqual({ embeddings: [], totalTokensUsed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the legacy /api/embeddings path for a single text and never probes /api/embed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/embeddings")) {
        const body = JSON.parse(String(init?.body));
        expect(body.prompt).toBe("aaa");
        expect(body.truncate).toBe(false);
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch(["aaa"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.totalTokensUsed).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to per-text /api/embeddings when /api/embed returns 404 (old ollama)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/embeddings")) {
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch(["aaa", "bbb"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    // 1 batched attempt (404) + 2 per-text fallback requests
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("falls back to per-text truncation when /api/embed signals a context-length error", async () => {
    const longText = "x".repeat(10_000); // exceeds maxTokens * 4 = 8192 chars
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        return new Response(JSON.stringify({ error: "input length exceeds the context length" }), { status: 400 });
      }
      if (url.endsWith("/api/embeddings")) {
        const body = JSON.parse(String(init?.body));
        if (body.prompt.length > 8192) {
          return new Response(JSON.stringify({ error: "context length exceeded" }), { status: 400 });
        }
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch([longText, "aaa"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
  });

  it("falls back to per-text /api/embeddings when /api/embed returns a malformed batch (one bad vector fails only its own chunk)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        // wrong vector count: 1 vector for 2 inputs
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
      }
      if (url.endsWith("/api/embeddings")) {
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch(["aaa", "bbb"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    // 1 batched attempt (rejected) + 2 per-text fallback requests
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("propagates the per-text error when the fallback path itself fails (no retry loop)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        // malformed batch triggers the fallback
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
      }
      if (url.endsWith("/api/embeddings")) {
        // per-text vector is also invalid (wrong dimensions)
        return new Response(JSON.stringify({ embedding: [0.1, 0.2] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(makeProvider().embedBatch(["aaa", "bbb"])).rejects.toThrow("invalid embedding");
  });

  it("propagates non-404, non-context-length errors from /api/embed (lets pRetry handle them)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        return new Response(JSON.stringify({ error: "server error" }), { status: 500 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(makeProvider().embedBatch(["aaa", "bbb"])).rejects.toThrow("Ollama embedding API error: 500");
  });

  it("falls back to per-text /api/embeddings when /api/embed returns a non-JSON 200 body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        return new Response("not json", { status: 200 });
      }
      if (url.endsWith("/api/embeddings")) {
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch(["aaa", "bbb"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    // 1 batched attempt (malformed) + 2 per-text fallback requests
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("falls back to per-text /api/embeddings when /api/embed returns a null 200 body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/embed")) {
        return new Response("null", { status: 200 });
      }
      if (url.endsWith("/api/embeddings")) {
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await makeProvider().embedBatch(["aaa", "bbb"]);

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});