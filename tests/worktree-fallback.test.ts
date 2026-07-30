import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadMergedConfig } from "../src/config/merger.js";
import { parseConfig } from "../src/config/schema.js";
import { resolveProjectConfigPath, resolveProjectIndexPath, resolveWritableProjectConfigPath } from "../src/config/paths.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, hashContent, InvertedIndex, VectorStore } from "../src/native/index.js";

function readBranchFileHashes(indexPath: string, branch: string): Record<string, string> {
  const branchHash = hashContent(branch).slice(0, 16);
  return JSON.parse(
    fs.readFileSync(path.join(indexPath, `file-hashes.${branchHash}.json`), "utf-8"),
  ) as Record<string, string>;
}

describe("worktree fallback (issue #60)", () => {
  let tempDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let worktreeGitDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-"));
    mainRepoDir = path.join(tempDir, "main-repo");
    worktreeDir = path.join(tempDir, "worktree-feature");
    worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x", "y"), "2222222222222222222222222222222222222222\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature/x/y\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          scope: "project",
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: ["docs/reference"],
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads project config from the main repo when the worktree has no local config", () => {
    const configPath = resolveProjectConfigPath(worktreeDir, "opencode");
    const loaded = loadMergedConfig(worktreeDir, "opencode") as Record<string, unknown>;

    expect(configPath).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.scope).toBe("project");
    expect(loaded.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("throws a file-specific error when the inherited project config is malformed", () => {
    const configPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(configPath, '{"embeddingProvider":"custom",', "utf-8");

    expect(() => loadMergedConfig(worktreeDir, "opencode")).toThrow(
      new RegExp(`Failed to load config file ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });

  it("throws a file-specific error when the inherited project config has an invalid shape", () => {
    const configPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(configPath, JSON.stringify({ knowledgeBases: "docs/reference" }, null, 2), "utf-8");

    expect(() => loadMergedConfig(worktreeDir, "opencode")).toThrow(/field 'knowledgeBases' must be an array of strings/);
  });

  it("throws a file-specific error when the global config is malformed", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-home-"));

    try {
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("USERPROFILE", homeDir);
      const globalConfigPath = path.join(homeDir, ".config", "opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, '{"debug":', "utf-8");

      const repoConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
      fs.rmSync(repoConfigPath, { force: true });

      expect(() => loadMergedConfig(worktreeDir, "opencode")).toThrow(
        new RegExp(`Failed to load config file ${globalConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to project config when the global config is malformed", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-home-"));

    try {
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("USERPROFILE", homeDir);
      const globalConfigPath = path.join(homeDir, ".config", "opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, '{"debug":', "utf-8");

      const loaded = loadMergedConfig(worktreeDir, "opencode") as Record<string, unknown>;

      expect(loaded.scope).toBe("project");
      expect(loaded.additionalInclude).toEqual(["docs/**/*.md"]);
      expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps project object overrides as wholesale replacements instead of deep-merging", () => {
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("USERPROFILE", tempDir);
    const globalConfigPath = path.join(tempDir, ".config", "opencode", "codebase-index.json");

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify(
        {
          indexing: {
            autoIndex: true,
            maxFileSize: 12345,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
        },
        null,
        2,
      ),
      "utf-8"
    );

    const loaded = loadMergedConfig(worktreeDir, "opencode") as {
      indexing?: Record<string, unknown>;
    };

    expect(loaded.indexing).toEqual({ watchFiles: false });
  });

  it("rebases inherited absolute repo-local knowledge bases onto the worktree", () => {
    const absoluteRepoLocalKb = path.join(mainRepoDir, "docs", "reference");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          scope: "project",
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: [absoluteRepoLocalKb],
        },
        null,
        2
      ),
      "utf-8"
    );

    const loaded = loadMergedConfig(worktreeDir, "opencode") as Record<string, unknown>;

    expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("shares the main project index when the worktree inherits its config", async () => {
    const config = parseConfig(loadMergedConfig(worktreeDir, "opencode"));
    const indexer = new Indexer(worktreeDir, config, "opencode");
    try {
      const status = await indexer.getStatus();
      const sharedIndexPath = path.join(mainRepoDir, ".opencode", "index");

      expect(resolveProjectIndexPath(worktreeDir, "project", "opencode")).toBe(sharedIndexPath);
      expect(status.indexPath).toBe(sharedIndexPath);
      expect(status.currentBranch).toBe("feature/x/y");
    } finally {
      await indexer.close();
    }
  });

  it("rebinds branch-scoped runtime caches when one Indexer switches branches", async () => {
    const mainSourcePath = path.join(mainRepoDir, "src", "branch-marker.ts");
    const mainContent = "export function mainBranchMarker() { return 'main'; }\n";
    const featureContent = "export function featureBranchMarker() { return 'feature'; }\n";
    fs.mkdirSync(path.dirname(mainSourcePath), { recursive: true });
    fs.writeFileSync(mainSourcePath, mainContent, "utf-8");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: texts.map((text) => ({
          embedding: Array.from({ length: 8 }, (_, index) => ((text.length + index * 17) % 997) / 997),
        })),
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const indexer = new Indexer(mainRepoDir, parseConfig(loadMergedConfig(mainRepoDir)));
    const runtimePaths = indexer as unknown as {
      fileHashCachePath: string;
      failedBatchesPath: string;
    };
    const sharedIndexPath = fs.realpathSync.native(path.join(mainRepoDir, ".opencode", "index"));
    const mainNamespace = hashContent("main").slice(0, 16);
    const featureNamespace = hashContent("feature/x/y").slice(0, 16);

    try {
      await indexer.index();
      const fetchesAfterMain = fetchSpy.mock.calls.length;
      expect(runtimePaths.fileHashCachePath).toBe(
        path.join(sharedIndexPath, `file-hashes.${mainNamespace}.json`),
      );
      expect(runtimePaths.failedBatchesPath).toBe(
        path.join(sharedIndexPath, `failed-batches.${mainNamespace}.json`),
      );
      const mainHashes = readBranchFileHashes(sharedIndexPath, "main");

      fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/feature/x/y\n");
      fs.writeFileSync(mainSourcePath, featureContent, "utf-8");
      await indexer.index();

      expect(indexer.getCurrentBranch()).toBe("feature/x/y");
      expect(runtimePaths.fileHashCachePath).toBe(
        path.join(sharedIndexPath, `file-hashes.${featureNamespace}.json`),
      );
      expect(runtimePaths.failedBatchesPath).toBe(
        path.join(sharedIndexPath, `failed-batches.${featureNamespace}.json`),
      );
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(fetchesAfterMain);
      expect(readBranchFileHashes(sharedIndexPath, "feature/x/y")).not.toEqual(mainHashes);

      const database = new Database(path.join(sharedIndexPath, "codebase.db"));
      try {
        expect(database.getBranchChunkIds("main").length).toBeGreaterThan(0);
        expect(database.getBranchChunkIds("feature/x/y").length).toBeGreaterThan(0);
        expect(database.getSymbolsForBranch("main").some((symbol) => symbol.name === "mainBranchMarker")).toBe(true);
        expect(database.getSymbolsForBranch("feature/x/y").some((symbol) => symbol.name === "featureBranchMarker")).toBe(true);
      } finally {
        database.close();
      }

      fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(mainSourcePath, mainContent, "utf-8");
      await expect(indexer.getIndexFreshness()).resolves.toMatchObject({
        readable: true,
        current: true,
      });
      expect(indexer.getCurrentBranch()).toBe("main");
      expect(runtimePaths.fileHashCachePath).toBe(
        path.join(sharedIndexPath, `file-hashes.${mainNamespace}.json`),
      );
    } finally {
      await indexer.close();
      fetchSpy.mockRestore();
    }
  });

  it("shares portable branch catalogs without re-embedding identical worktree content", async () => {
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);

    const sourceContent = "export function sharedPortableMarker() { return 'shared-portable-index'; }\n";
    const mainSourcePath = path.join(mainRepoDir, "src", "worktree-marker.ts");
    const worktreeSourcePath = path.join(worktreeDir, "src", "worktree-marker.ts");
    const storedSourcePath = "src/worktree-marker.ts";
    const staleWorktreeIndexPath = path.join(worktreeDir, ".opencode", "index");
    fs.mkdirSync(path.dirname(mainSourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(worktreeSourcePath), { recursive: true });
    fs.mkdirSync(staleWorktreeIndexPath, { recursive: true });
    fs.writeFileSync(mainSourcePath, sourceContent, "utf-8");
    fs.writeFileSync(worktreeSourcePath, sourceContent, "utf-8");
    fs.writeFileSync(path.join(staleWorktreeIndexPath, "legacy-marker"), "stale", "utf-8");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        const seed = Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0);
        return {
          embedding: Array.from({ length: 8 }, (_, index) => ((seed + index * 17) % 997) / 997),
        };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const mainConfig = parseConfig(loadMergedConfig(mainRepoDir, "opencode"));
    const worktreeConfig = parseConfig(loadMergedConfig(worktreeDir, "opencode"));
    const mainIndexer = new Indexer(mainRepoDir, mainConfig, "opencode");
    const worktreeIndexer = new Indexer(worktreeDir, worktreeConfig, "opencode");
    const indexers = [mainIndexer, worktreeIndexer];
    const sharedIndexPath = path.join(mainRepoDir, ".opencode", "index");

    try {
      const mainStats = await mainIndexer.index();
      await mainIndexer.close();
      const requestsAfterMain = fetchSpy.mock.calls.length;
      expect(requestsAfterMain).toBeGreaterThan(0);

      const databaseBeforeWorktree = new Database(path.join(sharedIndexPath, "codebase.db"));
      const statsBeforeWorktree = databaseBeforeWorktree.getStats();
      const mainChunkIds = databaseBeforeWorktree.getBranchChunkIds("main").sort();
      const mainSymbolIds = databaseBeforeWorktree.getBranchSymbolIds("main").sort();
      databaseBeforeWorktree.close();

      const worktreeStats = await worktreeIndexer.index();
      await worktreeIndexer.close();

      expect(resolveProjectIndexPath(mainRepoDir, "project", "opencode")).toBe(sharedIndexPath);
      expect(resolveProjectIndexPath(worktreeDir, "project", "opencode")).toBe(sharedIndexPath);
      expect(fs.readFileSync(path.join(staleWorktreeIndexPath, "legacy-marker"), "utf-8")).toBe("stale");
      expect(worktreeStats.tokensUsed).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(requestsAfterMain);

      const database = new Database(path.join(sharedIndexPath, "codebase.db"));
      const statsAfterWorktree = database.getStats();
      const featureChunkIds = database.getBranchChunkIds("feature/x/y").sort();
      const featureSymbolIds = database.getBranchSymbolIds("feature/x/y").sort();
      const rawChunks = mainChunkIds.map((chunkId) => database.getChunk(chunkId));
      const rawSymbols = database.getSymbolsForBranch("main");

      expect(mainStats.indexedChunks).toBeGreaterThan(0);
      expect(mainChunkIds.length).toBeGreaterThan(0);
      expect(mainSymbolIds.length).toBeGreaterThan(0);
      expect(database.getAllBranches().sort()).toEqual(["feature/x/y", "main"]);
      expect(featureChunkIds).toEqual(mainChunkIds);
      expect(featureSymbolIds).toEqual(mainSymbolIds);
      expect(statsAfterWorktree.embeddingCount).toBe(statsBeforeWorktree.embeddingCount);
      expect(statsAfterWorktree.chunkCount).toBe(statsBeforeWorktree.chunkCount);
      expect(statsAfterWorktree.symbolCount).toBe(statsBeforeWorktree.symbolCount);
      expect(statsAfterWorktree.branchCount).toBe(2);
      expect(statsAfterWorktree.branchChunkCount).toBe(statsBeforeWorktree.branchChunkCount * 2);
      expect(rawChunks.every((chunk) => chunk?.filePath === storedSourcePath)).toBe(true);
      expect(rawSymbols.some((symbol) => symbol.name === "sharedPortableMarker")).toBe(true);
      expect(rawSymbols.every((symbol) => symbol.filePath === storedSourcePath)).toBe(true);
      database.close();

      const vectorStore = new VectorStore(path.join(sharedIndexPath, "vectors"), 8);
      vectorStore.loadStrict();
      const rawVectorMetadata = vectorStore.getAllMetadata();
      expect(rawVectorMetadata).toHaveLength(statsAfterWorktree.chunkCount);
      expect(rawVectorMetadata.every(({ metadata }) => metadata.filePath === storedSourcePath)).toBe(true);

      const mainFileHashes = readBranchFileHashes(sharedIndexPath, "main");
      const featureFileHashes = readBranchFileHashes(sharedIndexPath, "feature/x/y");
      expect(Object.keys(mainFileHashes)).toEqual([storedSourcePath]);
      expect(featureFileHashes).toEqual(mainFileHashes);
      expect(path.isAbsolute(storedSourcePath)).toBe(false);
      expect(storedSourcePath).not.toContain("\\");

      const mainReader = new Indexer(mainRepoDir, mainConfig, "opencode");
      const worktreeReader = new Indexer(worktreeDir, worktreeConfig, "opencode");
      indexers.push(mainReader, worktreeReader);
      const mainResults = await mainReader.search("sharedPortableMarker", 5, { metadataOnly: true });
      const mainSymbols = await mainReader.getSymbolsForBranch();
      const mainSymbolsForFile = await mainReader.getSymbolsForFiles([mainSourcePath]);
      const worktreeResults = await worktreeReader.search("sharedPortableMarker", 5, { metadataOnly: true });
      const worktreeSymbols = await worktreeReader.getSymbolsForBranch();
      const worktreeSymbolsForFile = await worktreeReader.getSymbolsForFiles([worktreeSourcePath]);

      expect(mainResults.find((result) => result.name === "sharedPortableMarker")?.filePath).toBe(mainSourcePath);
      expect(worktreeResults.find((result) => result.name === "sharedPortableMarker")?.filePath).toBe(worktreeSourcePath);
      expect(mainSymbols.find((symbol) => symbol.name === "sharedPortableMarker")?.filePath).toBe(mainSourcePath);
      expect(worktreeSymbols.find((symbol) => symbol.name === "sharedPortableMarker")?.filePath).toBe(worktreeSourcePath);
      expect(mainSymbolsForFile.find((symbol) => symbol.name === "sharedPortableMarker")?.filePath).toBe(mainSourcePath);
      expect(worktreeSymbolsForFile.find((symbol) => symbol.name === "sharedPortableMarker")?.filePath).toBe(worktreeSourcePath);
    } finally {
      await Promise.all(indexers.map((indexer) => indexer.close()));
      fetchSpy.mockRestore();
    }
  });

  it("keeps shared project search results strictly scoped to the active branch", async () => {
    const mainSourceDir = path.join(mainRepoDir, "src");
    const featureSourcePath = path.join(worktreeDir, "src", "feature-only.ts");
    fs.mkdirSync(mainSourceDir, { recursive: true });
    fs.mkdirSync(path.dirname(featureSourcePath), { recursive: true });
    for (let index = 0; index < 6; index++) {
      fs.writeFileSync(
        path.join(mainSourceDir, `main-only-${index}.ts`),
        `export function mainOnlyBranchMarker${index}() { return 'main-only-${index}'; }\n`,
        "utf-8",
      );
    }
    fs.writeFileSync(
      featureSourcePath,
      "export function featureOnlyBranchMarker() { return 'feature-only'; }\n",
      "utf-8",
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: texts.map((text, index) => ({
          embedding: Array.from(
            { length: 8 },
            (_, dimension) => ((text.length + index * 13 + dimension * 17) % 997) / 997,
          ),
        })),
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const mainIndexer = new Indexer(mainRepoDir, parseConfig(loadMergedConfig(mainRepoDir)));
    const worktreeIndexer = new Indexer(worktreeDir, parseConfig(loadMergedConfig(worktreeDir)));

    try {
      await mainIndexer.index();
      await worktreeIndexer.index();

      const runtime = worktreeIndexer as unknown as {
        database: Database;
        invertedIndex: InvertedIndex;
        store: VectorStore;
      };
      const featureChunkIds = new Set(runtime.database.getBranchChunkIds("feature/x/y"));
      const featureChunkId = Array.from(featureChunkIds).find(
        (chunkId) => runtime.store.getMetadata(chunkId)?.name === "featureOnlyBranchMarker",
      );
      expect(featureChunkId).toBeDefined();
      const featureMetadata = runtime.store.getMetadata(featureChunkId!);
      expect(featureMetadata).toBeDefined();
      const foreignCandidates = runtime.database.getBranchChunkIds("main")
        .filter((chunkId) => !featureChunkIds.has(chunkId))
        .map((chunkId) => ({ chunkId, metadata: runtime.store.getMetadata(chunkId) }))
        .filter((candidate) => candidate.metadata?.name?.startsWith("mainOnlyBranchMarker"))
        .slice(0, 5)
        .map(({ chunkId, metadata }, index) => ({
          id: chunkId,
          score: 0.99 - index * 0.01,
          metadata: metadata!,
        }));
      expect(foreignCandidates).toHaveLength(5);
      const activeCandidate = {
        id: featureChunkId!,
        score: 0.8,
        metadata: featureMetadata!,
      };
      const rankedCandidates = [...foreignCandidates, activeCandidate];
      const semanticSearchSpy = vi.spyOn(runtime.store, "search").mockImplementation(
        (_embedding, requestedLimit = 10) => rankedCandidates.slice(0, requestedLimit),
      );
      const keywordSearchSpy = vi.spyOn(runtime.invertedIndex, "search").mockImplementation(
        (_query, requestedLimit = 100) => new Map(
          rankedCandidates.slice(0, requestedLimit).map((candidate) => [candidate.id, candidate.score]),
        ),
      );

      const scopedSearch = await worktreeIndexer.search(
        "ranked branch retrieval probe",
        1,
        { metadataOnly: true },
      );
      expect(scopedSearch[0]?.name).toBe("featureOnlyBranchMarker");
      expect(semanticSearchSpy.mock.calls.some(([, requestedLimit]) => requestedLimit > 4)).toBe(true);
      expect(keywordSearchSpy.mock.calls.some(([, requestedLimit]) => (requestedLimit ?? 0) > 4)).toBe(true);

      semanticSearchSpy.mockClear();
      const scopedSimilar = await worktreeIndexer.findSimilar("ranked branch retrieval probe", 1);
      expect(scopedSimilar[0]?.name).toBe("featureOnlyBranchMarker");
      expect(semanticSearchSpy.mock.calls.some(([, requestedLimit]) => requestedLimit > 2)).toBe(true);

      semanticSearchSpy.mockImplementation(
        (_embedding, requestedLimit = 10) => foreignCandidates.slice(0, requestedLimit),
      );
      keywordSearchSpy.mockImplementation(
        (_query, requestedLimit = 100) => new Map(
          foreignCandidates.slice(0, requestedLimit).map((candidate) => [candidate.id, candidate.score]),
        ),
      );
      await expect(
        worktreeIndexer.search("ranked branch retrieval probe", 1, { metadataOnly: true }),
      ).resolves.toEqual([]);
      await expect(
        worktreeIndexer.findSimilar("ranked branch retrieval probe", 1),
      ).resolves.toEqual([]);

      const unscopedSearch = await worktreeIndexer.search(
        "ranked branch retrieval probe",
        1,
        { metadataOnly: true, filterByBranch: false },
      );
      const unscopedSimilar = await worktreeIndexer.findSimilar(
        "ranked branch retrieval probe",
        1,
        { filterByBranch: false },
      );
      expect(unscopedSearch[0]?.name).toBe(foreignCandidates[0]?.metadata.name);
      expect(unscopedSimilar[0]?.name).toBe(foreignCandidates[0]?.metadata.name);

      for (const branch of runtime.database.getAllBranches()) {
        runtime.database.clearBranch(branch);
        runtime.database.clearBranchSymbols(branch);
      }
      expect(runtime.database.getAllBranches()).toEqual([]);
      expect(
        (await worktreeIndexer.search("ranked branch retrieval probe", 1, { metadataOnly: true }))[0]?.name,
      ).toBe(foreignCandidates[0]?.metadata.name);
      expect(
        (await worktreeIndexer.findSimilar("ranked branch retrieval probe", 1))[0]?.name,
      ).toBe(foreignCandidates[0]?.metadata.name);
    } finally {
      await Promise.all([mainIndexer.close(), worktreeIndexer.close()]);
      fetchSpy.mockRestore();
    }
  });

  it("keeps an explicit worktree-local config and its project index local", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ scope: "project", knowledgeBases: ["worktree-only"] }, null, 2),
      "utf-8"
    );

    const configPath = resolveProjectConfigPath(worktreeDir, "opencode");
    const indexPath = resolveProjectIndexPath(worktreeDir, "project", "opencode");
    const loaded = loadMergedConfig(worktreeDir, "opencode") as Record<string, unknown>;

    expect(configPath).toBe(path.join(worktreeDir, ".opencode", "codebase-index.json"));
    expect(indexPath).toBe(path.join(worktreeDir, ".opencode", "index"));
    expect(loaded.knowledgeBases).toEqual(["worktree-only"]);
  });

  it("ignores a stale worktree-local index while inheriting main config", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });

    expect(resolveWritableProjectConfigPath(worktreeDir, "opencode")).toBe(path.join(worktreeDir, ".opencode", "codebase-index.json"));
    expect(resolveProjectConfigPath(worktreeDir, "opencode")).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(resolveProjectIndexPath(worktreeDir, "project", "opencode")).toBe(path.join(mainRepoDir, ".opencode", "index"));
  });

  it("keeps explicit worktree-local config and index when they exist", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });

    fs.writeFileSync(
      path.join(worktreeDir, ".opencode", "codebase-index.json"),
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "worktree-model",
          dimensions: 16,
        },
        scope: "project",
      }, null, 2),
      "utf-8"
    );

    expect(resolveProjectIndexPath(worktreeDir, "project", "opencode")).toBe(path.join(worktreeDir, ".opencode", "index"));
  });
});
