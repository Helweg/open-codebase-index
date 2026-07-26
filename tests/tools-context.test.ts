import { beforeEach, describe, expect, it, vi } from "vitest";

import { countContextTokens } from "../src/tools/utils.js";
import { resolveSearchContext } from "../src/tools/context.js";

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
    });
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
    expect(search).toHaveBeenNthCalledWith(1, "find request helpers", 100, { fileType: "ts", directory: "src" });
    expect(search).toHaveBeenNthCalledWith(2, "find request helpers", 100, { fileType: undefined, directory: undefined });
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
    expect(search).toHaveBeenNthCalledWith(1, "where is `getStatus` defined", 100, { fileType: undefined, directory: undefined });
    expect(search).toHaveBeenNthCalledWith(2, "getStatus", 100, { fileType: undefined, directory: undefined });
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
    expect(search).toHaveBeenNthCalledWith(1, "getStatus", 100, { fileType: "ts", directory: "src" });
    expect(search).toHaveBeenNthCalledWith(2, "getStatus", 100, { fileType: undefined, directory: undefined });
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
    });
    expect(lookup).toHaveBeenNthCalledWith(2, "resolveSearchContext", 100, {});
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
      ["where is `getStatus` defined", 100, { fileType: "ts", directory: "private/scope" }],
      ["getStatus", 100, { fileType: "ts", directory: "private/scope" }],
      ["where is `getStatus` defined", 100, {}],
      ["getStatus", 100, {}],
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
});
