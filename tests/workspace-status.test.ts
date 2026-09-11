import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { IndexStatusResult } from "../src/tools/operations.js";

import { runCbiCli } from "../src/adapters/cbi.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  getWorkspaceStatus,
  parseWorkspaceRepoSpecs,
} from "../src/tools/workspace-status.js";
import { createWorkspaceDatabaseSnapshot } from "../src/tools/workspace-status-snapshot.js";

const tempDirs: string[] = [];

function makeRepo(branch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-workspace-"));
  tempDirs.push(root);
  execFileSync("git", ["init", "-b", branch], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), branch);
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

function status(currentBranch: string, overrides: Partial<IndexStatusResult> = {}): IndexStatusResult {
  return {
    indexed: true,
    mode: "hybrid",
    vectorCount: 12,
    provider: "local",
    model: "test",
    indexPath: "/index",
    currentBranch,
    baseBranch: "main",
    compatibility: { compatible: true },
    failedBatchesCount: 0,
    autoIndex: { enabled: false, state: "idle", updatedAt: new Date(0).toISOString() },
    branchReadiness: { state: "ready", activeCatalogChunkCount: 12, registeredCatalog: true },
    ...overrides,
  };
}

function structuralConfig() {
  return parseConfig({
    indexing: { mode: "structural", watchFiles: false, requireProjectMarker: false },
    include: ["**/*.ts"],
    exclude: [],
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace status", () => {
  it("parses names and paths by the first equals sign and rejects invalid bounded input", () => {
    expect(parseWorkspaceRepoSpecs(["api=repo=with=equals"], "/tmp"))
      .toEqual([{ name: "api", root: "/tmp/repo=with=equals" }]);
    expect(() => parseWorkspaceRepoSpecs([], "/tmp")).toThrow("at least one");
    expect(() => parseWorkspaceRepoSpecs(["=repo"], "/tmp")).toThrow("Malformed");
    expect(() => parseWorkspaceRepoSpecs(["api="], "/tmp")).toThrow("Malformed");
    expect(() => parseWorkspaceRepoSpecs(["api=a", "api=b"], "/tmp")).toThrow("Duplicate repository name");
    expect(() => parseWorkspaceRepoSpecs(Array.from({ length: 21 }, (_, index) => `r${index}=p${index}`), "/tmp"))
      .toThrow("at most 20");
  });

  it("rejects duplicate canonical roots while preserving explicit names", () => {
    const root = makeRepo("main");
    expect(() => parseWorkspaceRepoSpecs([`one=${root}`, `two=${path.join(root, ".")}`], "/"))
      .toThrow("resolve to the same root");
  });

  it("reports actual branch and HEAD independently from indexed branch readiness", async () => {
    const api = makeRepo("feature/api");
    const web = makeRepo("feature/web");
    const result = await getWorkspaceStatus(
      [{ name: "api", root: api }, { name: "web", root: web }],
      "jcode",
      { readStatus: async (root) => status(root === api ? "feature/api" : "main", root === api ? {} : { mode: "structural" }) },
    );

    expect(result.repositories[0]).toMatchObject({ actualBranch: "feature/api", indexedBranch: "feature/api", branchMismatch: false, ready: true });
    expect(result.repositories[0].actualHead).toMatch(/^[0-9a-f]{40}$/);
    expect(result.repositories[1]).toMatchObject({ actualBranch: "feature/web", indexedBranch: "main", branchMismatch: true, mode: "structural", ready: false });
  });

  it("treats persisted provider-free structural chunks as ready through the public CLI path", async () => {
    const root = makeRepo("main");
    fs.writeFileSync(path.join(root, "service.ts"), "export function structuralWorkspaceMarker() { return 42; }\n");
    execFileSync("git", ["add", "service.ts"], { cwd: root });
    execFileSync("git", ["commit", "-m", "add source"], { cwd: root });
    const config = structuralConfig();
    fs.mkdirSync(path.join(root, ".codebase-index"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codebase-index", "config.json"), JSON.stringify({
      indexing: { mode: "structural", watchFiles: false, requireProjectMarker: false },
      include: ["**/*.ts"],
      exclude: [],
    }));
    const indexer = new Indexer(root, config, "jcode");
    const indexed = await indexer.index();
    expect(indexed.indexedChunks).toBeGreaterThan(0);
    const sourceDatabasePath = path.join(root, ".codebase-index", "index", "structural", "codebase.db");
    expect(fs.existsSync(`${sourceDatabasePath}-wal`)).toBe(true);

    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
    const stdout: string[] = [];
    const exitCode = await runCbiCli(
      ["node", "cbi", "workspace", "status", "--repo", `structural=${root}`, "--host", "jcode", "--json"],
      root,
      { printStdout: (text) => stdout.push(text), printStderr: () => undefined },
    );
    const output = JSON.parse(stdout[0]) as { repositories: Array<Record<string, unknown>> };
    expect(exitCode).toBe(0);
    expect(output.repositories[0]).toMatchObject({
      ready: true,
      mode: "structural",
      compatibility: "compatible",
      branchMismatch: false,
      freshness: "not_checked",
    });
    expect(output.repositories[0].chunkCount).toBeGreaterThan(0);
    expect(output.repositories[0].activeChunkCount).toBeGreaterThan(0);
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
    await indexer.close();
  });

  it("cleans snapshots and fails boundedly when source database artifacts keep changing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbi-snapshot-source-"));
    tempDirs.push(root);
    const databasePath = path.join(root, "codebase.db");
    fs.writeFileSync(databasePath, "database");
    fs.writeFileSync(`${databasePath}-wal`, "wal");

    const snapshot = await createWorkspaceDatabaseSnapshot(databasePath);
    const snapshotRoot = path.dirname(snapshot.databasePath);
    expect(fs.readFileSync(snapshot.databasePath, "utf8")).toBe("database");
    expect(fs.readFileSync(`${snapshot.databasePath}-wal`, "utf8")).toBe("wal");
    await snapshot.close();
    expect(fs.existsSync(snapshotRoot)).toBe(false);

    await expect(createWorkspaceDatabaseSnapshot(databasePath, {
      maxAttempts: 2,
      afterCopyAttempt: async (attempt) => {
        await fs.promises.appendFile(`${databasePath}-wal`, String(attempt));
      },
    })).rejects.toThrow("changed during status inspection");
  });

  it("keeps healthy repositories visible when paths, indexes, or providers fail", async () => {
    const healthy = makeRepo("main");
    const provider = makeRepo("main");
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}`);
    const result = await getWorkspaceStatus(
      [{ name: "healthy", root: healthy }, { name: "provider", root: provider }, { name: "missing", root: missing }],
      "codex",
      { readStatus: async (root) => {
        if (root === provider) throw new Error("provider apiKey=top-secret failed");
        return status("main");
      } },
    );

    expect(result.ready).toBe(false);
    expect(result.repositories[0].ready).toBe(true);
    expect(result.repositories[1].error).toBe("Embedding provider status is unavailable.");
    expect(JSON.stringify(result)).not.toContain("top-secret");
    expect(result.repositories[2].error).toContain("missing or unreadable");
  });

  it("does not mutate repository files while inspecting status", async () => {
    const root = makeRepo("main");
    const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
    await getWorkspaceStatus([{ name: "repo", root }], "jcode", { readStatus: async () => status("main") });
    expect(fs.readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it("prints every JSON result and exits nonzero when any repository is not ready", async () => {
    const stdout: string[] = [];
    const result = {
      host: "jcode" as const,
      ready: false,
      repositories: [],
    };
    const exitCode = await runCbiCli(
      ["node", "cbi", "workspace", "status", "--repo", "api=repo path", "--host=jcode", "--json"],
      "/tmp",
      { runWorkspaceStatus: async (specs, cwd, host) => {
        expect(specs).toEqual(["api=repo path"]);
        expect(cwd).toBe("/tmp");
        expect(host).toBe("jcode");
        return result;
      }, printStdout: (text) => stdout.push(text), printStderr: () => undefined },
    );
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout[0])).toEqual(result);
  });

  it("preserves existing status command dispatch", async () => {
    const stdout: string[] = [];
    const exitCode = await runCbiCli(["node", "cbi", "status", "--project", "/repo"], "/tmp", {
      runStatus: async () => ({ text: "existing status" }),
      printStdout: (text) => stdout.push(text),
      printStderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toEqual(["existing status"]);
  });
});
