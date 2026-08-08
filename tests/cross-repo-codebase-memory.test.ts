import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPerQueryResult, computeEvalMetrics } from "../src/eval/metrics.js";
import type { GoldenDataset, GoldenQuery, PerQueryEvalResult } from "../src/eval/types.js";
import {
  buildReportMarkdown,
  parseCliArgs,
  parseCodebaseMemoryMcpInitOutput,
  parseCodebaseMemoryMcpQueryOutput,
  runCodebaseMemoryMcpRepeat,
  type CliOptions,
  type RepoBenchmarkResult,
} from "../scripts/cross-repo-benchmark.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function definitionQuery(id: string, filePath: string, symbol?: string): GoldenQuery {
  return {
    id,
    query: symbol ? `where is ${symbol} defined` : `find ${id}`,
    queryType: "definition",
    expected: { filePath, ...(symbol ? { symbol } : {}) },
  };
}

function pluginResult(query: GoldenQuery, filePath: string, name?: string): PerQueryEvalResult {
  return buildPerQueryResult(query, [{
    filePath,
    startLine: 1,
    endLine: 2,
    score: 1,
    chunkType: "function",
    name,
  }], 5, 10);
}

function cliOptions(repoPath: string, enabled: boolean): CliOptions {
  return {
    repos: [repoPath],
    outputRoot: repoPath,
    reindex: false,
    repeats: 1,
    maxParseFiles: 10,
    persistDatasets: false,
    skipRipgrep: true,
    skipSg: true,
    codegraph: false,
    codebaseMemoryMcp: enabled,
  };
}

describe("cross-repo codebase-memory-mcp comparator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const directory = tempDirs.pop();
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("strictly parses init and query output into ranked file-level candidates", () => {
    const isolatedRepoPath = tempDir("cross-repo-memory-parse-");
    const init = parseCodebaseMemoryMcpInitOutput(JSON.stringify({ project: "project-123", extra: true }));

    expect(init.project).toBe("project-123");
    expect(init.resultJson).toEqual({ project: "project-123", extra: true });

    const query = parseCodebaseMemoryMcpQueryOutput(JSON.stringify({
      total: 2,
      results: [
        {
          name: "alpha",
          file_path: "src/a.ts",
          label: "function",
          lines: [10, 20],
          extra: "preserved in raw JSON",
        },
        {
          name: "alpha",
          file_path: "src/b.ts",
          label: "method",
          lines: { preview: "export function alpha() {}" },
        },
      ],
    }), isolatedRepoPath);

    expect(query.total).toBe(2);
    expect(query.results).toEqual([
      {
        name: "alpha",
        filePath: "src/a.ts",
        label: "function",
        lines: [10, 20],
        score: 1,
      },
      {
        name: "alpha",
        filePath: "src/b.ts",
        label: "method",
        lines: { preview: "export function alpha() {}" },
        score: 0.5,
      },
    ]);
    expect(query.results.every((result) => !("startLine" in result) && !("endLine" in result))).toBe(true);
    expect(query.resultJson.total).toBe(2);
    expect((query.resultJson.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      extra: "preserved in raw JSON",
    });
  });

  it("rejects malformed init and query response shapes", () => {
    for (const output of ["not-json", "[]", "{}", JSON.stringify({ project: "" })]) {
      expect(() => parseCodebaseMemoryMcpInitOutput(output)).toThrow(/Malformed codebase-memory-mcp init output/);
    }

    const isolatedRepoPath = tempDir("cross-repo-memory-malformed-");
    const malformed = [
      "not-json",
      "[]",
      JSON.stringify({ results: [] }),
      JSON.stringify({ total: -1, results: [] }),
      JSON.stringify({ total: 0, results: {} }),
      JSON.stringify({ total: 0, results: [{}] }),
      JSON.stringify({ total: 1, results: [{ name: "alpha", file_path: "src/a.ts", label: "function" }] }),
      JSON.stringify({ total: 0, results: [{ name: "alpha", file_path: "src/a.ts", label: "function", lines: [] }] }),
    ];

    for (const output of malformed) {
      expect(() => parseCodebaseMemoryMcpQueryOutput(output, isolatedRepoPath)).toThrow(
        /Malformed codebase-memory-mcp query output/,
      );
    }
  });

  it("rejects result paths that escape the isolated repository", () => {
    const isolatedRepoPath = tempDir("cross-repo-memory-path-");
    const result = (filePath: string): string => JSON.stringify({
      total: 1,
      results: [{ name: "alpha", file_path: filePath, label: "function", lines: [] }],
    });

    expect(() => parseCodebaseMemoryMcpQueryOutput(result("../outside.ts"), isolatedRepoPath)).toThrow(
      /outside isolated repo/,
    );
    expect(() => parseCodebaseMemoryMcpQueryOutput(result("..\\outside.ts"), isolatedRepoPath)).toThrow(
      /outside isolated repo/,
    );
    expect(() => parseCodebaseMemoryMcpQueryOutput(
      result(path.join(os.tmpdir(), "outside.ts")),
      isolatedRepoPath,
    )).toThrow(/outside isolated repo/);
  });

  it("uses the pinned CLI contract, one isolated copy, definition-only scope, and raw artifacts", async () => {
    const repoPath = tempDir("cross-repo-memory-source-");
    const artifactPath = path.join(tempDir("cross-repo-memory-artifacts-"), "repeat-1.json");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "a.ts"), "export function alpha() {}", "utf-8");

    const scoped = definitionQuery("definition", "src/a.ts", "alpha.value");
    const symbolButNotDefinition: GoldenQuery = {
      id: "implementation",
      query: "how is ignored implemented",
      queryType: "implementation-intent",
      expected: { filePath: "src/a.ts", symbol: "ignored" },
    };
    const noSymbol = definitionQuery("no-symbol", "src/a.ts");
    const dataset: GoldenDataset = {
      version: "1",
      name: "memory-fixture",
      queries: [scoped, symbolButNotDefinition, noSymbol],
    };
    const pluginPerQuery = [
      pluginResult(scoped, "src/a.ts", "alpha.value"),
      pluginResult(symbolButNotDefinition, "src/a.ts", "ignored"),
      pluginResult(noSymbol, "src/a.ts"),
    ];
    let isolatedRepoPath = "";
    const executor = vi.fn(async (
      executable: string,
      args: string[],
      options?: { env: NodeJS.ProcessEnv },
    ) => {
      expect(executable).toBe("npx");
      if (args[3] === "index_repository") {
        const payload = JSON.parse(args[4]!) as { repo_path: string };
        isolatedRepoPath = payload.repo_path;
        expect(options?.env.CBM_CACHE_DIR).toBe(
          path.join(isolatedRepoPath, ".codebase-memory-mcp-cache"),
        );
        expect(fs.existsSync(path.join(isolatedRepoPath, "src/a.ts"))).toBe(true);
        return { stdout: JSON.stringify({ project: "memory-project" }) };
      }

      expect(options?.env.CBM_CACHE_DIR).toBe(
        path.join(isolatedRepoPath, ".codebase-memory-mcp-cache"),
      );
      const payload = JSON.parse(args[4]!) as { project: string; name_pattern: string };
      expect(payload).toEqual({ project: "memory-project", name_pattern: "^alpha\\.value$" });
      return {
        stdout: JSON.stringify({
          total: 1,
          results: [{
            name: "alpha.value",
            file_path: "src/a.ts",
            label: "function",
            lines: [1, 1],
          }],
        }),
      };
    });

    const summary = await runCodebaseMemoryMcpRepeat({
      repoPath,
      dataset,
      pluginPerQuery,
      repeat: 1,
      artifactPath,
      executor,
    });

    expect(summary.status).toBe("completed");
    expect(summary.queryIds).toEqual(["definition"]);
    expect(summary.codebaseMemoryMcpMetrics?.hitAt1).toBe(1);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenNthCalledWith(1, "npx", [
      "--yes",
      "codebase-memory-mcp@0.8.1",
      "cli",
      "index_repository",
      JSON.stringify({ repo_path: isolatedRepoPath }),
    ], expect.objectContaining({
      env: expect.objectContaining({
        CBM_CACHE_DIR: path.join(isolatedRepoPath, ".codebase-memory-mcp-cache"),
      }),
    }));
    expect(executor).toHaveBeenNthCalledWith(2, "npx", [
      "--yes",
      "codebase-memory-mcp@0.8.1",
      "cli",
      "search_graph",
      JSON.stringify({ project: "memory-project", name_pattern: "^alpha\\.value$" }),
    ], expect.objectContaining({
      env: expect.objectContaining({
        CBM_CACHE_DIR: path.join(isolatedRepoPath, ".codebase-memory-mcp-cache"),
      }),
    }));
    expect(fs.existsSync(isolatedRepoPath)).toBe(false);

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as {
      cacheDir: string;
      init: { command: string[]; stdout: string; resultJson: unknown; project: string };
      scope: { queryIds: string[]; scopedQueryCount: number; totalQueryCount: number };
      queries: Array<{
        command: string[];
        stdout: string;
        resultJson: unknown;
        results: Array<Record<string, unknown>>;
        perQuery: { results: Array<Record<string, unknown>> };
      }>;
    };
    expect(artifact.init).toMatchObject({
      project: "memory-project",
      resultJson: { project: "memory-project" },
    });
    expect(artifact.init.stdout).toBe(JSON.stringify({ project: "memory-project" }));
    expect(artifact.cacheDir).toBe(path.join(isolatedRepoPath, ".codebase-memory-mcp-cache"));
    expect(artifact.scope).toEqual({ queryIds: ["definition"], scopedQueryCount: 1, totalQueryCount: 3 });
    expect(artifact.queries).toHaveLength(1);
    expect(artifact.queries[0]!.resultJson).toMatchObject({ total: 1 });
    expect(artifact.queries[0]!.results[0]).not.toHaveProperty("startLine");
    expect(artifact.queries[0]!.results[0]).not.toHaveProperty("endLine");
    expect(artifact.queries[0]!.perQuery.results[0]).not.toHaveProperty("startLine");
    expect(artifact.queries[0]!.perQuery.results[0]).not.toHaveProperty("endLine");
  });

  it("disqualifies invocation failures without zero-scoring", async () => {
    const repoPath = tempDir("cross-repo-memory-failure-");
    const artifactPath = path.join(tempDir("cross-repo-memory-failure-artifacts-"), "repeat-1.json");
    const query = definitionQuery("definition", "src/a.ts", "alpha");
    const dataset: GoldenDataset = { version: "1", name: "failure", queries: [query] };
    const executor = vi.fn(async (_executable: string, args: string[]) => {
      if (args[3] === "index_repository") {
        return { stdout: JSON.stringify({ project: "memory-project" }) };
      }
      throw new Error("query process exited 1");
    });

    const summary = await runCodebaseMemoryMcpRepeat({
      repoPath,
      dataset,
      pluginPerQuery: [pluginResult(query, "src/a.ts", "alpha")],
      repeat: 1,
      artifactPath,
      executor,
    });

    expect(summary).toMatchObject({
      status: "disqualified",
      pluginMetrics: undefined,
      codebaseMemoryMcpMetrics: undefined,
    });
    expect(summary.error).toContain("query process exited 1");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as {
      status: string;
      error: string;
      queries: Array<{ error: string }>;
      comparison?: unknown;
    };
    expect(artifact.status).toBe("disqualified");
    expect(artifact.queries[0]!.error).toBe("query process exited 1");
    expect(artifact.comparison).toBeUndefined();
  });

  it("records no-scope without creating an isolated copy or invoking npx", async () => {
    const repoPath = tempDir("cross-repo-memory-no-scope-");
    const artifactPath = path.join(tempDir("cross-repo-memory-no-scope-artifacts-"), "repeat-1.json");
    const dataset: GoldenDataset = {
      version: "1",
      name: "no-scope",
      queries: [definitionQuery("no-symbol", "src/a.ts")],
    };
    const executor = vi.fn(async () => {
      throw new Error("executor must not be called");
    });

    const summary = await runCodebaseMemoryMcpRepeat({
      repoPath,
      dataset,
      pluginPerQuery: [],
      repeat: 1,
      artifactPath,
      executor,
    });

    expect(summary).toMatchObject({
      status: "no-scope",
      scopedQueryCount: 0,
      totalQueryCount: 1,
      queryIds: [],
    });
    expect(executor).not.toHaveBeenCalled();
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as {
      status: string;
      isolatedRepoPath?: string;
      cacheDir?: string;
      init: { command: string[] };
      queries: unknown[];
    };
    expect(artifact).toMatchObject({
      status: "no-scope",
      init: { command: [] },
      queries: [],
    });
    expect(artifact.isolatedRepoPath).toBeUndefined();
    expect(artifact.cacheDir).toBeUndefined();
  });

  it("is opt-in and renders a standalone per-repo and aggregate report section", () => {
    const repoPath = tempDir("cross-repo-memory-report-");
    expect(parseCliArgs(["--repos", repoPath]).codebaseMemoryMcp).toBe(false);
    expect(parseCliArgs(["--repos", repoPath, "--codebase-memory-mcp"]).codebaseMemoryMcp).toBe(true);

    const query = definitionQuery("definition", "src/a.ts", "alpha");
    const perQuery = pluginResult(query, "src/a.ts", "alpha");
    const metrics = computeEvalMetrics([query], [perQuery], 0, 0, 0);
    const result: RepoBenchmarkResult = {
      repoName: "fixture",
      repoPath,
      datasetPath: "dataset.json",
      datasetQueryCount: 1,
      fileSampling: {
        parsedFileCount: 1,
        truncated: false,
        maxParseFiles: 10,
        fileSizeLimitBytes: 1_000_000,
      },
      plugin: {
        outputDir: "plugin",
        summaryPath: "summary.json",
        perQueryPath: "per-query.json",
        metrics,
        repeatSummaries: [],
      },
      codebaseMemoryMcp: {
        scopedQueryCount: 1,
        totalQueryCount: 1,
        successfulRepeatCount: 1,
        disqualifiedRepeatCount: 0,
        repeatSummaries: [],
        metrics: { plugin: metrics, codebaseMemoryMcp: metrics },
      },
    };

    const disabledReport = buildReportMarkdown(
      "2026-08-08T00:00:00.000Z",
      cliOptions(repoPath, false),
      "run",
      [result],
    );
    expect(disabledReport).not.toContain("## Fair codebase-memory-mcp Comparator");

    const report = buildReportMarkdown(
      "2026-08-08T00:00:00.000Z",
      cliOptions(repoPath, true),
      "run",
      [result],
    );
    const [generalReport, fairSection] = report.split("## Fair codebase-memory-mcp Comparator");
    expect(generalReport).not.toContain("| codebase-memory-mcp |");
    expect(fairSection).toContain("### fixture");
    expect(fairSection).toContain("### Aggregate fair comparison");
    expect(fairSection).toContain("| Metric | Plugin | codebase-memory-mcp |");
    expect(fairSection).toContain("Latency is omitted in this comparator");
    expect(fairSection).not.toContain("| Latency p50 (ms) |");
  });
});
