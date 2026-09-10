import type { Database } from "../src/native/index.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { hashContent } from "../src/native/index.js";
import { formatStatus } from "../src/tools/utils.js";

describe("branch readiness diagnostics", () => {
  let root: string;
  let indexer: Indexer;
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const config = (scope: "project" | "global" = "project") => parseConfig({
    scope,
    embeddingProvider: "custom",
    customProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "readiness-test", dimensions: 8 },
    include: ["**/*.ts"],
    indexing: { autoIndex: false, watchFiles: false, autoGc: false },
    search: { minScore: 0 },
  });
  const db = (): Database => (indexer as unknown as { database: Database }).database;
  const marker = (branch: string): string => `index.callGraphResolutionVersion.${hashContent(branch).slice(0, 24)}`;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "branch-readiness-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "entry.ts"), "export function readinessTarget() {\n  const seed = 40;\n  const adjusted = seed + 2;\n  return adjusted;\n}\n");
    git("add", "src/entry.ts");
    git("commit", "-q", "-m", "fixture");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return new Response(JSON.stringify({
        data: input.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
        usage: { total_tokens: input.length },
      }));
    });
    indexer = new Indexer(root, config(), "opencode", { indexPath: path.join(root, "isolated-index") });
    const stats = await indexer.index();
    expect(stats.indexedChunks, JSON.stringify(stats)).toBeGreaterThan(0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await indexer?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports actual branch coverage separately from globally stored chunks", async () => {
    const status = await indexer.getStatus();
    expect(status.indexed).toBe(true);
    expect(status.vectorCount).toBeGreaterThan(0);
    expect(status.branchReadiness).toMatchObject({ state: "ready", registeredCatalog: true });
    expect(status.branchReadiness?.activeCatalogChunkCount).toBeGreaterThan(0);
  });

  it("reports a missing branch without leaking other-branch evidence and recovers by normal indexing", async () => {
    const originalIds = db().getBranchChunkIds("main").sort();
    git("checkout", "-q", "-b", "missing");
    indexer.refreshBranchInfo();
    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.vectorCount).toBeGreaterThan(0);
    expect(status.branchReadiness).toMatchObject({ state: "missing", activeCatalogChunkCount: 0 });
    const text = formatStatus(status);
    expect(text).toContain("Current branch: missing");
    expect(text).toContain("Indexed chunks (all branches):");
    expect(text).toContain("cbi index");
    expect(await indexer.search("readinessTarget", 10, { definitionIntent: true })).toEqual([]);
    await indexer.index();
    expect((await indexer.getStatus()).branchReadiness?.state).toBe("ready");
    expect((await indexer.search("readinessTarget", 10, { definitionIntent: true })).length).toBeGreaterThan(0);
    expect(db().getBranchChunkIds("main").sort()).toEqual(originalIds);
  });

  it("identifies a completed empty catalog by metadata without manufacturing membership rows", async () => {
    db().clearBranch("main");
    db().clearBranchSymbols("main");
    expect(db().getMetadata(marker("main"))).not.toBeNull();
    const status = await indexer.getStatus();
    expect(status.branchReadiness).toMatchObject({ state: "empty", registeredCatalog: true, activeCatalogChunkCount: 0 });
    expect(status.indexed).toBe(false);
    expect(await indexer.search("readinessTarget", 10, { definitionIntent: true })).toEqual([]);
  });

  it("retains project legacy behavior when no branch catalogs or completion marker exist", async () => {
    db().clearBranch("main");
    db().clearBranchSymbols("main");
    db().deleteMetadata(marker("main"));
    const status = await indexer.getStatus();
    expect(status.branchReadiness?.state).toBe("legacy");
    expect(status.indexed).toBe(true);
  });

  it("refreshes a long-lived reader to the current checkout without claiming missing coverage", async () => {
    await indexer.getStatus();
    git("checkout", "-q", "-b", "changed-checkout");
    const status = await indexer.getStatus();
    expect(status.currentBranch).toBe("changed-checkout");
    expect(status.checkoutBranch).toBe("changed-checkout");
    expect(status.indexed).toBe(false);
    expect(status.branchReadiness?.state).toBe("missing");
    expect(formatStatus(status)).toContain("Current branch: changed-checkout");
  });

  it("degrades safely when branch catalog reads fail", async () => {
    vi.spyOn(db(), "getAllBranches").mockImplementation(() => { throw new Error("catalog unavailable"); });
    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
    expect(status.branchReadiness).toBeUndefined();
    expect(status.warning).toBeTruthy();
  });

  it("does not interpret another project's global catalog as active coverage", async () => {
    await indexer.close();
    indexer = new Indexer(root, config("global"), "opencode", { indexPath: path.join(root, "global-isolated-index") });
    await indexer.index();
    git("checkout", "-q", "-b", "global-missing");
    indexer.refreshBranchInfo();
    const status = await indexer.getStatus();
    expect(status.branchReadiness?.state).toBe("missing");
    expect(status.indexed).toBe(false);
    expect(await indexer.search("readinessTarget", 10, { definitionIntent: true })).toEqual([]);
  });
});
