import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { parseConfig } from "../src/config/schema.js";
import { IndexLockContentionError } from "../src/indexer/index-lock.js";
import type { IndexFreshnessResult, IndexProgress, IndexStats, StatusResult } from "../src/indexer/index.js";
import type { BackgroundIndexingPolicy } from "../src/utils/power-source.js";

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
  stopAutoIndex,
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
  index = vi.fn(async (onProgress?: (progress: IndexProgress) => void) => {
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
  forceIndex = vi.fn(async (onProgress?: (progress: IndexProgress) => void) => this.index(onProgress));
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

  it("refreshes a readable stale Pi index before retrieval", async () => {
    const indexer = new MockIndexer();
    indexer.readable = true;
    indexer.freshness = { readable: true, current: false, reason: "files-changed" };
    configureAutoIndex(projectRoot, "pi", config(), () => indexer);

    const result = await waitForAutoIndexForRetrieval(projectRoot, "pi");

    expect(result).toEqual({ ready: true });
    expect(indexer.index).toHaveBeenCalledOnce();
    expect(indexer.getIndexFreshness).toHaveBeenCalledTimes(3);
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
