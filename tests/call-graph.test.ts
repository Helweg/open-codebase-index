import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseConfig } from "../src/config/schema.js";
import { extractCalls, Database, hashContent, parseFiles } from "../src/native/index.js";
import type { SymbolData, CallEdgeData } from "../src/native/index.js";
import {
  Indexer,
  CALL_GRAPH_LANGUAGES,
  CALL_GRAPH_SYMBOL_CHUNK_TYPES,
  CASE_INSENSITIVE_LANGUAGES,
  findEnclosingSymbol,
} from "../src/indexer/index.js";

const fixturesDir = path.join(__dirname, "fixtures", "call-graph");

describe("call-graph", () => {
  let tempDir: string;
  let _dbs: Database[] = [];

function openDb(): Database {
  const d = new Database(path.join(tempDir, "test.db"));
  _dbs.push(d);
  return d;
}

function openIndexerDb(): Database {
  const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const d = new Database(dbPath);
  _dbs.push(d);
  return d;
}

function writeGitBranchHead(branchName: string): void {
  const gitDir = path.join(tempDir, ".git");
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branchName}\n`);
  fs.writeFileSync(
    path.join(gitDir, "refs", "heads", branchName),
    "1111111111111111111111111111111111111111\n",
  );
}

function createIndexerConfig(): ReturnType<typeof parseConfig> {
  return parseConfig({
    embeddingProvider: "custom",
    customProvider: {
      baseUrl: "http://localhost:11434/v1",
      model: "mock-model",
      dimensions: 8,
    },
    indexing: { watchFiles: false },
  });
}

function migrationMetadataKey(prefix: string, catalogIdentity = "default"): string {
  return `${prefix}.${hashContent(catalogIdentity).slice(0, 24)}`;
}

  function buildFileSymbols(filePath: string, content: string): SymbolData[] {
    const parsed = parseFiles([{ path: filePath, content }])[0];
    const symbols: SymbolData[] = [];

    for (const chunk of parsed.chunks) {
      if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
      symbols.push({
        id: `sym_${hashContent(filePath + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`,
        filePath,
        name: chunk.name,
        kind: chunk.chunkType,
        startLine: chunk.startLine,
        startCol: 0,
        endLine: chunk.endLine,
        endCol: 0,
        language: chunk.language,
      });
    }

    return symbols;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-graph-test-"));
    _dbs = [];
  });

  afterEach(() => {
    _dbs.forEach((d) => d.close());
    _dbs = [];
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

 describe("call extraction", () => {
     it("should extract method calls", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
          const calls = extractCalls(content, "php");

          const methodCalls = calls.filter((c) => c.callType === "MethodCall");
          const methodNames = methodCalls.map((c) => c.calleeName);
          expect(methodNames).toContain("validate");
          expect(methodNames).toContain("add");
          expect(methodNames).toContain("subtract");
        });

        it("should extract nullsafe method calls", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
          const calls = extractCalls(content, "php");

          const resetCall = calls.find((c) => c.calleeName === "reset");
          expect(resetCall).toBeDefined();
          expect(resetCall!.callType).toBe("MethodCall");
        });

        it("should extract static method calls", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
          const calls = extractCalls(content, "php");

          const createCall = calls.find((c) => c.calleeName === "create");
          expect(createCall).toBeDefined();
          expect(createCall!.callType).toBe("MethodCall");
        });

        it("should detect method calls using zero-allocation approach", () => {
          const content = fs.readFileSync(path.join(fixturesDir, "php-method-zeroalloc.php"), "utf-8");
          const calls = extractCalls(content, "php");

          // Check that method calls are correctly identified without using parent() on callee.name
          const methodCalls = calls.filter((c) => c.callType === "MethodCall");
          expect(methodCalls.length).toBeGreaterThan(0);

          // Verify specific method call patterns
          expect(methodCalls.some(c => c.calleeName === "process")).toBe(true);
          expect(methodCalls.some(c => c.calleeName === "validate")).toBe(true);
        });

    it("should extract method calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "method-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("validate");
      expect(callNames).toContain("reset");
      expect(callNames).toContain("add");
      expect(callNames).toContain("subtract");
      expect(callNames).toContain("square");
    });

    it("should extract constructor calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "constructors.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const constructorCalls = calls.filter((c) => c.callType === "Constructor");
      const constructorNames = constructorCalls.map((c) => c.calleeName);
      expect(constructorNames).toContain("SimpleClass");
      expect(constructorNames).toContain("ClassWithArgs");
      expect(constructorNames).toContain("NestedConstruction");
      expect(constructorNames).toContain("GenericBox");
    });

    it("should extract imports", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "imports.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const importCalls = calls.filter((c) => c.callType === "Import");
      const importNames = importCalls.map((c) => c.calleeName);
      expect(importNames).toContain("parseFile");
      expect(importNames).toContain("hashContent");
      expect(importNames).toContain("Indexer");
      expect(importNames).toContain("Logger");
      expect(importNames).toContain("Database");
    });

    it("should handle nested calls", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "nested-calls.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("inner");
      expect(callNames).toContain("middle");
      expect(callNames).toContain("deep");
      expect(callNames).toContain("compute");
      expect(callNames).toContain("transform");
      expect(callNames).toContain("getData");
    });

    it("should handle edge cases", () => {
      const content = fs.readFileSync(path.join(fixturesDir, "edge-cases.ts"), "utf-8");
      const calls = extractCalls(content, "typescript");

      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("method");
      expect(callNames).toContain("trueCase");
      expect(callNames).toContain("falseCase");
      expect(callNames).toContain("riskyOperation");
      expect(callNames).toContain("handleError");
      expect(callNames).toContain("cleanup");
      expect(callNames).toContain("fetchData");
    });

    describe("php call extraction", () => {
      it("should extract direct function calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-simple-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const callNames = calls.map((c) => c.calleeName);
        expect(callNames).toContain("directcall");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("compute");

        const directCall = calls.find((c) => c.calleeName === "directcall");
        expect(directCall).toBeDefined();
        expect(directCall!.callType).toBe("Call");
      });

      it("should normalize PHP function names to lowercase", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-simple-calls.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const helperCalls = calls.filter((c) => c.calleeName === "helper" && c.callType === "Call");
        expect(helperCalls.length).toBe(2);
      });

      it("should extract method calls", () => {
         const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
         const calls = extractCalls(content, "php");

         const methodCalls = calls.filter((c) => c.callType === "MethodCall");
         const methodNames = methodCalls.map((c) => c.calleeName);
         expect(methodNames).toContain("validate");
         expect(methodNames).toContain("add");
         expect(methodNames).toContain("subtract");
       });

     it("should extract nullsafe method calls", () => {
         const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
         const calls = extractCalls(content, "php");

         const resetCall = calls.find((c) => c.calleeName === "reset");
         expect(resetCall).toBeDefined();
         expect(resetCall!.callType).toBe("MethodCall");
      });

      it("should extract static method calls", () => {
         const content = fs.readFileSync(path.join(fixturesDir, "php-method-calls.php"), "utf-8");
         const calls = extractCalls(content, "php");

         const createCall = calls.find((c) => c.calleeName === "create");
         expect(createCall).toBeDefined();
         expect(createCall!.callType).toBe("MethodCall");
      });

      it("should extract constructor calls", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-constructors.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const constructorCalls = calls.filter((c) => c.callType === "Constructor");
        const constructorNames = constructorCalls.map((c) => c.calleeName);
        expect(constructorNames).toContain("SimpleClass");
        expect(constructorNames).toContain("ClassWithArgs");
      });

      it("should extract use imports", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-imports.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const importCalls = calls.filter((c) => c.callType === "Import");
        const importNames = importCalls.map((c) => c.calleeName);
        expect(importNames).toContain("User");
        expect(importNames).toContain("AuthService");
      });

      it("should extract grouped use imports", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-imports.php"), "utf-8");
        const calls = extractCalls(content, "php");

        const importCalls = calls.filter((c) => c.callType === "Import");
        const importNames = importCalls.map((c) => c.calleeName);
        expect(importNames).toContain("StringHelper");
        expect(importNames).toContain("ArrayHelper");
      });

      it("should distinguish PHP 8.x calls from first-class callable references", () => {
        const content = fs.readFileSync(path.join(fixturesDir, "php-8-features.php"), "utf-8");
        const calls = extractCalls(content, "php");
        const callNames = calls.map((call) => call.calleeName);

        expect(callNames).toContain("displayname");
        expect(callNames).toContain("fallback");
        expect(callNames).toContain("normalize");
        expect(callNames).toContain("formatstatus");
        expect(callNames).toContain("now");
        expect(callNames).toContain("trim");
        expect(callNames).toContain("strtolower");
        expect(callNames).toContain("format");
        expect(callNames).toContain("create");
        expect(calls).toContainEqual(
          expect.objectContaining({ calleeName: "Job", callType: "Constructor" }),
        );
        expect(calls).toContainEqual(
          expect.objectContaining({ calleeName: "Profile", callType: "Constructor" }),
        );

        expect(callNames).not.toContain("callableonly");
        expect(callNames).not.toContain("methodonly");
        expect(callNames).not.toContain("staticonly");
        expect(callNames).not.toContain("featureflag");
        expect(callNames).not.toContain("attribute");
      });
    });

    describe("php same-file case-insensitive resolution", () => {
      it("resolves a mixed-case same-file PHP function call through the Indexer", async () => {
        const phpContent = `<?php
use Vendor\\Package\\ImportedService;

function callBuildReport(): string {
    // Keep this function large enough to form an independent semantic chunk.
    return BUILDREPORT();
}

function buildReport(): string {
    // Keep the mixed-case declaration as an independent graph symbol.
    return "report";
}

function reportbuilder(): string {
    // A legal PHP function whose folded name collides with the class below.
    return "function";
}

function createReportBuilder(): ReportBuilder {
    // Constructor resolution must select the class despite the function collision.
    return new REPORTBUILDER();
}

class ReportBuilder {
    public function build(): string {
        return "report";
    }
}
`;
        const callSites = extractCalls(phpContent, "php");
        const importSite = callSites.find((site) => site.callType === "Import");
        expect(importSite?.calleeName).toBe("ImportedService");

        const projectDir = path.join(tempDir, "php-project");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, "report.php"), phpContent, "utf-8");

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
          const data = (body.input ?? []).map(() => ({ embedding: Array(8).fill(0.125) }));
          return new Response(
            JSON.stringify({ data, usage: { total_tokens: Math.max(1, data.length) } }),
            { status: 200 },
          );
        });
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          indexing: { watchFiles: false },
        });
        const indexer = new Indexer(projectDir, config, "opencode");

        try {
          await indexer.index();

          const symbols = await indexer.getSymbolsForBranch();
          const caller = symbols.find((symbol) => symbol.name === "callBuildReport");
          const target = symbols.find((symbol) => symbol.name === "buildReport");
          const factory = symbols.find((symbol) => symbol.name === "createReportBuilder");
          const classSymbol = symbols.find((symbol) => symbol.name === "ReportBuilder");
          expect(caller).toBeDefined();
          expect(target).toBeDefined();
          expect(factory).toBeDefined();
          expect(classSymbol).toBeDefined();

          const functionEdge = (await indexer.getCallees(caller!.id)).find(
            (edge) => edge.targetName === "buildreport",
          );
          expect(functionEdge).toMatchObject({
            callType: "Call",
            isResolved: true,
            toSymbolId: target!.id,
          });

          const constructorEdge = (await indexer.getCallees(factory!.id)).find(
            (edge) => edge.callType === "Constructor",
          );
          expect(constructorEdge).toMatchObject({
            targetName: "REPORTBUILDER",
            isResolved: true,
            toSymbolId: classSymbol!.id,
          });
        } finally {
          await indexer.close();
          fetchSpy.mockRestore();
        }
      });

      it("reprocesses unchanged PHP call edges after a resolution upgrade", async () => {
        const phpContent = `<?php
function callBuildReport(): string {
    // Keep this function large enough to form an independent semantic chunk.
    return BUILDREPORT();
}

function buildReport(): string {
    // Keep the mixed-case declaration as an independent graph symbol.
    return "report";
}
`;
        const projectDir = path.join(tempDir, "php-upgrade-project");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, "report.php"), phpContent, "utf-8");

        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
          const data = (body.input ?? []).map(() => ({ embedding: Array(8).fill(0.125) }));
          return new Response(
            JSON.stringify({ data, usage: { total_tokens: Math.max(1, data.length) } }),
            { status: 200 },
          );
        });
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          indexing: { watchFiles: false },
        });

        CASE_INSENSITIVE_LANGUAGES.delete("php");
        let indexer = new Indexer(projectDir, config, "opencode");
        try {
          await indexer.index();
          const caller = (await indexer.getSymbolsForBranch()).find(
            (symbol) => symbol.name === "callBuildReport",
          );
          const edge = (await indexer.getCallees(caller!.id)).find(
            (candidate) => candidate.targetName === "buildreport",
          );
          expect(edge?.isResolved).toBe(false);
        } finally {
          await indexer.close();
          CASE_INSENSITIVE_LANGUAGES.add("php");
        }

        const database = new Database(path.join(projectDir, ".opencode", "index", "codebase.db"));
        database.deleteMetadata(migrationMetadataKey("index.callGraphResolutionVersion"));
        database.close();
        const embeddingCallsBeforeUpgrade = fetchSpy.mock.calls.length;

        indexer = new Indexer(projectDir, config, "opencode");
        try {
          await indexer.index();
          const symbols = await indexer.getSymbolsForBranch();
          const caller = symbols.find((symbol) => symbol.name === "callBuildReport");
          const target = symbols.find((symbol) => symbol.name === "buildReport");
          const edge = (await indexer.getCallees(caller!.id)).find(
            (candidate) => candidate.targetName === "buildreport",
          );
          expect(edge).toMatchObject({
            isResolved: true,
            toSymbolId: target!.id,
          });
          expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeUpgrade);
        } finally {
          await indexer.close();
          fetchSpy.mockRestore();
        }
      });

      it("reprocesses unchanged PHP files after the PHP 8 grammar upgrade", async () => {
        const projectDir = path.join(tempDir, "php-grammar-upgrade-project");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, "relative.php"),
          `<?php
namespace App;
function helper(): string { return "ok"; }
function caller(): string { return namespace\\helper(); }
`,
          "utf-8",
        );
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
          const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
          return new Response(
            JSON.stringify({
              data: inputs.map(() => ({ embedding: Array.from({ length: 8 }, () => 0.125) })),
              usage: { total_tokens: Math.max(1, inputs.length) },
            }),
            { status: 200 },
          );
        });
        const config = parseConfig({
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          indexing: { watchFiles: false },
        });

        CALL_GRAPH_LANGUAGES.delete("php");
        let indexer = new Indexer(projectDir, config, "opencode");
        try {
          await indexer.index();
          const caller = (await indexer.getSymbolsForBranch()).find(
            (symbol) => symbol.name === "caller",
          );
          expect(caller).toBeDefined();
          expect(await indexer.getCallees(caller!.id)).toHaveLength(0);
        } finally {
          await indexer.close();
          CALL_GRAPH_LANGUAGES.add("php");
        }

        const database = new Database(path.join(projectDir, ".opencode", "index", "codebase.db"));
        database.setMetadata(migrationMetadataKey("index.callGraphResolutionVersion"), "3");
        database.close();
        const embeddingCallsBeforeUpgrade = fetchSpy.mock.calls.length;
        indexer = new Indexer(projectDir, config, "opencode");
        try {
          await indexer.index();
          const caller = (await indexer.getSymbolsForBranch()).find(
            (symbol) => symbol.name === "caller",
          );
          const edge = (await indexer.getCallees(caller!.id)).find(
            (candidate) => candidate.targetName === "helper",
          );
          expect(edge).toBeDefined();
          expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeUpgrade);
        } finally {
          await indexer.close();
          fetchSpy.mockRestore();
        }
      });
    });

    describe("apex call extraction", () => {
      it("should extract direct function calls", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-simple-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const callNames = calls.map((c) => c.calleeName);
        expect(callNames).toContain("directcall");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("compute");

        const directCall = calls.find((c) => c.calleeName === "directcall");
        expect(directCall).toBeDefined();
        expect(directCall!.callType).toBe("Call");
      });

      it("should normalize Apex function names to lowercase (case-insensitive language)", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-simple-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        // Both `helper(...)` invocations + `HELPER()` invocation should normalize to `helper`.
        const helperCalls = calls.filter(
          (c) => c.calleeName === "helper" && c.callType === "Call",
        );
        expect(helperCalls.length).toBe(3);

        // `MyFunc()` should normalize to `myfunc`.
        const myFuncCall = calls.find((c) => c.calleeName === "myfunc");
        expect(myFuncCall).toBeDefined();
        expect(myFuncCall!.callType).toBe("Call");
      });

      it("should extract method calls", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const methodCalls = calls.filter((c) => c.callType === "MethodCall");
        const methodNames = methodCalls.map((c) => c.calleeName);
        expect(methodNames).toContain("validate");
        expect(methodNames).toContain("add");
        expect(methodNames).toContain("subtract");
        expect(methodNames).toContain("cleanup");
      });

      it("should extract static method calls as method calls", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        // Apex grammar produces method_invocation with object field for both
        // instance and static calls; we report both as MethodCall.
        const staticDo = calls.find((c) => c.calleeName === "staticdo");
        expect(staticDo).toBeDefined();
        expect(staticDo!.callType).toBe("MethodCall");
      });

      it("should extract chained method calls with case normalization", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        // Foo.Bar.DeepCall() → method_invocation with object=field_access(Foo.Bar)
        // and name=DeepCall, normalized to lowercase.
        const deepCall = calls.find((c) => c.calleeName === "deepcall");
        expect(deepCall).toBeDefined();
        expect(deepCall!.callType).toBe("MethodCall");

        // Method() should also normalize
        const methodCall = calls.find(
          (c) => c.calleeName === "method" && c.callType === "MethodCall",
        );
        expect(methodCall).toBeDefined();
      });

      it("should extract constructor calls preserving original case", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-constructors.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const constructorCalls = calls.filter(
          (c) => c.callType === "Constructor",
        );
        const constructorNames = constructorCalls.map((c) => c.calleeName);
        // Constructor names keep original casing (they need to match
        // class_declaration symbols which use exact-case names).
        expect(constructorNames).toContain("Account");
        expect(constructorNames).toContain("SimpleClass");
        expect(constructorNames).toContain("ClassWithArgs");
      });

      it("should not produce import edges (Apex has no imports)", () => {
        const content = fs.readFileSync(
          path.join(fixturesDir, "apex-method-calls.cls"),
          "utf-8",
        );
        const calls = extractCalls(content, "apex");

        const importCalls = calls.filter((c) => c.callType === "Import");
        expect(importCalls.length).toBe(0);
      });
    });

    describe("matlab call extraction", () => {
      const content = `function score = calculateSignal(model, prices)
    returns = diff(log(prices));
    normalized = SignalUtils.normalize(returns);
    score = model.score(normalized) + helper(normalized);
    first = prices(1);
end

function value = helper(values)
    value = mean(values) / std(values);
end
`;

      it("should extract direct function calls", () => {
        const calls = extractCalls(content, "matlab");
        const callNames = calls.map((c) => c.calleeName);

        expect(callNames).toContain("diff");
        expect(callNames).toContain("log");
        expect(callNames).toContain("helper");
        expect(callNames).toContain("mean");
        expect(callNames).toContain("std");
      });

      it("should extract method and package calls", () => {
        const calls = extractCalls(content, "matlab");

        const normalizeCall = calls.find((c) => c.calleeName === "normalize");
        expect(normalizeCall).toBeDefined();
        expect(normalizeCall!.callType).toBe("MethodCall");

        const scoreCall = calls.find((c) => c.calleeName === "score");
        expect(scoreCall).toBeDefined();
        expect(scoreCall!.callType).toBe("MethodCall");
      });

      it("should document indexing syntax ambiguity", () => {
        const calls = extractCalls(content, "matlab");
        const pricesCall = calls.find((c) => c.calleeName === "prices");

        expect(pricesCall).toBeDefined();
        expect(pricesCall!.callType).toBe("Call");
      });

      it("should produce edges owned by MATLAB function symbols", () => {
        expect(CALL_GRAPH_LANGUAGES.has("matlab")).toBe(true);

        const filePath = path.join(tempDir, "calculateSignal.m");
        const parsed = parseFiles([{ path: filePath, content }]);
        expect(parsed.length).toBe(1);

        const fileSymbols: SymbolData[] = [];
        for (const chunk of parsed[0].chunks) {
          if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
          fileSymbols.push({
            id: `sym_${hashContent(
              filePath + ":" + chunk.name + ":" + chunk.chunkType + ":" +
              chunk.startLine + ":" + (chunk.startCol ?? 0),
            ).slice(0, 16)}`,
            filePath,
            name: chunk.name,
            kind: chunk.chunkType,
            startLine: chunk.startLine,
            startCol: 0,
            endLine: chunk.endLine,
            endCol: 0,
            language: chunk.language,
          });
        }

        expect(fileSymbols.length).toBeGreaterThan(0);
        expect(fileSymbols.some((s) => s.name === "calculateSignal")).toBe(true);
        expect(fileSymbols.some((s) => s.name === "helper")).toBe(true);

        const calls = extractCalls(content, "matlab");
        const ownedCalls = calls.filter((site) =>
          fileSymbols.some(
            (sym) => site.line >= sym.startLine && site.line <= sym.endLine,
          ),
        );
        expect(ownedCalls.length).toBe(calls.length);
      });
    });
  });

  describe("apex trigger call graph", () => {
    it("should treat trigger_declaration as a valid call graph symbol type", () => {
      // Regression test for PR #68 review: without trigger_declaration in
      // CALL_GRAPH_SYMBOL_CHUNK_TYPES, calls inside .trigger files were
      // silently dropped because no enclosing symbol could be found.
      expect(CALL_GRAPH_SYMBOL_CHUNK_TYPES.has("trigger_declaration")).toBe(true);
    });

    it("should produce edges for calls inside Apex triggers", () => {
      const triggerContent = `trigger AccountTrigger on Account (before insert, before update) {
    AccountService.process(Trigger.new);
    helper(Trigger.newMap);
}
`;
      const triggerPath = path.join(tempDir, "AccountTrigger.trigger");
      fs.writeFileSync(triggerPath, triggerContent, "utf-8");

      const parsed = parseFiles([{ path: triggerPath, content: triggerContent }]);
      expect(parsed.length).toBe(1);

      // Apply the same filter the Indexer uses to build symbols.
      const fileSymbols: SymbolData[] = [];
      for (const chunk of parsed[0].chunks) {
        if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
        fileSymbols.push({
          id: `sym_${hashContent(
            triggerPath + ":" + chunk.name + ":" + chunk.chunkType + ":" +
            chunk.startLine + ":" + (chunk.startCol ?? 0),
          ).slice(0, 16)}`,
          filePath: triggerPath,
          name: chunk.name,
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: chunk.startCol ?? 0,
          endLine: chunk.endLine,
          endCol: chunk.endCol ?? 0,
          language: chunk.language,
        });
      }

      // The trigger itself must produce a symbol; otherwise call sites would
      // be dropped at the enclosingSymbol step.
      expect(fileSymbols.length).toBeGreaterThan(0);
      const triggerSymbol = fileSymbols.find((s) => s.kind === "trigger_declaration");
      expect(triggerSymbol).toBeDefined();
      expect(triggerSymbol!.name).toBe("AccountTrigger");

      // Extract call sites and confirm each one resolves to an enclosing symbol
      // (i.e. the trigger), so the Indexer would actually persist the edges.
      const calls = extractCalls(triggerContent, "apex");
      expect(calls.length).toBeGreaterThan(0);

      const enclosedCalls = calls.filter((site) =>
        fileSymbols.some(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine,
        ),
      );
      expect(enclosedCalls.length).toBe(calls.length);

      // Sanity: at least one of the calls is the helper() direct call inside the trigger.
      expect(calls.some((c) => c.calleeName === "helper")).toBe(true);
    });
  });

  describe("apex same-file case-insensitive resolution", () => {
    it("should declare apex as a case-insensitive language", () => {
      // The Rust call_extractor lowercases Apex callee names; the Indexer
      // must use the same normalization when resolving same-file calls.
      expect(CASE_INSENSITIVE_LANGUAGES.has("apex")).toBe(true);
    });

    it("should resolve a same-file Apex call when caller and callee differ in case", () => {
      // Regression test for PR #68 review: previously, declaring `processOrder`
      // and calling `PROCESSORDER()` left toSymbolId NULL because the lookup
      // was case-sensitive while the call edge's targetName was already
      // lowercased by the Rust extractor.
      //
      // We declare the methods as method-level symbols directly (the same
      // scenario that occurs when the Indexer chunks larger Apex classes into
      // method_declaration chunks via split_large_chunk) and then exercise
      // the same lookup path the Indexer uses.
      const apexContent = `public class CaseTest {
    public void caller() {
        PROCESSORDER();
    }
    public void processOrder() {
        Integer x = 1;
    }
}
`;
      const filePath = path.join(tempDir, "CaseTest.cls");

      // Verify the Rust extractor produces the lowercased target the Indexer
      // would persist on the call edge.
      const callSites = extractCalls(apexContent, "apex");
      const processOrderCall = callSites.find((c) => c.calleeName === "processorder");
      expect(processOrderCall).toBeDefined();

      const fileSymbols: SymbolData[] = [
        {
          id: "sym_case_caller",
          filePath,
          name: "caller",
          kind: "method_declaration",
          startLine: 2,
          startCol: 0,
          endLine: 4,
          endCol: 0,
          language: "apex",
        },
        {
          id: "sym_case_target",
          filePath,
          name: "processOrder", // mixed case declaration
          kind: "method_declaration",
          startLine: 5,
          startCol: 0,
          endLine: 7,
          endCol: 0,
          language: "apex",
        },
      ];

      // Replicate the Indexer's same-file resolution logic verbatim, using
      // the exported case-insensitivity invariant.
      const isCaseInsensitive = CASE_INSENSITIVE_LANGUAGES.has("apex");
      expect(isCaseInsensitive).toBe(true);
      const normalizeKey = (s: string) => (isCaseInsensitive ? s.toLowerCase() : s);

      const symbolsByName = new Map<string, SymbolData[]>();
      for (const sym of fileSymbols) {
        const key = normalizeKey(sym.name);
        const list = symbolsByName.get(key) ?? [];
        list.push(sym);
        symbolsByName.set(key, list);
      }

      // The crux of the bug: this lookup must succeed even though the symbol
      // was declared as `processOrder` and the edge target is `processorder`.
      const candidates = symbolsByName.get(normalizeKey(processOrderCall!.calleeName));
      expect(candidates).toBeDefined();
      expect(candidates!.length).toBe(1);
      expect(candidates![0].name).toBe("processOrder");

      // Persist and resolve through a real Database to confirm end-to-end behavior.
      const db = new Database(path.join(tempDir, "case.db"));
      _dbs.push(db);
      db.upsertSymbolsBatch(fileSymbols);

      const edge: CallEdgeData = {
        id: "edge_case_insensitive",
        fromSymbolId: "sym_case_caller",
        targetName: processOrderCall!.calleeName,
        callType: processOrderCall!.callType,
        confidence: "Direct",
        line: processOrderCall!.line,
        col: processOrderCall!.column,
        isResolved: false,
      };
      db.upsertCallEdgesBatch([edge]);
      db.resolveCallEdge(edge.id, candidates![0].id);

      db.addSymbolsToBranchBatch(
        "test",
        fileSymbols.map((s) => s.id),
      );
      const callees = db.getCallees("sym_case_caller", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_case_target");
    });
  });

  describe("gdscript call extraction", () => {
    it("should extract direct function calls", () => {
      const content = `
func main() -> void:
    foo()
    bar(1, 2)
`;
      const calls = extractCalls(content, "gdscript");
      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("foo");
      expect(callNames).toContain("bar");
    });

    it("should classify attribute calls as MethodCall", () => {
      const content = `
func _ready() -> void:
    self.take_damage(5)
    health_changed.emit(health)
`;
      const calls = extractCalls(content, "gdscript");
      const takeDamage = calls.find((c) => c.calleeName === "take_damage");
      expect(takeDamage).toBeDefined();
      expect(takeDamage!.callType).toBe("MethodCall");

      // `signal.emit()` resolves to the signal name (not the `emit` method)
      // so it can match the indexed signal symbol.
      const emit = calls.find((c) => c.calleeName === "health_changed");
      expect(emit).toBeDefined();
      expect(emit!.callType).toBe("MethodCall");
      expect(calls.some((c) => c.calleeName === "emit")).toBe(false);
    });

    it("should resolve Class.new() to the class name as a constructor", () => {
      const content = `
func spawn() -> void:
    var e = Enemy.new()
`;
      const calls = extractCalls(content, "gdscript");
      const ctor = calls.find((c) => c.calleeName === "Enemy");
      expect(ctor).toBeDefined();
      expect(ctor!.callType).toBe("Constructor");
      expect(calls.some((c) => c.calleeName === "new")).toBe(false);
    });

    it("should preserve case (GDScript is case-sensitive)", () => {
      const content = `
func main() -> void:
    DoThing()
`;
      const calls = extractCalls(content, "gdscript");
      expect(calls.some((c) => c.calleeName === "DoThing")).toBe(true);
      expect(calls.some((c) => c.calleeName === "dothing")).toBe(false);
    });
  });

  describe("zig call extraction", () => {
    it("should extract direct function calls", () => {
      const content = `
const std = @import("std");

pub fn greet(name: []const u8) void {
    std.debug.print("Hello, {s}\\n", .{name});
}

pub fn main() void {
    greet("world");
}
`;
      const calls = extractCalls(content, "zig");
      const callNames = calls.map((c) => c.calleeName);
      expect(callNames).toContain("greet");
    });

    it("should classify field-access calls as MethodCall", () => {
      const content = `
const std = @import("std");

pub fn greet(name: []const u8) void {
    std.debug.print("Hello, {s}\\n", .{name});
}
`;
      const calls = extractCalls(content, "zig");
      const printCall = calls.find((c) => c.calleeName === "print");
      expect(printCall).toBeDefined();
      expect(printCall!.callType).toBe("MethodCall");
    });

    it("should extract @import builtins as import edges", () => {
      const content = `
const std = @import("std");
const math = @import("math.zig");
`;
      const calls = extractCalls(content, "zig");
      const importCalls = calls.filter((c) => c.callType === "Import");
      expect(importCalls.length).toBeGreaterThanOrEqual(2);
      expect(importCalls.some((c) => c.calleeName.includes("std"))).toBe(true);
      expect(importCalls.some((c) => c.calleeName.includes("math.zig"))).toBe(true);
    });
  });

  describe("C call graph", () => {
    const filePath = path.join(fixturesDir, "c-calls.c");
    const content = fs.readFileSync(filePath, "utf-8");

    it("should extract conservative C calls and includes", () => {
      const calls = extractCalls(content, "c");
      const callNames = calls.map((call) => call.calleeName);
      const imports = calls.filter((call) => call.callType === "Import");

      expect(CALL_GRAPH_LANGUAGES.has("c")).toBe(true);
      expect(calls.find((call) => call.calleeName === "helper")?.callType).toBe("Call");
      expect(callNames).toContain("compute");
      expect(callNames).toContain("printf");
      expect(callNames).toContain("external_api");
      expect(imports.some((call) => call.calleeName.includes("stdio.h"))).toBe(true);
      expect(imports.some((call) => call.calleeName.includes("helpers.h"))).toBe(true);

      expect(callNames).not.toContain("declared_only");
      expect(callNames).not.toContain("call_helper");
      expect(callNames).not.toContain("helper_alias");
      expect(callNames).not.toContain("callback");
      expect(callNames).not.toContain("local_callback");
    });

    it("should preserve C function symbols and resolve a same-file call", () => {
      const db = openDb();
      const symbols = buildFileSymbols(filePath, content);
      const names = symbols.map((symbol) => symbol.name);

      expect(names).toContain("helper");
      expect(names).toContain("compute");
      expect(names).toContain("invoke");
      expect(names).toContain("inspect");
      expect(names).toContain("external_api");
      expect(names).toContain("main");

      const helper = symbols.find((symbol) => symbol.name === "helper");
      const compute = symbols.find((symbol) => symbol.name === "compute");
      expect(helper).toBeDefined();
      expect(compute).toBeDefined();

      const helperCall = extractCalls(content, "c").find(
        (call) =>
          call.calleeName === "helper" &&
          call.line >= compute!.startLine &&
          call.line <= compute!.endLine,
      );
      expect(helperCall).toBeDefined();

      db.upsertSymbolsBatch(symbols);
      const edge: CallEdgeData = {
        id: "edge_c_helper",
        fromSymbolId: compute!.id,
        targetName: helperCall!.calleeName,
        callType: helperCall!.callType,
        confidence: helperCall!.confidence,
        line: helperCall!.line,
        col: helperCall!.column,
        isResolved: false,
      };
      db.upsertCallEdgesBatch([edge]);
      const candidates = symbols.filter((symbol) => symbol.name === edge.targetName);
      expect(candidates).toHaveLength(1);
      db.resolveCallEdge(edge.id, candidates[0].id);
      db.addSymbolsToBranchBatch("test", symbols.map((symbol) => symbol.id));

      const callees = db.getCallees(compute!.id, "test");
      expect(callees).toHaveLength(1);
      expect(callees[0].targetName).toBe("helper");
      expect(callees[0].toSymbolId).toBe(helper!.id);
      expect(callees[0].isResolved).toBe(true);
    });
  });

  describe("C++ call graph", () => {
    const filePath = path.join(fixturesDir, "cpp-calls.cpp");
    const content = fs.readFileSync(filePath, "utf-8");

    it("should extract conservative C++ calls, constructors, namespaces, and includes", () => {
      const calls = extractCalls(content, "cpp");
      const callNames = calls.map((call) => call.calleeName);
      const imports = calls.filter((call) => call.callType === "Import");
      const constructors = calls.filter((call) => call.callType === "Constructor");
      const runCalls = calls.filter(
        (call) => call.calleeName === "run" && call.callType === "MethodCall",
      );

      expect(CALL_GRAPH_LANGUAGES.has("cpp")).toBe(true);
      expect(calls.find((call) => call.calleeName === "helper")?.callType).toBe("Call");
      expect(
        calls.find((call) => call.calleeName === "project::detail::normalize")?.callType,
      ).toBe("Call");
      expect(runCalls).toHaveLength(4);
      expect(constructors.filter((call) => call.calleeName === "Widget")).toHaveLength(5);
      expect(
        constructors.filter((call) => call.calleeName === "project::detail::RemoteWidget"),
      ).toHaveLength(2);
      expect(constructors.some((call) => call.calleeName === "Point")).toBe(true);
      expect(imports.some((call) => call.calleeName.includes("memory"))).toBe(true);
      expect(imports.some((call) => call.calleeName.includes("widget.hpp"))).toBe(true);
      expect(imports.some((call) => call.calleeName.includes("project::detail"))).toBe(true);

      expect(callNames).not.toContain("declared_only");
      expect(callNames).not.toContain("run_widget");
      expect(callNames).not.toContain("helper_alias");
      expect(callNames).not.toContain("callback");
      expect(callNames).not.toContain("local_callback");
      expect(callNames).not.toContain("signature");
      expect(callNames).not.toContain("identity");
      expect(callNames).not.toContain("vexing");
      expect(calls.find((call) => call.calleeName === "make_widget")?.callType).toBe("Call");
    });

    it("should preserve short C++ class and struct symbols", () => {
      const shortTypes = parseFiles([{
        path: "short.cpp",
        content: "class Tag {};\nstruct Tiny {};\n",
      }])[0].chunks;

      expect(shortTypes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "Tag", chunkType: "class_specifier" }),
        expect.objectContaining({ name: "Tiny", chunkType: "struct_specifier" }),
      ]));
    });

    it("should preserve C++ symbols and resolve same-file calls and constructors", () => {
      const db = openDb();
      const symbols = buildFileSymbols(filePath, content);
      const names = symbols.map((symbol) => symbol.name);

      expect(names).toContain("Widget");
      expect(names).toContain("Point");
      expect(names).toContain("project");
      expect(names).toContain("helper");
      expect(names).toContain("process");

      const widget = symbols.find((symbol) => symbol.name === "Widget");
      const point = symbols.find((symbol) => symbol.name === "Point");
      const helper = symbols.find((symbol) => symbol.name === "helper");
      const process = symbols.find((symbol) => symbol.name === "process");
      expect(widget).toBeDefined();
      expect(point).toBeDefined();
      expect(helper).toBeDefined();
      expect(process).toBeDefined();

      const processCalls = extractCalls(content, "cpp").filter(
        (call) => call.line >= process!.startLine && call.line <= process!.endLine,
      );
      const helperCall = processCalls.find((call) => call.calleeName === "helper");
      const widgetConstructor = processCalls.find(
        (call) => call.calleeName === "Widget" && call.callType === "Constructor",
      );
      const pointConstructor = processCalls.find(
        (call) => call.calleeName === "Point" && call.callType === "Constructor",
      );
      expect(helperCall).toBeDefined();
      expect(widgetConstructor).toBeDefined();
      expect(pointConstructor).toBeDefined();

      db.upsertSymbolsBatch(symbols);
      const edges: CallEdgeData[] = [
        {
          id: "edge_cpp_helper",
          fromSymbolId: process!.id,
          targetName: helperCall!.calleeName,
          callType: helperCall!.callType,
          confidence: helperCall!.confidence,
          line: helperCall!.line,
          col: helperCall!.column,
          isResolved: false,
        },
        {
          id: "edge_cpp_widget",
          fromSymbolId: process!.id,
          targetName: widgetConstructor!.calleeName,
          callType: widgetConstructor!.callType,
          confidence: widgetConstructor!.confidence,
          line: widgetConstructor!.line,
          col: widgetConstructor!.column,
          isResolved: false,
        },
        {
          id: "edge_cpp_point",
          fromSymbolId: process!.id,
          targetName: pointConstructor!.calleeName,
          callType: pointConstructor!.callType,
          confidence: pointConstructor!.confidence,
          line: pointConstructor!.line,
          col: pointConstructor!.column,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);
      for (const edge of edges) {
        const candidates = symbols.filter((symbol) => symbol.name === edge.targetName);
        expect(candidates).toHaveLength(1);
        db.resolveCallEdge(edge.id, candidates[0].id);
      }
      db.addSymbolsToBranchBatch("test", symbols.map((symbol) => symbol.id));

      const callees = db.getCallees(process!.id, "test");
      expect(callees.find((edge) => edge.targetName === "helper")?.toSymbolId).toBe(helper!.id);
      expect(callees.find((edge) => edge.targetName === "Widget")?.toSymbolId).toBe(widget!.id);
      expect(callees.find((edge) => edge.targetName === "Point")?.toSymbolId).toBe(point!.id);
      expect(callees.filter((edge) => edge.isResolved)).toHaveLength(3);
    });
  });

  describe("C and C++ indexing integration", () => {
    it("should build and resolve same-file edges through the Indexer", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return new Response(
          JSON.stringify({
            data: inputs.map(() => ({ embedding: Array.from({ length: 8 }, () => 0.125) })),
            usage: { total_tokens: Math.max(1, inputs.length) },
          }),
          { status: 200 },
        );
      });

      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(
        path.join(tempDir, ".git", "refs", "heads", "main"),
        "1111111111111111111111111111111111111111\n",
      );
      fs.copyFileSync(path.join(fixturesDir, "c-calls.c"), path.join(tempDir, "main.c"));
      fs.copyFileSync(path.join(fixturesDir, "cpp-calls.cpp"), path.join(tempDir, "main.cpp"));

      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
      });
      const indexer = new Indexer(tempDir, config, "opencode");

      try {
        await indexer.index();
        const symbols = await indexer.getSymbolsForBranch();
        const compute = symbols.find(
          (symbol) => symbol.name === "compute" && symbol.language === "c",
        );
        const invoke = symbols.find(
          (symbol) => symbol.name === "invoke" && symbol.language === "c",
        );
        const inspect = symbols.find(
          (symbol) => symbol.name === "inspect" && symbol.language === "c",
        );
        const cMain = symbols.find(
          (symbol) => symbol.name === "main" && symbol.language === "c",
        );
        const process = symbols.find(
          (symbol) => symbol.name === "process" && symbol.language === "cpp",
        );
        expect(compute).toBeDefined();
        expect(invoke).toBeDefined();
        expect(inspect).toBeDefined();
        expect(cMain).toBeDefined();
        expect(process).toBeDefined();

        const cCallees = await indexer.getCallees(compute!.id);
        const cHelper = cCallees.find((edge) => edge.targetName === "helper");
        expect(cHelper?.isResolved).toBe(true);
        expect(cHelper?.toSymbolId).toBeDefined();

        const invokeCallees = await indexer.getCallees(invoke!.id);
        expect(invokeCallees.some((edge) => edge.targetName === "callback")).toBe(false);
        expect(invokeCallees.some((edge) => edge.targetName === "local_callback")).toBe(false);

        const mainCallees = await indexer.getCallees(cMain!.id);
        expect(mainCallees.some((edge) => edge.targetName === "call_helper")).toBe(false);
        expect(mainCallees.some((edge) => edge.targetName === "helper_alias")).toBe(false);

        const inspectCallees = await indexer.getCallees(inspect!.id);
        const externalApiCall = inspectCallees.find((edge) => edge.targetName === "external_api");
        expect(externalApiCall).toBeDefined();
        expect(externalApiCall?.isResolved).toBe(false);

        const cppCallees = await indexer.getCallees(process!.id);
        const cppHelper = cppCallees.find((edge) => edge.targetName === "helper");
        const widgetConstructor = cppCallees.find(
          (edge) => edge.targetName === "Widget" && edge.callType === "Constructor",
        );
        const pointConstructor = cppCallees.find(
          (edge) => edge.targetName === "Point" && edge.callType === "Constructor",
        );
        expect(cppHelper?.isResolved).toBe(true);
        expect(widgetConstructor?.isResolved).toBe(true);
        expect(pointConstructor?.isResolved).toBe(true);
        const qualifiedNormalize = cppCallees.find(
          (edge) => edge.targetName === "project::detail::normalize",
        );
        expect(qualifiedNormalize).toBeDefined();
        expect(qualifiedNormalize?.isResolved).toBe(false);
        expect(cppCallees.some((edge) => edge.targetName === "run_widget")).toBe(false);
        expect(cppCallees.some((edge) => edge.targetName === "helper_alias")).toBe(false);
        expect(cppCallees.some((edge) => edge.targetName === "callback")).toBe(false);
        expect(cppCallees.some((edge) => edge.targetName === "local_callback")).toBe(false);
        expect(cppCallees.some((edge) => edge.targetName === "signature")).toBe(false);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });

    it("should reprocess unchanged C files after a call-graph version upgrade", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return new Response(
          JSON.stringify({
            data: inputs.map(() => ({ embedding: Array.from({ length: 8 }, () => 0.125) })),
            usage: { total_tokens: Math.max(1, inputs.length) },
          }),
          { status: 200 },
        );
      });
      fs.writeFileSync(
        path.join(tempDir, "main.c"),
        "int helper(int value) { return value + 1; }\nint caller(void) { return helper(1); }\n",
      );
      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
      });

      CALL_GRAPH_LANGUAGES.delete("c");
      let indexer = new Indexer(tempDir, config, "opencode");
      try {
        await indexer.index();
        const caller = (await indexer.getSymbolsForBranch()).find(
          (symbol) => symbol.name === "caller",
        );
        expect(caller).toBeDefined();
        expect(await indexer.getCallees(caller!.id)).toHaveLength(0);
      } finally {
        await indexer.close();
        CALL_GRAPH_LANGUAGES.add("c");
      }

      const database = new Database(path.join(tempDir, ".opencode", "index", "codebase.db"));
      database.setMetadata(migrationMetadataKey("index.callGraphResolutionVersion"), "2");
      database.close();
      const embeddingCallsBeforeUpgrade = fetchSpy.mock.calls.length;

      indexer = new Indexer(tempDir, config, "opencode");
      try {
        await indexer.index();
        const symbols = await indexer.getSymbolsForBranch();
        const caller = symbols.find((symbol) => symbol.name === "caller");
        const helper = symbols.find((symbol) => symbol.name === "helper");
        const edge = (await indexer.getCallees(caller!.id)).find(
          (candidate) => candidate.targetName === "helper",
        );
        expect(edge).toMatchObject({
          isResolved: true,
          toSymbolId: helper!.id,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeUpgrade);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });
  });

  describe("swift call graph", () => {
    const buildSwiftSymbols = (
      filePath: string,
      content: string,
    ): SymbolData[] => {
      const parsed = parseFiles([{ path: filePath, content }]);
      return parsed[0].chunks
        .filter(
          (chunk) =>
            !!chunk.name &&
            CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType),
        )
        .map((chunk) => ({
          id: `sym_${hashContent(
            filePath + ":" + chunk.name + ":" + chunk.chunkType + ":" +
            chunk.startLine + ":" + (chunk.startCol ?? 0),
          ).slice(0, 16)}`,
          filePath,
          name: chunk.name!,
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: chunk.startCol ?? 0,
          endLine: chunk.endLine,
          endCol: chunk.endCol ?? 0,
          language: chunk.language,
        }));
    };

    it("should enable case-sensitive Swift symbols and call extraction", () => {
      expect(CALL_GRAPH_LANGUAGES.has("swift")).toBe(true);
      expect(CASE_INSENSITIVE_LANGUAGES.has("swift")).toBe(false);
      for (const chunkType of [
        "actor_declaration",
        "extension_declaration",
        "protocol_declaration",
        "protocol_function_declaration",
        "init_declaration",
        "deinit_declaration",
        "subscript_declaration",
      ]) {
        expect(CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunkType)).toBe(true);
      }

      const calls = extractCalls(
        "func caller() { load(); Load(); object.refresh(); Widget() }",
        "swift",
      );
      expect(calls.some((call) => call.calleeName === "load")).toBe(true);
      expect(calls.some((call) => call.calleeName === "Load")).toBe(true);
      expect(calls.find((call) => call.calleeName === "refresh")?.callType).toBe(
        "MethodCall",
      );
      expect(calls.find((call) => call.calleeName === "Widget")?.callType).toBe(
        "Constructor",
      );
    });

    it("should not treat Swift subscripts as calls", () => {
      const calls = extractCalls(
        `func read() {
    _ = values[id]
    _ = object.items[index]
    array[0].run()
    dictionary[key]?.refresh()
}`,
        "swift",
      );

      for (const subscriptBase of ["values", "items", "array", "dictionary"]) {
        expect(calls.some((call) => call.calleeName === subscriptBase)).toBe(false);
      }
      expect(calls.some((call) => call.calleeName === "run")).toBe(true);
      expect(calls.some((call) => call.calleeName === "refresh")).toBe(true);
    });

    it("should extract Swift imports, inheritance and conformities", () => {
      const content = `
import Foundation
import struct Foundation.Date

protocol ChildProtocol: ParentProtocol {}
class Child: Base, Runnable, Sendable {}
struct Value: Runnable {}
struct NoncopyableToken: ~Copyable {}
`;
      const calls = extractCalls(content, "swift");

      expect(calls.some(
        (call) => call.calleeName === "Foundation" && call.callType === "Import",
      )).toBe(true);
      expect(calls.some(
        (call) => call.calleeName === "Date" && call.callType === "Import",
      )).toBe(true);
      expect(calls.some(
        (call) => call.calleeName === "Base" && call.callType === "Inherits",
      )).toBe(true);
      expect(calls.some(
        (call) =>
          call.calleeName === "ParentProtocol" &&
          call.callType === "Inherits",
      )).toBe(true);
      expect(calls.some(
        (call) => call.calleeName === "Runnable" && call.callType === "Implements",
      )).toBe(true);
      expect(calls.some(
        (call) => call.calleeName === "Sendable" && call.callType === "Implements",
      )).toBe(true);
      expect(calls.some((call) => call.calleeName === "Copyable")).toBe(false);
    });

    it("should create nested Swift symbols and prefer the narrowest enclosure", () => {
      const filePath = path.join(
        fixturesDir,
        "..",
        "swift",
        "ModernService.swift",
      );
      const content = fs.readFileSync(filePath, "utf-8");
      const symbols = buildSwiftSymbols(filePath, content);

      expect(symbols.some(
        (symbol) =>
          symbol.name === "UserRepository" &&
          symbol.kind === "class_declaration",
      )).toBe(true);
      expect(symbols.some(
        (symbol) => symbol.name === "loadNames" && symbol.kind === "method_declaration",
      )).toBe(true);

      const loadCall = extractCalls(content, "swift").find(
        (call) =>
          call.calleeName === "load" &&
          content.split("\n")[call.line - 1]?.includes("self.load"),
      );
      expect(loadCall).toBeDefined();

      const enclosing = findEnclosingSymbol(symbols, loadCall!.line);
      expect(enclosing?.name).toBe("loadNames");
      expect(enclosing?.kind).toBe("method_declaration");
    });

    it("should not attach a preceding top-level call to a documented Swift symbol", () => {
      const filePath = path.join(tempDir, "CommentRange.swift");
      const content = `helper()
/// Documentation.
func documented() {}
`;
      const symbols = buildSwiftSymbols(filePath, content);
      const helperCall = extractCalls(content, "swift").find(
        (call) => call.calleeName === "helper",
      );

      expect(helperCall?.line).toBe(1);
      expect(findEnclosingSymbol(symbols, helperCall!.line)).toBeUndefined();
    });

    it("should prefer a Swift method over its one-line type container", () => {
      const filePath = path.join(tempDir, "OneLine.swift");
      const content = "struct S { func f() { g() }; func g() {} }";
      const symbols = buildSwiftSymbols(filePath, content);
      const call = extractCalls(content, "swift").find(
        (site) => site.calleeName === "g",
      );

      expect(call).toBeDefined();
      expect(findEnclosingSymbol(symbols, call!.line)?.name).toBe("f");
    });

    it("should distinguish multiple Swift methods on the same line", () => {
      const filePath = path.join(tempDir, "SameLineMethods.swift");
      const content =
        "struct S { func f() {}; func g() { h() }; func h() {} }";
      const symbols = buildSwiftSymbols(filePath, content);
      const call = extractCalls(content, "swift").find(
        (site) => site.calleeName === "h",
      );

      expect(call).toBeDefined();
      expect(
        findEnclosingSymbol(symbols, call!.line, call!.column)?.name,
      ).toBe("g");
    });

    it("should persist and resolve a same-file Swift call from its method", () => {
      const db = openDb();
      const filePath = path.join(tempDir, "Runner.swift");
      const content = `
func helper() -> Int { 42 }

struct Runner {
    func run() -> Int {
        helper()
    }
}
`;
      const symbols = buildSwiftSymbols(filePath, content);
      db.upsertSymbolsBatch(symbols);

      const helper = symbols.find((symbol) => symbol.name === "helper");
      const run = symbols.find((symbol) => symbol.name === "run");
      const call = extractCalls(content, "swift").find(
        (site) => site.calleeName === "helper",
      );
      expect(helper).toBeDefined();
      expect(run).toBeDefined();
      expect(call).toBeDefined();
      expect(findEnclosingSymbol(symbols, call!.line)?.id).toBe(run!.id);

      const edge: CallEdgeData = {
        id: "edge_swift_helper",
        fromSymbolId: run!.id,
        targetName: call!.calleeName,
        callType: call!.callType,
        confidence: "Direct",
        line: call!.line,
        col: call!.column,
        isResolved: false,
      };
      db.upsertCallEdgesBatch([edge]);
      db.resolveCallEdge(edge.id, helper!.id);
      db.addSymbolsToBranchBatch("main", symbols.map((symbol) => symbol.id));

      const callees = db.getCallees(run!.id, "main");
      expect(callees).toHaveLength(1);
      expect(callees[0].targetName).toBe("helper");
      expect(callees[0].toSymbolId).toBe(helper!.id);
      expect(callees[0].isResolved).toBe(true);
    });

    it("should resolve Swift calls, preserve overloads and reparse cached files after upgrade", async () => {
      fs.writeFileSync(
        path.join(tempDir, "Runner.swift"),
        `func helper() -> Int { 42 }
struct Runner {
    func run() -> Int { helper() }
}
`,
        "utf-8",
      );
      fs.writeFileSync(
        path.join(tempDir, "Overloads.swift"),
        "func choose(_ value: Int) {}; func choose(_ value: String) {}; func caller() { choose(1) }\n",
        "utf-8",
      );

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            input?: string[];
          };
          const texts = Array.isArray(body.input) ? body.input : [];
          return new Response(
            JSON.stringify({
              data: texts.map((_text, index) => ({
                embedding: Array.from(
                  { length: 8 },
                  (_unused, dimension) => (index + dimension + 1) / 10,
                ),
              })),
              usage: { total_tokens: Math.max(1, texts.length) },
            }),
            { status: 200 },
          );
        },
      );
      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-embedding-model",
          dimensions: 8,
          requestIntervalMs: 0,
        },
        indexing: {
          watchFiles: false,
          retries: 0,
          retryDelayMs: 1,
        },
      });
      const indexer = new Indexer(tempDir, config, "opencode");

      try {
        await indexer.index();
        const symbols = await indexer.getSymbolsForBranch();
        const helper = symbols.find((symbol) => symbol.name === "helper");
        const run = symbols.find((symbol) => symbol.name === "run");
        const caller = symbols.find((symbol) => symbol.name === "caller");
        const chooseSymbols = symbols.filter(
          (symbol) => symbol.name === "choose",
        );
        expect(helper).toBeDefined();
        expect(run).toBeDefined();
        expect(caller).toBeDefined();
        expect(chooseSymbols).toHaveLength(2);
        expect(new Set(chooseSymbols.map((symbol) => symbol.id)).size).toBe(2);

        const runCallees = await indexer.getCallees(run!.id);
        const helperEdge = runCallees.find(
          (edge) => edge.targetName === "helper",
        );
        expect(helperEdge?.isResolved).toBe(true);
        expect(helperEdge?.toSymbolId).toBe(helper!.id);

        const callerCallees = await indexer.getCallees(caller!.id);
        const overloadEdge = callerCallees.find(
          (edge) => edge.targetName === "choose",
        );
        expect(overloadEdge?.isResolved).toBe(false);
        expect(overloadEdge?.toSymbolId).toBeUndefined();

        const database = new Database(
          path.join(tempDir, ".opencode", "index", "codebase.db"),
        );
        database.deleteSymbolsByFile("Runner.swift");
        database.deleteMetadata(migrationMetadataKey("index.parser.swiftVersion"));
        database.close();
        expect(
          (await indexer.getSymbolsForBranch()).some(
            (symbol) => symbol.name === "run",
          ),
        ).toBe(false);

        const embeddingCallsBeforeUpgrade = fetchSpy.mock.calls.length;
        await indexer.index();
        expect(
          (await indexer.getSymbolsForBranch()).some(
            (symbol) => symbol.name === "run",
          ),
        ).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeUpgrade);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });

    it("should leave overloaded Swift targets ambiguous", () => {
      const filePath = path.join(tempDir, "Overloads.swift");
      const content = `
func helper(_ value: Int) {}
func helper(_ value: String) {}
func caller() { helper(1) }
`;
      const symbols = buildSwiftSymbols(filePath, content);
      const helperCandidates = symbols.filter(
        (symbol) => symbol.name === "helper",
      );
      const helperCall = extractCalls(content, "swift").find(
        (call) => call.calleeName === "helper",
      );

      expect(helperCandidates).toHaveLength(2);
      expect(helperCall).toBeDefined();
      expect(helperCandidates.length === 1).toBe(false);
    });
  });

  describe("ruby symbol persistence", () => {
    it("persists class and module symbols in the branch symbol catalog", async () => {
      const rubyFilePath = path.join(tempDir, "sinatra.rb");
      const rubyContent = `module Sinatra
  module NotFound
    class Templates
      def self.call
        :ok
      end
    end
  end
end
`;

      fs.writeFileSync(rubyFilePath, rubyContent, "utf-8");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
        const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return new Response(
          JSON.stringify({
            data: texts.map(() => ({ embedding: Array.from({ length: 8 }, () => 0.125) })),
            usage: { total_tokens: Math.max(1, texts.length) },
          }),
          { status: 200 },
        );
      });

      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
      });
      const indexer = new Indexer(tempDir, config, "opencode");

      try {
        await indexer.index();

        const symbols = await indexer.getSymbolsForBranch();
        const rubySymbols = symbols.filter((symbol) => symbol.filePath === rubyFilePath);

        expect(rubySymbols.some((symbol) => symbol.kind === "module" && symbol.name === "Sinatra")).toBe(true);
        expect(rubySymbols.some((symbol) => symbol.kind === "module" && symbol.name === "NotFound")).toBe(true);
        expect(rubySymbols.some((symbol) => symbol.kind === "class" && symbol.name === "Templates")).toBe(true);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });
  });

  describe("symbol enclosure", () => {
    it("should exclude a call at a Tree-sitter end-column boundary", () => {
      const filePath = path.join(tempDir, "Boundary.js");
      const content =
        "function f(){ const reallyLongVariableName = 1234567890; }g()";
      const parsed = parseFiles([{ path: filePath, content }]);
      const functionChunk = parsed[0].chunks.find(
        (chunk) => chunk.name === "f",
      );
      const call = extractCalls(content, "javascript").find(
        (site) => site.calleeName === "g",
      );
      expect(functionChunk).toBeDefined();
      expect(call).toBeDefined();

      const symbol: SymbolData = {
        id: "sym_boundary",
        filePath,
        name: "f",
        kind: functionChunk!.chunkType,
        startLine: functionChunk!.startLine,
        startCol: functionChunk!.startCol ?? 0,
        endLine: functionChunk!.endLine,
        endCol: functionChunk!.endCol ?? 0,
        language: functionChunk!.language,
      };
      expect(call!.column).toBe(symbol.endCol);
      expect(
        findEnclosingSymbol([symbol], call!.line, call!.column),
      ).toBeUndefined();
    });
  });

  describe("metal call extraction", () => {
    const metalFixturePath = path.join(
      __dirname,
      "fixtures",
      "metal",
      "representative.metal",
    );

    it("should extract direct, template, member, and qualified calls", () => {
      const content = fs.readFileSync(metalFixturePath, "utf-8");
      const calls = extractCalls(content, "metal");
      const callNames = calls.map((call) => call.calleeName);

      expect(callNames).toEqual(
        expect.arrayContaining([
          "shade",
          "scaled_value",
          "sample",
          "adjust",
          "clamp",
          "threadgroup_barrier",
          "simd_sum",
        ]),
      );
      expect(calls.find((call) => call.calleeName === "sample")?.callType).toBe(
        "MethodCall",
      );
      expect(calls.find((call) => call.calleeName === "clamp")?.callType).toBe(
        "MethodCall",
      );
    });

    it("should expose named Metal functions as call graph symbols", () => {
      const content = fs.readFileSync(metalFixturePath, "utf-8");
      const filePath = "/shaders/representative.metal";
      const parsed = parseFiles([{ path: filePath, content }]);
      const symbolNames = parsed[0].chunks
        .filter((chunk) => CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType))
        .map((chunk) => chunk.name);

      expect(CALL_GRAPH_LANGUAGES.has("metal")).toBe(true);
      expect(symbolNames).toEqual(
        expect.arrayContaining([
          "scaled_value",
          "shade",
          "adjust",
          "vertex_main",
          "fragment_main",
          "reduce_kernel",
        ]),
      );
    });

    it("should resolve Metal function and method calls through the Indexer", async () => {
      const baseContent = fs.readFileSync(metalFixturePath, "utf-8");
      const longBody = Array.from(
        { length: 160 },
        (_, index) => `  value += ${index}.0f * 0.0f;`,
      ).join("\n");
      const content = `${baseContent}

inline float long_helper(float value) {
${longBody}
  return value;
}

kernel void long_kernel(const device float* input [[buffer(0)]],
                        device float* output [[buffer(1)]],
                        uint gid [[thread_position_in_grid]]) {
  output[gid] = long_helper(input[gid]);
}
`;
      const filePath = path.join(tempDir, "representative.metal");
      fs.writeFileSync(filePath, content, "utf-8");

      const longHelperChunks = parseFiles([{ path: filePath, content }])[0].chunks
        .filter((chunk) => chunk.name === "long_helper");
      expect(longHelperChunks.length).toBeGreaterThan(1);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            input?: string[];
          };
          const texts = Array.isArray(body.input) ? body.input : [];
          return new Response(
            JSON.stringify({
              data: texts.map((_text, index) => ({
                embedding: Array.from(
                  { length: 8 },
                  (_, dimension) => ((index + dimension + 1) % 9) / 9,
                ),
              })),
              usage: { total_tokens: Math.max(1, texts.length * 8) },
            }),
          );
        },
      );
      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
          requestIntervalMs: 0,
        },
        indexing: { watchFiles: false },
      });
      const indexer = new Indexer(tempDir, config, "opencode");

      try {
        const stats = await indexer.index();
        expect(stats.totalFiles).toBe(1);

        const expectedCallers = [
          ["shade", "fragment_main"],
          ["adjust", "reduce_kernel"],
          ["long_helper", "long_kernel"],
        ] as const;
        for (const [targetName, callerName] of expectedCallers) {
          const callers = await indexer.getCallers(targetName);
          expect(callers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                fromSymbolName: callerName,
                isResolved: true,
              }),
            ]),
          );
        }

        const database = new Database(
          path.join(tempDir, ".opencode", "index", "codebase.db"),
        );
        database.deleteSymbolsByFile("representative.metal");
        database.deleteMetadata(migrationMetadataKey("index.parser.metalVersion"));
        database.close();
        expect(
          (await indexer.getSymbolsForBranch()).some(
            (symbol) => symbol.name === "long_kernel",
          ),
        ).toBe(false);

        const embeddingCallsBeforeUpgrade = fetchSpy.mock.calls.length;
        await indexer.index();
        expect(
          (await indexer.getSymbolsForBranch()).some(
            (symbol) => symbol.name === "long_kernel",
          ),
        ).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeUpgrade);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });
  });

  describe("bash call extraction", () => {
    it("should extract direct command and function calls", () => {
      const content = `
#!/usr/bin/env bash

function greet() {
  echo "Hello, $1"
}

add() {
  local left="$1"
  local right="$2"
  echo "$(( left + right ))"
}

main() {
  local name="World"
  greet "$name"
  local total
  total=$(add 1 2)
  echo "total: $total"
}
`;
      const calls = extractCalls(content, "bash");
      const callNames = calls.map((c) => c.calleeName);

      expect(CALL_GRAPH_LANGUAGES.has("bash")).toBe(true);
      expect(callNames).toContain("greet");
      expect(callNames).toContain("add");
    });

    it("should parse Bash function names for call graph symbols", () => {
      const filePath = "/scripts/build.sh";
      const content = `
#!/usr/bin/env bash

function greet() {
  echo "Hello, $1"
}

add() {
  local left="$1"
  local right="$2"
  echo "$(( left + right ))"
}

main() {
  local name="World"
  greet "$name"
  local total
  total=$(add 1 2)
  echo "total: $total"
}
`;
      const parsed = parseFiles([{ path: filePath, content }]);
      const chunks = parsed[0].chunks;
      const symbolChunks = chunks.filter((chunk) => CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType));
      const names = symbolChunks.map((chunk) => chunk.name);

      expect(names).toContain("greet");
      expect(names).toContain("add");
      expect(names).toContain("main");
    });

    it("should keep small Bash function chunks for call graph symbols", () => {
      const filePath = "/scripts/tiny.sh";
      const content = `
a(){ b; }
b(){ echo ok; }
`;
      const parsed = parseFiles([{ path: filePath, content }]);
      const symbolChunks = parsed[0].chunks.filter((chunk) => CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType));
      const names = symbolChunks.map((chunk) => chunk.name);

      expect(names).toContain("a");
      expect(names).toContain("b");
    });

    it("should resolve same-file Bash function calls", () => {
      const db = openDb();
      const filePath = "/scripts/build.sh";
      const content = `
#!/usr/bin/env bash

helper() {
  local message="helper"
  echo "preparing \${message} call"
  echo "\${message}"
}

main() {
  local result="starting"
  echo "$result"
  helper
  echo "done"
}
`;
      const parsed = parseFiles([{ path: filePath, content }]);
      const fileSymbols: SymbolData[] = [];

      for (const chunk of parsed[0].chunks) {
        if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;
        fileSymbols.push({
          id: `sym_${hashContent(
            filePath + ":" + chunk.name + ":" + chunk.chunkType + ":" +
            chunk.startLine + ":" + (chunk.startCol ?? 0),
          ).slice(0, 16)}`,
          filePath,
          name: chunk.name,
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: 0,
          endLine: chunk.endLine,
          endCol: 0,
          language: chunk.language,
        });
      }

      db.upsertSymbolsBatch(fileSymbols);
      const main = fileSymbols.find((symbol) => symbol.name === "main");
      const helper = fileSymbols.find((symbol) => symbol.name === "helper");
      expect(main).toBeDefined();
      expect(helper).toBeDefined();

      const helperCall = extractCalls(content, "bash").find((call) => call.calleeName === "helper");
      expect(helperCall).toBeDefined();

      const edge: CallEdgeData = {
        id: "edge_bash_helper",
        fromSymbolId: main!.id,
        targetName: helperCall!.calleeName,
        callType: helperCall!.callType,
        confidence: "Direct",
        line: helperCall!.line,
        col: helperCall!.column,
        isResolved: false,
      };
      db.upsertCallEdgesBatch([edge]);
      db.resolveCallEdge(edge.id, helper!.id);
      db.addSymbolsToBranchBatch("test", fileSymbols.map((symbol) => symbol.id));

      const callees = db.getCallees(main!.id, "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe(helper!.id);
    });
  });

  describe("call graph storage", () => {
    it("should store symbols in database", () => {
      const db = openDb();
      const symbols: SymbolData[] = [
        {
          id: "sym_001",
          filePath: "/src/foo.ts",
          name: "fooFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_002",
          filePath: "/src/foo.ts",
          name: "barFunc",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 20,
          endCol: 0,
          language: "typescript",
        },
      ];

      db.upsertSymbolsBatch(symbols);
      const retrieved = db.getSymbolsByFile("/src/foo.ts");
      expect(retrieved.length).toBe(2);

      const names = retrieved.map((s) => s.name);
      expect(names).toContain("fooFunc");
      expect(names).toContain("barFunc");

      const byName = db.getSymbolsByName("fooFunc");
      expect(byName.length).toBe(1);
      expect(byName[0]?.filePath).toBe("/src/foo.ts");

      const byNameCi = db.getSymbolsByNameCi("foofunc");
      expect(byNameCi.length).toBe(1);
      expect(byNameCi[0]?.filePath).toBe("/src/foo.ts");
    });

    it("should store call edges", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_a",
          filePath: "/src/a.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_b",
          filePath: "/src/a.ts",
          name: "callee",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 20,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_001",
          fromSymbolId: "sym_a",
          targetName: "callee",
          callType: "Call",
        confidence: "Direct",
          line: 5,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      db.addSymbolsToBranchBatch("test", ["sym_a", "sym_b"]);
      const callees = db.getCallees("sym_a", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].targetName).toBe("callee");
      expect(callees[0].callType).toBe("Call");
    });

    it("should store branch relationships", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_br1",
          filePath: "/src/x.ts",
          name: "branchFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);
      db.addSymbolsToBranchBatch("main", ["sym_br1"]);

      // Create an edge from sym_br1 targeting "branchFunc" so getCallers can find it
      const edges: CallEdgeData[] = [
        {
          id: "edge_br1",
          fromSymbolId: "sym_br1",
          targetName: "branchFunc",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // getCallers filters by branch
      const callers = db.getCallers("branchFunc", "main");
      expect(callers.length).toBe(1);
      expect(callers[0].fromSymbolId).toBe("sym_br1");
    });
  });

  describe("call resolution", () => {
    it("should resolve same-file calls", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_caller",
          filePath: "/src/file.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_target",
          filePath: "/src/file.ts",
          name: "target",
          kind: "function",
          startLine: 7,
          startCol: 0,
          endLine: 12,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_resolve",
          fromSymbolId: "sym_caller",
          targetName: "target",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Resolve the edge
      db.resolveCallEdge("edge_resolve", "sym_target");

      // Verify resolution
      db.addSymbolsToBranchBatch("test", ["sym_caller", "sym_target"]);
      const callees = db.getCallees("sym_caller", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_target");
    });

    it("should leave cross-file calls unresolved", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_local",
          filePath: "/src/local.ts",
          name: "localFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_cross",
          fromSymbolId: "sym_local",
          targetName: "externalFunc",
          callType: "Import",
        confidence: "Direct",
          line: 1,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Don't resolve — it's cross-file
      db.addSymbolsToBranchBatch("test", ["sym_local"]);
      const callees = db.getCallees("sym_local", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });

    it("should handle multiple targets with same name", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_caller_m",
          filePath: "/src/main.ts",
          name: "main",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_helper_a",
          filePath: "/src/a.ts",
          name: "helper",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_helper_b",
          filePath: "/src/b.ts",
          name: "helper",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_multi",
          fromSymbolId: "sym_caller_m",
          targetName: "helper",
          callType: "Call",
        confidence: "Direct",
          line: 5,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Resolve to only one of the targets
      db.resolveCallEdge("edge_multi", "sym_helper_a");

      db.addSymbolsToBranchBatch("test", ["sym_caller_m", "sym_helper_a", "sym_helper_b"]);
      const callees = db.getCallees("sym_caller_m", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(true);
      expect(callees[0].toSymbolId).toBe("sym_helper_a");
    });

    it("should keep ambiguous same-file target unresolved", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_caller_amb",
          filePath: "/src/file.ts",
          name: "caller",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_dup_1",
          filePath: "/src/file.ts",
          name: "dup",
          kind: "function",
          startLine: 7,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_dup_2",
          filePath: "/src/file.ts",
          name: "dup",
          kind: "function",
          startLine: 12,
          startCol: 0,
          endLine: 15,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      const edges: CallEdgeData[] = [
        {
          id: "edge_ambiguous",
          fromSymbolId: "sym_caller_amb",
          targetName: "dup",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 2,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      db.addSymbolsToBranchBatch("test", ["sym_caller_amb", "sym_dup_1", "sym_dup_2"]);
      const callees = db.getCallees("sym_caller_amb", "test");
      expect(callees.length).toBe(1);
      expect(callees[0].isResolved).toBe(false);
      expect(callees[0].toSymbolId).toBeUndefined();
    });
  });

  describe("local TypeScript and JavaScript module resolution", () => {
    function mockEmbeddings(): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return new Response(
          JSON.stringify({
            data: inputs.map(() => ({ embedding: Array(8).fill(0.125) })),
            usage: { total_tokens: Math.max(1, inputs.length) },
          }),
          { status: 200 },
        );
      });
    }

    function copyLocalModuleFixture(projectDir: string): void {
      fs.cpSync(path.join(fixturesDir, "local-modules"), projectDir, { recursive: true });
    }

    function copyAliasFixture(projectDir: string): void {
      fs.cpSync(path.join(fixturesDir, "local-module-alias-resolution"), projectDir, { recursive: true });
    }

    it("resolves relative imports, aliases, and re-exports while abstaining on ambiguity", async () => {
      const projectDir = path.join(tempDir, "local-module-project");
      fs.mkdirSync(projectDir, { recursive: true });
      copyLocalModuleFixture(projectDir);
      const fetchSpy = mockEmbeddings();
      const indexer = new Indexer(projectDir, createIndexerConfig(), "opencode");

      try {
        await indexer.index();
        const symbols = await indexer.getSymbolsForBranch();
        const byName = (name: string): SymbolData => {
          const matches = symbols.filter((symbol) => symbol.name === name);
          expect(matches.length).toBeGreaterThan(0);
          return matches[0];
        };
        const edgeFrom = async (callerName: string, targetName: string): Promise<CallEdgeData> => {
          const edge = (await indexer.getCallees(byName(callerName).id)).find(
            (candidate) => candidate.targetName === targetName,
          );
          expect(edge).toBeDefined();
          return edge!;
        };

        await expect(edgeFrom("runDirect", "directTarget")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: byName("directTarget").id,
        });
        await expect(edgeFrom("runAlias", "localAlias")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: byName("directTarget").id,
        });
        await expect(edgeFrom("runReexport", "localReexport")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: byName("originalTarget").id,
        });

        const duplicateTargets = symbols.filter((symbol) => symbol.name === "duplicateTarget");
        expect(duplicateTargets).toHaveLength(2);
        const duplicateA = duplicateTargets.find((symbol) => symbol.filePath.endsWith("duplicate-a.ts"));
        await expect(edgeFrom("runDuplicate", "duplicateTarget")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: duplicateA!.id,
        });
        const ambiguousEdge = await edgeFrom("runAmbiguous", "ambiguousTarget");
        expect(ambiguousEdge).toMatchObject({ isResolved: false });
        expect(ambiguousEdge.toSymbolId).toBeUndefined();
        const missingEdge = await edgeFrom("runMissing", "missingTarget");
        expect(missingEdge).toMatchObject({ isResolved: false });
        expect(missingEdge.toSymbolId).toBeUndefined();
        await expect(edgeFrom("runLocal", "localTarget")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: byName("localTarget").id,
        });
        await expect(edgeFrom("runJavaScript", "jsAlias")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: byName("javascriptTarget").id,
        });

        const directCallers = await indexer.getCallers("directTarget");
        expect(directCallers.map((edge) => edge.fromSymbolName).sort()).toEqual(["runAlias", "runDirect"]);

        const coverage = await indexer.getCallGraphCoverage();
        expect(coverage).toMatchObject({
          totalEdges: 8,
          resolvedEdges: 6,
          unresolvedEdges: 2,
          resolutionRate: 0.75,
        });
        expect(coverage.languages).toEqual([
          {
            language: "javascript",
            totalEdges: 1,
            resolvedEdges: 1,
            unresolvedEdges: 0,
            resolutionRate: 1,
          },
          {
            language: "typescript",
            totalEdges: 7,
            resolvedEdges: 5,
            unresolvedEdges: 2,
            resolutionRate: 5 / 7,
          },
        ]);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });

    it("resolves explicit path aliases deterministically and abstains for external/ambiguous alias targets", async () => {
      const projectDir = path.join(tempDir, "local-module-alias-project");
      fs.mkdirSync(projectDir, { recursive: true });
      copyAliasFixture(projectDir);
      const configDir = path.join(projectDir, "config");
      fs.mkdirSync(configDir, { recursive: true });
      const originalAliasConfig = fs.readFileSync(path.join(projectDir, "tsconfig.json"), "utf-8")
        .replace('"baseUrl": "."', '"baseUrl": ".."');
      fs.writeFileSync(path.join(configDir, "base.json"), originalAliasConfig);
      fs.writeFileSync(path.join(projectDir, "tsconfig.json"), JSON.stringify({ extends: "./config/base" }));
      const fetchSpy = mockEmbeddings();
      const indexer = new Indexer(projectDir, createIndexerConfig(), "opencode");

      try {
        await indexer.index();
        const symbols = await indexer.getSymbolsForBranch();
        const byName = (name: string): SymbolData => {
          const matches = symbols.filter((symbol) => symbol.name === name);
          expect(matches.length).toBeGreaterThan(0);
          return matches[0];
        };

        const edgeFrom = async (callerName: string, targetName: string): Promise<CallEdgeData> => {
          const callerSymbol = byName(callerName);
          const edge = (await indexer.getCallees(callerSymbol.id)).find((candidate) => candidate.targetName === targetName);
          expect(edge).toBeDefined();
          return edge!;
        };

        await expect(edgeFrom("runDeterministic", "deterministicTarget")).resolves.toMatchObject({
          isResolved: true,
          toSymbolId: byName("deterministicTarget").id,
        });

        const ambiguousEdge = await edgeFrom("runAmbiguous", "ambiguousTarget");
        expect(ambiguousEdge).toMatchObject({ isResolved: false });
        expect(ambiguousEdge.toSymbolId).toBeUndefined();

        const externalEdge = await edgeFrom("runExternal", "externalTarget");
        expect(externalEdge).toMatchObject({ isResolved: false });
        expect(externalEdge.toSymbolId).toBeUndefined();

        const embeddingCallsBeforeConfigChange = fetchSpy.mock.calls.length;
        fs.writeFileSync(path.join(configDir, "base.json"), JSON.stringify({
          compilerOptions: {
            baseUrl: "..",
            paths: {
              "@core/*": ["src/missing/*"],
              "@ambiguous/*": ["src/ambiguous-a/*", "src/ambiguous-b/*"],
            },
          },
        }));
        await indexer.index();

        const refreshedEdge = await edgeFrom("runDeterministic", "deterministicTarget");
        expect(refreshedEdge).toMatchObject({ isResolved: false });
        expect(refreshedEdge.toSymbolId).toBeUndefined();
        expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeConfigChange);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });

    it("reprocesses unchanged importers when a local re-export changes", async () => {
      const projectDir = path.join(tempDir, "local-module-refresh-project");
      fs.mkdirSync(projectDir, { recursive: true });
      copyLocalModuleFixture(projectDir);
      const fetchSpy = mockEmbeddings();
      let indexer = new Indexer(projectDir, createIndexerConfig(), "opencode");

      try {
        await indexer.index();
        let symbols = await indexer.getSymbolsForBranch();
        let caller = symbols.find((symbol) => symbol.name === "runReexport");
        let edge = (await indexer.getCallees(caller!.id)).find(
          (candidate) => candidate.targetName === "localReexport",
        );
        expect(edge?.isResolved).toBe(true);
        await indexer.close();

        fs.writeFileSync(
          path.join(projectDir, "barrel.ts"),
          'export { missingOriginal as publicTarget } from "./reexport-source.js";\n',
        );
        indexer = new Indexer(projectDir, createIndexerConfig(), "opencode");
        await indexer.index();
        symbols = await indexer.getSymbolsForBranch();
        caller = symbols.find((symbol) => symbol.name === "runReexport");
        edge = (await indexer.getCallees(caller!.id)).find(
          (candidate) => candidate.targetName === "localReexport",
        );
        expect(edge).toMatchObject({ isResolved: false });
        expect(edge?.toSymbolId).toBeUndefined();
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });

    it("migrates unchanged local import edges without re-embedding chunks", async () => {
      const projectDir = path.join(tempDir, "local-module-migration-project");
      fs.mkdirSync(projectDir, { recursive: true });
      copyLocalModuleFixture(projectDir);
      const fetchSpy = mockEmbeddings();
      let indexer = new Indexer(projectDir, createIndexerConfig(), "opencode");

      try {
        await indexer.index();
        const symbols = await indexer.getSymbolsForBranch();
        const caller = symbols.find((symbol) => symbol.name === "runAlias");
        const edge = (await indexer.getCallees(caller!.id)).find(
          (candidate) => candidate.targetName === "localAlias",
        );
        expect(edge?.isResolved).toBe(true);
        await indexer.close();

        const database = new Database(path.join(projectDir, ".opencode", "index", "codebase.db"));
        database.upsertCallEdge({
          id: edge!.id,
          fromSymbolId: edge!.fromSymbolId,
          targetName: edge!.targetName,
          callType: edge!.callType,
          confidence: edge!.confidence,
          line: edge!.line,
          col: edge!.col,
          isResolved: false,
        });
        database.setMetadata(migrationMetadataKey("index.callGraphResolutionVersion"), "4");
        database.close();
        const embeddingCallsBeforeMigration = fetchSpy.mock.calls.length;

        indexer = new Indexer(projectDir, createIndexerConfig(), "opencode");
        await indexer.index();
        const migratedSymbols = await indexer.getSymbolsForBranch();
        const migratedCaller = migratedSymbols.find((symbol) => symbol.name === "runAlias");
        const migratedTarget = migratedSymbols.find((symbol) => symbol.name === "directTarget");
        const migratedEdge = (await indexer.getCallees(migratedCaller!.id)).find(
          (candidate) => candidate.targetName === "localAlias",
        );
        expect(migratedEdge).toMatchObject({
          isResolved: true,
          toSymbolId: migratedTarget!.id,
        });
        expect(fetchSpy).toHaveBeenCalledTimes(embeddingCallsBeforeMigration);
      } finally {
        await indexer.close();
        fetchSpy.mockRestore();
      }
    });
  });

  describe("branch awareness", () => {
    it("reports graph coverage only for the active branch", async () => {
      writeGitBranchHead("main");
      const db = openIndexerDb();
      const symbols: SymbolData[] = [
        {
          id: "sym_main_coverage_caller",
          filePath: "src/main-caller.ts",
          name: "mainCaller",
          kind: "function_declaration",
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_main_coverage_target",
          filePath: "src/main-target.ts",
          name: "mainTarget",
          kind: "function_declaration",
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_feature_coverage_caller",
          filePath: "src/feature-caller.js",
          name: "featureCaller",
          kind: "function_declaration",
          startLine: 1,
          startCol: 0,
          endLine: 3,
          endCol: 0,
          language: "javascript",
        },
      ];
      db.upsertSymbolsBatch(symbols);
      db.addSymbolsToBranchBatch("main", [symbols[0].id, symbols[1].id]);
      db.addSymbolsToBranchBatch("feature", [symbols[2].id]);
      db.upsertCallEdgesBatch([
        {
          id: "edge_main_coverage",
          fromSymbolId: symbols[0].id,
          targetName: symbols[1].name,
          toSymbolId: symbols[1].id,
          callType: "Call",
          confidence: "Direct",
          line: 2,
          col: 2,
          isResolved: true,
        },
        {
          id: "edge_feature_coverage",
          fromSymbolId: symbols[2].id,
          targetName: "missingFeatureTarget",
          callType: "Call",
          confidence: "Direct",
          line: 2,
          col: 2,
          isResolved: false,
        },
      ]);
      db.close();

      let indexer = new Indexer(tempDir, createIndexerConfig(), "opencode");
      try {
        await expect(indexer.getCallGraphCoverage()).resolves.toMatchObject({
          totalEdges: 1,
          resolvedEdges: 1,
          unresolvedEdges: 0,
          languages: [{ language: "typescript", totalEdges: 1, resolvedEdges: 1 }],
        });
        await indexer.close();

        writeGitBranchHead("feature");
        indexer = new Indexer(tempDir, createIndexerConfig(), "opencode");
        await expect(indexer.getCallGraphCoverage()).resolves.toMatchObject({
          totalEdges: 1,
          resolvedEdges: 0,
          unresolvedEdges: 1,
          languages: [{ language: "javascript", totalEdges: 1, resolvedEdges: 0 }],
        });
      } finally {
        await indexer.close();
      }
    });

    it("should filter symbols by current branch", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_main_1",
          filePath: "/src/main.ts",
          name: "mainFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_feat_1",
          filePath: "/src/feat.ts",
          name: "featFunc",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      db.addSymbolsToBranchBatch("main", ["sym_main_1"]);
      db.addSymbolsToBranchBatch("feature", ["sym_feat_1"]);

      // Create edges so getCallers can find them
      const edges: CallEdgeData[] = [
        {
          id: "edge_main_1",
          fromSymbolId: "sym_main_1",
          targetName: "mainFunc",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 0,
          isResolved: false,
        },
        {
          id: "edge_feat_1",
          fromSymbolId: "sym_feat_1",
          targetName: "featFunc",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Query with branch "main" should only return main symbols
      const mainCallers = db.getCallers("mainFunc", "main");
      expect(mainCallers.length).toBe(1);
      expect(mainCallers[0].fromSymbolId).toBe("sym_main_1");

      // Query with branch "main" should not return feature symbols
      const featOnMain = db.getCallers("featFunc", "main");
      expect(featOnMain.length).toBe(0);
    });

    it("should filter call edges by branch", () => {
      const db = openDb();

      const symbols: SymbolData[] = [
        {
          id: "sym_br_a",
          filePath: "/src/a.ts",
          name: "funcA",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
        {
          id: "sym_br_b",
          filePath: "/src/b.ts",
          name: "funcB",
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 5,
          endCol: 0,
          language: "typescript",
        },
      ];
      db.upsertSymbolsBatch(symbols);

      db.addSymbolsToBranchBatch("main", ["sym_br_a"]);
      db.addSymbolsToBranchBatch("other", ["sym_br_b"]);

      const edges: CallEdgeData[] = [
        {
          id: "edge_ba",
          fromSymbolId: "sym_br_a",
          targetName: "sharedTarget",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 0,
          isResolved: false,
        },
        {
          id: "edge_bb",
          fromSymbolId: "sym_br_b",
          targetName: "sharedTarget",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 0,
          isResolved: false,
        },
      ];
      db.upsertCallEdgesBatch(edges);

      // Only sym_br_a is on "main"
      const mainCallers = db.getCallers("sharedTarget", "main");
      expect(mainCallers.length).toBe(1);
      expect(mainCallers[0].fromSymbolId).toBe("sym_br_a");

      // Only sym_br_b is on "other"
      const otherCallers = db.getCallers("sharedTarget", "other");
      expect(otherCallers.length).toBe(1);
      expect(otherCallers[0].fromSymbolId).toBe("sym_br_b");
    });
  });

  describe("integration", () => {
    it("should build complete call graph for simple project", () => {
      const db = openDb();
      const content = fs.readFileSync(path.join(fixturesDir, "same-file-refs.ts"), "utf-8");
      const filePath = path.join(fixturesDir, "same-file-refs.ts");

      // Extract calls
      const callSites = extractCalls(content, "typescript");
      expect(callSites.length).toBeGreaterThan(0);

      // Build symbols from known functions in the fixture
      const functionDefs = [
        { name: "entryPoint", startLine: 5, endLine: 13 },
        { name: "helperA", startLine: 15, endLine: 18 },
        { name: "helperB", startLine: 20, endLine: 22 },
        { name: "internalUtil", startLine: 24, endLine: 26 },
        { name: "MyClass", startLine: 28, endLine: 41 },
        { name: "outerScope", startLine: 54, endLine: 60 },
        { name: "fibonacci", startLine: 63, endLine: 66 },
        { name: "evenOdd", startLine: 68, endLine: 71 },
        { name: "isOdd", startLine: 73, endLine: 76 },
        { name: "exported", startLine: 79, endLine: 81 },
      ];

      const symbols: SymbolData[] = functionDefs.map((def) => ({
        id: `sym_${hashContent(filePath + ":" + def.name + ":function:" + def.startLine).slice(0, 16)}`,
        filePath,
        name: def.name,
        kind: "function",
        startLine: def.startLine,
        startCol: 0,
        endLine: def.endLine,
        endCol: 0,
        language: "typescript",
      }));

      db.upsertSymbolsBatch(symbols);

      // Build edges from call sites
      const edges: CallEdgeData[] = [];
      for (const site of callSites) {
        const enclosing = symbols.find(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine
        );
        if (!enclosing) continue;

        const edgeId = `edge_${hashContent(enclosing.id + ":" + site.calleeName + ":" + site.line + ":" + site.column).slice(0, 16)}`;
        edges.push({
          id: edgeId,
          fromSymbolId: enclosing.id,
          targetName: site.calleeName,
          callType: site.callType,
          confidence: site.confidence,
          line: site.line,
          col: site.column,
          isResolved: false,
        });
      }

      expect(edges.length).toBeGreaterThan(0);
      db.upsertCallEdgesBatch(edges);

      // Resolve same-file calls
      for (const edge of edges) {
        const matchingSymbol = symbols.find((sym) => sym.name === edge.targetName);
        if (matchingSymbol) {
          db.resolveCallEdge(edge.id, matchingSymbol.id);
        }
      }

      // Add symbols to branch
      db.addSymbolsToBranchBatch("main", symbols.map((s) => s.id));

      // Verify: helperA should be called by entryPoint, arrowFunc, outerScope (innerScope), exported
      const helperACallers = db.getCallers("helperA", "main");
      expect(helperACallers.length).toBeGreaterThan(0);

      // Verify: helperB should be called by entryPoint and helperA
      const helperBCallers = db.getCallers("helperB", "main");
      expect(helperBCallers.length).toBeGreaterThan(0);

      // Verify entryPoint's callees
      const entryPointSymbol = symbols.find((s) => s.name === "entryPoint");
      expect(entryPointSymbol).toBeDefined();
      const entryCallees = db.getCallees(entryPointSymbol!.id, "main");
      expect(entryCallees.length).toBeGreaterThan(0);

      const entryCalleeNames = entryCallees.map((e) => e.targetName);
      expect(entryCalleeNames).toContain("helperA");
      expect(entryCalleeNames).toContain("helperB");

      // Verify resolved edges have toSymbolId set
      const resolvedCallees = entryCallees.filter((e) => e.isResolved);
      expect(resolvedCallees.length).toBeGreaterThan(0);
      for (const resolved of resolvedCallees) {
        expect(resolved.toSymbolId).toBeDefined();
      }
    });
  });

  describe("inheritance and implements extraction", () => {
    it("should extract TypeScript class extends", () => {
      const code = "class AdminController extends BaseController { handle() {} }";
      const calls = extractCalls(code, "typescript");
      const inherits = calls.filter((c) => c.callType === "Inherits");
      expect(inherits.length).toBe(1);
      expect(inherits[0].calleeName).toBe("BaseController");
    });

    it("should extract TypeScript class implements", () => {
      const code = "class UserService implements IUserService { getUser() {} }";
      const calls = extractCalls(code, "typescript");
      const impl = calls.filter((c) => c.callType === "Implements");
      expect(impl.length).toBe(1);
      expect(impl[0].calleeName).toBe("IUserService");
    });

    it("should extract TypeScript extends + implements together", () => {
      const code = "class Admin extends BaseUser implements IAdmin, ISerializable { }";
      const calls = extractCalls(code, "typescript");
      const inherits = calls.filter((c) => c.callType === "Inherits");
      const impl = calls.filter((c) => c.callType === "Implements");
      expect(inherits.length).toBe(1);
      expect(inherits[0].calleeName).toBe("BaseUser");
      expect(impl.length).toBe(2);
      const implNames = impl.map((c) => c.calleeName);
      expect(implNames).toContain("IAdmin");
      expect(implNames).toContain("ISerializable");
    });

    it("should extract Python class inheritance", () => {
      const code = "class Admin(BaseUser, Serializable):\n    pass\n";
      const calls = extractCalls(code, "python");
      const inherits = calls.filter((c) => c.callType === "Inherits");
      expect(inherits.length).toBe(2);
      const names = inherits.map((c) => c.calleeName);
      expect(names).toContain("BaseUser");
      expect(names).toContain("Serializable");
    });

    it("should extract Rust impl trait", () => {
      const code = "impl Display for MyStruct { fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) } }";
      const calls = extractCalls(code, "rust");
      const impl = calls.filter((c) => c.callType === "Implements");
      expect(impl.length).toBe(1);
      expect(impl[0].calleeName).toBe("Display");
    });

    it("should extract Go struct embedding", () => {
      const code = "package main\n\ntype Admin struct {\n\tBaseUser\n}";
      const calls = extractCalls(code, "go");
      const inherits = calls.filter((c) => c.callType === "Inherits");
      expect(inherits.length).toBe(1);
      expect(inherits[0].calleeName).toBe("BaseUser");
    });

    it("should store and query inheritance edges in database", () => {
      const db = openDb();
      const branch = "main";

      // Create symbols
      const baseSymbol: SymbolData = {
        id: "sym_base",
        filePath: "src/base.ts",
        name: "BaseController",
        kind: "class",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      };
      const childSymbol: SymbolData = {
        id: "sym_child",
        filePath: "src/admin.ts",
        name: "AdminController",
        kind: "class",
        startLine: 1,
        startCol: 0,
        endLine: 20,
        endCol: 0,
        language: "typescript",
      };

      db.upsertSymbol(baseSymbol);
      db.upsertSymbol(childSymbol);
      db.addSymbolsToBranch(branch, [baseSymbol.id, childSymbol.id]);

      // Create an Inherits edge
      const edge: CallEdgeData = {
        id: "edge_inherits_1",
        fromSymbolId: "sym_child",
        targetName: "BaseController",
        toSymbolId: "sym_base",
        callType: "Inherits",
        confidence: "Direct",
        line: 1,
        col: 0,
        isResolved: true,
      };
      db.upsertCallEdge(edge);

      // Query callers of BaseController should include the Inherits edge
      const callers = db.getCallersWithContext("BaseController", branch);
      expect(callers.length).toBe(1);
      expect(callers[0].callType).toBe("Inherits");
      expect(callers[0].fromSymbolId).toBe("sym_child");
    });
  });

  describe("shortest path", () => {
    it("should find a direct path between two symbols", () => {
      const db = openDb();

      // Create symbols: A -> B -> C
      db.upsertSymbol({
        id: "sym_a",
        filePath: "src/a.ts",
        name: "funcA",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_b",
        filePath: "src/b.ts",
        name: "funcB",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_c",
        filePath: "src/c.ts",
        name: "funcC",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      // Add to branch
      db.addSymbolsToBranch("main", ["sym_a", "sym_b", "sym_c"]);

      // Create edges: A calls B, B calls C
      db.upsertCallEdgesBatch([
        {
          id: "edge_ab",
          fromSymbolId: "sym_a",
          targetName: "funcB",
          toSymbolId: "sym_b",
          callType: "Call",
        confidence: "Direct",
          line: 5,
          col: 2,
          isResolved: true,
        },
        {
          id: "edge_bc",
          fromSymbolId: "sym_b",
          targetName: "funcC",
          toSymbolId: "sym_c",
          callType: "Call",
        confidence: "Direct",
          line: 3,
          col: 2,
          isResolved: true,
        },
      ]);

      const result = db.findShortestPath("funcA", "funcC", "main");
      expect(result.length).toBe(3);
      expect(result[0].symbolName).toBe("funcA");
      expect(result[1].symbolName).toBe("funcB");
      expect(result[2].symbolName).toBe("funcC");
      expect(result[0].filePath).toBe("src/a.ts");
      expect(result[1].filePath).toBe("src/b.ts");
      expect(result[2].filePath).toBe("src/c.ts");
    });

    it("should return empty array when no path exists", () => {
      const db = openDb();

      // Two disconnected symbols
      db.upsertSymbol({
        id: "sym_x",
        filePath: "src/x.ts",
        name: "funcX",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_y",
        filePath: "src/y.ts",
        name: "funcY",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      db.addSymbolsToBranch("main", ["sym_x", "sym_y"]);

      const result = db.findShortestPath("funcX", "funcY", "main");
      expect(result.length).toBe(0);
    });

    it("should return empty array when source symbol does not exist", () => {
      const db = openDb();
      const result = db.findShortestPath("nonexistent", "funcY", "main");
      expect(result.length).toBe(0);
    });

    it("should respect maxDepth limit", () => {
      const db = openDb();

      // Create a chain: A -> B -> C -> D
      const symbols = ["A", "B", "C", "D"];
      for (let i = 0; i < symbols.length; i++) {
        db.upsertSymbol({
          id: `sym_${symbols[i]}`,
          filePath: `src/${symbols[i].toLowerCase()}.ts`,
          name: `func${symbols[i]}`,
          kind: "function",
          startLine: 1,
          startCol: 0,
          endLine: 10,
          endCol: 0,
          language: "typescript",
        });
      }
      db.addSymbolsToBranch("main", symbols.map((s) => `sym_${s}`));

      // Create edges: A->B->C->D
      for (let i = 0; i < symbols.length - 1; i++) {
        db.upsertCallEdge({
          id: `edge_${symbols[i]}${symbols[i + 1]}`,
          fromSymbolId: `sym_${symbols[i]}`,
          targetName: `func${symbols[i + 1]}`,
          toSymbolId: `sym_${symbols[i + 1]}`,
          callType: "Call",
        confidence: "Direct",
          line: 5,
          col: 2,
          isResolved: true,
        });
      }

      // maxDepth=2 should not find path from A to D (needs 3 hops)
      const shallow = db.findShortestPath("funcA", "funcD", "main", 2);
      expect(shallow.length).toBe(0);

      // maxDepth=10 (default) should find it
      const deep = db.findShortestPath("funcA", "funcD", "main", 10);
      expect(deep.length).toBe(4);
      expect(deep[0].symbolName).toBe("funcA");
      expect(deep[3].symbolName).toBe("funcD");
    });

    it("should respect branch filtering", () => {
      const db = openDb();

      db.upsertSymbol({
        id: "sym_p",
        filePath: "src/p.ts",
        name: "funcP",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_q",
        filePath: "src/q.ts",
        name: "funcQ",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      // Only add to "feature" branch, not "main"
      db.addSymbolsToBranch("feature", ["sym_p", "sym_q"]);

      db.upsertCallEdge({
        id: "edge_pq",
        fromSymbolId: "sym_p",
        targetName: "funcQ",
        toSymbolId: "sym_q",
        callType: "Call",
        confidence: "Direct",
        line: 3,
        col: 0,
        isResolved: true,
      });

      // Should find path on "feature" branch
      const onFeature = db.findShortestPath("funcP", "funcQ", "feature");
      expect(onFeature.length).toBe(2);

      // Should NOT find path on "main" branch
      const onMain = db.findShortestPath("funcP", "funcQ", "main");
      expect(onMain.length).toBe(0);
    });

    it("should find path through unresolved edges by name matching", () => {
      const db = openDb();

      db.upsertSymbol({
        id: "sym_caller",
        filePath: "src/caller.ts",
        name: "caller",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_middle",
        filePath: "src/middle.ts",
        name: "middle",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_target",
        filePath: "src/target.ts",
        name: "target",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      db.addSymbolsToBranch("main", ["sym_caller", "sym_middle", "sym_target"]);

      // caller -> middle (unresolved, but name matches)
      db.upsertCallEdge({
        id: "edge_cm",
        fromSymbolId: "sym_caller",
        targetName: "middle",
        toSymbolId: undefined,
        callType: "Call",
        confidence: "Direct",
        line: 5,
        col: 0,
        isResolved: false,
      });
      // middle -> target (resolved)
      db.upsertCallEdge({
        id: "edge_mt",
        fromSymbolId: "sym_middle",
        targetName: "target",
        toSymbolId: "sym_target",
        callType: "Call",
        confidence: "Direct",
        line: 3,
        col: 0,
        isResolved: true,
      });

      const result = db.findShortestPath("caller", "target", "main");
      expect(result.length).toBe(3);
      expect(result[0].symbolName).toBe("caller");
      expect(result[1].symbolName).toBe("middle");
      expect(result[2].symbolName).toBe("target");
    });

    it("should return no path when target name is ambiguous and unresolved", () => {
      const db = openDb();

      // Create caller symbol
      db.upsertSymbol({
        id: "sym_caller_amb",
        filePath: "src/caller.ts",
        name: "caller",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      // Create two symbols with the same name "handler" in different files
      db.upsertSymbol({
        id: "sym_handler_a",
        filePath: "src/handler-a.ts",
        name: "handler",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_handler_b",
        filePath: "src/handler-b.ts",
        name: "handler",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      db.addSymbolsToBranch("main", ["sym_caller_amb", "sym_handler_a", "sym_handler_b"]);

      // Unresolved edge from caller to "handler" (no to_symbol_id)
      db.upsertCallEdge({
        id: "edge_ambiguous",
        fromSymbolId: "sym_caller_amb",
        targetName: "handler",
        toSymbolId: undefined,
        callType: "Call",
        confidence: "Direct",
        line: 5,
        col: 0,
        isResolved: false,
      });

      // Ambiguous target (multiple symbols named "handler") should return no path
      const result = db.findShortestPath("caller", "handler", "main");
      expect(result.length).toBe(0);
    });

    it("should prefer edge to_symbol_id when it matches a resolved target", () => {
      const db = openDb();

      db.upsertSymbol({
        id: "sym_src",
        filePath: "src/src.ts",
        name: "source",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_dest_a",
        filePath: "src/dest-a.ts",
        name: "dest",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertSymbol({
        id: "sym_dest_b",
        filePath: "src/dest-b.ts",
        name: "dest",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      db.addSymbolsToBranch("main", ["sym_src", "sym_dest_a", "sym_dest_b"]);

      // Resolved edge pointing specifically to dest_b
      db.upsertCallEdge({
        id: "edge_resolved_dest",
        fromSymbolId: "sym_src",
        targetName: "dest",
        toSymbolId: "sym_dest_b",
        callType: "Call",
        confidence: "Direct",
        line: 5,
        col: 0,
        isResolved: true,
      });

      const result = db.findShortestPath("source", "dest", "main");
      expect(result.length).toBe(2);
      expect(result[0].symbolName).toBe("source");
      expect(result[1].symbolName).toBe("dest");
      // Should use the specific resolved target (dest_b), not arbitrary first match
      expect(result[1].filePath).toBe("src/dest-b.ts");
      expect(result[1].symbolId).toBe("sym_dest_b");
    });

    describe("findCallPathBySymbolIds", () => {
      const functionSymbol = (id: string, filePath: string, name: string): SymbolData => ({
        id,
        filePath,
        name,
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });

      const callEdge = ({
        id,
        fromSymbolId,
        targetName,
        toSymbolId,
        callType = "Call",
        confidence = "Direct",
        line = 1,
        col = 0,
        isResolved = true,
      }: Pick<CallEdgeData, "id" | "fromSymbolId" | "targetName"> &
        Partial<Pick<CallEdgeData, "toSymbolId" | "callType" | "confidence" | "line" | "col" | "isResolved">>):
        CallEdgeData => ({
        id,
        fromSymbolId,
        targetName,
        toSymbolId,
        callType,
        confidence,
        line,
        col,
        isResolved,
      });

      const callPath = async (fromSymbolId: string, toSymbolId: string, maxDepth = 10) => {
        const indexer = new Indexer(tempDir, createIndexerConfig(), "opencode");
        try {
          return await indexer.findCallPathBySymbolIds(fromSymbolId, toSymbolId, maxDepth);
        } finally {
          await indexer.close();
        }
      };

      it("does not retarget resolved edges to a different symbol on another branch", async () => {
        writeGitBranchHead("main");
        const db = openIndexerDb();

        db.upsertSymbolsBatch([
          functionSymbol("sym_caller", "src/caller.ts", "caller"),
          functionSymbol("sym_target_main", "src/target-main.ts", "target"),
          functionSymbol("sym_target_feature", "src/target-feature.ts", "target"),
        ]);

        db.addSymbolsToBranch("main", ["sym_caller", "sym_target_main"]);
        db.addSymbolsToBranch("feature", ["sym_target_feature"]);

        db.upsertCallEdge(
          callEdge({
            id: "edge_cross_branch",
            fromSymbolId: "sym_caller",
            targetName: "target",
            toSymbolId: "sym_target_feature",
            line: 5,
          }),
        );

        const path = await callPath("sym_caller", "sym_target_main", 10);
        expect(path).toEqual([]);
      });

      it("uses name fallback only for unresolved edges", async () => {
        writeGitBranchHead("main");
        const db = openIndexerDb();

        db.upsertSymbolsBatch([
          functionSymbol("sym_entry", "src/entry.ts", "entry"),
          functionSymbol("sym_mid", "src/mid.ts", "mid"),
          functionSymbol("sym_exit", "src/exit.ts", "exit"),
        ]);

        db.addSymbolsToBranch("main", ["sym_entry", "sym_mid", "sym_exit"]);

        db.upsertCallEdgesBatch([
          callEdge({
            id: "edge_entry_mid",
            fromSymbolId: "sym_entry",
            targetName: "mid",
            line: 2,
            isResolved: false,
          }),
          callEdge({
            id: "edge_mid_exit",
            fromSymbolId: "sym_mid",
            targetName: "exit",
            toSymbolId: "sym_exit",
            line: 4,
          }),
        ]);

        const path = await callPath("sym_entry", "sym_exit", 10);
        expect(path.map((item) => item.symbolId)).toEqual(["sym_entry", "sym_mid", "sym_exit"]);
      });

      it("respects branch catalog filtering", async () => {
        writeGitBranchHead("main");
        const db = openIndexerDb();

        db.upsertSymbolsBatch([
          functionSymbol("sym_main_call", "src/main-call.ts", "call"),
          functionSymbol("sym_main_target", "src/main-target.ts", "target"),
          functionSymbol("sym_feature_call", "src/feature-call.ts", "call"),
          functionSymbol("sym_feature_target", "src/feature-target.ts", "target"),
        ]);

        db.addSymbolsToBranch("main", ["sym_main_call", "sym_main_target"]);
        db.addSymbolsToBranch("feature", ["sym_feature_call", "sym_feature_target"]);

        db.upsertCallEdgesBatch([
          callEdge({
            id: "edge_main",
            fromSymbolId: "sym_main_call",
            targetName: "target",
            toSymbolId: "sym_main_target",
            line: 3,
          }),
          callEdge({
            id: "edge_feature",
            fromSymbolId: "sym_feature_call",
            targetName: "target",
            toSymbolId: "sym_feature_target",
            line: 3,
          }),
        ]);

        const mainPath = await callPath("sym_main_call", "sym_main_target", 10);
        expect(mainPath.map((item) => item.symbolId)).toEqual(["sym_main_call", "sym_main_target"]);

        const mainToFeature = await callPath("sym_main_call", "sym_feature_target", 10);
        expect(mainToFeature).toEqual([]);

        writeGitBranchHead("feature");
        const featurePath = await callPath("sym_feature_call", "sym_feature_target", 10);
        expect(featurePath.map((item) => item.symbolId)).toEqual([
          "sym_feature_call",
          "sym_feature_target",
        ]);

        const featureToMain = await callPath("sym_feature_call", "sym_main_target", 10);
        expect(featureToMain).toEqual([]);
      });

      it("respects maxDepth boundary", async () => {
        writeGitBranchHead("main");
        const db = openIndexerDb();

        db.upsertSymbolsBatch([
          functionSymbol("sym_depth_a", "src/depth-a.ts", "depthA"),
          functionSymbol("sym_depth_b", "src/depth-b.ts", "depthB"),
          functionSymbol("sym_depth_c", "src/depth-c.ts", "depthC"),
        ]);

        db.addSymbolsToBranch("main", ["sym_depth_a", "sym_depth_b", "sym_depth_c"]);

        db.upsertCallEdgesBatch([
          callEdge({
            id: "edge_depth_ab",
            fromSymbolId: "sym_depth_a",
            targetName: "depthB",
            toSymbolId: "sym_depth_b",
            line: 1,
          }),
          callEdge({
            id: "edge_depth_bc",
            fromSymbolId: "sym_depth_b",
            targetName: "depthC",
            toSymbolId: "sym_depth_c",
            line: 2,
          }),
        ]);

        const tooShallow = await callPath("sym_depth_a", "sym_depth_c", 1);
        expect(tooShallow).toEqual([]);

        const sufficient = await callPath("sym_depth_a", "sym_depth_c", 2);
        expect(sufficient.map((item) => item.symbolId)).toEqual(["sym_depth_a", "sym_depth_b", "sym_depth_c"]);
      });
    });
  });
});
