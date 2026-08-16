import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchTrace } from "../src/indexer/index.js";

import { codebase_context as opencodeCodebaseContext } from "../src/adapters/opencode/tools.js";
import { countContextTokens } from "../src/tools/utils.js";
import { resolveCodebaseContext, resolveSearchContext } from "../src/tools/context.js";

const operationMocks = vi.hoisted(() => ({
  searchCodebase: vi.fn(),
  searchCodebaseWithEffectiveness: vi.fn(),
  implementationLookup: vi.fn(),
  getCallGraphPath: vi.fn(),
  getCallGraphData: vi.fn(),
  recordToolEffectiveness: vi.fn(),
  isToolEffectivenessEnabled: vi.fn(() => true),
  getIndexMetrics: vi.fn(() => ({ text: "metrics" })),
}));

vi.mock("../src/tools/operations.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/operations.js")>("../src/tools/operations.js");
  return {
    ...actual,
    searchCodebase: operationMocks.searchCodebase,
    searchCodebaseWithEffectiveness: operationMocks.searchCodebaseWithEffectiveness,
    implementationLookup: operationMocks.implementationLookup,
    getCallGraphPath: operationMocks.getCallGraphPath,
    getCallGraphData: operationMocks.getCallGraphData,
    recordToolEffectiveness: operationMocks.recordToolEffectiveness,
    isToolEffectivenessEnabled: operationMocks.isToolEffectivenessEnabled,
    getIndexMetrics: operationMocks.getIndexMetrics,
  };
});

import { codebase_context, codebase_peek, codebase_search, index_metrics } from "../src/tools/index.js";

const context = { worktree: "/repo" };
const commonArgs = {
  from: undefined,
  to: undefined,
  fromFilePath: undefined,
  toFilePath: undefined,
  symbol: undefined,
  limit: 10,
  maxDepth: 10,
  fileType: undefined,
  directory: undefined,
  tokenBudget: 128,
};

describe("native OpenCode codebase_context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    operationMocks.isToolEffectivenessEnabled.mockReturnValue(true);
    operationMocks.searchCodebase.mockResolvedValue([]);
    operationMocks.searchCodebaseWithEffectiveness.mockImplementation(
      async (projectRoot, host, route, query, options, render) => {
        try {
          const results = await operationMocks.searchCodebase(projectRoot, host, query, options);
          const rendered = render(results);
          operationMocks.recordToolEffectiveness(projectRoot, host, {
            route,
            host,
            outcome: results.length > 0 ? "success" : "no-result",
            resultCount: results.length,
            returnedTokenEstimate: countContextTokens(rendered.text),
            exactHandoffEmitted: rendered.text.includes("Exact-search handoff:"),
          });
          return rendered.output;
        } catch (error) {
          operationMocks.recordToolEffectiveness(projectRoot, host, {
            route,
            host,
            outcome: "error",
            resultCount: 0,
            returnedTokenEstimate: 0,
          });
          throw error;
        }
      },
    );
    operationMocks.implementationLookup.mockResolvedValue([]);
    operationMocks.getCallGraphPath.mockResolvedValue({
      from: { status: "not_found", name: "", candidates: [], totalCandidates: 0 },
      to: { status: "not_found", name: "", candidates: [], totalCandidates: 0 },
      path: [],
    });
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callers",
      resolution: { status: "not_found", name: "", candidates: [], totalCandidates: 0 },
      callers: [],
      callees: [],
    });
  });

  it("marks OpenCode peek and search routes for effectiveness aggregation", async () => {
    operationMocks.searchCodebase.mockResolvedValue([]);

    await codebase_peek.execute({
      query: "request routing",
      limit: 10,
      fileType: undefined,
      directory: undefined,
      chunkType: undefined,
      blameAuthor: undefined,
      blameSha: undefined,
      blameSince: undefined,
      blameUntil: undefined,
    }, context);
    expect(operationMocks.searchCodebaseWithEffectiveness).toHaveBeenLastCalledWith("/repo", "opencode", "peek", "request routing", expect.objectContaining({
      metadataOnly: true,
    }), expect.any(Function));

    await codebase_search.execute({
      query: "request routing",
      limit: 5,
      fileType: undefined,
      directory: undefined,
      chunkType: undefined,
      contextLines: undefined,
      blameAuthor: undefined,
      blameSha: undefined,
      blameSince: undefined,
      blameUntil: undefined,
    }, context);
    expect(operationMocks.searchCodebaseWithEffectiveness).toHaveBeenLastCalledWith(
      "/repo",
      "opencode",
      "search",
      "request routing",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("records OpenCode tokens from final text once and treats formatter failures as errors", async () => {
    operationMocks.searchCodebase.mockResolvedValueOnce([]);
    const output = await codebase_search.execute({
      query: "no matches",
      limit: 5,
      fileType: undefined,
      directory: undefined,
      chunkType: undefined,
      contextLines: undefined,
      blameAuthor: undefined,
      blameSha: undefined,
      blameSince: undefined,
      blameUntil: undefined,
    }, context);
    expect(operationMocks.recordToolEffectiveness).toHaveBeenCalledTimes(1);
    expect(operationMocks.recordToolEffectiveness).toHaveBeenLastCalledWith("/repo", "opencode", expect.objectContaining({
      route: "search",
      outcome: "no-result",
      returnedTokenEstimate: countContextTokens(output),
    }));

    operationMocks.recordToolEffectiveness.mockClear();
    const broken = {
      startLine: 1,
      endLine: 2,
      name: "broken",
      chunkType: "function",
      content: "source",
      score: 0.9,
      get filePath(): string {
        throw new Error("OpenCode formatter failed");
      },
    };
    operationMocks.searchCodebase.mockResolvedValueOnce([broken]);
    await expect(codebase_search.execute({
      query: "broken formatter",
      limit: 5,
      fileType: undefined,
      directory: undefined,
      chunkType: undefined,
      contextLines: undefined,
      blameAuthor: undefined,
      blameSha: undefined,
      blameSince: undefined,
      blameUntil: undefined,
    }, context)).rejects.toThrow("OpenCode formatter failed");
    expect(operationMocks.recordToolEffectiveness).toHaveBeenCalledTimes(1);
    expect(operationMocks.recordToolEffectiveness).toHaveBeenLastCalledWith("/repo", "opencode", expect.objectContaining({
      route: "search",
      outcome: "error",
      returnedTokenEstimate: 0,
    }));
  });

  it("forwards OpenCode metrics reset without recording another tool event", async () => {
    operationMocks.getIndexMetrics.mockClear();
    operationMocks.recordToolEffectiveness.mockClear();

    await index_metrics.execute({ reset: true }, context);

    expect(operationMocks.getIndexMetrics).toHaveBeenCalledWith("/repo", "opencode", { reset: true });
    expect(operationMocks.recordToolEffectiveness).not.toHaveBeenCalled();
  });

  it("records bounded context recovery and scope-relaxation categories", async () => {
    operationMocks.searchCodebase
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        filePath: "src/auth.ts",
        startLine: 1,
        endLine: 5,
        name: "authHandler",
        chunkType: "function",
        content: "sensitive source",
        score: 0.9,
      }]);

    await codebase_context.execute({
      ...commonArgs,
      query: "find request helpers",
      fileType: "ts",
      directory: "src",
    }, context);

    expect(operationMocks.recordToolEffectiveness).toHaveBeenCalledWith("/repo", "opencode", expect.objectContaining({
      route: "context-conceptual",
      host: "opencode",
      outcome: "success",
      recoveryUsed: true,
      resultCount: 1,
      scopeRelaxation: "both",
      exactHandoffEmitted: true,
    }));
    expect(JSON.stringify(operationMocks.recordToolEffectiveness.mock.calls)).not.toContain("sensitive source");
    expect(JSON.stringify(operationMocks.recordToolEffectiveness.mock.calls)).not.toContain("src/auth.ts");
    expect(JSON.stringify(operationMocks.recordToolEffectiveness.mock.calls)).not.toContain("authHandler");
  });

  it("returns a bounded conceptual evidence pack without source content", async () => {
    operationMocks.searchCodebase.mockResolvedValue(Array.from({ length: 12 }, (_, index) => ({
      filePath: `src/${"long-directory/".repeat(8)}file-${index}.ts`,
      startLine: index * 10 + 1,
      endLine: index * 10 + 8,
      name: `handler${index}`,
      chunkType: "function",
      content: `function handler${index}() { return "secret source"; }`,
      score: 1 - index / 100,
    })));

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "where is request handling implemented",
    }, context);

    expect(operationMocks.searchCodebase).toHaveBeenCalledWith("/repo", "opencode", "where is request handling implemented", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
      metadataOnly: true,
      prioritizeSourcePaths: expect.any(Boolean),
    });
    expect(result).toContain("Codebase evidence");
    expect(result).toContain("2 additional results excluded by result limit");
    expect(result).not.toContain("secret source");
    expect(countContextTokens(result)).toBeLessThanOrEqual(128);
  });

  it("includes result-derived exact-search handoffs in conceptual packs", async () => {
    operationMocks.searchCodebase.mockResolvedValue([{
      filePath: "src/auth.ts",
      startLine: 12,
      endLine: 30,
      name: "validateToken",
      chunkType: "function",
      content: "secret source",
      score: 0.99,
    }]);

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "how is authentication validated",
      tokenBudget: 512,
    }, context);

    expect(result).toContain('Exact-search handoff: use exact grep/search for "validateToken"');
    expect(result).not.toContain("secret source");
    expect(countContextTokens(result)).toBeLessThanOrEqual(512);
  });

  it("packs implementation evidence before higher-scoring docs for source-intent queries", async () => {
    operationMocks.searchCodebase.mockResolvedValue([
      {
        filePath: "README.md",
        startLine: 1,
        endLine: 10,
        chunkType: "other",
        content: "documentation",
        score: 0.99,
      },
      {
        filePath: "src/auth.ts",
        startLine: 20,
        endLine: 40,
        name: "validateToken",
        chunkType: "function",
        content: "implementation",
        score: 0.60,
      },
    ]);

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "where is authentication implemented",
      tokenBudget: 512,
    }, context);

    expect(result.indexOf("src/auth.ts")).toBeLessThan(result.indexOf("README.md"));
  });

  it("keeps higher-scoring docs first for documentation-intent queries", async () => {
    operationMocks.searchCodebase.mockResolvedValue([
      {
        filePath: "README.md",
        startLine: 1,
        endLine: 10,
        chunkType: "other",
        content: "documentation",
        score: 0.99,
      },
      {
        filePath: "src/auth.ts",
        startLine: 20,
        endLine: 40,
        name: "validateToken",
        chunkType: "function",
        content: "implementation",
        score: 0.60,
      },
    ]);

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "show the authentication documentation",
      tokenBudget: 512,
    }, context);

    expect(result.indexOf("README.md")).toBeLessThan(result.indexOf("src/auth.ts"));
  });

  it("routes explicit definitions to compact location evidence", async () => {
    operationMocks.implementationLookup.mockResolvedValue([{
      filePath: "src/auth.ts",
      startLine: 12,
      endLine: 30,
      name: "validateToken",
      chunkType: "function",
      content: "function validateToken() { return fullSource; }",
      score: 0.99,
    }]);

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "where is validateToken defined",
      symbol: "validateToken",
    }, context);

    expect(operationMocks.implementationLookup).toHaveBeenCalledWith("/repo", "opencode", "validateToken", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
    });
    expect(result).toContain("src/auth.ts:12-30");
    expect(result).not.toContain("fullSource");
    expect(countContextTokens(result)).toBeLessThanOrEqual(128);
  });

  it("preserves lookup order for definition evidence so the exact-symbol result stays first", async () => {
    const lookup = vi.fn().mockResolvedValue([
      {
        filePath: "src/exact-result.ts",
        startLine: 10,
        endLine: 12,
        name: "exactMatch",
        chunkType: "function",
        content: "exact",
        score: 0.10,
      },
      {
        filePath: "src/other-source.ts",
        startLine: 1,
        endLine: 4,
        name: "otherMatch",
        chunkType: "function",
        content: "high score",
        score: 0.99,
      },
      {
        filePath: "README.md",
        startLine: 1,
        endLine: 8,
        name: "overlap",
        chunkType: "other",
        content: "docs",
        score: 0.98,
      },
    ]);

    const result = await resolveSearchContext(
      {
        query: "find exactMatch",
        symbol: "exactMatch",
        limit: 10,
        tokenBudget: 2048,
        fileType: undefined,
        directory: undefined,
      },
      {
        lookup,
        search: vi.fn(),
      },
    );

    expect(result.details?.route).toBe("definition");
    expect(result.details?.results?.[0]).toMatchObject({
      filePath: "src/exact-result.ts",
      startLine: 10,
      endLine: 12,
      score: 0.10,
    });
    expect(result.text.indexOf("src/exact-result.ts:10-12")).toBeLessThan(result.text.indexOf("src/other-source.ts:1-4"));
  });

  it("routes dependency endpoints through bounded call-path output", async () => {
    operationMocks.getCallGraphPath.mockResolvedValue({
      from: { status: "resolved", name: "start", symbolId: "start-id", filePath: "src/start.ts", startLine: 1, kind: "function", matchedBy: "name" },
      to: { status: "resolved", name: "finish", symbolId: "finish-id", filePath: "src/finish.ts", startLine: 30, kind: "function", matchedBy: "name" },
      path: Array.from({ length: 30 }, (_, index) => ({
        symbolName: `symbol${index}`,
        filePath: `src/path-${index}.ts`,
        line: index + 1,
        callType: index === 0 ? "source" : "Call",
      })),
    });

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "trace start to finish",
      from: "start",
      to: "finish",
    }, context);

    expect(operationMocks.getCallGraphPath).toHaveBeenCalledWith("/repo", "opencode", "start", "finish", 10, undefined, undefined);
    expect(result).toContain("Path (30 hops)");
    expect(countContextTokens(result)).toBeLessThanOrEqual(128);
  });

  it("accepts explicit null optional arguments like the other adapters", async () => {
    await codebase_context.execute({
      query: "request handling",
      from: null,
      to: null,
      fromFilePath: null,
      toFilePath: null,
      symbol: null,
      limit: null,
      maxDepth: null,
      fileType: null,
      directory: null,
      tokenBudget: null,
    }, context);

    expect(operationMocks.searchCodebase).toHaveBeenCalledWith("/repo", "opencode", "request handling", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
      metadataOnly: true,
      prioritizeSourcePaths: expect.any(Boolean),
    });
  });

  it("keeps explicit artifact-intent queries on host-aware scoped search instead of definition lookup", async () => {
    operationMocks.searchCodebase.mockResolvedValue([{
      filePath: "tests/status.test.ts",
      startLine: 1,
      endLine: 5,
      name: "getStatus test",
      chunkType: "test_declaration",
      content: "hidden",
      score: 0.9,
    }]);

    const queries = [
      "tests for `getStatus`",
      "where is getStatus documentation",
      "getStatus configuration settings",
      "who calls getStatus",
    ];

    for (const query of queries) {
      operationMocks.searchCodebase.mockClear();
      operationMocks.implementationLookup.mockClear();
      await codebase_context.execute({
        ...commonArgs,
        query,
        fileType: "ts",
        directory: "src",
      }, context);

      expect(operationMocks.implementationLookup).not.toHaveBeenCalled();
      expect(operationMocks.searchCodebase).toHaveBeenCalledWith("/repo", "opencode", query, {
        limit: 100,
        fileType: "ts",
        directory: "src",
        metadataOnly: true,
        prioritizeSourcePaths: expect.any(Boolean),
      });
    }
  });

  it("falls back from an inferred definition miss to conceptual search", async () => {
    operationMocks.searchCodebase.mockResolvedValue([{
      filePath: "src/fallback.ts",
      startLine: 1,
      endLine: 4,
      name: "actualHandler",
      chunkType: "function",
      content: "hidden",
      score: 0.8,
    }]);

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "where is missingHandler defined",
    }, context);

    expect(operationMocks.implementationLookup).toHaveBeenCalledWith("/repo", "opencode", "missingHandler", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
    });
    expect(operationMocks.searchCodebase).toHaveBeenCalledWith("/repo", "opencode", "where is missingHandler defined", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
      metadataOnly: true,
      prioritizeSourcePaths: expect.any(Boolean),
    });
    expect(result).toContain("src/fallback.ts:1-4");
  });

  it("retries scoped conceptual search with unscoped filters when scoped results are empty", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          filePath: "src/auth.ts",
          startLine: 1,
          endLine: 5,
          name: "authHandler",
          chunkType: "function",
          content: "function authHandler() { return true; }",
          score: 0.9,
        },
      ]);

    const result = await resolveSearchContext(
      {
        query: "find request helpers",
        symbol: undefined,
        limit: 10,
        tokenBudget: 128,
        fileType: "ts",
        directory: "src",
      },
      {
        lookup: vi.fn().mockResolvedValue([]),
        search,
      },
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, "find request helpers", 100, { fileType: "ts", directory: "src" }, undefined, { prioritizeSourcePaths: true });
    expect(search).toHaveBeenNthCalledWith(2, "find request helpers", 100, { fileType: undefined, directory: undefined }, undefined, { prioritizeSourcePaths: true });
    expect(result.details?.recovery?.attempts).toEqual([
      {
        kind: "conceptual",
        scope: "scoped",
        resultCount: 0,
        relaxedFields: [],
      },
      {
        kind: "conceptual",
        scope: "unscoped",
        resultCount: 1,
        relaxedFields: ["directory", "fileType"],
      },
    ]);
    expect(result.text).toContain("src/auth.ts:1-5");
    expect(result.text).toContain("Recovery: directory filter removed; file-type filter removed.");
    expect(result.details?.tokenEstimate).toBe(countContextTokens(result.text));
    expect(countContextTokens(result.text)).toBeLessThanOrEqual(128);
  });

  it("retries inferred symbol conceptual query text when original conceptual query has no matches", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          filePath: "src/auth.ts",
          startLine: 1,
          endLine: 8,
          name: "getStatus",
          chunkType: "function",
          content: "function getStatus() { return 0; }",
          score: 0.88,
        },
      ]);

    const result = await resolveSearchContext(
      {
        query: "where is `getStatus` defined",
        symbol: undefined,
        limit: 10,
        tokenBudget: 128,
        fileType: undefined,
        directory: undefined,
      },
      {
        lookup: vi.fn().mockResolvedValue([]),
        search,
      },
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, "where is `getStatus` defined", 100, { fileType: undefined, directory: undefined }, undefined, { prioritizeSourcePaths: true });
    expect(search).toHaveBeenNthCalledWith(2, "getStatus", 100, { fileType: undefined, directory: undefined }, undefined, { prioritizeSourcePaths: true });
    expect(result.text).toContain("src/auth.ts:1-8");
    expect(result.text).toContain("Recovery: inferred definition missed; inferred-symbol query tried.");
    expect(result.text.indexOf("Recovery:")).toBeLessThan(result.text.indexOf("[1]"));
    expect(result.details?.tokenEstimate).toBe(countContextTokens(result.text));
    expect(result.details?.recovery?.successfulAttemptIndex).toBe(2);
  });

  it("reports explicit-symbol definition miss with recovery details", async () => {
    const result = await resolveSearchContext(
      {
        query: "where is missingDefinition defined",
        symbol: "missingDefinition",
        limit: 10,
        tokenBudget: 128,
        fileType: undefined,
        directory: undefined,
      },
      {
        lookup: vi.fn().mockResolvedValue([]),
        search: vi.fn().mockResolvedValue([]),
      },
    );

    expect(result.text).toContain("No definition found.");
    expect(result.text).not.toContain("where is missingDefinition defined");
    expect(result.text).toContain("Explicit symbol lookup only; conceptual search was not attempted.");
    expect(result.details).toMatchObject({
      route: "definition",
      routedQuery: "missingDefinition",
    });
    expect(result.details?.recovery?.attempts).toEqual([
      {
        kind: "definition",
        scope: "unscoped",
        resultCount: 0,
        relaxedFields: [],
      },
    ]);
    expect(result.details?.recovery?.successfulAttemptIndex).toBeUndefined();
  });

  it("does not duplicate identical conceptual attempts", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await resolveSearchContext(
      {
        query: "getStatus",
        symbol: undefined,
        limit: 10,
        tokenBudget: 128,
        fileType: "ts",
        directory: "src",
      },
      {
        lookup: vi.fn().mockResolvedValue([]),
        search,
      },
    );

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenNthCalledWith(1, "getStatus", 100, { fileType: "ts", directory: "src" }, undefined, { prioritizeSourcePaths: true });
    expect(search).toHaveBeenNthCalledWith(2, "getStatus", 100, { fileType: undefined, directory: undefined }, undefined, { prioritizeSourcePaths: true });
    expect(result.details?.recovery?.attempts).toHaveLength(3);
    expect(new Set(result.details?.recovery?.attempts.map((attempt) => JSON.stringify(attempt))).size)
      .toBe(3);
  });

  it("fits all-failure output to the provided token budget", async () => {
    const result = await resolveSearchContext(
      {
        query: "where is neverFound defined",
        symbol: "neverFound",
        limit: 10,
        tokenBudget: 128,
        fileType: "ts",
        directory: "src",
      },
      {
        lookup: vi.fn().mockResolvedValue([]),
        search: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
      },
    );

    expect(countContextTokens(result.text)).toBeLessThanOrEqual(128);
    expect(result.details?.tokenEstimate).toBe(countContextTokens(result.text));
    expect(result.details?.route).toBe("definition");
    expect(result.details?.recovery?.attempts).toHaveLength(2);
  });

  it("keeps explicit symbols definition-only with normalized scoped then unscoped lookup", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        filePath: "src/tools/context.ts",
        startLine: 1,
        endLine: 4,
        name: "resolveSearchContext",
        chunkType: "function",
        content: "hidden",
        score: 0.9,
      }]);
    const search = vi.fn();

    const result = await resolveSearchContext({
      query: "   ",
      symbol: "  resolveSearchContext  ",
      limit: 10,
      tokenBudget: 128,
      fileType: " .TS ",
      directory: " ./src\\tools/ ",
    }, { lookup, search });

    expect(lookup).toHaveBeenNthCalledWith(1, "resolveSearchContext", 100, {
      fileType: "ts",
      directory: "src/tools",
    }, undefined);
    expect(lookup).toHaveBeenNthCalledWith(2, "resolveSearchContext", 100, {}, undefined);
    expect(search).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      route: "definition",
      routedQuery: "resolveSearchContext",
      truncated: false,
      selectedCount: 1,
    });
    expect(result.text).toContain("Recovery: directory filter removed; file-type filter removed.");
    expect(result.text).not.toContain("resolveSearchContext  ");
    expect(result.details?.tokenEstimate).toBe(countContextTokens(result.text));
  });

  it("orders and deduplicates conceptual recovery attempts across query and scope", async () => {
    const search = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        filePath: "lib/status.ts",
        startLine: 2,
        endLine: 6,
        name: "getStatus",
        chunkType: "function",
        content: "hidden",
        score: 0.8,
      }]);

    const result = await resolveSearchContext({
      query: "  where is `getStatus` defined  ",
      symbol: undefined,
      limit: 10,
      tokenBudget: 128,
      fileType: " .TS ",
      directory: " ./private\\scope/ ",
    }, {
      lookup: vi.fn().mockResolvedValue([]),
      search,
    });

    expect(search.mock.calls).toEqual([
      ["where is `getStatus` defined", 100, { fileType: "ts", directory: "private/scope" }, undefined, { prioritizeSourcePaths: true }],
      ["getStatus", 100, { fileType: "ts", directory: "private/scope" }, undefined, { prioritizeSourcePaths: true }],
      ["where is `getStatus` defined", 100, {}, undefined, { prioritizeSourcePaths: true }],
      ["getStatus", 100, {}, undefined, { prioritizeSourcePaths: true }],
    ]);
    const recoveryLine = result.text.split("\n").find((line) => line.startsWith("Recovery:"));
    expect(recoveryLine).toBe("Recovery: inferred definition missed; inferred-symbol query tried; directory filter removed; file-type filter removed.");
    expect(recoveryLine).not.toContain("getStatus");
    expect(recoveryLine).not.toContain("private/scope");
    expect(recoveryLine?.length).toBeLessThan(160);
    expect(result.details).toMatchObject({ route: "conceptual", routedQuery: "getStatus", truncated: false });
    expect(result.details?.tokenEstimate).toBe(countContextTokens(result.text));
  });

  it("keeps packed evidence and omission metadata consistent without post-truncation", async () => {
    const results = Array.from({ length: 8 }, (_, index) => ({
      filePath: `src/${"nested/".repeat(6)}file-${index}.ts`,
      startLine: index + 1,
      endLine: index + 2,
      name: `handler${index}`,
      chunkType: "function",
      content: "hidden",
      score: 1 - index / 100,
    }));
    const result = await resolveSearchContext({
      query: "find handlers",
      symbol: undefined,
      limit: 8,
      tokenBudget: 128,
      fileType: "ts",
      directory: "missing",
    }, {
      lookup: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(results),
    });

    const renderedEvidenceCount = result.text.match(/^\[\d+\]/gm)?.length ?? 0;
    expect(renderedEvidenceCount).toBe(result.details?.selectedCount);
    expect(result.details?.results).toHaveLength(renderedEvidenceCount);
    expect(result.details?.omittedCount).toBe(results.length - renderedEvidenceCount);
    expect(result.details?.truncated).toBe(false);
    expect(result.details?.tokenEstimate).toBe(countContextTokens(result.text));
    expect(countContextTokens(result.text)).toBeLessThanOrEqual(128);
  });

  it("prefers source paths for conceptual code queries but not documentation queries", async () => {
    const sourceSearch = vi.fn().mockResolvedValue([{
      filePath: "src/index.ts",
      startLine: 1,
      endLine: 2,
      chunkType: "function",
      content: "export function search() {}",
      score: 0.9,
    }]);
    const docsSearch = vi.fn().mockResolvedValue([{
      filePath: "docs/search.md",
      startLine: 1,
      endLine: 2,
      chunkType: "markdown",
      content: "# Search",
      score: 0.9,
    }]);

    await resolveSearchContext({
      query: "find code that combines semantic and keyword rankings",
    }, { lookup: vi.fn(), search: sourceSearch });
    await resolveSearchContext({
      query: "find documentation for configuring search",
    }, { lookup: vi.fn(), search: docsSearch });

    expect(sourceSearch).toHaveBeenCalledWith(
      "find code that combines semantic and keyword rankings",
      100,
      {},
      undefined,
      { prioritizeSourcePaths: true },
    );
    expect(docsSearch).toHaveBeenCalledWith(
      "find documentation for configuring search",
      100,
      {},
      undefined,
      { prioritizeSourcePaths: false },
    );
  });

  it("captures search and context-pack traces when diagnostic flag is set", async () => {
    const search = vi.fn().mockImplementation(async (_query: string, _limit: number, _scope: unknown, trace?: (trace: SearchTrace) => void) => {
      trace?.({
        semanticCandidates: [],
        keywordCandidates: [],
        hybridCandidates: [],
        postExternalRerankCandidates: [],
        tieredCandidates: [],
        finalCandidates: [],
      });
      return [
        {
          filePath: "src/trace.ts",
          startLine: 4,
          endLine: 12,
          name: "traceTarget",
          chunkType: "function",
          content: "function traceTarget() {}",
          score: 0.9,
        },
      ];
    });

    const result = await resolveSearchContext({
      query: "where is traceTarget defined",
      symbol: undefined,
      limit: 10,
      tokenBudget: 128,
      fileType: undefined,
      directory: undefined,
      diagnostic: true,
    }, {
      lookup: vi.fn().mockResolvedValue([]),
      search,
    });

    expect(search).toHaveBeenCalledWith(
      "where is traceTarget defined",
      100,
      {},
      expect.any(Function),
      { prioritizeSourcePaths: true },
    );
    expect(result.details?.diagnostic).toMatchObject({
      route: "conceptual",
      searchQuery: expect.any(String),
      searchScope: {},
      searchTrace: {
        semanticCandidates: [],
        keywordCandidates: [],
      },
      contextPackTrace: {
        inputCandidates: [
          {
            filePath: "src/trace.ts",
            startLine: 4,
            endLine: 12,
            score: 0.9,
            chunkType: "function",
            name: "traceTarget",
          },
        ],
      },
    });
  });

  it("forwards the diagnostic flag from codebase context into search traces", async () => {
    operationMocks.implementationLookup.mockImplementation(async (_projectRoot, _host, _query, options) => {
      options.trace?.({
        semanticCandidates: [],
        keywordCandidates: [],
        hybridCandidates: [],
        postExternalRerankCandidates: [],
        tieredCandidates: [],
        finalCandidates: [],
      });

      return [{
        filePath: "src/resolve.ts",
        startLine: 10,
        endLine: 20,
        name: "resolveContext",
        chunkType: "function",
        content: "function resolveContext() {}",
        score: 0.99,
      }];
    });

    const result = await resolveCodebaseContext("/repo", "opencode", {
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
      diagnostic: true,
    });

    expect(operationMocks.implementationLookup).toHaveBeenCalledWith(
      "/repo",
      "opencode",
      "resolveContext",
      expect.objectContaining({
        limit: 100,
        fileType: undefined,
        directory: undefined,
        trace: expect.any(Function),
      }),
    );
    expect(operationMocks.searchCodebase).not.toHaveBeenCalled();
    expect(result.details?.diagnostic).toMatchObject({
      route: "definition",
      searchTrace: {
        semanticCandidates: [],
      },
      contextPackTrace: {
        selectedCandidates: [
          {
            filePath: "src/resolve.ts",
            startLine: 10,
            endLine: 20,
            score: 0.99,
            chunkType: "function",
            name: "resolveContext",
          },
        ],
      },
    });
  });

  it("preserves OpenCode text output when diagnostic is disabled", async () => {
    const baseline = await resolveCodebaseContext("/repo", "opencode", {
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
      diagnostic: false,
    });

    const noDiagnostic = await opencodeCodebaseContext.execute({
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
      diagnostic: false,
    }, context);

    const omittedDiagnostic = await opencodeCodebaseContext.execute({
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
    }, context);

    expect(noDiagnostic).toBe(baseline.text);
    expect(omittedDiagnostic).toBe(baseline.text);
  });

  it("appends diagnostics text in OpenCode output when diagnostic is true", async () => {
    operationMocks.implementationLookup.mockResolvedValue([{
      filePath: "src/resolve.ts",
      startLine: 10,
      endLine: 20,
      name: "resolveContext",
      chunkType: "function",
      content: "function resolveContext() {}",
      score: 0.99,
    }]);

    const withDiagnostic = await opencodeCodebaseContext.execute({
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
      diagnostic: true,
    }, context);

    const baseline = await resolveCodebaseContext("/repo", "opencode", {
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
      diagnostic: true,
    });

    expect(withDiagnostic.startsWith(baseline.text)).toBe(true);
    expect(withDiagnostic).toContain("\nDiagnostics:\n");
    expect(withDiagnostic).toContain('"route"');
    expect(withDiagnostic).toContain("\"route\": \"definition\"");
    expect(withDiagnostic).not.toContain('"selectedCount"');
  });

  it("omits diagnostic details when diagnostic flag is false", async () => {
    operationMocks.implementationLookup.mockResolvedValue([{
      filePath: "src/resolve.ts",
      startLine: 1,
      endLine: 2,
      name: "resolveContext",
      chunkType: "function",
      content: "function resolveContext() {}",
      score: 0.9,
    }]);

    const result = await resolveCodebaseContext("/repo", "opencode", {
      ...commonArgs,
      query: "resolve context",
      symbol: "resolveContext",
      diagnostic: false,
    });

    expect(result.details?.diagnostic).toBeUndefined();
    expect(operationMocks.implementationLookup).toHaveBeenCalledWith(
      "/repo",
      "opencode",
      "resolveContext",
      expect.objectContaining({
        limit: 100,
        fileType: undefined,
        directory: undefined,
      }),
    );
    const lookupOptions = operationMocks.implementationLookup.mock.calls[0][3] as {
      trace?: ((trace: SearchTrace) => void) | undefined;
    };
    expect(lookupOptions.trace).toBeUndefined();
    expect(result.text).toContain("src/resolve.ts");
  });

  it("exposes the diagnostic flag in OpenCode schema", () => {
    const args = (opencodeCodebaseContext as { args: Record<string, unknown> }).args;
    expect(args).toHaveProperty("diagnostic");
  });
});
