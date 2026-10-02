import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCbiCommandArgs } from "../src/adapters/cbi.js";
import { parseIndexArgs } from "../src/adapters/mcp/cli.js";
import { parseArgs } from "../src/adapters/mcp/cli-options.js";
import { parseConfig } from "../src/config/schema.js";
import { getCurrentBranch, resolveDefaultProjectRoot } from "../src/git/index.js";
import { Indexer } from "../src/indexer/index.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(directory: string, branch: string): void {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, "init", "-b", branch);
  git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-m", "fixture");
}

const startupParsers = [
  { name: "CLI status", parse: (cwd: string, args: string[]) => parseCbiCommandArgs("status", args, cwd).project },
  { name: "CLI index", parse: (cwd: string, args: string[]) => parseIndexArgs(args, cwd).project },
  { name: "MCP", parse: (_cwd: string, args: string[]) => parseArgs(["node", "mcp", ...args]).project },
];

describe("default checkout project scope", () => {
  let temp: string;
  let repo: string;
  let child: string;
  let indexers: Indexer[];

  beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-root-")));
    repo = path.join(temp, "repo");
    child = path.join(repo, "packages", "app", "src");
    initRepo(repo, "feature/parent");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(child, "package.json"), "{}");
    indexers = [];
    vi.spyOn(process, "cwd").mockReturnValue(child);
  });

  afterEach(async () => {
    await Promise.all(indexers.map((indexer) => indexer.close()));
    vi.restoreAllMocks();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it.each(startupParsers)("$name selects the containing checkout despite a package marker", ({ parse }) => {
    const root = parse(child, []);
    expect(root).toBe(repo);
    expect(getCurrentBranch(root)).toBe("feature/parent");
  });

  it.each(startupParsers)("$name preserves explicit child and parent scopes", ({ parse }) => {
    expect(parse(child, ["--project", child])).toBe(child);
    expect(parse(child, ["--project", repo])).toBe(repo);
    expect(parse(child, ["--project", "."])).toBe(child);
  });

  it("keeps standalone non-Git directories unchanged", () => {
    const standalone = path.join(temp, "standalone");
    fs.mkdirSync(standalone);
    vi.mocked(process.cwd).mockReturnValue(standalone);
    for (const { parse } of startupParsers) expect(parse(standalone, [])).toBe(standalone);
  });

  it("selects a nested repository rather than its containing checkout", () => {
    const nested = path.join(repo, "nested");
    initRepo(nested, "feature/nested");
    const nestedChild = path.join(nested, "src");
    fs.mkdirSync(nestedChild);
    vi.mocked(process.cwd).mockReturnValue(nestedChild);
    for (const { parse } of startupParsers) {
      const root = parse(nestedChild, []);
      expect(root).toBe(nested);
      expect(getCurrentBranch(root)).toBe("feature/nested");
    }
  });

  it("selects the linked worktree, not the main repository", () => {
    const worktree = path.join(temp, "worktree");
    git(repo, "worktree", "add", "-b", "feature/worktree", worktree);
    const worktreeChild = path.join(worktree, "src");
    fs.mkdirSync(worktreeChild);
    vi.mocked(process.cwd).mockReturnValue(worktreeChild);
    for (const { parse } of startupParsers) {
      const root = parse(worktreeChild, []);
      expect(root).toBe(worktree);
      expect(getCurrentBranch(root)).toBe("feature/worktree");
    }
  });

  it("selects a submodule with a relative gitdir pointer", () => {
    const source = path.join(temp, "submodule-source");
    initRepo(source, "feature/submodule");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/submodule");
    const submodule = path.join(repo, "vendor", "submodule");
    const submoduleChild = path.join(submodule, "src");
    fs.mkdirSync(submoduleChild);
    vi.mocked(process.cwd).mockReturnValue(submoduleChild);
    for (const { parse } of startupParsers) {
      const root = parse(submoduleChild, []);
      expect(root).toBe(submodule);
      expect(getCurrentBranch(root)).toBe("feature/submodule");
    }
  });

  it("discovers a checkout through a symlink without widening explicit alias scopes", () => {
    const alias = path.join(temp, "alias");
    fs.symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasChild = path.join(alias, "packages", "app", "src");
    expect(resolveDefaultProjectRoot(aliasChild)).toBe(repo);
    expect(parseIndexArgs(["--project", aliasChild], aliasChild).project).toBe(aliasChild);
  });

  it("does not cross a broken nested Git boundary", () => {
    fs.writeFileSync(path.join(child, ".git"), "gitdir: /nonexistent/gitdir\n");
    expect(resolveDefaultProjectRoot(child)).toBe(child);
  });

  it("reuses the registered global branch catalog from every default startup path", async () => {
    fs.writeFileSync(path.join(child, "service.ts"), "export function checkoutAnswer() { return 42; }\n");
    const config = parseConfig({
      scope: "global",
      include: ["**/*.ts"],
      indexing: { mode: "structural", autoIndex: false, watchFiles: false },
    });
    const runtime = { indexPath: path.join(temp, "catalog") };
    const writer = new Indexer(repo, config, "codex", runtime);
    indexers.push(writer);
    await writer.index();
    const parentStatus = await writer.getStatus();
    expect(parentStatus.branchReadiness?.state).toBe("ready");
    await writer.close();

    for (const { parse } of startupParsers) {
      const reader = new Indexer(parse(child, []), config, "codex", runtime);
      indexers.push(reader);
      const status = await reader.getStatus();
      expect(status.currentBranch).toBe("feature/parent");
      expect(status.branchReadiness).toEqual(parentStatus.branchReadiness);
      expect((await reader.search("checkoutAnswer", 5, { definitionIntent: true }))
        .some((result) => result.name === "checkoutAnswer")).toBe(true);
      await reader.close();
    }
  });
});
