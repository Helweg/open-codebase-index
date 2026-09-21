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
  commands: new Map<string, { description: string; template: string }>(),
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
  loadCommandsFromDirectory: vi.fn(() => mockState.commands),
}));

vi.mock("../src/tools/index.js", () => {
  const toolStub = {
    description: "stub tool description",
    args: {},
    execute: vi.fn(
      async (
        _args: unknown,
        ctx: { metadata?: (u: { title?: string; metadata?: Record<string, unknown> }) => void },
      ) => {
        ctx?.metadata?.({ title: "t", metadata: { k: 1 } });
        return "OK";
      },
    ),
  };
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

import mod from "../src/index.js";
import { configureAutoIndex, resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";
import type { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { parseConfig } from "../src/config/schema.js";

function createFakeContext(options?: {
  directory?: string;
  worktree?: string;
  canonical?: string;
}) {
  const dir = options?.directory ?? "/tmp/project";
  const worktreeDir = options?.worktree ?? dir;
  const canonicalDir = options?.canonical ?? dir;

  const addedTools: Array<{
    name: string;
    description: string;
    input: any;
    execute: (input: any, context: any) => Promise<any>;
  }> = [];
  const addedCommands: Array<{
    name: string;
    description?: string;
    execute: (input: any) => Promise<void>;
  }> = [];
  const sessionHooks = new Map<string, Function>();
  const toolHooks = new Map<string, Function>();
  const promptMock = vi.fn(async () => {});
  const disposeMocks: Array<ReturnType<typeof vi.fn>> = [];

  const createRegistration = () => {
    const dispose = vi.fn(async () => {});
    disposeMocks.push(dispose);
    return { dispose };
  };

  const ctx: any = {
    location: {
      directory: dir,
      project: {
        id: "p1",
        directory: worktreeDir,
        canonical: canonicalDir,
      },
    },
    options: {},
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    tool: {
      transform: vi.fn(async (cb: (editor: any) => void) => {
        cb({
          add: (t: any) => addedTools.push(t),
          namespace: vi.fn(),
          list: () => addedTools,
          get: (id: string) => addedTools.find((t) => t.name === id),
          update: vi.fn(),
          remove: vi.fn(),
        });
        return createRegistration();
      }),
      hook: vi.fn(async (name: string, cb: Function) => {
        toolHooks.set(name, cb);
        return createRegistration();
      }),
    },
    session: {
      hook: vi.fn(async (name: string, cb: Function) => {
        sessionHooks.set(name, cb);
        return createRegistration();
      }),
      prompt: promptMock,
    },
    command: {
      transform: vi.fn(async (cb: (editor: any) => void) => {
        cb({
          add: (c: any) => addedCommands.push(c),
        });
        return createRegistration();
      }),
    },
  };

  return {
    ctx,
    addedTools,
    addedCommands,
    sessionHooks,
    toolHooks,
    promptMock,
    disposeMocks,
  };
}

describe("OpenCode v2 plugin adapter (tests/plugin-v2.test.ts)", () => {
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
    mockState.commands = new Map();
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

  // Case 1: Shape
  it("1. exports default object satisfying v2 and v1 contracts", () => {
    expect(typeof mod).toBe("object");
    expect(mod).not.toBeNull();
    expect(typeof (mod as any).id).toBe("string");
    expect((mod as any).id.length).toBeGreaterThan(0);
    expect(typeof (mod as any).setup).toBe("function");
    expect(typeof (mod as any).server).toBe("function");
    expect("tui" in (mod as any)).toBe(false);
  });

  // Case 2: Tool parity — ungameable
  it("2. registers the exact derived v1 tool inventory with no omissions or phantoms", async () => {
    const v1Runtime = await (mod as any).server({ directory: "/tmp/project", worktree: "/tmp/project" });
    const v1Names = Object.keys(v1Runtime.tool ?? {}).sort();

    const { ctx, addedTools } = createFakeContext();
    await (mod as any).setup(ctx);

    const registeredNames = addedTools.map((t) => t.name).sort();
    expect(registeredNames.length).toBe(v1Names.length);
    expect(registeredNames).toEqual(v1Names);
  });

  // Case 3: Tool definitions are well formed
  it("3. ensures all registered tools are well-formed with valid schema and execution", async () => {
    const { ctx, addedTools } = createFakeContext();
    await (mod as any).setup(ctx);

    expect(addedTools.length).toBeGreaterThan(0);
    for (const toolDef of addedTools) {
      expect(typeof toolDef.name).toBe("string");
      expect(toolDef.name.length).toBeGreaterThan(0);
      expect(typeof toolDef.description).toBe("string");
      expect(toolDef.description.length).toBeGreaterThan(0);
      expect(toolDef.input).toBeDefined();

      const input = toolDef.input as
        | { "~standard"?: { validate: (v: unknown) => unknown | Promise<unknown> }; type?: string }
        | undefined;
      if (typeof input === "object" && input !== null && "~standard" in input && input["~standard"]) {
        expect(typeof input["~standard"].validate).toBe("function");

        const emptyResult = await input["~standard"].validate({});
        expect(typeof emptyResult).toBe("object");
        expect(emptyResult).not.toBeNull();
        const hasValueOrIssues =
          typeof emptyResult === "object" &&
          emptyResult !== null &&
          ("value" in emptyResult || "issues" in emptyResult);
        expect(hasValueOrIssues).toBe(true);

        const invalidResult = await input["~standard"].validate(42);
        expect(typeof invalidResult).toBe("object");
        expect(invalidResult).not.toBeNull();
        const issues =
          typeof invalidResult === "object" &&
          invalidResult !== null &&
          "issues" in invalidResult &&
          Array.isArray(invalidResult.issues)
            ? invalidResult.issues
            : [];
        expect(issues.length).toBeGreaterThan(0);
      } else {
        expect(typeof input === "object" && input !== null && input.type === "object").toBe(true);
      }

      expect(typeof toolDef.execute).toBe("function");
    }
  });

  // Case 4: Tool execute adaptation
  it("4. adapts v1 tool execution and context metadata to v2 Result and progress", async () => {
    const { ctx, addedTools } = createFakeContext();
    await (mod as any).setup(ctx);

    const firstTool = addedTools[0];
    expect(firstTool).toBeDefined();

    const progressMock = vi.fn();
    const fakeToolContext = {
      sessionID: "ses-test",
      signal: new AbortController().signal,
      progress: progressMock,
    };

    const result = await firstTool.execute({}, fakeToolContext);
    expect(result).toEqual({ content: "OK" });
    expect(progressMock).toHaveBeenCalledTimes(1);
    expect(progressMock).toHaveBeenCalledWith(expect.objectContaining({ title: "t", k: 1 }));
  });

  // Case 5: Commands
  it("5. registers commands and handles $ARGUMENTS expansion and mention stripping", async () => {
    mockState.commands = new Map([
      ["search", { description: "Search query", template: "Search for $ARGUMENTS now" }],
      ["review", { description: "Review changes", template: "Review prompt" }],
    ]);

    const { ctx, addedCommands, promptMock } = createFakeContext();
    await (mod as any).setup(ctx);

    expect(addedCommands.length).toBe(2);
    const searchCmd = addedCommands.find((c) => c.name === "search");
    const reviewCmd = addedCommands.find((c) => c.name === "review");

    expect(searchCmd).toBeDefined();
    expect(searchCmd?.description).toBe("Search query");

    // Test $ARGUMENTS expansion and mention removal
    await searchCmd?.execute({
      sessionID: "s1",
      prompt: {
        text: "auth flow",
        files: [{ path: "a.ts", mention: { start: 0, end: 5 } }],
        agents: [{ id: "ag1", mention: { start: 0, end: 4 } }],
        skills: [{ id: "sk1", mention: { start: 0, end: 4 } }],
      },
      delivery: "steer",
    });

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s1",
        text: "Search for auth flow now",
        delivery: "steer",
        files: [{ path: "a.ts" }],
        agents: [{ id: "ag1" }],
        skills: [{ id: "sk1" }],
      }),
    );

    // Test template without $ARGUMENTS -> appends argument
    await reviewCmd?.execute({
      sessionID: "s2",
      prompt: {
        text: "extra argument",
        files: [],
        agents: [],
        skills: [],
      },
      delivery: "queue",
    });

    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s2",
        text: "Review prompt\n\nextra argument",
        delivery: "queue",
      }),
    );
  });

  // Case 6: Hooks fire
  it("6. registers and correctly dispatches session and tool hooks", async () => {
    const { ctx, sessionHooks, toolHooks } = createFakeContext();
    await (mod as any).setup(ctx);

    expect(sessionHooks.has("prompt")).toBe(true);
    expect(sessionHooks.has("context")).toBe(true);
    expect(toolHooks.has("execute.after")).toBe(true);

    const controller = mockState.routingControllers[0];
    expect(controller).toBeDefined();

    // 1. prompt hook
    const promptHook = sessionHooks.get("prompt");
    await promptHook?.({
      sessionID: "s1",
      prompt: { text: "user message text" },
    });
    expect(controller.observeUserMessage).toHaveBeenCalledWith("s1", [{ type: "text", text: "user message text" }]);

    // 2. context hook
    controller.getSystemHints.mockResolvedValueOnce(["h1"]).mockResolvedValueOnce([]);
    const contextHook = sessionHooks.get("context");
    const contextEvent1 = { sessionID: "s1", system: [] as Array<{ type: string; text: string }> };
    await contextHook?.(contextEvent1);
    expect(controller.getSystemHints).toHaveBeenCalledWith("s1");
    expect(contextEvent1.system).toEqual([{ type: "text", text: "h1" }]);
    expect(typeof contextEvent1.system[0]).toBe("object");
    expect(contextEvent1.system[0]).toEqual({ type: "text", text: "h1" });

    const contextEvent2 = { sessionID: "s1", system: [] as Array<{ type: string; text: string }> };
    await contextHook?.(contextEvent2);
    expect(contextEvent2.system).toEqual([]);

    // 3. tool execute.after hook
    const toolAfterHook = toolHooks.get("execute.after");
    await toolAfterHook?.({
      sessionID: "s1",
      tool: "codebase_search",
    });
    expect(controller.markToolUsed).toHaveBeenCalledWith("s1", "codebase_search");
  });

  // Case 7: Developer-role fallback
  it("7. falls back developer-role routing hints into event.system on v2", async () => {
    mockState.config.search.routingHintRole = "developer";
    const { ctx, sessionHooks } = createFakeContext();
    await (mod as any).setup(ctx);

    const contextHook = sessionHooks.get("context");
    const contextEvent = { sessionID: "s2", system: [] as Array<{ type: string; text: string }> };
    await contextHook?.(contextEvent);

    expect(contextEvent.system).toEqual([{ type: "text", text: "runtime-routing-hint" }]);
  });

  // Case 8: Project root
  it("8. resolves project root according to git worktree status", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "v2-project-root-"));
    const selectedDir = path.join(tempDir, "selected");
    const gitWorktree = path.join(tempDir, "git-worktree");

    mkdirSync(selectedDir, { recursive: true });
    mkdirSync(path.join(gitWorktree, ".git"), { recursive: true });
    writeFileSync(path.join(gitWorktree, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");

    try {
      // 8a. Git worktree
      mockState.initializeTools.mockClear();
      const { ctx: gitCtx } = createFakeContext({ directory: selectedDir, worktree: gitWorktree });
      await (mod as any).setup(gitCtx);
      expect(mockState.initializeTools).toHaveBeenCalledWith(gitWorktree, expect.any(Object));

      // 8b. Non-git worktree falls back to directory
      mockState.initializeTools.mockClear();
      const nonGitWorktree = path.parse(tempDir).root;
      const { ctx: nonGitCtx } = createFakeContext({ directory: tempDir, worktree: nonGitWorktree });
      await (mod as any).setup(nonGitCtx);
      expect(mockState.initializeTools).toHaveBeenCalledWith(tempDir, expect.any(Object));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Case 9: Safety guards preserved
  it("9. preserves safety guards for home directory and missing project markers", async () => {
    // 9a. Home directory symlink
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "v2-home-symlink-"));
    const homeLink = path.join(tempDir, "home-link");
    symlinkSync(os.homedir(), homeLink, "dir");
    mockState.config.indexing.watchFiles = true;
    mockState.config.indexing.requireProjectMarker = false;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { ctx: homeCtx } = createFakeContext({ directory: homeLink });
      await (mod as any).setup(homeCtx);

      expect(mockState.createWatcherWithIndexer).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.configureBackgroundWorker).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(homeLink, "opencode", true);
    } finally {
      warn.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }

    // 9b. Missing project marker
    const projectRoot = "/tmp/v2-missing-marker";
    mockState.config.indexing.autoIndex = true;
    mockState.config.indexing.watchFiles = true;
    mockState.config.indexing.requireProjectMarker = true;
    fileMocks.hasProjectMarker.mockReturnValue(false);

    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ctx: markerCtx } = createFakeContext({ directory: projectRoot });
      await (mod as any).setup(markerCtx);

      expect(mockState.createWatcherWithIndexer).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.configureBackgroundWorker).not.toHaveBeenCalled();
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(projectRoot, "opencode", true);
    } finally {
      warn2.mockRestore();
    }
  });

  // Case 10: Failure degrades, never throws
  it("10. degrades safely without throwing when configuration parsing fails", async () => {
    vi.mocked(parseConfig).mockImplementationOnce(() => {
      throw new Error("Simulated config parse failure");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ctx, addedTools } = createFakeContext();
      const setupResult = await (mod as any).setup(ctx);

      expect(setupResult).toBeUndefined();
      expect(addedTools.length).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        "[codebase-index] Failed to initialize plugin (check config and network):",
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Case 11: Cleanup
  it("11. returns cleanup function that stops background worker and disposes registrations", async () => {
    const projectRoot = "/tmp/v2-cleanup-project";
    const { ctx, disposeMocks } = createFakeContext({ directory: projectRoot });

    const cleanup = await (mod as any).setup(ctx);
    expect(typeof cleanup).toBe("function");

    backgroundWorkerMocks.stopBackgroundWorker.mockClear();
    await cleanup();
    expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(projectRoot, "opencode", true);
    expect(disposeMocks.length).toBeGreaterThan(0);
    for (const dispose of disposeMocks) {
      expect(dispose).toHaveBeenCalled();
    }
  });

  // Case 12: Setup failure after worker start stops worker and disposes registrations
  it("12. stops worker and disposes registrations when setup fails after worker start", async () => {
    const projectRoot = "/tmp/v2-fail-cleanup-project";
    const { ctx, disposeMocks } = createFakeContext({ directory: projectRoot });

    ctx.command.transform.mockRejectedValueOnce(new Error("Simulated registration error"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      backgroundWorkerMocks.stopBackgroundWorker.mockClear();
      const setupResult = await (mod as any).setup(ctx);

      expect(setupResult).toBeUndefined();
      expect(backgroundWorkerMocks.stopBackgroundWorker).toHaveBeenCalledWith(projectRoot, "opencode", true);
      expect(disposeMocks.length).toBeGreaterThan(0);
      for (const dispose of disposeMocks) {
        expect(dispose).toHaveBeenCalled();
      }
      expect(errorSpy).toHaveBeenCalledWith(
        "[codebase-index] Failed to initialize plugin (check config and network):",
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Case 13: Registration disposal failure logging
  it("13. logs error when registration disposal rejects during cleanup", async () => {
    const projectRoot = "/tmp/v2-disposal-fail-project";
    const { ctx, disposeMocks } = createFakeContext({ directory: projectRoot });

    const cleanup = await (mod as any).setup(ctx);
    expect(typeof cleanup).toBe("function");

    const disposalError = new Error("Simulated disposal rejection");
    disposeMocks[0].mockRejectedValueOnce(disposalError);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await cleanup();
      expect(errorSpy).toHaveBeenCalledWith(
        "[codebase-index] Failed to dispose OpenCode v2 registration:",
        disposalError,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Case 14: Teardown worker stop failure logging
  it("14. logs error when background worker stop fails during setup failure teardown", async () => {
    const projectRoot = "/tmp/v2-teardown-fail-project";
    const { ctx } = createFakeContext({ directory: projectRoot });

    ctx.command.transform.mockRejectedValueOnce(new Error("Simulated setup error"));
    const stopError = new Error("Simulated stop failure");
    backgroundWorkerMocks.stopBackgroundWorker.mockRejectedValueOnce(stopError);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const setupResult = await (mod as any).setup(ctx);
      expect(setupResult).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        "[codebase-index] Failed to stop OpenCode background worker after failed setup:",
        stopError,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
