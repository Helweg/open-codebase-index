import * as fs from "node:fs";
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

  it("supports --cohort-dir and --cache-dir CLI flags", () => {
    const customCohortDir = path.join(process.cwd(), "tmp-fixture-cohort");
    const customWorkDir = path.join(process.cwd(), "tmp-validator-work");
    const parsed = parseCliArgs([
      "--cohort-dir",
      customCohortDir,
      "--cache-dir",
      customWorkDir,
    ]);

    expect(parsed).toEqual({
      cohortDir: path.resolve(customCohortDir),
      workDir: path.resolve(customWorkDir),
    });
  });
});
