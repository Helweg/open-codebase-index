import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

const mockState = vi.hoisted(() => ({
  config: {
    scope: "project" as "project" | "global",
    search: {
      routingHints: true,
      routingGraphHandoffHints: false,
      routingHintRole: "system" as "system" | "developer",
    },
    indexing: {
      autoIndex: false,
      autoIndexWaitMs: 50,
      autoIndexMaxRetries: 0,
      autoIndexRetryDelayMs: 10,
      watchFiles: false,
      pauseBackgroundIndexingOnBattery: false,
      requireProjectMarker: true,
    },
  },
  createWatcherWithIndexer: vi.fn(() => ({ stop: vi.fn() })),
  indexer: {
    forceIndex: vi.fn().mockResolvedValue({}),
    getStatus: vi.fn().mockResolvedValue({ indexed: true }),
    index: vi.fn().mockResolvedValue({}),
  },
  initializeTools: vi.fn(),
  hints: ["runtime-routing-hint"],
  routingControllers: [] as Array<{
    getSystemHints: ReturnType<typeof vi.fn>;
    observeUserMessage: ReturnType<typeof vi.fn>;
    markToolUsed: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../src/config/merger.js", () => ({
  loadMergedConfig: vi.fn(() => ({})),
}));

vi.mock("../src/config/schema.js", () => ({
  parseConfig: vi.fn(() => mockState.config),
}));

vi.mock("../src/utils/files.js", () => ({
  hasProjectMarker: vi.fn(() => true),
}));

vi.mock("../src/watcher/index.js", () => ({
  createWatcherWithIndexer: mockState.createWatcherWithIndexer,
}));

vi.mock("../src/commands/loader.js", () => ({
  loadCommandsFromDirectory: vi.fn(() => new Map()),
}));

vi.mock("../src/tools/index.js", () => {
  const toolStub = {};
  return {
    codebase_context: toolStub,
    codebase_edit_context: toolStub,
    codebase_search: toolStub,
    codebase_peek: toolStub,
    index_codebase: toolStub,
    index_status: toolStub,
    index_health_check: toolStub,
    index_metrics: toolStub,
    index_logs: toolStub,
    find_similar: toolStub,
    call_graph: toolStub,
    call_graph_path: toolStub,
    implementation_lookup: toolStub,
    add_knowledge_base: toolStub,
    list_knowledge_bases: toolStub,
    remove_knowledge_base: toolStub,
    pr_impact: toolStub,
    code_communities: toolStub,
    index_visualize: toolStub,
    initializeTools: mockState.initializeTools,
    getIndexerForProject: vi.fn(() => mockState.indexer),
    getSharedIndexer: vi.fn(() => mockState.indexer),
  };
});

vi.mock("../src/routing-hints.js", () => {
  class MockRoutingHintController {
    observeUserMessage = vi.fn();
    getSystemHints = vi.fn(async () => mockState.hints);
    markToolUsed = vi.fn();

    constructor() {
      mockState.routingControllers.push({
        getSystemHints: this.getSystemHints,
        observeUserMessage: this.observeUserMessage,
        markToolUsed: this.markToolUsed,
      });
    }
  }

  return {
    RoutingHintController: MockRoutingHintController,
  };
});

import plugin from "../src/index.js";
import { configureAutoIndex, resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";
import type { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { OPENCODE_TOOL_NAMES } from "../src/tools/tool-names.js";

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("plugin routing hint hook selection", () => {
  beforeEach(() => {
    mockState.config = {
      scope: "project",
      search: {
        routingHints: true,
        routingGraphHandoffHints: false,
        routingHintRole: "system",
      },
      indexing: {
        autoIndex: false,
        autoIndexWaitMs: 50,
        autoIndexMaxRetries: 0,
        autoIndexRetryDelayMs: 10,
        watchFiles: false,
        pauseBackgroundIndexingOnBattery: false,
        requireProjectMarker: true,
      },
    };
    mockState.hints = ["runtime-routing-hint"];
    mockState.routingControllers.length = 0;
    mockState.createWatcherWithIndexer.mockClear();
    mockState.indexer.forceIndex.mockReset().mockResolvedValue({});
    mockState.indexer.getStatus.mockReset().mockResolvedValue({ indexed: true });
    mockState.indexer.index.mockReset().mockResolvedValue({});
    mockState.initializeTools.mockReset().mockImplementation((
      projectRoot: string,
      config: ParsedCodebaseIndexConfig,
    ) => {
      configureAutoIndex(
        projectRoot,
        "opencode",
        config,
        () => mockState.indexer,
      );
    });
  });

  afterEach(async () => {
    await resetAutoIndexCoordinatorsForTests();
  });

  it("does not watch a project symlink that resolves to the home directory", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "plugin-home-symlink-"));
    const homeLink = path.join(tempDir, "home-link");
    symlinkSync(os.homedir(), homeLink, "dir");
    mockState.config.indexing.watchFiles = true;
    mockState.config.indexing.requireProjectMarker = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await plugin({ directory: homeLink } as Parameters<typeof plugin>[0]);
      expect(mockState.createWatcherWithIndexer).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to directory when worktree is not a git repository", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "plugin-non-git-worktree-"));
    const nonGitWorktree = path.parse(tempDir).root;
    mockState.initializeTools.mockClear();

    try {
      await plugin({ directory: tempDir, worktree: nonGitWorktree } as Parameters<typeof plugin>[0]);

      expect(mockState.initializeTools).toHaveBeenCalledWith(tempDir, expect.any(Object));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a git worktree when it is a real git repository", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "plugin-git-worktree-"));
    const directory = path.join(tempDir, "selected-dir");
    const worktree = path.join(tempDir, "worktree");

    mkdirSync(directory, { recursive: true });
    mkdirSync(path.join(worktree, ".git"), { recursive: true });
    writeFileSync(path.join(worktree, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");

    mockState.initializeTools.mockClear();

    try {
      await plugin({ directory, worktree } as Parameters<typeof plugin>[0]);

      expect(mockState.initializeTools).toHaveBeenCalledWith(worktree, expect.any(Object));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("registers the exact canonical OpenCode tool inventory", async () => {
    const runtime = await plugin({ directory: "/tmp/project" } as Parameters<typeof plugin>[0]);

    expect(Object.keys(runtime.tool ?? {})).toEqual([...OPENCODE_TOOL_NAMES]);
    expect(new Set(Object.keys(runtime.tool ?? {})).size).toBe(OPENCODE_TOOL_NAMES.length);
  });

  it("waits for the previous watcher to stop before creating the next one", async () => {
    mockState.config.indexing.autoIndex = true;
    mockState.config.indexing.watchFiles = true;
    const indexGate = createDeferred<{}>();
    mockState.indexer.index.mockImplementationOnce(() => indexGate.promise);
    const stopGate = createDeferred<void>();
    const firstWatcher = {
      stop: vi.fn(() => stopGate.promise),
    };
    const secondWatcher = { stop: vi.fn().mockResolvedValue(undefined) };
    mockState.createWatcherWithIndexer
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(secondWatcher);

    await plugin({ directory: "/tmp/reload-project" } as Parameters<typeof plugin>[0]);
    await vi.waitFor(() => expect(mockState.indexer.index).toHaveBeenCalledOnce());

    const secondReload = plugin({ directory: "/tmp/reload-project" } as Parameters<typeof plugin>[0]);
    await vi.waitFor(() => expect(firstWatcher.stop).toHaveBeenCalledOnce());
    expect(mockState.createWatcherWithIndexer).toHaveBeenCalledOnce();

    stopGate.resolve();
    await secondReload;

    expect(mockState.createWatcherWithIndexer).toHaveBeenCalledTimes(2);
    expect(mockState.indexer.index).toHaveBeenCalledOnce();
    indexGate.resolve({});
    await vi.waitFor(() => expect(mockState.indexer.getStatus).toHaveBeenCalled());
  });

  it("does not create a second watcher when stopping the previous one fails", async () => {
    mockState.config.indexing.watchFiles = true;
    const stopError = new Error("stop failed");
    const firstWatcher = {
      stop: vi.fn()
        .mockRejectedValueOnce(stopError)
        .mockResolvedValue(undefined),
    };
    mockState.createWatcherWithIndexer.mockReturnValue(firstWatcher);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const projectRoot = "/tmp/stop-failure-project";

    try {
      await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);
      const failedReload = await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);

      expect(failedReload.tool).toBeUndefined();
      expect(firstWatcher.stop).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith("[codebase-index] Failed to stop replaced watcher:", stopError);
      expect(mockState.createWatcherWithIndexer).toHaveBeenCalledOnce();
    } finally {
      mockState.config.indexing.watchFiles = false;
      await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);
      error.mockRestore();
    }
  });

  it("serializes concurrent reloads while replaced watcher shutdowns are pending", async () => {
    mockState.config.indexing.watchFiles = true;
    const firstStopGate = createDeferred<void>();
    const secondStopGate = createDeferred<void>();
    const firstWatcher = { stop: vi.fn(() => firstStopGate.promise) };
    const secondWatcher = { stop: vi.fn(() => secondStopGate.promise) };
    const finalWatcher = { stop: vi.fn().mockResolvedValue(undefined) };
    mockState.createWatcherWithIndexer
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(secondWatcher)
      .mockReturnValueOnce(finalWatcher);

    const projectRoot = "/tmp/concurrent-reload-project";
    const reloads = [
      plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]),
      plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]),
      plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]),
    ];

    await vi.waitFor(() => expect(firstWatcher.stop).toHaveBeenCalledOnce());
    expect(mockState.createWatcherWithIndexer).toHaveBeenCalledOnce();
    expect(secondWatcher.stop).not.toHaveBeenCalled();

    firstStopGate.resolve();
    await vi.waitFor(() => expect(secondWatcher.stop).toHaveBeenCalledOnce());
    expect(mockState.createWatcherWithIndexer).toHaveBeenCalledTimes(2);
    expect(finalWatcher.stop).not.toHaveBeenCalled();

    secondStopGate.resolve();
    await Promise.all(reloads);

    expect(mockState.createWatcherWithIndexer).toHaveBeenCalledTimes(3);
    expect(firstWatcher.stop).toHaveBeenCalledOnce();
    expect(secondWatcher.stop).toHaveBeenCalledOnce();
    expect(finalWatcher.stop).not.toHaveBeenCalled();

    mockState.config.indexing.watchFiles = false;
    await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);

    expect(finalWatcher.stop).toHaveBeenCalledOnce();
  });

  it("injects hints through system transform when role is system", async () => {
    const runtime = await plugin({ directory: "/tmp/project" } as Parameters<typeof plugin>[0]);

    const systemTransform = runtime["experimental.chat.system.transform"] as
      ((input: { sessionID?: string }, output: { system?: string[]; developer?: string[] }) => Promise<void>)
      | undefined;
    const developerTransform = runtime["experimental.chat.developer.transform"] as
      ((input: { sessionID?: string }, output: { system?: string[]; developer?: string[] }) => Promise<void>)
      | undefined;

    expect(systemTransform).toBeTypeOf("function");
    expect(developerTransform).toBeTypeOf("function");

    const systemOutput: { system: string[]; developer: string[] } = { system: [], developer: [] };
    await systemTransform?.({ sessionID: "s1" }, systemOutput);
    expect(systemOutput.system).toEqual(["runtime-routing-hint"]);
    expect(systemOutput.developer).toEqual([]);

    const developerOutput: { system: string[]; developer: string[] } = { system: [], developer: [] };
    await developerTransform?.({ sessionID: "s1" }, developerOutput);
    expect(developerOutput.system).toEqual([]);
    expect(developerOutput.developer).toEqual([]);
  });

  it("injects hints through developer transform when role is developer", async () => {
    mockState.config.search.routingHintRole = "developer";
    const runtime = await plugin({ directory: "/tmp/project" } as Parameters<typeof plugin>[0]);

    const systemTransform = runtime["experimental.chat.system.transform"] as
      ((input: { sessionID?: string }, output: { system?: string[]; developer?: string[] }) => Promise<void>)
      | undefined;
    const developerTransform = runtime["experimental.chat.developer.transform"] as
      ((input: { sessionID?: string }, output: { system?: string[]; developer?: string[] }) => Promise<void>)
      | undefined;

    const systemOutput: { system: string[]; developer: string[] } = { system: [], developer: [] };
    await systemTransform?.({ sessionID: "s2" }, systemOutput);
    expect(systemOutput.system).toEqual([]);
    expect(systemOutput.developer).toEqual([]);

    const developerOutput: { system: string[]; developer: string[] } = { system: [], developer: [] };
    await developerTransform?.({ sessionID: "s2" }, developerOutput);
    expect(developerOutput.developer).toEqual(["runtime-routing-hint"]);
    expect(developerOutput.system).toEqual([]);
  });

  it("falls back to system output when developer output channel is unavailable", async () => {
    mockState.config.search.routingHintRole = "developer";
    const runtime = await plugin({ directory: "/tmp/project" } as Parameters<typeof plugin>[0]);

    const developerTransform = runtime["experimental.chat.developer.transform"] as
      ((input: { sessionID?: string }, output: { system?: string[]; developer?: string[] }) => Promise<void>)
      | undefined;

    const output: { system: string[] } = { system: [] };
    await developerTransform?.({ sessionID: "s3" }, output);

    expect(output.system).toEqual(["runtime-routing-hint"]);
  });
});
