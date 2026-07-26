import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadMergedConfig } from "../src/config/merger.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, InvertedIndex, VectorStore } from "../src/native/index.js";
import { hashContent } from "../src/native/index.js";

describe("indexer clearIndex force rebuild", () => {
  let tempDir: string;
  let sourceFile: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let embeddingDimensions = 8;
  let tempHome: string;

  beforeEach(() => {
    embeddingDimensions = 8;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from(
          { length: embeddingDimensions },
          (_, idx) => ((seed + idx * 17) % 997) / 997
        );
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * embeddingDimensions) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-index-indexer-"));
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "clear-index-home-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    sourceFile = path.join(tempDir, "src", "index.ts");
    fs.writeFileSync(
      sourceFile,
      [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return alpha();",
        "}",
      ].join("\n"),
      "utf-8"
    );
  });

  let _indexers: Indexer[] = [];
  let _dbs: Database[] = [];

  function trackIndexer(i: Indexer): Indexer { _indexers.push(i); return i; }
  function trackDb(d: Database): Database { _dbs.push(d); return d; }

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _dbs.forEach((d) => d.close());
    _indexers = [];
    _dbs = [];
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function createIndexer(projectRoot: string, dimensions: number, scope: "project" | "global" = "project"): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: `mock-${dimensions}d`,
        dimensions,
      },
      scope,
      debug: {
        enabled: true,
        logLevel: "warn",
        logSearch: false,
        logEmbedding: false,
        logCache: false,
        logGc: false,
        logBranch: false,
        metrics: false,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return trackIndexer(new Indexer(projectRoot, config));
  }

  it("clears persisted embeddings before a force rebuild with new dimensions", async () => {
    embeddingDimensions = 8;
    const originalIndexer = createIndexer(tempDir, 8);
    const originalStats = await originalIndexer.index();
    expect(originalStats.failedChunks).toBe(0);
    expect(originalStats.indexedChunks).toBeGreaterThan(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const seededDb = trackDb(new Database(dbPath));
    expect(seededDb.getStats().embeddingCount).toBeGreaterThan(0);

    embeddingDimensions = 4;
    const rebuiltIndexer = createIndexer(tempDir, 4);
    await rebuiltIndexer.clearIndex();

    const clearedDb = trackDb(new Database(dbPath));
    expect(clearedDb.getStats().embeddingCount).toBe(0);
    expect(clearedDb.getStats().chunkCount).toBe(0);
    expect(clearedDb.getStats().branchChunkCount).toBe(0);

    const rebuiltStats = await rebuiltIndexer.index();
    expect(rebuiltStats.failedChunks).toBe(0);
    expect(rebuiltStats.indexedChunks).toBeGreaterThan(0);

    const rebuiltDb = trackDb(new Database(dbPath));
    const rebuiltBranch = rebuiltDb.getAllBranches()[0];
    expect(rebuiltBranch).toBeTruthy();
    const rebuiltChunkId = rebuiltDb.getBranchChunkIds(rebuiltBranch!)[0];
    expect(rebuiltChunkId).toBeTruthy();
    const rebuiltChunk = rebuiltDb.getChunk(rebuiltChunkId!);
    expect(rebuiltChunk).not.toBeNull();
    const embeddingBuffer = rebuiltDb.getEmbedding(rebuiltChunk!.contentHash);
    expect(embeddingBuffer).not.toBeNull();
    const floatCount = embeddingBuffer!.byteLength / Float32Array.BYTES_PER_ELEMENT;
    expect(floatCount).toBe(4);
  });

  it("marks older embedding strategy metadata as incompatible until force rebuild", async () => {
    embeddingDimensions = 8;
    const indexer = createIndexer(tempDir, 8);
    const stats = await indexer.index();
    expect(stats.failedChunks).toBe(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    db.setMetadata("index.embeddingStrategyVersion", "1");

    const restartedIndexer = createIndexer(tempDir, 8);
    const status = await restartedIndexer.getStatus();

    expect(status.compatibility?.compatible).toBe(false);
    expect(status.compatibility?.reason).toContain("Embedding strategy mismatch");
    await expect(restartedIndexer.index()).rejects.toThrow("Run index_codebase with force=true to rebuild the index");
  });

  it("keeps an in-flight search usable while the same Indexer reloads for a mutation", async () => {
    const indexer = createIndexer(tempDir, 8);
    await indexer.index();
    const immediateFetch = fetchSpy.getMockImplementation()!;
    let releaseSearch: (() => void) | null = null;
    let notifySearchStarted: (() => void) | null = null;
    const searchStarted = new Promise<void>((resolve) => { notifySearchStarted = resolve; });
    fetchSpy.mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      if (body.input?.includes("slow query")) {
        notifySearchStarted?.();
        await new Promise<void>((resolve) => { releaseSearch = resolve; });
      }
      return immediateFetch(url, init);
    });

    const searchPromise = indexer.search("slow query");
    await searchStarted;
    await expect(indexer.index()).resolves.toMatchObject({ failedChunks: 0 });
    releaseSearch?.();

    await expect(searchPromise).resolves.toEqual(expect.any(Array));
  });

  it("reloads persisted state only once for a force mutation lease", async () => {
    const indexer = createIndexer(tempDir, 8);
    await indexer.index();
    const vectorLoad = vi.spyOn(VectorStore.prototype, "load");
    const invertedLoad = vi.spyOn(InvertedIndex.prototype, "load");

    await indexer.forceIndex();

    expect(vectorLoad).toHaveBeenCalledOnce();
    expect(invertedLoad).toHaveBeenCalledOnce();
    vectorLoad.mockRestore();
    invertedLoad.mockRestore();
  });

  it("rejects force clearing an inherited project index from a fresh worktree", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo");
    const worktreeDir = path.join(tempDir, "worktree-feature");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
    const mainSourceFile = path.join(mainRepoDir, "src", "index.ts");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(path.dirname(mainSourceFile), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-8d",
          dimensions: 8,
        },
        indexing: {
          watchFiles: false,
          retries: 0,
          retryDelayMs: 1,
        },
      }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(mainSourceFile, "export function alpha() { return 'a'; }\n", "utf-8");

    embeddingDimensions = 8;
    await createIndexer(mainRepoDir, 8).index();

    const inheritedIndexer = trackIndexer(new Indexer(worktreeDir, parseConfig(loadMergedConfig(worktreeDir))));
    await expect(inheritedIndexer.clearIndex()).rejects.toThrow(
      "Project-scoped force rebuild is unsafe while using an inherited worktree index"
    );
  });

  it("preserves an inherited project index when its crashed owner needs recovery", async () => {
    const mainRepoDir = path.join(tempDir, "main-repo-recovery");
    const worktreeDir = path.join(tempDir, "worktree-recovery");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "recovery");
    const mainSourceFile = path.join(mainRepoDir, "src", "index.ts");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.dirname(mainSourceFile), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/recovery\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(mainRepoDir, ".opencode", "codebase-index.json"), JSON.stringify({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-8d", dimensions: 8 },
      scope: "project",
      indexing: { watchFiles: false, retries: 0, retryDelayMs: 1 },
    }, null, 2));
    fs.writeFileSync(mainSourceFile, "export function preserved() { return true; }\n");

    const mainIndexer = createIndexer(mainRepoDir, 8);
    await mainIndexer.index();
    await mainIndexer.close();
    const inheritedIndexPath = path.join(mainRepoDir, ".opencode", "index");
    const lockPath = path.join(inheritedIndexPath, "indexing.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }));

    const inheritedIndexer = trackIndexer(new Indexer(worktreeDir, parseConfig(loadMergedConfig(worktreeDir))));
    await expect(inheritedIndexer.index()).rejects.toThrow(
      "Interrupted indexing recovery is unsafe while using an inherited worktree index"
    );

    expect(fs.existsSync(path.join(inheritedIndexPath, "codebase.db"))).toBe(true);
    expect(fs.existsSync(path.join(inheritedIndexPath, "vectors"))).toBe(true);
    expect(fs.readdirSync(inheritedIndexPath).some((name) => name.startsWith("indexing.lock.recovery."))).toBe(true);
  });

  it("allows codex force clearing a local legacy OpenCode project index", async () => {
    embeddingDimensions = 8;
    const legacyIndexer = createIndexer(tempDir, 8);
    const legacyStats = await legacyIndexer.index();
    expect(legacyStats.failedChunks).toBe(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const seededDb = trackDb(new Database(dbPath));
    expect(seededDb.getStats().embeddingCount).toBeGreaterThan(0);

    const codexConfig = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });
    const codexIndexer = trackIndexer(new Indexer(tempDir, codexConfig, "codex"));

    await expect(codexIndexer.clearIndex()).resolves.toBeUndefined();

    const clearedDb = trackDb(new Database(dbPath));
    expect(clearedDb.getStats().embeddingCount).toBe(0);
    expect(clearedDb.getStats().chunkCount).toBe(0);
  });

  it("keeps mutations on the canonical index after a project symlink is retargeted", async () => {
    const indexParent = path.join(tempDir, ".opencode");
    const indexLink = path.join(indexParent, "index");
    const firstTarget = path.join(tempHome, "canonical-index-a");
    const secondTarget = path.join(tempHome, "canonical-index-b");
    fs.mkdirSync(indexParent, { recursive: true });
    fs.mkdirSync(firstTarget, { recursive: true });
    fs.mkdirSync(secondTarget, { recursive: true });
    fs.symlinkSync(firstTarget, indexLink, "dir");

    const indexer = createIndexer(tempDir, 8);
    await indexer.index();
    expect(fs.existsSync(path.join(firstTarget, "codebase.db"))).toBe(true);

    fs.unlinkSync(indexLink);
    fs.symlinkSync(secondTarget, indexLink, "dir");
    fs.writeFileSync(sourceFile, "export function canonicalUpdate() { return 'updated'; }\n", "utf-8");

    await indexer.index();

    expect(fs.existsSync(path.join(firstTarget, "codebase.db"))).toBe(true);
    expect(fs.existsSync(path.join(secondTarget, "codebase.db"))).toBe(false);
  });

  it("clears only the current project from a shared global index when compatibility is unchanged", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    const indexerA = createIndexer(projectA, 8, "global");
    const indexerB = createIndexer(projectB, 8, "global");

    await indexerA.index();
    await indexerB.index();

    const removeSpy = vi.spyOn(VectorStore.prototype, "remove").mockImplementation(() => {
      throw new Error("native remove should not be called during clearIndex");
    });

    await indexerA.clearIndex();

    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    expect(db.getChunksByFile(projectAFile)).toHaveLength(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);

    const remainingChunk = db.getChunksByFile(projectBFile)[0];
    const remainingBranch = db.getAllBranches().find((branch) => branch.endsWith(":default"));
    expect(remainingBranch).toBeTruthy();
    expect(db.chunkExistsOnBranch(remainingBranch!, remainingChunk.chunkId)).toBe(true);
    expect(db.getStats().embeddingCount).toBeGreaterThan(0);

    const fileHashCachePath = path.join(tempHome, ".opencode", "global-index", "file-hashes.json");
    const fileHashCache = JSON.parse(fs.readFileSync(fileHashCachePath, "utf-8")) as Record<string, string>;
    expect(fileHashCache[projectAFile]).toBeUndefined();
    expect(typeof fileHashCache[projectBFile]).toBe("string");
  });

  it("rebuilds the vector store during incremental removals without calling native remove", async () => {
    const indexer = createIndexer(tempDir, 8);
    await indexer.index();

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const dbBefore = trackDb(new Database(dbPath));
    const chunkIdsBefore = dbBefore.getChunksByFile(sourceFile).map((chunk) => chunk.chunkId);

    fs.writeFileSync(
      sourceFile,
      [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const removeSpy = vi.spyOn(VectorStore.prototype, "remove").mockImplementation(() => {
      throw new Error("native remove should not be called during incremental indexing");
    });

    const stats = await indexer.index();

    expect(stats.removedChunks).toBeGreaterThan(0);
    expect(stats.failedChunks).toBe(0);
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();

    const dbAfter = trackDb(new Database(dbPath));
    const chunkIdsAfter = new Set(dbAfter.getChunksByFile(sourceFile).map((chunk) => chunk.chunkId));
    expect(chunkIdsBefore.some((chunkId) => !chunkIdsAfter.has(chunkId))).toBe(true);
  });

  it("rejects an incompatible global force reset when the shared index contains other projects", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    embeddingDimensions = 8;
    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    embeddingDimensions = 4;
    const incompatibleIndexer = createIndexer(projectA, 4, "global");

    await expect(incompatibleIndexer.clearIndex()).rejects.toThrow(
      "Global index compatibility reset is unsafe"
    );

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    expect(db.getChunksByFile(projectAFile).length).toBeGreaterThan(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);
  });

  it("allows an incompatible global force reset when the current project is the only indexed tenant", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    embeddingDimensions = 8;
    await createIndexer(projectA, 8, "global").index();

    embeddingDimensions = 4;
    const rebuiltIndexer = createIndexer(projectA, 4, "global");
    await rebuiltIndexer.clearIndex();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    expect(db.getStats().embeddingCount).toBe(0);
    expect(db.getStats().chunkCount).toBe(0);

    const rebuiltStats = await rebuiltIndexer.index();
    expect(rebuiltStats.failedChunks).toBe(0);
    expect(rebuiltStats.indexedChunks).toBeGreaterThan(0);
  });

  it("allows a global embedding strategy rebuild without deleting other projects", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    const indexerA = createIndexer(projectA, 8, "global");
    const indexerB = createIndexer(projectB, 8, "global");

    await indexerA.index();
    await indexerB.index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const projectBHash = hashContent(path.resolve(projectB)).slice(0, 16);
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const restartedIndexerA = createIndexer(projectA, 8, "global");
    const statusBefore = await restartedIndexerA.getStatus();
    expect(statusBefore.compatibility?.compatible).toBe(false);
    expect(statusBefore.compatibility?.reason).toContain("Embedding strategy mismatch");

    await restartedIndexerA.clearIndex();

    expect(db.getChunksByFile(projectAFile)).toHaveLength(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);
    expect(db.getMetadata(`index.embeddingStrategyVersion.${projectAHash}`)).toBeNull();
    expect(db.getMetadata(`index.embeddingStrategyVersion.${projectBHash}`)).toBe("2");

    const rebuiltStats = await restartedIndexerA.index();
    expect(rebuiltStats.failedChunks).toBe(0);
    expect(rebuiltStats.indexedChunks).toBeGreaterThan(0);

    expect(db.getChunksByFile(projectAFile).length).toBeGreaterThan(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);
  });

  it("detects global embedding strategy mismatch from DB-only scoped state", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    const indexer = createIndexer(projectA, 8, "global");
    await indexer.index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const chunk = db.getChunksByFile(projectAFile)[0];
    const projectHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const branchKey = `${projectHash}:default`;

    db.setMetadata("index.embeddingStrategyVersion", "1");
    db.deleteMetadata(`index.embeddingStrategyVersion.${projectHash}`);
    db.deleteBranchChunksForBranch(branchKey, [chunk.chunkId]);
    db.addChunksToBranchBatch(branchKey, [chunk.chunkId]);

    const storeFile = path.join(tempHome, ".opencode", "global-index", "vectors.usearch");
    fs.rmSync(storeFile, { force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors"), { recursive: true, force: true });

    const restartedIndexer = createIndexer(projectA, 8, "global");
    const status = await restartedIndexer.getStatus();

    expect(status.compatibility?.compatible).toBe(false);
    expect(status.compatibility?.reason).toContain("Embedding strategy mismatch");
  });

  it("detects DB-only scoped mismatch on a non-default branch during startup", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.join(projectA, ".git", "refs", "heads", "feature"), { recursive: true });
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".git", "HEAD"), "ref: refs/heads/feature/test\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "feature", "test"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    const indexer = createIndexer(projectA, 8, "global");
    await indexer.index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const chunk = db.getChunksByFile(projectAFile)[0];
    const projectHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const branchKey = `${projectHash}:feature/test`;

    db.setMetadata("index.embeddingStrategyVersion", "1");
    db.deleteMetadata(`index.embeddingStrategyVersion.${projectHash}`);
    db.deleteBranchChunksForBranch(branchKey, [chunk.chunkId]);
    db.addChunksToBranchBatch(branchKey, [chunk.chunkId]);

    const storeFile = path.join(tempHome, ".opencode", "global-index", "vectors.usearch");
    fs.rmSync(storeFile, { force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors"), { recursive: true, force: true });

    const restartedIndexer = createIndexer(projectA, 8, "global");
    const status = await restartedIndexer.getStatus();

    expect(status.currentBranch).toBe("feature/test");
    expect(status.compatibility?.compatible).toBe(false);
    expect(status.compatibility?.reason).toContain("Embedding strategy mismatch");
  });

  it("detects file-hash-only scoped mismatch during startup status checks", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const branchKey = `${projectHash}:default`;

    db.setMetadata("index.embeddingStrategyVersion", "1");
    db.deleteMetadata(`index.embeddingStrategyVersion.${projectHash}`);
    db.clearBranch(branchKey);
    db.deleteChunksByFile(projectAFile);
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors.usearch"), { force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors"), { recursive: true, force: true });

    const status = await createIndexer(projectA, 8, "global").getStatus();

    expect(status.compatibility?.compatible).toBe(false);
    expect(status.compatibility?.reason).toContain("Embedding strategy mismatch");
  });

  it("detects symbol-only scoped mismatch during startup status checks", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const branchKey = `${projectHash}:default`;
    const projectSymbol = `sym_${hashContent(`${projectAFile}:alpha:function:1`).slice(0, 16)}`;

    db.setMetadata("index.embeddingStrategyVersion", "1");
    db.deleteMetadata(`index.embeddingStrategyVersion.${projectHash}`);
    db.clearBranch(branchKey);
    db.deleteBranchSymbolsForBranch(branchKey, [projectSymbol]);
    db.deleteChunksByFile(projectAFile);
    db.addSymbolsToBranchBatch(branchKey, [projectSymbol]);

    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors.usearch"), { force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tempHome, ".opencode", "global-index", "file-hashes.json"),
      JSON.stringify({}, null, 2),
      "utf-8"
    );

    expect(db.getBranchChunkIds(branchKey)).toHaveLength(0);
    expect(db.getBranchSymbolIds(branchKey)).toContain(projectSymbol);

    const status = await createIndexer(projectA, 8, "global").getStatus();

    expect(status.compatibility?.compatible).toBe(false);
    expect(status.compatibility?.reason).toContain("Embedding strategy mismatch");
  });

  it("re-embeds shared knowledge-base chunks after a global embedding strategy reset", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const kbDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const kbFile = path.join(kbDir, "docs", "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(kbFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const embedInputs: string[][] = [];
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      embedInputs.push(texts);

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from(
          { length: embeddingDimensions },
          (_, idx) => ((seed + idx * 17) % 997) / 997
        );
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * embeddingDimensions) },
        }),
        { status: 200 }
      );
    });

    const createKbIndexer = (projectRoot: string) => trackIndexer(new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [kbDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    })));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const beforeResetCalls = embedInputs.length;
    const restartedIndexer = createKbIndexer(projectA);
    await restartedIndexer.clearIndex();

    const resetStatus = await restartedIndexer.getStatus();
    expect(resetStatus.compatibility?.compatible).toBe(true);

    const rebuiltStats = await restartedIndexer.index();
    expect(rebuiltStats.failedChunks).toBe(0);

    const afterResetInputs = embedInputs.slice(beforeResetCalls).flat();
    expect(afterResetInputs.some((text) => text.includes("sharedDoc"))).toBe(true);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();
  });

  it("keeps forced re-embed pending across restart until a failed shared chunk is re-embedded", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const kbDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const kbFile = path.join(kbDir, "docs", "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(kbFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const kbPrompt = "export function sharedDoc() { return 'shared'; }";
    let failSharedKbEmbedding = false;
    const embedInputs: string[][] = [];
    fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      embedInputs.push(texts);

      if (failSharedKbEmbedding && texts.some((text) => text.includes(kbPrompt))) {
        return new Response(JSON.stringify({ error: "simulated shared kb failure" }), { status: 500 });
      }

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from(
          { length: embeddingDimensions },
          (_, idx) => ((seed + idx * 17) % 997) / 997
        );
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * embeddingDimensions) },
        }),
        { status: 200 }
      );
    });

    const createKbIndexer = (projectRoot: string) => trackIndexer(new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [kbDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    })));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const projectABranch = `${projectAHash}:default`;
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const resettingIndexer = createKbIndexer(projectA);
    await resettingIndexer.clearIndex();

    failSharedKbEmbedding = true;
    const failedStats = await resettingIndexer.index();
    expect(failedStats.failedChunks).toBeGreaterThan(0);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBe("true");

    const sharedChunkId = db.getChunksByFile(kbFile)[0]?.chunkId;
    expect(sharedChunkId).toBeTruthy();
    expect(db.chunkExistsOnBranch(projectABranch, sharedChunkId!)).toBe(false);

    failSharedKbEmbedding = false;
    const restartedIndexer = createKbIndexer(projectA);
    const restartStatus = await restartedIndexer.getStatus();
    expect(restartStatus.compatibility?.compatible).toBe(true);

    const beforeRecoveryCalls = embedInputs.length;
    const recoveredStats = await restartedIndexer.index();
    expect(recoveredStats.failedChunks).toBe(0);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();
    expect(db.chunkExistsOnBranch(projectABranch, sharedChunkId!)).toBe(true);

    const recoveryInputs = embedInputs.slice(beforeRecoveryCalls).flat();
    expect(recoveryInputs.some((text) => text.includes(kbPrompt))).toBe(true);
  });

  it("rejects a full global reset when another tenant survives only in DB branch rows", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const projectBHash = hashContent(path.resolve(projectB)).slice(0, 16);
    const projectAChunk = db.getChunksByFile(projectAFile)[0];
    const projectBChunk = db.getChunksByFile(projectBFile)[0];

    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors.usearch"), { force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors"), { recursive: true, force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors.meta.json"), { force: true });
    fs.writeFileSync(
      path.join(tempHome, ".opencode", "global-index", "file-hashes.json"),
      JSON.stringify({}, null, 2),
      "utf-8"
    );
    db.clearBranch(`${projectAHash}:default`);
    db.clearBranch(`${projectBHash}:default`);
    db.addChunksToBranchBatch(`${projectAHash}:default`, [projectAChunk.chunkId]);
    db.addChunksToBranchBatch(`${projectBHash}:default`, [projectBChunk.chunkId]);

    embeddingDimensions = 4;
    await expect(createIndexer(projectA, 4, "global").clearIndex()).rejects.toThrow(
      "Global index compatibility reset is unsafe"
    );
  });

  it("rejects a full global reset when another tenant survives only in DB branch symbol rows", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const projectBHash = hashContent(path.resolve(projectB)).slice(0, 16);
    const projectAChunk = db.getChunksByFile(projectAFile)[0];
    const projectBChunk = db.getChunksByFile(projectBFile)[0];
    const projectASymbol = `sym_${hashContent(`${projectAFile}:alpha:function:1`).slice(0, 16)}`;
    const projectBSymbol = `sym_${hashContent(`${projectBFile}:beta:function:1`).slice(0, 16)}`;

    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors.usearch"), { force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors"), { recursive: true, force: true });
    fs.rmSync(path.join(tempHome, ".opencode", "global-index", "vectors.meta.json"), { force: true });
    fs.writeFileSync(
      path.join(tempHome, ".opencode", "global-index", "file-hashes.json"),
      JSON.stringify({}, null, 2),
      "utf-8"
    );

    db.clearBranch(`${projectAHash}:default`);
    db.clearBranch(`${projectBHash}:default`);
    db.deleteBranchSymbolsForBranch(`${projectAHash}:default`, [projectASymbol]);
    db.deleteBranchSymbolsForBranch(`${projectBHash}:default`, [projectBSymbol]);
    db.deleteChunksByFile(projectAFile);
    db.deleteChunksByFile(projectBFile);
    db.addSymbolsToBranchBatch(`${projectAHash}:default`, [projectASymbol]);
    db.addSymbolsToBranchBatch(`${projectBHash}:default`, [projectBSymbol]);

    expect(db.getBranchChunkIds(`${projectBHash}:default`)).toHaveLength(0);
    expect(db.getBranchSymbolIds(`${projectBHash}:default`)).toContain(projectBSymbol);
    expect(projectAChunk).toBeTruthy();
    expect(projectBChunk).toBeTruthy();

    embeddingDimensions = 4;
    await expect(createIndexer(projectA, 4, "global").clearIndex()).rejects.toThrow(
      "Global index compatibility reset is unsafe"
    );
  });

  it("resets a corrupted local sqlite index during health check and reports rebuild guidance", async () => {
    embeddingDimensions = 8;
    const indexer = createIndexer(tempDir, 8);
    const stats = await indexer.index();
    expect(stats.indexedChunks).toBeGreaterThan(0);

    const gcEmbeddingsSpy = vi.spyOn(Database.prototype, "gcOrphanEmbeddings").mockReturnValue(0);
    const gcChunksSpy = vi.spyOn(Database.prototype, "gcOrphanChunks").mockImplementation(() => {
      throw new Error("SQLite error: database disk image is malformed");
    });

    const result = await indexer.healthCheck();
    gcEmbeddingsSpy.mockRestore();
    gcChunksSpy.mockRestore();
    expect(result.resetCorruptedIndex).toBe(true);
    expect(result.warning).toContain("reset the local index");

    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBe(0);
  });

  it("rebuilds the vector store during health check cleanup without calling native remove", async () => {
    const indexer = createIndexer(tempDir, 8);
    await indexer.index();

    const retainedFile = path.join(tempDir, "src", "retained.ts");
    fs.writeFileSync(retainedFile, "export function gamma() { return 'g'; }\n", "utf-8");
    await indexer.index();

    fs.rmSync(sourceFile, { force: true });

    const removeSpy = vi.spyOn(VectorStore.prototype, "remove").mockImplementation(() => {
      throw new Error("native remove should not be called during health check");
    });

    const result = await indexer.healthCheck();

    expect(result.removed).toBeGreaterThan(0);
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();

    const status = await indexer.getStatus();
    expect(status.vectorCount).toBeGreaterThan(0);

    const dbPath = path.join(tempDir, ".opencode", "index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    expect(db.getChunksByFile(retainedFile).length).toBeGreaterThan(0);
  });

  it("refuses to auto-reset a corrupted shared global sqlite index", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    const indexer = createIndexer(projectA, 8, "global");
    await indexer.index();

    const gcEmbeddingsSpy = vi.spyOn(Database.prototype, "gcOrphanEmbeddings").mockReturnValue(0);
    const gcChunksSpy = vi.spyOn(Database.prototype, "gcOrphanChunks").mockImplementation(() => {
      throw new Error("SQLite error: database disk image is malformed");
    });

    await expect(indexer.healthCheck()).rejects.toThrow("Automatic repair is disabled for global scope");
    gcEmbeddingsSpy.mockRestore();
    gcChunksSpy.mockRestore();
  });

  it("surfaces rebuild guidance when automatic orphan GC resets a corrupted local index", async () => {
    embeddingDimensions = 8;
    const indexer = trackIndexer(new Indexer(tempDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
        autoGc: true,
        gcOrphanThreshold: 0,
      },
    })));

    const initialStats = await indexer.index();
    expect(initialStats.indexedChunks).toBeGreaterThan(0);

    const getStatsSpy = vi.spyOn(Database.prototype, "getStats").mockReturnValue({
      embeddingCount: 2,
      chunkCount: 1,
      branchChunkCount: 1,
      branchCount: 1,
      symbolCount: 0,
      callEdgeCount: 0,
    });
    const realGcOrphanEmbeddings = Database.prototype.gcOrphanEmbeddings;
    const gcEmbeddingsSpy = vi.spyOn(Database.prototype, "gcOrphanEmbeddings").mockImplementation(function () {
      return realGcOrphanEmbeddings.call(this);
    });
    const gcChunksSpy = vi.spyOn(Database.prototype, "gcOrphanChunks").mockImplementation(() => {
      throw new Error("SQLite error: database disk image is malformed");
    });

    const maybeRunOrphanGc = vi.spyOn(indexer as unknown as { maybeRunOrphanGc: () => Promise<unknown> }, "maybeRunOrphanGc");

    fs.writeFileSync(sourceFile, [
      "export function alpha() {",
      "  return 'alpha-updated';",
      "}",
      "",
      "export function gamma() {",
      "  return alpha();",
      "}",
    ].join("\n"), "utf-8");

    const result = await indexer.index();
    getStatsSpy.mockRestore();
    gcEmbeddingsSpy.mockRestore();
    gcChunksSpy.mockRestore();
    expect(maybeRunOrphanGc).toHaveBeenCalled();
    expect(result.resetCorruptedIndex).toBe(true);
    expect(result.warning).toContain("reset the local index");

    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBe(0);
  });

  it("preserves shared knowledge-base rows still referenced by another global project", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const kbDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const kbFile = path.join(kbDir, "docs", "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");
    fs.writeFileSync(kbFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => trackIndexer(new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [kbDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    })));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();
    await createKbIndexer(projectA).clearIndex();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    expect(db.getChunksByFile(projectAFile)).toHaveLength(0);
    expect(db.getChunksByFile(projectBFile).length).toBeGreaterThan(0);
    expect(db.getChunksByFile(kbFile).length).toBeGreaterThan(0);

    const searchResults = await createKbIndexer(projectB).search("sharedDoc", 5);
    expect(searchResults.some((result) => result.filePath === kbFile)).toBe(true);
  });

  it("keeps legacy global branch catalogs readable across repos until each project is reindexed", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectBChunk = db.getChunksByFile(projectBFile)[0];
    const projectAKey = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBKey = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;

    db.clearBranch(projectBKey);
    db.addChunksToBranchBatch("default", [projectBChunk.chunkId]);
    db.deleteMetadata(`index.globalBranchMigration.${hashContent(path.resolve(projectB)).slice(0, 16)}`);
    db.clearBranch(projectAKey);

    const searchResults = await createIndexer(projectB, 8, "global").search("beta", 5);
    expect(searchResults.some((result) => result.filePath === projectBFile)).toBe(true);
  });

  it("stops reading legacy global branch rows for a repo after that repo is reindexed", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();
    await createIndexer(projectB, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAChunk = db.getChunksByFile(projectAFile)[0];
    const projectBChunk = db.getChunksByFile(projectBFile)[0];
    const projectAKey = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBKey = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;

    db.clearBranch(projectAKey);
    db.addChunksToBranchBatch("default", [projectAChunk.chunkId]);
    db.deleteMetadata(`index.globalBranchMigration.${hashContent(path.resolve(projectA)).slice(0, 16)}`);

    const legacyVisibleResults = await createIndexer(projectA, 8, "global").search("alpha", 5);
    expect(legacyVisibleResults.some((result) => result.filePath === projectAFile)).toBe(true);

    await createIndexer(projectA, 8, "global").index();

    db.clearBranch(projectAKey);
    db.addChunksToBranchBatch("default", [projectBChunk.chunkId]);

    const isolatedResults = await createIndexer(projectA, 8, "global").search("beta", 5);
    expect(isolatedResults.some((result) => result.filePath === projectBFile)).toBe(false);
    expect(db.getMetadata(`index.globalBranchMigration.${hashContent(path.resolve(projectA)).slice(0, 16)}`)).toBe("done");
    expect(db.getBranchChunkIds(projectBKey).length).toBeGreaterThan(0);
  });

  it("clears both legacy and namespaced branch rows for the current repo during global force reset", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    const indexerA = createIndexer(projectA, 8, "global");
    await indexerA.index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAChunk = db.getChunksByFile(projectAFile)[0];
    const namespacedBranch = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;

    db.addChunksToBranchBatch("default", [projectAChunk.chunkId]);

    await indexerA.clearIndex();

    expect(db.chunkExistsOnBranch(namespacedBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.chunkExistsOnBranch("default", projectAChunk.chunkId)).toBe(false);

    const rebuiltStats = await createIndexer(projectA, 8, "global").index();
    expect(rebuiltStats.failedChunks).toBe(0);

    const searchResults = await createIndexer(projectA, 8, "global").search("alpha", 5);
    expect(searchResults.filter((result) => result.filePath === projectAFile)).toHaveLength(1);
  });

  it("clears namespaced and legacy branch rows for the current repo's other branches during strategy reset", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.join(projectA, ".git", "refs", "heads", "feature"), { recursive: true });
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".git", "HEAD"), "ref: refs/heads/default\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "default"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "feature", "test"), "2222222222222222222222222222222222222222\n");
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    embeddingDimensions = 8;
    const indexerA = createIndexer(projectA, 8, "global");
    await indexerA.index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const defaultBranch = `${projectAHash}:default`;
    const featureBranch = `${projectAHash}:feature/test`;
    const legacyFeatureBranch = "feature/test";
    const projectAChunk = db.getChunksByFile(projectAFile)[0];

    db.addChunksToBranchBatch(featureBranch, [projectAChunk.chunkId]);
    db.addChunksToBranchBatch(legacyFeatureBranch, [projectAChunk.chunkId]);
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const globalIndexDir = path.join(tempHome, ".opencode", "global-index");
    fs.writeFileSync(
      path.join(globalIndexDir, "file-hashes.json"),
      JSON.stringify({ [projectAFile]: "project-a-hash" }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(path.join(globalIndexDir, "failed-batches.json"), "[]", "utf-8");

    embeddingDimensions = 8;
    const resettingIndexer = createIndexer(projectA, 8, "global");
    await resettingIndexer.clearIndex();

    expect(db.chunkExistsOnBranch(defaultBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.chunkExistsOnBranch(featureBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.chunkExistsOnBranch(legacyFeatureBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();
  });

  it("allows incompatible global reset when only same-project non-current branches have data", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.join(projectA, ".git", "refs", "heads", "feature"), { recursive: true });
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".git", "HEAD"), "ref: refs/heads/default\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "default"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "feature", "test"), "2222222222222222222222222222222222222222\n");
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    embeddingDimensions = 8;
    await createIndexer(projectA, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const defaultBranch = `${projectAHash}:default`;
    const featureBranch = `${projectAHash}:feature/test`;
    const projectAChunk = db.getChunksByFile(projectAFile)[0];

    db.addChunksToBranchBatch(featureBranch, [projectAChunk.chunkId]);
    expect(db.chunkExistsOnBranch(defaultBranch, projectAChunk.chunkId)).toBe(true);
    expect(db.chunkExistsOnBranch(featureBranch, projectAChunk.chunkId)).toBe(true);

    embeddingDimensions = 4;
    const incompatibleIndexer = createIndexer(projectA, 4, "global");
    await expect(incompatibleIndexer.clearIndex()).resolves.toBeUndefined();

    expect(db.chunkExistsOnBranch(defaultBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.chunkExistsOnBranch(featureBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();
  });

  it("clears DB-only legacy branch rows for deleted same-project branches during strategy reset", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.join(projectA, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".git", "HEAD"), "ref: refs/heads/default\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "default"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const defaultBranch = `${projectAHash}:default`;
    const deletedLegacyBranch = "feature/old";
    const projectAChunk = db.getChunksByFile(projectAFile)[0];

    db.addChunksToBranchBatch(deletedLegacyBranch, [projectAChunk.chunkId]);
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const globalIndexDir = path.join(tempHome, ".opencode", "global-index");
    fs.writeFileSync(
      path.join(globalIndexDir, "file-hashes.json"),
      JSON.stringify({ [projectAFile]: "project-a-hash" }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(path.join(globalIndexDir, "failed-batches.json"), "[]", "utf-8");

    await createIndexer(projectA, 8, "global").clearIndex();

    expect(db.chunkExistsOnBranch(defaultBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.chunkExistsOnBranch(deletedLegacyBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();
  });

  it("allows incompatible global reset when only same-project legacy bare branch rows remain", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectAFile = path.join(projectA, "src", "a.ts");
    fs.mkdirSync(path.join(projectA, ".git", "refs", "heads", "feature"), { recursive: true });
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".git", "HEAD"), "ref: refs/heads/default\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "default"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "feature", "test"), "2222222222222222222222222222222222222222\n");
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");

    await createIndexer(projectA, 8, "global").index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const namespacedDefaultBranch = `${projectAHash}:default`;
    const legacyFeatureBranch = "feature/test";
    const projectAChunk = db.getChunksByFile(projectAFile)[0];

    db.addChunksToBranchBatch(legacyFeatureBranch, [projectAChunk.chunkId]);
    db.clearBranch(namespacedDefaultBranch);

    expect(db.getBranchChunkIds(namespacedDefaultBranch)).toHaveLength(0);
    expect(db.chunkExistsOnBranch(legacyFeatureBranch, projectAChunk.chunkId)).toBe(true);

    embeddingDimensions = 4;
    const incompatibleIndexer = createIndexer(projectA, 4, "global");
    await expect(incompatibleIndexer.clearIndex()).resolves.toBeUndefined();

    expect(db.chunkExistsOnBranch(legacyFeatureBranch, projectAChunk.chunkId)).toBe(false);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();
  });

  it("preserves foreign legacy shared-kb branch rows during strategy reset", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const sharedDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const sharedFile = path.join(sharedDir, "shared.ts");

    fs.mkdirSync(path.join(projectA, ".git", "refs", "heads", "feature"), { recursive: true });
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.writeFileSync(path.join(projectA, ".git", "HEAD"), "ref: refs/heads/default\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "default"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(projectA, ".git", "refs", "heads", "feature", "test"), "2222222222222222222222222222222222222222\n");

    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(sharedFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => trackIndexer(new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [sharedDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    })));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectAHash = hashContent(path.resolve(projectA)).slice(0, 16);
    const projectAProjectChunk = db.getChunksByFile(projectAFile)[0];
    const sharedChunk = db.getChunksByFile(sharedFile)[0];
    const foreignLegacyBranch = "feature/test";

    db.addChunksToBranchBatch(foreignLegacyBranch, [sharedChunk.chunkId]);
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const globalIndexDir = path.join(tempHome, ".opencode", "global-index");
    fs.writeFileSync(
      path.join(globalIndexDir, "file-hashes.json"),
      JSON.stringify({ [projectAFile]: "project-a-hash", [projectBFile]: "project-b-hash", [sharedFile]: "shared-hash" }, null, 2),
      "utf-8"
    );
    fs.writeFileSync(path.join(globalIndexDir, "failed-batches.json"), "[]", "utf-8");

    await createKbIndexer(projectA).clearIndex();

    expect(db.chunkExistsOnBranch(foreignLegacyBranch, sharedChunk.chunkId)).toBe(true);
    expect(db.chunkExistsOnBranch(foreignLegacyBranch, projectAProjectChunk.chunkId)).toBe(false);
  });

  it("preserves foreign failed-batch and file-hash state during global clear when no vectors exist yet", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return 'b'; }\n", "utf-8");

    const projectAIndexer = createIndexer(projectA, 8, "global");

    await projectAIndexer.index();
    const fileHashCachePath = path.join(tempHome, ".opencode", "global-index", "file-hashes.json");
    fs.writeFileSync(
      fileHashCachePath,
      JSON.stringify({ [projectAFile]: "project-a-hash", [projectBFile]: "foreign-hash" }, null, 2),
      "utf-8"
    );

    const failedBatchesPath = path.join(tempHome, ".opencode", "global-index", "failed-batches.json");
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
      {
        chunks: [
          {
            id: "pending-beta",
            text: "beta pending",
            content: "export function beta() { return 'b'; }",
            contentHash: "pending-hash",
            metadata: {
              filePath: projectBFile,
              startLine: 1,
              endLine: 1,
              language: "typescript",
              chunkType: "function",
              hash: "pending-hash",
              name: "beta",
            },
          },
        ],
        error: "simulated failure",
        attemptCount: 1,
        lastAttempt: new Date().toISOString(),
      },
      ], null, 2),
      "utf-8"
    );

    await projectAIndexer.clearIndex();

    const fileHashCache = JSON.parse(fs.readFileSync(fileHashCachePath, "utf-8")) as Record<string, string>;
    expect(fileHashCache[projectBFile]).toBe("foreign-hash");

    const failedBatches = JSON.parse(fs.readFileSync(failedBatchesPath, "utf-8")) as Array<{ chunks: Array<{ metadata: { filePath: string } }> }>;
    expect(failedBatches.some((batch) => batch.chunks.some((chunk) => chunk.metadata.filePath === projectBFile))).toBe(true);
  });

  it("logs a warning when the persisted file hash cache is malformed", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const indexer = createIndexer(tempDir, 8, "global");
    const fileHashCachePath = path.join(tempHome, ".opencode", "global-index", "file-hashes.json");
    fs.mkdirSync(path.dirname(fileHashCachePath), { recursive: true });
    fs.writeFileSync(fileHashCachePath, "{", "utf-8");
    const canonicalFileHashCachePath = fs.realpathSync.native(fileHashCachePath);

    await indexer.clearIndex();

    const logs = indexer.getLogger().getLogs().filter((entry) => entry.level === "warn");
    expect(logs.some((entry) =>
      entry.message === "Failed to load file hash cache, resetting cache state"
      && entry.data?.fileHashCachePath === canonicalFileHashCachePath
    )).toBe(true);
  });

  it("clears current-repo branch ownership for DB-only chunks left by failed embeddings", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const sharedDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const sharedFile = path.join(sharedDir, "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return 'a'; }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedDoc(); }\n", "utf-8");
    fs.writeFileSync(sharedFile, "export function sharedDoc() { return 'shared'; }\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => trackIndexer(new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [sharedDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    })));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectABranch = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBBranch = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;
    const sharedChunk = db.getChunksByFile(sharedFile)[0];

    db.deleteBranchChunksForBranch(projectABranch, [sharedChunk.chunkId]);
    db.deleteBranchChunksForBranch(projectBBranch, [sharedChunk.chunkId]);
    db.deleteChunksByFile(sharedFile);
    db.upsertChunksBatch([
      {
        chunkId: sharedChunk.chunkId,
        contentHash: sharedChunk.contentHash,
        filePath: sharedFile,
        startLine: sharedChunk.startLine,
        endLine: sharedChunk.endLine,
        nodeType: sharedChunk.nodeType,
        name: sharedChunk.name,
        language: sharedChunk.language,
      },
    ]);
    db.addChunksToBranchBatch(projectABranch, [sharedChunk.chunkId]);

    await createKbIndexer(projectA).clearIndex();

    expect(db.chunkExistsOnBranch(projectABranch, sharedChunk.chunkId)).toBe(false);
    expect(db.getChunksByFile(sharedFile)).toHaveLength(0);
  });

  it("preserves resolved call edges for shared symbols kept by another global project", async () => {
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);

    const projectA = path.join(tempDir, "project-a");
    const projectB = path.join(tempDir, "project-b");
    const sharedDir = path.join(tempDir, "shared-kb");
    const projectAFile = path.join(projectA, "src", "a.ts");
    const projectBFile = path.join(projectB, "src", "b.ts");
    const sharedFile = path.join(sharedDir, "shared.ts");

    fs.mkdirSync(path.dirname(projectAFile), { recursive: true });
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(projectAFile, "export function alpha() { return sharedHelper(); }\n", "utf-8");
    fs.writeFileSync(projectBFile, "export function beta() { return sharedHelper(); }\n", "utf-8");
    fs.writeFileSync(sharedFile, "export const shared = 'shared';\n", "utf-8");

    const createKbIndexer = (projectRoot: string) => trackIndexer(new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-8d",
        dimensions: 8,
      },
      scope: "global",
      knowledgeBases: [sharedDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    })));

    await createKbIndexer(projectA).index();
    await createKbIndexer(projectB).index();

    const dbPath = path.join(tempHome, ".opencode", "global-index", "codebase.db");
    const db = trackDb(new Database(dbPath));
    const projectABranch = `${hashContent(path.resolve(projectA)).slice(0, 16)}:default`;
    const projectBBranch = `${hashContent(path.resolve(projectB)).slice(0, 16)}:default`;

    const sharedSymbolId = `sym_${hashContent(`${sharedFile}:sharedHelper:function:1`).slice(0, 16)}`;
    const betaSymbolId = `sym_${hashContent(`${projectBFile}:beta:function:1`).slice(0, 16)}`;
    const edgeId = `edge_${hashContent(`${betaSymbolId}:sharedHelper:1:0`).slice(0, 16)}`;

    db.upsertSymbolsBatch([
      {
        id: sharedSymbolId,
        filePath: sharedFile,
        name: "sharedHelper",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 30,
        language: "typescript",
      },
      {
        id: betaSymbolId,
        filePath: projectBFile,
        name: "beta",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 1,
        endCol: 40,
        language: "typescript",
      },
    ]);
    db.upsertCallEdgesBatch([
      {
        id: edgeId,
        fromSymbolId: betaSymbolId,
        targetName: "sharedHelper",
        toSymbolId: sharedSymbolId,
        callType: "Call",
        confidence: "Direct",
        line: 1,
        col: 0,
        isResolved: true,
      },
    ]);
    db.addSymbolsToBranchBatch(projectABranch, [sharedSymbolId]);
    db.addSymbolsToBranchBatch(projectBBranch, [sharedSymbolId, betaSymbolId]);

    await createKbIndexer(projectA).clearIndex();

    const callers = await createKbIndexer(projectB).getCallers("sharedHelper");
    expect(callers.some((caller) => caller.id === edgeId && caller.fromSymbolFilePath === projectBFile)).toBe(true);
  });
});
