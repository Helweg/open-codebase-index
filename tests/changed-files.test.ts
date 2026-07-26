import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPullRequestCatalogIdentity,
  getChangedFiles,
} from "../src/tools/changed-files.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const execFileAsync = promisify(execFile as typeof execFile);
const GH_FIELDS = "number,headRefName,headRefOid,headRepository,headRepositoryOwner,baseRefName,url,files";
const BASE_COMMIT = "1".repeat(40);
const HEAD_COMMIT = "2".repeat(40);
const MERGE_BASE = "3".repeat(40);

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
        return (callback as (err: Error | null, result?: { stdout: string; stderr: string }) => void)(response.error);
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

function localBranchResolutionResponses(
  baseRef: string,
  headRef: string,
  baseCommit = BASE_COMMIT,
  headCommit = HEAD_COMMIT,
  mergeBase = MERGE_BASE,
  diff = "src/a.ts\0src/b.ts\0",
): MockResponse[] {
  const responses: MockResponse[] = [
    {
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${baseRef}^{commit}`],
      stdout: `${baseCommit}\n`,
    },
  ];
  if (headRef.includes("/") && !headRef.startsWith("refs/")) {
    responses.push({ command: "git", args: ["remote"], stdout: "" });
  }
  responses.push(
    {
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${headRef === "HEAD" ? "HEAD" : `refs/heads/${headRef}`}^{commit}`],
      stdout: `${headCommit}\n`,
    },
    {
      command: "git",
      args: ["merge-base", "--", baseCommit, headCommit],
      stdout: `${mergeBase}\n`,
    },
    {
      command: "git",
      args: ["diff", "--name-only", "-z", `${mergeBase}...${headCommit}`, "--"],
      stdout: diff,
    },
  );
  return responses;
}

function ghResponse(options: {
  pr?: number;
  owner?: string;
  repository?: string;
  headOwner?: string;
  headRepository?: string;
  headRefName?: string;
  headRefOid?: string;
  files?: string[];
} = {}): MockResponse {
  const pr = options.pr ?? 42;
  const owner = options.owner ?? "example";
  const repository = options.repository ?? "project";
  const headOwner = options.headOwner ?? owner;
  const headRepository = options.headRepository ?? repository;
  return {
    command: "gh",
    args: ["pr", "view", String(pr), "--json", GH_FIELDS],
    stdout: JSON.stringify({
      number: pr,
      headRefName: options.headRefName ?? "feature/pr-42",
      headRefOid: options.headRefOid ?? HEAD_COMMIT,
      headRepository: { name: headRepository, nameWithOwner: `${headOwner}/${headRepository}` },
      headRepositoryOwner: { login: headOwner },
      baseRefName: "main",
      url: `https://github.com/${owner}/${repository}/pull/${pr}`,
      files: (options.files ?? ["src/pr.ts", "tests/pr.test.ts"]).map((file) => ({ path: file })),
    }),
  };
}

function missingLocalPrResponses(pr: number): MockResponse[] {
  return [
    {
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/pull/${pr}/head^{commit}`],
      error: new Error("missing head"),
    },
    {
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/pull/${pr}/merge^2^{commit}`],
      error: new Error("missing merge"),
    },
  ];
}

void execFileAsync;

describe("getChangedFiles", () => {
  const projectRoot = "/test/project";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves branch refs to full OIDs before merge-base and NUL-delimited diff", async () => {
    mockExecFile(localBranchResolutionResponses("main", "feature/x"));

    const result = await getChangedFiles({ branch: "feature/x", projectRoot });

    expect(result).toMatchObject({
      source: "git",
      baseBranch: "main",
      catalogIdentity: "feature/x",
      headRefName: "feature/x",
      headRef: HEAD_COMMIT,
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("uses the current branch when no branch is provided", async () => {
    mockExecFile([
      { command: "git", args: ["branch", "--show-current"], stdout: "feature/current\n" },
      ...localBranchResolutionResponses("main", "feature/current", BASE_COMMIT, HEAD_COMMIT, MERGE_BASE, "README.md\0"),
    ]);

    const result = await getChangedFiles({ projectRoot });
    expect(result.headRefName).toBe("feature/current");
    expect(result.files).toEqual(["README.md"]);
  });

  it("falls back to HEAD in detached-HEAD state", async () => {
    mockExecFile([
      { command: "git", args: ["branch", "--show-current"], stdout: "" },
      ...localBranchResolutionResponses("main", "HEAD", BASE_COMMIT, HEAD_COMMIT, MERGE_BASE, "src/detached.ts\0"),
    ]);

    const result = await getChangedFiles({ projectRoot });
    expect(result.headRefName).toBe("HEAD");
    expect(result.headRef).toBe(HEAD_COMMIT);
    expect(result.files).toEqual(["src/detached.ts"]);
  });

  it("returns repository-aware authoritative metadata from gh", async () => {
    mockExecFile([ghResponse({ headOwner: "fork-owner", headRepository: "fork-project" })]);

    const result = await getChangedFiles({ pr: 42, projectRoot });

    expect(result).toMatchObject({
      source: "gh",
      baseBranch: "main",
      headRefName: "feature/pr-42",
      headRef: HEAD_COMMIT,
      baseRepository: "https://github.com/example/project",
      baseRepositoryIdentity: "github.com/example/project",
      headRepositoryIdentity: "github.com/fork-owner/fork-project",
      catalogIdentity: createPullRequestCatalogIdentity(
        "github.com/example/project",
        42,
        "github.com/fork-owner/fork-project",
      ),
      files: ["src/pr.ts", "tests/pr.test.ts"],
    });
  });

  it("does not collide when two forks use the same PR number and display branch", async () => {
    mockExecFile([
      ghResponse({ headOwner: "alice", headRepository: "project", headRefName: "shared" }),
      ghResponse({ headOwner: "bob", headRepository: "project", headRefName: "shared" }),
    ]);

    const alice = await getChangedFiles({ pr: 42, projectRoot });
    const bob = await getChangedFiles({ pr: 42, projectRoot });

    expect(alice.headRefName).toBe(bob.headRefName);
    expect(alice.catalogIdentity).not.toBe(bob.catalogIdentity);
  });

  it("rejects gh metadata for a different PR number", async () => {
    const response = ghResponse({ pr: 42 });
    response.stdout = JSON.stringify({
      ...JSON.parse(response.stdout ?? "{}"),
      number: 41,
    });
    mockExecFile([response, ...missingLocalPrResponses(42)]);

    await expect(getChangedFiles({ pr: 42, projectRoot })).rejects.toThrow(
      "gh returned PR #41 while PR #42 was requested",
    );
  });

  it("throws when gh and authoritative local PR refs are unavailable", async () => {
    mockExecFile([
      { command: "gh", args: ["pr", "view", "99", "--json", GH_FIELDS], error: new Error("missing PR") },
      ...missingLocalPrResponses(99),
    ]);

    await expect(getChangedFiles({ pr: 99, projectRoot })).rejects.toThrow(
      "Failed to retrieve an authoritative base for PR #99",
    );
  });

  it("uses matching local PR merge parents and an isolated local catalog identity", async () => {
    const headCommit = "a".repeat(40);
    const baseCommit = "b".repeat(40);
    mockExecFile([
      { command: "gh", args: ["pr", "view", "7", "--json", GH_FIELDS], error: new Error("gh unavailable") },
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
        args: ["diff", "--name-only", "-z", `${baseCommit}...${headCommit}`, "--"],
        stdout: "src/safe.ts\0",
      },
    ]);

    const result = await getChangedFiles({ pr: 7, projectRoot, baseBranch: "wrong" });

    expect(result.source).toBe("git");
    expect(result.baseBranch).toBe(baseCommit);
    expect(result.headRef).toBe(headCommit);
    expect(result.catalogIdentity).toContain(encodeURIComponent(`local:${path.resolve(projectRoot)}`));
    expect(result.files).toEqual(["src/safe.ts"]);
  });

  it("rejects a local PR head when no authoritative base is available", async () => {
    const headCommit = "c".repeat(40);
    mockExecFile([
      { command: "gh", args: ["pr", "view", "8", "--json", GH_FIELDS], error: new Error("gh unavailable") },
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

    await expect(getChangedFiles({ pr: 8, projectRoot })).rejects.toThrow(
      "safe local fallback requires refs/pull/8/merge",
    );
  });

  it("handles an empty diff", async () => {
    mockExecFile(localBranchResolutionResponses("main", "feature/empty", BASE_COMMIT, HEAD_COMMIT, MERGE_BASE, ""));
    const result = await getChangedFiles({ branch: "feature/empty", projectRoot });
    expect(result.files).toEqual([]);
  });

  it("preserves newline and space filenames and deduplicates NUL-delimited output", async () => {
    mockExecFile(localBranchResolutionResponses(
      "main",
      "feature/nul",
      BASE_COMMIT,
      HEAD_COMMIT,
      MERGE_BASE,
      "src/line\nbreak.ts\0src/with space.ts\0src/line\nbreak.ts\0",
    ));

    const result = await getChangedFiles({ branch: "feature/nul", projectRoot });
    expect(result.files).toEqual(["src/line\nbreak.ts", "src/with space.ts"]);
  });

  it("rejects changed paths that escape the project root", async () => {
    mockExecFile([
      ghResponse({ files: ["../outside.ts"] }),
      ...missingLocalPrResponses(42),
    ]);

    await expect(getChangedFiles({ pr: 42, projectRoot })).rejects.toThrow(
      "Changed file escapes the project root",
    );
  });

  it("respects a custom base branch while keeping comparisons OID-only", async () => {
    mockExecFile(localBranchResolutionResponses("develop", "feature/dev", BASE_COMMIT, HEAD_COMMIT, MERGE_BASE, "src/dev.ts\0"));

    const result = await getChangedFiles({ branch: "feature/dev", projectRoot, baseBranch: "develop" });
    expect(result.baseBranch).toBe("develop");
    expect(result.files).toEqual(["src/dev.ts"]);
  });
});
