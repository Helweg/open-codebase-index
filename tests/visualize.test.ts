import { describe, it, expect } from "vitest";
import { attachRecentActivity } from "../src/tools/visualize/activity.js";
import { transformForVisualization } from "../src/tools/visualize/transform.js";
import { generateVisualizationHtml } from "../src/tools/visualize/template.js";
import { analyzeVisualizationGraph } from "../src/tools/visualize/graph.js";
import type { VisualizationData } from "../src/tools/visualize/types.js";
import type { SymbolData, CallEdgeData } from "../src/native/index.js";

function makeSymbol(id: string, name: string, filePath: string, kind = "function"): SymbolData {
  return {
    id,
    name,
    filePath,
    kind,
    startLine: 1,
    startCol: 0,
    endLine: 10,
    endCol: 1,
    language: "typescript",
  };
}

function makeEdge(
  id: string,
  fromSymbolId: string,
  targetName: string,
  toSymbolId: string | undefined,
  callType = "Call",
  isResolved = true,
): CallEdgeData {
  return {
    id,
    fromSymbolId,
    fromSymbolName: undefined,
    fromSymbolFilePath: undefined,
    targetName,
    toSymbolId,
    callType,
    confidence: "Direct",
    line: 5,
    col: 10,
    isResolved,
  };
}

describe("visualize - transform", () => {
  const symbols: SymbolData[] = [
    makeSymbol("sym1", "handleRequest", "src/handlers/request.ts"),
    makeSymbol("sym2", "validateInput", "src/utils/validate.ts"),
    makeSymbol("sym3", "logError", "src/utils/logger.ts"),
    makeSymbol("sym4", "parseConfig", "src/config/parser.ts"),
    makeSymbol("sym5", "orphanFn", "src/orphan.ts"),
  ];

  const edges: CallEdgeData[] = [
    makeEdge("e1", "sym1", "validateInput", "sym2", "Call"),
    makeEdge("e2", "sym1", "logError", "sym3", "Call"),
    makeEdge("e3", "sym2", "parseConfig", "sym4", "Call"),
    makeEdge("e4", "sym1", "unresolvedFn", undefined, "Call", false),
  ];

  it("filters unresolved edges", () => {
    const result = transformForVisualization(symbols, edges);
    // e4 is unresolved, should be excluded
    expect(result.edges.length).toBe(3);
    expect(result.edges.every((e) => e.source && e.target)).toBe(true);
  });

  it("excludes orphan nodes by default", () => {
    const result = transformForVisualization(symbols, edges);
    // sym5 has no edges, should be excluded
    expect(result.nodes.find((n) => n.id === "sym5")).toBeUndefined();
    expect(result.nodes.length).toBe(4);
  });

  it("includes orphan nodes when requested", () => {
    const result = transformForVisualization(symbols, edges, { includeOrphans: true });
    expect(result.nodes.find((n) => n.id === "sym5")).toBeDefined();
    expect(result.nodes.length).toBe(5);
  });

  it("filters by directory", () => {
    const result = transformForVisualization(symbols, edges, { directory: "src/utils" });
    // Only sym2 and sym3 are in src/utils, and only edge e3 connects sym2→sym4 (sym4 not in src/utils)
    // Edge e1: sym1→sym2 (sym1 not in src/utils, filtered)
    // Edge e2: sym1→sym3 (sym1 not in src/utils, filtered)
    // Edge e3: sym2→sym4 (sym4 not in src/utils, filtered)
    // No edges remain with both ends in src/utils
    expect(result.nodes.length).toBe(0);
  });

  it("filters absolute indexed paths by repo-relative directory", () => {
    const root = "/tmp/example-repo";
    const absoluteSymbols: SymbolData[] = [
      makeSymbol("sym1", "handleRequest", `${root}/src/handlers/request.ts`),
      makeSymbol("sym2", "validateInput", `${root}/src/utils/validate.ts`),
      makeSymbol("sym3", "logError", `${root}/src/utils/logger.ts`),
      makeSymbol("sym4", "testHelper", `${root}/tests/helper.ts`),
    ];
    const absoluteEdges: CallEdgeData[] = [
      makeEdge("e1", "sym2", "logError", "sym3", "Call"),
      makeEdge("e2", "sym4", "handleRequest", "sym1", "Call"),
    ];

    const result = transformForVisualization(absoluteSymbols, absoluteEdges, { directory: "src" });

    expect(result.nodes.map((node) => node.name).sort()).toEqual(["logError", "validateInput"]);
    expect(result.edges).toHaveLength(1);
  });

  it("filters by directory with connected nodes", () => {
    // Add an edge between two nodes in the same directory
    const extraEdges = [
      ...edges,
      makeEdge("e5", "sym2", "logError", "sym3", "Call"),
    ];
    const result = transformForVisualization(symbols, extraEdges, { directory: "src/utils" });
    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(1);
  });

  it("truncates to maxNodes keeping most-connected", () => {
    const result = transformForVisualization(symbols, edges, { maxNodes: 2 });
    // sym1 has 2 outgoing edges (most connected), sym2 has 1 in + 1 out
    expect(result.nodes.length).toBeLessThanOrEqual(2);
    expect(result.metadata.truncated).toBe(true);
  });

  it("sets correct metadata", () => {
    const result = transformForVisualization(symbols, edges);
    expect(result.metadata.totalSymbols).toBe(5);
    expect(result.metadata.totalEdges).toBe(4);
    expect(result.metadata.truncated).toBe(false);
    expect(result.metadata.moduleCount).toBeGreaterThan(0);
  });

  it("adds graph-derived change lenses when git activity is unavailable", () => {
    const result = attachRecentActivity(
      transformForVisualization(symbols, edges),
      "/path/that/does/not/exist",
    );

    expect(result.changes?.length).toBeGreaterThan(0);
    expect(result.changes?.[0]?.source).toBe("call graph");
    expect(result.changes?.[0]?.focusNodeId).toBeTruthy();
  });

  it("extracts directory from filePath", () => {
    const result = transformForVisualization(symbols, edges);
    const reqNode = result.nodes.find((n) => n.name === "handleRequest");
    expect(reqNode?.directory).toBe("src/handlers");
  });

  it("derives module metadata for nodes", () => {
    const result = transformForVisualization(symbols, edges, { includeOrphans: true });
    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.nodes.every((node) => node.moduleId.length > 0)).toBe(true);
    expect(result.nodes.every((node) => node.moduleLabel.length > 0)).toBe(true);
    expect(result.modules.every((module) => module.category.length > 0)).toBe(true);
  });

  it("labels fixture-derived modules explicitly", () => {
    const fixtureSymbols: SymbolData[] = [
      makeSymbol("fixture1", "fixtureFn", "tests/fixtures/call-graph/sample.ts"),
      makeSymbol("runtime1", "runtimeFn", "src/indexer/runtime.ts"),
    ];

    const fixtureEdges: CallEdgeData[] = [
      makeEdge("e1", "fixture1", "runtimeFn", "runtime1", "Call"),
    ];

    const result = transformForVisualization(fixtureSymbols, fixtureEdges, { includeOrphans: true });
    const fixtureModule = result.modules.find((module) => module.pathPrefix === "tests/fixtures/call-graph");

    expect(fixtureModule?.label).toBe("fixture: call-graph");
    expect(fixtureModule?.category).toBe("fixture");
  });

  it("aggregates module-level edges", () => {
    const result = transformForVisualization(symbols, edges, { includeOrphans: true });
    expect(Array.isArray(result.moduleEdges)).toBe(true);
    expect(result.moduleEdges.every((edge) => edge.weight > 0)).toBe(true);
  });

  it("does not derive module-level edges from unresolved calls", () => {
    const unresolvedOnly: CallEdgeData[] = [
      makeEdge("e1", "sym1", "parseConfig", undefined, "Call", false),
    ];

    const result = transformForVisualization(symbols, unresolvedOnly, { includeOrphans: true });

    expect(result.edges).toHaveLength(0);
    expect(result.moduleEdges).toHaveLength(0);
  });
});

describe("visualize - safe HTML data", () => {
  it("keeps hostile names, paths and activity inert in the JSON data block", () => {
    const hostile = '</script><script>globalThis.injected=true</script><img src=x onerror="alert(1)"> & \'"';
    const data = transformForVisualization(
      [makeSymbol("s1", hostile, `src/${hostile}/a.ts`)],
      [], { includeOrphans: true },
    );
    data.changes = [{
      id: "change", title: hostile, kind: "hot", when: "today", source: "git",
      intent: hostile, summary: hostile, why: hostile, calls: 0, churn: 0,
      risk: "low", moduleId: data.modules[0].id, filePaths: [hostile],
    }];
    const html = generateVisualizationHtml(data);
    const embedded = html.match(/<script type="application\/json" id="visualization-data">([^]*?)<\/script>/)![1];
    expect(embedded).not.toContain("<");
    expect(embedded).not.toContain(">");
    expect(JSON.parse(embedded).data).toEqual(data);
    expect(html).not.toContain(hostile);
  });
});

describe("visualize - graph analysis", () => {
  function graph(ids: string[], links: Array<[string, string]>): VisualizationData {
    const data = transformForVisualization(ids.map((id) => makeSymbol(id, id, `src/${id}/file.ts`)),
      links.map(([from, to], index) => makeEdge(String(index), from, to, to)),
      { includeOrphans: true, maxNodes: Math.max(1, ids.length) });
    return data;
  }

  it("finds one mutually reachable module group instead of duplicate reciprocal pairs", () => {
    const data = graph(["A", "B", "C"], [["A", "B"], ["B", "C"], ["C", "A"], ["B", "A"]]);
    const result = analyzeVisualizationGraph(data);
    expect(result.moduleCycles).toEqual([data.modules.map((module) => module.id).sort()]);
    expect(result.symbolCycles).toEqual([["A", "B", "C"]]);
  });

  it("includes self recursion and long loops, but no groups for a DAG", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "self"];
    const data = graph(ids, [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"], ["f", "a"], ["self", "self"]]);
    expect(analyzeVisualizationGraph(data).symbolCycles).toEqual([["a", "b", "c", "d", "e", "f"], ["self"]]);
    const dag = analyzeVisualizationGraph(graph(["a", "b", "c"], [["a", "b"], ["b", "c"]]));
    expect(dag.moduleCycles).toEqual([]);
    expect(dag.symbolCycles).toEqual([]);
  });

  it("is permutation-stable, ignores absent endpoints, and never mutates the snapshot", () => {
    const data = graph(["a", "b", "c", "d"], [["a", "b"], ["b", "a"], ["b", "c"]]);
    data.edges.push({ source: "missing", target: "a", line: 1, callType: "Call", confidence: "Direct" });
    data.moduleEdges.push({ source: "missing", target: data.modules[0].id, weight: 2, callTypes: {} });
    const original = structuredClone(data);
    const result = analyzeVisualizationGraph(data);
    const reversed = { ...data, nodes: [...data.nodes].reverse(), edges: [...data.edges].reverse(),
      modules: [...data.modules].reverse(), moduleEdges: [...data.moduleEdges].reverse() };
    expect(analyzeVisualizationGraph(reversed)).toEqual(result);
    expect(data).toEqual(original);
  });

  it("has no cyclic groups for disconnected or empty snapshots", () => {
    expect(analyzeVisualizationGraph(graph(["a", "b", "c"], []))).toEqual({ moduleCycles: [], symbolCycles: [] });
    expect(analyzeVisualizationGraph(graph([], []))).toEqual({ moduleCycles: [], symbolCycles: [] });
  });

  it("keeps equal-name definitions separate by ID when only one is cyclic", () => {
    const data = graph(["duplicate-a", "duplicate-b", "helper"], [["duplicate-a", "helper"], ["helper", "duplicate-a"]]);
    data.nodes[0].name = data.nodes[1].name = "duplicate";
    const result = analyzeVisualizationGraph(data);
    expect(result.symbolCycles).toEqual([["duplicate-a", "helper"]]);
    expect(analyzeVisualizationGraph({ ...data, nodes: [...data.nodes].reverse() })).toEqual(result);
  });

  it("handles a 5,000-symbol SCC without recursive-stack failure", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `symbol-${String(i).padStart(4, "0")}`);
    const data = graph(ids, ids.map((id, i) => [id, ids[(i + 1) % ids.length]]));
    expect(analyzeVisualizationGraph(data).symbolCycles).toEqual([ids]);
  });
});
