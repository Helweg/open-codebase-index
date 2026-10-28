import type { CodebaseEditContextEvidence, CodebaseEditContextResult } from "../src/tools/edit-context.js";
import type { SharedCodebaseEditContextArgs } from "../src/tools/contracts.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { createMcpServer } from "../src/mcp-server.js";
import { codebase_edit_context } from "../src/adapters/opencode/tools.js";
import { resolveCodebaseContext } from "../src/tools/context.js";
import { resolveCodebaseEditContext, resolveCodebaseEditContextWithDependencies } from "../src/tools/edit-context.js";
import { executeCodebaseEditContext } from "../src/tools/execute-common.js";
import { getCallGraphData, getIndexerForProject, getSymbolTestEvidence, implementationLookup, searchCodebase } from "../src/tools/operations.js";
import { configCache, defaultProjectRoots, getIndexerCacheKey, indexerCache } from "../src/tools/operation-runtime.js";
import { countContextTokens } from "../src/tools/context-pack.js";
import { discoverSymbolTests, TEST_DISCOVERY_MAX_FILE_BYTES } from "../src/tools/test-discovery.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";

const config = parseConfig({
  indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
  search: { minScore: 0 },
});
let root: string;
let indexer: Indexer;

async function writeSource(relative: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-evidence-"));
  indexer = new Indexer(root, config, "opencode");
  const key = getIndexerCacheKey(root, "opencode");
  configCache.set(key, config);
  indexerCache.set(key, indexer);
  await writeSource("src/gate.ts", `export function signalGate(inputs: boolean[]) {
  return inputs.every(Boolean);
}
`);
  await writeSource("src/transport.ts", `import { signalGate } from './gate.js';
export function createTransport(inputs: boolean[]) {
  return signalGate(inputs);
}
`);
  await writeSource("src/foreign.ts", "export function foreignGate(inputs: boolean[]) { return false; }\n");
  await writeSource("tests/z-direct.test.ts", `import { signalGate as aliasGate } from '../src/gate.js';
it('rejects a false input', () => {
  expect(aliasGate([true, false])).toBe(false);
});
`);
  await writeSource("tests/a-related.test.ts", `import { createTransport } from '../src/transport.js';
it('forwards gate behavior', () => {
  expect(createTransport([true, false])).toBe(false);
});
`);
  await writeSource("tests/decoy.test.ts", `import { foreignGate as signalGate } from '../src/foreign.js';
it('uses a foreign import', () => {
  expect(signalGate([false])).toBe(false);
});
it('contains only spelling', () => {
  // signalGate([false]);
  expect('signalGate([false])').toContain('signalGate');
});
`);
});

afterEach(async () => {
  await indexer.close();
  const key = getIndexerCacheKey(root, "opencode");
  indexerCache.delete(key);
  configCache.delete(key);
  await fs.rm(root, { recursive: true, force: true });
});

function request(args: Partial<SharedCodebaseEditContextArgs> = {}): Promise<CodebaseEditContextResult> {
  return resolveCodebaseEditContext(root, "opencode", {
    query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts",
    includeTests: true, tokenBudget: 1200, ...args,
  });
}

async function assertRenderedReferences(response: CodebaseEditContextResult): Promise<void> {
  const rows = [...response.text.matchAll(/^- (.+):(\d+)-(\d+) \[(direct_target_test_reference|related_caller_test_reference)\] referencedSymbol=(\S+) referenceLine=(\d+)$/gmu)];
  const references = response.details.testDiscovery!.results;
  expect(rows.map((row) => ({
    filePath: row[1], startLine: Number(row[2]), endLine: Number(row[3]),
    evidenceKind: row[4], referencedSymbol: row[5], referenceLine: Number(row[6]),
  }))).toEqual(references.map(({ filePath, startLine, endLine, evidenceKind, referencedSymbol, referenceLine }) => ({
    filePath, startLine, endLine, evidenceKind, referencedSymbol, referenceLine,
  })));
  for (const reference of references) {
    const lines = (await fs.readFile(reference.filePath, "utf8")).split("\n");
    expect(reference.startLine).toBe(2);
    expect(reference.endLine).toBe(4);
    expect(reference.referenceLine).toBe(3);
    expect(lines[reference.referenceLine - 1]).toMatch(/\b(?:aliasGate|createTransport)\(/u);
    expect(reference).not.toHaveProperty("content");
  }
  expect(countContextTokens(response.text)).toBeLessThanOrEqual(response.details.tokenBudget);
}

describe("native-backed pre-edit test evidence", () => {
  it("renders alias-proved direct tests before graph and related tests, excluding name-only and foreign decoys", async () => {
    await indexer.index();
    const response = await request();
    expect(response.details.testDiscovery?.resolution).toBe("resolved");
    expect(response.details.testDiscovery?.results.map((result) => [path.relative(root, result.filePath), result.evidenceKind])).toEqual([
      ["tests/z-direct.test.ts", "direct_target_test_reference"],
      ["tests/a-related.test.ts", "related_caller_test_reference"],
    ]);
    expect(response.details.sourceIncluded).toBe(true);
    expect(response.text).toContain("Static source references; not runtime coverage.");
    expect(response.text.indexOf("direct_target_test_reference")).toBeLessThan(response.text.indexOf("## Direct callers"));
    expect(response.text.indexOf("## Direct callees")).toBeLessThan(response.text.indexOf("related_caller_test_reference"));
    expect(response.text).not.toContain("decoy.test.ts");
    await assertRenderedReferences(response);
  });

  it.each([128, 600, 1200])("credits only whole rendered rows at %i tokens", async (tokenBudget) => {
    await indexer.index();
    const proved = await getSymbolTestEvidence(root, "opencode", "signalGate", { targetFilePath: "src/gate.ts" });
    let selected: CodebaseEditContextEvidence | undefined;
    const response = await resolveCodebaseEditContextWithDependencies({
      query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts", includeTests: true, tokenBudget,
    }, {
      projectRoot: root,
      onSelectedEvidence: (evidence) => { selected = evidence; },
      searchCodebase: (query, options, control) => searchCodebase(root, "opencode", query, options, control),
      implementationLookup: (query, options, control) => implementationLookup(root, "opencode", query, options, control),
      getCallGraphData: (params, control) => getCallGraphData(root, "opencode", params, control),
      getTestEvidence: (target, control) => getSymbolTestEvidence(root, "opencode", target.symbol, { targetFilePath: target.filePath }, control),
    });
    await assertRenderedReferences(response);
    expect(selected?.testReferences).toEqual(response.details.testDiscovery?.results);
    for (const reference of selected!.testReferences) {
      expect(reference).not.toHaveProperty("content");
    }
    expect(response.details.testDiscovery?.omittedReferenceCount).toBe(proved.results.length - selected!.testReferences.length);
    expect(response.details.callerCount).toBe(selected!.callers.length);
    expect(response.details.calleeCount).toBe(selected!.callees.length);
    expect(response.details.sourceIncluded).toBe(selected!.sources.length > 0);
    if (tokenBudget === 128) expect(response.details.testDiscovery?.omittedReferenceCount).toBeGreaterThan(0);
    expect(response.text.match(/```/gu)?.length ?? 0).toBe(response.details.sourceIncluded ? 2 : 0);
  });

  it("preserves the omitted/false route and performs no test-discovery inventory work", async () => {
    await indexer.index();
    const inventory = vi.spyOn(indexer, "getIndexedFilePathsForActiveBranch");
    try {
      const omitted = await request({ includeTests: undefined });
      const disabled = await request({ includeTests: false });
      expect(omitted).toEqual(disabled);
      expect(disabled.details.sourceIncluded).toBe(true);
      expect(disabled.details.testDiscovery).toBeUndefined();
      expect(disabled.text).not.toContain("Source-linked tests");
      expect(inventory).not.toHaveBeenCalled();
    } finally {
      inventory.mockRestore();
    }
  });

  it("uses the selected host project root when the caller omits projectRoot", async () => {
    await indexer.index();
    const previous = defaultProjectRoots.get("opencode");
    defaultProjectRoots.set("opencode", root);
    try {
      const response = await resolveCodebaseEditContext(undefined, "opencode", {
        query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts", tokenBudget: 1200,
      });
      expect(response.details.sourceIncluded).toBe(true);
      expect(response.text).toContain("return inputs.every(Boolean);");
    } finally {
      if (previous === undefined) defaultProjectRoots.delete("opencode");
      else defaultProjectRoots.set("opencode", previous);
    }
  });

  it.each([
    { file: "src/multiline.ts", symbol: "multilineGate", source: "export\nfunction multilineGate() {\n  return 1;\n}\n" },
    { file: "src/decorated.py", symbol: "decorated_gate", source: "@decorator\ndef decorated_gate():\n    return 1\n" },
  ])("accepts native export/decorator declaration evidence for $symbol", async ({ file, symbol, source }) => {
    await writeSource(file, source);
    await indexer.index();
    const response = await request({ symbol, filePath: file });
    expect(response.details.resolution).toBe("resolved");
    expect(response.details.sourceIncluded).toBe(true);
    expect(response.text).toContain("return 1");
  });

  it("starts a large, fragmented declaration at its canonical signature rather than a ranked body slice", async () => {
    await writeSource("src/large-gate.ts", [
      "export function largeGate() {",
      "  let total = 0;",
      ...Array.from({ length: 240 }, (_, index) => `  total += ${index};`),
      "  return total;",
      "}",
    ].join("\n"));
    await indexer.index();
    const response = await request({ symbol: "largeGate", filePath: "src/large-gate.ts" });
    expect(response.details.sourceIncluded).toBe(true);
    expect(response.text).toContain("export function largeGate()");
    expect(response.text).toContain("  let total = 0;");
    expect(countContextTokens(response.text)).toBeLessThanOrEqual(1200);
  });

  it("withholds missing canonical source without treating an inaccessible-file marker as implementation", async () => {
    await indexer.index();
    await fs.rm(path.join(root, "src/gate.ts"));
    const response = await request();
    expect(response.details.sourceIncluded).toBe(false);
    expect(response.text).not.toContain("[File not accessible]");
  });

  it.each([false, true])("selects the exact source file rather than a suffix match with includeTests=%s", async (includeTests) => {
    await writeSource("nested/src/gate.ts", "export function signalGate(inputs: boolean[]) { return 'foreign-source'; }\n");
    await indexer.index();
    const definitions = await implementationLookup(root, "opencode", "signalGate", { limit: 10, exactSymbol: true });
    const foreign = definitions.find((definition) => definition.filePath.endsWith("/nested/src/gate.ts"))!;
    const target = definitions.find((definition) => definition.filePath === path.join(root, "src/gate.ts"))!;
    expect(foreign).toBeDefined();
    expect(target).toBeDefined();
    const response = await resolveCodebaseEditContextWithDependencies({
      query: "change signalGate", symbol: "signalGate", filePath: path.join(root, "src/gate.ts"), includeTests, tokenBudget: 1200,
    }, {
      projectRoot: root,
      searchCodebase: (query, options, control) => searchCodebase(root, "opencode", query, options, control),
      implementationLookup: async () => [foreign, target],
      getCallGraphData: (params, control) => getCallGraphData(root, "opencode", params, control),
      getTestEvidence: (selected, control) => getSymbolTestEvidence(root, "opencode", selected.symbol, { targetFilePath: selected.filePath }, control),
    });
    expect(response.details.sourceIncluded).toBe(true);
    expect(response.text).toContain("return inputs.every(Boolean);");
    expect(response.text).not.toContain("foreign-source");
  });

  it("withholds source credit when lookup returns only an enclosing declaration", async () => {
    await writeSource("src/wrapped.ts", [
      "export class SignalOwner {",
      "  signalGate(inputs: boolean[]) {",
      "    return inputs.every(Boolean);",
      "  }",
      "}",
      "",
    ].join("\n"));
    await indexer.index();
    const enclosing = await implementationLookup(root, "opencode", "SignalOwner", { limit: 10 });
    expect(enclosing.map((definition) => definition.name)).toContain("SignalOwner");
    const response = await resolveCodebaseEditContextWithDependencies({
      query: "change signalGate", symbol: "signalGate", filePath: "src/wrapped.ts", tokenBudget: 1200,
    }, {
      projectRoot: root,
      searchCodebase: (query, options, control) => searchCodebase(root, "opencode", query, options, control),
      implementationLookup: async () => enclosing,
      getCallGraphData: (params, control) => getCallGraphData(root, "opencode", params, control),
    });
    expect(response.details.resolution).toBe("resolved");
    expect(response.details.sourceIncluded).toBe(false);
    expect(response.text).not.toContain("export class SignalOwner");
    expect(response.text).not.toContain("return inputs.every(Boolean);");
  });

  it("uses targetFilePath only to disambiguate the target, not to restrict external test directories", async () => {
    await writeSource("src/duplicate.ts", "export function signalGate(inputs: boolean[]) { return true; }\n");
    await indexer.index();
    const response = await request();
    expect(response.details.testDiscovery?.results.map((result) => path.relative(root, result.filePath))).toEqual([
      "tests/z-direct.test.ts", "tests/a-related.test.ts",
    ]);
    const ambiguous = await request({ filePath: undefined });
    expect(ambiguous.details.resolution).toBe("ambiguous");
    expect(ambiguous.details.testDiscovery?.resolution).toBe("ambiguous");
    expect(ambiguous.details.testDiscovery?.results).toEqual([]);
    const scoped = await getSymbolTestEvidence(root, "opencode", "signalGate", {
      targetFilePath: path.join(root, "src/gate.ts"), directory: "tests", fileType: "ts",
    });
    expect(scoped.results.map((result) => result.evidenceKind)).toEqual([
      "direct_target_test_reference", "related_caller_test_reference",
    ]);
    const ordinary = await resolveCodebaseContext(root, "opencode", {
      query: "tests for signalGate", directory: "tests", tokenBudget: 1200,
    });
    expect(ordinary.details?.testDiscovery?.resolution).toBe("ambiguous");
    await expect(getSymbolTestEvidence(root, "opencode", "signalGate", { targetFilePath: "../escape.ts" }))
      .rejects.toThrow("inside the project root");
  });

  it.skipIf(process.platform === "win32")("normalizes canonical target paths and rejects a symlink escape before discovery", async () => {
    await indexer.index();
    const canonical = await getSymbolTestEvidence(root, "opencode", "signalGate", {
      targetFilePath: await fs.realpath(path.join(root, "src/gate.ts")),
    });
    expect(canonical.resolution).toBe("resolved");
    expect(canonical.results.map((result) => result.evidenceKind)).toEqual([
      "direct_target_test_reference", "related_caller_test_reference",
    ]);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "edit-test-outside-"));
    try {
      const externalTarget = path.join(outside, "gate.ts");
      await fs.writeFile(externalTarget, "export function signalGate() { return false; }\n");
      await fs.symlink(externalTarget, path.join(root, "src/escape.ts"));
      await expect(getSymbolTestEvidence(root, "opencode", "signalGate", { targetFilePath: "src/escape.ts" }))
        .rejects.toThrow("inside the project root");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("fails closed on stale target coordinates rather than crediting a new same-name declaration", async () => {
    await indexer.index();
    await writeSource("src/gate.ts", "// coordinate drift\nexport function signalGate(inputs: boolean[]) { return false; }\n");
    const response = await request();
    expect(response.details.testDiscovery?.resolution).toBe("ambiguous");
    expect(response.details.testDiscovery?.results).toEqual([]);
    expect(response.details.testDiscovery?.capped).toBe(true);
  });

  it("reports unsupported and non-authoritative targets without claiming tests are absent", async () => {
    await writeSource("src/math.py", "def calculate(value):\n    return value + 1\n");
    await indexer.index();
    const unsupported = await request({ symbol: "calculate", filePath: "src/math.py" });
    expect(unsupported.details.resolution).toBe("resolved");
    expect(unsupported.details.testDiscovery?.resolution).toBe("unsupported");
    expect(unsupported.details.testDiscovery?.results).toEqual([]);
    const conceptual = await request({ symbol: undefined });
    expect(conceptual.details.testDiscovery?.resolution).toBe("not_requested");
    expect(conceptual.details.testDiscovery?.results).toEqual([]);
    expect(unsupported.text).toContain("Static source references; not runtime coverage.");
    expect(unsupported.text).not.toContain("No tests");
  });

  it("retains the 20-reference discovery cap separately from response omissions", async () => {
    await writeSource("tests/z-direct.test.ts", `import { signalGate } from '../src/gate.js';\n${Array.from({ length: 24 }, (_, index) => `it('case ${index}', () => {\n  expect(signalGate([false])).toBe(false);\n});\n`).join("")}`);
    await indexer.index();
    const proved = await getSymbolTestEvidence(root, "opencode", "signalGate", { targetFilePath: "src/gate.ts" });
    expect(proved.results).toHaveLength(20);
    expect(proved.capped).toBe(true);
    const response = await request({ tokenBudget: 600 });
    expect(response.details.testDiscovery?.capped).toBe(true);
    expect(response.details.testDiscovery?.omittedReferenceCount).toBe(20 - response.details.testDiscovery!.results.length);
    expect(response.details.testDiscovery?.omittedReferenceCount).toBeGreaterThan(0);
    expect(countContextTokens(response.text)).toBeLessThanOrEqual(600);
  });

  it("does not reinterpret a saturated canonical lookup as unique after file filtering", async () => {
    for (let index = 0; index < 99; index += 1) {
      await writeSource(`duplicates/gate-${index}.ts`, "export function signalGate(inputs: boolean[]) { return false; }\n");
    }
    await indexer.index();
    const response = await request();
    expect(response.details.resolution).toBe("resolved");
    expect(response.details.testDiscovery?.resolution).toBe("ambiguous");
    expect(response.details.testDiscovery?.capped).toBe(true);
    expect(response.details.testDiscovery?.results).toEqual([]);
  });

  it("keeps oversized test files out of evidence and exposes discovery incompleteness", async () => {
    await indexer.index();
    await writeSource("tests/z-direct.test.ts", `//${"x".repeat(TEST_DISCOVERY_MAX_FILE_BYTES)}\n`);
    const response = await request();
    expect(response.details.testDiscovery?.capped).toBe(true);
    expect(response.details.testDiscovery?.results.map((result) => path.relative(root, result.filePath))).toEqual(["tests/a-related.test.ts"]);
    expect(response.details.testDiscovery?.omittedReferenceCount).toBe(0);
  });

  it("propagates cancellation from inside discovery rather than returning partial selected evidence", async () => {
    await indexer.index();
    const controller = new AbortController();
    const inventory = vi.spyOn(indexer, "getIndexedFilePathsForActiveBranch").mockImplementation(async () => {
      controller.abort();
      return [];
    });
    try {
      await expect(resolveCodebaseEditContext(root, "opencode", {
        query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts", includeTests: true,
      }, { signal: controller.signal })).rejects.toBeInstanceOf(OperationCancelledError);
    } finally {
      inventory.mockRestore();
    }
  });

  it("rejects cancellation during an empty definition lookup instead of returning not_found", async () => {
    await indexer.index();
    const controller = new AbortController();
    await expect(discoverSymbolTests(root, "missingGate", {}, {
      lookup: async (symbol) => {
        const definitions = await implementationLookup(root, "opencode", symbol, { limit: 100 });
        controller.abort();
        return definitions;
      },
      graph: (symbol, filePath) => getCallGraphData(root, "opencode", { name: symbol, filePath, direction: "callers" }),
      indexedFiles: () => indexer.getIndexedFilePathsForActiveBranch(),
      lexicalFiles: async () => { throw new Error("Cancellation must precede test inventory ranking."); },
    }, { signal: controller.signal })).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("returns unavailable, not fabricated empty resolved discovery, after an operational failure", async () => {
    await indexer.index();
    const inventory = vi.spyOn(indexer, "getIndexedFilePathsForActiveBranch").mockRejectedValue(new Error("inventory unavailable"));
    try {
      const response = await request();
      expect(response.details.testDiscovery?.resolution).toBe("unavailable");
      expect(response.details.testDiscovery?.results).toEqual([]);
      expect(response.details.sourceIncluded).toBe(true);
      expect(response.text).toContain("Discovery: unavailable");
    } finally {
      inventory.mockRestore();
    }
  });

  it("keeps the OpenCode host text-valued while rendering the same native-proved test citations", async () => {
    await indexer.index();
    const args = {
      query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts",
      includeTests: true, tokenBudget: 600, includeApiImpact: false,
      callerLimit: null, calleeLimit: null,
    };
    const shared = await resolveCodebaseEditContext(root, "opencode", args);
    const context = {
      worktree: root, abort: new AbortController().signal,
    } as Parameters<typeof codebase_edit_context.execute>[1];
    const text = await codebase_edit_context.execute(args, context);
    expect(typeof text).toBe("string");
    expect(text).toBe(shared.text);
    expect(text).toContain("direct_target_test_reference");
    await assertRenderedReferences({ text, details: shared.details });
  });

  it("preserves selected shared details through the real MCP text and structured-content boundary", async () => {
    await indexer.index();
    const shared = await executeCodebaseEditContext(root, "opencode", {
      query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts", includeTests: true, tokenBudget: 600,
    });
    expect(shared.details?.testDiscovery).toEqual(expect.objectContaining({ resolution: "resolved" }));
    await indexer.close();
    const server = createMcpServer(root, config, "opencode");
    indexer = getIndexerForProject(root, "opencode");
    const client = new Client({ name: "edit-test-evidence", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "codebase_edit_context")?.inputSchema.properties?.includeTests)
        .toEqual(expect.objectContaining({ type: "boolean", default: false }));
      const result = await client.callTool({
        name: "codebase_edit_context",
        arguments: { query: "change signalGate", symbol: "signalGate", filePath: "src/gate.ts", includeTests: true, tokenBudget: 600 },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const details = result.structuredContent as CodebaseEditContextResult["details"];
      expect(content[0].text).toBe(shared.text);
      expect(details.testDiscovery).toEqual(shared.details?.testDiscovery);
      await assertRenderedReferences({ text: content[0].text, details });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
