import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { buildPerQueryResult, computeEvalMetrics } from "../src/eval/metrics.js";
import * as runner from "../src/eval/runner.js";
import {
  loadFixedDataset,
  parseCliArgs,
  runForRepo,
  type CliOptions,
} from "../scripts/cross-repo-benchmark.js";

vi.mock("../src/eval/runner.js", () => ({
  runEvaluation: vi.fn(),
}));

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function datasetPathForRepo(datasetDir: string, repoName: string): string {
  return path.join(datasetDir, `${repoName}.json`);
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}
let originalBenchmarkRepos: string | undefined;

beforeEach(() => {
  originalBenchmarkRepos = process.env.BENCHMARK_REPOS;
  delete process.env.BENCHMARK_REPOS;
});

afterEach(() => {
  if (originalBenchmarkRepos === undefined) {
    delete process.env.BENCHMARK_REPOS;
  } else {
    process.env.BENCHMARK_REPOS = originalBenchmarkRepos;
  }

  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

function mockedQueryResult(filePath: string) {
  return {
    id: "q-implementation",
    query: "find implementation query",
    queryType: "implementation-intent" as const,
    expected: { filePath },
    retrievalMode: "search" as const,
  };
}

function mockEvalResult(datasetPath: string): Awaited<ReturnType<typeof runner.runEvaluation>> {
  const query = mockedQueryResult(datasetPath);
  const results = [
    buildPerQueryResult(query, [{
      filePath: query.expected.filePath ?? "src/a.ts",
      startLine: 1,
      endLine: 2,
      score: 1,
      chunkType: "function",
      name: "fixture",
    }], 5, 10),
  ];

  const metrics = computeEvalMetrics([query], results, 0, 0, 0);

  const outputDir = path.join(path.dirname(datasetPath), "plugin", "result");
  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "summary.json"), {});
  writeJson(path.join(outputDir, "per-query.json"), []);

  return {
    outputDir,
    summary: {
      generatedAt: new Date().toISOString(),
      projectRoot: path.dirname(datasetPath),
      datasetPath,
      datasetName: "cross-repo-fixed",
      datasetVersion: "1.0.0",
      queryCount: results.length,
      topK: 10,
      searchConfig: {
        fusionStrategy: "rrf",
        hybridWeight: 0.5,
        rrfK: 60,
        rerankTopN: 10,
      },
      metrics,
    },
    perQuery: results,
  };
}

function withRunEvaluationMock(result: Awaited<ReturnType<typeof runner.runEvaluation>>): void {
  vi.mocked(runner.runEvaluation).mockReset();
  vi.mocked(runner.runEvaluation).mockResolvedValue(result);
}

describe("cross-repo benchmark dataset-dir flag", () => {
  it("parses --dataset-dir in CLI args", () => {
    const repoPath = tempDir("cross-repo-benchmark-cli-repo-");
    const datasetDir = tempDir("cross-repo-benchmark-cli-fixed-");

    const parsed = parseCliArgs(["--repos", repoPath, "--dataset-dir", datasetDir]);
    expect(parsed.datasetDir).toBe(datasetDir);

    expect(parseCliArgs(["--repos", repoPath]).datasetDir).toBeUndefined();
  });

  it("loads a fixed dataset with all supported evidence path fields", () => {
    const repoPath = tempDir("cross-repo-benchmark-fixed-load-repo-");
    const fixedDir = tempDir("cross-repo-benchmark-fixed-load-");
    const repoName = path.basename(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "fixture.ts"), "export function fixture() {}", "utf-8");
    fs.writeFileSync(path.join(repoPath, "src", "other.ts"), "export function other() {}", "utf-8");

    const dataset = {
      version: "1.0.0",
      name: "fixed-fixture",
      queries: [
        {
          id: "implementation",
          query: "where is fixture implemented",
          queryType: "implementation-intent",
          expected: {
            filePath: "src/fixture.ts",
            acceptableFiles: ["src/other.ts"],
            gradedEvidence: [
              {
                path: "src/other.ts",
                relevance: 1,
              },
            ],
          },
        },
      ],
    };

    const fixedPath = datasetPathForRepo(fixedDir, repoName);
    writeJson(fixedPath, dataset);

    const loaded = loadFixedDataset(fixedPath, repoPath);
    expect(loaded.version).toBe("1.0.0");
    expect(loaded.name).toBe("fixed-fixture");
    expect(loaded.queries[0]).toMatchObject(dataset.queries[0]);
  });

  it("rejects fixed datasets with missing evidence paths", () => {
    const repoPath = tempDir("cross-repo-benchmark-fixed-missing-");
    const fixedDir = tempDir("cross-repo-benchmark-fixed-missing-path-");
    const repoName = path.basename(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "fixture.ts"), "export function fixture() {}", "utf-8");

    const fixedPath = datasetPathForRepo(fixedDir, repoName);
    writeJson(fixedPath, {
      version: "1.0.0",
      name: "missing-path",
      queries: [
        {
          id: "implementation",
          query: "where is missing",
          queryType: "implementation-intent",
          expected: {
            filePath: "src/missing.ts",
          },
        },
      ],
    });

    expect(() => loadFixedDataset(fixedPath, repoPath)).toThrow(/does not exist/);
  });

  it("rejects fixed datasets with evidence paths that escape repository root", () => {
    const repoPath = tempDir("cross-repo-benchmark-fixed-outside-");
    const fixedDir = tempDir("cross-repo-benchmark-fixed-outside-path-");
    const repoName = path.basename(repoPath);
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "fixture.ts"), "export function fixture() {}", "utf-8");

    const fixedPath = datasetPathForRepo(fixedDir, repoName);
    writeJson(fixedPath, {
      version: "1.0.0",
      name: "outside-path",
      queries: [
        {
          id: "implementation",
          query: "where is outside",
          queryType: "implementation-intent",
          expected: {
            filePath: "../outside.ts",
          },
        },
      ],
    });

    expect(() => loadFixedDataset(fixedPath, repoPath)).toThrow(/outside repository/);
  });

  it("uses fixed dataset file when present and copies it to run artifacts", async () => {
    const repoPath = tempDir("cross-repo-benchmark-run-fixed-repo-");
    const fixedDir = tempDir("cross-repo-benchmark-run-fixed-");
    const runRoot = tempDir("cross-repo-benchmark-run-fixed-artifacts-");
    const repoName = path.basename(repoPath);
    const datasetPath = datasetPathForRepo(fixedDir, repoName);

    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "src", "fixture.ts"), "export function fixture() {}", "utf-8");

    const dataset = {
      version: "1.0.0",
      name: "fixed-fixture",
      queries: [
        {
          id: "implementation",
          query: "where is fixture",
          queryType: "implementation-intent",
          expected: {
            filePath: "src/fixture.ts",
          },
        },
      ],
    };
    writeJson(datasetPath, dataset);

    const expectedRunDatasetPath = path.join(runRoot, "datasets", `${repoName}.json`);
    withRunEvaluationMock(mockEvalResult(expectedRunDatasetPath));

    const options: CliOptions = {
      repos: [repoPath],
      outputRoot: runRoot,
      datasetDir: fixedDir,
      reindex: false,
      repeats: 1,
      maxParseFiles: 20,
      persistDatasets: false,
      skipRipgrep: true,
      skipSg: true,
      codegraph: false,
      codebaseMemoryMcp: false,
    };

    const result = await runForRepo(
      repoPath,
      options,
      runRoot,
      path.join(runRoot, "datasets"),
      path.join(runRoot, "persist")
    );

    expect(result.error).toBeUndefined();
    expect(result.datasetPath).toBe(expectedRunDatasetPath);
    expect(result.datasetQueryCount).toBe(1);

    const copied = JSON.parse(fs.readFileSync(result.datasetPath, "utf-8")) as { name: string; queries: unknown[] };
    expect(copied).toEqual(dataset);
    expect(vi.mocked(runner.runEvaluation).mock.calls[0]?.[0].datasetPath).toBe(result.datasetPath);
  });

  it("falls back to generation when fixed dataset is absent for repo", async () => {
    const repoPath = process.cwd();
    const fixedDir = tempDir("cross-repo-benchmark-run-missing-");
    const runRoot = tempDir("cross-repo-benchmark-run-generated-artifacts-");
    const datasetToIgnore = {
      version: "1.0.0",
      name: "wrong-repo",
      queries: [
        {
          id: "other",
          query: "never used",
          queryType: "implementation-intent",
          expected: {
            filePath: "src/fixture.ts",
          },
        },
      ],
    };
    writeJson(path.join(fixedDir, `wrong-repo.json`), datasetToIgnore);

    const options: CliOptions = {
      repos: [repoPath],
      outputRoot: runRoot,
      datasetDir: fixedDir,
      reindex: false,
      repeats: 1,
      maxParseFiles: 20,
      persistDatasets: false,
      skipRipgrep: true,
      skipSg: true,
      codegraph: false,
      codebaseMemoryMcp: false,
    };

    const expectedRunDatasetPath = path.join(runRoot, "datasets", `${path.basename(repoPath)}.json`);
    withRunEvaluationMock(mockEvalResult(expectedRunDatasetPath));

    const result = await runForRepo(
      repoPath,
      options,
      runRoot,
      path.join(runRoot, "datasets"),
      path.join(runRoot, "persist")
    );

    expect(result.error).toBeUndefined();
    const generated = JSON.parse(fs.readFileSync(result.datasetPath, "utf-8")) as { name: string };
    expect(generated.name).toBe(`cross-repo-${path.basename(repoPath)}`);
    expect(generated.name).not.toBe("wrong-repo");
  });
});
