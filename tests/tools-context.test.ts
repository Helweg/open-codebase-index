import { beforeEach, describe, expect, it, vi } from "vitest";

import { countContextTokens } from "../src/tools/utils.js";

const operationMocks = vi.hoisted(() => ({
  searchCodebase: vi.fn(),
  implementationLookup: vi.fn(),
  getCallGraphPath: vi.fn(),
  getCallGraphData: vi.fn(),
}));

vi.mock("../src/tools/operations.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/operations.js")>("../src/tools/operations.js");
  return {
    ...actual,
    searchCodebase: operationMocks.searchCodebase,
    implementationLookup: operationMocks.implementationLookup,
    getCallGraphPath: operationMocks.getCallGraphPath,
    getCallGraphData: operationMocks.getCallGraphData,
  };
});

import { codebase_context } from "../src/tools/index.js";

const context = { worktree: "/repo" };
const commonArgs = {
  from: undefined,
  to: undefined,
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
    operationMocks.searchCodebase.mockResolvedValue([]);
    operationMocks.implementationLookup.mockResolvedValue([]);
    operationMocks.getCallGraphPath.mockResolvedValue([]);
    operationMocks.getCallGraphData.mockResolvedValue({ direction: "callers", callers: [], callees: [] });
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
    operationMocks.getCallGraphPath.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({
      symbolName: `symbol${index}`,
      filePath: `src/path-${index}.ts`,
      line: index + 1,
      callType: "Call",
    })));

    const result = await codebase_context.execute({
      ...commonArgs,
      query: "trace start to finish",
      from: "start",
      to: "finish",
    }, context);

    expect(operationMocks.getCallGraphPath).toHaveBeenCalledWith("/repo", "opencode", "start", "finish", 10);
    expect(result).toContain("Path (30 hops)");
    expect(countContextTokens(result)).toBeLessThanOrEqual(128);
  });

  it("accepts explicit null optional arguments like the other adapters", async () => {
    await codebase_context.execute({
      query: "request handling",
      from: null,
      to: null,
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
});
