import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import type { IndexLockLease } from "../src/indexer/index-lock.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  acquireIndexLock,
  isIndexLockContentionError,
  releaseIndexLock,
} from "../src/indexer/index-lock.js";
import { Database, hashContent, VectorStore } from "../src/native/index.js";
import { createPullRequestCatalogIdentity } from "../src/tools/changed-files.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(repo: string, content: string, message: string): string {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "feature.ts"), content);
  git(repo, ["add", "--", "src/feature.ts"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function branchCommitMetadataKey(catalogIdentity: string): string {
  return `index.branchCommit.${hashContent(catalogIdentity).slice(0, 24)}`;
}

function symbolExtractorMetadataKey(catalogIdentity: string): string {
  return `index.symbolExtractorVersion.${hashContent(catalogIdentity).slice(0, 24)}`;
}

function migrationMetadataKey(prefix: string, catalogIdentity: string): string {
  return `${prefix}.${hashContent(catalogIdentity).slice(0, 24)}`;
}

describe("automatic branch index preparation", () => {
  let tempDir: string;
  let repo: string;
  let knowledgeBase: string;
  let mainCommit: string;
  let featureCommit: string;
  let indexer: Indexer;
  let config: ParsedCodebaseIndexConfig;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "automatic-branch-index-test-"));
    repo = path.join(tempDir, "repo");
    knowledgeBase = path.join(tempDir, "external-knowledge-base");
    fs.mkdirSync(repo);
    fs.mkdirSync(knowledgeBase);
    fs.writeFileSync(
      path.join(knowledgeBase, "external.ts"),
      "export function externalKnowledge(): number { return 42; }\n",
    );
    fs.symlinkSync(knowledgeBase, path.join(repo, "linked-knowledge-base"), "dir");
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    mainCommit = commitFile(repo, `// Main branch implementation
function baseValue(): number {
  const seed = 1;
  const adjusted = seed + 1;
  return adjusted;
}

function unchangedHelper(): number {
  return baseValue();
}
`, "main");
    git(repo, ["checkout", "-b", "feature"]);
    featureCommit = commitFile(
      repo,
      `// Feature branch implementation
function helper(): number {
  const seed = 2;
  const adjusted = seed + 1;
  return adjusted;
}

function changed(): number {
  const first = helper();
  const second = helper();
  return first + second;
}
`,
      "feature",
    );
    git(repo, ["branch", "locked"]);
    git(repo, ["checkout", "main"]);

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: texts.map((text, index) => ({
          embedding: Array.from({ length: 8 }, (_, dimension) =>
            ((text.length + index * 11 + dimension * 17) % 101) / 101),
        })),
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false, autoGc: false },
      knowledgeBases: ["linked-knowledge-base"],
    });
    indexer = new Indexer(repo, config, "opencode");
    await indexer.index();
  });

  afterEach(async () => {
    await indexer.close();
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function database(): Promise<Database> {
    await indexer.getStatus();
    return (indexer as unknown as { database: Database }).database;
  }

  it("prepares a missing local branch once, reports progress, and keeps canonical external knowledge bases external", async () => {
    const initialDb = await database();
    const mainChunkIds = initialDb.getBranchChunkIds("main").sort();
    const mainSymbolIds = initialDb.getBranchSymbolIds("main").sort();
    const mainSymbolNames = initialDb.getSymbolsForBranch("main").map((symbol) => symbol.name).sort();
    expect(initialDb.getMetadata(branchCommitMetadataKey("main"))).toBe(mainCommit);
    const beforeHead = git(repo, ["rev-parse", "HEAD"]);
    const beforeStatus = git(repo, ["status", "--porcelain"]);
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const fetchesBefore = fetchSpy.mock.calls.length;
    const progressPhases: string[] = [];

    const first = await indexer.getPrImpact(
      { branch: "feature" },
      (progress) => progressPhases.push(progress.phase),
    );

    expect(first.indexPreparation).toMatchObject({
      prepared: true,
      branch: "feature",
      commit: featureCommit,
      source: "local",
    });
    expect(progressPhases).toContain("scanning");
    expect(progressPhases).toContain("complete");
    expect(first.changedFiles).toContain("src/feature.ts");
    expect(first.directSymbols.map((symbol) => symbol.name)).toContain("changed");
    expect(first.directSymbols).toContainEqual(expect.objectContaining({
      name: "changed",
      filePath: path.join(repo, "src", "feature.ts"),
    }));
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);

    const db = await database();
    const featureSymbols = db.getSymbolsForBranch("feature");
    expect(featureSymbols.length).toBeGreaterThan(0);
    expect(featureSymbols.some((symbol) => symbol.filePath === "src/feature.ts")).toBe(true);
    expect(featureSymbols.some((symbol) => symbol.filePath.includes("codebase-index-branch-"))).toBe(false);
    expect(featureSymbols.some((symbol) => symbol.filePath === fs.realpathSync.native(path.join(knowledgeBase, "external.ts")))).toBe(true);
    expect(db.getMetadata(branchCommitMetadataKey("feature"))).toBe(featureCommit);

    expect(db.getBranchChunkIds("main").sort()).toEqual(mainChunkIds);
    expect(db.getBranchSymbolIds("main").sort()).toEqual(mainSymbolIds);
    expect(db.getSymbolsForBranch("main").map((symbol) => symbol.name).sort()).toEqual(mainSymbolNames);
    expect(mainChunkIds.every((chunkId) => db.getChunk(chunkId) !== null)).toBe(true);
    expect(db.getBranchChunkIds("feature").every((chunkId) => !mainChunkIds.includes(chunkId))).toBe(true);

    const fetchesAfterPreparation = fetchSpy.mock.calls.length;
    expect(fetchesAfterPreparation).toBeGreaterThan(fetchesBefore);
    const second = await indexer.getPrImpact({ branch: "feature" });
    expect(second.indexPreparation).toEqual({ prepared: false, branch: "feature" });
    expect(fetchSpy.mock.calls.length).toBe(fetchesAfterPreparation);
  });

  it("keeps alternate-branch data intact while health check removes stale active-branch data", async () => {
    git(repo, ["checkout", "feature"]);
    const featureOnlyPath = path.join(repo, "src", "feature-only.ts");
    fs.writeFileSync(featureOnlyPath, "export function featureOnly(): number { return 7; }\n");
    git(repo, ["add", "--", "src/feature-only.ts"]);
    git(repo, ["commit", "-m", "add feature-only source"]);
    featureCommit = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    const mainOnlyPath = path.join(repo, "src", "main-only.ts");
    fs.writeFileSync(mainOnlyPath, "export function mainOnly(): number { return 3; }\n");
    await indexer.index();
    await indexer.getPrImpact({ branch: "feature" });

    const db = await database();
    const featureOnlyChunkIds = db.getChunksByFile("src/feature-only.ts").map((chunk) => chunk.chunkId);
    const featureOnlySymbolIds = db.getSymbolsByFile("src/feature-only.ts").map((symbol) => symbol.id);
    const mainOnlyChunkIds = db.getChunksByFile("src/main-only.ts").map((chunk) => chunk.chunkId);
    expect(featureOnlyChunkIds.length).toBeGreaterThan(0);
    expect(featureOnlySymbolIds.length).toBeGreaterThan(0);
    expect(mainOnlyChunkIds.length).toBeGreaterThan(0);
    expect(db.getBranchChunkIds("feature")).toEqual(expect.arrayContaining(featureOnlyChunkIds));
    expect(db.getBranchSymbolIds("feature")).toEqual(expect.arrayContaining(featureOnlySymbolIds));

    fs.rmSync(mainOnlyPath);
    const result = await indexer.healthCheck();

    expect(result.removed).toBe(mainOnlyChunkIds.length);
    expect(result.filePaths).toEqual([mainOnlyPath]);
    expect(featureOnlyChunkIds.every((chunkId) => db.getChunk(chunkId) !== null)).toBe(true);
    expect(mainOnlyChunkIds.every((chunkId) => db.getChunk(chunkId) === null)).toBe(true);
    expect(db.getBranchChunkIds("feature")).toEqual(expect.arrayContaining(featureOnlyChunkIds));
    expect(db.getBranchSymbolIds("feature")).toEqual(expect.arrayContaining(featureOnlySymbolIds));

    for (const branch of db.getAllBranches()) {
      expect(db.getBranchChunkIds(branch).every((chunkId) => db.getChunk(chunkId) !== null)).toBe(true);
      const storedSymbolIds = new Set(db.getSymbolsForBranch(branch).map((symbol) => symbol.id));
      expect(db.getBranchSymbolIds(branch).every((symbolId) => storedSymbolIds.has(symbolId))).toBe(true);
    }

    const status = await indexer.getStatus();
    const vectorStore = new VectorStore(path.join(status.indexPath, "vectors"), 8);
    vectorStore.loadStrict();
    const vectorChunkIds = new Set(vectorStore.getAllMetadata().map(({ key }) => key));
    expect(featureOnlyChunkIds.every((chunkId) => vectorChunkIds.has(chunkId))).toBe(true);
    expect(mainOnlyChunkIds.every((chunkId) => !vectorChunkIds.has(chunkId))).toBe(true);
  });

  it("reparses a cached alternate branch when its symbol extractor metadata is stale", async () => {
    await indexer.getPrImpact({ branch: "feature" });
    const db = await database();
    expect(db.getMetadata(symbolExtractorMetadataKey("main"))).toBe("1");
    expect(db.getMetadata(symbolExtractorMetadataKey("feature"))).toBe("1");

    const status = await indexer.getStatus();
    await indexer.close();
    const directDatabase = new Database(path.join(status.indexPath, "codebase.db"));
    directDatabase.setMetadata(symbolExtractorMetadataKey("feature"), "stale");
    directDatabase.close();
    indexer = new Indexer(repo, config, "opencode");
    const fetchesBeforeMigration = fetchSpy.mock.calls.length;

    const migrated = await indexer.getPrImpact({ branch: "feature" });

    expect(migrated.indexPreparation).toMatchObject({
      prepared: true,
      branch: "feature",
      commit: featureCommit,
    });
    expect(fetchSpy.mock.calls.length).toBe(fetchesBeforeMigration);
    const migratedDb = await database();
    expect(migratedDb.getMetadata(symbolExtractorMetadataKey("feature"))).toBe("1");
    expect(migratedDb.getMetadata(symbolExtractorMetadataKey("main"))).toBe("1");
  });

  it("reparses only the cached branch whose parser migration marker is stale", async () => {
    git(repo, ["checkout", "feature"]);
    fs.writeFileSync(
      path.join(repo, "src", "feature.swift"),
      "func featureSwiftMarker() -> Int { return 42 }\n",
    );
    git(repo, ["add", "--", "src/feature.swift"]);
    git(repo, ["commit", "-m", "add feature swift source"]);
    featureCommit = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "main"]);

    await indexer.getPrImpact({ branch: "feature" });
    const status = await indexer.getStatus();
    await indexer.close();

    const swiftPrefix = "index.parser.swiftVersion";
    const directDatabase = new Database(path.join(status.indexPath, "codebase.db"));
    expect(
      directDatabase.getSymbolsByFile("src/feature.swift").some(
        (symbol) => symbol.name === "featureSwiftMarker",
      ),
    ).toBe(true);
    directDatabase.deleteSymbolsByFile("src/feature.swift");
    directDatabase.setMetadata(migrationMetadataKey(swiftPrefix, "feature"), "stale");
    directDatabase.close();

    git(repo, ["checkout", "feature"]);
    indexer = new Indexer(repo, config);
    await expect(indexer.getIndexFreshness()).resolves.toEqual({
      readable: true,
      current: false,
      reason: "migration-required",
    });
    await indexer.close();
    git(repo, ["checkout", "main"]);

    indexer = new Indexer(repo, config);
    const fetchesBeforeMigration = fetchSpy.mock.calls.length;
    const migrated = await indexer.getPrImpact({ branch: "feature" });

    expect(migrated.indexPreparation).toMatchObject({
      prepared: true,
      branch: "feature",
      commit: featureCommit,
    });
    expect(fetchSpy.mock.calls.length).toBe(fetchesBeforeMigration);

    const migratedDb = await database();
    expect(
      migratedDb.getSymbolsByFile("src/feature.swift").some(
        (symbol) => symbol.name === "featureSwiftMarker",
      ),
    ).toBe(true);
    for (const [prefix, version] of [
      ["index.callGraphResolutionVersion", "9"],
      [swiftPrefix, "1"],
      ["index.parser.metalVersion", "1"],
    ] as const) {
      expect(migratedDb.getMetadata(migrationMetadataKey(prefix, "main"))).toBe(version);
      expect(migratedDb.getMetadata(migrationMetadataKey(prefix, "feature"))).toBe(version);
    }
  });

  it("reindexes a moved branch OID, replaces stale catalog data, and preserves primary data", async () => {
    await indexer.getPrImpact({ branch: "feature" });
    const db = await database();
    const mainChunkIds = db.getBranchChunkIds("main").sort();
    const mainSymbolIds = db.getBranchSymbolIds("main").sort();
    const oldFeatureChunkIds = db.getBranchChunkIds("feature").sort();

    git(repo, ["checkout", "feature"]);
    const advancedCommit = commitFile(
      repo,
      `function advancedHelper(): number {
  return 7;
}

function advancedChange(): number {
  return advancedHelper() * 2;
}
`,
      "advance feature",
    );
    git(repo, ["checkout", "main"]);

    const advanced = await indexer.getPrImpact({ branch: "feature" });
    expect(advanced.indexPreparation).toMatchObject({
      prepared: true,
      branch: "feature",
      commit: advancedCommit,
    });
    expect(advanced.directSymbols.map((symbol) => symbol.name)).toContain("advancedChange");

    const refreshedDb = await database();
    const newFeatureChunkIds = refreshedDb.getBranchChunkIds("feature").sort();
    const staleFeatureOnlyIds = oldFeatureChunkIds.filter((chunkId) => !newFeatureChunkIds.includes(chunkId));
    expect(staleFeatureOnlyIds.length).toBeGreaterThan(0);
    expect(staleFeatureOnlyIds.every((chunkId) => refreshedDb.getChunk(chunkId) === null)).toBe(true);
    expect(refreshedDb.getBranchChunkIds("main").sort()).toEqual(mainChunkIds);
    expect(refreshedDb.getBranchSymbolIds("main").sort()).toEqual(mainSymbolIds);
    expect(mainChunkIds.every((chunkId) => refreshedDb.getChunk(chunkId) !== null)).toBe(true);
    expect(refreshedDb.getMetadata(branchCommitMetadataKey("feature"))).toBe(advancedCommit);

    const reused = await indexer.getPrImpact({ branch: "feature" });
    expect(reused.indexPreparation).toEqual({ prepared: false, branch: "feature" });
  });

  it("treats catalogs without commit metadata as legacy-stale and restores metadata", async () => {
    await indexer.getPrImpact({ branch: "feature" });
    const status = await indexer.getStatus();
    await indexer.close();

    const directDatabase = new Database(path.join(status.indexPath, "codebase.db"));
    directDatabase.deleteMetadata(branchCommitMetadataKey("feature"));
    directDatabase.close();

    indexer = new Indexer(repo, config, "opencode");
    const rebuilt = await indexer.getPrImpact({ branch: "feature" });
    expect(rebuilt.indexPreparation).toMatchObject({
      prepared: true,
      branch: "feature",
      commit: featureCommit,
    });
    expect((await database()).getMetadata(branchCommitMetadataKey("feature"))).toBe(featureCommit);

    const reused = await indexer.getPrImpact({ branch: "feature" });
    expect(reused.indexPreparation).toEqual({ prepared: false, branch: "feature" });
  });

  it("uses an authoritative local PR merge ref and a repository-specific catalog identity", async () => {
    git(repo, ["update-ref", "refs/pull/7/head", featureCommit]);
    const mergeCommit = git(repo, [
      "commit-tree",
      `${featureCommit}^{tree}`,
      "-p",
      mainCommit,
      "-p",
      featureCommit,
      "-m",
      "synthetic PR merge",
    ]);
    git(repo, ["update-ref", "refs/pull/7/merge", mergeCommit]);

    const result = await indexer.getPrImpact({ pr: 7 });

    expect(result.indexPreparation).toMatchObject({
      prepared: true,
      branch: "pr/7",
      commit: featureCommit,
      source: "pull-ref",
    });
    const localRepositoryIdentity = `local:${fs.realpathSync.native(repo)}`;
    const catalogIdentity = createPullRequestCatalogIdentity(
      localRepositoryIdentity,
      7,
      `${localRepositoryIdentity}/refs/pull/7/head`,
    );
    const db = await database();
    expect(db.getSymbolsForBranch(catalogIdentity).length).toBeGreaterThan(0);
    expect(db.getSymbolsForBranch("pr/7")).toEqual([]);
    expect(db.getMetadata(branchCommitMetadataKey(catalogIdentity))).toBe(featureCommit);
    expect(git(repo, ["branch", "--show-current"])).toBe("main");
  });

  it("keeps same-number, same-display PRs from different forks in distinct verified catalogs", async () => {
    git(repo, ["checkout", "-b", "fork-bob", "main"]);
    const bobCommit = commitFile(
      repo,
      `function bobHelper(): number {
  return 11;
}

function bobOnly(): number {
  return bobHelper() + 1;
}
`,
      "bob fork",
    );
    git(repo, ["checkout", "main"]);
    git(repo, ["update-ref", "refs/pull/41/head", featureCommit]);

    const binDir = path.join(tempDir, "bin");
    const statePath = path.join(tempDir, "gh-state");
    fs.mkdirSync(binDir);
    const aliceMetadata = JSON.stringify({
      number: 41,
      headRefName: "shared-branch",
      headRefOid: featureCommit,
      headRepository: { name: "project", nameWithOwner: "alice/project" },
      headRepositoryOwner: { login: "alice" },
      baseRefName: "main",
      url: "https://github.com/base/project/pull/41",
      files: [{ path: "src/feature.ts" }],
    });
    const bobMetadata = JSON.stringify({
      number: 41,
      headRefName: "shared-branch",
      headRefOid: bobCommit,
      headRepository: { name: "project", nameWithOwner: "bob/project" },
      headRepositoryOwner: { login: "bob" },
      baseRefName: "main",
      url: "https://github.com/base/project/pull/41",
      files: [{ path: "src/feature.ts" }],
    });
    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(ghPath, `#!/bin/sh
if [ "$(cat ${JSON.stringify(statePath)})" = "bob" ]; then
  printf '%s\\n' ${JSON.stringify(bobMetadata)}
else
  printf '%s\\n' ${JSON.stringify(aliceMetadata)}
fi
`);
    fs.chmodSync(ghPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
    try {
      fs.writeFileSync(statePath, "alice");
      const alice = await indexer.getPrImpact({ pr: 41 });
      expect(alice.indexPreparation).toMatchObject({
        prepared: true,
        branch: "shared-branch",
        commit: featureCommit,
        source: "pull-ref",
      });
      expect(alice.directSymbols.map((symbol) => symbol.name)).toContain("changed");

      fs.writeFileSync(statePath, "bob");
      const bob = await indexer.getPrImpact({ pr: 41 });
      expect(bob.indexPreparation).toMatchObject({
        prepared: true,
        branch: "shared-branch",
        commit: bobCommit,
        source: "local",
      });
      expect(bob.directSymbols.map((symbol) => symbol.name)).toContain("bobOnly");
    } finally {
      process.env.PATH = originalPath;
    }

    const aliceIdentity = createPullRequestCatalogIdentity(
      "github.com/base/project",
      41,
      "github.com/alice/project",
    );
    const bobIdentity = createPullRequestCatalogIdentity(
      "github.com/base/project",
      41,
      "github.com/bob/project",
    );
    const db = await database();
    expect(db.getSymbolsForBranch(aliceIdentity).map((symbol) => symbol.name)).toContain("changed");
    expect(db.getSymbolsForBranch(bobIdentity).map((symbol) => symbol.name)).toContain("bobOnly");
    expect(db.getSymbolsForBranch("shared-branch")).toEqual([]);
    expect(db.getMetadata(branchCommitMetadataKey(aliceIdentity))).toBe(featureCommit);
    expect(db.getMetadata(branchCommitMetadataKey(bobIdentity))).toBe(bobCommit);
  });

  it("honors index lock contention and cleans up the temporary worktree on failure", async () => {
    const status = await indexer.getStatus();
    const beforeHead = git(repo, ["rev-parse", "HEAD"]);
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    let lease: IndexLockLease | null = acquireIndexLock(status.indexPath, "index");

    try {
      let caught: unknown;
      try {
        await indexer.getPrImpact({ branch: "locked" });
      } catch (error) {
        caught = error;
      }
      expect(isIndexLockContentionError(caught)).toBe(true);
    } finally {
      if (lease) {
        releaseIndexLock(lease);
        lease = null;
      }
    }

    expect(git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
  });
});
