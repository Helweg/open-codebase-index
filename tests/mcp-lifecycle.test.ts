import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseConfig } from "../src/config/schema.js";
import { createMcpServer } from "../src/mcp-server.js";
import {
  configCache,
  getIndexerCacheKey,
  getIndexerForProject,
  indexerCache,
  initializeTools,
} from "../src/tools/operation-runtime.js";
import { resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";

const backgroundWorkerMocks = vi.hoisted(() => ({
  attachBackgroundWorkerWatcher: vi.fn(),
  configureBackgroundWorker: vi.fn(),
  getBackgroundWorkerProjectKey: vi.fn((projectRoot: string, host: string) => `${host}::${projectRoot}`),
  stopBackgroundWorker: vi.fn(async () => {}),
  updateBackgroundWorkerConfig: vi.fn(),
  isBackgroundWorkerLeader: vi.fn(() => false),
  isBackgroundWorkerManaged: vi.fn(() => false),
  isBackgroundWorkerStopping: vi.fn(() => false),
  requestBackgroundWorker: vi.fn(),
}));

vi.mock("../src/utils/background-worker.js", () => ({
  attachBackgroundWorkerWatcher: backgroundWorkerMocks.attachBackgroundWorkerWatcher,
  configureBackgroundWorker: backgroundWorkerMocks.configureBackgroundWorker,
  getBackgroundWorkerProjectKey: backgroundWorkerMocks.getBackgroundWorkerProjectKey,
  stopBackgroundWorker: backgroundWorkerMocks.stopBackgroundWorker,
  updateBackgroundWorkerConfig: backgroundWorkerMocks.updateBackgroundWorkerConfig,
  isBackgroundWorkerLeader: backgroundWorkerMocks.isBackgroundWorkerLeader,
  isBackgroundWorkerManaged: backgroundWorkerMocks.isBackgroundWorkerManaged,
  isBackgroundWorkerStopping: backgroundWorkerMocks.isBackgroundWorkerStopping,
  requestBackgroundWorker: backgroundWorkerMocks.requestBackgroundWorker,
  requestBackgroundWorkerRefresh: vi.fn(),
}));

vi.mock("../src/utils/auto-index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/auto-index.js")>("../src/utils/auto-index.js");
  return {
    ...actual,
    startAutoIndexForBackgroundWorker: vi.fn(),
    stopAutoIndex: vi.fn(async () => {}),
  };
});

function pendingStop(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function safeProjectConfig() {
  return parseConfig({ indexing: { requireProjectMarker: false } });
}

describe("MCP automatic indexing lifecycle", () => {
  beforeEach(() => {
    backgroundWorkerMocks.attachBackgroundWorkerWatcher.mockReset();
    backgroundWorkerMocks.configureBackgroundWorker.mockReset();
    backgroundWorkerMocks.getBackgroundWorkerProjectKey.mockClear();
    backgroundWorkerMocks.stopBackgroundWorker.mockReset();
    backgroundWorkerMocks.stopBackgroundWorker.mockResolvedValue(undefined);
    backgroundWorkerMocks.updateBackgroundWorkerConfig.mockReset();
    backgroundWorkerMocks.isBackgroundWorkerLeader.mockReset();
    backgroundWorkerMocks.isBackgroundWorkerLeader.mockReturnValue(false);
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReset();
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(false);
    backgroundWorkerMocks.isBackgroundWorkerStopping.mockReset();
    backgroundWorkerMocks.isBackgroundWorkerStopping.mockReturnValue(false);
    backgroundWorkerMocks.requestBackgroundWorker.mockReset();
  });

  afterEach(async () => {
    await resetAutoIndexCoordinatorsForTests();
  });

  it("refreshes the authoritative OpenCode configuration when its plugin reloads", () => {
    const projectRoot = "/tmp/opencode-authoritative-reload";
    const disabled = parseConfig({ indexing: { autoIndex: false, watchFiles: false } });
    const enabled = parseConfig({ indexing: { autoIndex: true, watchFiles: false } });
    const key = getIndexerCacheKey(projectRoot, "opencode");
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(true);

    try {
      initializeTools(projectRoot, disabled, "opencode");
      initializeTools(projectRoot, enabled, "opencode");

      expect(configCache.get(key)?.indexing.autoIndex).toBe(true);
    } finally {
      configCache.delete(key);
      indexerCache.delete(key);
    }
  });

  it("awaits coordination shutdown from the high-level server close", async () => {
    const stop = pendingStop();
    backgroundWorkerMocks.stopBackgroundWorker.mockReturnValueOnce(stop.promise);
    const server = createMcpServer("/tmp/mcp-close-project", safeProjectConfig(), "jcode");

    let settled = false;
    const closing = server.close().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith("/tmp/mcp-close-project", "jcode");
    expect(settled).toBe(false);
    stop.resolve();
    await closing;
    expect(settled).toBe(true);
  });

  it("awaits coordination shutdown from the low-level server close", async () => {
    const stop = pendingStop();
    backgroundWorkerMocks.stopBackgroundWorker.mockReturnValueOnce(stop.promise);
    const server = createMcpServer("/tmp/mcp-shutdown-project", safeProjectConfig(), "claude");

    let settled = false;
    const closing = server.server.close().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith("/tmp/mcp-shutdown-project", "claude");
    expect(settled).toBe(false);
    stop.resolve();
    await closing;
    expect(settled).toBe(true);
  });

  it("stops coordination when the MCP transport shuts down", async () => {
    const server = createMcpServer("/tmp/mcp-transport-project", safeProjectConfig(), "codex");
    const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.close();

    await vi.waitFor(() => {
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith("/tmp/mcp-transport-project", "codex");
    });
  });

  it("handles a background teardown rejection from the transport close callback", async () => {
    const stopError = new Error("background teardown failed");
    backgroundWorkerMocks.stopBackgroundWorker.mockRejectedValueOnce(stopError);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createMcpServer("/tmp/mcp-transport-stop-error", safeProjectConfig(), "codex");

    server.server.onclose?.();

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        "[codebase-index] Failed to stop MCP background worker after transport close:",
        stopError,
      );
    });
    error.mockRestore();
  });

  it("keeps shared coordination running until the final same-process server closes", async () => {
    const projectRoot = "/tmp/mcp-shared-process-project";
    const first = createMcpServer(projectRoot, safeProjectConfig(), "codex");
    const second = createMcpServer(projectRoot, safeProjectConfig(), "codex");

    await first.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).not.toHaveBeenCalled();

    await second.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledTimes(1);
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(projectRoot, "codex");
  });

  it("restarts shared coordination when a replacement server joins during teardown", async () => {
    const projectRoot = "/tmp/mcp-replacement-during-teardown";
    const stop = pendingStop();
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(false);
    backgroundWorkerMocks.stopBackgroundWorker
      .mockReturnValueOnce(stop.promise)
      .mockResolvedValueOnce(undefined);

    const first = createMcpServer(projectRoot, safeProjectConfig(), "codex");
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(true);
    const closing = first.close();
    await vi.waitFor(() => {
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledOnce();
    });

    const replacement = createMcpServer(projectRoot, safeProjectConfig(), "codex");
    expect(backgroundWorkerMocks.requestBackgroundWorker).toHaveBeenCalledWith(projectRoot, "codex");

    stop.resolve();
    await closing;
    await replacement.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledTimes(2);
  });

  it("restarts shared coordination when a server joins an external teardown", async () => {
    const projectRoot = "/tmp/mcp-replacement-during-external-teardown";
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(false);
    const first = createMcpServer(projectRoot, safeProjectConfig(), "codex");

    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(true);
    backgroundWorkerMocks.isBackgroundWorkerStopping.mockReturnValue(true);
    const replacement = createMcpServer(projectRoot, safeProjectConfig(), "codex");

    expect(backgroundWorkerMocks.requestBackgroundWorker).toHaveBeenCalledWith(projectRoot, "codex");

    await first.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).not.toHaveBeenCalled();
    await replacement.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledOnce();
  });

  it("keeps a safe shared worker running when a marker-required server joins", async () => {
    const projectRoot = "/tmp/mcp-shared-process-without-marker";
    const safe = createMcpServer(projectRoot, safeProjectConfig(), "codex");
    const unsafe = createMcpServer(projectRoot, parseConfig({
      indexing: { requireProjectMarker: true },
    }), "codex");

    expect(backgroundWorkerMocks.stopBackgroundWorker).not.toHaveBeenCalled();

    await unsafe.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).not.toHaveBeenCalled();

    await safe.close();
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledTimes(1);
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(projectRoot, "codex");
  });

  it("keeps the existing indexer when a marker-required server joins a managed worker", async () => {
    const projectRoot = "/tmp/mcp-managed-worker-indexer";
    const safe = createMcpServer(projectRoot, safeProjectConfig(), "codex");
    const safeIndexer = getIndexerForProject(projectRoot, "codex");
    backgroundWorkerMocks.isBackgroundWorkerManaged.mockReturnValue(true);

    const unsafe = createMcpServer(projectRoot, parseConfig({
      indexing: { requireProjectMarker: true },
    }), "codex");

    expect(getIndexerForProject(projectRoot, "codex")).toBe(safeIndexer);

    await unsafe.close();
    await safe.close();
  });
});
