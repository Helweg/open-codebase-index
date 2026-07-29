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

  it("reloads without waiting for a stuck watcher or starting a redundant index", async () => {
    mockState.config.indexing.autoIndex = true;
    mockState.config.indexing.watchFiles = true;
    let resolveIndex: (() => void) | undefined;
    mockState.indexer.index.mockImplementationOnce(() => new Promise((resolve) => {
      resolveIndex = () => resolve({});
    }));
    const firstWatcher = {
      stop: vi.fn(() => new Promise<void>(() => {})),
    };
    const secondWatcher = { stop: vi.fn().mockResolvedValue(undefined) };
    mockState.createWatcherWithIndexer
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValueOnce(secondWatcher);

    await plugin({ directory: "/tmp/reload-project" } as Parameters<typeof plugin>[0]);
    await vi.waitFor(() => expect(mockState.indexer.index).toHaveBeenCalledOnce());

    await expect(plugin({ directory: "/tmp/reload-project" } as Parameters<typeof plugin>[0])).resolves.toBeDefined();

    expect(firstWatcher.stop).toHaveBeenCalledOnce();
    expect(mockState.indexer.index).toHaveBeenCalledOnce();
    resolveIndex?.();
    await vi.waitFor(() => expect(mockState.indexer.getStatus).toHaveBeenCalled());
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
