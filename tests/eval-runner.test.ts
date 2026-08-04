import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEvaluation, runSweep } from "../src/eval/runner.js";
import * as operationRuntime from "../src/tools/operation-runtime.js";

describe("eval runner", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        return {
          embedding: Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997),
        };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-runner-"));
    mkdirSync(path.join(tempDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(tempDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "budgets"), { recursive: true });
    mkdirSync(path.join(tempDir, "benchmarks", "baselines"), { recursive: true });

    writeFileSync(
      path.join(tempDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(tempDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              retrievalMode: "context",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs eval and writes required artifacts", async () => {
    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(result.summary.queryCount).toBe(1);
    expect(result.summary.datasetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.perQuery[0]?.resolvedRoute).toBe("definition");
    expect(result.perQuery[0]?.routedQuery).toBe("rankHybridResults");
    expect(typeof result.summary.metrics.distinctTop3Ratio).toBe("number");
    expect(typeof result.summary.metrics.rawDistinctTop3Ratio).toBe("number");
    expect(result.perQuery[0]?.tokenBudget).toBe(1200);
    expect(result.perQuery[0]?.responseTokens).toBeGreaterThan(0);
    expect(result.summary.metrics.contextEfficiency.queryCount).toBe(1);
    expect(result.summary.metrics.contextEfficiency.responseTokens.p95).toBeLessThanOrEqual(1200);
    expect(readFileSync(path.join(result.outputDir, "summary.json"), "utf-8")).toContain("\"metrics\"");
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8")).toContain("Distinct Top@3");
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8")).toContain("Raw Distinct Top@3");
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8")).toContain("Context response tokens max");
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8")).toContain("# Evaluation Summary");
    expect(readFileSync(path.join(result.outputDir, "per-query.json"), "utf-8")).toContain("\"queries\"");

    const repeatRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(repeatRun.summary.datasetFingerprint).toBe(result.summary.datasetFingerprint);
  });

  it("evaluates edit-context targets and only scores published graph neighbors when expected", async () => {
    writeFileSync(
      path.join(tempDir, "src", "indexer", "index.ts"),
      [
        "export function rankHybridResults(query: string) { return query.length; }",
        "export function evaluateRanking() { return rankHybridResults('query'); }",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "edit-context.json"),
      JSON.stringify({
        version: "1.0.0",
        name: "edit-context",
        queries: [
          {
            id: "with-neighbor",
            query: "change rankHybridResults behavior",
            queryType: "definition",
            retrievalMode: "edit-context",
            args: {
              symbol: "rankHybridResults",
              filePath: "src/indexer/index.ts",
              tokenBudget: 512,
            },
            expected: {
              filePath: "src/indexer/index.ts",
              symbol: "rankHybridResults",
              graphNeighbor: {
                direction: "caller",
                filePath: "src/indexer/index.ts",
                symbol: "evaluateRanking",
              },
            },
          },
          {
            id: "target-only",
            query: "review rankHybridResults before editing",
            queryType: "definition",
            retrievalMode: "edit-context",
            args: {
              symbol: "rankHybridResults",
              filePath: "src/indexer/index.ts",
              tokenBudget: 512,
            },
            expected: {
              filePath: "src/indexer/index.ts",
              symbol: "rankHybridResults",
            },
          },
        ],
      }, null, 2),
      "utf-8",
    );

    const runtimeCacheSpy = vi.spyOn(operationRuntime, "getIndexerForProject");
    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/edit-context.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(runtimeCacheSpy).not.toHaveBeenCalled();
    runtimeCacheSpy.mockRestore();
    const withNeighbor = result.perQuery.find((query) => query.id === "with-neighbor");
    const targetOnly = result.perQuery.find((query) => query.id === "target-only");
    expect(withNeighbor).toMatchObject({
      retrievalMode: "edit-context",
      resolvedRoute: "definition",
      routedQuery: "rankHybridResults",
      hitAt1: true,
      graphNeighborMatched: true,
      tokenBudget: 512,
    });
    expect(withNeighbor?.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "rankHybridResults" }),
      expect.objectContaining({ name: "evaluateRanking", graphDirection: "caller" }),
    ]));
    expect(withNeighbor?.responseTokens).toBeLessThanOrEqual(512);
    expect(targetOnly?.graphNeighborMatched).toBeUndefined();
    expect(targetOnly?.results.every((item) => item.graphDirection === undefined)).toBe(true);
    expect(result.summary.metrics.graphNeighborRecall).toBe(1);
    expect(result.summary.metrics.contextEfficiency.queryCount).toBe(2);
    expect(readFileSync(path.join(result.outputDir, "summary.md"), "utf-8"))
      .toContain("Graph-neighbor recall");
  });

  it("fails fast when reindexing produces no searchable vectors", async () => {
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ data: [], usage: { total_tokens: 0 } }),
      { status: 200 },
    ));

    const configPath = path.join(tempDir, ".opencode", "codebase-index.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    config.indexing = {
      watchFiles: false,
      retries: 0,
      retryDelayMs: 0,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "empty-index.json"),
      JSON.stringify({
        name: "empty-index",
        failOnMissingBaseline: false,
        thresholds: {},
      }),
      "utf-8",
    );

    await expect(runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: true,
      reindex: true,
      budgetPath: "benchmarks/budgets/empty-index.json",
    })).rejects.toThrow(/Evaluation reindex produced no searchable vectors/);
  });

  it("fails fast in sweep mode when reindexing produces no searchable vectors", async () => {
    fetchSpy.mockResolvedValue(new Response(
      JSON.stringify({ data: [], usage: { total_tokens: 0 } }),
      { status: 200 },
    ));

    const configPath = path.join(tempDir, "benchmarks", "budgets", "empty-index-sweep.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "empty-index-sweep",
        failOnMissingBaseline: false,
        thresholds: {},
      }, null, 2),
      "utf-8",
    );

    await expect(runSweep(
      {
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: true,
        budgetPath: "benchmarks/budgets/empty-index-sweep.json",
        reindex: true,
      },
      {
        fusionStrategy: ["rrf", "weighted"],
      }
    )).rejects.toThrow(/Evaluation reindex produced no searchable vectors/);
  });

  it("applies query args as search filters in search mode", async () => {
    const datasetPath = path.join(tempDir, "benchmarks", "golden", "args-search.json");
    writeFileSync(
      datasetPath,
      JSON.stringify(
        {
          version: "1.0.0",
          name: "args-search",
          queries: [
            {
              id: "q-search",
              query: "codebase_search",
              queryType: "keyword-heavy",
              retrievalMode: "search",
              language: "typescript",
              difficulty: "easy",
              tags: ["filters", "search"],
              args: {
                fileType: "ts",
                directory: "src/tools",
              },
              expected: {
                filePath: "src/tools/index.ts",
                expectedOutcome: "results",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/args-search.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(result.perQuery).toHaveLength(1);
    expect(result.perQuery[0]?.results[0]?.filePath).toContain("src/tools/index.ts");
    expect(result.perQuery[0]?.failureBucket).toBeUndefined();
  });

  it("records metadata and recovery outcome for context queries", async () => {
    const datasetPath = path.join(tempDir, "benchmarks", "golden", "args-context.json");
    writeFileSync(
      datasetPath,
      JSON.stringify(
        {
          version: "1.0.0",
          name: "args-context",
          queries: [
            {
              id: "q-context",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              retrievalMode: "context",
              language: "typescript",
              difficulty: "medium",
              tags: ["context", "filters"],
              args: {
                symbol: "rankHybridResults",
                fileType: "ts",
                directory: "src/indexer",
              },
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
                expectedRoute: "definition",
                expectedOutcome: "results",
                recoveryExpectation: "none",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/args-context.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(result.perQuery).toHaveLength(1);
    expect(result.perQuery[0]?.language).toBe("typescript");
    expect(result.perQuery[0]?.difficulty).toBe("medium");
    expect(result.perQuery[0]?.tags).toEqual(["context", "filters"]);
    expect(result.perQuery[0]?.routeMatched).toBe(true);
    expect(result.perQuery[0]?.recoveryMatched).toBe(true);
  });

  it("does not delete an inherited main-repo project index when reindexing from a fresh worktree", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "budgets"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "baselines"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(path.join(mainRepoDir, ".opencode", "index", "sentinel.txt"), "keep-me", "utf-8");
    writeFileSync(
      path.join(mainRepoDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await runEvaluation({
      projectRoot: worktreeDir,
      datasetPath: path.relative(worktreeDir, path.join(mainRepoDir, "benchmarks", "golden", "small.json")),
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    expect(readFileSync(path.join(mainRepoDir, ".opencode", "index", "sentinel.txt"), "utf-8")).toBe("keep-me");
  });

  it("creates a local eval config boundary when reindexing from a fallback worktree", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "docs", "reference"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: ["docs/reference"],
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(mainRepoDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await runEvaluation({
      projectRoot: worktreeDir,
      datasetPath: path.relative(worktreeDir, path.join(mainRepoDir, "benchmarks", "golden", "small.json")),
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    const localEvalConfig = JSON.parse(
      readFileSync(path.join(worktreeDir, ".opencode", "codebase-index.json"), "utf-8")
    ) as {
      additionalInclude?: string[];
      knowledgeBases?: string[];
      customProvider?: { model?: string };
    };

    expect(localEvalConfig.customProvider?.model).toBe("mock-embedding-model");
    expect(localEvalConfig.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(localEvalConfig.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("creates a local eval config boundary when reindexing with an explicit config path", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "docs", "reference"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const externalConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    writeFileSync(
      externalConfigPath,
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: ["docs/reference"],
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(mainRepoDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                symbol: "rankHybridResults",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await runEvaluation({
      projectRoot: worktreeDir,
      configPath: path.relative(worktreeDir, externalConfigPath),
      datasetPath: path.relative(worktreeDir, path.join(mainRepoDir, "benchmarks", "golden", "small.json")),
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    const localEvalConfig = JSON.parse(
      readFileSync(path.join(worktreeDir, ".opencode", "codebase-index.json"), "utf-8")
    ) as {
      additionalInclude?: string[];
      knowledgeBases?: string[];
      customProvider?: { model?: string };
    };

    expect(localEvalConfig.customProvider?.model).toBe("mock-embedding-model");
    expect(localEvalConfig.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(localEvalConfig.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("resolves relative knowledge bases from an arbitrary explicit config path during eval reindex", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
    const configDir = path.join(mainRepoDir, "config");
    const externalKbDir = path.join(mainRepoDir, "external-kb");
    const externalConfigPath = path.join(configDir, "eval-config.json");

    mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(externalKbDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    writeFileSync(
      externalConfigPath,
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["../docs/**/*.md"],
          knowledgeBases: ["../external-kb"],
          search: {
            maxResults: 10,
            minScore: 0,
            fusionStrategy: "rrf",
            rrfK: 60,
            rerankTopN: 20,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(mainRepoDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );
    writeFileSync(
      path.join(externalKbDir, "guide.ts"),
      "export function externalKbSymbol() { return 'kb'; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is externalKbSymbol implementation",
              queryType: "definition",
              expected: {
                filePath: "external-kb/guide.ts",
                symbol: "externalKbSymbol",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: worktreeDir,
      configPath: path.relative(worktreeDir, externalConfigPath),
      datasetPath: path.relative(worktreeDir, path.join(mainRepoDir, "benchmarks", "golden", "small.json")),
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    expect(result.perQuery).toHaveLength(1);
    expect(result.perQuery[0]?.hitAt10).toBe(true);
    expect(result.perQuery[0]?.failureBucket).toBeUndefined();

    const localEvalConfig = JSON.parse(
      readFileSync(path.join(worktreeDir, ".opencode", "codebase-index.json"), "utf-8")
    ) as {
      additionalInclude?: string[];
      knowledgeBases?: string[];
    };

    expect(localEvalConfig.additionalInclude).toEqual(["../main-repo/docs/**/*.md"]);
    expect(localEvalConfig.knowledgeBases).toEqual(["../main-repo/external-kb"]);
  });

  it("includes the baseline path when eval summary JSON is malformed", async () => {
    const brokenBaselinePath = path.join(tempDir, "benchmarks", "baselines", "broken-summary.json");
    writeFileSync(brokenBaselinePath, '{"generatedAt":"2026-01-01T00:00:00.000Z",', "utf-8");

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        againstPath: path.relative(tempDir, brokenBaselinePath),
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(new RegExp(`Failed to parse eval summary JSON at ${brokenBaselinePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("preserves summary validation errors for valid JSON baselines", async () => {
    const invalidBaselinePath = path.join(tempDir, "benchmarks", "baselines", "invalid-summary.json");
    writeFileSync(
      invalidBaselinePath,
      JSON.stringify(
        {
          generatedAt: "2026-01-01T00:00:00.000Z",
          datasetName: "small",
          datasetVersion: "1.0.0",
          queryCount: 1,
          searchConfig: {
            fusionStrategy: "rrf",
            hybridWeight: 0.5,
            rrfK: 60,
            rerankTopN: 20,
          },
          metrics: {
            hitAt1: "bad",
            hitAt3: 1,
            hitAt5: 1,
            hitAt10: 1,
            mrrAt10: 1,
            ndcgAt10: 1,
            distinctTop3Ratio: 1,
            rawDistinctTop3Ratio: 1,
            latencyMs: { p50: 1, p95: 1, p99: 1 },
            embedding: { callCount: 1, estimatedCostUsd: 0 },
            tokenEstimate: { embeddingTokensUsed: 1 },
            failureBuckets: {
              "wrong-file": 0,
              "wrong-symbol": 0,
              "docs-tests-outranking-source": 0,
              "no-relevant-hit-top-k": 0,
            },
          },
          perQuery: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        againstPath: path.relative(tempDir, invalidBaselinePath),
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(new RegExp(`${invalidBaselinePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.metrics\\.hitAt1 must be a finite number`));
  });

  it("rematerializes the local eval config when repeated reindex runs use different explicit config paths", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
    const configDir = path.join(mainRepoDir, "config");
    const kbOneDir = path.join(mainRepoDir, "kb-one");
    const kbTwoDir = path.join(mainRepoDir, "kb-two");
    const configOnePath = path.join(configDir, "eval-config-one.json");
    const configTwoPath = path.join(configDir, "eval-config-two.json");

    mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "indexer"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "src", "tools"), { recursive: true });
    mkdirSync(path.join(mainRepoDir, "benchmarks", "golden"), { recursive: true });
    mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(kbOneDir, { recursive: true });
    mkdirSync(kbTwoDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });

    writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const baseConfig = {
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    };

    writeFileSync(configOnePath, JSON.stringify({ ...baseConfig, knowledgeBases: ["../kb-one"] }, null, 2), "utf-8");
    writeFileSync(configTwoPath, JSON.stringify({ ...baseConfig, knowledgeBases: ["../kb-two"] }, null, 2), "utf-8");

    writeFileSync(
      path.join(mainRepoDir, "src", "indexer", "index.ts"),
      "export function rankHybridResults(query: string) { return query.length; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "src", "tools", "index.ts"),
      "export const codebase_search = () => 'ok';\n",
      "utf-8"
    );
    writeFileSync(
      path.join(kbOneDir, "guide.ts"),
      "export function kbOneSymbol() { return 'one'; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(kbTwoDir, "guide.ts"),
      "export function kbTwoSymbol() { return 'two'; }\n",
      "utf-8"
    );
    writeFileSync(
      path.join(mainRepoDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where is kbTwoSymbol implementation",
              queryType: "definition",
              expected: {
                filePath: "kb-two/guide.ts",
                symbol: "kbTwoSymbol",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await runEvaluation({
      projectRoot: worktreeDir,
      configPath: path.relative(worktreeDir, configOnePath),
      datasetPath: path.relative(worktreeDir, path.join(mainRepoDir, "benchmarks", "golden", "small.json")),
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    const secondRun = await runEvaluation({
      projectRoot: worktreeDir,
      configPath: path.relative(worktreeDir, configTwoPath),
      datasetPath: path.relative(worktreeDir, path.join(mainRepoDir, "benchmarks", "golden", "small.json")),
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: true,
    });

    expect(secondRun.perQuery).toHaveLength(1);
    expect(secondRun.perQuery[0]?.hitAt10).toBe(true);
    expect(secondRun.perQuery[0]?.results.some((result) => result.filePath.endsWith(path.join("kb-two", "guide.ts")))).toBe(true);

    const localEvalConfig = JSON.parse(
      readFileSync(path.join(worktreeDir, ".opencode", "codebase-index.json"), "utf-8")
    ) as {
      knowledgeBases?: string[];
    };

    expect(localEvalConfig.knowledgeBases).toEqual(["../main-repo/kb-two"]);
  });

  it("compares against baseline and writes compare artifact", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "eval-baseline-summary.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(baselineRun.summary, null, 2),
      "utf-8"
    );

    const compareRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      againstPath: "benchmarks/baselines/eval-baseline-summary.json",
      ciMode: false,
      reindex: false,
    });

    expect(compareRun.comparison).toBeDefined();
    expect(readFileSync(path.join(compareRun.outputDir, "compare.json"), "utf-8")).toContain("\"distinctTop3Ratio\"");
    expect(readFileSync(path.join(compareRun.outputDir, "compare.json"), "utf-8")).toContain("\"rawDistinctTop3Ratio\"");
    expect(readFileSync(path.join(compareRun.outputDir, "compare.json"), "utf-8")).toContain("\"deltas\"");
  });

  it("rejects comparisons when one summary lacks dataset fingerprint", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselineSummary = { ...baselineRun.summary } as Record<string, unknown>;
    delete baselineSummary.datasetFingerprint;
    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "legacy-fingerprint-summary.json");
    writeFileSync(baselinePath, JSON.stringify(baselineSummary, null, 2), "utf-8");

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        againstPath: "benchmarks/baselines/legacy-fingerprint-summary.json",
        ciMode: false,
        reindex: false,
      }),
    ).rejects.toThrow(/mismatched dataset fingerprint presence/);
  });

  it("fails fast when baseline summary is missing required diversity metrics", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const legacyBaseline = {
      ...baselineRun.summary,
      metrics: {
        ...baselineRun.summary.metrics,
      },
    } as Record<string, unknown>;

    delete (legacyBaseline.metrics as Record<string, unknown>).distinctTop3Ratio;
    delete (legacyBaseline.metrics as Record<string, unknown>).rawDistinctTop3Ratio;

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "legacy-baseline-summary.json");
    writeFileSync(baselinePath, JSON.stringify(legacyBaseline, null, 2), "utf-8");

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        againstPath: "benchmarks/baselines/legacy-baseline-summary.json",
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(/metrics\.distinctTop3Ratio must be a finite number/);
  });

  it("fails ci mode when budget baseline summary is missing required diversity metrics", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const legacyBaseline = {
      ...baselineRun.summary,
      metrics: {
        ...baselineRun.summary.metrics,
      },
    } as Record<string, unknown>;

    delete (legacyBaseline.metrics as Record<string, unknown>).distinctTop3Ratio;
    delete (legacyBaseline.metrics as Record<string, unknown>).rawDistinctTop3Ratio;

    writeFileSync(
      path.join(tempDir, "benchmarks", "baselines", "legacy-baseline-summary.json"),
      JSON.stringify(legacyBaseline, null, 2),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "legacy-check.json"),
      JSON.stringify(
        {
          name: "legacy-check",
          baselinePath: "benchmarks/baselines/legacy-baseline-summary.json",
          failOnMissingBaseline: true,
          thresholds: {
            rawDistinctTop3RatioMaxDrop: 0.1,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: true,
        budgetPath: "benchmarks/budgets/legacy-check.json",
        reindex: false,
      })
    ).rejects.toThrow(/metrics\.distinctTop3Ratio must be a finite number/);
  });

  it("fails ci gate when thresholds regress beyond tolerance", async () => {
    const baselineRun = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const baselinePath = path.join(tempDir, "benchmarks", "baselines", "eval-baseline-summary.json");
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          ...baselineRun.summary,
          metrics: {
            ...baselineRun.summary.metrics,
            hitAt5: 0.95,
            mrrAt10: 0.95,
            latencyMs: {
              p50: 1,
              p95: 1,
              p99: 1,
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "default.json"),
      JSON.stringify(
        {
          name: "default",
          baselinePath: "benchmarks/baselines/eval-baseline-summary.json",
          failOnMissingBaseline: true,
          thresholds: {
            hitAt5MaxDrop: 0.01,
            mrrAt10MaxDrop: 0.01,
            p95LatencyMaxMultiplier: 1.01,
            minHitAt5: 1.1,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const run = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: true,
      budgetPath: "benchmarks/budgets/default.json",
      reindex: false,
    });

    expect(run.gate?.passed).toBe(false);
    expect((run.gate?.violations.length ?? 0) > 0).toBe(true);
  });

  it("runs parameter sweep and emits aggregate compare report", async () => {
    const sweep = await runSweep(
      {
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      },
      {
        fusionStrategy: ["rrf", "weighted"],
        hybridWeight: [0.4, 0.6],
        rrfK: [30],
        rerankTopN: [10],
      }
    );

    expect(sweep.aggregate.runCount).toBe(4);
    expect(readFileSync(path.join(sweep.outputDir, "compare.json"), "utf-8")).toContain("\"runCount\"");
  });

  it("enables branch filtering only when expected.branch is provided", async () => {
    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "small.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q-branch",
              query: "where is rankHybridResults implementation",
              queryType: "definition",
              expected: {
                filePath: "src/indexer/index.ts",
                branch: "other-branch",
              },
            },
          ],
        },
        null,
        2
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(/expects branch 'other-branch'/);
  });

  it("handles missing baseline based on failOnMissingBaseline", async () => {
    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "strict.json"),
      JSON.stringify(
        {
          name: "strict",
          baselinePath: "benchmarks/baselines/missing.json",
          failOnMissingBaseline: true,
          thresholds: {},
        },
        null,
        2
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: true,
        budgetPath: "benchmarks/budgets/strict.json",
        reindex: false,
      })
    ).rejects.toThrow(/Budget baseline is missing/);

    writeFileSync(
      path.join(tempDir, "benchmarks", "budgets", "lenient.json"),
      JSON.stringify(
        {
          name: "lenient",
          baselinePath: "benchmarks/baselines/missing.json",
          failOnMissingBaseline: false,
          thresholds: {},
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: true,
      budgetPath: "benchmarks/budgets/lenient.json",
      reindex: false,
    });

    expect(result.gate?.passed).toBe(true);
  });

  it("includes the config path when eval config JSON is malformed", async () => {
    const brokenConfigPath = path.join(tempDir, "broken-config.json");
    writeFileSync(brokenConfigPath, '{"embeddingProvider":"custom",', "utf-8");

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        configPath: path.relative(tempDir, brokenConfigPath),
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(new RegExp(`Failed to parse eval config JSON at ${brokenConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("fails early when eval config has an invalid knowledgeBases shape", async () => {
    const invalidConfigPath = path.join(tempDir, "invalid-shape-config.json");
    writeFileSync(
      invalidConfigPath,
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-embedding-model",
            dimensions: 8,
          },
          knowledgeBases: "docs/reference",
        },
        null,
        2,
      ),
      "utf-8"
    );

    await expect(
      runEvaluation({
        projectRoot: tempDir,
        configPath: path.relative(tempDir, invalidConfigPath),
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      })
    ).rejects.toThrow(/field 'knowledgeBases' must be an array of strings/);
  });
});
