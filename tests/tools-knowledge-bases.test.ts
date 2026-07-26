import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { indexerInstances, MockIndexer } = vi.hoisted(() => {
  const indexerInstances: Array<{
    projectRoot: string;
    config: Record<string, unknown>;
    getStatus: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
  }> = [];

  class MockIndexer {
    public readonly projectRoot: string;
    public readonly config: Record<string, unknown>;
    public getStatus = vi.fn().mockResolvedValue({
      indexed: true,
      vectorCount: 0,
      provider: "ollama",
      model: "nomic-embed-text",
      indexPath: "/tmp/index",
      currentBranch: "main",
      baseBranch: "main",
    });

    public constructor(projectRoot: string, config: Record<string, unknown>) {
      this.projectRoot = projectRoot;
      this.config = config;
      indexerInstances.push({ projectRoot, config, getStatus: this.getStatus, healthCheck: this.healthCheck });
    }

    public estimateCost = vi.fn().mockResolvedValue({
      filesCount: 0,
      totalSizeBytes: 0,
      estimatedChunks: 0,
      estimatedTokens: 0,
      estimatedCost: 0,
      isFree: true,
      provider: "ollama",
      model: "nomic-embed-text",
    });

    public clearIndex = vi.fn().mockResolvedValue(undefined);
    public index = vi.fn().mockResolvedValue({
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    });
    public forceIndex = vi.fn().mockResolvedValue({
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    });

    public healthCheck = vi.fn().mockResolvedValue({
      removed: 0,
      gcOrphanEmbeddings: 0,
      gcOrphanChunks: 0,
      gcOrphanSymbols: 0,
      gcOrphanCallEdges: 0,
      filePaths: [],
    });

    public getLogger = vi.fn().mockReturnValue({
      isEnabled: vi.fn().mockReturnValue(false),
      isMetricsEnabled: vi.fn().mockReturnValue(false),
      getLogs: vi.fn().mockReturnValue([]),
      getLogsByCategory: vi.fn().mockReturnValue([]),
      getLogsByLevel: vi.fn().mockReturnValue([]),
      formatMetrics: vi.fn().mockReturnValue(""),
    });
  }

  return { indexerInstances, MockIndexer };
});

vi.mock("../src/indexer/index.js", () => ({
  Indexer: MockIndexer,
}));

import { parseConfig } from "../src/config/schema.js";
import { loadMergedConfig } from "../src/config/merger.js";
import { IndexLockContentionError } from "../src/indexer/index-lock.js";
import { add_knowledge_base, index_codebase, index_health_check, initializeTools, remove_knowledge_base } from "../src/tools/index.js";

describe("knowledge base tool config refresh", () => {
  let tempDir: string;
  let kbDir: string;

  beforeEach(() => {
    indexerInstances.length = 0;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tools-test-"));
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-source-"));
    initializeTools(tempDir, parseConfig({ indexing: { watchFiles: false } }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
  });

  it("returns an explicit busy result from the OpenCode health-check tool", async () => {
    const owner = {
      pid: 4242,
      hostname: "local-test",
      startedAt: "2026-07-17T10:00:00.000Z",
      operation: "health-check" as const,
      token: "owner-token",
    };
    indexerInstances[0]?.healthCheck.mockRejectedValueOnce(
      new IndexLockContentionError(path.join(tempDir, ".opencode", "index", "indexing.lock"), owner, "active"),
    );

    const result = await index_health_check.execute({});

    expect(result).toContain("INDEX_BUSY");
    expect(result).toContain("PID 4242");
    expect(result).toContain("operation health-check");
    expect(result).toContain(owner.startedAt);
  });

  it("rebuilds the shared indexer after adding a knowledge base", async () => {
    await add_knowledge_base.execute({ path: kbDir });

    expect(indexerInstances).toHaveLength(2);
    expect(indexerInstances[1]?.projectRoot).toBe(tempDir);
    expect(indexerInstances[1]?.config.knowledgeBases).toEqual([path.normalize(kbDir)]);
  });

  it("rebuilds the shared indexer after removing a knowledge base", async () => {
    await add_knowledge_base.execute({ path: kbDir });
    await remove_knowledge_base.execute({ path: kbDir });

    expect(indexerInstances).toHaveLength(3);
    expect(indexerInstances[2]?.projectRoot).toBe(tempDir);
    expect(indexerInstances[2]?.config.knowledgeBases).toEqual([]);
  });

  it("materializes a local config boundary for fresh worktree knowledge base edits", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(
      mainConfigPath,
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
        knowledgeBases: [],
      }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    await add_knowledge_base.execute({ path: kbDir });

    const localConfigPath = path.join(worktreeDir, ".opencode", "codebase-index.json");
    const savedMainConfig = JSON.parse(fs.readFileSync(mainConfigPath, "utf-8")) as { knowledgeBases?: string[] };
    const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf-8")) as { knowledgeBases?: string[] };
    expect(savedMainConfig.knowledgeBases).toEqual([]);
    expect(localConfig.knowledgeBases).toEqual([path.normalize(kbDir)]);
    expect(indexerInstances.at(-1)?.projectRoot).toBe(worktreeDir);
    expect(indexerInstances.at(-1)?.config.knowledgeBases).toEqual([path.normalize(kbDir)]);
  });

  it("keeps repo-local inherited knowledge bases relative when materializing a local boundary", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, "docs", "reference"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(
      mainConfigPath,
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
        knowledgeBases: ["docs/reference"],
      }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    await add_knowledge_base.execute({ path: kbDir });

    const localConfigPath = path.join(worktreeDir, ".opencode", "codebase-index.json");
    const savedMainConfig = JSON.parse(fs.readFileSync(mainConfigPath, "utf-8")) as { knowledgeBases?: string[] };
    const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf-8")) as { knowledgeBases?: string[] };
    expect(savedMainConfig.knowledgeBases).toEqual(["docs/reference"]);
    expect(localConfig.knowledgeBases).toEqual(["docs/reference", path.normalize(kbDir)]);
  });

  it("preserves additionalInclude globs when tools rewrite local config", async () => {
    const configPath = path.join(tempDir, ".opencode", "codebase-index.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
        additionalInclude: ["docs/**/*.md"],
        knowledgeBases: [],
      }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(tempDir, parseConfig(loadMergedConfig(tempDir)));

    await add_knowledge_base.execute({ path: kbDir });

    const savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      additionalInclude?: string[];
      knowledgeBases?: string[];
    };
    expect(savedConfig.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(savedConfig.knowledgeBases).toEqual([path.normalize(kbDir)]);
    expect(indexerInstances.at(-1)?.config.additionalInclude).toEqual(["docs/**/*.md"]);
  });

  it("preserves inherited additionalInclude globs when materializing a local config boundary", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(
      mainConfigPath,
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
        additionalInclude: ["docs/**/*.md"],
        knowledgeBases: [],
      }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    await add_knowledge_base.execute({ path: kbDir });

    const localConfigPath = path.join(worktreeDir, ".opencode", "codebase-index.json");
    const savedMainConfig = JSON.parse(fs.readFileSync(mainConfigPath, "utf-8")) as {
      additionalInclude?: string[];
      knowledgeBases?: string[];
    };
    const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf-8")) as {
      additionalInclude?: string[];
      knowledgeBases?: string[];
    };
    expect(savedMainConfig.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(savedMainConfig.knowledgeBases).toEqual([]);
    expect(localConfig.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(localConfig.knowledgeBases).toEqual([path.normalize(kbDir)]);
    expect(indexerInstances.at(-1)?.config.additionalInclude).toEqual(["docs/**/*.md"]);
  });

  it("deduplicates knowledge base paths that only differ by trailing separators", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tools-home-"));

    try {
      vi.stubEnv("HOME", homeDir);
      const globalConfigPath = path.join(homeDir, ".config", "opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(
        globalConfigPath,
        JSON.stringify({ knowledgeBases: [`${kbDir}/`] }, null, 2),
        "utf-8"
      );

      const configPath = path.join(tempDir, ".opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ knowledgeBases: [kbDir] }, null, 2),
        "utf-8"
      );

      const merged = loadMergedConfig(tempDir) as { knowledgeBases?: string[] };
      expect(merged.knowledgeBases).toEqual([path.normalize(kbDir)]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes upgraded worktree knowledge base edits to a local config boundary when a local index already exists", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(
      mainConfigPath,
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-model",
          dimensions: 8,
        },
        indexing: { watchFiles: false },
        knowledgeBases: [],
      }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    await add_knowledge_base.execute({ path: kbDir });

    const localConfigPath = path.join(worktreeDir, ".opencode", "codebase-index.json");
    const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf-8")) as { knowledgeBases?: string[] };
    const savedMainConfig = JSON.parse(fs.readFileSync(mainConfigPath, "utf-8")) as { knowledgeBases?: string[] };

    expect(localConfig.knowledgeBases).toEqual([path.normalize(kbDir)]);
    expect(savedMainConfig.knowledgeBases).toEqual([]);
    expect(indexerInstances.at(-1)?.projectRoot).toBe(worktreeDir);
    expect(indexerInstances.at(-1)?.config.knowledgeBases).toEqual([path.normalize(kbDir)]);
  });

  it("localizes force rebuilds before probing inherited project indexes", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["docs/reference"] }, null, 2),
      "utf-8"
    );

    indexerInstances.length = 0;
    initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    await index_codebase.execute({ force: true, estimateOnly: false, verbose: false }, {
      metadata: () => undefined,
    });

    expect(indexerInstances[0]?.getStatus).not.toHaveBeenCalled();
    expect(indexerInstances.length).toBeGreaterThanOrEqual(2);
    const localConfig = JSON.parse(fs.readFileSync(path.join(worktreeDir, ".opencode", "codebase-index.json"), "utf-8")) as {
      knowledgeBases?: string[];
    };
    expect(localConfig.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("does not snapshot global-only settings when materializing a local config boundary", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-tools-home-"));
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    try {
      vi.stubEnv("HOME", homeDir);
      fs.mkdirSync(path.join(homeDir, ".config", "opencode"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".config", "opencode", "codebase-index.json"),
        JSON.stringify({ debug: { enabled: true } }, null, 2),
        "utf-8"
      );

      fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
      fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
      fs.mkdirSync(worktreeGitDir, { recursive: true });
      fs.mkdirSync(worktreeDir, { recursive: true });

      fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
      fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
      fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
      fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

      const mainConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
      fs.writeFileSync(
        mainConfigPath,
        JSON.stringify({ knowledgeBases: [] }, null, 2),
        "utf-8"
      );

      indexerInstances.length = 0;
      initializeTools(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

      await add_knowledge_base.execute({ path: kbDir });

      const localConfigPath = path.join(worktreeDir, ".opencode", "codebase-index.json");
      const localConfig = JSON.parse(fs.readFileSync(localConfigPath, "utf-8")) as {
        knowledgeBases?: string[];
        debug?: { enabled?: boolean };
      };

      expect(localConfig.knowledgeBases).toEqual([path.normalize(kbDir)]);
      expect(localConfig).not.toHaveProperty("debug");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
