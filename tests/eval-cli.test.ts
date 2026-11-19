import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const runEvaluationMock = vi.fn();
const runSweepMock = vi.fn();

vi.mock("../src/eval/runner.js", () => ({
  runEvaluation: (...args: unknown[]) => runEvaluationMock(...args),
  runSweep: (...args: unknown[]) => runSweepMock(...args),
}));

import { handleEvalCommand } from "../src/eval/cli.js";

describe("eval cli", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-cli-"));
    runEvaluationMock.mockReset();
    runSweepMock.mockReset();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    { label: "terminal flag", args: ["--reindex", "--config"] },
    { label: "empty value", args: ["--config", ""] },
    { label: "next option", args: ["--config", "--reindex"] },
    { label: "short option", args: ["--config", "-h"] },
    { label: "against option", args: ["--config", "--against", "baseline.json"] },
  ])("requires a config path before starting evaluation ($label)", async ({ args }) => {
    await expect(handleEvalCommand(["run", ...args], tempDir)).rejects.toThrow("--config requires a path");
    expect(runEvaluationMock).not.toHaveBeenCalled();
    expect(runSweepMock).not.toHaveBeenCalled();
  });

  it.each([
    "--project", "--dataset", "--current", "--output", "--against", "--budget",
    "--fusionStrategy", "--hybridWeight", "--rrfK", "--rerankTopN",
    "--sweepFusionStrategy", "--sweepHybridWeight", "--sweepRrfK", "--sweepRerankTopN",
  ])("requires a value for %s before starting runner work", async (flag) => {
    for (const suffix of [[], [""], ["--config", "config.json"], ["-h"]]) {
      await expect(handleEvalCommand(["run", flag, ...suffix], tempDir))
        .rejects.toThrow(`${flag} requires a value`);
      expect(runEvaluationMock).not.toHaveBeenCalled();
      expect(runSweepMock).not.toHaveBeenCalled();
    }
  });

  it("resolves config from invoking cwd and forwards project, baseline, and negative numbers", async () => {
    runEvaluationMock.mockResolvedValue({
      outputDir: path.join(tempDir, "out"),
      summary: { metrics: { hitAt5: 1, mrrAt10: 1, latencyMs: { p95: 1 } } },
    });

    const exitCode = await handleEvalCommand([
      "run", "--project", "nested-project", "--config", "config.json", "--against", "baseline.json",
      "--hybridWeight", "-0.25", "--rrfK", "-10", "--rerankTopN", "-2",
    ], tempDir);

    expect(exitCode).toBe(0);
    expect(runEvaluationMock).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: path.join(tempDir, "nested-project"),
      configPath: path.join(tempDir, "config.json"),
      againstPath: "baseline.json",
      searchOverrides: {
        hybridWeight: -0.25,
        rrfK: -10,
        rerankTopN: -2,
      },
    }));
  });

  it("forwards negative numeric sweep values", async () => {
    runSweepMock.mockResolvedValue({
      outputDir: path.join(tempDir, "out"),
      aggregate: {
        generatedAt: new Date().toISOString(),
        runCount: 2,
        runs: [],
        gatePassed: true,
        failedGateRuns: 0,
      },
    });

    const exitCode = await handleEvalCommand(
      ["run", "--sweepHybridWeight", "-0.25,0.25"],
      tempDir,
    );

    expect(exitCode).toBe(0);
    expect(runSweepMock).toHaveBeenCalledWith(
      expect.any(Object),
      { hybridWeight: [-0.25, 0.25] },
    );
  });

  it("returns non-zero for --ci sweep when any run fails gate", async () => {
    runSweepMock.mockResolvedValue({
      outputDir: path.join(tempDir, "out"),
      aggregate: {
        generatedAt: new Date().toISOString(),
        runCount: 2,
        runs: [],
        gatePassed: false,
        failedGateRuns: 1,
      },
    });

    const exitCode = await handleEvalCommand(
      ["run", "--ci", "--sweepHybridWeight", "0.3,0.7"],
      tempDir
    );

    expect(exitCode).toBe(1);
  });

  it("returns zero for --ci sweep when all runs pass gate", async () => {
    runSweepMock.mockResolvedValue({
      outputDir: path.join(tempDir, "out"),
      aggregate: {
        generatedAt: new Date().toISOString(),
        runCount: 2,
        runs: [],
        gatePassed: true,
        failedGateRuns: 0,
      },
    });

    const exitCode = await handleEvalCommand(
      ["run", "--ci", "--sweepHybridWeight", "0.3,0.7"],
      tempDir
    );

    expect(exitCode).toBe(0);
  });

  it("requires --current for eval diff", async () => {
    await expect(
      handleEvalCommand(["diff", "--against", "baseline.json"], tempDir)
    ).rejects.toThrow(/requires --current/);
  });

  it("validates eval diff current/against file extensions", async () => {
    await expect(
      handleEvalCommand(["diff", "--current", "current.md", "--against", "baseline.json"], tempDir)
    ).rejects.toThrow(/--current must point to a summary JSON file/);

    await expect(
      handleEvalCommand(["diff", "--current", "current.json", "--against", "baseline.md"], tempDir)
    ).rejects.toThrow(/--against must point to a summary JSON file/);
  });

  it("runs eval diff with explicit --current summary path", async () => {
    const currentSummaryPath = path.join(tempDir, "current.json");
    const baselineSummaryPath = path.join(tempDir, "baseline.json");

    const summary = {
      generatedAt: new Date().toISOString(),
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      datasetName: "small",
      datasetVersion: "1.0.0",
      queryCount: 1,
      topK: 10,
      searchConfig: {
        fusionStrategy: "rrf",
        hybridWeight: 0.4,
        rrfK: 60,
        rerankTopN: 20,
      },
      metrics: {
        hitAt1: 1,
        hitAt3: 1,
        hitAt5: 1,
        hitAt10: 1,
        mrrAt10: 1,
        ndcgAt10: 1,
        distinctTop3Ratio: 1,
        rawDistinctTop3Ratio: 1,
        latencyMs: { p50: 1, p95: 2, p99: 3 },
        tokenEstimate: { queryTokens: 10, embeddingTokensUsed: 20 },
        embedding: { callCount: 1, estimatedCostUsd: 0, costPer1MTokensUsd: 0 },
        failureBuckets: {
          "wrong-file": 0,
          "wrong-symbol": 0,
          "docs-tests-outranking-source": 0,
          "no-relevant-hit-top-k": 0,
        },
      },
    };

    writeFileSync(currentSummaryPath, JSON.stringify(summary, null, 2), "utf-8");
    writeFileSync(baselineSummaryPath, JSON.stringify(summary, null, 2), "utf-8");

    const exitCode = await handleEvalCommand(
      ["diff", "--current", "current.json", "--against", "baseline.json"],
      tempDir
    );

    expect(exitCode).toBe(0);
  });

  it("allows eval diff to read legacy summaries missing diversity metrics", async () => {
    const currentSummaryPath = path.join(tempDir, "current.json");
    const baselineSummaryPath = path.join(tempDir, "baseline.json");

    const legacySummary = {
      generatedAt: new Date().toISOString(),
      projectRoot: tempDir,
      datasetPath: "benchmarks/golden/small.json",
      datasetName: "small",
      datasetVersion: "1.0.0",
      queryCount: 1,
      topK: 10,
      searchConfig: {
        fusionStrategy: "rrf",
        hybridWeight: 0.4,
        rrfK: 60,
        rerankTopN: 20,
      },
      metrics: {
        hitAt1: 1,
        hitAt3: 1,
        hitAt5: 1,
        hitAt10: 1,
        mrrAt10: 1,
        ndcgAt10: 1,
        latencyMs: { p50: 1, p95: 2, p99: 3 },
        tokenEstimate: { queryTokens: 10, embeddingTokensUsed: 20 },
        embedding: { callCount: 1, estimatedCostUsd: 0, costPer1MTokensUsd: 0 },
        failureBuckets: {
          "wrong-file": 0,
          "wrong-symbol": 0,
          "docs-tests-outranking-source": 0,
          "no-relevant-hit-top-k": 0,
        },
      },
    };

    writeFileSync(currentSummaryPath, JSON.stringify(legacySummary, null, 2), "utf-8");
    writeFileSync(baselineSummaryPath, JSON.stringify(legacySummary, null, 2), "utf-8");

    const exitCode = await handleEvalCommand(
      ["diff", "--current", "current.json", "--against", "baseline.json"],
      tempDir
    );

    expect(exitCode).toBe(0);
  });
});
