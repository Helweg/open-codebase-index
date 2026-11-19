import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEvaluation, runSweep } from "../src/eval/runner.js";
import { loadParsedConfig } from "../src/eval/runner-config.js";
import { Indexer } from "../src/indexer/index.js";
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

  it.each([false, true])("rejects missing explicit config before indexing (reindex: %s)", async (reindex) => {
    const configPath = path.join("config", "missing-eval.json");
    fetchSpy.mockClear();

    await expect(runEvaluation({
      projectRoot: tempDir,
      configPath,
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex,
    })).rejects.toThrow(`Config file not found: ${path.join(tempDir, configPath)}`);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(path.join(tempDir, ".opencode", "index"))).toBe(false);
    expect(existsSync(path.join(tempDir, "benchmarks", "results"))).toBe(false);
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

  async function createLinkedEvalFixture() {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
    mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    for (const directory of ["src", ".opencode", "benchmarks"]) {
      cpSync(path.join(tempDir, directory), path.join(mainRepoDir, directory), { recursive: true });
    }
    cpSync(path.join(tempDir, "src"), path.join(worktreeDir, "src"), { recursive: true });
    writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`);
    writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainIndexer = new Indexer(mainRepoDir, loadParsedConfig(mainRepoDir), "opencode");
    try {
      await mainIndexer.index();
    } finally {
      await mainIndexer.close();
    }
    const mainIndexPath = path.join(mainRepoDir, ".opencode", "index");
    const localIndexPath = path.join(worktreeDir, ".opencode", "index");
    const mainDatabasePath = path.join(mainIndexPath, "codebase.db");
    const mainDatabaseBytes = readFileSync(mainDatabasePath);
    const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    const mainConfigBytes = readFileSync(mainConfigPath);
    const sentinelPath = path.join(mainIndexPath, "sentinel.txt");
    writeFileSync(sentinelPath, "keep-main");
    return {
      mainRepoDir,
      worktreeDir,
      mainIndexPath,
      localIndexPath,
      mainDatabasePath,
      mainDatabaseBytes,
      mainConfigPath,
      mainConfigBytes,
      sentinelPath,
    };
  }

  function getEmbeddingRequestInputs(): string[] {
    return fetchSpy.mock.calls.flatMap(([, init]) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      if (body === null || typeof body !== "object" || !("input" in body) || !Array.isArray(body.input)) {
        return [];
      }
      return body.input.filter((input): input is string => typeof input === "string");
    });
  }

  it.each([false, true])("preserves the project config during explicit reindex (late failure: %s)", async (lateFailure) => {
    const projectConfigPath = path.join(tempDir, ".opencode", "codebase-index.json");
    const originalConfig = readFileSync(projectConfigPath);
    const config = loadParsedConfig(tempDir);
    const model = "eval-only-embedding-model";
    writeFileSync(
      path.join(tempDir, "eval-config.json"),
      JSON.stringify({
        ...config,
        embeddingModel: model,
        customProvider: { ...config.customProvider, model },
      }),
    );
    fetchSpy.mockClear();

    const evaluation = runEvaluation({
      projectRoot: tempDir,
      configPath: "eval-config.json",
      datasetPath: "benchmarks/golden/small.json",
      outputRoot: "benchmarks/results",
      reindex: true,
      ciMode: lateFailure,
      budgetPath: "benchmarks/budgets/missing.json",
    });
    if (lateFailure) {
      await expect(evaluation).rejects.toMatchObject({
        code: "ENOENT",
        path: path.join(tempDir, "benchmarks", "budgets", "missing.json"),
      });
    } else {
      const result = await evaluation;
      expect(result.perQuery[0]?.hitAt1).toBe(true);
    }

    const requestedModels = fetchSpy.mock.calls.map(([, init]) => {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      return body !== null && typeof body === "object" && "model" in body ? body.model : undefined;
    });
    expect(requestedModels).toContain(model);
    expect(readFileSync(projectConfigPath)).toEqual(originalConfig);
  });

  it("keeps an eval-local structural catalog separate from its hybrid sibling", async () => {
    const fixture = await createLinkedEvalFixture();
    const options = {
      projectRoot: fixture.worktreeDir,
      datasetPath: path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json"),
      outputRoot: "benchmarks/results",
    };
    await runEvaluation({ ...options, reindex: true });
    const hybridDatabasePath = path.join(fixture.localIndexPath, "codebase.db");
    const hybridBytes = readFileSync(hybridDatabasePath);
    const siblingSentinel = path.join(fixture.localIndexPath, "sentinel.txt");
    writeFileSync(siblingSentinel, "keep-hybrid");
    const config = loadParsedConfig(fixture.mainRepoDir);
    writeFileSync(
      path.join(fixture.worktreeDir, "eval-config.json"),
      JSON.stringify({ ...config, indexing: { ...config.indexing, mode: "structural" } }),
    );
    fetchSpy.mockClear();

    for (const reindex of [true, false]) {
      const result = await runEvaluation({ ...options, configPath: "eval-config.json", reindex });

      expect(result.perQuery[0]?.hitAt1).toBe(true);
      expect(existsSync(path.join(fixture.localIndexPath, "structural", "codebase.db"))).toBe(true);
      expect(readFileSync(hybridDatabasePath)).toEqual(hybridBytes);
      expect(readFileSync(siblingSentinel, "utf-8")).toBe("keep-hybrid");
      expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
      expect(readFileSync(fixture.mainConfigPath)).toEqual(fixture.mainConfigBytes);
      expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
      expect(existsSync(path.join(fixture.worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an eval-local structural catalog aliasing its hybrid sibling", async () => {
    const fixture = await createLinkedEvalFixture();
    const options = {
      projectRoot: fixture.worktreeDir,
      datasetPath: path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json"),
    };
    const hybridResult = await runEvaluation({
      ...options,
      outputRoot: "benchmarks/hybrid-results",
      reindex: true,
    });
    expect(hybridResult.perQuery[0]?.hitAt1).toBe(true);
    const hybridDatabasePath = path.join(fixture.localIndexPath, "codebase.db");
    const hybridBytes = readFileSync(hybridDatabasePath);
    const siblingSentinel = path.join(fixture.localIndexPath, "sentinel.txt");
    writeFileSync(siblingSentinel, "keep-hybrid");
    const structuralIndexPath = path.join(fixture.localIndexPath, "structural");
    symlinkSync(
      fixture.localIndexPath,
      structuralIndexPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = loadParsedConfig(fixture.mainRepoDir);
    writeFileSync(
      path.join(fixture.worktreeDir, "eval-config.json"),
      JSON.stringify({ ...config, indexing: { ...config.indexing, mode: "structural" } }),
    );
    fetchSpy.mockClear();

    for (const reindex of [false, true]) {
      await expect(runEvaluation({
        ...options,
        configPath: "eval-config.json",
        outputRoot: "benchmarks/results",
        reindex,
      })).rejects.toThrow(
        `Eval-local structural index path aliases its hybrid store: ${structuralIndexPath}. Use a separate structural directory.`,
      );

      expect(readFileSync(hybridDatabasePath)).toEqual(hybridBytes);
      expect(readFileSync(siblingSentinel, "utf-8")).toBe("keep-hybrid");
      expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
      expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
      expect(existsSync(path.join(fixture.worktreeDir, "benchmarks", "results"))).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["base-main", "hybrid"],
    ["base-outside", "hybrid"],
    ["base-self", "hybrid"],
    ["structural-outside", "structural"],
    ["main-inward", "hybrid"],
    ["structural-main-inward", "structural"],
  ] as const)("rejects eval-local index aliases or escapes (%s, %s)", async (alias, mode) => {
    const fixture = await createLinkedEvalFixture();
    const outsidePath = path.join(tempDir, "outside-index");
    mkdirSync(outsidePath, { recursive: true });
    writeFileSync(path.join(outsidePath, "sentinel.txt"), "keep-outside");
    mkdirSync(path.dirname(fixture.localIndexPath), { recursive: true });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    switch (alias) {
      case "base-main":
        symlinkSync(fixture.mainIndexPath, fixture.localIndexPath, linkType);
        break;
      case "base-outside":
        symlinkSync(outsidePath, fixture.localIndexPath, linkType);
        break;
      case "base-self":
        symlinkSync(fixture.worktreeDir, fixture.localIndexPath, linkType);
        break;
      case "structural-outside":
        mkdirSync(fixture.localIndexPath, { recursive: true });
        symlinkSync(outsidePath, path.join(fixture.localIndexPath, "structural"), linkType);
        break;
      case "main-inward":
        renameSync(fixture.mainIndexPath, fixture.localIndexPath);
        symlinkSync(fixture.localIndexPath, fixture.mainIndexPath, linkType);
        break;
      case "structural-main-inward":
        mkdirSync(path.join(fixture.localIndexPath, "structural"), { recursive: true });
        symlinkSync(
          path.join(fixture.localIndexPath, "structural"),
          path.join(fixture.mainIndexPath, "structural"),
          linkType,
        );
        break;
    }
    const config = loadParsedConfig(fixture.mainRepoDir);
    writeFileSync(
      path.join(fixture.worktreeDir, "eval-config.json"),
      JSON.stringify({ ...config, indexing: { ...config.indexing, mode } }),
    );
    fetchSpy.mockClear();

    await expect(runEvaluation({
      projectRoot: fixture.worktreeDir,
      configPath: "eval-config.json",
      datasetPath: path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json"),
      outputRoot: "benchmarks/results",
      reindex: true,
    })).rejects.toThrow(alias.endsWith("outside") || alias === "base-self"
      ? /escapes the linked worktree/
      : /aliases the main checkout/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
    expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
    expect(readFileSync(path.join(outsidePath, "sentinel.txt"), "utf-8")).toBe("keep-outside");
    expect(existsSync(path.join(fixture.worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
    expect(existsSync(path.join(fixture.worktreeDir, "benchmarks", "results"))).toBe(false);
  });

  describe("configured index reindexing", () => {
    let projectRoot: string;
    let indexPath: string;

    beforeEach(() => {
      projectRoot = path.join(tempDir, "project");
      indexPath = path.join(tempDir, "outside", "index");
      mkdirSync(projectRoot, { recursive: true });
      for (const directory of ["src", ".opencode", "benchmarks"]) {
        cpSync(path.join(tempDir, directory), path.join(projectRoot, directory), { recursive: true });
      }
      const config = loadParsedConfig(projectRoot);
      writeFileSync(
        path.join(projectRoot, ".opencode", "codebase-index.json"),
        JSON.stringify({ ...config, indexPath }),
      );
      writeFileSync(
        path.join(projectRoot, "benchmarks", "budgets", "configured-index.json"),
        JSON.stringify({ name: "configured-index", failOnMissingBaseline: false, thresholds: { minHitAt5: 1 } }),
      );
    });

    it("rebuilds an existing external index without touching the existing default index", async () => {
      const config = loadParsedConfig(projectRoot);
      const defaultIndexer = new Indexer(projectRoot, { ...config, indexPath: undefined }, "opencode");
      const configuredIndexer = new Indexer(projectRoot, config, "opencode");
      try {
        await defaultIndexer.index();
        await configuredIndexer.index();
      } finally {
        await Promise.all([defaultIndexer.close(), configuredIndexer.close()]);
      }
      const defaultDatabase = path.join(projectRoot, ".opencode", "index", "codebase.db");
      const defaultBytes = readFileSync(defaultDatabase);
      const defaultSentinel = path.join(projectRoot, ".opencode", "index", "sentinel.txt");
      writeFileSync(defaultSentinel, "keep-default");
      const configuredSentinel = path.join(indexPath, "sentinel.txt");
      writeFileSync(configuredSentinel, "keep-external");
      fetchSpy.mockClear();
      writeFileSync(
        path.join(projectRoot, ".opencode", "codebase-index.json"),
        JSON.stringify({
          ...config,
          embeddingModel: "rebuilt-embedding-model",
          customProvider: { ...config.customProvider, model: "rebuilt-embedding-model" },
        }),
      );

      const result = await runEvaluation({
        projectRoot,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        reindex: true,
        ciMode: true,
        budgetPath: "benchmarks/budgets/configured-index.json",
      });

      expect(result.perQuery[0]?.hitAt1).toBe(true);
      // Unchanged source must be embedded again, not reused from the old index.
      expect(fetchSpy).toHaveBeenCalled();
      expect(readFileSync(defaultDatabase)).toEqual(defaultBytes);
      expect(readFileSync(configuredSentinel, "utf-8")).toBe("keep-external");
      expect(readFileSync(defaultSentinel, "utf-8")).toBe("keep-default");
    });

    it("rebuilds the configured structural store without resetting its semantic sibling", async () => {
      const config = loadParsedConfig(projectRoot);
      const semanticIndexer = new Indexer(projectRoot, config, "opencode");
      const structuralConfig = { ...config, indexing: { ...config.indexing, mode: "structural" as const } };
      const structuralIndexer = new Indexer(projectRoot, structuralConfig, "opencode");
      try {
        await semanticIndexer.index();
        await structuralIndexer.index();
      } finally {
        await Promise.all([semanticIndexer.close(), structuralIndexer.close()]);
      }
      const semanticDatabase = path.join(indexPath, "codebase.db");
      const semanticBytes = readFileSync(semanticDatabase);
      writeFileSync(
        path.join(projectRoot, ".opencode", "codebase-index.json"),
        JSON.stringify(structuralConfig),
      );
      fetchSpy.mockClear();

      const result = await runEvaluation({
        projectRoot,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        reindex: true,
      });

      expect(result.perQuery[0]?.hitAt1).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(readFileSync(semanticDatabase)).toEqual(semanticBytes);
    });

    it("refuses to rebuild an inherited configured index from a linked worktree", async () => {
      const worktreeRoot = path.join(tempDir, "worktree");
      const worktreeGitDir = path.join(projectRoot, ".git", "worktrees", "feature");
      mkdirSync(path.join(projectRoot, ".git", "refs", "heads"), { recursive: true });
      mkdirSync(worktreeGitDir, { recursive: true });
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(path.join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(path.join(projectRoot, ".git", "refs", "heads", "main"), `${"1".repeat(40)}\n`);
      writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`);
      writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
      writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
      cpSync(path.join(projectRoot, "src"), path.join(worktreeRoot, "src"), { recursive: true });
      const config = loadParsedConfig(projectRoot);
      const owner = new Indexer(projectRoot, config, "opencode");
      try {
        await owner.index();
      } finally {
        await owner.close();
      }
      const sentinel = path.join(indexPath, "sentinel.txt");
      writeFileSync(sentinel, "keep-shared");

      await expect(runEvaluation({
        projectRoot: worktreeRoot,
        datasetPath: path.join(projectRoot, "benchmarks", "golden", "small.json"),
        outputRoot: "benchmarks/results",
        reindex: true,
      })).rejects.toThrow(/force rebuild is unsafe.*inherited worktree index/);

      expect(readFileSync(sentinel, "utf-8")).toBe("keep-shared");
      const reader = new Indexer(projectRoot, config, "opencode");
      try {
        const results = await reader.search("rankHybridResults", 5, { metadataOnly: true });
        expect(results.some((result) => result.name === "rankHybridResults")).toBe(true);
      } finally {
        await reader.close();
      }
    });

    it("rebuilds only the current project in a configured shared global index", async () => {
      const config = { ...loadParsedConfig(projectRoot), scope: "global" as const };
      writeFileSync(
        path.join(projectRoot, ".opencode", "codebase-index.json"),
        JSON.stringify(config),
      );
      const otherRoot = path.join(tempDir, "other-project");
      mkdirSync(path.join(otherRoot, "src"), { recursive: true });
      writeFileSync(
        path.join(otherRoot, "src", "foreign.ts"),
        "export function foreignProjectMarker() { return 'preserve'; }\n",
      );
      const otherIndexer = new Indexer(otherRoot, config, "opencode");
      const projectIndexer = new Indexer(projectRoot, config, "opencode");
      try {
        await otherIndexer.index();
        await projectIndexer.index();
      } finally {
        await Promise.all([otherIndexer.close(), projectIndexer.close()]);
      }
      fetchSpy.mockClear();

      const result = await runEvaluation({
        projectRoot,
        datasetPath: "benchmarks/golden/small.json",
        outputRoot: "benchmarks/results",
        reindex: true,
        ciMode: true,
        budgetPath: "benchmarks/budgets/configured-index.json",
      });

      expect(result.perQuery[0]?.hitAt1).toBe(true);
      expect(fetchSpy).toHaveBeenCalled();
      const reader = new Indexer(otherRoot, config, "opencode");
      try {
        const results = await reader.search("foreignProjectMarker", 5, { metadataOnly: true });
        expect(results.find((entry) => entry.name === "foreignProjectMarker")?.filePath)
          .toBe(path.join(otherRoot, "src", "foreign.ts"));
      } finally {
        await reader.close();
      }
    });
  });

  it("executes architecture_context queries and measures cited evidence relevance and response tokens", async () => {
    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "architecture.json"),
      JSON.stringify({
        version: "1.0.0",
        name: "architecture",
        queries: [{
          id: "architecture-indexer",
          query: "map the indexer architecture before changing result ranking",
          queryType: "architecture",
          retrievalMode: "architecture",
          args: { directory: "src/indexer", depth: 2, tokenBudget: 512 },
          expected: {
            gradedEvidence: [{
              path: "src/indexer/index.ts",
              symbol: "rankHybridResults",
              relevance: 3,
            }],
          },
        }],
      }, null, 2),
      "utf-8",
    );

    const runtimeCacheSpy = vi.spyOn(operationRuntime, "getIndexerForProject");
    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/architecture.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    expect(runtimeCacheSpy).not.toHaveBeenCalled();
    runtimeCacheSpy.mockRestore();
    expect(result.perQuery[0]).toMatchObject({
      retrievalMode: "architecture",
      queryType: "architecture",
      hitAt1: true,
      tokenBudget: 512,
    });
    expect(result.perQuery[0]?.responseTokens).toBeGreaterThan(0);
    expect(result.perQuery[0]?.responseTokens).toBeLessThanOrEqual(512);
    expect(result.perQuery[0]?.results[0]).toMatchObject({
      filePath: "src/indexer/index.ts",
      name: "rankHybridResults",
      chunkType: "architecture-module",
    });
    expect(result.summary.metrics.retrievalModeCounts?.architecture).toBe(1);
    expect(result.summary.metrics.contextEfficiency.responseTokens.max).toBeLessThanOrEqual(512);
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

  it("does not use the expected path to disambiguate edit-context requests", async () => {
    const symbol = "prepareEditTarget";
    const filePath = "src/primary/target.ts";
    for (const directory of ["primary", "secondary"]) {
      mkdirSync(path.join(tempDir, "src", directory), { recursive: true });
      writeFileSync(
        path.join(tempDir, "src", directory, "target.ts"),
        `export function ${symbol}(value: string) { return '${directory}:' + value; }\n`,
        "utf-8",
      );
    }

    const query = {
      query: "change prepareEditTarget behavior",
      queryType: "definition",
      retrievalMode: "edit-context",
      args: { symbol, tokenBudget: 512 },
      expected: { filePath, symbol },
    };
    writeFileSync(
      path.join(tempDir, "benchmarks", "golden", "edit-context-scope.json"),
      JSON.stringify({
        version: "1.0.0",
        name: "edit-context-scope",
        queries: [
          { ...query, id: "unscoped" },
          { ...query, id: "scoped", args: { ...query.args, filePath } },
        ],
      }, null, 2),
      "utf-8",
    );

    const result = await runEvaluation({
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/edit-context-scope.json",
      outputRoot: "benchmarks/results",
      ciMode: false,
      reindex: false,
    });

    const scoped = result.perQuery.find((item) => item.id === "scoped");
    expect(scoped).toMatchObject({ resolvedRoute: "definition", hitAt1: true });
    expect(scoped?.results[0]).toMatchObject({ filePath: path.join(tempDir, filePath), name: symbol });
    const unscoped = result.perQuery.find((item) => item.id === "unscoped");
    expect(unscoped?.resolvedRoute).toBe("search");
  });

  it.each(["checkout", "snapshot", "tests", "docs", `long-${"nested-".repeat(20)}`])("grades published edit-context evidence relative to a %s project root", async (rootName) => {
    const projectRoot = path.join(tempDir, rootName);
    cpSync(path.join(tempDir, "src"), path.join(projectRoot, "src"), { recursive: true });
    cpSync(path.join(tempDir, ".opencode"), path.join(projectRoot, ".opencode"), { recursive: true });
    mkdirSync(path.join(projectRoot, "benchmarks", "golden"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "benchmarks", "golden", "edit-fallback.json"),
      JSON.stringify({
        version: "1.0.0",
        name: "edit-fallback",
        queries: [{
          id: "unresolved-target",
          query: "assemble code evidence before editing",
          queryType: "definition",
          retrievalMode: "edit-context",
          args: { symbol: "missingSymbol", tokenBudget: 1200 },
          expected: {
            filePath: "src/indexer/index.ts",
            symbol: "rankHybridResults",
          },
        }],
      }),
    );
    const searchSpy = vi.spyOn(Indexer.prototype, "search").mockResolvedValue([
      {
        filePath: path.join(projectRoot, "tests", "context.test.ts"),
        startLine: 1,
        endLine: 1,
        score: 1,
        chunkType: "function_declaration",
        name: "testContext",
        content: "function testContext() { return true; }",
      },
      {
        filePath: path.join(projectRoot, "src", "indexer", "index.ts"),
        startLine: 1,
        endLine: 1,
        score: 0.9,
        chunkType: "function_declaration",
        name: "rankHybridResults",
        content: "function rankHybridResults() { return true; }",
      },
    ]);
    try {
      const result = await runEvaluation({
        projectRoot,
        datasetPath: "benchmarks/golden/edit-fallback.json",
        outputRoot: "benchmarks/results",
        ciMode: false,
        reindex: false,
      });
      expect(result.perQuery[0]).toMatchObject({
        resolvedRoute: "search",
        hitAt1: true,
        reciprocalRankAt10: 1,
      });
      expect(result.perQuery[0].results.map((item) => item.name))
        .toEqual(["rankHybridResults", "testContext"]);
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("does not grade a location echoed in a risk message when evidence is omitted by the final budget", async () => {
    const filePath = path.join(tempDir, "src", "indexer", "index.ts");
    const symbol = `${filePath}:1-1 ${"unknown ".repeat(200)}`;
    writeFileSync(path.join(tempDir, "benchmarks", "golden", "edit-budget.json"), JSON.stringify({
      version: "1.0.0",
      name: "edit-budget",
      queries: [128, 4000].map((tokenBudget) => ({
        id: `budget-${tokenBudget}`,
        query: "assemble code evidence before editing",
        queryType: "definition",
        retrievalMode: "edit-context",
        args: { symbol, tokenBudget },
        expected: { filePath: "src/indexer/index.ts", symbol: "rankHybridResults" },
      })),
    }));
    const searchSpy = vi.spyOn(Indexer.prototype, "search").mockResolvedValue([{
      filePath, startLine: 1, endLine: 1, score: 1,
      chunkType: "function_declaration", name: "rankHybridResults",
      content: "function rankHybridResults() { return true; }",
    }]);
    try {
      const result = await runEvaluation({
        projectRoot: tempDir, datasetPath: "benchmarks/golden/edit-budget.json",
        outputRoot: "benchmarks/results", reindex: false,
      });
      expect(result.perQuery[0]).toMatchObject({ hitAt1: false, results: [] });
      expect(result.perQuery[0].responseTokens).toBeLessThanOrEqual(128);
      expect(result.perQuery[1]).toMatchObject({ hitAt1: true, reciprocalRankAt10: 1 });
      expect(result.perQuery[1].results.map((item) => item.name)).toEqual(["rankHybridResults"]);
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("grades only graph neighbors retained after the final source and graph budget", async () => {
    // This identity alone exceeds 128 tokens, independent of the temporary root's length.
    const callerName = `evaluateRanking${"Linked".repeat(128)}`;
    writeFileSync(path.join(tempDir, "src", "indexer", "index.ts"), [
      "export function rankHybridResults(query: string) {",
      `  /* ${"ranking ".repeat(250)} */`,
      "  return query.length;",
      "}",
      `export function ${callerName}() { return rankHybridResults('query'); }`,
    ].join("\n"));
    writeFileSync(path.join(tempDir, "benchmarks", "golden", "edit-graph-budget.json"), JSON.stringify({
      version: "1.0.0", name: "edit-graph-budget",
      queries: [128, 4000].map((tokenBudget) => ({
        id: `graph-budget-${tokenBudget}`,
        query: "review ranking before editing",
        queryType: "definition", retrievalMode: "edit-context",
        args: { symbol: "rankHybridResults", tokenBudget },
        expected: {
          filePath: "src/indexer/index.ts", symbol: "rankHybridResults",
          graphNeighbor: { direction: "caller", filePath: "src/indexer/index.ts", symbol: callerName },
        },
      })),
    }));
    const result = await runEvaluation({
      projectRoot: tempDir, datasetPath: "benchmarks/golden/edit-graph-budget.json",
      outputRoot: "benchmarks/results", reindex: false,
    });
    expect(result.perQuery[0]).toMatchObject({ hitAt1: true, graphNeighborMatched: false });
    expect(result.perQuery[0].results.map((item) => item.name)).toEqual(["rankHybridResults"]);
    expect(result.perQuery[0].responseTokens).toBeLessThanOrEqual(128);
    expect(result.perQuery[1]).toMatchObject({ hitAt1: true, graphNeighborMatched: true });
    expect(result.perQuery[1].results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: callerName, graphDirection: "caller" }),
    ]));
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

  it("uses only the requested recovery option, never the expected recovery label", async () => {
    const datasetPath = path.join(tempDir, "benchmarks/golden/scope-options.json");
    writeFileSync(datasetPath, JSON.stringify({
      version: "2.3.0", name: "scope-options",
      queries: [undefined, false, true].map((allowUnscopedRecovery, index) => ({
        id: `scope-${index}`, query: "find ranking definition", queryType: "definition", retrievalMode: "context",
        args: { symbol: "rankHybridResults", directory: "absent", fileType: "py",
          ...(allowUnscopedRecovery === undefined ? {} : { allowUnscopedRecovery }) },
        expected: { filePath: "src/indexer/index.ts", symbol: "rankHybridResults",
          expectedOutcome: allowUnscopedRecovery === true ? "results" : "no-results",
          recoveryExpectation: "filter-relaxed" },
      })),
    }));
    const result = await runEvaluation({
      projectRoot: tempDir, datasetPath: "benchmarks/golden/scope-options.json",
      outputRoot: "benchmarks/results", ciMode: false, reindex: false,
    });
    for (const row of result.perQuery.slice(0, 2)) {
      expect(row.results).toEqual([]);
      expect(row.outcomeMatched).toBe(true);
      expect(row.recoveryMatched).toBe(false);
    }
    expect(result.perQuery[2]?.results).toContainEqual(expect.objectContaining({
      filePath: expect.stringContaining("src/indexer/index.ts"), name: "rankHybridResults",
    }));
    expect(result.perQuery[2]?.outcomeMatched).toBe(true);
    expect(result.perQuery[2]?.recoveryMatched).toBe(true);
  });

  it("keeps strict context misses empty when ordinary scoped search has evidence", async () => {
    writeFileSync(path.join(tempDir, ".opencode/codebase-index.json"), JSON.stringify({
      indexing: { mode: "structural", watchFiles: false, autoIndex: false, requireProjectMarker: false },
      search: { minScore: 0 },
    }));
    mkdirSync(path.join(tempDir, "src/helpers"), { recursive: true });
    mkdirSync(path.join(tempDir, "lib"), { recursive: true });
    writeFileSync(path.join(tempDir, "src/helpers/request.ts"),
      "export function requestHelpers() { return 'request helpers'; }\n");
    writeFileSync(path.join(tempDir, "lib/status.ts"),
      "export function getStatus() { return 'ready'; }\n");
    const datasetPath = "benchmarks/golden/context-authority.json";
    writeFileSync(path.join(tempDir, datasetPath), JSON.stringify({
      version: "2.3.0", name: "context-authority",
      queries: [
        ...[undefined, false, true].map((allowUnscopedRecovery, index) => ({
          id: `context-${index}`, query: "request helpers", queryType: "definition", retrievalMode: "context",
          args: { symbol: "getStatus", directory: "src/helpers", fileType: "ts",
            ...(allowUnscopedRecovery === undefined ? {} : { allowUnscopedRecovery }) },
          expected: { filePath: "lib/status.ts", symbol: "getStatus", expectedRoute: "definition",
            expectedOutcome: allowUnscopedRecovery === true ? "results" : "no-results",
            recoveryExpectation: "filter-relaxed" },
        })),
        {
          id: "ordinary-search", query: "request helpers", queryType: "conceptual", retrievalMode: "search",
          args: { directory: "src/helpers", fileType: "ts" },
          expected: { filePath: "src/helpers/request.ts", symbol: "requestHelpers",
            expectedRoute: "search", expectedOutcome: "results" },
        },
      ],
    }));
    const result = await runEvaluation({
      projectRoot: tempDir, datasetPath, outputRoot: "benchmarks/results", ciMode: false, reindex: false,
    });
    for (const row of result.perQuery.slice(0, 2)) {
      expect(row.results).toEqual([]);
      expect(row.resolvedRoute).toBe("definition");
      expect(row.routedQuery).toBe("getStatus");
      expect(row.candidateCount).toBe(0);
      expect(row.outcomeMatched).toBe(true);
      expect(row.recoveryMatched).toBe(false);
    }
    expect(result.perQuery[2]?.results.map((item) => ({
      file: path.relative(tempDir, item.filePath).replace(/\\/g, "/"), name: item.name,
    }))).toEqual([{ file: "lib/status.ts", name: "getStatus" }]);
    expect(result.perQuery[2]?.outcomeMatched).toBe(true);
    expect(result.perQuery[2]?.recoveryMatched).toBe(true);
    expect(result.perQuery[3]?.results.map((item) =>
      path.relative(tempDir, item.filePath).replace(/\\/g, "/"))).toEqual(["src/helpers/request.ts"]);
    expect(result.perQuery[3]?.resolvedRoute).toBe("search");
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

  it("uses a local eval catalog without creating config when inheriting worktree settings", async () => {
    const fixture = await createLinkedEvalFixture();
    writeFileSync(fixture.mainConfigPath, JSON.stringify({
      ...loadParsedConfig(fixture.mainRepoDir),
      include: ["src/**/*.ts", "*.ts"],
      additionalInclude: ["docs/**/*.md"],
      knowledgeBases: ["docs/reference"],
    }));
    const sourceConfigBytes = readFileSync(fixture.mainConfigPath);
    for (const [root, prefix] of [[fixture.mainRepoDir, "main"], [fixture.worktreeDir, "worktree"]]) {
      mkdirSync(path.join(root, "docs", "reference"), { recursive: true });
      writeFileSync(
        path.join(root, "docs", "reference", "guide.ts"),
        `export function ${prefix}KbSymbol() { return '${prefix}'; }\n`,
      );
      writeFileSync(path.join(root, "docs", "notes.md"), `# ${prefix}IncludeMarker\nSelected ${prefix} documentation.\n`);
    }
    const datasetPath = path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json");
    writeFileSync(datasetPath, JSON.stringify({
      version: "1.0.0",
      name: "inherited-worktree",
      queries: [
        {
          id: "kb", query: "worktreeKbSymbol", queryType: "definition",
          expected: { filePath: "docs/reference/guide.ts", symbol: "worktreeKbSymbol" },
        },
        {
          id: "include", query: "worktreeIncludeMarker", queryType: "definition",
          expected: { filePath: "docs/notes.md" },
        },
        {
          id: "target", query: "rankHybridResults", queryType: "definition",
          expected: { filePath: "src/indexer/index.ts", symbol: "rankHybridResults" },
        },
      ],
    }));

    for (const reindex of [true, false]) {
      fetchSpy.mockClear();
      const result = await runEvaluation({
        projectRoot: fixture.worktreeDir,
        datasetPath,
        outputRoot: "benchmarks/results",
        reindex,
      });

      expect(existsSync(path.join(fixture.localIndexPath, "codebase.db"))).toBe(true);
      expect(existsSync(path.join(fixture.worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
      expect(readFileSync(fixture.mainConfigPath)).toEqual(sourceConfigBytes);
      expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
      expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
      expect(result.perQuery[2]?.hitAt1).toBe(true);
      if (reindex) {
        const inputs = getEmbeddingRequestInputs();
        expect(inputs).toEqual(expect.arrayContaining([
          expect.stringContaining("export function worktreeKbSymbol("),
          expect.stringContaining("Selected worktree documentation."),
        ]));
        expect(inputs.some((input) => input.includes("export function mainKbSymbol("))).toBe(false);
        expect(inputs.some((input) => input.includes("Selected main documentation."))).toBe(false);
      }
    }
  });

  it("uses an explicit project config in memory with worktree-relative sources", async () => {
    const fixture = await createLinkedEvalFixture();
    writeFileSync(fixture.mainConfigPath, JSON.stringify({
      ...loadParsedConfig(fixture.mainRepoDir),
      include: ["src/**/*.ts", "*.ts"],
      additionalInclude: ["docs/**/*.md"],
      knowledgeBases: ["docs/reference"],
    }));
    const sourceConfigBytes = readFileSync(fixture.mainConfigPath);
    for (const [root, prefix] of [[fixture.mainRepoDir, "main"], [fixture.worktreeDir, "worktree"]]) {
      mkdirSync(path.join(root, "docs", "reference"), { recursive: true });
      writeFileSync(
        path.join(root, "docs", "reference", "guide.ts"),
        `export function ${prefix}ExplicitKb() { return '${prefix}'; }\n`,
      );
      writeFileSync(path.join(root, "docs", "notes.md"), `# ${prefix}ExplicitInclude\nSelected ${prefix} documentation.\n`);
    }
    const datasetPath = path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json");
    writeFileSync(datasetPath, JSON.stringify({
      version: "1.0.0",
      name: "explicit-project-config",
      queries: [
        {
          id: "kb", query: "worktreeExplicitKb", queryType: "definition",
          expected: { filePath: "docs/reference/guide.ts", symbol: "worktreeExplicitKb" },
        },
        {
          id: "include", query: "worktreeExplicitInclude", queryType: "definition",
          expected: { filePath: "docs/notes.md" },
        },
        {
          id: "target", query: "rankHybridResults", queryType: "definition",
          expected: { filePath: "src/indexer/index.ts", symbol: "rankHybridResults" },
        },
      ],
    }));

    fetchSpy.mockClear();
    const result = await runEvaluation({
      projectRoot: fixture.worktreeDir,
      configPath: path.relative(fixture.worktreeDir, fixture.mainConfigPath),
      datasetPath,
      outputRoot: "benchmarks/results",
      reindex: true,
    });

    expect(result.perQuery[2]?.hitAt1).toBe(true);
    const inputs = getEmbeddingRequestInputs();
    expect(inputs).toEqual(expect.arrayContaining([
      expect.stringContaining("export function worktreeExplicitKb("),
      expect.stringContaining("Selected worktree documentation."),
    ]));
    expect(inputs.some((input) => input.includes("export function mainExplicitKb("))).toBe(false);
    expect(inputs.some((input) => input.includes("Selected main documentation."))).toBe(false);
    expect(existsSync(path.join(fixture.localIndexPath, "codebase.db"))).toBe(true);
    expect(existsSync(path.join(fixture.worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
    expect(readFileSync(fixture.mainConfigPath)).toEqual(sourceConfigBytes);
    expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
    expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
  });

  it("resolves source-relative knowledge bases and includes from an arbitrary explicit config", async () => {
    const fixture = await createLinkedEvalFixture();
    const configDir = path.join(fixture.mainRepoDir, "config");
    const externalKbDir = path.join(fixture.mainRepoDir, "external-kb");
    const externalConfigPath = path.join(configDir, "eval-config.json");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(externalKbDir, { recursive: true });
    for (const root of [fixture.mainRepoDir, fixture.worktreeDir]) {
      mkdirSync(path.join(root, "docs"), { recursive: true });
    }
    mkdirSync(path.join(fixture.worktreeDir, "external-kb"), { recursive: true });
    writeFileSync(path.join(externalKbDir, "guide.ts"), "export function externalKbSymbol() { return 'selected'; }\n");
    writeFileSync(
      path.join(fixture.worktreeDir, "external-kb", "guide.ts"),
      "export function wrongKbSymbol() { return 'unselected'; }\n",
    );
    writeFileSync(path.join(fixture.mainRepoDir, "docs", "notes.md"), "# wrongIncludeMarker\nUnselected documentation.\n");
    writeFileSync(path.join(fixture.worktreeDir, "docs", "notes.md"), "# sourceRelativeInclude\nSelected documentation.\n");
    writeFileSync(externalConfigPath, JSON.stringify({
      ...loadParsedConfig(fixture.mainRepoDir),
      include: ["src/**/*.ts", "*.ts"],
      additionalInclude: ["../../worktree-feature/docs/**/*.md"],
      knowledgeBases: ["../external-kb"],
    }));
    const sourceConfigBytes = readFileSync(externalConfigPath);
    const datasetPath = path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json");
    writeFileSync(datasetPath, JSON.stringify({
      version: "1.0.0",
      name: "source-relative-config",
      queries: [
        {
          id: "kb", query: "externalKbSymbol", queryType: "definition",
          expected: { filePath: "external-kb/guide.ts", symbol: "externalKbSymbol" },
        },
        {
          id: "include", query: "sourceRelativeInclude", queryType: "definition",
          expected: { filePath: "docs/notes.md" },
        },
      ],
    }));

    fetchSpy.mockClear();
    const result = await runEvaluation({
      projectRoot: fixture.worktreeDir,
      configPath: path.relative(fixture.worktreeDir, externalConfigPath),
      datasetPath,
      outputRoot: "benchmarks/results",
      reindex: true,
    });

    expect(result.perQuery[0]?.hitAt10).toBe(true);
    const inputs = getEmbeddingRequestInputs();
    expect(inputs).toEqual(expect.arrayContaining([
      expect.stringContaining("export function externalKbSymbol("),
      expect.stringContaining("Selected documentation."),
    ]));
    expect(inputs.some((input) => input.includes("export function wrongKbSymbol("))).toBe(false);
    expect(inputs.some((input) => input.includes("Unselected documentation."))).toBe(false);
    expect(existsSync(path.join(fixture.localIndexPath, "codebase.db"))).toBe(true);
    expect(existsSync(path.join(fixture.worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
    expect(readFileSync(externalConfigPath)).toEqual(sourceConfigBytes);
    expect(readFileSync(fixture.mainConfigPath)).toEqual(fixture.mainConfigBytes);
    expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
    expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
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

  it("uses each explicit config on repeated reindexes without creating project config", async () => {
    const fixture = await createLinkedEvalFixture();
    const configDir = path.join(fixture.mainRepoDir, "config");
    mkdirSync(configDir, { recursive: true });
    const configPaths: string[] = [];
    const sourceConfigBytes: Buffer[] = [];
    for (const [name, suffix] of [["one", "One"], ["two", "Two"]]) {
      const kbDir = path.join(fixture.mainRepoDir, `kb-${name}`);
      const docsDir = path.join(fixture.worktreeDir, `docs-${name}`);
      mkdirSync(kbDir, { recursive: true });
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(path.join(kbDir, "guide.ts"), `export function kb${suffix}Symbol() { return '${name}'; }\n`);
      writeFileSync(path.join(docsDir, "guide.md"), `# include${suffix}Marker\nSelected ${name} documentation.\n`);
      const configPath = path.join(configDir, `eval-config-${name}.json`);
      writeFileSync(configPath, JSON.stringify({
        ...loadParsedConfig(fixture.mainRepoDir),
        include: ["src/**/*.ts", "*.ts"],
        additionalInclude: [`../../worktree-feature/docs-${name}/**/*.md`],
        knowledgeBases: [`../kb-${name}`],
      }));
      configPaths.push(configPath);
      sourceConfigBytes.push(readFileSync(configPath));
    }
    const datasetPath = path.join(fixture.mainRepoDir, "benchmarks", "golden", "small.json");
    writeFileSync(datasetPath, JSON.stringify({
      version: "1.0.0",
      name: "successive-configs",
      queries: [
        {
          id: "kb-one", query: "kbOneSymbol", queryType: "definition",
          expected: { filePath: "kb-one/guide.ts", symbol: "kbOneSymbol" },
        },
        {
          id: "kb-two", query: "kbTwoSymbol", queryType: "definition",
          expected: { filePath: "kb-two/guide.ts", symbol: "kbTwoSymbol" },
        },
        {
          id: "include-one", query: "includeOneMarker", queryType: "definition",
          expected: { filePath: "docs-one/guide.md" },
        },
        {
          id: "include-two", query: "includeTwoMarker", queryType: "definition",
          expected: { filePath: "docs-two/guide.md" },
        },
      ],
    }));

    for (const [index, configPath] of configPaths.entries()) {
      fetchSpy.mockClear();
      const result = await runEvaluation({
        projectRoot: fixture.worktreeDir,
        configPath: path.relative(fixture.worktreeDir, configPath),
        datasetPath,
        outputRoot: "benchmarks/results",
        reindex: true,
      });

      expect(result.perQuery.slice(0, 2).map((query) => query.hitAt10))
        .toEqual(index === 0 ? [true, false] : [false, true]);
      const inputs = getEmbeddingRequestInputs();
      const selected = index === 0 ? "One" : "Two";
      const unselected = index === 0 ? "Two" : "One";
      expect(inputs).toEqual(expect.arrayContaining([
        expect.stringContaining(`export function kb${selected}Symbol(`),
        expect.stringContaining(`Selected ${selected.toLowerCase()} documentation.`),
      ]));
      expect(inputs.some((input) => input.includes(`export function kb${unselected}Symbol(`))).toBe(false);
      expect(inputs.some((input) => input.includes(`Selected ${unselected.toLowerCase()} documentation.`))).toBe(false);
      expect(readFileSync(configPath)).toEqual(sourceConfigBytes[index]);
      expect(existsSync(path.join(fixture.localIndexPath, "codebase.db"))).toBe(true);
      expect(existsSync(path.join(fixture.worktreeDir, ".opencode", "codebase-index.json"))).toBe(false);
      expect(readFileSync(fixture.mainConfigPath)).toEqual(fixture.mainConfigBytes);
      expect(readFileSync(fixture.mainDatabasePath)).toEqual(fixture.mainDatabaseBytes);
      expect(readFileSync(fixture.sentinelPath, "utf-8")).toBe("keep-main");
    }
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
