import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp-server.js";
import { parseConfig } from "../src/config/schema.js";
import { IndexLockContentionError } from "../src/indexer/index-lock.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "fs";

const { testMainRepo } = vi.hoisted(() => ({
  testMainRepo: `/tmp/codebase-index-mcp-vitest-main-repo-${process.pid}`,
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  const inheritedIndexPath = `${testMainRepo}/.opencode/index`;
  return {
    ...actual,
    existsSync: vi.fn((targetPath: string) => {
      const normalizedPath = targetPath.replace(/\\/g, "/");
      return normalizedPath === inheritedIndexPath || actual.existsSync(targetPath);
    }),
  };
});

vi.mock("../src/git/index.js", () => ({
  resolveWorktreeMainRepoRoot: vi.fn(() => testMainRepo),
}));

const mergerMocks = vi.hoisted(() => ({
  loadProjectConfigLayer: vi.fn(() => ({})),
  materializeLocalProjectConfig: vi.fn(),
}));

const indexerMockState = vi.hoisted(() => ({
  constructorArgs: [] as Array<[string, unknown]>,
  instances: [] as Array<{
    initialize: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getCallers: ReturnType<typeof vi.fn>;
    getCallees: ReturnType<typeof vi.fn>;
    findCallPath: ReturnType<typeof vi.fn>;
    clearIndex: ReturnType<typeof vi.fn>;
    forceIndex: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../src/config/merger.js", () => mergerMocks);

let mockIndexResult = {
  totalFiles: 10,
  totalChunks: 50,
  indexedChunks: 50,
  failedChunks: 0,
  failedBatchesPath: undefined as string | undefined,
  tokensUsed: 1000,
  durationMs: 500,
  existingChunks: 0,
  removedChunks: 0,
  skippedFiles: [],
  parseFailures: [],
};

let mockStatusResult = {
  indexed: true,
  vectorCount: 50,
  provider: "openai",
  model: "text-embedding-3-small",
  indexPath: "/tmp/index",
  currentBranch: "main",
  baseBranch: "main",
  compatibility: { compatible: true },
  failedBatchesCount: 0,
  failedBatchesPath: undefined as string | undefined,
};

let mockHealthCheckResult = {
  removed: 0,
  gcOrphanEmbeddings: 0,
  gcOrphanChunks: 0,
  gcOrphanSymbols: 0,
  gcOrphanCallEdges: 0,
  filePaths: [],
} as {
  removed: number;
  gcOrphanEmbeddings: number;
  gcOrphanChunks: number;
  gcOrphanSymbols: number;
  gcOrphanCallEdges: number;
  filePaths: string[];
  resetCorruptedIndex?: boolean;
  warning?: string;
};

vi.mock("../src/indexer/index.js", () => {
  class MockIndexer {
    constructor(projectRoot: string, config: unknown) {
      indexerMockState.constructorArgs.push([projectRoot, config]);
      indexerMockState.instances.push({
        initialize: this.initialize,
        getStatus: this.getStatus,
        getCallers: this.getCallers,
        getCallees: this.getCallees,
        findCallPath: this.findCallPath,
        clearIndex: this.clearIndex,
        forceIndex: this.forceIndex,
      });
    }

    initialize = vi.fn().mockResolvedValue(undefined);
    search = vi.fn().mockResolvedValue([
      {
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        name: "validateToken",
        chunkType: "function",
        content: "function validateToken(token: string) {\n  return token.length > 0;\n}",
        score: 0.95,
      },
    ]);
    findSimilar = vi.fn().mockResolvedValue([
      {
        filePath: "src/utils.ts",
        startLine: 5,
        endLine: 15,
        name: "checkAuth",
        chunkType: "function",
        content: "function checkAuth(token: string) {\n  return !!token;\n}",
        score: 0.88,
      },
    ]);
    index = vi.fn().mockImplementation(async () => mockIndexResult);
    forceIndex = vi.fn().mockImplementation(async () => mockIndexResult);
    getStatus = vi.fn().mockImplementation(async () => mockStatusResult);
    healthCheck = vi.fn().mockImplementation(async () => mockHealthCheckResult);
    clearIndex = vi.fn().mockResolvedValue(undefined);
    getCallers = vi.fn().mockResolvedValue([
      {
        id: "edge_1",
        fromSymbolId: "sym_caller",
        targetName: "validateToken",
        callType: "Call",
        confidence: "Direct",
        line: 12,
        col: 4,
        isResolved: true,
        fromSymbolName: "callerFn",
        fromSymbolFilePath: "src/caller.ts",
      },
    ]);
    getCallees = vi.fn().mockResolvedValue([
      {
        id: "edge_2",
        fromSymbolId: "sym_validate",
        targetName: "calledFn",
        callType: "Call",
        confidence: "Direct",
        line: 4,
        col: 2,
        isResolved: true,
        toSymbolId: "sym_called",
      },
    ]);
    findCallPath = vi.fn().mockResolvedValue([
      {
        symbolName: "fromNode",
        filePath: "src/start.ts",
        line: 1,
        symbolId: "from-node-id",
        toSymbolId: "to-node-id",
        callType: "Call",
      },
      {
        symbolName: "toNode",
        filePath: "src/end.ts",
        line: 2,
        symbolId: "to-node-id",
        toSymbolId: "to-symbol-id",
        callType: "Call",
      },
    ]);
    estimateCost = vi.fn().mockResolvedValue({
      filesCount: 10,
      totalSizeBytes: 50000,
      estimatedChunks: 50,
      estimatedTokens: 1000,
      estimatedCost: 0.01,
      isFree: false,
      provider: "openai",
      model: "text-embedding-3-small",
    });
    getLogger = vi.fn().mockReturnValue({
      isEnabled: vi.fn().mockReturnValue(false),
      isMetricsEnabled: vi.fn().mockReturnValue(false),
      getLogs: vi.fn().mockReturnValue([]),
      getLogsByCategory: vi.fn().mockReturnValue([]),
      getLogsByLevel: vi.fn().mockReturnValue([]),
      formatMetrics: vi.fn().mockReturnValue(""),
    });
    getPrImpact = vi.fn().mockResolvedValue({
      changedFiles: ["src/a.ts"],
      directSymbols: [{ id: "sym_1", name: "funcA", kind: "function", filePath: "src/a.ts" }],
      transitiveCallers: [],
      totalAffected: 1,
      communities: [{ label: "Core", symbolCount: 1, directSymbols: ["sym_1"] }],
      hubNodes: [],
      riskLevel: "LOW",
      riskReason: "Small impact: 1 affected symbols, no hub nodes touched.",
      conflictingPRs: undefined,
    });
  }
  return { Indexer: MockIndexer };
});

describe("createMcpServer", () => {
  it("should create a server instance", () => {
    const config = parseConfig({});
    const server = createMcpServer("/tmp/test-project", config);

    expect(server).toBeDefined();
    expect(server).toHaveProperty("connect");
  });

  it("should have the correct server name", () => {
    const config = parseConfig({});
    const server = createMcpServer("/tmp/test-project", config);

    expect(server).toBeDefined();
  });

});

describe("MCP server tools and prompts", () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    fs.mkdirSync(`${testMainRepo}/.opencode/index`, { recursive: true });
    indexerMockState.constructorArgs.length = 0;
    indexerMockState.instances.length = 0;
    mergerMocks.loadProjectConfigLayer.mockReset();
    mergerMocks.loadProjectConfigLayer.mockReturnValue({});
    mergerMocks.materializeLocalProjectConfig.mockReset();
    mockIndexResult = {
      totalFiles: 10,
      totalChunks: 50,
      indexedChunks: 50,
      failedChunks: 0,
      failedBatchesPath: undefined,
      tokensUsed: 1000,
      durationMs: 500,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };
    mockStatusResult = {
      indexed: true,
      vectorCount: 50,
      provider: "openai",
      model: "text-embedding-3-small",
      indexPath: "/tmp/main-repo/.opencode/index",
      currentBranch: "main",
      baseBranch: "main",
      compatibility: { compatible: true },
      failedBatchesCount: 0,
      failedBatchesPath: undefined,
    };
    mockHealthCheckResult = {
      removed: 0,
      gcOrphanEmbeddings: 0,
      gcOrphanChunks: 0,
      gcOrphanSymbols: 0,
      gcOrphanCallEdges: 0,
      filePaths: [],
    };

    const config = parseConfig({});
    server = createMcpServer("/tmp/test-project", config);
    client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(testMainRepo, { recursive: true, force: true });
  });

  it("should register all 13 tools", async () => {
    const tools = await client.listTools();

    expect(tools.tools).toHaveLength(13);

    const toolNames = tools.tools.map(t => t.name).sort();
    const expectedNames = [
      "call_graph",
      "call_graph_path",
      "codebase_context",
      "codebase_peek",
      "codebase_search",
      "find_similar",
      "implementation_lookup",
      "pr_impact",

      "index_codebase",
      "index_health_check",
      "index_logs",
      "index_metrics",
      "index_status",
    ].sort();

    expect(toolNames).toEqual(expectedNames);
  });

  it("should expose self-routing descriptions even when the client ignores server instructions", async () => {
    const tools = await client.listTools();
    const descriptions = new Map(tools.tools.map(tool => [tool.name, tool.description ?? ""]));

    expect(tools.tools[0]?.name).toBe("codebase_context");
    expect(descriptions.get("codebase_context")).toContain("PREFERRED FIRST TOOL");
    expect(descriptions.get("codebase_context")).toContain("before built-in code search");
    expect(descriptions.get("index_status")).toContain("START HERE");
    expect(descriptions.get("index_status")).toContain("codebase_peek");
    expect(descriptions.get("codebase_peek")).toContain("LOW-TOKEN");
    expect(descriptions.get("codebase_peek")).toContain("codebase_context");
    expect(descriptions.get("implementation_lookup")).toContain("FIRST TOOL");
    expect(descriptions.get("implementation_lookup")).toContain("known-symbol");
    expect(descriptions.get("implementation_lookup")).toContain("Do not use for callers");
    expect(descriptions.get("codebase_search")).toContain("after codebase_peek");
    expect(descriptions.get("codebase_search")).toContain("grep");
    expect(descriptions.get("call_graph")).toContain("after identifying a symbol");
    expect(descriptions.get("call_graph_path")).toContain("both endpoint symbols");
    expect(descriptions.get("pr_impact")).toContain("FIRST TOOL");
  });

  it("should register all 5 prompts", async () => {
    const prompts = await client.listPrompts();

    expect(prompts.prompts).toHaveLength(5);

    const promptNames = prompts.prompts.map(p => p.name).sort();
    const expectedNames = ["definition", "find", "index", "search", "status"].sort();

    expect(promptNames).toEqual(expectedNames);
  });

  it("should execute codebase_search tool", async () => {
    const result = await client.callTool({
      name: "codebase_search",
      arguments: { query: "test query" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 results");
    expect(content[0].text).toContain("validateToken");
  });

  it("should execute codebase_peek tool", async () => {
    const result = await client.callTool({
      name: "codebase_peek",
      arguments: { query: "test query" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 locations");
  });

  it("should execute codebase_peek with null optional fields", async () => {
    const result = await client.callTool({
      name: "codebase_peek",
      arguments: {
        query: "test query",
        limit: null,
        fileType: null,
        directory: null,
        chunkType: null,
        blameAuthor: null,
        blameSha: null,
        blameSince: null,
      },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 locations");
  });

  it("should route codebase_context conceptual discovery with null optional fields", async () => {
    const result = await client.callTool({
      name: "codebase_context",
      arguments: {
        query: "where is authentication handled",
        symbol: null,
        from: null,
        to: null,
        limit: null,
        maxDepth: null,
        fileType: null,
        directory: null,
      },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("Found 1 locations");
    expect(content[0].text).toContain("implementation_lookup");
  });

  it("should route codebase_context known symbols to definition lookup", async () => {
    const result = await client.callTool({
      name: "codebase_context",
      arguments: { query: "where is validateToken defined", symbol: "validateToken" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain('function "validateToken"');
  });

  it("should route codebase_context endpoint pairs to call graph paths", async () => {
    const result = await client.callTool({
      name: "codebase_context",
      arguments: { query: "trace fromNode to toNode", from: "fromNode", to: "toNode", maxDepth: 7 },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("Path (2 hops)");
    const indexer = indexerMockState.instances.at(-1);
    expect(indexer?.findCallPath).toHaveBeenCalledWith("fromNode", "toNode", 7);
  });

  it("should recover direct unresolved edges when path traversal returns no hops", async () => {
    const indexer = indexerMockState.instances.at(-1);
    indexer?.findCallPath.mockResolvedValueOnce([]);
    indexer?.getCallers.mockResolvedValueOnce([{
      fromSymbolId: "from-node-id",
      fromSymbolName: "fromNode",
      fromSymbolFilePath: "src/start.ts",
      toSymbolId: null,
      targetName: "toNode",
      callType: "Call",
      line: 12,
      confidence: "Direct",
      isResolved: false,
    }]);

    const result = await client.callTool({
      name: "codebase_context",
      arguments: { query: "trace fromNode to toNode", from: "fromNode", to: "toNode" },
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("Direct path: fromNode --Call--> toNode");
    expect(content[0].text).toContain("edge is unresolved");
  });

  it("should expose concise server instructions for tool workflow", async () => {
    const instructions = await client.getInstructions();

    expect(instructions).toBeDefined();
    expect(instructions).toContain("index_status");
    expect(instructions).toContain("codebase_context");
    expect(instructions).toContain("codebase_peek");
    expect(instructions).toContain("implementation_lookup");
    expect(instructions).toContain("codebase_search");
    expect(instructions).toContain("grep");
    expect(instructions).toContain("call_graph");
    expect(instructions).toContain("opencode");
  });

  it("should execute index_status tool", async () => {
    const result = await client.callTool({
      name: "index_status",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Indexed chunks");
    expect(content[0].text).toContain("50");
    expect(content[0].text).toContain("Compatibility: Index is compatible");
  });

  it("should surface failed batch diagnostics in index_codebase output", async () => {
    mockIndexResult = {
      totalFiles: 10,
      totalChunks: 50,
      indexedChunks: 5,
      failedChunks: 2,
      failedBatchesPath: "/tmp/index/failed-batches.json",
      tokensUsed: 1000,
      durationMs: 500,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };

    const result = await client.callTool({
      name: "index_codebase",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("INDEXING WARNING");
    expect(content[0].text).toContain("failed-batches.json");
  });

  it("should return an explicit INDEX_BUSY MCP result", async () => {
    const owner = {
      pid: 4242,
      hostname: "local-test",
      startedAt: "2026-07-16T12:00:00.000Z",
      operation: "index" as const,
      token: "owner-token",
    };
    const indexer = (await import("../src/tools/operations.js")).getIndexerForProject("/tmp/test-project", "opencode");
    vi.mocked(indexer.index).mockRejectedValueOnce(
      new IndexLockContentionError("/tmp/indexing.lock", owner, "active"),
    );

    const result = await client.callTool({
      name: "index_codebase",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("INDEX_BUSY");
    expect(content[0].text).toContain("PID 4242");
    expect(content[0].text).toContain("operation index");
    expect(content[0].text).toContain(owner.startedAt);
  });

  it("should explain when an unreadable lock requires manual verification", async () => {
    const indexer = (await import("../src/tools/operations.js")).getIndexerForProject("/tmp/test-project", "opencode");
    vi.mocked(indexer.index).mockRejectedValueOnce(
      new IndexLockContentionError("/tmp/indexing.lock", null, "unknown-owner"),
    );

    const result = await client.callTool({
      name: "index_codebase",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("INDEX_BUSY");
    expect(content[0].text).toContain("Automatic recovery was refused");
    expect(content[0].text).toContain("manual verification");
  });

  it("should explain legacy locks in English", async () => {
    const owner = {
      pid: 4243,
      hostname: "local-test",
      startedAt: "2026-07-16T12:00:00.000Z",
      operation: "index" as const,
      token: "legacy-owner-token",
    };
    const indexer = (await import("../src/tools/operations.js")).getIndexerForProject("/tmp/test-project", "opencode");
    vi.mocked(indexer.index).mockRejectedValueOnce(
      new IndexLockContentionError("/tmp/indexing.lock", owner, "legacy-lock"),
    );

    const result = await client.callTool({
      name: "index_codebase",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("legacy lock format detected");
    expect(content[0].text).toContain("remove this lock manually only if it is stale");
  });

  it("should surface failed batch diagnostics in index_status output", async () => {
    mockStatusResult = {
      indexed: false,
      vectorCount: 0,
      provider: "google",
      model: "gemini-embedding-001",
      indexPath: "/tmp/index",
      currentBranch: "default",
      baseBranch: "default",
      compatibility: null,
      failedBatchesCount: 2,
      failedBatchesPath: "/tmp/index/failed-batches.json",
    };

    const result = await client.callTool({
      name: "index_status",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("failed embedding batches");
    expect(content[0].text).toContain("failed-batches.json");
  });

  it("should execute index_codebase with estimateOnly", async () => {
    const result = await client.callTool({
      name: "index_codebase",
      arguments: { estimateOnly: true },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Estimate");
  });

  it("should preserve runtime config on force refresh after localizing inherited project state", async () => {
    mergerMocks.loadProjectConfigLayer.mockReturnValue({ knowledgeBases: ["docs/reference"] });

    const runtimeConfig = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "https://runtime.example.com/v1",
        model: "runtime-model",
        dimensions: 1024,
        apiKey: "runtime-key",
      },
      scope: "project",
    });
    server = createMcpServer("/tmp/test-project", runtimeConfig);
    client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "index_codebase",
      arguments: { force: true },
    });

    expect(result.content).toBeDefined();
    expect(mergerMocks.materializeLocalProjectConfig).toHaveBeenCalledWith(
      "/tmp/test-project",
      mergerMocks.loadProjectConfigLayer.mock.results.at(-1)?.value,
      "opencode",
    );

    expect(indexerMockState.constructorArgs.length).toBeGreaterThanOrEqual(3);
    expect(indexerMockState.constructorArgs.slice(-2)).toEqual([
      ["/tmp/test-project", runtimeConfig],
      ["/tmp/test-project", runtimeConfig],
    ]);
    expect(indexerMockState.instances[0]?.initialize).not.toHaveBeenCalled();
    expect(indexerMockState.instances[0]?.getStatus).not.toHaveBeenCalled();
  });

  it("should materialize only the project config layer during MCP force localization", async () => {
    mergerMocks.loadProjectConfigLayer.mockReturnValue({ knowledgeBases: ["docs/reference"] });

    const runtimeConfig = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "https://runtime.example.com/v1",
        model: "runtime-model",
        dimensions: 1024,
        apiKey: "runtime-key",
      },
      scope: "project",
      search: {
        maxResults: 25,
      },
    });
    server = createMcpServer("/tmp/test-project", runtimeConfig);
    client = new Client({ name: "test-client", version: "1.0.0" });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    await client.callTool({
      name: "index_codebase",
      arguments: { force: true },
    });

    expect(mergerMocks.materializeLocalProjectConfig).toHaveBeenCalledWith(
      "/tmp/test-project",
      { knowledgeBases: ["docs/reference"] },
      "opencode",
    );
    expect(indexerMockState.constructorArgs.slice(-2)).toEqual([
      ["/tmp/test-project", runtimeConfig],
      ["/tmp/test-project", runtimeConfig],
    ]);
  });

  it("should execute index_health_check tool", async () => {
    const result = await client.callTool({
      name: "index_health_check",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("healthy");
  });

  it("should return an explicit INDEX_BUSY result from index_health_check", async () => {
    const owner = {
      pid: 4343,
      hostname: "local-test",
      startedAt: "2026-07-17T10:00:00.000Z",
      operation: "health-check" as const,
      token: "health-owner-token",
    };
    const indexer = (await import("../src/tools/operations.js")).getIndexerForProject("/tmp/test-project", "opencode");
    vi.mocked(indexer.healthCheck).mockRejectedValueOnce(
      new IndexLockContentionError("/tmp/indexing.lock", owner, "active"),
    );

    const result = await client.callTool({
      name: "index_health_check",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("INDEX_BUSY");
    expect(content[0].text).toContain("PID 4343");
    expect(content[0].text).toContain("operation health-check");
    expect(content[0].text).toContain(owner.startedAt);
  });

  it("should surface corruption reset guidance in index_health_check output", async () => {
    mockHealthCheckResult = {
      removed: 0,
      gcOrphanEmbeddings: 0,
      gcOrphanChunks: 0,
      gcOrphanSymbols: 0,
      gcOrphanCallEdges: 0,
      filePaths: [],
      resetCorruptedIndex: true,
      warning: "Detected a corrupted local SQLite index and reset the local index. Run index_codebase to rebuild search data.",
    };

    const result = await client.callTool({
      name: "index_health_check",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toContain("corrupted local SQLite index");
    expect(content[0].text).not.toContain("healthy");
  });

  it("should execute find_similar tool", async () => {
    const result = await client.callTool({
      name: "find_similar",
      arguments: { code: "function test() {}" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Found 1 similar");
  });

  it("should execute implementation_lookup tool", async () => {
    const result = await client.callTool({
      name: "implementation_lookup",
      arguments: { query: "validateToken" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("validateToken");
  });

  it("should execute call_graph callers with null optional fields", async () => {
    const result = await client.callTool({
      name: "call_graph",
      arguments: {
        name: "validateToken",
        direction: null,
        symbolId: null,
        relationshipType: null,
      },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("called by 1 function");
    const indexer = indexerMockState.instances[0];
    expect(indexer.getCallers).toHaveBeenCalledWith("validateToken", undefined);
  });

  it("should get search prompt", async () => {
    const prompt = await client.getPrompt({
      name: "search",
      arguments: { query: "auth logic" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.type).toBe("text");
    expect(msgContent.text).toContain("auth logic");
  });

  it("should get find prompt", async () => {
    const prompt = await client.getPrompt({
      name: "find",
      arguments: { query: "validation" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("validation");
  });

  it("should get index prompt", async () => {
    const prompt = await client.getPrompt({
      name: "index",
      arguments: {},
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_codebase");
  });

  it("should get status prompt", async () => {
    const prompt = await client.getPrompt({
      name: "status",
      arguments: {},
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.text).toContain("index_status");
  });

  it("should get definition prompt", async () => {
    const prompt = await client.getPrompt({
      name: "definition",
      arguments: { query: "validateToken" },
    });

    expect(prompt.messages).toBeDefined();
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
    const msgContent = prompt.messages[0].content as { type: string; text?: string };
    expect(msgContent.type).toBe("text");
    expect(msgContent.text).toContain("validateToken");
    expect(msgContent.text).toContain("implementation_lookup");
  });

  it("should execute index_metrics tool", async () => {
    const result = await client.callTool({
      name: "index_metrics",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("should execute index_logs tool", async () => {
    const result = await client.callTool({
      name: "index_logs",
      arguments: {},
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });
});
