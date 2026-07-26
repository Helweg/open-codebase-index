import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  acquireIndexLock,
  isIndexLockContentionError,
  releaseIndexLock,
  type IndexLockLease,
} from "../src/indexer/index-lock.js";
import type { Database } from "../src/native/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(repo: string, content: string, message: string): string {
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "feature.ts"), content);
  git(repo, ["add", "src/feature.ts"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("automatic branch index preparation", () => {
  let tempDir: string;
  let repo: string;
  let knowledgeBase: string;
  let mainCommit: string;
  let featureCommit: string;
  let indexer: Indexer;
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

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false, autoGc: false },
      knowledgeBases: [knowledgeBase],
    });
    indexer = new Indexer(repo, config);
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

  it("prepares a missing local branch once, reuses embeddings, and leaves the current worktree unchanged", async () => {
    const initialDb = await database();
    const mainChunkIds = initialDb.getBranchChunkIds("main").sort();
    const mainSymbolIds = initialDb.getBranchSymbolIds("main").sort();
    const mainSymbolNames = initialDb.getSymbolsForBranch("main").map((symbol) => symbol.name).sort();
    const beforeHead = git(repo, ["rev-parse", "HEAD"]);
    const beforeStatus = git(repo, ["status", "--porcelain"]);
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const fetchesBefore = fetchSpy.mock.calls.length;

    const first = await indexer.getPrImpact({ branch: "feature" });

    expect(first.indexPreparation).toMatchObject({
      prepared: true,
      branch: "feature",
      commit: featureCommit,
      source: "local",
    });
    expect(first.changedFiles).toContain("src/feature.ts");
    expect(first.directSymbols.map((symbol) => symbol.name)).toContain("changed");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);

    const db = await database();
    const featureSymbols = db.getSymbolsForBranch("feature");
    expect(featureSymbols.length).toBeGreaterThan(0);
    expect(featureSymbols.some((symbol) => symbol.filePath.startsWith(repo + path.sep))).toBe(true);
    expect(featureSymbols.some((symbol) => symbol.filePath.includes("codebase-index-branch-"))).toBe(false);
    expect(featureSymbols.some((symbol) => symbol.filePath === path.join(knowledgeBase, "external.ts"))).toBe(true);

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

  it("reindexes an advanced branch OID and reclaims only stale secondary data", async () => {
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

    const reused = await indexer.getPrImpact({ branch: "feature" });
    expect(reused.indexPreparation).toEqual({ prepared: false, branch: "feature" });
  });

  it("uses an authoritative local PR merge ref when gh metadata is unavailable", async () => {
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
    const fetchesBefore = fetchSpy.mock.calls.length;

    const result = await indexer.getPrImpact({ pr: 7 });

    expect(result.indexPreparation).toMatchObject({
      prepared: true,
      branch: "pr/7",
      commit: featureCommit,
      source: "pull-ref",
    });
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(fetchesBefore);
    expect((await database()).getSymbolsForBranch("pr/7").length).toBeGreaterThan(0);
    expect(git(repo, ["branch", "--show-current"])).toBe("main");
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
