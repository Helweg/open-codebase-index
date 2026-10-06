import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { execSync } from "node:child_process";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  parseCliArgs,
  validateCrossRepoCohortSources,
} from "../scripts/validate-cross-repo-cohort.js";
import { spawnSync } from "node:child_process";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(process.cwd(), "tmp-") + prefix);
  tempDirs.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeRepoFiles(repoPath: string, entries: Record<string, string>): void {
  for (const [fileName, content] of Object.entries(entries)) {
    const absolute = path.join(repoPath, fileName);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf-8");
  }
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "ignore",
  });

  if (result.status !== 0) {
    throw new Error(`git command failed: git ${args.join(" ")}`);
  }
}

function createGitRepo(): { repoPath: string; rev1: string } {
  const repoPath = tempDir("cross-repo-cohort-src-");
  fs.mkdirSync(repoPath, { recursive: true });

  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.name", "ci"]);
  runGit(repoPath, ["config", "user.email", "ci@example.com"]);

  writeRepoFiles(repoPath, {
    "src/fixture.ts": "export function expectedSymbol() { return 1; }\n",
  });
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "initial"]); 
  const rev1 = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
  return { repoPath, rev1 };
}

function createCohortFixture(options: { repoPath: string; revision: string; symbol: string }) {
  const cohortDir = tempDir("cross-repo-cohort-manifest-");
  const datasetName = "fixture.json";
  const cohortName = "cohort-local";

  writeJson(path.join(cohortDir, "cohort.json"), {
    version: "1.3.0",
    name: "cohort-local",
    repositories: [{
      name: "local-repo",
      url: options.repoPath,
      revision: options.revision,
      dataset: datasetName,
    }],
  });

  writeJson(path.join(cohortDir, datasetName), {
    version: "1.2.0",
    name: cohortName,
    queries: [
      {
        id: "definition-1",
        query: "where is expectedSymbol defined",
        queryType: "definition",
        retrievalMode: "context",
        args: {
          symbol: options.symbol,
        },
        expected: {
          filePath: "src/fixture.ts",
          symbol: options.symbol,
          expectedRoute: "definition",
        },
      },
    ],
  });

  return { cohortDir };
}

function writeStudyApproval(
  cohortDir: string,
  overrides: Record<string, unknown> = {},
): { studyApproval: string; noveltyEvidence: string } {
  const manifestPath = path.join(cohortDir, "cohort.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    repositories: Array<{ name: string; url: string; revision: string }>;
  };
  const approvalPath = path.join(cohortDir, "study-approval.json");
  const noveltyEvidence = path.join(cohortDir, "synthetic-novelty-evidence.bin");
  // Synthetic test evidence only: include non-text bytes and CRLF to catch text normalization.
  const evidence = Buffer.from([0xef, 0xbb, 0xbf, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65, 0x0d, 0x0a, 0xff, 0x00]);
  fs.writeFileSync(noveltyEvidence, evidence);
  writeJson(approvalPath, {
    schemaVersion: 1,
    noveltyDecision: "accepted_novel",
    sourceAcquisitionAuthorized: true,
    auditor: "synthetic-fixture-reviewer",
    auditedAt: "2026-09-21T00:00:00.000Z",
    evidenceSha256: crypto.createHash("sha256").update(evidence).digest("hex"),
    cohortSha256: crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
    repositories: manifest.repositories.map(({ name, url, revision }) => ({ name, url, revision })),
    ...overrides,
  });
  return { studyApproval: approvalPath, noveltyEvidence };
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("cross-repo source validator", () => {
  it("validates pinned revision definition symbol presence in local fixture repos", async () => {
    const { repoPath, rev1 } = createGitRepo();
    const { cohortDir } = createCohortFixture({
      repoPath,
      revision: rev1,
      symbol: "expectedSymbol",
    });
    const workDir = tempDir("cross-repo-cohort-work-");

    const summary = await validateCrossRepoCohortSources({
      cohortDir,
      workDir,
    });

    expect(summary.repositoriesChecked).toBe(1);
    expect(summary.repositoriesPassed).toBe(1);
    expect(summary.repositoriesFailed).toBe(0);
    expect(summary.repoResults[0]).toMatchObject({
      repository: "local-repo",
      definitionQueriesChecked: 1,
      definitionQueriesWithMissingSymbols: 0,
    });
    expect(fs.existsSync(summary.workspaceDir)).toBe(false);
  });

  it("fails when a definition symbol is not present in the expected file", async () => {
    const { repoPath, rev1 } = createGitRepo();
    const { cohortDir } = createCohortFixture({
      repoPath,
      revision: rev1,
      symbol: "missingSymbol",
    });

    const result = await validateCrossRepoCohortSources({ cohortDir });

    expect(result.repositoriesChecked).toBe(1);
    expect(result.repositoriesPassed).toBe(0);
    expect(result.repositoriesFailed).toBe(1);
    expect(result.repoResults[0].definitionQueriesWithMissingSymbols).toBe(1);
    expect(result.repoResults[0].missing).toHaveLength(1);
    expect(result.repoResults[0].missing[0]!.queryId).toBe("definition-1");
  });

  it("accepts a synthetic authorized approval bound to exact cohort and evidence bytes", async () => {
    const { repoPath, rev1 } = createGitRepo();
    const { cohortDir } = createCohortFixture({
      repoPath,
      revision: rev1,
      symbol: "expectedSymbol",
    });
    const { studyApproval, noveltyEvidence } = writeStudyApproval(cohortDir);

    const summary = await validateCrossRepoCohortSources({ cohortDir, studyApproval, noveltyEvidence });

    expect(summary.repositoriesPassed).toBe(1);
    expect(summary.repositoriesFailed).toBe(0);
  });

  it.each([
    ["rejected novelty decision", { noveltyDecision: "not_accepted_fail_closed" }, "noveltyDecision"],
    ["missing source authorization", { sourceAcquisitionAuthorized: false }, "sourceAcquisitionAuthorized"],
    ["cohort hash mismatch", { cohortSha256: "b".repeat(64) }, "cohortSha256"],
    ["repository pin mismatch", { repositories: [] }, "approved repositories"],
  ])("blocks %s before creating the source workspace", async (_label, overrides, message) => {
    const { repoPath, rev1 } = createGitRepo();
    const { cohortDir } = createCohortFixture({
      repoPath,
      revision: rev1,
      symbol: "expectedSymbol",
    });
    const { studyApproval, noveltyEvidence } = writeStudyApproval(cohortDir, overrides);
    const workDir = path.join(tempDir("cross-repo-approval-parent-"), "must-not-exist");

    await expect(validateCrossRepoCohortSources({ cohortDir, studyApproval, noveltyEvidence, workDir }))
      .rejects.toThrow(message);
    expect(fs.existsSync(workDir)).toBe(false);
  });

  it.each([
    ["tampered", "evidenceSha256"],
    ["missing", "Cannot read novelty evidence"],
    ["unreadable directory", "Cannot read novelty evidence"],
  ])("blocks %s evidence before workspace creation or Git invocation", async (state, message) => {
    const { cohortDir } = createCohortFixture({
      repoPath: path.join(tempDir("cross-repo-unused-source-"), "must-not-be-acquired"),
      revision: "fixture-revision",
      symbol: "expectedSymbol",
    });
    const { studyApproval, noveltyEvidence } = writeStudyApproval(cohortDir);
    if (state === "tampered") {
      fs.appendFileSync(noveltyEvidence, "\n");
    } else {
      fs.rmSync(noveltyEvidence);
      if (state === "unreadable directory") {
        fs.mkdirSync(noveltyEvidence);
      }
    }
    const parent = tempDir("cross-repo-evidence-parent-");
    const workDir = path.join(parent, "must-not-exist");
    const gitMarker = path.join(parent, "git-was-invoked");
    const gitBin = path.join(parent, "bin");
    fs.mkdirSync(gitBin);
    fs.writeFileSync(path.join(gitBin, "git"), `#!/bin/sh\nprintf called > "${gitMarker}"\nexit 1\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${gitBin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(validateCrossRepoCohortSources({ cohortDir, studyApproval, noveltyEvidence, workDir }))
        .rejects.toThrow(message);
      expect(fs.existsSync(workDir)).toBe(false);
      expect(fs.existsSync(gitMarker)).toBe(false);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it.each([
    [{ studyApproval: "fixture-approval.json" }, "--study-approval requires --novelty-evidence"],
    [{ noveltyEvidence: "fixture-evidence.bin" }, "--novelty-evidence requires --study-approval"],
  ])("rejects an unpaired gate option before reading sources or creating a workspace", async (options, message) => {
    const parent = tempDir("cross-repo-unpaired-parent-");
    const cohortDir = path.join(parent, "must-not-be-read");
    const workDir = path.join(parent, "must-not-exist");

    await expect(validateCrossRepoCohortSources({ cohortDir, workDir, ...options }))
      .rejects.toThrow(message);
    expect(fs.existsSync(workDir)).toBe(false);
  });

  it("supports cohort, cache, paired study approval and novelty evidence CLI flags", () => {
    const customCohortDir = path.join(process.cwd(), "tmp-fixture-cohort");
    const customWorkDir = path.join(process.cwd(), "tmp-validator-work");
    const customApproval = path.join(process.cwd(), "tmp-study-approval.json");
    const customEvidence = path.join(process.cwd(), "tmp-novelty-evidence.bin");
    const parsed = parseCliArgs([
      "--cohort-dir",
      customCohortDir,
      "--cache-dir",
      customWorkDir,
      "--study-approval",
      customApproval,
      "--novelty-evidence",
      customEvidence,
    ]);

    expect(parsed).toEqual({
      cohortDir: path.resolve(customCohortDir),
      workDir: path.resolve(customWorkDir),
      studyApproval: path.resolve(customApproval),
      noveltyEvidence: path.resolve(customEvidence),
    });
  });

  it("rejects a novelty evidence flag without a path", () => {
    expect(() => parseCliArgs(["--novelty-evidence"]))
      .toThrow("--novelty-evidence requires a path");
  });
});
