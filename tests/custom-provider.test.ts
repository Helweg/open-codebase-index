import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEmbeddingProvider, CustomProviderNonRetryableError } from "../src/embeddings/provider.js";
import { createCustomProviderInfo, type ConfiguredProviderInfo } from "../src/embeddings/detector.js";
import { Indexer } from "../src/indexer/index.js";
import { parseConfig } from "../src/config/schema.js";
import { EMBEDDING_MODELS } from "../src/config/constants.js";
import pRetry from "p-retry";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OperationCancelledError,
  ProviderRequestError,
} from "../src/utils/operation-control.js";

function getRejectedError<T>(promise: Promise<T>): Promise<Error> {
  return promise.then<Error>(
    () => {
      throw new Error("Expected promise to reject");
    },
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  );
}

describe("CustomEmbeddingProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function getCustomProviderInfo(
    info: ConfiguredProviderInfo
  ): Extract<ConfiguredProviderInfo, { provider: "custom" }> {
    expect(info.provider).toBe("custom");
    if (info.provider !== "custom") {
      throw new Error("Expected custom provider info");
    }
    return info;
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function createProvider(overrides?: { apiKey?: string; baseUrl?: string }) {
    const info = createCustomProviderInfo({
      baseUrl: overrides?.baseUrl ?? "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      apiKey: overrides?.apiKey,
    });
    return createEmbeddingProvider(info);
  }

  it("should call the correct URL with model and input", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0.1) }],
      usage: { total_tokens: 10 },
    }), { status: 200 }));

    const provider = createProvider();
    const result = await provider.embedQuery("test query");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/embeddings");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe("nomic-embed-text");
    expect(body.input).toEqual(["test query"]);
    expect(result.embedding).toHaveLength(768);
    expect(result.tokensUsed).toBe(10);
  });

  it("should include Authorization header when apiKey is provided", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0) }],
      usage: { total_tokens: 5 },
    }), { status: 200 }));

    const provider = createProvider({ apiKey: "sk-test-123" });
    await provider.embedQuery("test");

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
  });

  it("should not include Authorization header when no apiKey", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0) }],
      usage: { total_tokens: 5 },
    }), { status: 200 }));

    const provider = createProvider();
    await provider.embedQuery("test");

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("should handle batch embedding", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { embedding: new Array(768).fill(0.1) },
        { embedding: new Array(768).fill(0.2) },
        { embedding: new Array(768).fill(0.3) },
      ],
      usage: { total_tokens: 30 },
    }), { status: 200 }));

    const provider = createProvider();
    const result = await provider.embedBatch(["text1", "text2", "text3"]);

    expect(result.embeddings).toHaveLength(3);
    expect(result.totalTokensUsed).toBe(30);
  });

  it("should split custom provider requests by maxBatchSize", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { embedding: new Array(768).fill(0.1) },
          { embedding: new Array(768).fill(0.2) },
        ],
        usage: { total_tokens: 20 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { embedding: new Array(768).fill(0.3) },
          { embedding: new Array(768).fill(0.4) },
        ],
        usage: { total_tokens: 22 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          { embedding: new Array(768).fill(0.5) },
        ],
        usage: { total_tokens: 11 },
      }), { status: 200 }));

    const info = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      maxBatchSize: 2,
    });
    const provider = createEmbeddingProvider(info);

    const result = await provider.embedBatch(["text1", "text2", "text3", "text4", "text5"]);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string).input).toEqual(["text1", "text2"]);
    expect(JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string).input).toEqual(["text3", "text4"]);
    expect(JSON.parse((fetchSpy.mock.calls[2] as [string, RequestInit])[1].body as string).input).toEqual(["text5"]);
    expect(result.embeddings).toHaveLength(5);
    expect(result.totalTokensUsed).toBe(53);
  });

  it("should estimate tokens when usage is not provided", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0) }],
    }), { status: 200 }));

    const provider = createProvider();
    const result = await provider.embedBatch(["hello world"]);

    expect(result.embeddings).toHaveLength(1);
    expect(result.totalTokensUsed).toBeGreaterThan(0);
  });

  it("should throw on non-OK response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Rate limited", { status: 429 }));

    const provider = createProvider();
    await expect(provider.embedQuery("test")).rejects.toThrow("Custom embedding provider returned HTTP 429.");
  });

  it("should throw on unexpected response format", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      unexpected: "format",
    }), { status: 200 }));

    const provider = createProvider();
    await expect(provider.embedQuery("test")).rejects.toThrow("unexpected response format");
  });

  it("should strip trailing slashes from baseUrl", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0) }],
      usage: { total_tokens: 5 },
    }), { status: 200 }));

    const provider = createProvider({ baseUrl: "http://localhost:11434/v1///" });
    await provider.embedQuery("test");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/embeddings");
  });

  it("should return correct model info", () => {
    const provider = createProvider();
    const info = provider.getModelInfo();
    expect(info.model).toBe("nomic-embed-text");
    expect(info.dimensions).toBe(768);
    expect(info.costPer1MTokens).toBe(0);
  });

  it("should handle empty texts array", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [],
      usage: { total_tokens: 0 },
    }), { status: 200 }));

    const provider = createProvider();
    const result = await provider.embedBatch([]);

    expect(result.embeddings).toHaveLength(0);
    expect(result.totalTokensUsed).toBe(0);
  });

  it("should throw on dimension mismatch between config and API response", async () => {
    // API returns 1024-dim vectors but config says 768
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(1024).fill(0.1) }],
      usage: { total_tokens: 10 },
    }), { status: 200 }));

    const provider = createProvider();
    await expect(provider.embedQuery("test")).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
  });

  it("should always throw on dimension mismatch, even after a successful call", async () => {
    // First call: correct dimensions
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0.1) }],
      usage: { total_tokens: 10 },
    }), { status: 200 }));
    // Second call: wrong dimensions — should throw, not warn
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(512).fill(0.1) }],
      usage: { total_tokens: 10 },
    }), { status: 200 }));

    const provider = createProvider();
    const result1 = await provider.embedQuery("first");
    expect(result1.embedding).toHaveLength(768);

    // Second call still rejects the incompatible provider contract.
    await expect(provider.embedQuery("second")).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
  });

  it("should use configurable timeout", async () => {
    const info = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      timeoutMs: 5000,
    });
    const provider = createEmbeddingProvider(info);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ embedding: new Array(768).fill(0) }],
      usage: { total_tokens: 5 },
    }), { status: 200 }));

    await provider.embedQuery("test");

    // Verify the AbortSignal was passed (timeout is set internally)
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(options.signal).toBeDefined();
  });

  it("should default timeout to 30000ms", () => {
    const info = getCustomProviderInfo(createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
    }));
    expect(info.modelInfo.timeoutMs).toBe(30000);
  });

  it("should use custom timeout value from config", () => {
    const info = getCustomProviderInfo(createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      timeoutMs: 60000,
    }));
    expect(info.modelInfo.timeoutMs).toBe(60000);
  });

  it("should throw non-retryable error on 4xx responses (except 429)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    const provider = createProvider();
    const error = await getRejectedError(provider.embedQuery("test"));
    expect(error).toBeInstanceOf(CustomProviderNonRetryableError);
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("Unauthorized");
  });

  it("should throw non-retryable error on 400 Bad Request", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Bad model name", { status: 400 }));
    const provider = createProvider();
    const error = await getRejectedError(provider.embedQuery("test"));
    expect(error).toBeInstanceOf(CustomProviderNonRetryableError);
  });

  it("should throw non-retryable error on 403 Forbidden", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    const provider = createProvider();
    const error = await getRejectedError(provider.embedQuery("test"));
    expect(error).toBeInstanceOf(CustomProviderNonRetryableError);
  });

  it("should throw retryable error on 429 rate limit", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Rate limited", { status: 429 }));
    const provider = createProvider();
    const error = await getRejectedError(provider.embedQuery("test"));
    expect(error).not.toBeInstanceOf(CustomProviderNonRetryableError);
    expect(error.message).toContain("429");
  });

  it("should throw retryable error on 5xx server errors", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const provider = createProvider();
    const error = await getRejectedError(provider.embedQuery("test"));
    expect(error).not.toBeInstanceOf(CustomProviderNonRetryableError);
    expect(error.message).toContain("500");
  });

  it("should throw on embedding count mismatch (fewer than expected)", async () => {
    // Send 3 texts but server returns only 2 embeddings
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { embedding: new Array(768).fill(0.1) },
        { embedding: new Array(768).fill(0.2) },
      ],
      usage: { total_tokens: 20 },
    }), { status: 200 }));

    const provider = createProvider();
    await expect(provider.embedBatch(["text1", "text2", "text3"])).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
  });

  it("should throw on embedding count mismatch (more than expected)", async () => {
    // Send 1 text but server returns 2 embeddings
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { embedding: new Array(768).fill(0.1) },
        { embedding: new Array(768).fill(0.2) },
      ],
      usage: { total_tokens: 10 },
    }), { status: 200 }));

    const provider = createProvider();
    await expect(provider.embedBatch(["text1"])).rejects.toMatchObject({
      kind: "malformed_response",
      retryable: false,
    });
  });

  it("should throw AbortError with timeout message when fetch is aborted", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(abortError);

    const info = createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      timeoutMs: 5000,
    });
    const provider = createEmbeddingProvider(info);

    await expect(provider.embedQuery("test")).rejects.toThrow(
      "Custom embedding provider request timed out after 5000ms."
    );
  });

  it("keeps the provider timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }),
      }) as Response);
      const provider = createEmbeddingProvider(createCustomProviderInfo({
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        dimensions: 768,
        timeoutMs: 1000,
      }));
      const assertion = expect(provider.embedQuery("test"))
        .rejects.toThrow("Custom embedding provider request timed out after 1000ms.");

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts non-AbortError fetch failures", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

    const provider = createProvider();
    const error = await getRejectedError(provider.embedQuery("test"));
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.message).toBe("Custom embedding provider request failed.");
    expect(error.message).not.toContain("fetch failed");
  });

  it("should not retry on CustomProviderNonRetryableError via pRetry shouldRetry", async () => {
    // This tests the exact shouldRetry pattern used in src/indexer/index.ts
    // pRetry passes a plain object { error, attemptNumber, retriesLeft, retriesConsumed } to shouldRetry,
    // NOT the original Error — so we must access .error to get the original error's name.
    const shouldRetry = (error: unknown) => (error as { error?: Error }).error?.name !== "CustomProviderNonRetryableError";

    let attempts = 0;
    const nonRetryableError = new Error("Custom embedding API error (non-retryable): 401 - Unauthorized");
    nonRetryableError.name = "CustomProviderNonRetryableError";

    await expect(
      pRetry(
        async () => {
          attempts++;
          throw nonRetryableError;
        },
        { retries: 3, minTimeout: 10, shouldRetry }
      )
    ).rejects.toThrow("non-retryable");

    // Should have been called exactly once — pRetry should not retry
    expect(attempts).toBe(1);
  });

  it("should retry on regular errors via pRetry shouldRetry", async () => {
    const shouldRetry = (error: unknown) => (error as { error?: Error }).error?.name !== "CustomProviderNonRetryableError";

    let attempts = 0;
    await expect(
      pRetry(
        async () => {
          attempts++;
          throw new Error("Custom embedding API error: 500 - Internal Server Error");
        },
        { retries: 2, minTimeout: 10, shouldRetry }
      )
    ).rejects.toThrow("500");

    // Should have been called 3 times (1 initial + 2 retries)
    expect(attempts).toBe(3);
  });
});

describe("OllamaEmbeddingProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function createOllamaProvider(model: keyof typeof EMBEDDING_MODELS.ollama = "nomic-embed-text") {
    return createEmbeddingProvider({
      provider: "ollama",
      credentials: {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      },
      modelInfo: EMBEDDING_MODELS.ollama[model],
    });
  }

  it("retries oversize prompts with truncation for ollama", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: new Array(768).fill(0.1) }), { status: 200 }));

    const provider = createOllamaProvider();
    const oversized = "x".repeat(9000);
    const result = await provider.embedBatch([oversized]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string) as { prompt: string; truncate: boolean };
    const secondBody = JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string) as { prompt: string; truncate: boolean };
    expect(firstBody.truncate).toBe(false);
    expect(secondBody.truncate).toBe(false);
    expect(secondBody.prompt.length).toBeLessThan(firstBody.prompt.length);
    expect(result.embeddings).toHaveLength(1);
  });

  it("backs off on context errors even when the prompt is below the estimated char limit", async () => {
    const prompts: string[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string; truncate?: boolean };
      prompts.push(body.prompt ?? "");

      if (prompts.length === 1) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.1) }), { status: 200 });
    });

    const provider = createOllamaProvider();
    const nearLimit = "x".repeat(7000);
    const result = await provider.embedBatch([nearLimit]);

    expect(prompts).toHaveLength(2);
    expect(prompts[1].length).toBeLessThan(prompts[0].length);
    expect(result.embeddings).toHaveLength(1);
  });

  it("keeps shrinking ollama prompts until a context-length retry succeeds", async () => {
    const prompts: string[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string; truncate?: boolean };
      prompts.push(body.prompt ?? "");

      if (prompts.length < 3) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.1) }), { status: 200 });
    });

    const provider = createOllamaProvider();
    const oversized = "x".repeat(9000);
    const result = await provider.embedBatch([oversized]);

    expect(prompts).toHaveLength(3);
    expect(prompts[1].length).toBeLessThan(prompts[0].length);
    expect(prompts[2].length).toBeLessThan(prompts[1].length);
    expect(result.embeddings).toHaveLength(1);
  });

  it("matches alternate Ollama context-length error wording", async () => {
    const prompts: string[] = [];
    fetchSpy.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string; truncate?: boolean };
      prompts.push(body.prompt ?? "");

      if (prompts.length === 1) {
        return new Response(JSON.stringify({ error: "Context length exceeded for this embedding request" }), { status: 500 });
      }

      return new Response(JSON.stringify({ embedding: new Array(768).fill(0.1) }), { status: 200 });
    });

    const provider = createOllamaProvider();
    const oversized = "x".repeat(9000);
    const result = await provider.embedBatch([oversized]);

    expect(prompts).toHaveLength(2);
    expect(prompts[1].length).toBeLessThan(prompts[0].length);
    expect(result.embeddings).toHaveLength(1);
  });

  it("batches multiple ollama embedBatch texts into a single /api/embed request", async () => {
    let calls = 0;
    fetchSpy.mockImplementation(async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; truncate?: boolean };
      expect(body.truncate).toBe(false);
      expect(body.input).toEqual(["first", "second", "third"]);
      return new Response(JSON.stringify({
        embeddings: [0.1, 0.2, 0.3].map((v) => new Array(768).fill(v)),
      }), { status: 200 });
    });

    const provider = createOllamaProvider();
    const result = await provider.embedBatch(["first", "second", "third"]);

    expect(result.embeddings).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it("redacts non-context ollama errors", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));

    const provider = createOllamaProvider();
    const error = await getRejectedError(provider.embedBatch(["hello"]));
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error.message).toBe("Ollama embedding provider returned HTTP 500.");
    expect(error.message).not.toContain("boom");
  });

  it("aborts ollama embedding requests after the bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }));

      const provider = createOllamaProvider();
      const assertion = expect(provider.embedBatch(["hello"]))
        .rejects.toThrow("Ollama embedding request timed out after 120000ms");

      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back to per-text requests after caller cancellation", async () => {
    let calls = 0;
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    fetchSpy.mockImplementation(async (_url, init) => {
      calls += 1;
      markRequestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    const controller = new AbortController();
    const provider = createOllamaProvider();
    const operation = provider.embedBatch(["first", "second"], { signal: controller.signal });
    await requestStarted;
    controller.abort();

    await expect(operation).rejects.toBeInstanceOf(OperationCancelledError);
    expect(calls).toBe(1);
  });

  it("rejects ollama embeddings with the wrong vector dimensions", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      embedding: new Array(384).fill(0.1),
    }), { status: 200 }));

    const provider = createOllamaProvider();
    await expect(provider.embedBatch(["hello"]))
      .rejects.toThrow("expected 768 finite dimensions");
  });
});

describe("Indexer custom provider initialization", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-custom-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should throw when embeddingProvider is 'custom' but customProvider is missing", async () => {
    // Manually construct a config where embeddingProvider is 'custom' but customProvider is undefined.
    // parseConfig() would normally reject this, but initialize() has its own guard for safety.
    const baseConfig = parseConfig({ embeddingProvider: "openai" });
    const config = { ...baseConfig, embeddingProvider: "custom" as const, customProvider: undefined };
    const indexer = new Indexer(tempDir, config, "opencode");
    await expect(indexer.initialize()).rejects.toThrow(
      "embeddingProvider is 'custom' but customProvider config is missing"
    );
  });
});
