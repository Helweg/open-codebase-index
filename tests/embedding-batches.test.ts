import type { ChunkMetadata } from "../src/native/index.js";

import {
  coalesceFailedBatches,
  createPendingChunkStorageText,
  createPendingEmbeddingRequestBatches,
  createPendingEmbeddingRequests,
  getPendingChunkFilePath,
  getUniquePendingChunksFromRequests,
  hasAllEmbeddingParts,
  normalizeFailedBatch,
  normalizePendingChunk,
  poolEmbeddingVectors,
  type FailedBatch,
  type PendingChunk,
} from "../src/indexer/embedding-batches.js";
import { getDynamicBatchOptions } from "../src/indexer/index.js";
import type { ConfiguredProviderInfo } from "../src/embeddings/detector.js";

function metadata(filePath = "src/example.ts"): ChunkMetadata {
  return {
    filePath,
    startLine: 1,
    endLine: 3,
    chunkType: "function",
    name: "example",
    language: "typescript",
    hash: "hash",
  };
}

function pendingChunk(id: string, tokenCounts = [10]): PendingChunk {
  const texts = tokenCounts.map((tokenCount, index) => ({
    text: `${id}-part-${index}`,
    tokenCount,
  }));
  return {
    id,
    texts,
    storageText: createPendingChunkStorageText(texts),
    content: `content-${id}`,
    contentHash: `hash-${id}`,
    metadata: metadata(`src/${id}.ts`),
  };
}

describe("embedding batch helpers", () => {
  it("normalizes persisted multipart chunks and fills derived fields", () => {
    const normalized = normalizePendingChunk({
      id: "chunk-1",
      texts: [
        { text: "first", tokenCount: 5 },
        { text: "second", tokenCount: Number.NaN },
      ],
      content: "source",
      contentHash: "content-hash",
      metadata: metadata(),
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.texts).toEqual([
      { text: "first", tokenCount: 5 },
      { text: "second", tokenCount: 2 },
    ]);
    expect(normalized?.storageText).toBe("first\n\n... [split into 2 parts for embedding]");
  });

  it("rebuilds legacy single-text chunks from source metadata", () => {
    const normalized = normalizePendingChunk({
      id: "legacy",
      text: "legacy embedding text",
      content: "export function legacy() { return true; }",
      contentHash: "legacy-hash",
      metadata: metadata("src/legacy.ts"),
    }, 512);

    expect(normalized).not.toBeNull();
    expect(normalized?.texts).toHaveLength(1);
    expect(normalized?.texts[0]?.text).toContain("legacy");
    expect(normalized?.texts[0]?.text).toContain("export function legacy");
    expect(normalized?.storageText).toBe(normalized?.texts[0]?.text);
  });

  it("normalizes failed batches while dropping invalid chunks", () => {
    const normalized = normalizeFailedBatch({
      chunks: [pendingChunk("valid"), { id: 1 }],
      error: "rate limited",
      attemptCount: 2,
      lastAttempt: "2026-07-29T00:00:00.000Z",
    });

    expect(normalized?.chunks.map((chunk) => chunk.id)).toEqual(["valid"]);
    expect(normalized?.attemptCount).toBe(2);
  });

  it("preserves request order, batching limits, and first-seen chunk order", () => {
    const chunks = [pendingChunk("a", [3, 4]), pendingChunk("b", [5])];
    const requests = createPendingEmbeddingRequests(chunks);
    const batches = createPendingEmbeddingRequestBatches(chunks, { maxBatchItems: 2 });

    expect(requests.map((request) => [request.chunk.id, request.partIndex])).toEqual([
      ["a", 0],
      ["a", 1],
      ["b", 0],
    ]);
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(getUniquePendingChunksFromRequests([requests[0], requests[2], requests[1]])
      .map((chunk) => chunk.id)).toEqual(["a", "b"]);
  });

  it("coalesces failed batches only when retry state is identical", () => {
    const first: FailedBatch = {
      chunks: [pendingChunk("a")],
      error: "failed",
      attemptCount: 1,
      lastAttempt: "now",
    };
    const second: FailedBatch = { ...first, chunks: [pendingChunk("b")] };
    const differentAttempt: FailedBatch = { ...first, chunks: [pendingChunk("c")], attemptCount: 2 };

    const result = coalesceFailedBatches([first, second, differentAttempt]);

    expect(result).toHaveLength(2);
    expect(result[0]?.chunks.map((chunk) => chunk.id)).toEqual(["a", "b"]);
    expect(result[1]?.chunks.map((chunk) => chunk.id)).toEqual(["c"]);
    expect(first.chunks.map((chunk) => chunk.id)).toEqual(["a"]);
  });

  it("pools multipart vectors by clamped token weight", () => {
    expect(poolEmbeddingVectors([[1, 3], [5, 7]], [1, 3])).toEqual([4, 6]);
    expect(poolEmbeddingVectors([[2, 4]], [0])).toEqual([2, 4]);
    expect(poolEmbeddingVectors([], [])).toEqual([]);
  });

  it("detects complete embedding parts and extracts persisted paths", () => {
    const parts = [
      { vector: [1], tokenCount: 2 },
      { vector: [2], tokenCount: 3 },
    ];

    expect(hasAllEmbeddingParts(parts, 2)).toBe(true);
    expect(hasAllEmbeddingParts([parts[0], undefined], 2)).toBe(false);
    expect(hasAllEmbeddingParts(parts, 1)).toBe(false);
    expect(getPendingChunkFilePath(pendingChunk("path"))).toBe("src/path.ts");
    expect(getPendingChunkFilePath({ metadata: {} })).toBeNull();
  });

  it("applies embedding.batch.* only to the ollama provider", () => {
    // getDynamicBatchOptions reads only provider.provider; the remaining fields
    // are irrelevant to this gate, so a minimal cast is sufficient.
    const ollama = { provider: "ollama", credentials: {}, modelInfo: { maxTokens: 8192 } } as unknown as ConfiguredProviderInfo;
    const openai = { provider: "openai", credentials: {}, modelInfo: { maxTokens: 8192 } } as unknown as ConfiguredProviderInfo;
    const google = { provider: "google", credentials: {}, modelInfo: { maxTokens: 8192 } } as unknown as ConfiguredProviderInfo;
    const custom = { provider: "custom", credentials: {}, modelInfo: { maxTokens: 8192 } } as unknown as ConfiguredProviderInfo;

    // Ollama with no overrides gets the documented defaults.
    expect(getDynamicBatchOptions(ollama)).toEqual({ maxBatchTokens: 65_536, maxBatchItems: 16 });
    // Ollama honors user overrides.
    expect(getDynamicBatchOptions(ollama, { maxBatchItems: 1, maxBatchTokens: 100 })).toEqual({ maxBatchTokens: 100, maxBatchItems: 1 });

    // Non-ollama providers ignore embedding.batch.* entirely: an aggressive
    // maxBatchItems: 1 must NOT split their requests into one-item batches.
    const aggressiveBatch = { maxBatchItems: 1, maxBatchTokens: 1 };
    expect(getDynamicBatchOptions(openai, aggressiveBatch)).toEqual({});
    expect(getDynamicBatchOptions(google, aggressiveBatch)).toEqual({});
    expect(getDynamicBatchOptions(custom, aggressiveBatch)).toEqual({});
  });
});
