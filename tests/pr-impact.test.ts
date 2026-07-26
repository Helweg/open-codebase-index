import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { pr_impact, call_graph, initializeTools } from "../src/tools/index.js";
import { getChangedFiles } from "../src/tools/changed-files.js";
import type { Database } from "../src/native/index.js";
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));
import { execFile } from "child_process";

vi.mock("../src/tools/changed-files.js", () => ({
  getChangedFiles: vi.fn(),
}));

describe("pr_impact tool", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let _indexers: Indexer[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });
      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 },
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-impact-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(
      path.join(tempDir, "src", "placeholder.ts"),
      "export function placeholder() { return 1; }\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createIndexer(): Promise<Indexer> {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
    });
    initializeTools(tempDir, config);
    const indexer = new Indexer(tempDir, config);
    _indexers.push(indexer);
    await indexer.index();
    return indexer;
  }

  async function getDatabase(indexer: Indexer): Promise<Database> {
    await indexer.getStatus();
    return (indexer as unknown as { database: Database }).database;
  }

  it("happy path returns formatted report with expected sections", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: ["src/a.ts"],
      baseBranch: "main",
      source: "git",
      headRefName: "main",
    });

    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    db.upsertSymbol({
      id: "sym_a",
      filePath: path.join(tempDir, "src", "a.ts"),
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
      filePath: path.join(tempDir, "src", "b.ts"),
      name: "funcB",
      kind: "function",
      startLine: 1,
      startCol: 0,
      endLine: 10,
      endCol: 0,
      language: "typescript",
    });
    db.addSymbolsToBranch("main", ["sym_a", "sym_b"]);
    db.upsertCallEdge({
      id: "edge_ba",
      fromSymbolId: "sym_b",
      targetName: "funcA",
      toSymbolId: "sym_a",
      callType: "Call",
      confidence: "Direct",
      line: 5,
      col: 0,
      isResolved: true,
    });

    const result = await pr_impact.execute({ branch: "main" }, { worktree: tempDir });
    expect(typeof result).toBe("string");
    expect(result).toContain("Files changed:");
    expect(result).toContain("src/a.ts");
    expect(result).toContain("Symbols affected:");
    expect(result).toContain("Communities touched:");
    expect(result).toContain("Risk:");
  });

  it("returns an actionable error when a missing branch cannot be materialized", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: ["src/a.ts"],
      baseBranch: "main",
      source: "git",
      headRefName: "feature",
    });

    const indexer = await createIndexer();
    const db = await getDatabase(indexer);
    db.addSymbolsToBranch("main", []);
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        callback: (error: Error) => void,
      ) => callback(new Error("ref unavailable")),
    );

    const result = await pr_impact.execute({ branch: "feature" }, { worktree: tempDir });
    expect(typeof result).toBe("string");
    expect(result).toContain("Error analyzing PR impact");
    expect(result).toContain("not available locally");
  });

  it("throws when headRefName cannot be resolved in PR mode", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: ["src/a.ts"],
      baseBranch: "main",
      source: "git",
      headRefName: undefined,
    });

    const indexer = await createIndexer();

    await expect(indexer.getPrImpact({ pr: 42 })).rejects.toThrow(
      "Could not resolve head branch for PR #42",
    );
  });

  it("uses the indexed detached-HEAD branch key in branch mode", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: ["src/a.ts"],
      baseBranch: "main",
      source: "git",
      headRefName: "HEAD",
    });

    fs.writeFileSync(
      path.join(tempDir, ".git", "HEAD"),
      "2222222222222222222222222222222222222222\n",
    );
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);
    db.upsertSymbol({
      id: "sym_detached",
      filePath: path.join(tempDir, "src", "a.ts"),
      name: "detachedFunc",
      kind: "function",
      startLine: 1,
      startCol: 0,
      endLine: 10,
      endCol: 0,
      language: "typescript",
    });
    db.addSymbolsToBranch("2222222", ["sym_detached"]);

    const result = await indexer.getPrImpact({});

    expect(result.directSymbols.map((s) => s.id)).toContain("sym_detached");
  });

  it("detects hub nodes and flags HIGH risk", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: ["src/db.ts"],
      baseBranch: "main",
      source: "git",
      headRefName: "main",
    });

    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    db.upsertSymbol({
      id: "sym_hub",
      filePath: path.join(tempDir, "src", "db.ts"),
      name: "DatabasePool",
      kind: "class",
      startLine: 1,
      startCol: 0,
      endLine: 20,
      endCol: 0,
      language: "typescript",
    });

    const callerSymbols: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const id = `sym_caller_${i}`;
      callerSymbols.push(id);
      db.upsertSymbol({
        id,
        filePath: path.join(tempDir, "src", `caller${i}.ts`),
        name: `caller${i}`,
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 10,
        endCol: 0,
        language: "typescript",
      });
      db.upsertCallEdge({
        id: `edge_${i}`,
        fromSymbolId: id,
        targetName: "DatabasePool",
        toSymbolId: "sym_hub",
        callType: "Call",
        confidence: "Direct",
        line: 5,
        col: 0,
        isResolved: true,
      });
    }

    db.addSymbolsToBranch("main", ["sym_hub", ...callerSymbols]);

    const result = await pr_impact.execute({ branch: "main" }, { worktree: tempDir });
    expect(typeof result).toBe("string");
    expect(result).toContain("Risk: HIGH");
    expect(result).toContain("DatabasePool");
    expect(result).toContain("Hub nodes in change scope:");
  });

  it("regression: call_graph tool still works", async () => {
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    db.upsertSymbol({
      id: "sym_x",
      filePath: path.join(tempDir, "src", "x.ts"),
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
      filePath: path.join(tempDir, "src", "y.ts"),
      name: "funcY",
      kind: "function",
      startLine: 1,
      startCol: 0,
      endLine: 10,
      endCol: 0,
      language: "typescript",
    });
    db.addSymbolsToBranch("main", ["sym_x", "sym_y"]);
    db.upsertCallEdge({
      id: "edge_yx",
      fromSymbolId: "sym_y",
      targetName: "funcX",
      toSymbolId: "sym_x",
      callType: "Call",
      confidence: "Direct",
      line: 5,
      col: 0,
      isResolved: true,
    });

    const result = await call_graph.execute(
      { name: "funcX", direction: "callers" },
      { worktree: tempDir },
    );
    expect(typeof result).toBe("string");
    expect(result).toContain("funcY");
  });

  it("direction callers only returns upstream callers", async () => {
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    // Build: X -> A -> B (X calls A, A calls B)
    db.upsertSymbol({
      id: "sym_x", filePath: path.join(tempDir, "src", "x.ts"), name: "funcX",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_a", filePath: path.join(tempDir, "src", "a.ts"), name: "funcA",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_b", filePath: path.join(tempDir, "src", "b.ts"), name: "funcB",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.addSymbolsToBranch("main", ["sym_x", "sym_a", "sym_b"]);
    db.upsertCallEdge({
      id: "edge_xa", fromSymbolId: "sym_x", targetName: "funcA", toSymbolId: "sym_a",
      callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true,
    });
    db.upsertCallEdge({
      id: "edge_ab", fromSymbolId: "sym_a", targetName: "funcB", toSymbolId: "sym_b",
      callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true,
    });

    // callers of A should include X (calls A), not B (called by A)
    const callers = db.getTransitiveReachability(["sym_a"], "main", "callers", 5);
    const callerIds = callers.map((c) => c.symbolId);
    expect(callerIds).toContain("sym_x");
    expect(callerIds).not.toContain("sym_b");
  });

  it("direction callees only returns downstream callees", async () => {
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    // Build: X -> A -> B
    db.upsertSymbol({
      id: "sym_x", filePath: path.join(tempDir, "src", "x.ts"), name: "funcX",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_a", filePath: path.join(tempDir, "src", "a.ts"), name: "funcA",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_b", filePath: path.join(tempDir, "src", "b.ts"), name: "funcB",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.addSymbolsToBranch("main", ["sym_x", "sym_a", "sym_b"]);
    db.upsertCallEdge({
      id: "edge_xa", fromSymbolId: "sym_x", targetName: "funcA", toSymbolId: "sym_a",
      callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true,
    });
    db.upsertCallEdge({
      id: "edge_ab", fromSymbolId: "sym_a", targetName: "funcB", toSymbolId: "sym_b",
      callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true,
    });

    // callees of A should include B (A calls B), not X (calls A)
    const callees = db.getTransitiveReachability(["sym_a"], "main", "callees", 5);
    const calleeIds = callees.map((c) => c.symbolId);
    expect(calleeIds).toContain("sym_b");
    expect(calleeIds).not.toContain("sym_x");
  });

  it("direction both returns union of callers and callees", async () => {
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    // Build: X -> A -> B
    db.upsertSymbol({
      id: "sym_x", filePath: path.join(tempDir, "src", "x.ts"), name: "funcX",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_a", filePath: path.join(tempDir, "src", "a.ts"), name: "funcA",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_b", filePath: path.join(tempDir, "src", "b.ts"), name: "funcB",
      kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript",
    });
    db.addSymbolsToBranch("main", ["sym_x", "sym_a", "sym_b"]);
    db.upsertCallEdge({
      id: "edge_xa", fromSymbolId: "sym_x", targetName: "funcA", toSymbolId: "sym_a",
      callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true,
    });
    db.upsertCallEdge({
      id: "edge_ab", fromSymbolId: "sym_a", targetName: "funcB", toSymbolId: "sym_b",
      callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true,
    });

    // both: should contain X (caller) and B (callee)
    const both = db.getTransitiveReachability(["sym_a"], "main", "both", 5);
    const bothIds = both.map((c) => c.symbolId);
    expect(bothIds).toContain("sym_x");
    expect(bothIds).toContain("sym_b");
  });

  it("regression: checkConflicts detects overlapping PRs using correct branch for getSymbolsForFiles", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { pr?: number }) => {
        if (args.pr === 1) return { files: ["src/a.ts"], baseBranch: "main", source: "git", headRefName: "feature-branch" };
        if (args.pr === 2) return { files: ["src/b.ts"], baseBranch: "main", source: "git", headRefName: "other-branch" };
        if (args.pr === 3) return { files: ["src/c.ts"], baseBranch: "main", source: "git", headRefName: "third-branch" };
        return { files: ["src/a.ts"], baseBranch: "main", source: "git", headRefName: "feature-branch" };
      },
    );

    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        _opts: unknown,
        callback: (err: Error | null, result?: { stdout: string }) => void,
      ) => {
        if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
          callback(null, {
            stdout: '[{"number":2,"headRefName":"other-branch"},{"number":3,"headRefName":"third-branch"}]\n',
          });
        } else {
          callback(new Error("Unexpected execFile: " + cmd + " " + JSON.stringify(args)));
        }
      },
    );

    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    db.upsertSymbol({
      id: "sym_a",
      filePath: path.join(tempDir, "src", "a.ts"),
      name: "funcA",
      kind: "function",
      startLine: 1, startCol: 0, endLine: 10, endCol: 0,
      language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_b",
      filePath: path.join(tempDir, "src", "b.ts"),
      name: "funcB",
      kind: "function",
      startLine: 1, startCol: 0, endLine: 10, endCol: 0,
      language: "typescript",
    });
    db.upsertSymbol({
      id: "sym_c",
      filePath: path.join(tempDir, "src", "c.ts"),
      name: "funcC",
      kind: "function",
      startLine: 1, startCol: 0, endLine: 10, endCol: 0,
      language: "typescript",
    });

    db.addSymbolsToBranch("feature-branch", ["sym_a", "sym_b", "sym_c"]);
    db.addSymbolsToBranch("other-branch", ["sym_b"]);

    db.upsertCallEdge({
      id: "edge_ab",
      fromSymbolId: "sym_a",
      targetName: "funcB",
      toSymbolId: "sym_b",
      callType: "Call",
      confidence: "Direct",
      line: 5, col: 0,
      isResolved: true,
    });
    db.upsertCallEdge({
      id: "edge_bc",
      fromSymbolId: "sym_b",
      targetName: "funcC",
      toSymbolId: "sym_c",
      callType: "Call",
      confidence: "Direct",
      line: 5, col: 0,
      isResolved: true,
    });

    const getSymbolsSpy = vi.spyOn(db, "getSymbolsForFiles");

    const result = await indexer.getPrImpact({ pr: 1, checkConflicts: true });

    expect(result.conflictingPRs).toBeDefined();
    expect(result.conflictingPRs!.length).toBeGreaterThan(0);

    const prNums = result.conflictingPRs!.map((c) => c.pr);
    expect(prNums).toContain(2);

    expect(getSymbolsSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("b.ts")]),
      "other-branch",
    );
  });

  it("regression: checkConflicts detects overlapping PRs despite cross-branch line drift", async () => {
    (getChangedFiles as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { pr?: number }) => {
        if (args.pr === 1) return { files: ["src/a.ts"], baseBranch: "main", source: "git", headRefName: "feature-branch" };
        if (args.pr === 2) return { files: ["src/a.ts"], baseBranch: "main", source: "git", headRefName: "other-branch" };
        return { files: ["src/a.ts"], baseBranch: "main", source: "git", headRefName: "feature-branch" };
      },
    );

    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        _opts: unknown,
        callback: (err: Error | null, result?: { stdout: string }) => void,
      ) => {
        if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
          callback(null, {
            stdout: '[{"number":2,"headRefName":"other-branch"}]\n',
          });
        } else {
          callback(new Error("Unexpected execFile: " + cmd + " " + JSON.stringify(args)));
        }
      },
    );

    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    const filePath = path.join(tempDir, "src", "a.ts");

    // Symbol on the current branch at line 1.
    db.upsertSymbol({
      id: "sym_a_feature",
      filePath,
      name: "funcA",
      kind: "function",
      startLine: 1,
      startCol: 0,
      endLine: 10,
      endCol: 0,
      language: "typescript",
    });

    // Same symbol on the other branch at line 20, producing a different symbolId.
    db.upsertSymbol({
      id: "sym_a_other",
      filePath,
      name: "funcA",
      kind: "function",
      startLine: 20,
      startCol: 0,
      endLine: 30,
      endCol: 0,
      language: "typescript",
    });

    db.addSymbolsToBranch("feature-branch", ["sym_a_feature"]);
    db.addSymbolsToBranch("other-branch", ["sym_a_other"]);

    const result = await indexer.getPrImpact({ pr: 1, checkConflicts: true });

    expect(result.conflictingPRs).toBeDefined();
    const prNums = result.conflictingPRs!.map((c) => c.pr);
    expect(prNums).toContain(2);
  });
});
