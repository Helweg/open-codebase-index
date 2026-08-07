import { describe, expect, it } from "vitest";

import { evaluateBudgetGate } from "../src/eval/budget.js";
import type { EvalBudget, EvalComparison, EvalSummary } from "../src/eval/types.js";

function summary(p95: number): EvalSummary {
  return {
    generatedAt: new Date().toISOString(),
    projectRoot: "/tmp/project",
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
      routeAccuracy: 1,
      outcomeAccuracy: 1,
      recoveryAccuracy: 0,
      latencyMs: {
        p50: p95,
        p95,
        p99: p95,
      },
      tokenEstimate: {
        queryTokens: 10,
        embeddingTokensUsed: 10,
      },
      embedding: {
        callCount: 1,
        estimatedCostUsd: 0,
        costPer1MTokensUsd: 0,
      },
      contextEfficiency: {
        queryCount: 1,
        responseTokens: { total: 100, average: 100, p95: 100, max: 100 },
        duplicateCandidateRatio: 0.1,
        selectedFileRatio: 1,
        hitAt5Per1kResponseTokens: 10,
        mrrAt10Per1kResponseTokens: 10,
      },
      failureBuckets: {
        "wrong-file": 0,
        "wrong-symbol": 0,
        "docs-tests-outranking-source": 0,
        "no-relevant-hit-top-k": 0,
      },
    },
  };
}

function comparisonWithBaselineP95(baselineP95: number): EvalComparison {
  return {
    againstPath: "benchmarks/baselines/eval-baseline-summary.json",
    deltas: {
      hitAt1: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      hitAt3: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      hitAt5: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      hitAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      mrrAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      ndcgAt10: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      distinctTop3Ratio: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      rawDistinctTop3Ratio: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      latencyP50Ms: { current: 5, baseline: baselineP95, absolute: 5 - baselineP95, relativePct: 0 },
      latencyP95Ms: { current: 5, baseline: baselineP95, absolute: 5 - baselineP95, relativePct: 0 },
      latencyP99Ms: { current: 5, baseline: baselineP95, absolute: 5 - baselineP95, relativePct: 0 },
      embeddingCallCount: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      estimatedCostUsd: { current: 0, baseline: 0, absolute: 0, relativePct: 0 },
      contextResponseTokensAverage: { current: 100, baseline: 100, absolute: 0, relativePct: 0 },
      contextResponseTokensP95: { current: 100, baseline: 100, absolute: 0, relativePct: 0 },
      contextResponseTokensMax: { current: 100, baseline: 100, absolute: 0, relativePct: 0 },
      contextDuplicateCandidateRatio: { current: 0.1, baseline: 0.1, absolute: 0, relativePct: 0 },
      contextSelectedFileRatio: { current: 1, baseline: 1, absolute: 0, relativePct: 0 },
      contextHitAt5Per1kResponseTokens: { current: 10, baseline: 10, absolute: 0, relativePct: 0 },
      contextMrrAt10Per1kResponseTokens: { current: 10, baseline: 10, absolute: 0, relativePct: 0 },
    },
  };
}

describe("eval budget gate", () => {
  it("skips p95 multiplier violation when baseline p95 is near zero", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        p95LatencyMaxMultiplier: 1.1,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5), comparisonWithBaselineP95(0));
    expect(gate.passed).toBe(true);
    expect(gate.violations).toHaveLength(0);
  });

  it("still applies absolute p95 cap with near-zero baseline", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        p95LatencyMaxMultiplier: 1.1,
        p95LatencyMaxAbsoluteMs: 1,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5), comparisonWithBaselineP95(0));
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "p95LatencyMaxAbsoluteMs")).toBe(true);
  });

  it("fails when raw distinct top3 ratio drops below minimum", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        minRawDistinctTop3Ratio: 0.9,
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          rawDistinctTop3Ratio: 0.5,
        },
      }
    );
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "minRawDistinctTop3Ratio")).toBe(true);
  });

  it("fails when raw distinct top3 ratio regresses beyond allowed drop", () => {
    const budget: EvalBudget = {
      name: "default",
      failOnMissingBaseline: true,
      thresholds: {
        rawDistinctTop3RatioMaxDrop: 0.1,
      },
    };

    const comparison: EvalComparison = {
      ...comparisonWithBaselineP95(5),
      deltas: {
        ...comparisonWithBaselineP95(5).deltas,
        rawDistinctTop3Ratio: {
          current: 0.6,
          baseline: 0.8,
          absolute: -0.2,
          relativePct: -25,
        },
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          rawDistinctTop3Ratio: 0.6,
        },
      },
      comparison
    );
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "rawDistinctTop3RatioMaxDrop")).toBe(true);
  });

  it("fails when graph-neighbor recall drops below minimum", () => {
    const budget: EvalBudget = {
      name: "pre-edit",
      failOnMissingBaseline: false,
      thresholds: {
        minGraphNeighborRecall: 1,
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          graphNeighborRecall: 0.5,
        },
      }
    );
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "minGraphNeighborRecall")).toBe(true);
  });

  it("passes when graph-neighbor recall meets the minimum", () => {
    const budget: EvalBudget = {
      name: "pre-edit",
      failOnMissingBaseline: false,
      thresholds: {
        minGraphNeighborRecall: 0.5,
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          graphNeighborRecall: 1,
        },
      }
    );
    expect(gate.passed).toBe(true);
    expect(gate.violations).toHaveLength(0);
  });

  it("fails when route accuracy falls below threshold", () => {
    const budget: EvalBudget = {
      name: "pre-edit",
      failOnMissingBaseline: false,
      thresholds: {
        minRouteAccuracy: 1,
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          routeAccuracy: 0,
        },
      }
    );

    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "minRouteAccuracy")).toBe(true);
  });

  it("passes when route and outcome accuracy meet thresholds", () => {
    const budget: EvalBudget = {
      name: "pre-edit",
      failOnMissingBaseline: false,
      thresholds: {
        minRouteAccuracy: 1,
        minOutcomeAccuracy: 1,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5));

    expect(gate.passed).toBe(true);
    expect(gate.violations.some((v) => v.metric === "minRouteAccuracy")).toBe(false);
    expect(gate.violations.some((v) => v.metric === "minOutcomeAccuracy")).toBe(false);
  });

  it("fails when outcome accuracy falls below threshold", () => {
    const budget: EvalBudget = {
      name: "pre-edit",
      failOnMissingBaseline: false,
      thresholds: {
        minOutcomeAccuracy: 1,
      },
    };

    const gate = evaluateBudgetGate(
      budget,
      {
        ...summary(5),
        metrics: {
          ...summary(5).metrics,
          outcomeAccuracy: 0,
        },
      }
    );

    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.metric === "minOutcomeAccuracy")).toBe(true);
  });

  it("skips graph-neighbor gate when metric is absent", () => {
    const budget: EvalBudget = {
      name: "search-only",
      failOnMissingBaseline: false,
      thresholds: {
        minGraphNeighborRecall: 1,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5));
    expect(gate.passed).toBe(true);
    expect(gate.violations).toHaveLength(0);
  });

  it("enforces context response, duplicate, and quality-per-token thresholds", () => {
    const budget: EvalBudget = {
      name: "context",
      failOnMissingBaseline: false,
      thresholds: {
        maxContextResponseTokensAverage: 80,
        maxContextResponseTokensP95: 90,
        maxContextResponseTokensMax: 95,
        maxContextDuplicateCandidateRatio: 0.05,
        minContextSelectedFileRatio: 1.1,
        minContextHitAt5Per1kResponseTokens: 11,
        minContextMrrAt10Per1kResponseTokens: 11,
      },
    };

    const gate = evaluateBudgetGate(budget, summary(5));

    expect(gate.passed).toBe(false);
    expect(gate.violations.map((violation) => violation.metric)).toEqual([
      "maxContextResponseTokensAverage",
      "maxContextResponseTokensP95",
      "maxContextResponseTokensMax",
      "maxContextDuplicateCandidateRatio",
      "minContextSelectedFileRatio",
      "minContextHitAt5Per1kResponseTokens",
      "minContextMrrAt10Per1kResponseTokens",
    ]);
  });

  it("skips context-specific gates when a dataset has no context queries", () => {
    const withoutContext = summary(5);
    withoutContext.metrics.contextEfficiency.queryCount = 0;
    const gate = evaluateBudgetGate({
      name: "search-only",
      failOnMissingBaseline: false,
      thresholds: { maxContextResponseTokensMax: 1 },
    }, withoutContext);

    expect(gate.passed).toBe(true);
  });
});
