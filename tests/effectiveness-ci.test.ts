import { readFileSync } from "fs";

import { describe, expect, it } from "vitest";

import { evaluateBudgetGate } from "../src/eval/budget.js";
import type { EvalBudget, EvalSummary } from "../src/eval/types.js";

function summary(hitAt5: number, mrrAt10: number): EvalSummary {
  return {
    generatedAt: "2026-07-28T00:00:00.000Z",
    projectRoot: "/evaluation-fixture",
    datasetPath: "/evaluation-fixture/benchmarks/golden/small.json",
    datasetName: "small",
    datasetVersion: "1",
    queryCount: 8,
    topK: 10,
    searchConfig: {
      fusionStrategy: "rrf",
      hybridWeight: 0.4,
      rrfK: 60,
      rerankTopN: 20,
    },
    metrics: {
      hitAt1: 0,
      hitAt3: 0,
      hitAt5,
      hitAt10: hitAt5,
      mrrAt10,
      ndcgAt10: 0,
      distinctTop3Ratio: 1,
      rawDistinctTop3Ratio: 1,
      latencyMs: { p50: 100, p95: 200, p99: 250 },
      failureBuckets: {
        "wrong-file": 0,
        "wrong-symbol": 0,
        "docs-tests-outranking-source": 0,
        "no-relevant-hit-top-k": 0,
      },
      embedding: { callCount: 0, estimatedCostUsd: 0, costPer1MTokensUsd: 0 },
      tokenEstimate: { queryTokens: 0, embeddingTokensUsed: 0 },
      contextEfficiency: {
        queryCount: 0,
        responseTokens: { total: 0, average: 0, p95: 0, max: 0 },
        duplicateCandidateRatio: 0,
        selectedFileRatio: 1,
        hitAt5Per1kResponseTokens: 1,
        mrrAt10Per1kResponseTokens: 1,
      },
    },
  };
}

describe("effectiveness quality CI", () => {
  const budget = JSON.parse(
    readFileSync("benchmarks/budgets/ollama.json", "utf8"),
  ) as EvalBudget;

  it("rejects the observed retrieval step-down and accepts the healthy result", () => {
    const regressed = evaluateBudgetGate(budget, summary(0.5, 0.54));
    const healthy = evaluateBudgetGate(budget, summary(1, 0.8125));

    expect(regressed.passed).toBe(false);
    expect(regressed.violations.map((violation) => violation.metric)).toEqual(
      expect.arrayContaining(["minHitAt5", "minMrrAt10"]),
    );
    expect(healthy.passed).toBe(true);
  });

  it("retains diagnostics for successful and failed scheduled evaluations", () => {
    const workflow = readFileSync(".github/workflows/eval-quality.yml", "utf8");

    expect(workflow).toContain("- name: Add evaluation summary\n        if: always()");
    expect(workflow).toContain("- name: Upload evaluation diagnostics\n        if: always()");
    expect(workflow).toContain("--output eval-results");
    expect(workflow).toContain("path: eval-results");
    expect(workflow).not.toContain(".eval-results");
    expect(workflow).toContain("if-no-files-found: warn");
    expect(workflow).toContain("retention-days: 14");
    expect(workflow).not.toContain(".codebase-index");
  });
});
