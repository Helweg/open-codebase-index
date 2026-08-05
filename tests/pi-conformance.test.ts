import { beforeEach, describe, expect, it, vi } from "vitest";
import { countContextTokens } from "../src/tools/utils.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const operationMocks = vi.hoisted(() => ({
  getCallGraphData: vi.fn(),
  getCallGraphPath: vi.fn(),
  getIndexHealthCheck: vi.fn(),
  runIndexHealthCheck: vi.fn(),
  searchCodebase: vi.fn(),
  searchCodebaseWithEffectiveness: vi.fn(),
  implementationLookup: vi.fn(),
  recordToolEffectiveness: vi.fn(),
  getIndexMetrics: vi.fn(() => ({ text: "" })),
  isToolEffectivenessEnabled: vi.fn(() => true),
}));

const autoIndexMocks = vi.hoisted(() => ({
  stopAutoIndex: vi.fn(async () => {}),
}));

vi.mock("../src/tools/operations.js", () => ({
  addKnowledgeBase: vi.fn(() => "Added knowledge base"),
  findSimilarCode: vi.fn(() => []),
  getCallGraphData: operationMocks.getCallGraphData,
  getCallGraphPath: operationMocks.getCallGraphPath,
  getIndexHealthCheck: operationMocks.getIndexHealthCheck,
  getIndexMetrics: operationMocks.getIndexMetrics,
  getIndexStatus: vi.fn(),
  getPrImpact: vi.fn(),
  implementationLookup: operationMocks.implementationLookup,
  listKnowledgeBases: vi.fn(() => "No knowledge bases configured."),
  removeKnowledgeBase: vi.fn(() => "Removed knowledge base"),
  runIndexCodebase: vi.fn(),
  runIndexHealthCheck: operationMocks.runIndexHealthCheck,
  searchCodebase: operationMocks.searchCodebase,
  searchCodebaseWithEffectiveness: operationMocks.searchCodebaseWithEffectiveness,
  recordToolEffectiveness: operationMocks.recordToolEffectiveness,
  getIndexLogs: vi.fn(() => ({ text: "" })),
  isToolEffectivenessEnabled: operationMocks.isToolEffectivenessEnabled,
}));

vi.mock("../src/utils/auto-index.js", () => ({
  stopAutoIndex: autoIndexMocks.stopAutoIndex,
}));

interface RegisteredTool {
  readonly name: string;
  readonly parameters?: {
    readonly properties?: Record<string, {
      readonly default?: number;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly anyOf?: ReadonlyArray<{ readonly minimum?: number; readonly maximum?: number; readonly type?: string }>;
    }>;
  };
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx?: { readonly cwd?: string },
  ) => Promise<{ readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly details?: unknown }>;
}

interface RegisteredPiRuntime {
  tools: Map<string, RegisteredTool>;
  beforeAgentStartHandlers: Array<(event: { systemPrompt: string }) => Promise<unknown> | unknown>;
  sessionShutdownHandlers: Array<(
    event: { type: "session_shutdown" },
    ctx: { cwd?: string },
  ) => Promise<unknown> | unknown>;
}

async function registerPiTools(): Promise<RegisteredPiRuntime> {
  const tools = new Map<string, RegisteredTool>();
  const beforeAgentStartHandlers: Array<(event: { systemPrompt: string }) => Promise<unknown> | unknown> = [];
  const sessionShutdownHandlers: RegisteredPiRuntime["sessionShutdownHandlers"] = [];
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(eventName, handler) {
      if (eventName === "before_agent_start") {
        beforeAgentStartHandlers.push(handler as (event: { systemPrompt: string }) => Promise<unknown> | unknown);
      }
      if (eventName === "session_shutdown") {
        sessionShutdownHandlers.push(handler as RegisteredPiRuntime["sessionShutdownHandlers"][number]);
      }
    },
  } satisfies Pick<ExtensionAPI, "registerTool" | "on">;

  const { default: codebaseIndexPiExtension } = await import("../src/pi-extension.js");
  codebaseIndexPiExtension(pi);

  return { tools, beforeAgentStartHandlers, sessionShutdownHandlers };
}

describe("Pi adapter conformance", () => {
  beforeEach(() => {
    operationMocks.getCallGraphData.mockReset();
    operationMocks.getCallGraphPath.mockReset();
    operationMocks.getIndexHealthCheck.mockReset();
    operationMocks.runIndexHealthCheck.mockReset();
    operationMocks.searchCodebase.mockReset();
    operationMocks.searchCodebaseWithEffectiveness.mockReset();
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
    operationMocks.implementationLookup.mockReset();
    operationMocks.recordToolEffectiveness.mockReset();
    operationMocks.isToolEffectivenessEnabled.mockReset();
    operationMocks.isToolEffectivenessEnabled.mockReturnValue(true);
    operationMocks.getIndexMetrics.mockClear();
    autoIndexMocks.stopAutoIndex.mockReset();
    autoIndexMocks.stopAutoIndex.mockResolvedValue(undefined);
  });

  it("awaits automatic indexing shutdown when the Pi session closes", async () => {
    let releaseStop!: () => void;
    const stopping = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    autoIndexMocks.stopAutoIndex.mockReturnValueOnce(stopping);
    const { sessionShutdownHandlers } = await registerPiTools();

    let settled = false;
    const shutdown = Promise.resolve(sessionShutdownHandlers[0]?.(
      { type: "session_shutdown" },
      { cwd: "/repo" },
    )).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(autoIndexMocks.stopAutoIndex).toHaveBeenCalledWith("/repo", "pi");
    expect(settled).toBe(false);
    releaseStop();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("registers codebase_context first as the preferred gateway route", async () => {
    const { tools } = await registerPiTools();
    const names = [...tools.keys()];

    expect(names[0]).toBe("codebase_context");
    expect(names).toContain("codebase_search");
    expect(names).toContain("implementation_lookup");
    expect(tools.get("codebase_context")?.parameters?.properties?.tokenBudget).toEqual(
      expect.objectContaining({
        default: 1200,
        anyOf: expect.arrayContaining([expect.objectContaining({ minimum: 128, maximum: 4000 })]),
      }),
    );
    expect(tools.get("codebase_context")?.parameters?.properties?.limit).toEqual(expect.objectContaining({
      default: 10,
      anyOf: expect.arrayContaining([expect.objectContaining({ minimum: 1, maximum: 100 })]),
    }));
    expect(tools.get("codebase_context")?.parameters?.properties?.maxDepth).toEqual(expect.objectContaining({
      default: 10,
      anyOf: expect.arrayContaining([expect.objectContaining({ minimum: 1, maximum: 100 })]),
    }));
    expect(tools.get("codebase_context")?.parameters?.properties?.diagnostic).toEqual(
      expect.objectContaining({
        anyOf: expect.arrayContaining([expect.objectContaining({ type: "boolean" })]),
      }),
    );
  });

  it("keeps Pi normal output unchanged when diagnostic is false", async () => {
    operationMocks.implementationLookup.mockResolvedValue([{
      chunkType: "function",
      name: "validateToken",
      filePath: "src/auth.ts",
      startLine: 12,
      endLine: 30,
      score: 0.95,
      content: "function validateToken() {}",
    }]);

    const { tools } = await registerPiTools();

    const withoutDiagnostic = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "unused", symbol: "validateToken", limit: 8, tokenBudget: 128 },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );
    const withDiagnosticFalse = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "unused", symbol: "validateToken", limit: 8, tokenBudget: 128, diagnostic: false },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(withDiagnosticFalse?.content[0]?.text).toEqual(withoutDiagnostic?.content[0]?.text);
    expect(withDiagnosticFalse?.details).toBeDefined();
    expect(withDiagnosticFalse?.details).not.toHaveProperty("diagnostic");
  });

  it("formats metadata-only peek results with the shared exact-search handoff", async () => {
    operationMocks.searchCodebase.mockResolvedValue([{
      filePath: "src/auth.ts",
      startLine: 4,
      endLine: 12,
      name: "validateToken",
      chunkType: "function",
      content: "",
      score: 0.98,
    }]);
    const { tools } = await registerPiTools();

    const result = await tools.get("codebase_peek")?.execute(
      "tool-call",
      { query: "authentication validation" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain('function "validateToken" at src/auth.ts:4-12');
    expect(result?.content[0]?.text).toContain('Exact-search handoff: use exact grep/search for "validateToken"');
    expect(result?.content[0]?.text).not.toContain("```");
    expect(result?.details).toEqual(expect.arrayContaining([expect.objectContaining({ name: "validateToken" })]));
    expect(operationMocks.searchCodebaseWithEffectiveness).toHaveBeenCalledWith("/repo", "pi", "peek", "authentication validation", expect.objectContaining({
      metadataOnly: true,
    }), expect.any(Function));
  });

  it("marks full-content search for effectiveness aggregation", async () => {
    operationMocks.searchCodebase.mockResolvedValue([]);
    const { tools } = await registerPiTools();

    const result = await tools.get("codebase_search")?.execute(
      "tool-call",
      { query: "request routing" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.searchCodebaseWithEffectiveness).toHaveBeenCalledWith(
      "/repo",
      "pi",
      "search",
      "request routing",
      expect.any(Object),
      expect.any(Function),
    );
    expect(result?.content[0]?.text).toBe("No matching code found. Try a different query or run index_codebase first.");
    expect(operationMocks.recordToolEffectiveness).toHaveBeenCalledTimes(1);
    expect(operationMocks.recordToolEffectiveness).toHaveBeenLastCalledWith("/repo", "pi", expect.objectContaining({
      outcome: "no-result",
      returnedTokenEstimate: countContextTokens(result?.content[0]?.text ?? ""),
    }));
  });

  it("records Pi formatter failures as one error and forwards metrics reset", async () => {
    const broken = {
      startLine: 1,
      endLine: 2,
      name: "broken",
      chunkType: "function",
      content: "source",
      score: 0.9,
      get filePath(): string {
        throw new Error("Pi formatter failed");
      },
    };
    operationMocks.searchCodebase.mockResolvedValueOnce([broken]);
    const { tools } = await registerPiTools();

    await expect(tools.get("codebase_search")?.execute(
      "tool-call",
      { query: "broken formatter" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    )).rejects.toThrow("Pi formatter failed");
    expect(operationMocks.recordToolEffectiveness).toHaveBeenCalledTimes(1);
    expect(operationMocks.recordToolEffectiveness).toHaveBeenLastCalledWith("/repo", "pi", expect.objectContaining({
      route: "search",
      outcome: "error",
      returnedTokenEstimate: 0,
    }));

    await tools.get("index_metrics")?.execute(
      "tool-call",
      { reset: true },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );
    expect(operationMocks.getIndexMetrics).toHaveBeenCalledWith("/repo", "pi", { reset: true });
  });

  it("formats caller results like other host adapters", async () => {
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callers",
      resolution: {
        status: "resolved",
        name: "validateToken",
        symbolId: "sym_validate",
        filePath: "src/auth.ts",
        startLine: 4,
        kind: "function",
        matchedBy: "name",
      },
      callers: [{
        fromSymbolName: "entryPoint",
        fromSymbolFilePath: "src/app.ts",
        fromSymbolId: "sym_entry",
        callType: "Call",
        confidence: "Direct",
        line: 12,
        isResolved: true,
      }],
      callees: [],
    });
    const { tools } = await registerPiTools();

    const result = await tools.get("call_graph")?.execute(
      "tool-call",
      { name: "validateToken", direction: "callers" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("\"validateToken\" at src/auth.ts:4 is called by 1 function(s)");
    expect(result?.content[0]?.text).toContain("entryPoint in src/app.ts");
    expect(result?.details).toEqual(expect.objectContaining({ direction: "callers" }));
  });

  it("formats callee results like other host adapters", async () => {
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callees",
      resolution: {
        status: "resolved",
        name: "entryPoint",
        symbolId: "sym_entry",
        filePath: "src/app.ts",
        startLine: 10,
        kind: "function",
        matchedBy: "name",
      },
      callers: [],
      callees: [{
        targetName: "validateToken",
        toSymbolId: "sym_validate",
        callType: "Call",
        confidence: "Direct",
        line: 21,
        isResolved: true,
      }],
    });
    const { tools } = await registerPiTools();

    const result = await tools.get("call_graph")?.execute(
      "tool-call",
      { name: "entryPoint", direction: "callees", symbolId: "sym_entry" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("[1] \u2192 validateToken (Call) at line 21 [resolved]");
    expect(result?.details).toEqual(expect.objectContaining({ direction: "callees" }));
  });

  it("formats call path results like other host adapters", async () => {
    operationMocks.getCallGraphPath.mockResolvedValue({
      from: {
        status: "resolved", name: "createOrder", symbolId: "sym_order", filePath: "src/order.ts",
        startLine: 10, kind: "function", matchedBy: "name",
      },
      to: {
        status: "resolved", name: "chargeCard", symbolId: "sym_charge", filePath: "src/pay.ts",
        startLine: 33, kind: "function", matchedBy: "name",
      },
      path: [
        { symbolName: "createOrder", filePath: "src/order.ts", line: 10, callType: "source" },
        { symbolName: "chargeCard", filePath: "src/pay.ts", line: 33, callType: "MethodCall" },
      ],
    });
    const { tools } = await registerPiTools();

    const result = await tools.get("call_graph_path")?.execute(
      "tool-call",
      { from: "createOrder", to: "chargeCard" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("Path (2 hops):");
    expect(result?.content[0]?.text).toContain("[start] createOrder (src/order.ts:10)");
    expect(result?.content[0]?.text).toContain("--MethodCall--> chargeCard (src/pay.ts:33)");
    expect(result?.details).toEqual(expect.objectContaining({ path: expect.any(Array) }));
  });

  it("routes codebase_context from/to through call-graph lookup with fallback", async () => {
    operationMocks.getCallGraphPath.mockResolvedValue({
      from: {
        status: "resolved", name: "callerFn", symbolId: "sym_caller", filePath: "src/app.ts",
        startLine: 10, kind: "function", matchedBy: "name",
      },
      to: {
        status: "resolved", name: "targetFn", symbolId: "sym_target", filePath: "src/target.ts",
        startLine: 1, kind: "function", matchedBy: "name",
      },
      path: [],
    });
    operationMocks.getCallGraphData.mockResolvedValue({
      direction: "callers",
      resolution: {
        status: "resolved", name: "targetFn", symbolId: "sym_target", filePath: "src/target.ts",
        startLine: 1, kind: "function", matchedBy: "name",
      },
      callers: [{
        fromSymbolName: "callerFn",
        fromSymbolFilePath: "src/app.ts",
        fromSymbolId: "sym_caller",
        callType: "Call",
        confidence: "Direct",
        line: 19,
        isResolved: false,
      }],
      callees: [],
    });

    const { tools } = await registerPiTools();
    const result = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "dependency", from: "callerFn", to: "targetFn" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.getCallGraphPath).toHaveBeenCalledWith("/repo", "pi", "callerFn", "targetFn", 10, undefined, undefined);
    expect(operationMocks.getCallGraphData).toHaveBeenCalledWith("/repo", "pi", {
      name: "targetFn",
      direction: "callers",
      filePath: undefined,
    });
    expect(result?.content[0]?.text).toContain("Direct path: callerFn --Call--> targetFn");
    expect(result?.content[0]?.text).toContain("src/app.ts:19");
    expect(result?.content[0]?.text).toContain("edge is unresolved");
  });

  it("routes codebase_context symbol lookups through implementation lookup", async () => {
    operationMocks.implementationLookup.mockResolvedValue([
      {
        chunkType: "function",
        name: "validateToken",
        filePath: "src/auth.ts",
        startLine: 12,
        endLine: 30,
        score: 0.95,
        content: "function validateToken() {}",
      },
    ]);

    const { tools } = await registerPiTools();

    const result = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "unused", symbol: "validateToken", limit: 8, tokenBudget: 128 },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.implementationLookup).toHaveBeenCalledWith("/repo", "pi", "validateToken", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
    });
    expect(result?.content[0]?.text).toContain("src/auth.ts:12-30");
    expect(result?.content[0]?.text).not.toContain("function validateToken() {}");
    expect(countContextTokens(result?.content[0]?.text ?? "")).toBeLessThanOrEqual(128);
    expect(result?.details).toEqual(expect.objectContaining({
      tokenBudget: 128,
      selectedCount: 1,
      results: [expect.objectContaining({ filePath: "src/auth.ts", name: "validateToken" })],
    }));
    expect(JSON.stringify(result?.details)).not.toContain("content");
  });

  it("routes inferred symbol-style codebase_context queries through implementation lookup", async () => {
    operationMocks.implementationLookup.mockResolvedValue([
      {
        chunkType: "function",
        name: "getStatus",
        filePath: "src/auth.ts",
        startLine: 12,
        endLine: 30,
        score: 0.95,
        content: "function getStatus() {}",
      },
    ]);

    const { tools } = await registerPiTools();

    const result = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "where is `getStatus` defined" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.implementationLookup).toHaveBeenCalledWith("/repo", "pi", "getStatus", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
    });
    expect(result?.content[0]?.text).toContain("\"getStatus\"");
  });

  it("falls back to conceptual search when inferred symbol lookup returns no matches", async () => {
    operationMocks.implementationLookup.mockResolvedValue([]);
    operationMocks.searchCodebase.mockResolvedValue([
      {
        chunkType: "function",
        name: "missingDefinition",
        filePath: "src/auth.ts",
        startLine: 12,
        endLine: 30,
        score: 0.95,
        content: "function missingDefinition() {}",
      },
    ]);

    const { tools } = await registerPiTools();

    const result = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "show definition for `missingDefinition`" },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.implementationLookup).toHaveBeenCalledWith("/repo", "pi", "missingDefinition", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
    });
    expect(operationMocks.searchCodebase).toHaveBeenCalledWith(
      "/repo",
      "pi",
      "show definition for `missingDefinition`",
      {
        limit: 100,
        fileType: undefined,
        directory: undefined,
        metadataOnly: true,
      },
    );
    expect(result?.content[0]?.text).toContain("Codebase evidence");
    expect(result?.content[0]?.text).toContain("Recovery: inferred definition missed.");
    expect(result?.content[0]?.text).not.toContain("show definition for `missingDefinition`");
  });

  it("routes codebase_context query-only lookups with metadata-only search", async () => {
    operationMocks.searchCodebase.mockResolvedValue([
      {
        chunkType: "function",
        name: "validateToken",
        filePath: "src/auth.ts",
        startLine: 12,
        endLine: 30,
        score: 0.95,
        content: "function validateToken() {}",
      },
    ]);

    const { tools } = await registerPiTools();

    const result = await tools.get("codebase_context")?.execute(
      "tool-call",
      { query: "validation helper", limit: 4, fileType: "ts", directory: "src", tokenBudget: 128 },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.searchCodebase).toHaveBeenCalledWith("/repo", "pi", "validation helper", {
      limit: 100,
      fileType: "ts",
      directory: "src",
      metadataOnly: true,
    });
    expect(result?.content[0]?.text).toContain("Codebase evidence");
    expect(result?.content[0]?.text).not.toContain("validation helper");
    expect(countContextTokens(result?.content[0]?.text ?? "")).toBeLessThanOrEqual(128);
    expect(JSON.stringify(result?.details)).not.toContain("function validateToken() {}");
  });

  it("accepts explicit null optional codebase_context arguments", async () => {
    operationMocks.searchCodebase.mockResolvedValue([]);
    const { tools } = await registerPiTools();

    await tools.get("codebase_context")?.execute(
      "tool-call",
      {
        query: "validation helper",
        from: null,
        to: null,
        symbol: null,
        limit: null,
        maxDepth: null,
        fileType: null,
        directory: null,
        tokenBudget: null,
      },
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(operationMocks.searchCodebase).toHaveBeenCalledWith("/repo", "pi", "validation helper", {
      limit: 100,
      fileType: undefined,
      directory: undefined,
      metadataOnly: true,
    });
  });

  it("injects client-neutral repository guidance on before_agent_start", async () => {
    const { beforeAgentStartHandlers } = await registerPiTools();

    const result = await beforeAgentStartHandlers[0]?.({ systemPrompt: "Base system prompt." });

    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Check index_status first"),
    });
    expect((result as { systemPrompt?: string }).systemPrompt).toContain("codebase_context");
    expect((result as { systemPrompt?: string }).systemPrompt).toContain("implementation_lookup");
    expect((result as { systemPrompt?: string }).systemPrompt).toContain("call_graph");
  });

  it("returns INDEX_BUSY details from the Pi health-check tool", async () => {
    operationMocks.getIndexHealthCheck.mockRejectedValue(new Error("raw health-check operation must not be used"));
    operationMocks.runIndexHealthCheck.mockResolvedValue({
      kind: "busy",
      text: "INDEX_BUSY: another index operation is already in progress (PID 4444, operation health-check, since 2026-07-17T10:00:00.000Z).",
    });
    const { tools } = await registerPiTools();

    const result = await tools.get("index_health_check")?.execute(
      "tool-call",
      {},
      new AbortController().signal,
      () => {},
      { cwd: "/repo" },
    );

    expect(result?.content[0]?.text).toContain("INDEX_BUSY");
    expect(result?.content[0]?.text).toContain("PID 4444");
    expect(result?.details).toEqual({ code: "INDEX_BUSY" });
  });
});
