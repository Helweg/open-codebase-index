import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import { getChangedFiles } from "../src/tools/changed-files.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile as typeof execFile);

interface MockResponse {
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function mockExecFile(responses: MockResponse[]): void {
  let callIndex = 0;
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (cmd: string, args: string[], _options: unknown, callback: unknown) => {
      const response = responses[callIndex];
      callIndex += 1;

      if (response === undefined) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          new Error(`Unexpected execFile call: ${cmd} ${JSON.stringify(args)}`),
        );
      }

      if (response.error !== undefined) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          response.error,
        );
      }

      if (response.command !== undefined && response.command !== cmd) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          new Error(`Expected command ${response.command}, got ${cmd}`),
        );
      }

      if (response.args !== undefined && JSON.stringify(response.args) !== JSON.stringify(args)) {
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
          new Error(`Expected args ${JSON.stringify(response.args)}, got ${JSON.stringify(args)}`),
        );
      }

      return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(
        null,
        { stdout: response.stdout ?? "", stderr: response.stderr ?? "" },
      );
    },
  );
}

describe("getChangedFiles", () => {
  const projectRoot = "/test/project";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns changed files for a branch via git", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/x"], stdout: "abc123\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "abc123...feature/x"], stdout: "src/a.ts\0src/b.ts\0" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/x",
      projectRoot,
    });

    expect(result.source).toBe("git");
    expect(result.baseBranch).toBe("main");
    expect(result.headRefName).toBe("feature/x");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("uses the current branch when no branch is provided", async () => {
    mockExecFile([
      { command: "git", args: ["branch", "--show-current"], stdout: "feature/current\n" },
      { command: "git", args: ["merge-base", "main", "feature/current"], stdout: "def456\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "def456...feature/current"], stdout: "README.md\0" },
    ]);

    const result = await getChangedFiles({ projectRoot });

    expect(result.source).toBe("git");
    expect(result.headRefName).toBe("feature/current");
    expect(result.files).toEqual(["README.md"]);
  });

  it("falls back to HEAD in detached-HEAD state", async () => {
    mockExecFile([
      { command: "git", args: ["branch", "--show-current"], stdout: "" },
      { command: "git", args: ["merge-base", "main", "HEAD"], stdout: "detached-base\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "detached-base...HEAD"], stdout: "src/detached.ts\0" },
    ]);

    const result = await getChangedFiles({ projectRoot });

    expect(result.source).toBe("git");
    expect(result.headRefName).toBe("HEAD");
    expect(result.files).toEqual(["src/detached.ts"]);
  });

  it("extracts files from gh pr view when available", async () => {
    mockExecFile([
      {
        command: "gh",
        args: ["pr", "view", "42", "--json", "headRefName,headRefOid,baseRefName,url,files"],
        stdout: JSON.stringify({
          headRefName: "feature/pr-42",
          headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          baseRefName: "main",
          url: "https://github.com/example/project/pull/42",
          files: [{ path: "src/pr.ts" }, { path: "tests/pr.test.ts" }],
        }),
      },
    ]);

    const result = await getChangedFiles({ pr: 42, projectRoot });

    expect(result.source).toBe("gh");
    expect(result.baseBranch).toBe("main");
    expect(result.headRefName).toBe("feature/pr-42");
    expect(result.headRef).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(result.baseRepository).toBe("https://github.com/example/project");
    expect(result.files).toEqual(["src/pr.ts", "tests/pr.test.ts"]);
  });

  it("throws when gh pr view fails", async () => {
    mockExecFile([
      {
        command: "gh",
        args: ["pr", "view", "99", "--json", "headRefName,headRefOid,baseRefName,url,files"],
        error: new Error("GraphQL: Could not resolve to a PullRequest"),
      },
    ]);

    await expect(
      getChangedFiles({ pr: 99, projectRoot }),
    ).rejects.toThrow("Failed to retrieve an authoritative base for PR #99");
  });

  it("uses matching local PR merge parents instead of a wrong configured base", async () => {
    const headCommit = "a".repeat(40);
    const baseCommit = "b".repeat(40);
    mockExecFile([
      {
        command: "gh",
        args: ["pr", "view", "7", "--json", "headRefName,headRefOid,baseRefName,url,files"],
        error: new Error("gh unavailable"),
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "refs/pull/7/head^{commit}"],
        stdout: `${headCommit}\n`,
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "refs/pull/7/merge^2^{commit}"],
        stdout: `${headCommit}\n`,
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "refs/pull/7/merge^1^{commit}"],
        stdout: `${baseCommit}\n`,
      },
      {
        command: "git",
        args: ["diff", "--name-only", "-z", `${baseCommit}...${headCommit}`],
        stdout: "src/safe.ts\0",
      },
    ]);

    const result = await getChangedFiles({
      pr: 7,
      projectRoot,
      baseBranch: "definitely-wrong",
    });

    expect(result).toEqual({
      files: ["src/safe.ts"],
      baseBranch: baseCommit,
      source: "git",
      headRefName: "pr/7",
      headRef: headCommit,
    });
  });

  it("rejects a local PR head when no authoritative base is available", async () => {
    const headCommit = "c".repeat(40);
    mockExecFile([
      {
        command: "gh",
        args: ["pr", "view", "8", "--json", "headRefName,headRefOid,baseRefName,url,files"],
        error: new Error("gh unavailable"),
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "refs/pull/8/head^{commit}"],
        stdout: `${headCommit}\n`,
      },
      {
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", "--end-of-options", "refs/pull/8/merge^2^{commit}"],
        error: new Error("missing merge ref"),
      },
    ]);

    await expect(getChangedFiles({
      pr: 8,
      projectRoot,
      baseBranch: "wrong-base",
    })).rejects.toThrow("safe local fallback requires refs/pull/8/merge");
  });

  it("handles empty diffs gracefully", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/empty"], stdout: "base789\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "base789...feature/empty"], stdout: "" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/empty",
      projectRoot,
    });

    expect(result.files).toEqual([]);
    expect(result.headRefName).toBe("feature/empty");
  });

  it("strips leading ./ from file paths", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/dotslash"], stdout: "base000\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "base000...feature/dotslash"], stdout: "./src/file.ts\0" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/dotslash",
      projectRoot,
    });

    expect(result.files).toEqual(["src/file.ts"]);
    expect(result.headRefName).toBe("feature/dotslash");
  });

  it("deduplicates repeated file paths", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/dup"], stdout: "base111\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "base111...feature/dup"], stdout: "src/a.ts\0src/a.ts\0src/b.ts\0" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/dup",
      projectRoot,
    });

    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.headRefName).toBe("feature/dup");
  });

  it("preserves filenames containing newlines from NUL-delimited git output", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "main", "feature/newline"], stdout: "base222\n" },
      {
        command: "git",
        args: ["diff", "--name-only", "-z", "base222...feature/newline"],
        stdout: "src/line\nbreak.ts\0",
      },
    ]);

    const result = await getChangedFiles({
      branch: "feature/newline",
      projectRoot,
    });

    expect(result.files).toEqual(["src/line\nbreak.ts"]);
  });

  it("respects a custom baseBranch", async () => {
    mockExecFile([
      { command: "git", args: ["merge-base", "develop", "feature/dev"], stdout: "devbase\n" },
      { command: "git", args: ["diff", "--name-only", "-z", "devbase...feature/dev"], stdout: "src/dev.ts\0" },
    ]);

    const result = await getChangedFiles({
      branch: "feature/dev",
      projectRoot,
      baseBranch: "develop",
    });

    expect(result.baseBranch).toBe("develop");
    expect(result.headRefName).toBe("feature/dev");
    expect(result.files).toEqual(["src/dev.ts"]);
  });
});
