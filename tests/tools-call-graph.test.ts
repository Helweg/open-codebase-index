import { describe, expect, it, vi } from "vitest";

import type { Indexer } from "../src/indexer/index.js";
import type { CallEdgeData, PathHopData, SymbolData } from "../src/native/index.js";
import { queryCallGraph, queryCallGraphPath } from "../src/tools/call-graph.js";

function symbol(
  id: string,
  name: string,
  filePath: string,
  startLine: number = 1,
  language: string = "typescript",
): SymbolData {
  return {
    id,
    name,
    filePath,
    kind: "function",
    startLine,
    startCol: 0,
    endLine: startLine + 5,
    endCol: 0,
    language,
  };
}

function edge(overrides: Partial<CallEdgeData> = {}): CallEdgeData {
  return {
    id: "edge_internal",
    fromSymbolId: "sym_caller_internal",
    fromSymbolName: "caller",
    fromSymbolFilePath: "src/caller.ts",
    targetName: "target",
    toSymbolId: "sym_target_internal",
    callType: "Call",
    confidence: "Direct",
    line: 12,
    col: 2,
    isResolved: true,
    ...overrides,
  };
}

function fakeIndexer(options: {
  symbols?: SymbolData[];
  callers?: CallEdgeData[];
  callees?: CallEdgeData[];
  path?: PathHopData[];
} = {}): {
  indexer: Indexer;
  getSymbolsForBranch: ReturnType<typeof vi.fn>;
  getCallers: ReturnType<typeof vi.fn>;
  getCallees: ReturnType<typeof vi.fn>;
  findCallPath: ReturnType<typeof vi.fn>;
  findCallPathById: ReturnType<typeof vi.fn>;
} {
  const getSymbolsForBranch = vi.fn().mockResolvedValue(options.symbols ?? []);
  const getCallers = vi.fn().mockResolvedValue(options.callers ?? []);
  const getCallees = vi.fn().mockResolvedValue(options.callees ?? []);
  const findCallPath = vi.fn().mockResolvedValue(options.path ?? []);
  const findCallPathById = vi.fn().mockResolvedValue(options.path ?? []);
  const indexer = {
    getSymbolsForBranch,
    getCallers,
    getCallees,
    findCallPath,
    findCallPathById,
  } as unknown as Indexer;
  return { indexer, getSymbolsForBranch, getCallers, getCallees, findCallPath, findCallPathById };
}

describe("name-based call graph operation", () => {
  it("resolves a unique callee name and preserves relationship filters without leaking IDs", async () => {
    const handler = symbol("sym_handler_secret", "handler", "src/handler.ts", 10);
    const target = symbol("sym_target_secret", "target", "src/target.ts", 30);
    const { indexer, getCallees } = fakeIndexer({
      symbols: [handler, target],
      callees: [edge({ fromSymbolId: handler.id, toSymbolId: target.id, targetName: target.name })],
    });

    const result = await queryCallGraph(indexer, {
      name: "handler",
      direction: "callees",
      relationshipType: "MethodCall",
    });

    expect(getCallees).toHaveBeenCalledWith(handler.id, "MethodCall");
    expect(result.text).toContain('"handler" at src/handler.ts:10 calls 1 function');
    expect(result.text).toContain("resolved to src/target.ts:30");
    expect(result.text).not.toContain("sym_handler_secret");
    expect(result.text).not.toContain("sym_target_secret");
    expect(JSON.stringify(result.details)).not.toContain("sym_");
  });

  it("returns bounded ambiguity candidates and never queries edges", async () => {
    const symbols = Array.from({ length: 10 }, (_, index) => (
      symbol(`sym_${index}`, "handle", `src/feature-${index}/handler.ts`, index + 1)
    ));
    const { indexer, getCallers, getCallees } = fakeIndexer({ symbols });

    const result = await queryCallGraph(indexer, { name: "handle", direction: "callees" });

    expect(result.details.resolution).toBe("ambiguous");
    expect(result.details.candidates).toHaveLength(8);
    expect(result.text).toContain("src/feature-0/handler.ts:1");
    expect(result.text).toContain("2 more candidate(s) omitted");
    expect(result.text).toContain("Re-run call_graph with file");
    expect(getCallers).not.toHaveBeenCalled();
    expect(getCallees).not.toHaveBeenCalled();
  });

  it("uses a file qualifier to select one same-name definition", async () => {
    const first = symbol("sym_first", "handle", "/repo/src/api/handler.ts", 4);
    const second = symbol("sym_second", "handle", "/repo/src/jobs/handler.ts", 8);
    const firstCaller = edge({ id: "edge_first", fromSymbolName: "apiCaller", toSymbolId: first.id });
    const secondCaller = edge({ id: "edge_second", fromSymbolName: "jobCaller", toSymbolId: second.id });
    const unresolved = edge({ id: "edge_unresolved", fromSymbolName: "unknownCaller", toSymbolId: undefined, isResolved: false });
    const { indexer, getCallers } = fakeIndexer({
      symbols: [first, second],
      callers: [firstCaller, secondCaller, unresolved],
    });

    const result = await queryCallGraph(indexer, {
      name: "handle",
      direction: "callers",
      file: "src/api/handler.ts",
    });

    expect(getCallers).toHaveBeenCalledWith("handle", undefined);
    expect(result.text).toContain("apiCaller");
    expect(result.text).not.toContain("jobCaller");
    expect(result.text).toContain("unknownCaller");
    expect(result.text).toContain("[unresolved]");
    expect(result.details.symbol?.filePath).toBe(first.filePath);
  });

  it("uses a directory qualifier and accepts null optional arguments", async () => {
    const first = symbol("sym_first", "handle", "/repo/src/api/handler.ts", 4);
    const second = symbol("sym_second", "handle", "/repo/src/jobs/handler.ts", 8);
    const caller = edge({ fromSymbolName: "jobCaller", toSymbolId: second.id });
    const { indexer, getCallers } = fakeIndexer({ symbols: [first, second], callers: [caller] });

    const qualified = await queryCallGraph(indexer, {
      name: "handle",
      direction: "callers",
      directory: "src/jobs",
      file: null,
      relationshipType: null,
    });
    const nullCompatible = await queryCallGraph(
      fakeIndexer({
        symbols: [symbol("sym_unique", "unique", "src/unique.ts")],
        callers: [edge({ toSymbolId: "sym_unique" })],
      }).indexer,
      { name: "unique", direction: null, file: null, directory: null, relationshipType: null },
    );

    expect(getCallers).toHaveBeenCalledWith("handle", undefined);
    expect(qualified.text).toContain("jobCaller");
    expect(qualified.details.symbol?.filePath).toBe(second.filePath);
    expect(nullCompatible.details.direction).toBe("callers");
    expect(nullCompatible.details.resolution).toBe("resolved");
  });

  it("returns actionable missing-symbol guidance before callee lookup", async () => {
    const { indexer, getCallees } = fakeIndexer();

    const result = await queryCallGraph(indexer, { name: "missing", direction: "callees" });

    expect(result.details.resolution).toBe("missing");
    expect(result.text).toContain('No indexed symbol named "missing"');
    expect(result.text).toContain("implementation_lookup or codebase_peek");
    expect(result.text).toContain("index_status");
    expect(result.text).toContain("index_codebase");
    expect(getCallees).not.toHaveBeenCalled();
  });

  it.each(["php", "apex"])("matches %s candidates case-insensitively", async (language) => {
    const handler = symbol(`sym_${language}`, "Handler", `src/handler.${language}`, 7, language);
    const { indexer, getCallees } = fakeIndexer({ symbols: [handler] });

    const result = await queryCallGraph(indexer, { name: "HANDLER", direction: "callees" });

    expect(result.details.resolution).toBe("resolved");
    expect(result.details.symbol?.filePath).toBe(handler.filePath);
    expect(getCallees).toHaveBeenCalledWith(handler.id, undefined);
  });

  it("keeps candidate matching exact for case-sensitive languages", async () => {
    const handler = symbol("sym_ts", "Handler", "src/handler.ts", 7, "typescript");
    const { indexer, getCallees } = fakeIndexer({ symbols: [handler] });

    const result = await queryCallGraph(indexer, { name: "HANDLER", direction: "callees" });

    expect(result.details.resolution).toBe("missing");
    expect(getCallees).not.toHaveBeenCalled();
  });

  it("unions unresolved same-name callers with the selected definition without mixing resolved definitions", async () => {
    const selected = symbol("sym_selected", "handle", "src/api/handler.ts", 4);
    const other = symbol("sym_other", "handle", "src/jobs/handler.ts", 8);
    const selectedCaller = edge({ fromSymbolName: "apiCaller", toSymbolId: selected.id });
    const otherCaller = edge({ fromSymbolName: "jobCaller", toSymbolId: other.id });
    const unresolved = edge({ fromSymbolName: "dynamicCaller", toSymbolId: undefined, isResolved: false });
    const { indexer } = fakeIndexer({ symbols: [selected, other], callers: [selectedCaller, otherCaller, unresolved] });

    const result = await queryCallGraph(indexer, {
      name: "handle",
      direction: "callers",
      file: "src/api/handler.ts",
    });

    expect(result.text).toContain("apiCaller");
    expect(result.text).toContain("dynamicCaller");
    expect(result.text).toContain("[unresolved]");
    expect(result.text).not.toContain("jobCaller");
    expect(result.details.edges.map((candidate) => candidate.name)).toEqual(["apiCaller", "dynamicCaller"]);
  });

  it("caps public edge output and reports the omitted count", async () => {
    const target = symbol("sym_target", "target", "src/target.ts");
    const callers = Array.from({ length: 105 }, (_, index) => edge({
      id: `edge_${index}`,
      fromSymbolName: `caller${index}`,
      toSymbolId: target.id,
    }));
    const result = await queryCallGraph(fakeIndexer({ symbols: [target], callers }).indexer, {
      name: "target",
      direction: "callers",
    });

    expect(result.details.edges).toHaveLength(100);
    expect(result.details.omittedEdgeCount).toBe(5);
    expect(result.text).toContain("called by 105 function(s)");
    expect(result.text).toContain("5 more edge(s) omitted");
    expect(result.text).not.toContain("caller104");
  });

  it("preserves unresolved-target callers only when no indexed definition resolves", async () => {
    const unresolved = edge({
      fromSymbolName: "dynamicCaller",
      toSymbolId: undefined,
      isResolved: false,
      targetName: "dynamicTarget",
    });
    const resolved = edge({ fromSymbolName: "staleResolvedCaller", isResolved: true });
    const { indexer, getCallers } = fakeIndexer({ callers: [resolved, unresolved] });

    const result = await queryCallGraph(indexer, { name: "dynamicTarget", direction: "callers" });

    expect(getCallers).toHaveBeenCalledWith("dynamicTarget", undefined);
    expect(result.details.resolution).toBe("unresolved-target");
    expect(result.text).toContain("dynamicCaller");
    expect(result.text).not.toContain("staleResolvedCaller");
    expect(result.text).toContain("Run index_codebase");
  });

  it("reports qualifier misses with available exact-name locations", async () => {
    const available = symbol("sym_available", "handle", "src/api/handler.ts", 9);
    const { indexer, getCallers } = fakeIndexer({ symbols: [available] });

    const result = await queryCallGraph(indexer, {
      name: "handle",
      direction: "callers",
      directory: "src/missing",
    });

    expect(result.details.resolution).toBe("missing");
    expect(result.text).toContain("src/api/handler.ts:9");
    expect(result.text).toContain("Use one of those locations as file or directory");
    expect(getCallers).not.toHaveBeenCalled();
  });

  it("refuses ambiguous path endpoints without calling native traversal", async () => {
    const { indexer, findCallPath, findCallPathById } = fakeIndexer({
      symbols: [
        symbol("sym_start_a", "start", "src/a.ts"),
        symbol("sym_start_b", "start", "src/b.ts"),
        symbol("sym_end", "end", "src/end.ts"),
      ],
    });

    const result = await queryCallGraphPath(indexer, { from: "start", to: "end", maxDepth: 5 });

    expect(result.details.resolution).toBe("ambiguous");
    expect(result.details.ambiguousEndpoint).toBe("from");
    expect(result.text).toContain("does not silently choose");
    expect(result.text).toContain("fromFile");
    expect(result.text).not.toContain("sym_start_a");
    expect(findCallPath).not.toHaveBeenCalled();
    expect(findCallPathById).not.toHaveBeenCalled();
  });

  it("uses qualified endpoint IDs for ambiguous path names without leaking them", async () => {
    const startA = symbol("sym_start_a_secret", "start", "src/api/start.ts");
    const startB = symbol("sym_start_b_secret", "start", "src/jobs/start.ts");
    const endA = symbol("sym_end_a_secret", "end", "src/api/end.ts");
    const endB = symbol("sym_end_b_secret", "end", "src/jobs/end.ts");
    const path: PathHopData[] = [
      { symbolId: startB.id, symbolName: "start", filePath: startB.filePath, line: 1, callType: "" },
      { symbolId: endA.id, symbolName: "end", filePath: endA.filePath, line: 1, callType: "Call" },
    ];
    const { indexer, findCallPathById } = fakeIndexer({
      symbols: [startA, startB, endA, endB],
      path,
    });

    const result = await queryCallGraphPath(indexer, {
      from: "start",
      to: "end",
      fromDirectory: "src/jobs",
      toFile: "src/api/end.ts",
      maxDepth: null,
    });

    expect(findCallPathById).toHaveBeenCalledWith(startB.id, endA.id, undefined);
    expect(result.details.resolution).toBe("resolved");
    expect(result.details.fromDirectory).toBe("src/jobs");
    expect(result.details.toFile).toBe("src/api/end.ts");
    expect(result.text).toContain("src/jobs/start.ts:1");
    expect(JSON.stringify(result)).not.toContain("_secret");
  });

  it("reports missing path qualifiers with usable locations and accepts null qualifiers", async () => {
    const start = symbol("sym_start", "start", "src/api/start.ts");
    const end = symbol("sym_end", "end", "src/end.ts");
    const missing = await queryCallGraphPath(fakeIndexer({ symbols: [start, end] }).indexer, {
      from: "start",
      to: "end",
      fromFile: "src/missing.ts",
    });
    const { indexer, findCallPathById } = fakeIndexer({ symbols: [start, end] });
    const nullCompatible = await queryCallGraphPath(indexer, {
      from: "start",
      to: "end",
      fromFile: null,
      fromDirectory: null,
      toFile: null,
      toDirectory: null,
      maxDepth: null,
    });

    expect(missing.details.resolution).toBe("missing");
    expect(missing.text).toContain("src/api/start.ts:1");
    expect(missing.text).toContain("fromFile or fromDirectory");
    expect(findCallPathById).toHaveBeenCalledWith(start.id, end.id, undefined);
    expect(nullCompatible.details.resolution).toBe("no-path");
  });
});
