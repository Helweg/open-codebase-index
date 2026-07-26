import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  config: {
    search: {
      routingHints: true,
      routingGraphHandoffHints: false,
      routingHintRole: "system" as "system" | "developer",
    },
    indexing: {
      autoIndex: false,
      watchFiles: false,
      requireProjectMarker: true,
    },
  },
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
  createWatcherWithIndexer: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../src/commands/loader.js", () => ({
  loadCommandsFromDirectory: vi.fn(() => new Map()),
}));

vi.mock("../src/tools/index.js", () => {
  const toolStub = {};
  const indexerStub = {
    initialize: vi.fn().mockResolvedValue(undefined),
    index: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ indexed: true, compatibility: { compatible: true } }),
  };

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
    initializeTools: vi.fn(),
    getSharedIndexer: vi.fn(() => indexerStub),
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

describe("plugin routing hint hook selection", () => {
  beforeEach(() => {
    mockState.config = {
      search: {
        routingHints: true,
        routingGraphHandoffHints: false,
        routingHintRole: "system",
      },
      indexing: {
        autoIndex: false,
        watchFiles: false,
        requireProjectMarker: true,
      },
    };
    mockState.hints = ["runtime-routing-hint"];
    mockState.routingControllers.length = 0;
  });

  it("registers codebase_context in the native OpenCode tool map", async () => {
    const runtime = await plugin({ directory: "/tmp/project" } as Parameters<typeof plugin>[0]);

    expect(runtime.tool).toEqual(expect.objectContaining({
      codebase_context: expect.any(Object),
    }));
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
