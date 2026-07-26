import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isValidGitRefName,
  withMaterializedBranch,
} from "../src/git/branch-materialization.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("branch materialization", () => {
  let tempDir: string;
  let repo: string;
  let mainCommit: string;
  let featureCommit: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "branch-materialization-test-"));
    repo = path.join(tempDir, "repo");
    fs.mkdirSync(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test User"]);
    mainCommit = commitFile(repo, "src/value.ts", "export const value = 'main';\n", "main");
    git(repo, ["checkout", "-b", "feature"]);
    featureCommit = commitFile(repo, "src/value.ts", "export const value = 'feature';\n", "feature");
    git(repo, ["checkout", "main"]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("materializes a local branch without mutating the caller worktree and cleans up", async () => {
    const beforeHead = git(repo, ["rev-parse", "HEAD"]);
    const beforeStatus = git(repo, ["status", "--porcelain"]);
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    let materializedPath = "";

    const result = await withMaterializedBranch(
      { projectRoot: repo, branch: "feature" },
      async (worktreePath, info) => {
        materializedPath = worktreePath;
        expect(fs.readFileSync(path.join(worktreePath, "src/value.ts"), "utf8")).toContain("feature");
        expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(featureCommit);
        expect(info).toMatchObject({ branch: "feature", commit: featureCommit, source: "local", fetched: false });
        return "indexed";
      },
    );

    expect(result.value).toBe("indexed");
    expect(fs.existsSync(path.dirname(materializedPath))).toBe(false);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(repo, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
  });

  it("supports detached commit refs", async () => {
    const result = await withMaterializedBranch(
      { projectRoot: repo, branch: featureCommit, ref: featureCommit },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ commit: featureCommit, source: "local", fetched: false });
  });

  it("uses an existing local PR head without invoking a network fetch", async () => {
    git(repo, ["update-ref", "refs/pull/7/head", featureCommit]);

    const result = await withMaterializedBranch(
      { projectRoot: repo, branch: "pr/7", ref: "refs/pull/7/head", pr: 7 },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ branch: "pr/7", source: "pull-ref", fetched: false });
  });

  it("fetches a missing remote-qualified branch only when local resolution fails", async () => {
    const remote = path.join(tempDir, "remote.git");
    git(tempDir, ["init", "--bare", remote]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "feature"]);
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/feature"]);
    expect(() => git(repo, ["rev-parse", "--verify", "refs/remotes/origin/feature"])).toThrow();

    const result = await withMaterializedBranch(
      { projectRoot: repo, branch: "origin/feature" },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ source: "remote-fetch", fetched: true, commit: featureCommit });
  });

  it("cleans up the temporary worktree when indexing fails", async () => {
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    let materializedPath = "";

    await expect(withMaterializedBranch(
      { projectRoot: repo, branch: "feature" },
      async (worktreePath) => {
        materializedPath = worktreePath;
        throw new Error("injected indexing failure");
      },
    )).rejects.toThrow("injected indexing failure");

    expect(fs.existsSync(path.dirname(materializedPath))).toBe(false);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(mainCommit);
  });

  it("rejects invalid refs before creating a worktree", async () => {
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    expect(isValidGitRefName("feature; touch /tmp/pwned")).toBe(false);

    await expect(withMaterializedBranch(
      { projectRoot: repo, branch: "feature; touch /tmp/pwned" },
      async () => undefined,
    )).rejects.toThrow("Branch name is invalid");

    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
  });
});
