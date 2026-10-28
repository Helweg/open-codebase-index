import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { getWorkingTreeChanges } from "../src/tools/changed-files.js";

let root: string;
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
async function source(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
  await fs.writeFile(path.join(root, filePath), content);
}
async function commit(): Promise<void> {
  git("add", "--all");
  git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "working-tree-impact-"));
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("working-tree change collection", () => {
  it("reports current staged and unstaged paths without changing the Git index", async () => {
    await source("staged.ts", "export const value = 1;\n");
    await source("unstaged.ts", "export const value = 1;\n");
    await commit();
    await source("staged.ts", "export const value = 2;\n");
    git("add", "--", "staged.ts");
    await source("staged.ts", "export const value = 3;\n");
    await source("unstaged.ts", "export const value = 4;\n");
    await source("new λ file.ts", "export const value = 5;\n");
    const before = await fs.readFile(path.join(root, ".git/index"));
    const changes = await getWorkingTreeChanges(root);
    expect(changes).toEqual({ headCommit: git("rev-parse", "HEAD"), omittedFileCount: 0, entries: [
      { path: "new λ file.ts", indexStatus: "?", worktreeStatus: "?" },
      { path: "staged.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "unstaged.ts", indexStatus: " ", worktreeStatus: "M" },
    ] });
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(before);
    expect(await fs.readFile(path.join(root, "staged.ts"), "utf8")).toContain("= 3");
  });

  it("preserves both paths of renames and literal newline names", async () => {
    await source("old.ts", "export function original() { return 1; }\n");
    await source("deleted.ts", "export const removed = 1;\n");
    await commit();
    git("mv", "--", "old.ts", "new name.ts");
    await fs.unlink(path.join(root, "deleted.ts"));
    const newlineName = process.platform === "win32" ? "unicode-λ.ts" : "line\nbreak.ts";
    await source(newlineName, "export const fresh = 1;\n");
    const changes = await getWorkingTreeChanges(root);
    expect(changes.entries).toContainEqual({ path: "new name.ts", previousPath: "old.ts", indexStatus: "R", worktreeStatus: " " });
    expect(changes.entries).toContainEqual({ path: "deleted.ts", indexStatus: " ", worktreeStatus: "D" });
    expect(changes.entries).toContainEqual({ path: newlineName, indexStatus: "?", worktreeStatus: "?" });
  });

  // APFS and Windows reject these bytes before Git can report them; Linux preserves byte filenames.
  it.runIf(process.platform === "linux")("rejects byte filenames that would alias a valid replacement-character filename", async () => {
    await source("invalid-\uFFFD.ts", "export function validUnicodePath() { return 1; }\n");
    expect((await getWorkingTreeChanges(root)).entries).toEqual([
      { path: "invalid-\uFFFD.ts", indexStatus: "?", worktreeStatus: "?" },
    ]);
    const invalidPath = Buffer.concat([Buffer.from(path.join(root, "invalid-")), Buffer.from([0xff]), Buffer.from(".ts")]);
    await fs.writeFile(invalidPath, "export function differentBytePath() { return 2; }\n");
    await expect(getWorkingTreeChanges(root)).rejects.toThrow("Working-tree paths must be valid UTF-8");
  });

  it("distinguishes an unborn repository, a clean tree, and ignored files", async () => {
    expect(await getWorkingTreeChanges(root)).toEqual({ headCommit: null, entries: [], omittedFileCount: 0 });
    await source(".gitignore", "ignored.ts\n");
    await commit();
    await source("ignored.ts", "ignored\n");
    expect(await getWorkingTreeChanges(root)).toEqual({ headCommit: git("rev-parse", "HEAD"), entries: [], omittedFileCount: 0 });
  });

  it("discloses deterministic path truncation rather than silently dropping files", async () => {
    for (let index = 0; index < 203; index++) await source(`file-${String(index).padStart(3, "0")}.ts`, "export const x = 1;\n");
    const changes = await getWorkingTreeChanges(root);
    expect(changes.entries.map((entry) => entry.path)).toEqual(Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(3, "0")}.ts`));
    expect(changes.omittedFileCount).toBe(3);
  });

  it("rejects unmerged index entries rather than assigning a risk", async () => {
    await source("conflict.ts", "export const value = 1;\n");
    await commit();
    const blob = git("rev-parse", "HEAD:conflict.ts");
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: root, input: `0 ${"0".repeat(40)}\tconflict.ts\n100644 ${blob} 1\tconflict.ts\n100644 ${blob} 2\tconflict.ts\n100644 ${blob} 3\tconflict.ts\n`,
    });
    await expect(getWorkingTreeChanges(root)).rejects.toThrow("Resolve unmerged files");
  });

  it("rejects non-Git directories and cancellation", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "no-working-tree-"));
    try { await expect(getWorkingTreeChanges(outside)).rejects.toThrow(); }
    finally { await fs.rm(outside, { recursive: true, force: true }); }
    await expect(getWorkingTreeChanges(root, AbortSignal.abort())).rejects.toThrow();
  });

  it("scopes nested projects and converts repository-root paths into project-relative paths", async () => {
    await source("nested project/src/gate.ts", "export function signalGate() { return true; }\n");
    await source("outside.ts", "export const other = 1;\n");
    await commit();
    await source("nested project/src/gate.ts", "export function signalGate() { return false; }\n");
    await source("nested project/new λ.ts", "export function fresh() { return true; }\n");
    await source("outside.ts", "export const other = 2;\n");
    const before = await fs.readFile(path.join(root, ".git/index"));
    const changes = await getWorkingTreeChanges(path.join(root, "nested project"));
    expect(changes.entries).toEqual([
      { path: "new λ.ts", indexStatus: "?", worktreeStatus: "?" },
      { path: "src/gate.ts", indexStatus: " ", worktreeStatus: "M" },
    ]);
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(before);
  });

  it.each(["inbound", "outbound"])("keeps a %s rename across a child project boundary scoped to its local endpoint", async (direction) => {
    const local = "nested/gate.ts";
    const sibling = "sibling.ts";
    await source(direction === "inbound" ? sibling : local, "export function boundaryGate() { return true; }\n");
    await fs.mkdir(path.join(root, "nested"), { recursive: true });
    await commit();
    git("mv", "--", direction === "inbound" ? sibling : local, direction === "inbound" ? local : sibling);
    const before = await fs.readFile(path.join(root, ".git/index"));
    const changes = await getWorkingTreeChanges(path.join(root, "nested"));
    expect(changes.entries).toEqual([
      { path: "gate.ts", indexStatus: direction === "inbound" ? "A" : "D", worktreeStatus: " " },
    ]);
    expect(changes.omittedFileCount).toBe(0);
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(before);
  });
});

describe("working-tree impact on the current native graph", () => {
  let indexer: Indexer;
  let indexRoot: string;

  beforeEach(async () => {
    indexRoot = await fs.mkdtemp(path.join(os.tmpdir(), "working-tree-impact-index-"));
    await source("src/gate.ts", "export function signalGate(value: boolean) { return value; }\n");
    await source("src/transport.ts", "import { signalGate } from './gate.js';\nexport function createTransport(value: boolean) { return signalGate(value); }\n");
    await commit();
    indexer = new Indexer(root, parseConfig({
      indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false, maxFilesPerDirectory: 1000 },
      include: ["**/*.ts", "**/*.md"], exclude: ["excluded/**"], search: { minScore: 0 },
    }), "omp", { indexPath: indexRoot });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await indexer.close();
    await fs.rm(indexRoot, { recursive: true, force: true });
  });

  async function snapshot(directory: string): Promise<Record<string, string>> {
    const contents: Record<string, string> = {};
    async function visit(current: string): Promise<void> {
      for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        // SQLite readers update transient shared-memory coordination, not persisted index evidence.
        if (entry.name.endsWith(".db-shm")) continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(file);
        else contents[path.relative(directory, file)] = entry.isSymbolicLink()
          ? `symlink:${await fs.readlink(file)}`
          : createHash("sha256").update(await fs.readFile(file)).digest("hex");
      }
    }
    await visit(directory);
    return contents;
  }

  it("rejects stale edits without mutation, then accepts refreshed dirty staged/unstaged/untracked contents and reachability", async () => {
    await indexer.index();
    await source("src/gate.ts", "export function signalGate(value: boolean) { return !value; }\n");
    git("add", "--", "src/gate.ts");
    await source("src/gate.ts", "export function signalGate(value: boolean) { return dirtyGate(value); }\nexport function dirtyGate(value: boolean) { return value; }\n");
    await source("src/transport.ts", "import { signalGate } from './gate.js';\nexport function createTransport(value: boolean) { return signalGate(Boolean(value)); }\n");
    await source("src/new λ file.ts", "import { createTransport } from './transport.js';\nexport function untrackedConsumer() { return createTransport(true); }\n");
    const beforeGit = await snapshot(root);
    const beforeIndex = await snapshot(indexRoot);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is forbidden"));
    const indexSpy = vi.spyOn(indexer, "index");
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow("Working-tree impact requires a current index. Run index_codebase, then retry.");
    expect(await snapshot(root)).toEqual(beforeGit);
    expect(await snapshot(indexRoot)).toEqual(beforeIndex);
    expect(indexSpy).not.toHaveBeenCalled();

    await indexer.index();
    expect(await indexer.getIndexFreshness()).toMatchObject({ current: true, reason: "current" });
    const indexedGit = await snapshot(root);
    const indexedArtifacts = await snapshot(indexRoot);
    const progress = vi.fn();
    const result = await indexer.getPrImpact({ workingTree: true }, progress);
    expect(result.workingTree).toEqual({
      headCommit: git("rev-parse", "HEAD"), scope: "current_indexed_files", omittedFileCount: 0, unassessed: [],
      entries: [
        { path: "src/gate.ts", indexStatus: "M", worktreeStatus: "M" },
        { path: "src/new λ file.ts", indexStatus: "?", worktreeStatus: "?" },
        { path: "src/transport.ts", indexStatus: " ", worktreeStatus: "M" },
      ],
    });
    expect(result.changedFiles).toEqual(["src/gate.ts", "src/new λ file.ts", "src/transport.ts"]);
    expect(result.directSymbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["signalGate", "dirtyGate", "createTransport", "untrackedConsumer"]));
    expect(result.riskLevel).not.toBe("UNKNOWN");
    expect(result.riskReason).toContain("current indexed contents, not staged blobs");
    expect(result.indexPreparation).toBeUndefined();
    expect(progress).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(indexedGit);
    expect(await snapshot(indexRoot)).toEqual(indexedArtifacts);
  });

  it("traverses unchanged callers of an indexed changed file", async () => {
    await source("src/gate.ts", "export function signalGate(value: boolean) { return !value; }\n");
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true, direction: "callers" });
    expect(result.directSymbols.map((symbol) => symbol.name)).toEqual(["signalGate"]);
    expect(result.transitiveCallers).toContainEqual(expect.objectContaining({
      name: "createTransport", filePath: path.join(root, "src/transport.ts"), depth: 1,
    }));
  });

  it("reports deletions and rename sources as UNKNOWN without manufacturing historical symbols", async () => {
    git("mv", "--", "src/gate.ts", "src/renamed gate.ts");
    await fs.unlink(path.join(root, "src/transport.ts"));
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.workingTree?.entries).toContainEqual({
      path: "src/renamed gate.ts", previousPath: "src/gate.ts", indexStatus: "R", worktreeStatus: " ",
    });
    expect(result.workingTree?.unassessed).toEqual(expect.arrayContaining([
      { path: "src/gate.ts", reason: "renamed_from" }, { path: "src/transport.ts", reason: "deleted" },
    ]));
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.directSymbols.map((symbol) => symbol.filePath)).toEqual([path.join(root, "src/renamed gate.ts")]);
    expect(result.transitiveCallers.some((symbol) => symbol.name === "createTransport")).toBe(false);
  });

  it("retains UNKNOWN coverage gaps for unindexed scoped exclusions and files without graph symbols", async () => {
    await source("excluded/new.ts", "export function notInScope() { return 1; }\n");
    await source("src/no-symbols.md", "# Operational notes\n\nDocumentation without call-graph declarations.\n");
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.workingTree?.unassessed).toEqual([
      { path: "excluded/new.ts", reason: "not_indexed" },
      { path: "src/no-symbols.md", reason: "no_symbols" },
    ]);
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.directSymbols).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("never reads outside-project symlink targets and identifies nonregular local links", async () => {
    const outside = path.join(indexRoot, "outside.ts");
    await fs.writeFile(outside, "export function outsideSentinel() { return 1; }\n");
    await fs.symlink(outside, path.join(root, "outside-link.ts"));
    await fs.symlink(path.join(root, "src/gate.ts"), path.join(root, "inside-link.ts"));
    await indexer.index();
    const before = await fs.readFile(outside);
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.workingTree?.unassessed).toEqual([
      { path: "inside-link.ts", reason: "not_regular" },
      { path: "outside-link.ts", reason: "outside_project" },
    ]);
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.directSymbols).toEqual([]);
    expect(await fs.readFile(outside)).toEqual(before);
  });

  it("returns an empty current-tree result rather than guessing a committed comparison", async () => {
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.changedFiles).toEqual([]);
    expect(result.directSymbols).toEqual([]);
    expect(result.transitiveCallers).toEqual([]);
    expect(result.workingTree).toMatchObject({ entries: [], unassessed: [], omittedFileCount: 0 });
    expect(result.riskReason).toContain("No working-tree changes");
    expect(result.indexPreparation).toBeUndefined();
  });

  it("analyzes an indexed unborn repository without inventing a HEAD commit", async () => {
    await indexer.close();
    git("update-ref", "-d", "refs/heads/main");
    await fs.unlink(path.join(root, ".git/index"));
    indexer = new Indexer(root, parseConfig({
      indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
      include: ["**/*.ts"], exclude: [],
    }), "omp", { indexPath: indexRoot });
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.workingTree?.headCommit).toBeNull();
    expect(result.workingTree?.entries).toEqual([
      { path: "src/gate.ts", indexStatus: "?", worktreeStatus: "?" },
      { path: "src/transport.ts", indexStatus: "?", worktreeStatus: "?" },
    ]);
    expect(result.directSymbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["signalGate", "createTransport"]));
    expect(result.indexPreparation).toBeUndefined();
  });

  it("does not report LOW when the path cap leaves unassessed files", async () => {
    for (let index = 0; index < 203; index++) await source(`excluded/${String(index).padStart(3, "0")}.ts`, "export function omitted() { return 1; }\n");
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.workingTree?.omittedFileCount).toBe(3);
    expect(result.workingTree?.entries.map((entry) => entry.path)).toEqual(
      Array.from({ length: 200 }, (_, index) => `excluded/${String(index).padStart(3, "0")}.ts`),
    );
    expect(result.workingTree?.unassessed.every((entry) => entry.reason === "not_indexed")).toBe(true);
    expect(result.riskLevel).toBe("UNKNOWN");
  });

  it.each([{ pr: 1 }, { branch: "" }, { checkConflicts: true }])("rejects incompatible options before initializing or inspecting Git: %j", async (conflict) => {
    const initializeSpy = vi.spyOn(indexer, "getStatus");
    const before = await snapshot(root);
    const beforeIndex = await snapshot(indexRoot);
    await expect(indexer.getPrImpact({ workingTree: true, ...conflict })).rejects.toThrow(
      "workingTree cannot be combined with pr, branch, or checkConflicts",
    );
    expect(initializeSpy).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
    expect(await snapshot(indexRoot)).toEqual(beforeIndex);
  });

  it("rejects cancellation before inspection and during the bounded consistency check", async () => {
    await indexer.index();
    await expect(indexer.getPrImpact({ workingTree: true }, undefined, { signal: AbortSignal.abort() })).rejects.toThrow();
    const controller = new AbortController();
    const original = indexer.getIndexFreshness.bind(indexer);
    let checks = 0;
    vi.spyOn(indexer, "getIndexFreshness").mockImplementation(async (options) => {
      const result = await original(options);
      if (++checks === 2) controller.abort();
      return result;
    });
    await expect(indexer.getPrImpact({ workingTree: true }, undefined, { signal: controller.signal })).rejects.toThrow();
    expect(checks).toBe(2);
  });

  it("invalidates concurrent dirty-byte changes deterministically even when Git XY status is unchanged", async () => {
    await source("src/gate.ts", "export function signalGate(value: boolean) { return !value; }\n");
    await indexer.index();
    const original = indexer.getIndexFreshness.bind(indexer);
    let checks = 0;
    vi.spyOn(indexer, "getIndexFreshness").mockImplementation(async (options) => {
      const result = await original(options);
      if (++checks === 2) await source("src/gate.ts", "export function signalGate(value: boolean) { return Boolean(value); }\n");
      return result;
    });
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow(
      "Working tree changed during impact analysis; retry on a stable tree.",
    );
    expect(checks).toBe(2);
  });

  it("rejects a concurrent graph publication even when source bytes and graph counts remain current", async () => {
    await source("src/gate.ts", "export function signalGate(value: boolean) { return !value; }\n");
    await indexer.index();
    const beforeStatus = await indexer.getStatus();
    const original = indexer.getIndexFreshness.bind(indexer);
    let checks = 0;
    vi.spyOn(indexer, "getIndexFreshness").mockImplementation(async (options) => {
      if (++checks === 2) {
        await indexer.index();
        expect(await indexer.getStatus()).toEqual(beforeStatus);
      }
      const freshness = await original(options);
      expect(freshness.current).toBe(true);
      return freshness;
    });
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow(
      "Working tree changed during impact analysis; retry on a stable tree.",
    );
    expect(checks).toBe(2);
  });

  it("rejects branch changes and pending migrations instead of preparing a different graph", async () => {
    await indexer.index();
    git("checkout", "-b", "other");
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow("Working-tree impact requires a current index.");
    git("checkout", "main");
    const status = await indexer.getStatus();
    vi.spyOn(indexer, "getStatus").mockResolvedValue({ ...status, migrationRequired: true });
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow("Working-tree impact requires a current index.");
  });

  it("rejects missing index data without preparing or publishing a branch", async () => {
    const before = await snapshot(root);
    const beforeIndex = await snapshot(indexRoot);
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow("Working-tree impact requires a current index.");
    expect(await snapshot(root)).toEqual(before);
    expect(await snapshot(indexRoot)).toEqual(beforeIndex);
  });

  it("propagates an unmerged-index error without producing a current impact result", async () => {
    await indexer.index();
    const blob = git("rev-parse", "HEAD:src/gate.ts");
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: root, input: `0 ${"0".repeat(40)}\tsrc/gate.ts\n100644 ${blob} 1\tsrc/gate.ts\n100644 ${blob} 2\tsrc/gate.ts\n100644 ${blob} 3\tsrc/gate.ts\n`,
    });
    const before = await snapshot(root);
    await expect(indexer.getPrImpact({ workingTree: true })).rejects.toThrow("Resolve unmerged files");
    expect(await snapshot(root)).toEqual(before);
  });

  it("assesses literal spaces, newline and Unicode paths using their indexed current symbols", async () => {
    const file = process.platform === "win32" ? "src/new λ space.ts" : "src/new λ\nspace.ts";
    await source(file, "export function literalPathFunction() { return true; }\n");
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.changedFiles).toEqual([file]);
    expect(result.workingTree?.unassessed).toEqual([]);
    expect(result.directSymbols).toContainEqual(expect.objectContaining({
      name: "literalPathFunction", filePath: path.join(root, file),
    }));
  });

  it("uses the selected child project's indexed graph without assessing dirty siblings", async () => {
    await indexer.close();
    await source("nested/src/gate.ts", "export function nestedGate() { return true; }\n");
    await commit();
    await source("nested/src/gate.ts", "export function nestedGate() { return false; }\n");
    await source("src/gate.ts", "export function outsideScope() { return false; }\n");
    indexer = new Indexer(path.join(root, "nested"), parseConfig({
      indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
      include: ["**/*.ts"], exclude: [],
    }), "omp", { indexPath: indexRoot });
    await indexer.index();
    const result = await indexer.getPrImpact({ workingTree: true });
    expect(result.changedFiles).toEqual(["src/gate.ts"]);
    expect(result.directSymbols.map((symbol) => symbol.name)).toEqual(["nestedGate"]);
    expect(result.workingTree?.unassessed).toEqual([]);
  });
});
