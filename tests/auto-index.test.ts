import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { parseConfig } from "../src/config/schema.js";
import { IndexLockContentionError } from "../src/indexer/index-lock.js";
import type {
  Indexer,
  IndexFreshnessResult,
  IndexProgress,
  IndexStats,
  StatusResult,
} from "../src/indexer/index.js";
import type { BackgroundIndexingPolicy } from "../src/utils/power-source.js";
import { OperationCancelledError, ProviderRequestError } from "../src/utils/operation-control.js";
import {
  configureBackgroundWorker,
  isBackgroundWorkerLeader,
  resetBackgroundWorkersForTests,
} from "../src/utils/background-worker.js";

const powerSource = vi.hoisted(() => ({
  createBackgroundIndexingPolicy: vi.fn(),
  policy: null as BackgroundIndexingPolicy | null,
}));

vi.mock("../src/utils/power-source.js", () => ({
  createBackgroundIndexingPolicy: powerSource.createBackgroundIndexingPolicy,
}));

import {
  configureAutoIndex,
  getAutoIndexStatus,
  requestBackgroundIndex,
  resetAutoIndexCoordinatorsForTests,
  runCoordinatedIndex,
  startAutoIndex,
  startAutoIndexForBackgroundWorker,
  stopAutoIndex,
  stopAutoIndexForBackgroundWorker,
  waitForAutoIndexForRetrieval,
} from "../src/utils/auto-index.js";

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function stats(): IndexStats {
  return {
    totalFiles: 1,
    totalChunks: 1,
    indexedChunks: 1,
    failedChunks: 0,
    tokensUsed: 1,
    durationMs: 1,
    existingChunks: 0,
    removedChunks: 0,
    skippedFiles: [],
    parseFailures: [],
  };
}

function status(indexed: boolean): StatusResult {
  return {
    indexed,
    vectorCount: indexed ? 1 : 0,
    provider: "custom",
    model: "test",
    indexPath: "/private/index/path",
    currentBranch: "main",
    baseBranch: "main",
    compatibility: { compatible: true },
    failedBatchesCount: 0,
  };
}

function config(
  indexingOverrides: Record<string, unknown> = {},
  rootOverrides: Record<string, unknown> = {},
) {
  return parseConfig({
    ...rootOverrides,
    embeddingProvider: "custom",
    customProvider: {
      baseUrl: "http://127.0.0.1:9999/v1",
      model: "test",
      dimensions: 8,
    },
    indexing: {
      autoIndex: true,
      autoIndexWaitMs: 50,
      autoIndexMaxRetries: 2,
      autoIndexRetryDelayMs: 10,
      watchFiles: false,
      requireProjectMarker: true,
      ...indexingOverrides,
    },
  });
}

class MockIndexer {
  readable = false;
  freshness: IndexFreshnessResult = { readable: false, current: false, reason: "missing" };
  getStatus = vi.fn(async () => status(this.readable));
  getIndexFreshness = vi.fn(async () => this.freshness);
  index = vi.fn(async (
    onProgress?: (progress: IndexProgress) => void,
    _options?: Parameters<Indexer["index"]>[1],
  ) => {
    onProgress?.({
      phase: "complete",
      filesProcessed: 1,
      totalFiles: 1,
      chunksProcessed: 1,
      totalChunks: 1,
    });
    this.readable = true;
    this.freshness = { readable: true, current: true, reason: "current" };
    return stats();
  });
  forceIndex = vi.fn(async (
    onProgress?: (progress: IndexProgress) => void,
    options?: Parameters<Indexer["index"]>[1],
  ) => this.index(onProgress, options));
}

describe("auto-index coordinator", () => {
  let projectRoot: string;

  beforeEach(() => {
    powerSource.policy = null;
    powerSource.createBackgroundIndexingPolicy.mockImplementation(() => powerSource.policy);
    projectRoot = mkdtempSync(path.join(os.tmpdir(), "auto-index-coordinator-"));
    mkdirSync(path.join(projectRoot, "src"));
    writeFileSync(path.join(projectRoot, "package.json"), "{}");
  });

  afterEach(async () => {
    await resetBackgroundWorkersForTests();
    await resetAutoIndexCoordinatorsForTests();
    vi.useRealTimers();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("skips a healthy current index and exposes the ready state", async () => {
    const indexer = new MockIndexer();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: true, reason: "current" };
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const result = await startAutoIndex(projectRoot, "jcode");

    expect(result).toMatchObject({ outcome: "ready", skipped: true });
    expect(indexer.index).not.toHaveBeenCalled();
    expect(getAutoIndexStatus(projectRoot, "jcode")).toMatchObject({
      enabled: true,
      state: "ready",
      source: "startup",
    });
  });

  it("refreshes a stale index before reporting ready", async () => {
    const indexer = new MockIndexer();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: false, reason: "files-changed" };
    configureAutoIndex(projectRoot, "codex", config(), () => indexer);

    const result = await startAutoIndex(projectRoot, "codex");

    expect(result?.outcome).toBe("ready");
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("refreshes a readable stale Pi index before reporting it ready", async () => {
    const indexer = new MockIndexer();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: false, reason: "files-changed" };
    configureAutoIndex(projectRoot, "pi", config(), () => indexer);

    const result = await waitForAutoIndexForRetrieval(projectRoot, "pi");

    expect(result).toEqual({ ready: true });
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
  });

  it("refreshes a readable branch-changed index before reporting it ready", async () => {
    const indexer = new MockIndexer();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: false, reason: "branch-changed" };
    configureAutoIndex(projectRoot, "pi", config(), () => indexer);

    await expect(waitForAutoIndexForRetrieval(projectRoot, "pi")).resolves.toEqual({ ready: true });
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
  });

  it("does not serve a stale snapshot while its refresh is in flight", async () => {
    const indexer = new MockIndexer();
    const refresh = deferred<IndexStats>();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: false, reason: "files-changed" };
    indexer.index.mockImplementation(async () => refresh.promise);
    configureAutoIndex(projectRoot, "pi", config({ autoIndexWaitMs: 0 }), () => indexer);

    const result = await waitForAutoIndexForRetrieval(projectRoot, "pi");

    expect(result).toMatchObject({
      ready: false,
      text: expect.stringMatching(/Automatic indexing is indexing/i),
    });
    expect(indexer.index).toHaveBeenCalledOnce();

    refresh.resolve(stats());
    await vi.waitFor(() => expect(getAutoIndexStatus(projectRoot, "pi").state).toBe("ready"));
  });

  it.each([
    "unreadable",
    "incompatible",
    "failed-batches",
    "migration-required",
  ] as const)("keeps a %s snapshot unavailable for retrieval", async (reason) => {
    const indexer = new MockIndexer();
    indexer.readable = reason !== "unreadable";
    indexer.freshness = {
      readable: reason !== "unreadable",
      current: false,
      reason,
    };
    configureAutoIndex(projectRoot, "pi", config(), () => indexer);

    const result = await waitForAutoIndexForRetrieval(projectRoot, "pi");

    expect(result.ready).toBe(false);
    expect(result.text).toContain("Run index_codebase");
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it("lets concurrent first retrievals await one in-flight job", async () => {
    const indexer = new MockIndexer();
    const indexing = deferred<IndexStats>();
    indexer.index.mockImplementation(async (onProgress) => {
      onProgress?.({
        phase: "embedding",
        filesProcessed: 1,
        totalFiles: 1,
        chunksProcessed: 0,
        totalChunks: 1,
      });
      const result = await indexing.promise;
      indexer.readable = true;
      indexer.freshness = { readable: true, current: true, reason: "current" };
      return result;
    });
    configureAutoIndex(projectRoot, "claude", config(), () => indexer);

    const first = waitForAutoIndexForRetrieval(projectRoot, "claude");
    const second = waitForAutoIndexForRetrieval(projectRoot, "claude");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    expect(getAutoIndexStatus(projectRoot, "claude")).toMatchObject({
      state: "indexing",
      progress: { phase: "embedding", percentage: 20 },
    });

    indexing.resolve(stats());
    await expect(Promise.all([first, second])).resolves.toEqual([{ ready: true }, { ready: true }]);
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("detaches a cancelled manual caller without stopping shared indexing", async () => {
    const indexer = new MockIndexer();
    const indexing = deferred<IndexStats>();
    let emitProgress: ((progress: IndexProgress) => void) | undefined;
    let underlyingSignal: AbortSignal | undefined;
    indexer.index.mockImplementation(async (onProgress, options) => {
      emitProgress = onProgress;
      underlyingSignal = options?.signal;
      return indexing.promise;
    });
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const first = runCoordinatedIndex(projectRoot, "jcode", false, firstProgress, firstController.signal);
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const second = runCoordinatedIndex(projectRoot, "jcode", false, secondProgress, secondController.signal);

    emitProgress?.({
      phase: "embedding",
      filesProcessed: 1,
      totalFiles: 1,
      chunksProcessed: 0,
      totalChunks: 2,
    });
    expect(firstProgress).toHaveBeenCalledOnce();
    expect(secondProgress).toHaveBeenCalledOnce();

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(OperationCancelledError);
    expect(underlyingSignal?.aborted).toBe(false);

    emitProgress?.({
      phase: "embedding",
      filesProcessed: 1,
      totalFiles: 1,
      chunksProcessed: 1,
      totalChunks: 2,
    });
    expect(firstProgress).toHaveBeenCalledOnce();
    expect(secondProgress).toHaveBeenCalledTimes(2);

    indexer.readable = true;
    indexing.resolve(stats());
    await expect(second).resolves.toMatchObject({ outcome: "ready" });
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("forwards phase updates to an attached coordinated caller", async () => {
    const indexer = new MockIndexer();
    indexer.index.mockImplementation(async (_onProgress, options) => {
      await options?.setPhase?.("embedding");
      indexer.readable = true;
      indexer.freshness = { readable: true, current: true, reason: "current" };
      return stats();
    });
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);
    const setPhase = vi.fn(async () => undefined);

    await expect(runCoordinatedIndex(
      projectRoot,
      "jcode",
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      setPhase,
    )).resolves.toMatchObject({ outcome: "ready" });

    expect(setPhase).toHaveBeenCalledWith("embedding");
  });

  it("delivers provider failures only to consumers still attached to shared indexing", async () => {
    const indexer = new MockIndexer();
    const indexing = deferred<IndexStats>();
    let reportProviderError: ((error: ProviderRequestError) => void) | undefined;
    indexer.index.mockImplementation(async (_onProgress, options) => {
      reportProviderError = options?.onProviderError;
      return indexing.promise;
    });
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstError = vi.fn();
    const secondError = vi.fn();
    const first = runCoordinatedIndex(
      projectRoot,
      "jcode",
      false,
      undefined,
      firstController.signal,
      undefined,
      firstError,
    );
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const second = runCoordinatedIndex(
      projectRoot,
      "jcode",
      false,
      undefined,
      secondController.signal,
      undefined,
      secondError,
    );

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(OperationCancelledError);
    reportProviderError?.(new ProviderRequestError({ statusCode: 500 }));
    expect(firstError).not.toHaveBeenCalled();
    expect(secondError).toHaveBeenCalledOnce();

    indexer.readable = true;
    indexing.resolve(stats());
    await expect(second).resolves.toMatchObject({ outcome: "ready" });
  });

  it("cancels an exclusively owned manual index after its caller detaches", async () => {
    const indexer = new MockIndexer();
    let underlyingSignal: AbortSignal | undefined;
    indexer.index.mockImplementation(async (_onProgress, options) => {
      underlyingSignal = options?.signal;
      return new Promise<IndexStats>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new OperationCancelledError()), { once: true });
      });
    });
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const controller = new AbortController();
    const operation = runCoordinatedIndex(projectRoot, "jcode", false, undefined, controller.signal);
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    controller.abort();

    await expect(operation).rejects.toBeInstanceOf(OperationCancelledError);
    await vi.waitFor(() => expect(underlyingSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(getAutoIndexStatus(projectRoot, "jcode").state).toBe("stopped"));
  });

  it("keeps manual indexing alive after an independent retrieval joins", async () => {
    const indexer = new MockIndexer();
    const indexing = deferred<IndexStats>();
    let underlyingSignal: AbortSignal | undefined;
    indexer.index.mockImplementation(async (_onProgress, options) => {
      underlyingSignal = options?.signal;
      return indexing.promise;
    });
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const controller = new AbortController();
    const manual = runCoordinatedIndex(projectRoot, "jcode", false, undefined, controller.signal);
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const retrieval = startAutoIndex(projectRoot, "jcode", "retrieval");
    expect(retrieval).not.toBeNull();

    controller.abort();
    await expect(manual).rejects.toBeInstanceOf(OperationCancelledError);
    expect(underlyingSignal?.aborted).toBe(false);

    indexer.readable = true;
    indexer.freshness = { readable: true, current: true, reason: "current" };
    indexing.resolve(stats());
    await expect(retrieval).resolves.toMatchObject({ outcome: "ready" });
  });

  it("removes a queued force index when its only caller cancels", async () => {
    const indexer = new MockIndexer();
    const background = deferred<IndexStats>();
    let underlyingSignal: AbortSignal | undefined;
    indexer.index.mockImplementation((_onProgress, options) => {
      underlyingSignal = options?.signal;
      return background.promise;
    });
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const backgroundJob = requestBackgroundIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const force = runCoordinatedIndex(projectRoot, "jcode", true, undefined, controller.signal);
    controller.abort();

    await expect(force).rejects.toBeInstanceOf(OperationCancelledError);
    expect(underlyingSignal?.aborted).toBe(false);
    background.resolve(stats());
    await expect(backgroundJob).resolves.toMatchObject({ outcome: "ready" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(indexer.forceIndex).not.toHaveBeenCalled();
  });

  it("preserves a pending watcher when a merged force caller cancels", async () => {
    const indexer = new MockIndexer();
    const active = deferred<IndexStats>();
    indexer.index
      .mockImplementationOnce(() => active.promise)
      .mockResolvedValueOnce(stats());
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    const activeJob = startAutoIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const watcher = requestBackgroundIndex(projectRoot, "jcode");
    const controller = new AbortController();
    const force = runCoordinatedIndex(projectRoot, "jcode", true, undefined, controller.signal);
    controller.abort();

    await expect(force).rejects.toBeInstanceOf(OperationCancelledError);
    indexer.readable = true;
    active.resolve(stats());
    await expect(activeJob).resolves.toMatchObject({ outcome: "ready" });
    await expect(watcher).resolves.toMatchObject({ outcome: "ready" });
    expect(indexer.index).toHaveBeenCalledTimes(2);
    expect(indexer.forceIndex).not.toHaveBeenCalled();
  });

  it("returns an actionable in-progress response after the configured wait", async () => {
    const indexer = new MockIndexer();
    const indexing = deferred<IndexStats>();
    indexer.index.mockImplementation(() => indexing.promise);
    configureAutoIndex(projectRoot, "jcode", config({ autoIndexWaitMs: 10 }), () => indexer);

    const result = await waitForAutoIndexForRetrieval(projectRoot, "jcode");

    expect(result.ready).toBe(false);
    expect(result.text).toContain("Automatic indexing is indexing");
    expect(result.text).toContain("index_status");
    indexing.resolve(stats());
  });

  it("forwards only real shared-index activity while a retrieval waits without taking ownership", async () => {
    vi.useFakeTimers();
    const indexer = new MockIndexer();
    const indexing = deferred<IndexStats>();
    let emitProgress: ((progress: IndexProgress) => void) | undefined;
    let emitPhase: ((phase: string) => void | Promise<void>) | undefined;
    let underlyingSignal: AbortSignal | undefined;
    indexer.index.mockImplementation((onProgress, options) => {
      emitProgress = onProgress;
      emitPhase = options?.setPhase;
      underlyingSignal = options?.signal;
      return indexing.promise;
    });
    configureAutoIndex(projectRoot, "jcode", config({ autoIndexWaitMs: 1200 }), () => indexer);
    const heartbeat = vi.fn(async () => undefined);
    const setPhase = vi.fn(async () => undefined);
    const controller = new AbortController();

    const waiting = waitForAutoIndexForRetrieval(projectRoot, "jcode", {
      heartbeat,
      setPhase,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(indexer.index).toHaveBeenCalledOnce();

    await emitPhase?.("embedding");
    emitProgress?.({
      phase: "embedding",
      filesProcessed: 1,
      totalFiles: 1,
      chunksProcessed: 1,
      totalChunks: 2,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setPhase).toHaveBeenCalledWith("embedding");
    expect(heartbeat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(heartbeat).toHaveBeenCalledOnce();

    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(OperationCancelledError);
    expect(underlyingSignal?.aborted).toBe(false);
    emitProgress?.({
      phase: "embedding",
      filesProcessed: 1,
      totalFiles: 1,
      chunksProcessed: 2,
      totalChunks: 2,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(heartbeat).toHaveBeenCalledOnce();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: true, reason: "current" };
    indexing.resolve(stats());
    await vi.runAllTimersAsync();
    expect(getAutoIndexStatus(projectRoot, "jcode")).toMatchObject({ state: "ready" });
  });

  it("retries transient locks with bounded exponential backoff", async () => {
    const indexer = new MockIndexer();
    indexer.index
      .mockRejectedValueOnce(new IndexLockContentionError("/private/indexing.lock", null, "active"))
      .mockImplementationOnce(async () => {
        indexer.readable = true;
        return stats();
      });
    configureAutoIndex(projectRoot, "jcode", config({ autoIndexRetryDelayMs: 100 }), () => indexer);

    const job = startAutoIndex(projectRoot, "jcode");
    await vi.waitFor(() => {
      expect(getAutoIndexStatus(projectRoot, "jcode")).toMatchObject({
        state: "busy-retrying",
        retryAttempt: 1,
        maxRetries: 2,
      });
    });

    await expect(job).resolves.toMatchObject({ outcome: "ready" });
    expect(indexer.index).toHaveBeenCalledTimes(2);
  });

  it("stores sanitized failures with timestamps", async () => {
    const indexer = new MockIndexer();
    indexer.index.mockRejectedValue(new Error("query secret-token failed at /Users/private/project"));
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    await expect(startAutoIndex(projectRoot, "jcode")).resolves.toMatchObject({ outcome: "failed" });
    const snapshot = getAutoIndexStatus(projectRoot, "jcode");

    expect(snapshot.state).toBe("failed");
    expect(snapshot.errorAt).toBeTypeOf("string");
    expect(snapshot.lastError).toContain("embedding provider configuration");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
    expect(JSON.stringify(snapshot)).not.toContain("/Users/private/project");
  });

  it("cancels pending retries and transitions to stopped", async () => {
    const indexer = new MockIndexer();
    indexer.index.mockRejectedValue(new IndexLockContentionError("/private/indexing.lock", null, "active"));
    configureAutoIndex(projectRoot, "jcode", config({ autoIndexRetryDelayMs: 1000 }), () => indexer);

    startAutoIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(getAutoIndexStatus(projectRoot, "jcode").state).toBe("busy-retrying"));
    await stopAutoIndex(projectRoot, "jcode");

    expect(getAutoIndexStatus(projectRoot, "jcode").state).toBe("stopped");
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("keeps stop terminal when forced work is queued behind an active run", async () => {
    const indexer = new MockIndexer();
    const background = deferred<IndexStats>();
    indexer.index.mockImplementation(() => background.promise);
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    requestBackgroundIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const force = runCoordinatedIndex(projectRoot, "jcode", true);
    const stopping = stopAutoIndex(projectRoot, "jcode");

    expect(getAutoIndexStatus(projectRoot, "jcode").state).toBe("stopped");
    background.resolve(stats());
    await stopping;
    await expect(force).resolves.toMatchObject({ outcome: "stopped" });
    expect(indexer.forceIndex).not.toHaveBeenCalled();
    expect(getAutoIndexStatus(projectRoot, "jcode").state).toBe("stopped");
  });

  it("uses the latest Indexer and coalesces watcher requests", async () => {
    const firstIndexer = new MockIndexer();
    const secondIndexer = new MockIndexer();
    const firstRun = deferred<IndexStats>();
    firstIndexer.index.mockImplementation(() => firstRun.promise);
    configureAutoIndex(projectRoot, "jcode", config(), () => firstIndexer);

    const firstRequest = requestBackgroundIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(firstIndexer.index).toHaveBeenCalledOnce());
    configureAutoIndex(projectRoot, "jcode", config(), () => secondIndexer);
    requestBackgroundIndex(projectRoot, "jcode");
    requestBackgroundIndex(projectRoot, "jcode");
    firstIndexer.readable = true;
    firstRun.resolve(stats());

    await firstRequest;
    await vi.waitFor(() => expect(secondIndexer.index).toHaveBeenCalledOnce());
    expect(firstIndexer.index).toHaveBeenCalledOnce();
  });

  it("defers startup indexing on battery power and resumes once on AC power", async () => {
    vi.useFakeTimers();
    let onBattery = true;
    const policy: BackgroundIndexingPolicy = {
      isPaused: vi.fn(async () => onBattery),
      recheckDelayMs: 100,
    };
    powerSource.policy = policy;
    const indexer = new MockIndexer();
    configureAutoIndex(projectRoot, "jcode", config({ pauseBackgroundIndexingOnBattery: true }), () => indexer);

    const startup = startAutoIndex(projectRoot, "jcode");
    await vi.advanceTimersByTimeAsync(0);

    expect(policy.isPaused).toHaveBeenCalledOnce();
    expect(indexer.index).not.toHaveBeenCalled();

    onBattery = false;
    await vi.advanceTimersByTimeAsync(100);

    await expect(startup).resolves.toMatchObject({ outcome: "ready" });
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("coalesces battery-deferred watcher requests into one AC reindex", async () => {
    vi.useFakeTimers();
    let onBattery = true;
    const policy: BackgroundIndexingPolicy = {
      isPaused: vi.fn(async () => onBattery),
      recheckDelayMs: 100,
    };
    powerSource.policy = policy;
    const indexer = new MockIndexer();
    configureAutoIndex(projectRoot, "jcode", config({ pauseBackgroundIndexingOnBattery: true }), () => indexer);

    const requests = [
      requestBackgroundIndex(projectRoot, "jcode"),
      requestBackgroundIndex(projectRoot, "jcode"),
      requestBackgroundIndex(projectRoot, "jcode"),
    ];
    await vi.advanceTimersByTimeAsync(0);

    expect(policy.isPaused).toHaveBeenCalledOnce();
    expect(indexer.index).not.toHaveBeenCalled();

    onBattery = false;
    await vi.advanceTimersByTimeAsync(100);

    await expect(Promise.all(requests)).resolves.toEqual([
      expect.objectContaining({ outcome: "ready" }),
      expect.objectContaining({ outcome: "ready" }),
      expect.objectContaining({ outcome: "ready" }),
    ]);
    expect(indexer.index).toHaveBeenCalledOnce();
  });

  it("drains watcher changes queued while a battery-aware index is running", async () => {
    const policy: BackgroundIndexingPolicy = {
      isPaused: vi.fn().mockResolvedValue(false),
      recheckDelayMs: 100,
    };
    powerSource.policy = policy;
    const indexer = new MockIndexer();
    const firstRun = deferred<IndexStats>();
    const secondRun = deferred<IndexStats>();
    indexer.index
      .mockImplementationOnce(() => firstRun.promise)
      .mockImplementationOnce(() => secondRun.promise);
    configureAutoIndex(projectRoot, "jcode", config({ pauseBackgroundIndexingOnBattery: true }), () => indexer);

    const firstRequest = requestBackgroundIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const queuedChange = requestBackgroundIndex(projectRoot, "jcode");
    let queuedChangeSettled = false;
    void queuedChange?.then(() => {
      queuedChangeSettled = true;
    });
    firstRun.resolve(stats());

    await expect(firstRequest).resolves.toMatchObject({ outcome: "ready" });
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(2));
    expect(queuedChangeSettled).toBe(false);
    secondRun.resolve(stats());
    await expect(queuedChange).resolves.toMatchObject({ outcome: "ready" });
  });

  it("stops a battery-deferred background request without indexing", async () => {
    vi.useFakeTimers();
    const policy: BackgroundIndexingPolicy = {
      isPaused: vi.fn().mockResolvedValue(true),
      recheckDelayMs: 100,
    };
    powerSource.policy = policy;
    const indexer = new MockIndexer();
    configureAutoIndex(projectRoot, "jcode", config({ pauseBackgroundIndexingOnBattery: true }), () => indexer);

    const request = requestBackgroundIndex(projectRoot, "jcode");
    await vi.advanceTimersByTimeAsync(0);
    await stopAutoIndex(projectRoot, "jcode");

    await expect(request).resolves.toEqual({ outcome: "stopped" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it("keeps manual indexing available while background work is paused on battery", async () => {
    const policy: BackgroundIndexingPolicy = {
      isPaused: vi.fn().mockResolvedValue(true),
      recheckDelayMs: 100,
    };
    powerSource.policy = policy;
    const indexer = new MockIndexer();
    configureAutoIndex(projectRoot, "jcode", config({ pauseBackgroundIndexingOnBattery: true }), () => indexer);

    await expect(runCoordinatedIndex(projectRoot, "jcode", false)).resolves.toMatchObject({
      outcome: "ready",
    });

    expect(indexer.index).toHaveBeenCalledOnce();
    expect(policy.isPaused).not.toHaveBeenCalled();
  });

  it("drains the old coordinator before starting an index-key replacement", async () => {
    const firstIndexer = new MockIndexer();
    const secondIndexer = new MockIndexer();
    const firstRun = deferred<IndexStats>();
    firstIndexer.index.mockImplementation(() => firstRun.promise);
    configureAutoIndex(projectRoot, "jcode", config(), () => firstIndexer);

    const firstRequest = requestBackgroundIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(firstIndexer.index).toHaveBeenCalledOnce());
    configureAutoIndex(projectRoot, "jcode", config({}, { scope: "global" }), () => secondIndexer);
    const secondRequest = requestBackgroundIndex(projectRoot, "jcode");
    await Promise.resolve();
    expect(secondIndexer.index).not.toHaveBeenCalled();

    firstRun.resolve(stats());
    await expect(firstRequest).resolves.toMatchObject({ outcome: "stopped" });
    await expect(secondRequest).resolves.toMatchObject({ outcome: "ready" });
    expect(secondIndexer.index).toHaveBeenCalledOnce();
  });

  it("keeps the replacement coordinator active while its previous worker shuts down", async () => {
    const firstIndexer = new MockIndexer();
    const secondIndexer = new MockIndexer();
    firstIndexer.readable = true;
    firstIndexer.freshness = { readable: true, current: true, reason: "current" };
    const localConfig = config();
    configureAutoIndex(projectRoot, "codex", localConfig, () => firstIndexer);
    configureBackgroundWorker(projectRoot, "codex", localConfig, {
      startAutoIndex: (source) => {
        startAutoIndexForBackgroundWorker(projectRoot, "codex", source);
      },
      stopAutoIndex: () => stopAutoIndexForBackgroundWorker(projectRoot, "codex"),
    });
    await vi.waitFor(() => expect(getAutoIndexStatus(projectRoot, "codex").state).toBe("ready"));

    const previousHome = process.env.HOME;
    const testHome = path.join(projectRoot, "test-home");
    mkdirSync(testHome);
    process.env.HOME = testHome;
    try {
      configureAutoIndex(projectRoot, "codex", config({}, { scope: "global" }), () => secondIndexer);

      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
      await vi.waitFor(() => expect(secondIndexer.index).toHaveBeenCalledOnce());
      expect(getAutoIndexStatus(projectRoot, "codex").state).toBe("ready");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("keeps a managed worker coordinator when a non-authoritative registration is unsafe", async () => {
    const indexer = new MockIndexer();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: true, reason: "current" };
    const safeConfig = config({ requireProjectMarker: false });
    configureAutoIndex(projectRoot, "codex", safeConfig, () => indexer);
    configureBackgroundWorker(projectRoot, "codex", safeConfig, {
      startAutoIndex: (source) => {
        startAutoIndexForBackgroundWorker(projectRoot, "codex", source);
      },
      stopAutoIndex: () => stopAutoIndexForBackgroundWorker(projectRoot, "codex"),
    });
    await vi.waitFor(() => expect(getAutoIndexStatus(projectRoot, "codex").state).toBe("ready"));

    rmSync(path.join(projectRoot, "package.json"));
    configureAutoIndex(projectRoot, "codex", config(), () => indexer, {
      preserveManagedWorker: true,
      synchronizeBackgroundWorker: false,
    });

    expect(getAutoIndexStatus(projectRoot, "codex").blockedReason).toBeUndefined();
    const refresh = startAutoIndexForBackgroundWorker(projectRoot, "codex");
    expect(refresh).not.toBeNull();
    await expect(refresh).resolves.toMatchObject({
      outcome: "ready",
      skipped: true,
    });
  });

  it("queues force indexing behind and supersedes background work safely", async () => {
    const indexer = new MockIndexer();
    const background = deferred<IndexStats>();
    indexer.index.mockImplementation(() => background.promise);
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    requestBackgroundIndex(projectRoot, "jcode");
    await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce());
    const force = runCoordinatedIndex(projectRoot, "jcode", true);
    expect(indexer.forceIndex).not.toHaveBeenCalled();
    indexer.readable = true;
    background.resolve(stats());

    await expect(force).resolves.toMatchObject({ outcome: "ready" });
    expect(indexer.forceIndex).toHaveBeenCalledOnce();
  });

  it("does no automatic work when autoIndex is false", async () => {
    const indexer = new MockIndexer();
    configureAutoIndex(projectRoot, "jcode", config({ autoIndex: false }), () => indexer);

    expect(startAutoIndex(projectRoot, "jcode")).toBeNull();
    await expect(waitForAutoIndexForRetrieval(projectRoot, "jcode")).resolves.toEqual({ ready: true });
    expect(indexer.getStatus).not.toHaveBeenCalled();
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it("preserves home-directory safety without exposing the raw path", async () => {
    const indexer = new MockIndexer();
    configureAutoIndex(os.homedir(), "jcode", config({ requireProjectMarker: false }), () => indexer);

    expect(startAutoIndex(os.homedir(), "jcode")).toBeNull();
    const result = await waitForAutoIndexForRetrieval(os.homedir(), "jcode");
    expect(result).toEqual({
      ready: false,
      text: "Automatic indexing is disabled for the home directory. Open a specific project and retry.",
    });
    expect(indexer.index).not.toHaveBeenCalled();
    expect(JSON.stringify(getAutoIndexStatus(os.homedir(), "jcode"))).not.toContain(os.homedir());
  });

  it("blocks automatic indexing when a project symlink resolves to the home directory", async () => {
    const indexer = new MockIndexer();
    const homeLink = path.join(projectRoot, "home-link");
    symlinkSync(os.homedir(), homeLink, "dir");
    configureAutoIndex(homeLink, "jcode", config({ requireProjectMarker: false }), () => indexer);

    expect(startAutoIndex(homeLink, "jcode")).toBeNull();
    await expect(waitForAutoIndexForRetrieval(homeLink, "jcode")).resolves.toMatchObject({
      ready: false,
      text: expect.stringContaining("home directory"),
    });
    expect(indexer.index).not.toHaveBeenCalled();
  });

  it("rechecks project-marker safety after a marker appears", async () => {
    const indexer = new MockIndexer();
    rmSync(path.join(projectRoot, "package.json"));
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    expect(startAutoIndex(projectRoot, "jcode")).toBeNull();
    expect(getAutoIndexStatus(projectRoot, "jcode")).toMatchObject({
      blockedReason: "project-marker-missing",
    });

    writeFileSync(path.join(projectRoot, "package.json"), "{}");
    await expect(waitForAutoIndexForRetrieval(projectRoot, "jcode")).resolves.toEqual({ ready: true });
    expect(indexer.index).toHaveBeenCalledOnce();
    expect(getAutoIndexStatus(projectRoot, "jcode").blockedReason).toBeUndefined();
  });

  it("still runs manual indexing when the project marker is missing", async () => {
    const indexer = new MockIndexer();
    rmSync(path.join(projectRoot, "package.json"));
    configureAutoIndex(projectRoot, "jcode", config(), () => indexer);

    await expect(runCoordinatedIndex(projectRoot, "jcode", false)).resolves.toMatchObject({
      outcome: "ready",
    });

    expect(indexer.index).toHaveBeenCalledOnce();
    expect(getAutoIndexStatus(projectRoot, "jcode").blockedReason).toBe("project-marker-missing");
  });

  it("still runs background watcher indexing from a home-directory project root", async () => {
    const indexer = new MockIndexer();
    configureAutoIndex(os.homedir(), "jcode", config({ requireProjectMarker: false }), () => indexer);

    await expect(requestBackgroundIndex(os.homedir(), "jcode")).resolves.toMatchObject({
      outcome: "ready",
    });

    expect(indexer.index).toHaveBeenCalledOnce();
    expect(getAutoIndexStatus(os.homedir(), "jcode").blockedReason).toBe("home-directory");
  });
});
