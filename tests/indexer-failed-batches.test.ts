import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, VectorStore, hashContent } from "../src/native/index.js";
import { formatStatus } from "../src/tools/utils.js";

describe("indexer failed batch recovery", () => {
  let tempDir: string;
  let sourceFile: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let failEmbeddings = false;
  let _indexers: Indexer[] = [];
  let _dbs: Database[] = [];
  let _extraDirs: string[] = [];
  function trackDb(d: Database): Database { _dbs.push(d); return d; }

  beforeEach(() => {
    failEmbeddings = false;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; prompt?: string };

      if (body.prompt) {
        if (body.prompt.includes("triggerFailure") && !body.prompt.includes("Part ")) {
          return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
        }

        return new Response(JSON.stringify({
          embedding: Array.from({ length: 768 }, () => 0.1),
        }), { status: 200 });
      }

      const texts = Array.isArray(body.input) ? body.input : [];

      if (failEmbeddings) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      }

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-batches-indexer-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    sourceFile = path.join(tempDir, "src", "index.ts");
    fs.writeFileSync(
      sourceFile,
      [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return alpha();",
        "}",
      ].join("\n"),
      "utf-8"
    );
  });

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
    _dbs.forEach((d) => d.close());
    _dbs = [];
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const dir of _extraDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    _extraDirs = [];
  });

  function createIndexer(): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      debug: {
        enabled: true,
        logLevel: "warn",
        logSearch: false,
        logEmbedding: false,
        logCache: false,
        logGc: false,
        logBranch: false,
        metrics: false,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
  }

  function createLimitedBatchIndexer(maxBatchSize: number): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
        maxBatchSize,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
  }

  function createOllamaIndexer(): Indexer {
    const config = parseConfig({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
  }

  it("retries saved failed batches on a later successful rerun without force", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    const failedStats = await indexer.index();
    expect(failedStats.failedChunks).toBeGreaterThan(0);

    const failedStatus = await indexer.getStatus();
    expect(failedStatus.indexed).toBe(false);
    expect(failedStatus.failedBatchesCount).toBeGreaterThan(0);

    failEmbeddings = false;
    const recoveredStats = await indexer.index();
    expect(recoveredStats.failedChunks).toBe(0);
    expect(recoveredStats.indexedChunks).toBeGreaterThan(0);

    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(recoveredStatus.failedBatchesCount).toBe(0);
    expect(recoveredStatus.failedBatchesPath).toBeUndefined();
  });

  it("clears stale failed batch warnings after a clean no-op run", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    await indexer.index();

    failEmbeddings = false;
    await indexer.index();

    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.failedBatchesCount).toBe(0);

    const noopStats = await indexer.index();
    expect(noopStats.failedChunks).toBe(0);

    const noopStatus = await indexer.getStatus();
    expect(noopStatus.indexed).toBe(true);
    expect(noopStatus.failedBatchesCount).toBe(0);
    expect(noopStatus.failedBatchesPath).toBeUndefined();
  });

  it("recommends a normal rerun before force rebuilds in failed batch guidance", () => {
    const message = formatStatus({
      indexed: false,
      vectorCount: 0,
      provider: "google",
      model: "gemini-embedding-001",
      indexPath: "/tmp/index",
      currentBranch: "default",
      baseBranch: "default",
      compatibility: null,
      failedBatchesCount: 2,
      failedBatchesPath: "/tmp/index/failed-batches.json",
    });

    expect(message).toContain("rerun index_codebase normally");
    expect(message).toContain("retry the saved failed batches");
    expect(message).toContain("Use force=true only for a full rebuild or compatibility reset");
  });

  it("isolates ollama embedding failures to the offending chunk", async () => {
    const safeFile = path.join(tempDir, "src", "safe.ts");
    fs.writeFileSync(safeFile, "export function safeChunk() { return 'ok'; }\n", "utf-8");

    fs.writeFileSync(
      sourceFile,
      [
        "export const alpha = 'alpha';",
        "export const beta = 'beta';",
        "export const gamma = 'gamma';",
        "export const delta = 'delta';",
        "export const epsilon = 'epsilon';",
        "export const zeta = 'zeta';",
        "export const eta = 'eta';",
        "export const theta = 'theta';",
        "export const triggerFailure = 'triggerFailure';",
        "export const iota = 'iota';",
        "export const kappa = 'kappa';",
        "export const lambda = 'lambda';",
        "export const mu = 'mu';",
        "export const nu = 'nu';",
        "export const xi = 'xi';",
        "export const omicron = 'omicron';",
        "export const pi = 'pi';",
        "export const rho = 'rho';",
        "export const sigma = 'sigma';",
        "export const tau = 'tau';",
        "export const upsilon = 'upsilon';",
        "export const phi = 'phi';",
        "export const chi = 'chi';",
        "export const psi = 'psi';",
        "export const omega = 'omega';",
        "export const stillWorks = 'stillWorks';",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createOllamaIndexer();
    const stats = await indexer.index();

    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(stats.failedChunks).toBeGreaterThan(0);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBeGreaterThan(0);
  });

  it("splits oversized ollama chunks into pooled sub-requests before embedding", async () => {
    const embedPrompts: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = body.prompt ?? "";
      embedPrompts.push(prompt);

      if (prompt.length > 8200) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      const seed = prompt.length % 17;
      return new Response(JSON.stringify({
        embedding: Array.from({ length: 768 }, (_, idx) => seed + idx / 1000),
      }), { status: 200 });
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function oversizedChunk() {",
        `  const blob = ${JSON.stringify("triggerFailure ".repeat(900))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createOllamaIndexer();
    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(embedPrompts.length).toBeGreaterThan(1);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 1/"))).toBe(true);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 2/"))).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("recovers split ollama chunks when provider retries need extra truncation below the estimated limit", async () => {
    const embedPrompts: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = body.prompt ?? "";
      embedPrompts.push(prompt);

      if (prompt.length > 6000) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      const seed = prompt.length % 19;
      return new Response(JSON.stringify({
        embedding: Array.from({ length: 768 }, (_, idx) => seed + idx / 1000),
      }), { status: 200 });
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function denseOversizedChunk() {",
        `  const blob = ${JSON.stringify("dense<>symbols{}[]() ".repeat(1400))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createOllamaIndexer();
    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(embedPrompts.length).toBeGreaterThan(1);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 1/"))).toBe(true);
    expect(embedPrompts.some((prompt, idx) => idx > 0 && prompt.length < embedPrompts[0]!.length)).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("rebuilds legacy failed-batch prompts with the current split strategy", async () => {
    const indexer = createOllamaIndexer();
    await indexer.initialize();

    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    fs.mkdirSync(path.dirname(failedBatchesPath), { recursive: true });
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
        {
          chunks: [
            {
              id: "legacy-oversized",
              text: "triggerFailure legacy prompt",
              content: "triggerFailure ".repeat(900),
              contentHash: "legacy-hash",
              metadata: {
                filePath: sourceFile,
                startLine: 1,
                endLine: 1,
                language: "typescript",
                chunkType: "function",
                hash: "legacy-hash",
                name: "legacyOversized",
              },
            },
          ],
          error: "legacy oversize failure",
          attemptCount: 1,
          lastAttempt: new Date().toISOString(),
        },
      ], null, 2),
      "utf-8"
    );

    const embedPrompts: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = body.prompt ?? "";
      embedPrompts.push(prompt);

      if (prompt.includes("triggerFailure") && !prompt.includes("Part ")) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      return new Response(JSON.stringify({
        embedding: Array.from({ length: 768 }, () => 0.1),
      }), { status: 200 });
    });

    const retry = await indexer.retryFailedBatches();

    expect(retry.failed).toBe(0);
    expect(retry.remaining).toBe(0);
    expect(retry.succeeded).toBe(1);
    expect(embedPrompts.length).toBeGreaterThan(1);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 1/"))).toBe(true);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 2/"))).toBe(true);
  });

  it("rebuilds retryable legacy failed-batch prompts with the provider-aware split budget", async () => {
    const indexer = createOllamaIndexer();
    await indexer.initialize();

    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    fs.mkdirSync(path.dirname(failedBatchesPath), { recursive: true });
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
        {
          chunks: [
            {
              id: "legacy-retryable",
              text: "triggerFailure legacy retryable prompt",
              content: "triggerFailure ".repeat(900),
              contentHash: "legacy-retryable-hash",
              metadata: {
                filePath: sourceFile,
                startLine: 1,
                endLine: 1,
                language: "typescript",
                chunkType: "function",
                hash: "legacy-retryable-hash",
                name: "legacyRetryable",
              },
            },
          ],
          error: "legacy retryable oversize failure",
          attemptCount: 1,
          lastAttempt: new Date().toISOString(),
        },
      ], null, 2),
      "utf-8"
    );

    fs.writeFileSync(
      sourceFile,
      [
        "export function legacyRetryable() {",
        `  return ${JSON.stringify("triggerFailure ".repeat(900))};`,
        "}",
      ].join("\n"),
      "utf-8"
    );

    const embedPrompts: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = body.prompt ?? "";
      embedPrompts.push(prompt);

      if (prompt.includes("triggerFailure") && !prompt.includes("Part ")) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      return new Response(JSON.stringify({
        embedding: Array.from({ length: 768 }, () => 0.1),
      }), { status: 200 });
    });

    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(embedPrompts.length).toBeGreaterThan(1);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 1/"))).toBe(true);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 2/"))).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("pools split custom-provider chunks across multiple embedBatch calls", async () => {
    const requestSizes: number[] = [];
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      requestSizes.push(texts.length);

      const data = texts.map((text, textIndex) => {
        const seed = (text.length + textIndex) % 23;
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => seed + idx / 100),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function oversizedCustomChunk() {",
        `  const blob = ${JSON.stringify("segment ".repeat(1500))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createLimitedBatchIndexer(1);
    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBe(1);
    expect(requestSizes.length).toBeGreaterThan(1);
    expect(requestSizes.every((size) => size <= 1)).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("waits for all split parts before pooling when custom-provider calls complete out of order", async () => {
    let callCount = 0;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const currentCall = callCount++;

      if (currentCall === 0) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      const data = texts.map((text, textIndex) => {
        const seed = (text.length + textIndex + currentCall) % 31;
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => seed + idx / 100),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function outOfOrderSplitChunk() {",
        `  const blob = ${JSON.stringify("out-of-order ".repeat(1500))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createLimitedBatchIndexer(1);
    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBe(1);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("retries split custom-provider failed batches across multiple embedBatch calls", async () => {
    let firstChunkAttempt = true;
    const requestSizes: number[] = [];
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      requestSizes.push(texts.length);

      if (firstChunkAttempt && texts.some((text) => text.includes("Part 1/"))) {
        firstChunkAttempt = false;
        return new Response(JSON.stringify({ error: "transient batch failure" }), { status: 500 });
      }

      const data = texts.map((text, textIndex) => {
        const seed = (text.length + textIndex) % 29;
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => seed + idx / 100),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function retryableSplitChunk() {",
        `  const blob = ${JSON.stringify("retryable ".repeat(1400))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createLimitedBatchIndexer(1);
    const failedStats = await indexer.index();

    expect(failedStats.failedChunks).toBe(1);
    expect(failedStats.indexedChunks).toBe(0);

    const retry = await indexer.retryFailedBatches();

    expect(retry.failed).toBe(0);
    expect(retry.remaining).toBe(0);
    expect(retry.succeeded).toBe(1);
    expect(requestSizes.length).toBeGreaterThan(1);
    expect(requestSizes.every((size) => size <= 1)).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("waits for all split retry parts before pooling when retry calls complete out of order", async () => {
    let firstChunkAttempt = true;
    let callCount = 0;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const currentCall = callCount++;

      if (firstChunkAttempt && texts.some((text) => text.includes("Part 1/"))) {
        firstChunkAttempt = false;
        return new Response(JSON.stringify({ error: "transient batch failure" }), { status: 500 });
      }

      if (currentCall % 2 === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      const data = texts.map((text, textIndex) => {
        const seed = (text.length + textIndex + currentCall) % 41;
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => seed + idx / 100),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function outOfOrderRetrySplitChunk() {",
        `  const blob = ${JSON.stringify("retry-out-of-order ".repeat(1400))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createLimitedBatchIndexer(1);
    const failedStats = await indexer.index();

    expect(failedStats.failedChunks).toBe(1);
    expect(failedStats.indexedChunks).toBe(0);

    const retry = await indexer.retryFailedBatches();

    expect(retry.failed).toBe(0);
    expect(retry.remaining).toBe(0);
    expect(retry.succeeded).toBe(1);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });

  it("deduplicates repeated retry failures for the same split chunk", async () => {
    const requestSizes: number[] = [];
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      requestSizes.push(texts.length);

      return new Response(JSON.stringify({ error: "persistent split failure" }), { status: 500 });
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function persistentlyFailingSplitChunk() {",
        `  const blob = ${JSON.stringify("persistent ".repeat(1400))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createLimitedBatchIndexer(1);
    const failedStats = await indexer.index();

    expect(failedStats.failedChunks).toBe(1);
    expect(failedStats.indexedChunks).toBe(0);

    const retry = await indexer.retryFailedBatches();

    expect(retry.succeeded).toBe(0);
    expect(retry.failed).toBe(1);
    expect(retry.remaining).toBe(1);
    expect(requestSizes.length).toBeGreaterThan(1);
    expect(requestSizes.every((size) => size <= 1)).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(1);
  });

  it("increments attemptCount when the same split chunk fails multiple times in one index run", async () => {
    const embedPrompts: string[] = [];
    fetchSpy.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = body.prompt ?? "";
      embedPrompts.push(prompt);

      if (prompt.includes("same-run-failure")) {
        return new Response(JSON.stringify({ error: "persistent split failure" }), { status: 500 });
      }

      return new Response(JSON.stringify({
        embedding: Array.from({ length: 768 }, () => 0.1),
      }), { status: 200 });
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function persistentlyFailingSameRunSplitChunk() {",
        `  const blob = ${JSON.stringify("same-run-failure ".repeat(900))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createOllamaIndexer();
    const failedStats = await indexer.index();

    expect(failedStats.failedChunks).toBe(1);
    expect(failedStats.indexedChunks).toBe(0);
    expect(embedPrompts.length).toBeGreaterThan(1);
    expect(embedPrompts.every((prompt) => prompt.includes("Part "))).toBe(true);

    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
      chunks: Array<{ id: string }>;
      attemptCount: number;
      error: string;
    }>;

    expect(persistedBatches).toHaveLength(1);
    expect(persistedBatches[0]?.chunks[0]?.id).toBeDefined();
    expect(persistedBatches[0]?.attemptCount).toBeGreaterThan(1);
    expect(persistedBatches[0]?.error).toContain("persistent split failure");
  });

  it("persists failed batches when storage fails after pooling embeddings", async () => {
    const addBatchSpy = vi.spyOn(VectorStore.prototype, "addBatch").mockImplementation(() => {
      throw new Error("vector store write failed");
    });

    try {
      const indexer = createIndexer();
      const failedStats = await indexer.index();

      expect(failedStats.failedChunks).toBe(1);
      expect(failedStats.indexedChunks).toBe(0);

      const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
      const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
        chunks: Array<{ id: string }>;
        error: string;
        attemptCount: number;
      }>;

      expect(persistedBatches).toHaveLength(1);
      expect(persistedBatches.every((batch) => batch.error.includes("vector store write failed"))).toBe(true);
      expect(persistedBatches.every((batch) => batch.attemptCount === 1)).toBe(true);

      const status = await indexer.getStatus();
      expect(status.failedBatchesCount).toBe(1);
    } finally {
      addBatchSpy.mockRestore();
    }
  });

  it("does not double-count mixed request failures and storage failures during retry", async () => {
    let firstRetryRun = true;
    const addBatchSpy = vi.spyOn(VectorStore.prototype, "addBatch").mockImplementation(() => {
      if (firstRetryRun) {
        throw new Error("vector store write failed");
      }
    });

    try {
      fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
        const texts = Array.isArray(body.input) ? body.input : [];

        if (firstRetryRun && texts.some((text) => text.includes("Part 1/"))) {
          return new Response(JSON.stringify({ error: "transient batch failure" }), { status: 500 });
        }

        const data = texts.map((text, textIndex) => {
          const seed = (text.length + textIndex) % 37;
          return {
            embedding: Array.from({ length: 8 }, (_, idx) => seed + idx / 100),
          };
        });

        return new Response(
          JSON.stringify({
            data,
            usage: { total_tokens: Math.max(1, texts.length * 8) },
          }),
          { status: 200 }
        );
      });

      fs.writeFileSync(
        sourceFile,
        [
          "export function mixedRetryFailureChunk() {",
          `  const blob = ${JSON.stringify("retry-mixed ".repeat(1400))};`,
          "  return blob.length;",
          "}",
        ].join("\n"),
        "utf-8"
      );

      const indexer = createLimitedBatchIndexer(1);
      const failedStats = await indexer.index();

      expect(failedStats.failedChunks).toBe(1);
      expect(failedStats.indexedChunks).toBe(0);

      const retry = await indexer.retryFailedBatches();
      firstRetryRun = false;

      expect(retry.succeeded).toBe(0);
      expect(retry.failed).toBe(1);
      expect(retry.remaining).toBe(1);

      const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
      const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
        chunks: Array<{ id: string }>;
        error: string;
        attemptCount: number;
      }>;

      expect(persistedBatches).toHaveLength(1);
      expect(persistedBatches[0]?.attemptCount).toBe(2);
      expect(persistedBatches[0]?.error).toContain("transient batch failure");
    } finally {
      addBatchSpy.mockRestore();
    }
  });

  it("keeps a retried chunk in failed batches when storage fails after pooling", async () => {
    let failStorageOnRetry = false;
    const addBatchSpy = vi.spyOn(VectorStore.prototype, "addBatch").mockImplementation(() => {
      if (failStorageOnRetry) {
        throw new Error("vector store write failed");
      }
    });

    try {
      const indexer = createIndexer();
      const failedStats = await indexer.index();

      expect(failedStats.failedChunks).toBe(0);
      expect(failedStats.indexedChunks).toBeGreaterThan(0);

      const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
      fs.writeFileSync(
        failedBatchesPath,
        JSON.stringify([
          {
            chunks: [
              {
                id: "chunk_abc123",
                text: "export function alpha() { return 'alpha'; }",
                content: "export function alpha() { return 'alpha'; }",
                contentHash: "retry-hash",
                metadata: {
                  filePath: sourceFile,
                  startLine: 1,
                  endLine: 3,
                  language: "typescript",
                  chunkType: "function",
                  hash: "retry-hash",
                  name: "alpha",
                },
              },
            ],
            error: "previous failure",
            attemptCount: 1,
            lastAttempt: new Date().toISOString(),
          },
        ], null, 2),
        "utf-8"
      );

      failStorageOnRetry = true;
      const retry = await indexer.retryFailedBatches();

      expect(retry.succeeded).toBe(0);
      expect(retry.failed).toBe(1);
      expect(retry.remaining).toBe(1);

      const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
        chunks: Array<{ id: string }>;
        error: string;
        attemptCount: number;
      }>;

      expect(persistedBatches).toHaveLength(1);
      expect(persistedBatches[0]?.chunks[0]?.id).toBe("chunk_abc123");
      expect(persistedBatches[0]?.error).toContain("vector store write failed");
      expect(persistedBatches[0]?.attemptCount).toBe(2);
    } finally {
      addBatchSpy.mockRestore();
    }
  });

  it("coalesces same-run failed chunks back into one persisted failed batch", async () => {
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      if (texts.length > 0) {
        return new Response(JSON.stringify({ error: "shared batch failure" }), { status: 500 });
      }

      return new Response(
        JSON.stringify({
          data: [],
          usage: { total_tokens: 0 },
        }),
        { status: 200 }
      );
    });

    const secondFile = path.join(tempDir, "src", "second.ts");
    fs.writeFileSync(
      sourceFile,
      [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return alpha();",
        "}",
      ].join("\n"),
      "utf-8"
    );
    fs.writeFileSync(
      secondFile,
      [
        "export function gamma() {",
        "  return 'gamma';",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createIndexer();
    const failedStats = await indexer.index();

    expect(failedStats.failedChunks).toBe(2);
    expect(failedStats.indexedChunks).toBe(0);

    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
      chunks: Array<{ id: string }>;
      error: string;
      attemptCount: number;
    }>;

    expect(persistedBatches).toHaveLength(1);
    expect(persistedBatches[0]?.chunks).toHaveLength(2);
    expect(persistedBatches[0]?.error).toContain("shared batch failure");
    expect(persistedBatches[0]?.attemptCount).toBe(1);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(1);
  });

  it("reports remaining failed batches using the coalesced persisted count", async () => {
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      if (texts.length > 0) {
        return new Response(JSON.stringify({ error: "shared retry failure" }), { status: 500 });
      }

      return new Response(
        JSON.stringify({
          data: [],
          usage: { total_tokens: 0 },
        }),
        { status: 200 }
      );
    });

    const secondFile = path.join(tempDir, "src", "retry-second.ts");
    fs.writeFileSync(sourceFile, "export function alpha() { return 'alpha'; }\n", "utf-8");
    fs.writeFileSync(secondFile, "export function beta() { return 'beta'; }\n", "utf-8");

    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    fs.mkdirSync(path.dirname(failedBatchesPath), { recursive: true });
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
        {
          chunks: [
            {
              id: "chunk_alpha",
              text: "export function alpha() { return 'alpha'; }",
              content: "export function alpha() { return 'alpha'; }",
              contentHash: "retry-alpha-hash",
              metadata: {
                filePath: sourceFile,
                startLine: 1,
                endLine: 1,
                language: "typescript",
                chunkType: "function",
                hash: "retry-alpha-hash",
                name: "alpha",
              },
            },
            {
              id: "chunk_beta",
              text: "export function beta() { return 'beta'; }",
              content: "export function beta() { return 'beta'; }",
              contentHash: "retry-beta-hash",
              metadata: {
                filePath: secondFile,
                startLine: 1,
                endLine: 1,
                language: "typescript",
                chunkType: "function",
                hash: "retry-beta-hash",
                name: "beta",
              },
            },
          ],
          error: "previous grouped failure",
          attemptCount: 1,
          lastAttempt: new Date().toISOString(),
        },
      ], null, 2),
      "utf-8"
    );

    const indexer = createIndexer();
    await indexer.initialize();

    const retry = await indexer.retryFailedBatches();
    const status = await indexer.getStatus();
    const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
      chunks: Array<{ id: string }>;
      error: string;
      attemptCount: number;
    }>;

    expect(retry.succeeded).toBe(0);
    expect(retry.failed).toBe(2);
    expect(retry.remaining).toBe(1);
    expect(status.failedBatchesCount).toBe(1);
    expect(persistedBatches).toHaveLength(1);
    expect(persistedBatches[0]?.chunks).toHaveLength(2);
    expect(persistedBatches[0]?.error).toContain("shared retry failure");
  });

  it("preserves foreign legacy failed batches without rewriting them during global scoped saves", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "failed-batches-global-home-"));
    _extraDirs.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    const globalFailedBatchesPath = path.join(tempHome, ".opencode", "global-index", "failed-batches.json");
    fs.mkdirSync(path.dirname(globalFailedBatchesPath), { recursive: true });
    fs.writeFileSync(
      globalFailedBatchesPath,
      JSON.stringify([
        {
          chunks: [
            {
              id: "foreign-legacy",
              text: "triggerFailure foreign legacy prompt",
              content: "triggerFailure ".repeat(900),
              contentHash: "foreign-legacy-hash",
              metadata: {
                filePath: projectBFile,
                startLine: 1,
                endLine: 1,
                language: "typescript",
                chunkType: "function",
                hash: "foreign-legacy-hash",
                name: "foreignLegacy",
              },
            },
          ],
          error: "foreign legacy oversize failure",
          attemptCount: 1,
          lastAttempt: new Date().toISOString(),
        },
      ], null, 2),
      "utf-8"
    );

    const indexer = _indexers[_indexers.push(new Indexer(projectA, parseConfig({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      scope: "global",
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    }))) - 1];

    const stats = await indexer.index();
    expect(stats.failedChunks).toBe(0);

    const persistedBatches = JSON.parse(fs.readFileSync(globalFailedBatchesPath, "utf-8")) as Array<{
      chunks: Array<{ metadata: { filePath: string }; text?: string; texts?: unknown[] }>;
    }>;
    const foreignChunk = persistedBatches
      .flatMap((batch) => batch.chunks)
      .find((chunk) => chunk.metadata.filePath === projectBFile);

    expect(foreignChunk).toBeDefined();
    expect(typeof foreignChunk?.text).toBe("string");
    expect(foreignChunk?.texts).toBeUndefined();
  });

  it("logs a warning when persisted failed batches are malformed", async () => {
    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    fs.mkdirSync(path.dirname(failedBatchesPath), { recursive: true });
    fs.writeFileSync(failedBatchesPath, "{", "utf-8");
    const indexer = createIndexer();
    await indexer.initialize();
    await indexer.getStatus();

    const logs = indexer.getLogger().getLogs().filter((entry) => entry.level === "warn");
    expect(logs.some((entry) =>
      entry.message === "Failed to load failed batch state, skipping persisted retries"
      && entry.data?.failedBatchesPath === failedBatchesPath
    )).toBe(true);
  });

  it("does not retry custom-provider non-retryable errors during retryFailedBatches()", async () => {
    let embedCallCount = 0;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      if (Array.isArray(body.input)) {
        embedCallCount += 1;
      }

      return new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 });
    });

    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    fs.mkdirSync(path.dirname(failedBatchesPath), { recursive: true });
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
        {
          chunks: [
            {
              id: "non-retryable-custom-provider-chunk",
              text: "export function alpha() { return 'alpha'; }",
              content: "export function alpha() { return 'alpha'; }",
              contentHash: "non-retryable-custom-provider-hash",
              metadata: {
                filePath: sourceFile,
                startLine: 1,
                endLine: 1,
                language: "typescript",
                chunkType: "function",
                hash: "non-retryable-custom-provider-hash",
                name: "alpha",
              },
            },
          ],
          error: "previous custom provider failure",
          attemptCount: 1,
          lastAttempt: new Date().toISOString(),
        },
      ], null, 2),
      "utf-8"
    );

    const retryingIndexer = _indexers[_indexers.push(new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        retries: 3,
        retryDelayMs: 1,
      },
    }))) - 1];

    await retryingIndexer.initialize();
    const retry = await retryingIndexer.retryFailedBatches();

    expect(embedCallCount).toBe(1);
    expect(retry.succeeded).toBe(0);
    expect(retry.failed).toBe(1);
    expect(retry.remaining).toBe(1);

    const persistedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
      attemptCount: number;
      error: string;
    }>;
    expect(persistedBatches[0]?.attemptCount).toBe(2);
    expect(persistedBatches[0]?.error).toContain("invalid api key");
  });

  it("clears pending global force re-embed metadata after retryFailedBatches() recovers all remaining chunks", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "failed-batches-force-reembed-home-"));
    _extraDirs.push(tempHome);
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const kbDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const kbFile = path.join(kbDir, "docs", "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(kbFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const kbPrompt = "export function sharedDoc() { return 'shared'; }";
    let failSharedKbEmbedding = false;
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      if (failSharedKbEmbedding && texts.some((text) => text.includes(kbPrompt))) {
        return new Response(JSON.stringify({ error: "simulated shared kb failure" }), { status: 500 });
      }

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    const createGlobalKbIndexer = (projectRoot: string) => {
      const idx = new Indexer(projectRoot, parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-8d",
          dimensions: 8,
        },
        scope: "global",
        knowledgeBases: [kbDir],
        indexing: {
          watchFiles: false,
          retries: 0,
          retryDelayMs: 1,
        },
      }));
      _indexers.push(idx);
      return idx;
    };

    await createGlobalKbIndexer(projectA).index();
    await createGlobalKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const projectABranch = `${projectHash}:default`;
    db.setMetadata(`index.embeddingStrategyVersion.${projectHash}`, "1");

    const resettingIndexer = createGlobalKbIndexer(projectA);
    await resettingIndexer.clearIndex();

    failSharedKbEmbedding = true;
    const failedStats = await resettingIndexer.index();
    expect(failedStats.failedChunks).toBeGreaterThan(0);
    expect(db.getMetadata(`index.forceReembed.${projectHash}`)).toBe("true");

    const sharedChunkId = db.getChunksByFile(kbFile)[0]?.chunkId;
    expect(sharedChunkId).toBeTruthy();
    expect(db.chunkExistsOnBranch(projectABranch, sharedChunkId!)).toBe(false);

    failSharedKbEmbedding = false;
    const retryingIndexer = createGlobalKbIndexer(projectA);
    const retry = await retryingIndexer.retryFailedBatches();

    expect(retry.failed).toBe(0);
    expect(retry.remaining).toBe(0);
    expect(retry.succeeded).toBeGreaterThan(0);
    expect(db.getMetadata(`index.forceReembed.${projectHash}`)).toBeNull();
    expect(db.chunkExistsOnBranch(projectABranch, sharedChunkId!)).toBe(true);
  });

  it("preserves previously indexed chunk in branch catalog when stale failed-batch retry fails", async () => {
    const indexer = createIndexer();

    // Step 1: Initial successful index
    const initialStats = await indexer.index();
    expect(initialStats.failedChunks).toBe(0);
    expect(initialStats.indexedChunks).toBeGreaterThan(0);

    // Step 2: Capture the actual indexed chunk id from the database
    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const dbBefore = trackDb(new Database(dbPath));
    const branches = dbBefore.getAllBranches();
    const branchKey = branches.find((b) => b.includes("default")) || branches[0];
    expect(branchKey).toBeDefined();

    const branchChunksBefore = dbBefore.getBranchChunkIds(branchKey!);
    expect(branchChunksBefore.length).toBeGreaterThan(0);
    const existingChunkId = branchChunksBefore[0];
    expect(existingChunkId).toBeDefined();

    // Step 3: Manually write a stale failed-batch entry for that same unchanged chunk
    const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
        {
          chunks: [
            {
              id: existingChunkId,
              text: "export function alpha() { return 'alpha'; }",
              content: "export function alpha() { return 'alpha'; }",
              contentHash: "stale-hash",
              metadata: {
                filePath: sourceFile,
                startLine: 1,
                endLine: 3,
                language: "typescript",
                chunkType: "function",
                hash: "stale-hash",
                name: "alpha",
              },
            },
          ],
          error: "stale previous failure",
          attemptCount: 1,
          lastAttempt: new Date().toISOString(),
        },
      ], null, 2),
      "utf-8"
    );

    // Step 4: Make the later index() rerun fail embedding for that retryable chunk
    failEmbeddings = true;
    const retryStats = await indexer.index();

    // Step 5: Assert the failed batch persists AND the branch catalog still contains that chunk id
    expect(retryStats.failedChunks).toBeGreaterThan(0);

    const failedBatchesAfter = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
      chunks: Array<{ id: string }>;
      error: string;
    }>;
    expect(failedBatchesAfter.length).toBeGreaterThan(0);
    expect(failedBatchesAfter.some((batch) => batch.chunks.some((c) => c.id === existingChunkId))).toBe(true);

    const dbAfter = trackDb(new Database(dbPath));
    const branchChunksAfter = dbAfter.getBranchChunkIds(branchKey!);
    expect(branchChunksAfter).toContain(existingChunkId);
  });

  it("restores recovered chunks to the branch catalog during retryFailedBatches()", async () => {
    failEmbeddings = true;
    const initialIndexer = createIndexer();
    const failedStats = await initialIndexer.index();
    expect(failedStats.failedChunks).toBeGreaterThan(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const dbBefore = trackDb(new Database(dbPath));
    const branchKey = "default";
    expect(dbBefore.getBranchChunkIds(branchKey)).toHaveLength(0);

    failEmbeddings = false;
    const retryIndexer = createIndexer();
    const retry = await retryIndexer.retryFailedBatches();

    expect(retry.failed).toBe(0);
    expect(retry.remaining).toBe(0);
    expect(retry.succeeded).toBeGreaterThan(0);

    const dbAfter = trackDb(new Database(dbPath));
    const branchChunksAfter = dbAfter.getBranchChunkIds(branchKey);
    expect(branchChunksAfter.length).toBe(retry.succeeded);
    for (const chunkId of branchChunksAfter) {
      expect(dbAfter.getChunk(chunkId)).not.toBeNull();
    }
  });

  it("rolls back vectors and excludes failed chunks from branch when database upsert fails during index()", async () => {
    const originalUpsert = Database.prototype.upsertEmbeddingsBatch;
    let callCount = 0;
    const removeSpy = vi.spyOn(VectorStore.prototype, "remove").mockImplementation(() => {
      throw new Error("native remove should not be called during index rollback");
    });

    try {
      vi.spyOn(Database.prototype, "upsertEmbeddingsBatch").mockImplementation(
        function (
          this: Database,
          items: Array<{ contentHash: string; embedding: Buffer; chunkText: string; model: string }>
        ) {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("database write failed");
          }
          return originalUpsert.call(this, items);
        }
      );

      const indexer = createIndexer();
      const stats = await indexer.index();

      expect(stats.failedChunks).toBeGreaterThan(0);
      expect(stats.indexedChunks).toBe(0);
      expect(removeSpy).not.toHaveBeenCalled();

      const status = await indexer.getStatus();
      expect(status.indexed).toBe(false);
      expect(status.failedBatchesCount).toBeGreaterThan(0);

      const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
      const dbAfter = trackDb(new Database(dbPath));
      const branches = dbAfter.getAllBranches();
      const branchKey = branches.find((b) => b.includes("default")) || branches[0];
      if (branchKey) {
        const branchChunks = dbAfter.getBranchChunkIds(branchKey);
        expect(branchChunks.length).toBe(0);
      }

      const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
      if (fs.existsSync(failedBatchesPath)) {
        const failedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
          error: string;
        }>;
        expect(failedBatches.length).toBeGreaterThan(0);
        expect(failedBatches[0]?.error).toContain("database write failed");
      }
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("rolls back vectors and excludes failed chunks from branch when database upsert fails during retryFailedBatches()", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    await indexer.index();

    failEmbeddings = false;

    const originalUpsert = Database.prototype.upsertEmbeddingsBatch;
    let callCount = 0;
    const removeSpy = vi.spyOn(VectorStore.prototype, "remove").mockImplementation(() => {
      throw new Error("native remove should not be called during retry rollback");
    });

    try {
      vi.spyOn(Database.prototype, "upsertEmbeddingsBatch").mockImplementation(
        function (
          this: Database,
          items: Array<{ contentHash: string; embedding: Buffer; chunkText: string; model: string }>
        ) {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("database write failed during retry");
          }
          return originalUpsert.call(this, items);
        }
      );

      const retry = await indexer.retryFailedBatches();

      expect(retry.succeeded).toBe(0);
      expect(retry.failed).toBeGreaterThan(0);
      expect(removeSpy).not.toHaveBeenCalled();

      const status = await indexer.getStatus();
      expect(status.failedBatchesCount).toBeGreaterThan(0);

      const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
      const dbAfter = trackDb(new Database(dbPath));
      const branches = dbAfter.getAllBranches();
      const branchKey = branches.find((b) => b.includes("default")) || branches[0];
      if (branchKey) {
        const branchChunks = dbAfter.getBranchChunkIds(branchKey);
        expect(branchChunks.length).toBe(0);
      }

      const failedBatchesPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
      if (fs.existsSync(failedBatchesPath)) {
        const failedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{
          error: string;
        }>;
        expect(failedBatches.length).toBeGreaterThan(0);
        expect(failedBatches[0]?.error).toContain("database write failed during retry");
      }
    } finally {
      removeSpy.mockRestore();
    }
  });
});
