import { afterEach, describe, expect, it, vi } from "vitest";

import type { Indexer, IndexStats } from "../src/indexer/index.js";
import {
  defaultProjectRoots,
  getIndexerCacheKey,
  indexerCache,
} from "../src/tools/operation-runtime.js";
import { implementationLookup, runIndexCodebase } from "../src/tools/operations.js";
import { OperationCancelledError, ProviderRequestError } from "../src/utils/operation-control.js";

function stats(): IndexStats {
  return {
    totalFiles: 1,
    totalChunks: 1,
    indexedChunks: 1,
    failedChunks: 0,
    existingChunks: 0,
    removedChunks: 0,
    tokensUsed: 10,
    durationMs: 5,
    skippedFiles: [],
    parseFailures: [],
  };
}

describe("direct index operation progress", () => {
  const projectRoot = "/tmp/direct-index-progress";
  const key = getIndexerCacheKey(projectRoot, "jcode");

  afterEach(() => {
    defaultProjectRoots.delete("jcode");
    indexerCache.delete(key);
  });

  it("forwards progress when no coordinator is registered", async () => {
    const index = vi.fn(async (onProgress?: Parameters<Indexer["index"]>[0]) => {
      onProgress?.({
        phase: "embedding",
        filesProcessed: 1,
        totalFiles: 1,
        chunksProcessed: 0,
        totalChunks: 1,
      });
      return stats();
    });
    defaultProjectRoots.set("jcode", projectRoot);
    indexerCache.set(key, { index } as unknown as Indexer);
    const onProgress = vi.fn();
    const reportProgress = vi.fn();

    await expect(runIndexCodebase(undefined, "jcode", {}, onProgress, { reportProgress }))
      .resolves.toMatchObject({ kind: "stats" });

    expect(index).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      phase: "embedding",
      percentage: 20,
    }));
    expect(reportProgress).toHaveBeenCalledWith(20, "embedding");
  });

  it("forwards phase control through the direct indexer path", async () => {
    const setPhase = vi.fn(async () => undefined);
    const index = vi.fn(async (
      _onProgress?: Parameters<Indexer["index"]>[0],
      options?: Parameters<Indexer["index"]>[1],
    ) => {
      await options?.setPhase?.("embedding");
      return stats();
    });
    defaultProjectRoots.set("jcode", projectRoot);
    indexerCache.set(key, { index } as unknown as Indexer);

    await expect(runIndexCodebase(undefined, "jcode", {}, undefined, { setPhase }))
      .resolves.toMatchObject({ kind: "stats" });

    expect(setPhase).toHaveBeenCalledWith("embedding");
  });

  it("retains a typed provider failure after direct partial indexing completes", async () => {
    const providerError = new ProviderRequestError({ statusCode: 429 });
    const index = vi.fn(async (
      _onProgress?: Parameters<Indexer["index"]>[0],
      options?: Parameters<Indexer["index"]>[1],
    ) => {
      options?.onProviderError?.(providerError);
      return stats();
    });
    defaultProjectRoots.set("jcode", projectRoot);
    indexerCache.set(key, { index } as unknown as Indexer);

    await expect(runIndexCodebase(undefined, "jcode", {})).resolves.toMatchObject({
      kind: "stats",
      providerError,
    });
  });

  it("stops exact-symbol resolution when its shared operation is cancelled", async () => {
    const controller = new AbortController();
    const getCallGraphSymbols = vi.fn(async () => {
      controller.abort();
      return [{
        id: "target",
        name: "target",
        filePath: "/tmp/target.ts",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 10,
        language: "typescript",
      }];
    });
    defaultProjectRoots.set("jcode", projectRoot);
    indexerCache.set(key, { getCallGraphSymbols } as unknown as Indexer);

    await expect(implementationLookup(
      undefined,
      "jcode",
      "target",
      { exactSymbol: true },
      { signal: controller.signal },
    )).rejects.toBeInstanceOf(OperationCancelledError);
  });
});
