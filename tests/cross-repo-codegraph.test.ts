import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPerQueryResult, computeEvalMetrics } from "../src/eval/metrics.js";
import type { GoldenDataset, GoldenQuery, PerQueryEvalResult } from "../src/eval/types.js";
import type { ParsedFile } from "../src/native/index.js";
import {
  buildGoldenDataset,
  buildReportMarkdown,
  buildPluginEvalRunOptions,
  controlledEvalConfigPath,
  writeControlledEvalConfig,
  MAX_FILE_SIZE_BYTES,
  parseCliArgs,
  runCodeGraphRepeat,
  type CliOptions,
  type RepoBenchmarkResult,
} from "../scripts/cross-repo-benchmark.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function query(id: string, filePath: string, symbol?: string): GoldenQuery {
  return {
    id,
    query: symbol ?? `find ${id}`,
    queryType: "definition",
    expected: { filePath, ...(symbol ? { symbol } : {}) },
  };
}

function result(queryValue: GoldenQuery, filePath: string, name?: string): PerQueryEvalResult {
  return buildPerQueryResult(queryValue, [{
    filePath,
    startLine: 1,
    endLine: 2,
    score: 1,
    chunkType: "function",
    name,
  }], 5, 10);
}

function fixture(): { dataset: GoldenDataset; pluginPerQuery: PerQueryEvalResult[] } {
  const queries = [
    query("symbol-hit", "src/a.ts", "alpha"),
    query("symbol-miss", "src/b.ts", "beta"),
    query("unscoped-hit", "src/c.ts"),
  ];
  return {
    dataset: { version: "1", name: "codegraph-fixture", queries },
    pluginPerQuery: [
      result(queries[0]!, "src/a.ts", "alpha"),
      result(queries[1]!, "src/wrong.ts", "wrong"),
      result(queries[2]!, "src/c.ts"),
    ],
  };
}

function cliOptions(repoPath: string): CliOptions {
  return {
    repos: [repoPath],
    outputRoot: repoPath,
    reindex: false,
    repeats: 2,
    maxParseFiles: 10,
    persistDatasets: false,
    skipRipgrep: true,
    skipSg: true,
    codegraph: true,
  };
}

describe("cross-repo CodeGraph comparator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const directory = tempDirs.pop();
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opts in only with --codegraph", () => {
    const repoPath = tempDir("cross-repo-cg-cli-");
    expect(parseCliArgs(["--repos", repoPath]).codegraph).toBe(false);
    expect(parseCliArgs(["--repos", repoPath, "--codegraph"]).codegraph).toBe(true);
  });

  it("routes generated definition queries through context definition lookup", () => {
    const repoPath = "/repo";
    const parsedFiles: ParsedFile[] = ["alpha", "beta", "gamma"].map((symbol) => ({
      path: path.join(repoPath, "src", `${symbol}.ts`),
      hash: symbol,
      symbols: [],
      chunks: [{
        content: `export function ${symbol}() { return "${symbol}"; }`,
        startLine: 1,
        endLine: 1,
        chunkType: "function",
        name: symbol,
        language: "typescript",
      }],
    }));

    const dataset = buildGoldenDataset("fixture", repoPath, parsedFiles);
    const definitions = dataset.queries.filter((item) => item.queryType === "definition");

    expect(definitions).toHaveLength(3);
    for (const definition of definitions) {
      expect(definition).toMatchObject({
        retrievalMode: "context",
        args: { symbol: definition.expected.symbol },
        expected: { expectedRoute: "definition" },
      });
    }
  });

  it("prefers definition candidates from non-workflow paths", () => {
    const repoPath = "/repo";
    const sourceFile = (name: string): ParsedFile => {
      const symbol = path.basename(name).replace(/\.[^.]+$/, "").replace(/[^a-z]/gi, "");
      return {
        path: path.join(repoPath, name),
        hash: name,
        symbols: [],
        chunks: [{
          content: `export function ${symbol}() { return 1; }`,
          startLine: 1,
          endLine: 1,
          chunkType: "function",
          name: symbol,
          language: "typescript",
        }],
      };
    };

    const parsedFiles = [
      sourceFile(".github/workflows/release.sh"),
      sourceFile("src/alpha.ts"),
      sourceFile("src/beta.ts"),
      sourceFile("src/gamma.ts"),
      sourceFile("src/delta.ts"),
      sourceFile("src/epsilon.ts"),
      sourceFile("src/zeta.ts"),
      sourceFile("src/eta.ts"),
      sourceFile("src/theta.ts"),
      sourceFile("src/iota.ts"),
      sourceFile("src/__tests__/test-helper.ts"),
      sourceFile("src/fixtures/sample-fixture.ts"),
    ];

    const dataset = buildGoldenDataset("fixture", repoPath, parsedFiles);
    const definitionQueries = dataset.queries.filter((query) => query.queryType === "definition");

    expect(definitionQueries).toHaveLength(3);
    expect(definitionQueries.every((query) => !query.expected.filePath.startsWith(".github/workflows/"))).toBe(true);
    expect(definitionQueries.every((query) => !query.expected.filePath.includes("/__tests__/"))).toBe(true);
    expect(definitionQueries.every((query) => !query.expected.filePath.includes("/fixtures/"))).toBe(true);
    });

  it("fails when all definition candidates are in test or fixture paths", () => {
    const repoPath = "/repo";
    const parsedFiles = [
      {
        path: path.join(repoPath, "src/__tests__/alpha.test.ts"),
        hash: "alpha.test.ts",
        symbols: [],
        chunks: [{
          content: "export function testAlpha() { return 1; }",
          startLine: 1,
          endLine: 1,
          chunkType: "function",
          name: "testAlpha",
          language: "typescript",
        }],
      },
      {
        path: path.join(repoPath, "src/fixtures/beta.fixture.ts"),
        hash: "beta.fixture.ts",
        symbols: [],
        chunks: [{
          content: "export function fixtureBeta() { return 1; }",
          startLine: 1,
          endLine: 1,
          chunkType: "function",
          name: "fixtureBeta",
          language: "typescript",
        }],
      },
    ];

    expect(() => buildGoldenDataset("fixture", repoPath, parsedFiles)).toThrow(
      "No definition candidates outside unsupported CodeGraph source paths in fixture"
    );
  });

  it("fails when all definition candidates are in unsupported workflow paths", () => {
    const repoPath = "/repo";
    const parsedFiles = [
      {
        path: path.join(repoPath, ".github/workflows/release.sh"),
        hash: "release.sh",
        symbols: [],
        chunks: [{
          content: "export function workflowonly() { return 1; }",
          startLine: 1,
          endLine: 1,
          chunkType: "function",
          name: "workflowonly",
          language: "typescript",
        }],
      },
      {
        path: path.join(repoPath, ".github/workflows/check.sh"),
        hash: "check.sh",
        symbols: [],
        chunks: [{
          content: "export function workflowsubonly() { return 1; }",
          startLine: 1,
          endLine: 1,
          chunkType: "function",
          name: "workflowsubonly",
          language: "typescript",
        }],
      },
    ];

    expect(() => buildGoldenDataset("fixture", repoPath, parsedFiles)).toThrow(
      "No definition candidates outside unsupported CodeGraph source paths in fixture"
    );
  });

  it("uses a fresh isolated repo per repeat, exact pinned commands, strict scoped metrics, and raw artifacts", async () => {
    const repoPath = tempDir("cross-repo-cg-source-");
    const artifactRoot = tempDir("cross-repo-cg-artifacts-");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "a.ts"), "export function alpha() {}", "utf-8");
    fs.writeFileSync(path.join(repoPath, "src", "b.ts"), "export function beta() {}", "utf-8");
    const { dataset, pluginPerQuery } = fixture();
    const isolatedPaths: string[] = [];
    const executor = vi.fn(async (executable: string, args: string[]) => {
      expect(executable).toBe("npx");
      if (args[2] === "init") {
        isolatedPaths.push(args[3]!);
        expect(fs.existsSync(path.join(args[3]!, "src", "a.ts"))).toBe(true);
        return { stdout: "" };
      }
      const symbol = args[3]!;
      return {
        stdout: JSON.stringify([{
          node: {
            filePath: symbol === "alpha" ? "src/a.ts" : "src/b.ts",
            startLine: 1,
            endLine: 1,
            kind: "function",
            name: symbol,
          },
          score: 1,
        }]),
      };
    });

    const summaries = await Promise.all([1, 2].map((repeat) => runCodeGraphRepeat({
      repoPath,
      dataset,
      pluginPerQuery,
      repeat,
      artifactPath: path.join(artifactRoot, `repeat-${repeat}.json`),
      executor,
    })));

    expect(isolatedPaths).toHaveLength(2);
    expect(new Set(isolatedPaths).size).toBe(2);
    expect(isolatedPaths.every((isolatedPath) => !fs.existsSync(isolatedPath))).toBe(true);
    for (const isolatedPath of isolatedPaths) {
      expect(executor).toHaveBeenCalledWith("npx", [
        "--yes", "@colbymchenry/codegraph@1.5.0", "init", isolatedPath,
      ]);
      expect(executor).toHaveBeenCalledWith("npx", [
        "--yes", "@colbymchenry/codegraph@1.5.0", "query", "alpha",
        "--path", isolatedPath, "--limit", "10", "--json",
      ]);
      expect(executor).toHaveBeenCalledWith("npx", [
        "--yes", "@colbymchenry/codegraph@1.5.0", "query", "beta",
        "--path", isolatedPath, "--limit", "10", "--json",
      ]);
    }

    for (const summary of summaries) {
      expect(summary.status).toBe("completed");
      expect(summary.queryIds).toEqual(["symbol-hit", "symbol-miss"]);
      expect(summary.pluginMetrics?.hitAt1).toBe(0.5);
      expect(summary.codeGraphMetrics?.hitAt1).toBe(1);
      const artifact = JSON.parse(fs.readFileSync(summary.artifactPath, "utf-8")) as {
        scope: { totalQueryCount: number; scopedQueryCount: number; queryIds: string[] };
        pluginPerQuery: Array<{ id: string }>;
        queries: Array<{ id: string; results: unknown[]; perQuery: { id: string } }>;
        comparison: unknown;
      };
      expect(artifact.scope).toEqual({
        totalQueryCount: 3,
        scopedQueryCount: 2,
        queryIds: ["symbol-hit", "symbol-miss"],
      });
      expect(artifact.pluginPerQuery.map((item) => item.id)).toEqual(["symbol-hit", "symbol-miss"]);
      expect(artifact.queries.map((item) => item.id)).toEqual(["symbol-hit", "symbol-miss"]);
      expect(artifact.queries.every((item) => item.results.length === 1 && item.perQuery.id === item.id)).toBe(true);
      expect(artifact.comparison).toBeDefined();
    }

    const pluginMetrics = computeEvalMetrics(dataset.queries, pluginPerQuery, 0, 0, 0);
    const report = buildReportMarkdown("2026-08-04T00:00:00.000Z", cliOptions(repoPath), "run", [{
      repoName: "fixture",
      repoPath,
      datasetPath: "dataset.json",
      datasetQueryCount: dataset.queries.length,
      fileSampling: { parsedFileCount: 2, truncated: false, maxParseFiles: 10, fileSizeLimitBytes: 1_000_000 },
      plugin: {
        outputDir: "plugin",
        summaryPath: "summary.json",
        perQueryPath: "per-query.json",
        metrics: pluginMetrics,
        repeatSummaries: [],
      },
      codegraph: {
        scopedQueryCount: 2,
        totalQueryCount: 3,
        successfulRepeatCount: 2,
        disqualifiedRepeatCount: 0,
        repeatSummaries: summaries,
        metrics: {
          plugin: summaries[0]!.pluginMetrics!,
          codegraph: summaries[0]!.codeGraphMetrics!,
        },
      },
    }]);
    const fairSection = report.split("## Fair CodeGraph Comparator")[1]!;
    expect(fairSection).toContain("| Metric | Plugin | CodeGraph |");
    expect(fairSection).not.toContain("| Ripgrep |");
    expect(fairSection).not.toContain("ast-grep");
  });

  it("disqualifies invocation failures without zero-scoring and keeps CodeGraph out of general tables", async () => {
    const repoPath = tempDir("cross-repo-cg-failure-");
    const artifactPath = path.join(tempDir("cross-repo-cg-failure-artifact-"), "repeat-1.json");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "a.ts"), "export function alpha() {}", "utf-8");
    const { dataset, pluginPerQuery } = fixture();
    const executor = vi.fn(async (_executable: string, args: string[]) => {
      if (args[2] === "init") return { stdout: "" };
      throw new Error("query process exited 1");
    });

    const summary = await runCodeGraphRepeat({
      repoPath,
      dataset,
      pluginPerQuery,
      repeat: 1,
      artifactPath,
      executor,
    });

    expect(summary.status).toBe("disqualified");
    expect(summary.pluginMetrics).toBeUndefined();
    expect(summary.codeGraphMetrics).toBeUndefined();
    expect(summary.error).toContain("query process exited 1");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as {
      status: string;
      error: string;
      queries: Array<{ id: string; error: string }>;
      comparison?: unknown;
    };
    expect(artifact.status).toBe("disqualified");
    expect(artifact.queries[0]).toMatchObject({ id: "symbol-hit", error: "query process exited 1" });
    expect(artifact.comparison).toBeUndefined();

    const pluginMetrics = computeEvalMetrics(dataset.queries, pluginPerQuery, 0, 0, 0);
    const repoResult: RepoBenchmarkResult = {
      repoName: "fixture",
      repoPath,
      datasetPath: "dataset.json",
      datasetQueryCount: dataset.queries.length,
      fileSampling: {
        parsedFileCount: 2,
        truncated: false,
        maxParseFiles: 10,
        fileSizeLimitBytes: 1_000_000,
      },
      plugin: {
        outputDir: "plugin",
        summaryPath: "summary.json",
        perQueryPath: "per-query.json",
        metrics: pluginMetrics,
        repeatSummaries: [],
      },
      codegraph: {
        scopedQueryCount: summary.scopedQueryCount,
        totalQueryCount: summary.totalQueryCount,
        successfulRepeatCount: 0,
        disqualifiedRepeatCount: 1,
        repeatSummaries: [summary],
      },
    };
    const report = buildReportMarkdown("2026-08-04T00:00:00.000Z", cliOptions(repoPath), "run", [repoResult]);
    const [generalTables, fairSection] = report.split("## Fair CodeGraph Comparator");

    expect(generalTables).not.toContain("CodeGraph |");
    expect(fairSection).toContain("Repeat 1: No comparison result");
    expect(fairSection).toContain("No comparison result: no CodeGraph repeat completed successfully.");
  });

  it("disqualifies and records init invocation failures", async () => {
    const repoPath = tempDir("cross-repo-cg-init-failure-");
    const artifactPath = path.join(tempDir("cross-repo-cg-init-artifact-"), "repeat-1.json");
    const { dataset, pluginPerQuery } = fixture();
    const summary = await runCodeGraphRepeat({
      repoPath,
      dataset,
      pluginPerQuery,
      repeat: 1,
      artifactPath,
      executor: vi.fn(async () => {
        throw new Error("init process exited 1");
      }),
    });

    expect(summary).toMatchObject({
      status: "disqualified",
      pluginMetrics: undefined,
      codeGraphMetrics: undefined,
    });
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as {
      init: { command: string[]; error: string };
      queries: unknown[];
      comparison?: unknown;
    };
    expect(artifact.init.command).toEqual([
      "npx", "--yes", "@colbymchenry/codegraph@1.5.0", "init", expect.any(String),
    ]);
    expect(artifact.init.error).toBe("init process exited 1");
    expect(artifact.queries).toEqual([]);
    expect(artifact.comparison).toBeUndefined();
  });

  it("uses a generated eval config artifact with hard-coded index caps and passes it to plugin run options", () => {
    const repoPath = tempDir("cross-repo-eval-config-run-repo-");
    const runDir = tempDir("cross-repo-eval-config-run-artifacts-");
    const homeDir = tempDir("cross-repo-eval-config-home-");

    const hostileHome = process.env.HOME;
    const controlledHome = path.join(homeDir, "user-home");
    process.env.HOME = controlledHome;

    try {
      const globalConfigPath = path.join(controlledHome, ".config", "opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(
        globalConfigPath,
        JSON.stringify({
          indexing: {
            maxFileSize: 12_345,
            maxChunksPerFile: 7,
          },
        }, null, 2),
        "utf-8"
      );

      const configPath = writeControlledEvalConfig(controlledEvalConfigPath(runDir, "fixture"));
      const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
        indexing?: {
          maxFileSize?: number;
          maxChunksPerFile?: number;
        };
      };

      expect(path.dirname(configPath)).toBe(path.join(runDir, "eval-configs"));
      expect(rawConfig).toEqual({
        indexing: {
          maxFileSize: MAX_FILE_SIZE_BYTES,
          maxChunksPerFile: 100,
        },
      });

      const runOptions = buildPluginEvalRunOptions({
        projectRoot: repoPath,
        datasetPath: "datasets/fixture.json",
        outputRoot: "plugin",
        reindexApplied: false,
        configPath,
      });

      expect(runOptions).toEqual({
        projectRoot: repoPath,
        datasetPath: "datasets/fixture.json",
        outputRoot: "plugin",
        ciMode: false,
        reindex: false,
        configPath,
      });
      expect(runOptions.configPath).toBe(configPath);
    } finally {
      process.env.HOME = hostileHome;
    }
  });
});
