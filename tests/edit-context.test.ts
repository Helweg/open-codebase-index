import { beforeEach, describe, expect, it, vi } from "vitest";

import { countContextTokens } from "../src/tools/utils.js";

const operationMocks = vi.hoisted(() => ({
  getCallGraphData: vi.fn(),
  implementationLookup: vi.fn(),
  searchCodebase: vi.fn(),
}));

vi.mock("../src/tools/operations.js", () => operationMocks);

import { resolveCodebaseEditContext } from "../src/tools/edit-context.js";

const resolved = {
  status: "resolved" as const,
  name: "validateToken",
  symbolId: "sym_validate",
  filePath: "src/auth.ts",
  startLine: 10,
  kind: "function",
  matchedBy: "name" as const,
};

const source = {
  filePath: "src/auth.ts",
  startLine: 10,
  endLine: 25,
  name: "validateToken",
  chunkType: "function",
  content: "function validateToken(token: string) {\n  return token.length > 0;\n}",
  score: 0.99,
};

const conceptual = {
  filePath: "src/auth-policy.ts",
  startLine: 4,
  endLine: 12,
  name: "authorizeRequest",
  chunkType: "function",
  content: "function authorizeRequest() {\n  return true;\n}",
  score: 0.8,
};

describe("codebase edit context", () => {
  beforeEach(() => {
    operationMocks.getCallGraphData.mockReset();
    operationMocks.implementationLookup.mockReset();
    operationMocks.searchCodebase.mockReset();
    operationMocks.implementationLookup.mockResolvedValue([source]);
    operationMocks.searchCodebase.mockResolvedValue([conceptual]);
  });

  it("includes authoritative target source within the total token budget", async () => {
    operationMocks.getCallGraphData.mockImplementation(async (_root, _host, args) => ({
      direction: args.direction,
      resolution: resolved,
      callers: [],
      callees: [],
    }));

    const result = await resolveCodebaseEditContext("/repo", "jcode", {
      query: "tighten token validation",
      symbol: "validateToken",
      tokenBudget: 256,
    });

    expect(result.text).toContain("## Target implementation");
    expect(result.text).toContain("src/auth.ts:10-25");
    expect(result.text).toContain("function validateToken");
    expect(result.details.sourceIncluded).toBe(true);
    expect(countContextTokens(result.text)).toBeLessThanOrEqual(256);
  });

  it("includes limited direct caller and callee evidence with locations and edge types", async () => {
    operationMocks.getCallGraphData.mockImplementation(async (_root, _host, args) => args.direction === "callers"
      ? {
          direction: "callers",
          resolution: resolved,
          callers: [
            {
              id: "caller-edge",
              fromSymbolId: "sym_caller",
              fromSymbolName: "handleRequest",
              fromSymbolFilePath: "src/handler.ts",
              targetName: "validateToken",
              callType: "Call",
              confidence: "Direct",
              line: 42,
              col: 2,
              isResolved: true,
            },
          ],
          callees: [],
        }
      : {
          direction: "callees",
          resolution: resolved,
          callers: [],
          callees: [
            {
              id: "callee-edge",
              fromSymbolId: "sym_validate",
              targetName: "parseToken",
              toSymbolId: "sym_parse",
              callType: "MethodCall",
              confidence: "Direct",
              line: 14,
              col: 2,
              isResolved: true,
            },
          ],
        });

    const result = await resolveCodebaseEditContext("/repo", "jcode", {
      query: "tighten token validation",
      symbol: "validateToken",
      callerLimit: 1,
      calleeLimit: 1,
      tokenBudget: 512,
    });

    expect(result.text).toContain("handleRequest at src/handler.ts:42 (Call, resolved)");
    expect(result.text).toContain("parseToken from src/auth.ts:14 (MethodCall, resolved)");
    expect(result.details.callerCount).toBe(1);
    expect(result.details.calleeCount).toBe(1);
  });

  it("returns a risk note and conceptual evidence for an ambiguous target", async () => {
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callers",
      resolution: {
        status: "ambiguous",
        name: "validateToken",
        candidates: [
          { filePath: "src/auth.ts", startLine: 10, kind: "function" },
          { filePath: "src/legacy-auth.ts", startLine: 8, kind: "function" },
        ],
        totalCandidates: 2,
      },
      callers: [],
      callees: [],
    });

    const result = await resolveCodebaseEditContext("/repo", "jcode", {
      query: "tighten token validation",
      symbol: "validateToken",
      tokenBudget: 256,
    });

    expect(result.text).toContain("Risk: symbol \"validateToken\" is ambiguous");
    expect(result.text).toContain("Pass filePath");
    expect(result.text).toContain("src/auth-policy.ts");
    expect(result.details.resolution).toBe("ambiguous");
    expect(operationMocks.implementationLookup).not.toHaveBeenCalled();
  });

  it("returns candidate source and a risk note when graph data is unavailable", async () => {
    operationMocks.getCallGraphData.mockRejectedValue(new Error("call graph unavailable"));

    const result = await resolveCodebaseEditContext("/repo", "jcode", {
      query: "tighten token validation",
      symbol: "validateToken",
      tokenBudget: 256,
    });

    expect(result.text).toContain("Risk: graph data is unavailable");
    expect(result.text).toContain("src/auth.ts");
    expect(result.details.resolution).toBe("graph_unavailable");
    expect(result.details.sourceIncluded).toBe(true);
  });

  it("returns a risk note and conceptual evidence when the symbol is unresolved", async () => {
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callers",
      resolution: {
        status: "not_found",
        name: "missingSymbol",
        candidates: [],
        totalCandidates: 0,
      },
      callers: [],
      callees: [],
    });

    const result = await resolveCodebaseEditContext("/repo", "jcode", {
      query: "change missing behavior",
      symbol: "missingSymbol",
    });

    expect(result.text).toContain("Risk: symbol \"missingSymbol\" could not be resolved");
    expect(result.text).toContain("src/auth-policy.ts");
    expect(result.details.resolution).toBe("not_found");
  });
});
