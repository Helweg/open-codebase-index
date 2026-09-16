import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type EmbeddingFallbackConfig } from "../src/config/schema.js";
import { createCustomProviderInfo, resolveConfiguredEmbeddingProvider, type ConfiguredProviderInfo } from "../src/embeddings/detector.js";
import { createEmbeddingProvider } from "../src/embeddings/provider.js";
import { EmbeddingFallbackError } from "../src/embeddings/fallback.js";
import { shouldRetryEmbeddingRequest } from "../src/indexer/index.js";
import { OperationCancelledError, OperationStallTimeoutError, ProviderRequestError } from "../src/utils/operation-control.js";

const primaryConfig = { baseUrl: "http://primary.test/v1", model: "replica-model", dimensions: 2, maxTokens: 8192, timeoutMs: 1000, maxBatchSize: 2, apiKey: "primary-secret" };
const replica = { provider: "custom" as const, baseUrl: "http://replica.test/v1", model: "replica-model", dimensions: 2 };
const info = createCustomProviderInfo(primaryConfig);
const vectors = [[1, 0], [0, 1]];
const response = (embeddings = vectors) => new Response(JSON.stringify({ data: embeddings.map((embedding) => ({ embedding })), usage: { total_tokens: 7 } }));
const makeProvider = (fallback = replica, onFallback = vi.fn()) => createEmbeddingProvider(info, fallback, onFallback);

// One primary per provider protocol: every request path drains the error body
// before it builds the status error.
const openAIPrimary: ConfiguredProviderInfo = {
  provider: "openai",
  credentials: { provider: "openai", baseUrl: "http://primary.test/v1", apiKey: "primary-secret" },
  modelInfo: { provider: "openai", model: "text-embedding-3-small", dimensions: 2, maxTokens: 8192, costPer1MTokens: 0 },
};
const ollamaPrimary: ConfiguredProviderInfo = {
  provider: "ollama",
  credentials: { provider: "ollama", baseUrl: "http://primary.test" },
  modelInfo: { provider: "ollama", model: "replica-model", dimensions: 2, maxTokens: 8192, costPer1MTokens: 0 },
};
const googlePrimary: ConfiguredProviderInfo = {
  provider: "google",
  credentials: { provider: "google", baseUrl: "http://primary.test", apiKey: "primary-secret" },
  modelInfo: { provider: "google", model: "gemini-embedding-001", dimensions: 2, maxTokens: 8192, costPer1MTokens: 0, taskAble: true },
};
// Headers arrive, then the body read fails: the HTTP status is already known.
const truncatedBody = (status = 503) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode("{\"error\":\"upstream"));
    controller.error(new TypeError("terminated"));
  },
}), { status });
const drainCases: Array<[string, ConfiguredProviderInfo, EmbeddingFallbackConfig, () => Response]> = [
  ["custom", info, replica, () => response()],
  ["openai", openAIPrimary, { ...replica, model: "text-embedding-3-small" }, () => response()],
  ["ollama", ollamaPrimary, { ...replica, provider: "ollama", baseUrl: "http://replica.test" }, () => new Response(JSON.stringify({ embeddings: vectors }))],
  ["google", googlePrimary, { ...replica, provider: "google", model: "gemini-embedding-001" }, () => new Response(JSON.stringify({ embeddings: vectors.map((values) => ({ values })) }))],
];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("embedding fallback requests", () => {
  it("uses only the primary while healthy and retries it on the next call after failover", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response());
    const warn = vi.fn();
    const provider = makeProvider(replica, warn);
    for (let i = 0; i < 3; i++) expect((await provider.embedBatch(["a", "b"])).embeddings).toEqual(vectors);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://primary.test/v1/embeddings", "http://primary.test/v1/embeddings",
      "http://replica.test/v1/embeddings", "http://primary.test/v1/embeddings",
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(provider.getModelInfo()).toEqual(info.modelInfo);
  });

  it.each([401, 403, 404, 429, 500, 502, 503, 504])("uses fallback after HTTP %i without waiting for indexer retries", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("private upstream body", { status })).mockResolvedValueOnce(response());
    expect((await makeProvider().embedBatch(["a", "b"])).embeddings).toEqual(vectors);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses fallback after a network failure and preserves credential isolation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("connection refused")).mockResolvedValueOnce(response());
    await makeProvider().embedBatch(["a", "b"]);
    expect(fetch.mock.calls[0][1]?.headers).toHaveProperty("Authorization", "Bearer primary-secret");
    expect(fetch.mock.calls[1][1]?.headers).not.toHaveProperty("Authorization");
    expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
  });

  it("normalizes replica URLs and resolves credentials for direct provider callers", async () => {
    vi.stubEnv("CBI_TEST_REPLICA_KEY", "replica-secret");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(response());
    const provider = createEmbeddingProvider(info, { ...replica, baseUrl: " http://replica.test/v1/ ", apiKey: "{env:CBI_TEST_REPLICA_KEY}" }, vi.fn());
    await provider.embedBatch(["a", "b"]);
    expect(fetch.mock.calls[1][0]).toBe("http://replica.test/v1/embeddings");
    expect(fetch.mock.calls[1][1]?.headers).toHaveProperty("Authorization", "Bearer replica-secret");
  });

  it.each([400, 422])("does not hide HTTP %i", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    await expect(makeProvider().embedBatch(["a", "b"])).rejects.toMatchObject({ statusCode: status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["json", "dimensions", "count", "nonfinite"])("does not fail over on an invalid %s response", async (kind) => {
    const data = kind === "json" ? new Response("invalid") : kind === "dimensions" ? response([[1], [2]])
      : kind === "count" ? response([[1, 0]]) : response([[null as unknown as number, 0], [0, 1]]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(data);
    await expect(makeProvider().embedBatch(["a", "b"])).rejects.toBeInstanceOf(ProviderRequestError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(drainCases)("keeps the known HTTP 503 when the %s error body disconnects mid-read", async (_provider, primaryInfo, fallbackConfig, healthy) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(truncatedBody()).mockResolvedValueOnce(healthy());
    const instance = createEmbeddingProvider(primaryInfo, fallbackConfig, vi.fn());
    expect((await instance.embedBatch(["a", "b"])).embeddings).toEqual(vectors);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a per-text Ollama status when the legacy error body disconnects", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(truncatedBody())
      .mockResolvedValueOnce(response());
    const instance = createEmbeddingProvider(ollamaPrimary, replica, vi.fn());
    expect((await instance.embedBatch(["a", "b"])).embeddings).toEqual(vectors);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://primary.test/api/embed", "http://primary.test/api/embeddings", "http://replica.test/v1/embeddings",
    ]);
  });

  it("does not fail over when a successful response body disconnects mid-read", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(truncatedBody(200));
    await expect(makeProvider().embedBatch(["a", "b"])).rejects.toMatchObject({ kind: "malformed_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still recovers per text when a non-eligible Ollama batch body is unreadable", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(truncatedBody(400))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [1, 0] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embedding: [0, 1] })));
    expect((await createEmbeddingProvider(ollamaPrimary, undefined, vi.fn()).embedBatch(["a", "b"])).embeddings)
      .toEqual(vectors);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://primary.test/api/embed", "http://primary.test/api/embeddings", "http://primary.test/api/embeddings",
    ]);
  });

  it("still reaches the replica when an eligible Ollama batch body is unreadable", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(truncatedBody(503)).mockResolvedValueOnce(response());
    expect((await createEmbeddingProvider(ollamaPrimary, replica, vi.fn()).embedBatch(["a", "b"])).embeddings)
      .toEqual(vectors);
    expect(fetch.mock.calls[1][0]).toBe("http://replica.test/v1/embeddings");
  });


  it("retains both sanitized failures and the final retry policy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("primary secret", { status: 503 }))
      .mockResolvedValueOnce(new Response("replica secret", { status: 401 }));
    const failure = await makeProvider().embedBatch(["a", "b"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EmbeddingFallbackError);
    expect(failure).toMatchObject({ primaryError: { statusCode: 503 }, fallbackError: { statusCode: 401 }, retryable: false });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(shouldRetryEmbeddingRequest(failure)).toBe(false);
  });

  it("keeps transient failures retryable when both endpoints are unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const failure = await makeProvider().embedQuery("a").catch((error: unknown) => error);
    expect(shouldRetryEmbeddingRequest(failure)).toBe(true);
  });

  it("waits for the configured request timeout before trying the replica", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response([[1, 0]]));
    const promise = makeProvider().embedQuery("a");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ embedding: [1, 0] });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["primary", "fallback"])("propagates cancellation during the %s without further calls", async (phase) => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, "fetch");
    if (phase === "fallback") fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetch.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort(new OperationCancelledError());
      throw new TypeError("aborted");
    });
    await expect(makeProvider().embedBatch(["a", "b"], { signal: controller.signal })).rejects.toBeInstanceOf(OperationCancelledError);
    expect(fetch).toHaveBeenCalledTimes(phase === "primary" ? 1 : 2);
  });

  it("does not start either server for an already interrupted operation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const signal = AbortSignal.abort(new OperationStallTimeoutError());
    await expect(makeProvider().embedDocument("a", { signal })).rejects.toBeInstanceOf(OperationStallTimeoutError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays a whole split batch and discards partial primary results", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([[9, 9], [9, 9]]))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([[1, 1]]));
    expect((await makeProvider().embedBatch(["a", "b", "c"])).embeddings).toEqual([...vectors, [1, 1]]);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).input)).toEqual([["a", "b"], ["c"], ["a", "b"], ["c"]]);
  });

  it.each(["custom", "ollama", "openai"] as const)("supports the %s fallback protocol with independent authentication", async (provider) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(provider === "ollama" ? new Response(JSON.stringify({ embeddings: vectors })) : response());
    const instance = createEmbeddingProvider(info, { ...replica, provider, apiKey: "replica-secret" }, vi.fn());
    expect((await instance.embedBatch(["a", "b"])).embeddings).toEqual(vectors);
    expect(fetch.mock.calls[1][1]?.headers).toHaveProperty("Authorization", "Bearer replica-secret");
    expect(String(fetch.mock.calls[1][0])).toMatch(provider === "ollama" ? /\/api\/embed$/ : /\/embeddings$/);
  });

  it.each(["legacy endpoint", "context truncation"])("finishes Ollama %s recovery on the primary before considering a replica", async (recovery) => {
    const context = recovery === "context truncation";
    const input = context ? "x".repeat(1000) : "a";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(context ? "context length exceeded" : null, { status: context ? 400 : 404 }));
    if (context) fetch.mockResolvedValueOnce(new Response("context length exceeded", { status: 400 }));
    for (const embedding of vectors) fetch.mockResolvedValueOnce(new Response(JSON.stringify({ embedding })));
    const warn = vi.fn();
    const provider = createEmbeddingProvider({
      provider: "ollama", credentials: { provider: "ollama", baseUrl: "http://primary.test" },
      modelInfo: { provider: "ollama", model: replica.model, dimensions: 2, maxTokens: 8192, costPer1MTokens: 0 },
    }, replica, warn);
    expect((await provider.embedBatch([input, "b"])).embeddings).toEqual(vectors);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://primary.test/api/embed", ...Array(context ? 3 : 2).fill("http://primary.test/api/embeddings"),
    ]);
    if (context) expect(JSON.parse(String(fetch.mock.calls[2][1]?.body)).prompt.length).toBeLessThan(input.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["embedQuery", "embedDocument", "embedBatch"] as const)("preserves Google task semantics through %s", async (method) => {
    const modelInfo = { provider: "google" as const, model: "gemini-embedding-001", dimensions: 2, maxTokens: 8192, costPer1MTokens: 0, taskAble: true };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ embeddings: [{ values: [1, 0] }] })));
    const provider = createEmbeddingProvider({ provider: "google", credentials: { provider: "google", baseUrl: "http://primary.test", apiKey: "primary-secret" }, modelInfo },
      { ...replica, provider: "google", model: modelInfo.model, apiKey: "replica-secret" }, vi.fn());
    if (method === "embedBatch") await provider.embedBatch(["a"]);
    else await provider[method]("a");
    expect(fetch.mock.calls[1][1]?.body).toBe(fetch.mock.calls[0][1]?.body);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).requests[0].taskType).toBe(method === "embedQuery" ? "CODE_RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT");
    expect(fetch.mock.calls[1][1]?.headers).toHaveProperty("x-goog-api-key", "replica-secret");
  });
});

describe("embedding fallback contract and offline startup", () => {
  it.each([
    ["nomic-embed-text", "nomic-embed-text"],
    ["nomic-embed-text:latest", "nomic-embed-text"],
    ["nomic-embed-text", "nomic-embed-text:latest"],
    ["nomic-embed-text:latest", "nomic-embed-text:latest"],
  ])("resolves catalog aliases %s / %s consistently", async (embeddingModel, fallbackModel) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response([Array(768).fill(0.01)]));
    const config = parseConfig({ embeddingProvider: "ollama", embeddingModel,
      embeddingFallback: { ...replica, model: fallbackModel, dimensions: 768 } });
    const primary = await resolveConfiguredEmbeddingProvider(config);
    const provider = createEmbeddingProvider(primary, config.embeddingFallback, vi.fn());
    expect((await provider.embedQuery("alias routing")).embedding).toHaveLength(768);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).model).toBe(fallbackModel);
    expect(provider.getModelInfo().model).toBe("nomic-embed-text");
  });

  it("does not equate arbitrary model names or quantization tags", () => {
    for (const model of ["replica-model:latest", "replica-model:Q4_0"]) {
      expect(() => parseConfig({ embeddingProvider: "ollama", embeddingModel: "replica-model", embeddingFallback: { ...replica, model } })).toThrow(/match/);
    }
    expect(() => parseConfig({ embeddingProvider: "custom", customProvider: { ...primaryConfig, model: "nomic-embed-text" },
      embeddingFallback: { ...replica, model: "nomic-embed-text:latest" } })).toThrow(/match/);
  });

  it("resolves an offline uncatalogued Ollama primary without availability probes", async () => {
    vi.stubEnv("OLLAMA_HOST", "http://offline.test");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const config = parseConfig({ embeddingProvider: "ollama", embeddingModel: "replica-model", embeddingFallback: { ...replica, maxTokens: 8192 } });
    const primary = await resolveConfiguredEmbeddingProvider(config);
    expect(primary).toMatchObject({ provider: "ollama", credentials: { baseUrl: "http://offline.test" }, modelInfo: { model: "replica-model", dimensions: 2, maxTokens: 8192 } });
    expect(fetch).not.toHaveBeenCalled();
    createEmbeddingProvider(primary, config.embeddingFallback, vi.fn());
  });

  it.each(["openai", "google"] as const)("resolves the pinned %s contract without HTTP discovery", async (provider) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const config = parseConfig({ embeddingProvider: provider, embeddingFallback: { ...replica, provider, model: provider === "openai" ? "text-embedding-3-small" : "gemini-embedding-001", dimensions: 1536 } });
    const primary = await resolveConfiguredEmbeddingProvider(config);
    expect(primary.provider).toBe(provider);
    expect(fetch).not.toHaveBeenCalled();
    createEmbeddingProvider(primary, config.embeddingFallback, vi.fn());
  });

  it.each([{ model: "different" }, { dimensions: 3 }, { maxTokens: 10 }, { provider: "google" as const }, { baseUrl: "http://169.254.169.254/v1" }])("rejects incompatible replica %j before requests", (change) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(() => createEmbeddingProvider(info, { ...replica, ...change }, vi.fn())).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
