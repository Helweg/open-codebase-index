import type { ChunkMetadata } from "../native/index.js";
import { createEmbeddingTexts, createDynamicBatches, estimateTokens } from "../native/index.js";

export interface PendingChunk {
  id: string;
  texts: Array<{
    text: string;
    tokenCount: number;
  }>;
  storageText: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

export interface PendingEmbeddingRequest {
  chunk: PendingChunk;
  partIndex: number;
  text: string;
  tokenCount: number;
}

export interface FailedBatch {
  chunks: PendingChunk[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

export interface RetryableFailedChunk {
  chunk: PendingChunk;
  attemptCount: number;
}

export interface SerializedFailedBatch {
  chunks: unknown[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

export function createPendingChunkStorageText(texts: PendingChunk["texts"]): string {
  const primaryText = texts[0]?.text ?? "";
  if (texts.length <= 1) {
    return primaryText;
  }

  return `${primaryText}\n\n... [split into ${texts.length} parts for embedding]`;
}

export function normalizePendingChunk(rawChunk: unknown, maxChunkTokens?: number): PendingChunk | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }

  const chunk = rawChunk as {
    id?: unknown;
    text?: unknown;
    texts?: Array<{ text?: unknown; tokenCount?: unknown }>;
    storageText?: unknown;
    content?: unknown;
    contentHash?: unknown;
    metadata?: unknown;
  };

  if (typeof chunk.id !== "string" || typeof chunk.contentHash !== "string" || !chunk.metadata || typeof chunk.metadata !== "object") {
    return null;
  }

  const texts = Array.isArray(chunk.texts)
    ? chunk.texts
      .map((entry) => {
        if (!entry || typeof entry.text !== "string") {
          return null;
        }

        return {
          text: entry.text,
          tokenCount: typeof entry.tokenCount === "number" && Number.isFinite(entry.tokenCount)
            ? entry.tokenCount
            : estimateTokens(entry.text),
        };
      })
      .filter((entry): entry is PendingChunk["texts"][number] => entry !== null)
    : [];

  if (texts.length === 0 && typeof chunk.text === "string") {
    if (typeof chunk.content === "string" && chunk.content.length > 0 && chunk.metadata && typeof chunk.metadata === "object") {
      const metadata = chunk.metadata as Partial<ChunkMetadata>;
      const rebuiltChunk = {
        content: chunk.content,
        startLine: typeof metadata.startLine === "number" ? metadata.startLine : 1,
        endLine: typeof metadata.endLine === "number" ? metadata.endLine : 1,
        chunkType: typeof metadata.chunkType === "string" ? metadata.chunkType : "other",
        name: typeof metadata.name === "string" ? metadata.name : undefined,
        language: typeof metadata.language === "string" ? metadata.language : "text",
      };
      const filePath = typeof metadata.filePath === "string" ? metadata.filePath : "unknown";
      texts.push(
        ...createEmbeddingTexts(rebuiltChunk, filePath, maxChunkTokens).map((text) => ({
          text,
          tokenCount: estimateTokens(text),
        }))
      );
    } else {
      texts.push({
        text: chunk.text,
        tokenCount: estimateTokens(chunk.text),
      });
    }
  }

  if (texts.length === 0) {
    return null;
  }

  return {
    id: chunk.id,
    texts,
    storageText: typeof chunk.storageText === "string" ? chunk.storageText : createPendingChunkStorageText(texts),
    content: typeof chunk.content === "string" ? chunk.content : "",
    contentHash: chunk.contentHash,
    metadata: chunk.metadata as ChunkMetadata,
  };
}

export function getPendingChunkFilePath(rawChunk: unknown): string | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }

  const chunk = rawChunk as { metadata?: unknown };
  if (!chunk.metadata || typeof chunk.metadata !== "object") {
    return null;
  }

  const metadata = chunk.metadata as { filePath?: unknown };
  return typeof metadata.filePath === "string" ? metadata.filePath : null;
}

export function normalizeFailedBatch(batch: SerializedFailedBatch, maxChunkTokens?: number): FailedBatch | null {
  const chunks = batch.chunks
    .map((chunk) => normalizePendingChunk(chunk, maxChunkTokens))
    .filter((chunk): chunk is PendingChunk => chunk !== null);

  if (chunks.length === 0) {
    return null;
  }

  return {
    chunks,
    error: batch.error,
    attemptCount: batch.attemptCount,
    lastAttempt: batch.lastAttempt,
  } satisfies FailedBatch;
}

export function createPendingEmbeddingRequests(chunks: PendingChunk[]): PendingEmbeddingRequest[] {
  return chunks.flatMap((chunk) =>
    chunk.texts.map((textPart, partIndex) => ({
      chunk,
      partIndex,
      text: textPart.text,
      tokenCount: textPart.tokenCount,
    }))
  );
}

export function createPendingEmbeddingRequestBatches(
  chunks: PendingChunk[],
  options: { maxBatchTokens?: number; maxBatchItems?: number } = {}
): PendingEmbeddingRequest[][] {
  return createDynamicBatches(createPendingEmbeddingRequests(chunks), options);
}

export function getUniquePendingChunksFromRequests(requests: PendingEmbeddingRequest[]): PendingChunk[] {
  const uniqueChunks = new Map<string, PendingChunk>();
  for (const request of requests) {
    uniqueChunks.set(request.chunk.id, request.chunk);
  }
  return Array.from(uniqueChunks.values());
}

export function coalesceFailedBatches(batches: FailedBatch[]): FailedBatch[] {
  const grouped = new Map<string, FailedBatch>();

  for (const batch of batches) {
    const key = `${batch.attemptCount}:${batch.lastAttempt}:${batch.error}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...batch,
        chunks: [...batch.chunks],
      });
      continue;
    }

    existing.chunks.push(...batch.chunks);
  }

  return Array.from(grouped.values());
}

export function poolEmbeddingVectors(vectors: number[][], weights: number[]): number[] {
  const firstVector = vectors[0];
  if (!firstVector) {
    return [];
  }

  const pooled = new Array<number>(firstVector.length).fill(0);
  let totalWeight = 0;

  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index];
    const weight = Math.max(1, weights[index] ?? 1);
    totalWeight += weight;

    for (let dimension = 0; dimension < vector.length; dimension++) {
      pooled[dimension] += vector[dimension] * weight;
    }
  }

  if (totalWeight === 0) {
    return firstVector;
  }

  return pooled.map((value) => value / totalWeight);
}

export function hasAllEmbeddingParts(
  parts: Array<{ vector: number[]; tokenCount: number } | undefined>,
  expectedPartCount: number
): boolean {
  if (parts.length !== expectedPartCount) {
    return false;
  }

  for (let index = 0; index < expectedPartCount; index++) {
    if (parts[index] === undefined) {
      return false;
    }
  }

  return true;
}
