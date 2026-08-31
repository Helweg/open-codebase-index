import { afterEach, describe, expect, it, vi } from "vitest";
import pRetry from "p-retry";
import {
  createCustomProviderInfo,
  detectEmbeddingProvider,
  getProviderDisplayName,
  tryDetectProvider,
} from "../src/embeddings/detector.js";
import { EMBEDDING_MODELS } from "../src/config/constants.js";
import { GoogleEmbeddingProvider } from "../src/embeddings/providers/google.js";
import { OpenAIEmbeddingProvider } from "../src/embeddings/providers/openai.js";
import { shouldRetryEmbeddingRequest } from "../src/indexer/index.js";
import { ProviderRequestError } from "../src/utils/operation-control.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("embeddings detector", () => {
  describe("getProviderDisplayName", () => {
    it("should return 'OpenAI' for openai", () => {
      expect(getProviderDisplayName("openai")).toBe("OpenAI");
    });

    it("should return 'Google (Gemini)' for google", () => {
      expect(getProviderDisplayName("google")).toBe("Google (Gemini)");
    });

    it("should return 'Ollama (Local)' for ollama", () => {
      expect(getProviderDisplayName("ollama")).toBe("Ollama (Local)");
    });

    it("should return the provider name as-is for unknown provider (default branch)", () => {
      // "auto" is no longer a valid EmbeddingProvider, but the default branch
      // still returns the input string for forward-compatibility
      expect(getProviderDisplayName("some-future-provider" as never)).toBe("some-future-provider");
    });

    it("should return 'Custom (OpenAI-compatible)' for custom", () => {
      expect(getProviderDisplayName("custom")).toBe("Custom (OpenAI-compatible)");
    });
  });

  describe("createCustomProviderInfo", () => {
    it("should create provider info with required fields", () => {
      const info = createCustomProviderInfo({
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        dimensions: 768,
      });
      expect(info.provider).toBe("custom");
      expect(info.credentials.provider).toBe("custom");
      expect(info.credentials.baseUrl).toBe("http://localhost:11434/v1");
      expect(info.credentials.apiKey).toBeUndefined();
      expect(info.modelInfo.provider).toBe("custom");
      expect(info.modelInfo.model).toBe("nomic-embed-text");
      expect(info.modelInfo.dimensions).toBe(768);
      expect(info.modelInfo.maxTokens).toBe(8192);
      expect(info.modelInfo.costPer1MTokens).toBe(0);
    });

    it("should pass through optional apiKey", () => {
      const info = createCustomProviderInfo({
        baseUrl: "https://api.example.com/v1",
        model: "my-model",
        dimensions: 1024,
        apiKey: "sk-test",
      });
      expect(info.credentials.apiKey).toBe("sk-test");
    });

    it("should use provided maxTokens", () => {
      const info = createCustomProviderInfo({
        baseUrl: "http://localhost/v1",
        model: "test",
        dimensions: 512,
        maxTokens: 4096,
      });
      expect(info.modelInfo.maxTokens).toBe(4096);
    });

    it("should pass through optional maxBatchSize", () => {
      const info = createCustomProviderInfo({
        baseUrl: "http://localhost/v1",
        model: "test",
        dimensions: 512,
        maxBatchSize: 64,
      });
      expect(info.modelInfo.maxBatchSize).toBe(64);
    });
  });

  describe("Ollama model discovery", () => {
    it("keeps catalog metadata for built-in models", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ models: [] })),
      );

      const provider = await detectEmbeddingProvider("ollama", "nomic-embed-text");

      expect(provider.modelInfo.model).toBe("nomic-embed-text");
      expect(provider.modelInfo.dimensions).toBe(768);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("canonicalizes auto-detected latest tags for built-in models", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).endsWith("/api/tags")) {
          return new Response(JSON.stringify({
            models: [{ name: "nomic-embed-text:latest" }],
          }));
        }
        return new Response(JSON.stringify({
          capabilities: ["embedding"],
          model_info: {
            "nomic-bert.context_length": 2048,
            "nomic-bert.embedding_length": 768,
          },
        }));
      });

      const provider = await tryDetectProvider();

      expect(provider.provider).toBe("ollama");
      expect(provider.modelInfo.model).toBe("nomic-embed-text");
      expect(provider.modelInfo.dimensions).toBe(768);
    });

    it("discovers metadata for an explicitly configured local model", async () => {
      vi.stubEnv("OLLAMA_HOST", "http://localhost:11434/");
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "private/embedding-model:v2" }] }));
        }
        if (url.endsWith("/api/show") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({ model: "private/embedding-model:v2" });
          return new Response(JSON.stringify({
            capabilities: ["embedding"],
            model_info: {
              "custom.context_length": 16384,
              "custom.embedding_length": 1536,
            },
          }));
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      const provider = await detectEmbeddingProvider("ollama", "private/embedding-model:v2");

      expect(provider.provider).toBe("ollama");
      expect(provider.credentials.baseUrl).toBe("http://localhost:11434");
      expect(provider.modelInfo).toEqual({
        provider: "ollama",
        model: "private/embedding-model:v2",
        dimensions: 1536,
        maxTokens: 16384,
        costPer1MTokens: 0,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("rejects installed chat models that are not embedding-capable", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "llama3.2:latest" }] }));
        }
        return new Response(JSON.stringify({
          capabilities: ["completion"],
          model_info: {
            "llama.context_length": 8192,
            "llama.embedding_length": 3072,
          },
        }));
      });

      await expect(detectEmbeddingProvider("ollama", "llama3.2:latest"))
        .rejects.toThrow("not installed or is not embedding-capable");
    });

    it("auto-detects embedding capability instead of relying on model names", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({
            models: [
              { model: "looks-like-embed-but-is-chat" },
              { model: "acme/retriever:v4" },
            ],
          }));
        }
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        if (model === "looks-like-embed-but-is-chat") {
          return new Response(JSON.stringify({ capabilities: ["completion"], model_info: {} }));
        }
        return new Response(JSON.stringify({
          capabilities: ["embedding"],
          model_info: {
            "acme.context_length": 4096,
            "acme.embedding_length": 640,
          },
        }));
      });

      const provider = await tryDetectProvider();

      expect(provider.provider).toBe("ollama");
      expect(provider.modelInfo.model).toBe("acme/retriever:v4");
      expect(provider.modelInfo.dimensions).toBe(640);
    });

    it("rejects embedding models with ambiguous dimension metadata", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (String(input).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "ambiguous" }] }));
        }
        return new Response(JSON.stringify({
          capabilities: ["embedding"],
          model_info: {
            "first.context_length": 2048,
            "first.embedding_length": 384,
            "second.embedding_length": 768,
          },
        }));
      });

      await expect(detectEmbeddingProvider("ollama", "ambiguous"))
        .rejects.toThrow("not installed or is not embedding-capable");
    });
  });
});

describe("GoogleEmbeddingProvider", () => {
  it("uses Gemini Embeddings 2 code-retrieval formatting", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      embeddings: [{ values: [0.1, 0.2] }],
    })));
    const provider = new GoogleEmbeddingProvider(
      { provider: "google", baseUrl: "https://example.test", apiKey: "test" },
      { ...EMBEDDING_MODELS.google["gemini-embedding-2"], dimensions: 2 },
    );
    const setPhase = vi.fn(async () => undefined);

    await provider.embedQuery("find the indexer", { setPhase });
    await provider.embedDocument("export class Indexer {}");

    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).requests[0]).toMatchObject({
      content: { parts: [{ text: "task: code retrieval | query: find the indexer" }] },
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).requests[0]).toMatchObject({
      content: { parts: [{ text: "title: none | text: export class Indexer {}" }] },
    });
    expect(setPhase).toHaveBeenCalledWith("embedding");
  });

  it("bounds the request while reading a response body", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
      }) as Response);
      const provider = new GoogleEmbeddingProvider(
        { provider: "google", baseUrl: "https://example.test", apiKey: "test" },
        EMBEDDING_MODELS.google["gemini-embedding-2"],
      );
      const assertion = expect(provider.embedQuery("query"))
        .rejects.toMatchObject({ timedOut: true, retryable: true });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { embeddings: [] },
    { embeddings: [{ values: [0.1] }] },
    { embeddings: [{ values: [0.1, Number.NaN] }] },
  ])("rejects malformed vectors without exposing response data", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    const provider = new GoogleEmbeddingProvider(
      { provider: "google", baseUrl: "https://secret.example", apiKey: "private" },
      { ...EMBEDDING_MODELS.google["gemini-embedding-2"], dimensions: 2 },
    );

    const error = await provider.embedQuery("private query").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "malformed_response", retryable: false });
    expect(String(error)).not.toContain("secret.example");
    expect(String(error)).not.toContain("private query");
  });
});

describe("OpenAIEmbeddingProvider", () => {
  it("bounds the request while reading a response body", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
      }) as Response);
      const provider = new OpenAIEmbeddingProvider(
        { provider: "openai", baseUrl: "https://example.test", apiKey: "test" },
        EMBEDDING_MODELS.openai["text-embedding-3-small"],
      );
      const assertion = expect(provider.embedQuery("query"))
        .rejects.toMatchObject({ timedOut: true, retryable: true });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { data: [], usage: { total_tokens: 1 } },
    { data: [{ embedding: [0.1] }], usage: { total_tokens: 1 } },
    { data: [{ embedding: [0.1, Number.POSITIVE_INFINITY] }], usage: { total_tokens: 1 } },
  ])("rejects malformed vectors without exposing response data", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body)));
    const provider = new OpenAIEmbeddingProvider(
      { provider: "openai", baseUrl: "https://secret.example", apiKey: "private" },
      { ...EMBEDDING_MODELS.openai["text-embedding-3-small"], dimensions: 2 },
    );

    const error = await provider.embedQuery("private query").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "malformed_response", retryable: false });
    expect(String(error)).not.toContain("secret.example");
    expect(String(error)).not.toContain("private query");
  });
});

describe("embedding request retries", () => {
  it("does not retry non-retryable provider 4xx failures", async () => {
    const request = vi.fn(async () => {
      throw new ProviderRequestError({ statusCode: 400 });
    });

    await expect(pRetry(request, {
      retries: 3,
      minTimeout: 0,
      shouldRetry: ({ error }) => shouldRetryEmbeddingRequest(error),
    })).rejects.toBeInstanceOf(ProviderRequestError);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([429, 500])("retries retryable provider status %i", async (statusCode) => {
    const request = vi.fn(async () => {
      throw new ProviderRequestError({ statusCode });
    });

    await expect(pRetry(request, {
      retries: 2,
      minTimeout: 0,
      shouldRetry: ({ error }) => shouldRetryEmbeddingRequest(error),
    })).rejects.toBeInstanceOf(ProviderRequestError);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
