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
  realRouting: false,
  hints: ["runtime-routing-hint"],
  routingControllers: [] as Array<{
    getSystemHints: ReturnType<typeof vi.fn>;
    observeUserMessage: ReturnType<typeof vi.fn>;
    markToolUsed: ReturnType<typeof vi.fn>;
  }>,
}));

const backgroundWorkerMocks = vi.hoisted(() => ({
  configureBackgroundWorker: vi.fn(),
  stopBackgroundWorker: vi.fn(async () => {}),
  updateBackgroundWorkerConfig: vi.fn(),
  waitForBackgroundWorkerStart: vi.fn(async () => {}),
}));

const fileMocks = vi.hoisted(() => ({
  hasProjectMarker: vi.fn(() => true),
}));

vi.mock("../src/config/merger.js", () => ({
  loadMergedConfig: vi.fn(() => ({})),
}));

vi.mock("../src/config/schema.js", () => ({
  parseConfig: vi.fn(() => mockState.config),
}));

vi.mock("../src/utils/files.js", () => ({
  hasProjectMarker: fileMocks.hasProjectMarker,
}));

vi.mock("../src/watcher/index.js", () => ({
  createWatcherWithIndexer: mockState.createWatcherWithIndexer,
}));

vi.mock("../src/utils/background-worker.js", () => ({
  configureBackgroundWorker: backgroundWorkerMocks.configureBackgroundWorker,
  stopBackgroundWorker: backgroundWorkerMocks.stopBackgroundWorker,
  updateBackgroundWorkerConfig: backgroundWorkerMocks.updateBackgroundWorkerConfig,
  waitForBackgroundWorkerStart: backgroundWorkerMocks.waitForBackgroundWorkerStart,
  isBackgroundWorkerLeader: vi.fn(() => false),
  isBackgroundWorkerManaged: vi.fn(() => false),
  requestBackgroundWorker: vi.fn(),
  requestBackgroundWorkerRefresh: vi.fn(),
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
    architecture_context: toolStub,
    code_communities: toolStub,
    index_visualize: toolStub,
    initializeTools: mockState.initializeTools,
    getIndexerForProject: vi.fn(() => mockState.indexer),
    getSharedIndexer: vi.fn(() => mockState.indexer),
  };
});

vi.mock("../src/routing-hints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/routing-hints.js")>();
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
    RoutingHintController: function (...args: ConstructorParameters<typeof actual.RoutingHintController>) {
      return mockState.realRouting
        ? new actual.RoutingHintController(...args)
        : new MockRoutingHintController();
    },
  };
});

import mod from "../src/index.js";
const plugin = mod.server;
import { configureAutoIndex, resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";
import type { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { OPENCODE_TOOL_NAMES } from "../src/tools/tool-names.js";

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
    mockState.realRouting = false;
    mockState.hints = ["runtime-routing-hint"];
    mockState.routingControllers.length = 0;
    mockState.createWatcherWithIndexer.mockClear();
    backgroundWorkerMocks.configureBackgroundWorker.mockReset();
    backgroundWorkerMocks.stopBackgroundWorker.mockReset().mockResolvedValue(undefined);
    backgroundWorkerMocks.updateBackgroundWorkerConfig.mockReset();
    fileMocks.hasProjectMarker.mockReset().mockReturnValue(true);
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
      expect(backgroundWorkerMocks.configureBackgroundWorker).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(homeLink, "opencode");
    } finally {
      warn.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not configure a worker when a project marker is required but missing", async () => {
    const projectRoot = "/tmp/missing-project-marker";
    mockState.config.indexing.autoIndex = true;
    mockState.config.indexing.watchFiles = true;
    fileMocks.hasProjectMarker.mockReturnValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);

      expect(mockState.createWatcherWithIndexer).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.configureBackgroundWorker).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(projectRoot, "opencode");
    } finally {
      warn.mockRestore();
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

  it("delegates watcher ownership to the background worker on reload", async () => {
    mockState.config.indexing.watchFiles = true;
    const projectRoot = "/tmp/reload-project";

    await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);
    await plugin({ directory: projectRoot } as Parameters<typeof plugin>[0]);

    expect(backgroundWorkerMocks.configureBackgroundWorker).toHaveBeenCalledTimes(2);
    expect(backgroundWorkerMocks.configureBackgroundWorker).toHaveBeenLastCalledWith(
      projectRoot,
      "opencode",
      mockState.config,
      expect.objectContaining({
        watcherFactory: expect.any(Function),
        watcherFactoryForConfig: expect.any(Function),
        replaceWatcher: true,
      }),
      { restartAutoIndex: true },
    );
  });

  it("clears the watcher factory when file watching is disabled", async () => {
    mockState.config.indexing.watchFiles = false;
    await plugin({ directory: "/tmp/unwatched-project" } as Parameters<typeof plugin>[0]);

    expect(backgroundWorkerMocks.configureBackgroundWorker).toHaveBeenCalledWith(
      "/tmp/unwatched-project",
      "opencode",
      mockState.config,
      expect.objectContaining({
        watcherFactory: null,
        watcherFactoryForConfig: expect.any(Function),
      }),
      { restartAutoIndex: true },
    );
  });

  it.each(["system", "developer"] as const)("retains real answer guidance after discovery through the %s hook", async (role) => {
    mockState.realRouting = true;
    mockState.config.search.routingHintRole = role;
    const runtime = await plugin({ directory: "/tmp/project" } as Parameters<typeof plugin>[0]);
    const message = runtime["chat.message"]!;
    const after = runtime["tool.execute.after"]!;
    const transform = runtime[`experimental.chat.${role}.transform`] as
      (input: { sessionID: string }, output: { system: string[]; developer: string[] }) => Promise<void>;
    await message({ sessionID: "real" }, {
      parts: [{ type: "text", text: "How does the retry queue work?" }],
    } as Parameters<typeof message>[1]);
    const first = { system: [] as string[], developer: [] as string[] };
    await transform({ sessionID: "real" }, first);
    expect(first[role]).toHaveLength(1);
    let retainedHint: string | undefined;
    for (const tool of ["codebase_context", "codebase_search", "read"]) {
      await after({ sessionID: "real", tool, callID: tool, args: {} }, { title: "", output: "", metadata: {} });
      const final = { system: [] as string[], developer: [] as string[] };
      await transform({ sessionID: "real" }, final);
      expect(final[role]).toHaveLength(1);
      expect(final[role][0]).toEqual(expect.any(String));
      expect(first[role][0]).toContain(final[role][0]);
      if (retainedHint !== undefined) expect(final[role][0]).toBe(retainedHint);
      retainedHint = final[role][0];
    }
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
