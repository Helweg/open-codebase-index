import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, InvertedIndex } from "../src/native/index.js";

function structuralConfig() {
  return parseConfig({
    indexing: {
      mode: "structural",
      autoGc: true,
      watchFiles: false,
      requireProjectMarker: false,
      maxDepth: -1,
      maxFilesPerDirectory: 1000,
    },
    include: ["**/*.ts"],
    exclude: [],
    search: { minScore: 0 },
  });
}

describe("provider-free structural indexing", () => {
  let projectDir: string;
  let indexRoot: string;
  let indexers: Indexer[];

  const createIndexer = (runtime: { indexPath: string }, config = structuralConfig()): Indexer => {
    const indexer = new Indexer(projectDir, config, "jcode", runtime);
    indexers.push(indexer);
    return indexer;
  };

  beforeEach(() => {
    indexers = [];
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-structural-project-"));
    indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-structural-index-"));
  });

  afterEach(async () => {
    await Promise.all(indexers.map((indexer) => indexer.close()));
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(indexRoot, { recursive: true, force: true });
  });

  it("rejects an invalid indexing mode instead of silently enabling hybrid mode", () => {
    expect(() => parseConfig({ indexing: { mode: "structral" } })).toThrow("indexing.mode");
  });

  it("indexes, searches, resolves definitions and graph edges across restart without vectors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fs.writeFileSync(path.join(projectDir, "service.ts"), [
      "export function loadAccount(id: string) { return `account:${id}`; }",
      "export function handleRequest() { return loadAccount('42'); }",
    ].join("\n"));

    const runtime = { indexPath: indexRoot };
    let indexer = createIndexer(runtime);
    const stats = await indexer.index();
    expect(stats.indexedChunks).toBeGreaterThan(0);

    const structuralPath = path.join(indexRoot, "structural");
    expect(fs.existsSync(path.join(structuralPath, "codebase.db"))).toBe(true);
    expect(fs.existsSync(path.join(structuralPath, "inverted-index.json"))).toBe(true);
    expect(fs.existsSync(path.join(structuralPath, "vectors"))).toBe(false);
    expect(fs.existsSync(`${path.join(structuralPath, "vectors")}.meta.json`)).toBe(false);

    const results = await indexer.search("loadAccount", 10, { definitionIntent: true });
    expect(results.some((result) => result.name === "loadAccount")).toBe(true);
    expect((await indexer.getCallers("loadAccount")).length).toBeGreaterThan(0);
    await expect(indexer.findSimilar("loadAccount('x')")).rejects.toThrow("unavailable");

    await indexer.close();
    indexer = createIndexer(runtime);
    expect((await indexer.search("account", 10)).length).toBeGreaterThan(0);
    const status = await indexer.getStatus();
    expect(status.mode).toBe("structural");
    expect(status.provider).toBe("none");
    expect(status.indexed).toBe(true);
    expect((await indexer.getDatabaseStats())?.embeddingCount).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("handles incremental updates and deletion inside the isolated structural catalog", async () => {
    const sourcePath = path.join(projectDir, "feature.ts");
    fs.writeFileSync(sourcePath, "export function oldFeature() { return 'legacyMarker'; }\n");
    const runtime = { indexPath: indexRoot };
    const indexer = createIndexer(runtime);
    await indexer.index();
    expect((await indexer.search("legacyMarker", 10)).length).toBeGreaterThan(0);

    fs.writeFileSync(sourcePath, "export function newFeature() { return 'freshMarker'; }\n");
    await indexer.index();
    expect((await indexer.search("freshMarker", 10)).length).toBeGreaterThan(0);
    expect(await indexer.search("legacyMarker", 10)).toEqual([]);

    fs.unlinkSync(sourcePath);
    const stats = await indexer.index();
    expect(stats.removedChunks).toBeGreaterThan(0);
    expect(await indexer.search("freshMarker", 10)).toEqual([]);
  });

  it("does not mutate hybrid artifacts when structural mode is selected", async () => {
    fs.writeFileSync(path.join(projectDir, "safe.ts"), "export const isolatedMarker = 1;\n");
    fs.mkdirSync(indexRoot, { recursive: true });
    fs.writeFileSync(path.join(indexRoot, "vectors"), "hybrid-vector-sentinel");
    fs.writeFileSync(path.join(indexRoot, "codebase.db"), "hybrid-db-sentinel");

    const indexer = createIndexer({ indexPath: indexRoot });
    await indexer.index();

    expect(fs.readFileSync(path.join(indexRoot, "vectors"), "utf8")).toBe("hybrid-vector-sentinel");
    expect(fs.readFileSync(path.join(indexRoot, "codebase.db"), "utf8")).toBe("hybrid-db-sentinel");
    expect((await indexer.search("isolatedMarker", 10)).length).toBeGreaterThan(0);
    await indexer.close();
    const hybridConfig = parseConfig({ indexing: { mode: "hybrid" } });
    const hybridIndexer = createIndexer({ indexPath: indexRoot }, hybridConfig);
    await hybridIndexer.close();
    expect(fs.readFileSync(path.join(indexRoot, "vectors"), "utf8")).toBe("hybrid-vector-sentinel");
    expect(fs.readFileSync(path.join(indexRoot, "codebase.db"), "utf8")).toBe("hybrid-db-sentinel");
  });

  it("rebuilds a corrupt structural keyword artifact from unchanged source files", async () => {
    fs.writeFileSync(path.join(projectDir, "stable.ts"), "export function stableLookup() { return 'durableNeedle'; }\n");
    const runtime = { indexPath: indexRoot };
    let indexer = createIndexer(runtime);
    await indexer.index();
    const keywordPath = path.join(indexRoot, "structural", "inverted-index.json");
    fs.writeFileSync(keywordPath, "not-json");

    let reader = createIndexer(runtime);
    const corruptStatus = await reader.getStatus();
    expect(corruptStatus.indexed).toBe(false);
    expect(corruptStatus.warning).toContain("Structural keyword index");
    await expect(reader.search("durableNeedle", 10)).rejects.toThrow("Structural keyword index");
    await reader.close();

    await indexer.close();
    indexer = createIndexer(runtime);
    await indexer.index();
    expect((await indexer.search("durableNeedle", 10)).length).toBeGreaterThan(0);
    expect((await indexer.healthCheck()).removed).toBe(0);

    fs.writeFileSync(path.join(indexRoot, "structural", "structural-generation"), "interrupted-publication");
    await indexer.close();
    reader = createIndexer(runtime);
    expect((await reader.getStatus()).indexed).toBe(false);
    await reader.close();
    indexer = createIndexer(runtime);
    await indexer.index();
    expect((await indexer.search("durableNeedle", 10)).length).toBeGreaterThan(0);
  });

  it("blocks readers when a nonempty structural catalog has a missing or valid-empty keyword artifact", async () => {
    fs.writeFileSync(path.join(projectDir, "stable.ts"), "export const persistedNeedle = 'catalog';\n");
    const runtime = { indexPath: indexRoot };
    let indexer = createIndexer(runtime);
    await indexer.index();
    await indexer.close();

    const keywordPath = path.join(indexRoot, "structural", "inverted-index.json");
    fs.unlinkSync(keywordPath);
    let reader = createIndexer(runtime);
    await expect(reader.getStatus()).resolves.toMatchObject({
      indexed: false,
      warning: expect.stringContaining("missing or empty"),
    });
    await expect(reader.search("persistedNeedle", 10)).rejects.toThrow("missing or empty");
    await reader.close();

    indexer = createIndexer(runtime);
    await indexer.index();
    await indexer.close();
    fs.writeFileSync(keywordPath, new InvertedIndex(keywordPath).serialize());
    reader = createIndexer(runtime);
    await expect(reader.getStatus()).resolves.toMatchObject({
      indexed: false,
      warning: expect.stringContaining("missing or empty"),
    });
    await expect(reader.search("persistedNeedle", 10)).rejects.toThrow("missing or empty");
  });

  it("refreshes a long-lived provider-free reader after external add and delete publications", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = { indexPath: indexRoot };
    const sourcePath = path.join(projectDir, "live.ts");
    fs.writeFileSync(sourcePath, "export const originalLiveNeedle = 'original';\n");

    let writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    const reader = createIndexer(runtime);
    expect((await reader.search("originalLiveNeedle", 10)).length).toBeGreaterThan(0);

    fs.writeFileSync(sourcePath, "export const addedLiveNeedle = 'added';\n");
    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    expect((await reader.search("addedLiveNeedle", 10)).length).toBeGreaterThan(0);
    expect(await reader.search("originalLiveNeedle", 10)).toEqual([]);

    fs.unlinkSync(sourcePath);
    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    expect(await reader.search("addedLiveNeedle", 10)).toEqual([]);
    expect((await reader.getDatabaseStats())?.embeddingCount).toBe(0);
    expect(fs.existsSync(path.join(indexRoot, "structural", "vectors"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks a long-lived reader on broken structural publication and recovers after republish", async () => {
    const runtime = { indexPath: indexRoot };
    fs.writeFileSync(path.join(projectDir, "recover.ts"), "export const liveRecoveryNeedle = 'durable';\n");
    let writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    const reader = createIndexer(runtime);
    expect((await reader.search("liveRecoveryNeedle", 10)).length).toBeGreaterThan(0);

    const structuralPath = path.join(indexRoot, "structural");
    const keywordPath = path.join(structuralPath, "inverted-index.json");
    fs.unlinkSync(keywordPath);
    await expect(reader.search("liveRecoveryNeedle", 10)).rejects.toThrow("Structural keyword index");

    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    expect((await reader.search("liveRecoveryNeedle", 10)).length).toBeGreaterThan(0);

    fs.writeFileSync(keywordPath, new InvertedIndex(keywordPath).serialize());
    await expect(reader.search("liveRecoveryNeedle", 10)).rejects.toThrow("Structural keyword index");
    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    expect((await reader.search("liveRecoveryNeedle", 10)).length).toBeGreaterThan(0);

    fs.writeFileSync(path.join(structuralPath, "structural-generation"), "interrupted-live-publication");
    await expect(reader.search("liveRecoveryNeedle", 10)).rejects.toThrow("Structural keyword index");
    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    expect((await reader.search("liveRecoveryNeedle", 10)).length).toBeGreaterThan(0);
  });

  it("detects WAL-only and checkpointed SQLite generation changes in a long-lived reader", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const runtime = { indexPath: indexRoot };
    fs.writeFileSync(path.join(projectDir, "wal.ts"), "export const walRefreshNeedle = 'durable';\n");
    let writer = createIndexer(runtime);
    await writer.index();
    await writer.close();

    const structuralPath = path.join(indexRoot, "structural");
    const databasePath = path.join(structuralPath, "codebase.db");
    const keywordPath = path.join(structuralPath, "inverted-index.json");
    const generationPath = path.join(structuralPath, "structural-generation");
    const publishedGeneration = fs.readFileSync(generationPath, "utf8").trim();
    const databaseMtime = fs.statSync(databasePath).mtimeMs;
    const keywordFingerprint = fs.readFileSync(keywordPath);
    const reader = createIndexer(runtime);
    expect((await reader.search("walRefreshNeedle", 10)).length).toBeGreaterThan(0);

    const pendingWriter = new Database(databasePath);
    pendingWriter.setMetadata("index.structuralGeneration", "pending-sqlite-generation");
    expect(fs.statSync(databasePath).mtimeMs).toBe(databaseMtime);
    expect(fs.statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);
    expect(fs.readFileSync(keywordPath)).toEqual(keywordFingerprint);
    expect(fs.readFileSync(generationPath, "utf8").trim()).toBe(publishedGeneration);
    await expect(reader.search("walRefreshNeedle", 10)).rejects.toThrow("Structural keyword index");

    pendingWriter.close();
    await expect(reader.search("walRefreshNeedle", 10)).rejects.toThrow("Structural keyword index");
    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    expect((await reader.search("walRefreshNeedle", 10)).length).toBeGreaterThan(0);
    expect((await reader.search("walRefreshNeedle", 10)).length).toBeGreaterThan(0);
    expect((await reader.getDatabaseStats())?.embeddingCount).toBe(0);
    expect(fs.existsSync(path.join(structuralPath, "vectors"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fingerprints only the read-only SQLite override and not the live database WAL", async () => {
    const runtime = { indexPath: indexRoot };
    fs.writeFileSync(path.join(projectDir, "snapshot.ts"), "export const snapshotWalNeedle = 'stable';\n");
    const writer = createIndexer(runtime);
    await writer.index();
    await writer.close();

    const structuralPath = path.join(indexRoot, "structural");
    const liveDatabasePath = path.join(structuralPath, "codebase.db");
    const snapshotDatabasePath = path.join(indexRoot, "read-only-snapshot.db");
    fs.copyFileSync(liveDatabasePath, snapshotDatabasePath);
    const reader = createIndexer({ ...runtime, readOnlyDatabasePath: snapshotDatabasePath });
    expect((await reader.search("snapshotWalNeedle", 10)).length).toBeGreaterThan(0);
    const snapshotWalPath = `${snapshotDatabasePath}-wal`;
    const snapshotWalFingerprint = fs.existsSync(snapshotWalPath)
      ? `${fs.statSync(snapshotWalPath).size}:${fs.statSync(snapshotWalPath).mtimeMs}`
      : "missing";

    const pendingWriter = new Database(liveDatabasePath);
    pendingWriter.setMetadata("index.structuralGeneration", "live-only-pending-generation");
    expect(fs.statSync(`${liveDatabasePath}-wal`).size).toBeGreaterThan(0);
    expect((await reader.search("snapshotWalNeedle", 10)).length).toBeGreaterThan(0);
    expect(fs.existsSync(snapshotWalPath)
      ? `${fs.statSync(snapshotWalPath).size}:${fs.statSync(snapshotWalPath).mtimeMs}`
      : "missing").toBe(snapshotWalFingerprint);
    pendingWriter.close();
  });

  it("keeps a long-lived structural reader scoped to its branch while another branch publishes", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.email", "structural@example.com");
    git("config", "user.name", "Structural Test");
    const sourcePath = path.join(projectDir, "branch-live.ts");
    fs.writeFileSync(sourcePath, "export const liveMainNeedle = 'main-only';\n");
    git("add", ".");
    git("commit", "-m", "main");

    const runtime = { indexPath: indexRoot };
    let writer = createIndexer(runtime);
    await writer.index();
    await writer.close();
    git("checkout", "-b", "feature");
    const mainWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-structural-main-worktree-"));
    fs.rmSync(mainWorktree, { recursive: true, force: true });
    git("worktree", "add", mainWorktree, "main");
    const mainReader = new Indexer(mainWorktree, structuralConfig(), "jcode", runtime);
    indexers.push(mainReader);
    expect((await mainReader.search("liveMainNeedle", 10)).length).toBeGreaterThan(0);

    fs.writeFileSync(sourcePath, "export const liveFeatureNeedle = 'feature-only';\n");
    git("add", ".");
    git("commit", "-m", "feature");
    writer = createIndexer(runtime);
    await writer.index();
    await writer.close();

    expect((await mainReader.search("liveMainNeedle", 10)).length).toBeGreaterThan(0);
    expect(await mainReader.search("liveFeatureNeedle", 10)).toEqual([]);
    await mainReader.close();
    git("worktree", "remove", "--force", mainWorktree);
  });

  it("publishes a new structural generation after health cleanup removes stale chunks", async () => {
    const removedPath = path.join(projectDir, "removed.ts");
    fs.writeFileSync(removedPath, "export const removedByHealth = 'stale';\n");
    fs.writeFileSync(path.join(projectDir, "kept.ts"), "export const keptByHealth = 'durable';\n");
    const runtime = { indexPath: indexRoot };
    let indexer = createIndexer(runtime);
    await indexer.index();
    const generationPath = path.join(indexRoot, "structural", "structural-generation");
    const before = fs.readFileSync(generationPath, "utf8");

    fs.unlinkSync(removedPath);
    expect((await indexer.healthCheck()).removed).toBeGreaterThan(0);
    expect(fs.readFileSync(generationPath, "utf8")).not.toBe(before);
    await indexer.close();

    indexer = createIndexer(runtime);
    expect((await indexer.getStatus()).indexed).toBe(true);
    expect((await indexer.search("keptByHealth", 10)).length).toBeGreaterThan(0);
    expect(await indexer.search("removedByHealth", 10)).toEqual([]);
  });

  it("isolates global structural catalogs by project and rejects force-clear from an inherited path", async () => {
    const secondProject = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-structural-project-b-"));
    try {
      fs.writeFileSync(path.join(projectDir, "a.ts"), "export function alphaOnly() { return 'alphaNeedle'; }\n");
      fs.writeFileSync(path.join(secondProject, "b.ts"), "export function betaOnly() { return 'betaNeedle'; }\n");
      const globalConfig = parseConfig({
        scope: "global",
        indexing: { mode: "structural", autoGc: false, watchFiles: false, requireProjectMarker: false },
        include: ["**/*.ts"],
        exclude: [],
        search: { minScore: 0 },
      });
      const runtime = { indexPath: indexRoot };
      const first = new Indexer(projectDir, globalConfig, "jcode", runtime);
      indexers.push(first);
      await first.index();
      await first.close();
      const second = new Indexer(secondProject, globalConfig, "jcode", runtime);
      indexers.push(second);
      await second.index();
      expect((await second.search("betaNeedle", 10)).length).toBeGreaterThan(0);
      expect(await second.search("alphaNeedle", 10)).toEqual([]);
      await second.forceIndex();
      await second.close();
      const firstAfterForce = new Indexer(projectDir, globalConfig, "jcode", runtime);
      indexers.push(firstAfterForce);
      expect((await firstAfterForce.search("alphaNeedle", 10)).length).toBeGreaterThan(0);

      const inherited = createIndexer({ indexPath: path.join(indexRoot, "inherited") });
      await inherited.index();
      await expect(inherited.forceIndex()).rejects.toThrow("inherited worktree index");
    } finally {
      fs.rmSync(secondProject, { recursive: true, force: true });
    }
  });

  it("supports freshness, force rebuild, and branch-scoped restart", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
    git("init");
    git("config", "user.email", "structural@example.com");
    git("config", "user.name", "Structural Test");
    fs.writeFileSync(path.join(projectDir, "branch.ts"), "export const mainMarker = 'main';\n");
    git("add", ".");
    git("commit", "-m", "main");

    const runtime = { indexPath: path.join(projectDir, ".codebase-index", "index") };
    let indexer = createIndexer(runtime);
    await indexer.index();
    expect(await indexer.getIndexFreshness()).toMatchObject({ current: true });

    fs.writeFileSync(path.join(projectDir, "branch.ts"), "export function featureMarker() { return 'feature'; }\n");
    git("checkout", "-b", "feature");
    git("add", ".");
    git("commit", "-m", "feature");
    indexer.refreshBranchInfo();
    await indexer.index();
    expect((await indexer.search("featureMarker", 10)).length).toBeGreaterThan(0);

    await indexer.forceIndex();
    expect((await indexer.search("featureMarker", 10)).length).toBeGreaterThan(0);
    await indexer.close();
    indexer = createIndexer(runtime);
    expect((await indexer.getCallGraphSymbols()).some((symbol) => symbol.name === "featureMarker")).toBe(true);
  });

  it("recovers a corrupt keyword index for every persisted branch without reading old checkout bytes", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, stdio: "ignore" });
    git("init");
    git("config", "user.email", "structural@example.com");
    git("config", "user.name", "Structural Test");
    fs.writeFileSync(path.join(projectDir, "branch.ts"), "export const branchANeedle = 'alpha-history';\n");
    git("add", ".");
    git("commit", "-m", "branch a");
    const branchA = execFileSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf8" }).trim();

    const runtime = { indexPath: indexRoot };
    let indexer = createIndexer(runtime);
    await indexer.index();
    await indexer.close();

    git("checkout", "-b", "branch-b");
    fs.writeFileSync(path.join(projectDir, "branch.ts"), "export const branchBNeedle = 'beta-current';\n");
    git("add", ".");
    git("commit", "-m", "branch b");
    indexer = createIndexer(runtime);
    await indexer.index();
    await indexer.close();

    fs.writeFileSync(path.join(runtime.indexPath, "structural", "inverted-index.json"), "not-json");
    indexer = createIndexer(runtime);
    await indexer.index();
    expect((await indexer.search("branchBNeedle", 10)).length).toBeGreaterThan(0);
    await indexer.close();

    git("checkout", branchA);
    indexer = createIndexer(runtime);
    expect((await indexer.search("branchANeedle", 10)).length).toBeGreaterThan(0);
  });
});
