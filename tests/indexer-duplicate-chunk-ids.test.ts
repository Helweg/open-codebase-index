import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import PQueue from "p-queue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import type { ConfiguredProviderInfo } from "../src/embeddings/detector.js";
import type { EmbeddingProviderInterface } from "../src/embeddings/provider.js";
import { createFailedBatchWriter } from "../src/indexer/failed-state-persistence.js";
import type { PendingChunk } from "../src/indexer/embedding-batches.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, InvertedIndex, VectorStore } from "../src/native/index.js";

describe("duplicate chunk ID indexing", () => {
  let tempDir: string;
  let database: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "duplicate-chunk-ids-"));
    database = new Database(path.join(tempDir, "codebase.db"));
  });

  afterEach(() => {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("publishes only the last duplicate occurrence", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "duplicate-id-test-model",
        dimensions: 3,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });
    const indexer = new Indexer(tempDir, config, "opencode", {
      indexPath: path.join(tempDir, "index"),
    });
    const storePath = path.join(tempDir, "vectors");
    const store = new VectorStore(storePath, 3);
    const addBatch = vi.spyOn(store, "addBatch");
    const invertedIndex = new InvertedIndex(path.join(tempDir, "inverted.json"));
    const embedBatch = vi.fn(async (texts: string[]) => ({
      embeddings: texts.map(() => [0.1, 0.2, 0.3]),
      totalTokensUsed: texts.length,
    }));
    const provider: EmbeddingProviderInterface = {
      embedQuery: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      embedDocument: async () => ({ embedding: [0.1, 0.2, 0.3], tokensUsed: 1 }),
      embedBatch,
      getModelInfo: () => ({
        model: "duplicate-id-test-model",
        dimensions: 3,
        maxTokens: 8192,
        costPer1MTokens: 0,
      }),
    };
    const configuredProviderInfo = {
      provider: "custom",
      credentials: { provider: "custom", baseUrl: "http://localhost:11434/v1" },
      modelInfo: {
        provider: "custom",
        model: "duplicate-id-test-model",
        dimensions: 3,
        maxTokens: 8192,
        costPer1MTokens: 0,
        timeoutMs: 1_000,
      },
    } satisfies ConfiguredProviderInfo;
    const pendingChunk = (chunkType: string, name: string): PendingChunk => ({
      id: "duplicate-id",
      texts: [{ text: `embedding for ${name}`, tokenCount: 3 }],
      storageText: `embedding for ${name}`,
      content: "same source content",
      contentHash: "same-content-hash",
      metadata: {
        filePath: "src/Duplicate.swift",
        startLine: 90,
        endLine: 101,
        chunkType,
        name,
        language: "swift",
        hash: "same-content-hash",
      },
    });
    const failedWriter = createFailedBatchWriter(path.join(tempDir, "failed-batches.json"));
    const processPendingChunkBatch = indexer as unknown as {
      processPendingChunkBatch(
        chunks: PendingChunk[],
        options: Record<string, unknown>,
      ): Promise<{ indexedChunks: number; failedChunks: number }>;
    };

    try {
      const result = await processPendingChunkBatch.processPendingChunkBatch([
        pendingChunk("enum_declaration", "LargeContainer"),
        pendingChunk("method_declaration", "nestedMethod"),
      ], {
        store,
        provider,
        invertedIndex,
        database,
        configuredProviderInfo,
        queue: new PQueue({ concurrency: 1 }),
        providerRateLimits: { concurrency: 1, intervalMs: 0, minRetryMs: 1, maxRetryMs: 1 },
        rateLimitState: { backoffMs: 0 },
        failedState: { writer: failedWriter, recordsWritten: 0 },
        attemptCounts: new Map<string, number>(),
        forceReembed: false,
        reuseCachedEmbeddings: false,
        incrementRepeatedFailures: true,
      });

      expect(embedBatch).toHaveBeenCalledTimes(1);
      expect(embedBatch.mock.calls[0]?.[0]).toEqual(["embedding for nestedMethod"]);
      expect(addBatch).toHaveBeenCalledTimes(1);
      expect(addBatch.mock.calls[0]?.[0]).toHaveLength(1);
      expect(result).toMatchObject({ indexedChunks: 1, failedChunks: 0 });
      expect(store.count()).toBe(1);
      expect(store.getMetadata("duplicate-id")?.name).toBe("nestedMethod");

      store.save();
      const reloadedStore = new VectorStore(storePath, 3);
      reloadedStore.load();
      expect(reloadedStore.count()).toBe(1);
      expect(reloadedStore.getMetadata("duplicate-id")?.chunkType).toBe("method_declaration");
    } finally {
      failedWriter.cleanup();
      await indexer.close();
    }
  });
});
