import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { createCustomProviderInfo } from "../src/embeddings/detector.js";
import { createEmbeddingProvider } from "../src/embeddings/provider.js";
import type { Indexer, IndexProgress, IndexStats } from "../src/indexer/index.js";
import {
  executeMcpOperation,
  type McpOperationExtra,
} from "../src/adapters/mcp/operation-execution.js";
import { McpRuntimeDiagnostics } from "../src/adapters/mcp/runtime-diagnostics.js";
import type { McpServerRuntime } from "../src/adapters/mcp/shared.js";
import {
  configureAutoIndex,
  resetAutoIndexCoordinatorsForTests,
  waitForAutoIndexForRetrieval,
} from "../src/utils/auto-index.js";
import {
  configCache,
  getIndexerCacheKey,
} from "../src/tools/operation-runtime.js";
import {
  OperationCancelledError,
  ProviderRequestError,
} from "../src/utils/operation-control.js";

function success(text = "ok") {
  return { content: [{ type: "text" as const, text }] };
}

function createExtra(options: {
  controller?: AbortController;
  progressToken?: string | number;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
} = {}): McpOperationExtra {
  const controller = options.controller ?? new AbortController();
  return {
    signal: controller.signal,
    requestId: 1,
    ...(options.progressToken !== undefined
      ? { _meta: { progressToken: options.progressToken } }
      : {}),
    sendNotification: options.sendNotification ?? (async () => undefined),
    sendRequest: async () => {
      throw new Error("Unexpected MCP request from test handler.");
    },
  } as unknown as McpOperationExtra;
}

describe("MCP operation execution", () => {
  let projectRoot: string;
  let runtime: McpServerRuntime;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-operation-"));
    configCache.set(getIndexerCacheKey(projectRoot, "jcode"), parseConfig({}));
    runtime = {
      projectRoot,
      host: "jcode",
      diagnostics: new McpRuntimeDiagnostics(path.join(projectRoot, ".codebase-index", "index")),
    };
  });

  afterEach(async () => {
    await resetAutoIndexCoordinatorsForTests();
    vi.useRealTimers();
    configCache.delete(getIndexerCacheKey(projectRoot, "jcode"));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns a redacted structured internal error", async () => {
    const result = await executeMcpOperation(runtime, "codebase_search", createExtra(), async () => {
      throw new Error("secret=abc query=user-input path=/private/work URL=https://provider.invalid/body");
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        schemaVersion: 1,
        code: "INTERNAL_ERROR",
        operation: "codebase_search",
        retryable: false,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret=abc");
    expect(serialized).not.toContain("user-input");
    expect(serialized).not.toContain("/private/work");
    expect(serialized).not.toContain("provider.invalid");
  });

  it("keeps diagnostics initialization failures inside the structured error boundary", async () => {
    const failingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => {
          throw new Error(`private runtime path: ${projectRoot}`);
        },
      },
    } as unknown as McpServerRuntime;

    const result = await executeMcpOperation(
      failingRuntime,
      "codebase_search",
      createExtra(),
      async () => success(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR", phase: "starting" } },
    });
    expect(JSON.stringify(result)).not.toContain(projectRoot);
  });

  it("classifies aggregate interruption from diagnostics initialization", async () => {
    const failingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => {
          throw new AggregateError([
            new Error("private diagnostics path=/private/runtime"),
            new OperationCancelledError(),
          ]);
        },
      },
    } as unknown as McpServerRuntime;

    const result = await executeMcpOperation(
      failingRuntime,
      "codebase_search",
      createExtra(),
      async () => success(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_CANCELLED", phase: "starting" } },
    });
    expect(JSON.stringify(result)).not.toContain("/private/runtime");
  });

  it("honors client cancellation while diagnostics initialization is pending", async () => {
    const controller = new AbortController();
    const pendingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => new Promise(() => undefined),
      },
    } as unknown as McpServerRuntime;
    const operation = executeMcpOperation(
      pendingRuntime,
      "codebase_search",
      createExtra({ controller }),
      async () => success(),
    );

    controller.abort();
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_CANCELLED", phase: "starting" } },
    });
  });

  it("times out while diagnostics initialization is pending", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pendingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => new Promise(() => undefined),
      },
    } as unknown as McpServerRuntime;
    const operation = executeMcpOperation(
      pendingRuntime,
      "codebase_search",
      createExtra(),
      async () => success(),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_TIMEOUT", phase: "starting" } },
    });
  });

  it("handles a synchronous late diagnostic cleanup failure after cancellation", async () => {
    const controller = new AbortController();
    let resolveBegin: ((value: { complete: () => Promise<void> }) => void) | undefined;
    const pendingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => new Promise<{ complete: () => Promise<void> }>((resolve) => {
          resolveBegin = resolve;
        }),
      },
    } as unknown as McpServerRuntime;
    const operation = executeMcpOperation(
      pendingRuntime,
      "codebase_search",
      createExtra({ controller }),
      async () => success(),
    );

    controller.abort();
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_CANCELLED", phase: "starting" } },
    });
    resolveBegin?.({
      complete: (() => {
        throw new Error("late private cleanup failure");
      }) as unknown as () => Promise<void>,
    });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it.each([
    [{ statusCode: 429 }, true],
    [{ statusCode: 500 }, true],
    [{ timedOut: true }, true],
    [{ statusCode: 400 }, false],
  ] as const)("classifies provider failures with retryability %s", async (options, retryable) => {
    const result = await executeMcpOperation(runtime, "codebase_search", createExtra(), async () => {
      throw new ProviderRequestError(options);
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: "PROVIDER_ERROR", retryable },
    });
  });

  it("classifies client cancellation without exposing the abort reason", async () => {
    const controller = new AbortController();
    const operation = executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({ controller }),
      async () => new Promise(() => undefined),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("private cancellation reason"));

    const result = await operation;
    expect(result.structuredContent).toMatchObject({
      error: { code: "OPERATION_CANCELLED", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain("private cancellation reason");
  });

  it("classifies nested aggregate cancellation without exposing cleanup failures", async () => {
    const result = await executeMcpOperation(runtime, "pr_impact", createExtra(), async () => {
      throw new AggregateError([
        new Error("cleanup path=/private/work secret=abc"),
        new AggregateError([
          new Error("provider URL=https://provider.invalid/body"),
          new OperationCancelledError(),
        ]),
      ]);
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "OPERATION_CANCELLED", operation: "pr_impact", retryable: true },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/private/work");
    expect(serialized).not.toContain("secret=abc");
    expect(serialized).not.toContain("provider.invalid");
  });

  it("defers diagnostic completion until cooperative cleanup settles after cancellation", async () => {
    const controller = new AbortController();
    let releaseCleanup: (() => void) | undefined;
    let diagnosticsCompleted = false;
    const cleanupRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => ({
          id: "cleanup-operation",
          setPhase: async () => undefined,
          heartbeat: async () => undefined,
          complete: async () => {
            diagnosticsCompleted = true;
          },
        }),
      },
    } as unknown as McpServerRuntime;
    const operation = executeMcpOperation(
      cleanupRuntime,
      "pr_impact",
      createExtra({ controller }),
      async (control) => {
        await new Promise<void>((resolve) => {
          control.signal?.addEventListener("abort", () => {
            releaseCleanup = resolve;
          }, { once: true });
        });
        return success();
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await vi.waitFor(() => expect(releaseCleanup).toBeTypeOf("function"));
    expect(diagnosticsCompleted).toBe(false);

    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_CANCELLED" } },
    });
    expect(diagnosticsCompleted).toBe(false);
    releaseCleanup?.();
    await vi.waitFor(() => expect(diagnosticsCompleted).toBe(true));
    expect(diagnosticsCompleted).toBe(true);
  });

  it("keeps diagnostics active beyond the old settlement timeout until the handler settles", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    const originalBegin = runtime.diagnostics.begin.bind(runtime.diagnostics);
    const completeDiagnostic = vi.fn();
    vi.spyOn(runtime.diagnostics, "begin").mockImplementation(async (operationName) => {
      const tracked = await originalBegin(operationName);
      return {
        ...tracked,
        complete: async () => {
          completeDiagnostic();
          await tracked.complete();
        },
      };
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let rejectHandler: ((error: Error) => void) | undefined;
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const operation = executeMcpOperation(runtime, "index_codebase", createExtra(), async (control) => {
      await control.setPhase?.("embedding");
      return new Promise((_resolve, reject) => {
        rejectHandler = reject;
        markHandlerStarted?.();
      });
    });

    await handlerStarted;
    await vi.advanceTimersByTimeAsync(6000);
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_TIMEOUT" } },
    });
    await expect(runtime.diagnostics.snapshot(undefined, 1000)).resolves.toMatchObject({
      activeOperations: [{ operation: "index_codebase", phase: "embedding", status: "suspected_stall" }],
    });

    rejectHandler?.(new Error("late private failure"));
    await vi.runAllTimersAsync();
    await expect(runtime.diagnostics.snapshot(undefined, 1000)).resolves.toMatchObject({ activeOperations: [] });
    expect(completeDiagnostic).toHaveBeenCalledOnce();
  });

  it("does not invoke the handler or emit progress for a pre-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private pre-cancel reason"));
    const sendNotification = vi.fn(async () => undefined);
    const handler = vi.fn(async () => success());

    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({ controller, progressToken: "unused", sendNotification }),
      handler,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_CANCELLED" } },
    });
  });

  it("uses the real five-minute default and rearms it on heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const operation = executeMcpOperation(runtime, "index_codebase", createExtra(), async (control) => {
      markHandlerStarted?.();
      setTimeout(() => {
        void control.heartbeat?.();
      }, 250_000);
      return new Promise((resolve) => {
        setTimeout(() => resolve(success()), 500_000);
      });
    });
    await handlerStarted;

    await vi.advanceTimersByTimeAsync(500_000);
    expect((await operation).isError).not.toBe(true);
  });

  it("returns OPERATION_TIMEOUT after the configured inactivity period", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const operation = executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra(),
      async () => {
        markHandlerStarted?.();
        return new Promise(() => undefined);
      },
    );
    await handlerStarted;

    await vi.advanceTimersByTimeAsync(1000);
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "OPERATION_TIMEOUT", phase: "starting", retryable: true },
      },
    });
  });

  it("times out an opaque provider wait before the provider deadline and aborts the provider request", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const provider = createEmbeddingProvider(createCustomProviderInfo({
      baseUrl: "http://localhost:11434/v1",
      model: "opaque-provider",
      dimensions: 8,
      timeoutMs: 5000,
    }));
    let requestSignal: AbortSignal | undefined;
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      markProviderStarted?.();
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    try {
      const operation = executeMcpOperation(runtime, "index_codebase", createExtra(), async (control) => {
        await provider.embedQuery("opaque request", control);
        return success();
      });
      await providerStarted;

      await vi.advanceTimersByTimeAsync(1000);
      await expect(operation).resolves.toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "OPERATION_TIMEOUT", phase: "embedding", retryable: true },
        },
      });
      expect(requestSignal?.aborted).toBe(true);
      await expect(runtime.diagnostics.snapshot(undefined, 1000)).resolves.toMatchObject({
        activeOperations: [],
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps a retrieval alive while its shared index reports real progress", async () => {
    const config = parseConfig({
      mcp: { stallTimeoutMs: 1000 },
      indexing: {
        autoIndex: true,
        autoIndexWaitMs: 2500,
        requireProjectMarker: false,
      },
    });
    configCache.set(getIndexerCacheKey(projectRoot, "jcode"), config);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const originalBegin = runtime.diagnostics.begin.bind(runtime.diagnostics);
    let markEmbeddingForwarded: (() => void) | undefined;
    let markEmbeddingProgressForwarded: (() => void) | undefined;
    let markStoringForwarded: (() => void) | undefined;
    const embeddingForwarded = new Promise<void>((resolve) => {
      markEmbeddingForwarded = resolve;
    });
    const embeddingProgressForwarded = new Promise<void>((resolve) => {
      markEmbeddingProgressForwarded = resolve;
    });
    const storingForwarded = new Promise<void>((resolve) => {
      markStoringForwarded = resolve;
    });
    vi.spyOn(runtime.diagnostics, "begin").mockImplementation(async (operationName) => {
      const tracked = await originalBegin(operationName);
      return {
        ...tracked,
        setPhase: async (phase) => {
          await tracked.setPhase(phase);
          if (phase === "embedding") markEmbeddingForwarded?.();
          if (phase === "storing") markStoringForwarded?.();
        },
        heartbeat: async () => {
          await tracked.heartbeat();
          markEmbeddingProgressForwarded?.();
        },
      };
    });
    let indexed = false;
    let markIndexStarted: (() => void) | undefined;
    const indexStarted = new Promise<void>((resolve) => {
      markIndexStarted = resolve;
    });
    const stats: IndexStats = {
      totalFiles: 1,
      totalChunks: 2,
      indexedChunks: 2,
      failedChunks: 0,
      tokensUsed: 2,
      durationMs: 1800,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };
    const index = vi.fn(async (
      onProgress?: (progress: IndexProgress) => void,
      options?: Parameters<Indexer["index"]>[1],
    ) => {
      await options?.setPhase?.("embedding");
      markIndexStarted?.();
      return new Promise<IndexStats>((resolve) => {
        setTimeout(() => onProgress?.({
          phase: "embedding",
          filesProcessed: 1,
          totalFiles: 1,
          chunksProcessed: 1,
          totalChunks: 2,
        }), 700);
        setTimeout(() => onProgress?.({
          phase: "storing",
          filesProcessed: 1,
          totalFiles: 1,
          chunksProcessed: 2,
          totalChunks: 2,
        }), 1400);
        setTimeout(() => {
          indexed = true;
          resolve(stats);
        }, 1800);
      });
    });
    const indexer = {
      forceIndex: index,
      getStatus: vi.fn(async () => ({
        indexed,
        vectorCount: indexed ? 2 : 0,
        provider: "custom",
        model: "test",
        indexPath: "/private/index/path",
        currentBranch: "main",
        baseBranch: "main",
        compatibility: { compatible: true },
        failedBatchesCount: 0,
      })),
      index,
    };
    configureAutoIndex(projectRoot, "jcode", config, () => indexer);

    const operation = executeMcpOperation(runtime, "codebase_context", createExtra(), async (control) => {
      await control.setPhase?.("waiting_for_index");
      const result = await waitForAutoIndexForRetrieval(projectRoot, "jcode", control);
      return success(result.ready ? "ready" : "not ready");
    });
    await indexStarted;
    await embeddingForwarded;

    await vi.advanceTimersByTimeAsync(700);
    await embeddingProgressForwarded;
    await vi.advanceTimersByTimeAsync(700);
    await storingForwarded;
    await vi.advanceTimersByTimeAsync(400);

    await expect(operation).resolves.toMatchObject({
      content: [{ type: "text", text: "ready" }],
    });
    expect(index).toHaveBeenCalledOnce();
  });

  it("keeps a retrieval alive while its freshness preflight reports heartbeats", async () => {
    const config = parseConfig({
      mcp: { stallTimeoutMs: 1000 },
      indexing: {
        autoIndex: true,
        autoIndexWaitMs: 2500,
        requireProjectMarker: false,
      },
    });
    configCache.set(getIndexerCacheKey(projectRoot, "jcode"), config);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let markPreflightStarted: (() => void) | undefined;
    let markFirstHeartbeat: (() => void) | undefined;
    let markSecondHeartbeat: (() => void) | undefined;
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve;
    });
    const firstHeartbeat = new Promise<void>((resolve) => {
      markFirstHeartbeat = resolve;
    });
    const secondHeartbeat = new Promise<void>((resolve) => {
      markSecondHeartbeat = resolve;
    });
    const index = vi.fn(async () => {
      throw new Error("Freshness should have avoided indexing.");
    });
    const getIndexFreshness = vi.fn(async (
      options?: Parameters<Indexer["getIndexFreshness"]>[0],
    ) => {
      await options?.setPhase?.("scanning");
      markPreflightStarted?.();
      return new Promise<Awaited<ReturnType<Indexer["getIndexFreshness"]>>>((resolve) => {
        setTimeout(() => {
          void Promise.resolve(options?.heartbeat?.()).then(() => markFirstHeartbeat?.());
        }, 700);
        setTimeout(() => {
          void Promise.resolve(options?.heartbeat?.()).then(() => markSecondHeartbeat?.());
        }, 1400);
        setTimeout(() => resolve({ readable: true, current: true, reason: "current" }), 1800);
      });
    });
    configureAutoIndex(projectRoot, "jcode", config, () => ({
      forceIndex: index,
      getIndexFreshness,
      getStatus: vi.fn(),
      index,
    }));

    const operation = executeMcpOperation(runtime, "codebase_context", createExtra(), async (control) => {
      await control.setPhase?.("waiting_for_index");
      const result = await waitForAutoIndexForRetrieval(projectRoot, "jcode", control);
      return success(result.ready ? "ready" : "not ready");
    });
    await preflightStarted;

    await vi.advanceTimersByTimeAsync(700);
    await firstHeartbeat;
    await vi.advanceTimersByTimeAsync(700);
    await secondHeartbeat;
    await vi.advanceTimersByTimeAsync(400);

    await expect(operation).resolves.toMatchObject({
      content: [{ type: "text", text: "ready" }],
    });
    expect(getIndexFreshness).toHaveBeenCalledOnce();
    expect(index).not.toHaveBeenCalled();
  });

  it("preserves client cancellation when diagnostic completion does not settle", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const pendingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => ({
          id: "pending-completion",
          setPhase: async () => undefined,
          heartbeat: async () => undefined,
          complete: async () => new Promise<void>(() => undefined),
        }),
      },
    } as unknown as McpServerRuntime;
    const operation = executeMcpOperation(
      pendingRuntime,
      "index_codebase",
      createExtra({ controller }),
      async () => new Promise(() => undefined),
    );
    await Promise.resolve();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_CANCELLED" } },
    });
  });

  it("preserves an inactivity timeout when diagnostic completion does not settle", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pendingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => ({
          id: "pending-completion",
          setPhase: async () => undefined,
          heartbeat: async () => undefined,
          complete: async () => new Promise<void>(() => undefined),
        }),
      },
    } as unknown as McpServerRuntime;
    const operation = executeMcpOperation(
      pendingRuntime,
      "index_codebase",
      createExtra(),
      async () => new Promise(() => undefined),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);

    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_TIMEOUT" } },
    });
  });

  it("returns INTERNAL_ERROR when successful diagnostic completion throws synchronously", async () => {
    const failingRuntime = {
      ...runtime,
      diagnostics: {
        begin: async () => ({
          id: "failing-completion",
          setPhase: async () => undefined,
          heartbeat: async () => undefined,
          complete: (() => {
            throw new Error("private completion failure");
          }) as unknown as () => Promise<void>,
        }),
      },
    } as unknown as McpServerRuntime;

    const result = await executeMcpOperation(
      failingRuntime,
      "codebase_search",
      createExtra(),
      async () => success(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR" } },
    });
    expect(JSON.stringify(result)).not.toContain("private completion failure");
  });

  it("does not emit progress without a progress token", async () => {
    const sendNotification = vi.fn(async () => undefined);
    await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({ sendNotification }),
      async (control) => {
        await control.reportProgress?.(20, "embedding");
        return success();
      },
    );
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("reuses the exact token and serializes strictly increasing progress", async () => {
    const notifications: ServerNotification[] = [];
    let inFlight = false;
    const sendNotification = vi.fn(async (notification: ServerNotification) => {
      expect(inFlight).toBe(false);
      inFlight = true;
      await Promise.resolve();
      notifications.push(notification);
      inFlight = false;
    });

    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({ progressToken: "opaque-token", sendNotification }),
      async (control) => {
        await control.reportProgress?.(10, "scanning");
        await control.reportProgress?.(10, "scanning");
        await control.reportProgress?.(5, "scanning");
        await control.reportProgress?.(50.8, "embedding");
        await control.reportProgress?.(100, "complete");
        return success();
      },
    );

    expect(result.isError).not.toBe(true);
    expect(notifications.map((notification) => notification.params)).toEqual([
      { progressToken: "opaque-token", progress: 0, total: 100 },
      { progressToken: "opaque-token", progress: 10, total: 100 },
      { progressToken: "opaque-token", progress: 50, total: 100 },
      { progressToken: "opaque-token", progress: 100, total: 100 },
    ]);
  });

  it("rearms the inactivity deadline on duplicate raw progress without emitting a duplicate", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const notifications: ServerNotification[] = [];
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });

    const operation = executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "duplicate-heartbeat",
        sendNotification: async (notification) => {
          notifications.push(notification);
        },
      }),
      async (control) => {
        markHandlerStarted?.();
        setTimeout(() => {
          void control.reportProgress?.(10, "embedding");
        }, 600);
        setTimeout(() => {
          void control.reportProgress?.(10, "embedding");
        }, 1200);
        return new Promise((resolve) => {
          setTimeout(() => resolve(success()), 1800);
        });
      },
    );
    await handlerStarted;

    await vi.advanceTimersByTimeAsync(1800);
    const result = await operation;
    expect(result.isError).not.toBe(true);
    expect(notifications.map((notification) => notification.params)).toEqual([
      { progressToken: "duplicate-heartbeat", progress: 0, total: 100 },
      { progressToken: "duplicate-heartbeat", progress: 10, total: 100 },
      { progressToken: "duplicate-heartbeat", progress: 100, total: 100 },
    ]);
  });

  it("turns progress delivery failure into a handled internal error", async () => {
    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: 42,
        sendNotification: async () => {
          throw new Error("closed transport with private detail");
        },
      }),
      async () => success(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR", retryable: false } },
    });
    expect(JSON.stringify(result)).not.toContain("private detail");
  });

  it("times out when initial progress delivery never settles", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const handler = vi.fn(async () => success());
    let markNotificationStarted: (() => void) | undefined;
    const notificationStarted = new Promise<void>((resolve) => {
      markNotificationStarted = resolve;
    });
    const operation = executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "blocked-initial",
        sendNotification: async () => {
          markNotificationStarted?.();
          return new Promise(() => undefined);
        },
      }),
      handler,
    );

    await notificationStarted;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_TIMEOUT" } },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not start the handler after the initial progress notification fails", async () => {
    const handler = vi.fn(async () => {
      throw new Error("late private handler failure");
    });
    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "token",
        sendNotification: async () => {
          throw new Error("initial progress failure");
        },
      }),
      handler,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR" } },
    });
  });

  it("handles synchronous notification failures", async () => {
    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "token",
        sendNotification: (() => {
          throw new Error("synchronous private failure");
        }) as unknown as (notification: ServerNotification) => Promise<void>,
      }),
      async () => success(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR" } },
    });
    expect(JSON.stringify(result)).not.toContain("synchronous private failure");
  });

  it("reports a final progress delivery failure instead of returning success", async () => {
    let notificationCount = 0;
    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "token",
        sendNotification: async () => {
          notificationCount += 1;
          if (notificationCount === 2) throw new Error("private final progress failure");
        },
      }),
      async () => success(),
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR" } },
    });
    expect(JSON.stringify(result)).not.toContain("private final progress failure");
  });

  it("times out when final progress delivery never settles", async () => {
    configCache.set(
      getIndexerCacheKey(projectRoot, "jcode"),
      parseConfig({ mcp: { stallTimeoutMs: 1000 } }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let notificationCount = 0;
    let markFinalNotificationStarted: (() => void) | undefined;
    const finalNotificationStarted = new Promise<void>((resolve) => {
      markFinalNotificationStarted = resolve;
    });
    const operation = executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "blocked-final",
        sendNotification: async () => {
          notificationCount += 1;
          if (notificationCount > 1) {
            markFinalNotificationStarted?.();
            return new Promise(() => undefined);
          }
        },
      }),
      async () => success(),
    );

    await finalNotificationStarted;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(operation).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "OPERATION_TIMEOUT" } },
    });
  });

  it("handles an ignored progress promise when notification delivery fails", async () => {
    let notificationCount = 0;
    const result = await executeMcpOperation(
      runtime,
      "index_codebase",
      createExtra({
        progressToken: "token",
        sendNotification: async () => {
          notificationCount += 1;
          if (notificationCount > 1) throw new Error("private transport failure");
        },
      }),
      async (control) => {
        void control.reportProgress?.(20, "embedding");
        return new Promise(() => undefined);
      },
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "INTERNAL_ERROR" } },
    });
    expect(JSON.stringify(result)).not.toContain("private transport failure");
  });

  it("adds diagnostics to index_status and excludes the current call", async () => {
    let releaseOperation: (() => void) | undefined;
    const active = executeMcpOperation(runtime, "index_codebase", createExtra(), async (control) => {
      await control.setPhase?.("embedding");
      return new Promise((resolve) => {
        releaseOperation = () => resolve(success());
      });
    });
    while (!releaseOperation) await new Promise((resolve) => setImmediate(resolve));

    const status = await executeMcpOperation(runtime, "index_status", createExtra(), async () => success("ready"));
    expect(status.structuredContent).toMatchObject({
      mcpDiagnostics: {
        schemaVersion: 1,
        activeOperations: [{ operation: "index_codebase", phase: "embedding", status: "active" }],
      },
    });
    expect(JSON.stringify(status.structuredContent)).not.toContain('"operation":"index_status"');

    releaseOperation();
    await active;
  });
});
