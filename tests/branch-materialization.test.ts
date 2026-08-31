import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isValidGitRefName,
  isValidGitRemoteName,
  withMaterializedBranch,
} from "../src/git/branch-materialization.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ["add", "--", file]);
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
    vi.unstubAllEnvs();
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
      { projectRoot: repo, branch: featureCommit, ref: featureCommit, expectedCommit: featureCommit },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ commit: featureCommit, source: "local", fetched: false });
  });

  it("uses an existing local PR head only when it matches the authoritative OID", async () => {
    git(repo, ["update-ref", "refs/pull/7/head", featureCommit]);

    const result = await withMaterializedBranch(
      {
        projectRoot: repo,
        branch: "pr/7",
        ref: featureCommit,
        expectedCommit: featureCommit,
        pr: 7,
      },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ branch: "pr/7", source: "pull-ref", fetched: false });
  });

  it("fetches a missing remote-qualified branch without reading or overwriting FETCH_HEAD", async () => {
    const remote = path.join(tempDir, "remote.git");
    git(tempDir, ["init", "--bare", remote]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "feature"]);
    const fetchHeadPath = path.join(repo, ".git", "FETCH_HEAD");
    fs.writeFileSync(fetchHeadPath, "sentinel-fetch-head\n");
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/feature"]);

    const result = await withMaterializedBranch(
      { projectRoot: repo, branch: "origin/feature", expectedCommit: featureCommit },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ source: "remote-fetch", fetched: true, commit: featureCommit });
    expect(fs.readFileSync(fetchHeadPath, "utf8")).toBe("sentinel-fetch-head\n");
    expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/codebase-index"])).toBe("");
  });

  it("prefers an independently configured remote over a shadowing local branch name", async () => {
    const remote = path.join(tempDir, "shadow-remote.git");
    git(tempDir, ["init", "--bare", remote]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "feature"]);
    git(repo, ["branch", "origin/feature", mainCommit]);
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/feature"]);

    const result = await withMaterializedBranch(
      { projectRoot: repo, branch: "origin/feature", expectedCommit: featureCommit },
      async (worktreePath) => ({
        head: git(worktreePath, ["rev-parse", "HEAD"]),
        value: fs.readFileSync(path.join(worktreePath, "src/value.ts"), "utf8"),
      }),
    );

    expect(result.value.head).toBe(featureCommit);
    expect(result.value.value).toContain("feature");
    expect(result.info.source).toBe("remote-fetch");
  });

  it("fetches an exact missing PR OID without gh checkout and removes the temporary ref", async () => {
    const remote = path.join(tempDir, "pr-remote.git");
    git(tempDir, ["init", "--bare", remote]);
    git(repo, ["remote", "add", "origin", remote]);
    git(repo, ["push", "origin", "main", "feature"]);
    git(remote, ["update-ref", "refs/pull/9/head", featureCommit]);
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/feature"]);
    git(repo, ["reflog", "expire", "--expire=now", "--all"]);
    git(repo, ["gc", "--prune=now"]);
    expect(() => git(repo, ["cat-file", "-e", `${featureCommit}^{commit}`])).toThrow();

    const result = await withMaterializedBranch(
      {
        projectRoot: repo,
        branch: "pr/9",
        ref: featureCommit,
        expectedCommit: featureCommit,
        pr: 9,
      },
      async (worktreePath) => git(worktreePath, ["rev-parse", "HEAD"]),
    );

    expect(result.value).toBe(featureCommit);
    expect(result.info).toMatchObject({ source: "pull-ref", fetched: true, commit: featureCommit });
    expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/codebase-index"])).toBe("");
  });

  it("rejects a dangerous remote name before Git can interpret it as an option", async () => {
    const remote = path.join(tempDir, "injection-remote.git");
    const bin = path.join(tempDir, "bin");
    const marker = path.join(tempDir, "upload-pack-option-ran");
    const victim = path.join(tempDir, "victim");
    fs.mkdirSync(bin);
    fs.writeFileSync(victim, "must survive");
    fs.writeFileSync(
      path.join(bin, "rm"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n/bin/rm -f ${JSON.stringify(victim)}\nexit 1\n`,
    );
    fs.chmodSync(path.join(bin, "rm"), 0o755);
    git(tempDir, ["init", "--bare", remote]);
    git(repo, ["config", "remote.--upload-pack=rm.url", remote]);
    expect(isValidGitRemoteName("--upload-pack=rm")).toBe(false);

    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    try {
      await expect(withMaterializedBranch(
        { projectRoot: repo, branch: "refs/remotes/--upload-pack=rm/feature" },
        async () => undefined,
      )).rejects.toThrow("Git remote name is unsafe");
    } finally {
      process.env.PATH = originalPath;
    }

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("must survive");
    expect(git(repo, ["for-each-ref", "--format=%(refname)", "refs/codebase-index"])).toBe("");
  });

  it("rejects a materialization whose resolved OID differs from authoritative metadata", async () => {
    await expect(withMaterializedBranch(
      { projectRoot: repo, branch: "feature", expectedCommit: mainCommit },
      async () => undefined,
    )).rejects.toThrow("authoritative metadata requires");
  });

  it("suppresses configured repository post-checkout hooks while adding the worktree", async () => {
    const marker = path.join(tempDir, "post-checkout-ran");
    const configuredHooks = path.join(tempDir, "malicious-hooks");
    const hook = path.join(configuredHooks, "post-checkout");
    fs.mkdirSync(configuredHooks);
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(hook, 0o755);
    git(repo, ["config", "core.hooksPath", configuredHooks]);

    await withMaterializedBranch(
      { projectRoot: repo, branch: "feature", expectedCommit: featureCommit },
      async () => undefined,
    );

    expect(fs.existsSync(marker)).toBe(false);
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

  it("cleans up the temporary worktree when the caller cancels", async () => {
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const controller = new AbortController();
    let materializedPath = "";

    await expect(withMaterializedBranch(
      { projectRoot: repo, branch: "feature", signal: controller.signal },
      async (worktreePath) => {
        materializedPath = worktreePath;
        controller.abort();
        return "ignored";
      },
    )).rejects.toBeInstanceOf(OperationCancelledError);

    expect(fs.existsSync(path.dirname(materializedPath))).toBe(false);
    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(mainCommit);
  });

  it("removes only the exact stale registration when the materialized directory disappears", async () => {
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);

    await expect(withMaterializedBranch(
      { projectRoot: repo, branch: "feature" },
      async (worktreePath) => {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        throw new Error("primary indexing failure");
      },
    )).rejects.toThrow("primary indexing failure");

    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
  });

  it("removes a missing temporary worktree registered through a symlinked temp path", async () => {
    const beforeWorktrees = git(repo, ["worktree", "list", "--porcelain"]);
    const physicalTempDir = path.join(tempDir, "physical-temp");
    const linkedTempDir = path.join(tempDir, "linked-temp");
    fs.mkdirSync(physicalTempDir);
    fs.symlinkSync(physicalTempDir, linkedTempDir, "dir");
    vi.stubEnv("TMPDIR", linkedTempDir);

    await expect(withMaterializedBranch(
      { projectRoot: repo, branch: "feature" },
      async (worktreePath) => {
        fs.rmSync(worktreePath, { recursive: true, force: true });
        throw new Error("primary indexing failure");
      },
    )).rejects.toThrow("primary indexing failure");

    expect(git(repo, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);
  });

  it("preserves the temporary path and primary error when deregistration cannot be verified", async () => {
    const gitDir = path.join(repo, ".git");
    const hiddenGitDir = path.join(repo, ".git-hidden");
    let materializedPath = "";
    let caught: unknown;

    try {
      try {
        await withMaterializedBranch(
          { projectRoot: repo, branch: "feature" },
          async (worktreePath) => {
            materializedPath = worktreePath;
            fs.renameSync(gitDir, hiddenGitDir);
            throw new Error("primary indexing failure");
          },
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate = caught as AggregateError;
      expect(aggregate.errors[0]).toBeInstanceOf(Error);
      expect((aggregate.errors[0] as Error).message).toBe("primary indexing failure");
      expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
      expect(fs.existsSync(path.dirname(materializedPath))).toBe(true);
    } finally {
      if (fs.existsSync(hiddenGitDir)) {
        fs.renameSync(hiddenGitDir, gitDir);
      }
      if (materializedPath && fs.existsSync(path.dirname(materializedPath))) {
        try {
          git(repo, ["worktree", "remove", "--force", "--force", "--", materializedPath]);
        } catch {
          // The assertion above verifies cleanup failure preservation. Test teardown is best effort.
        }
        fs.rmSync(path.dirname(materializedPath), { recursive: true, force: true });
      }
    }

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
