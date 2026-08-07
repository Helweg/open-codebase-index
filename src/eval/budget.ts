import type { EvalBudget, EvalComparison, EvalGateResult, EvalSummary } from "./types.js";

export function evaluateBudgetGate(
  budget: EvalBudget,
  summary: EvalSummary,
  comparison?: EvalComparison
): EvalGateResult {
  const BASELINE_P95_EPSILON_MS = 0.001;
  const violations: EvalGateResult["violations"] = [];

  const { thresholds } = budget;

  if (thresholds.minHitAt5 !== undefined && summary.metrics.hitAt5 < thresholds.minHitAt5) {
    violations.push({
      metric: "minHitAt5",
      message: `Hit@5 ${summary.metrics.hitAt5.toFixed(4)} is below minimum ${thresholds.minHitAt5.toFixed(4)}`,
    });
  }

  if (thresholds.minMrrAt10 !== undefined && summary.metrics.mrrAt10 < thresholds.minMrrAt10) {
    violations.push({
      metric: "minMrrAt10",
      message: `MRR@10 ${summary.metrics.mrrAt10.toFixed(4)} is below minimum ${thresholds.minMrrAt10.toFixed(4)}`,
    });
  }

  if (
    thresholds.minRawDistinctTop3Ratio !== undefined &&
    summary.metrics.rawDistinctTop3Ratio < thresholds.minRawDistinctTop3Ratio
  ) {
    violations.push({
      metric: "minRawDistinctTop3Ratio",
      message: `Raw Distinct Top@3 ${summary.metrics.rawDistinctTop3Ratio.toFixed(4)} is below minimum ${thresholds.minRawDistinctTop3Ratio.toFixed(4)}`,
    });
  }

  if (
    thresholds.minGraphNeighborRecall !== undefined &&
    summary.metrics.graphNeighborRecall !== undefined &&
    summary.metrics.graphNeighborRecall < thresholds.minGraphNeighborRecall
  ) {
    violations.push({
      metric: "minGraphNeighborRecall",
      message: `Graph-neighbor recall ${summary.metrics.graphNeighborRecall.toFixed(4)} is below minimum ${thresholds.minGraphNeighborRecall.toFixed(4)}`,
    });
  }

  if (
    thresholds.minRouteAccuracy !== undefined &&
    summary.metrics.routeAccuracy < thresholds.minRouteAccuracy
  ) {
    violations.push({
      metric: "minRouteAccuracy",
      message: `Route accuracy ${summary.metrics.routeAccuracy.toFixed(4)} is below minimum ${thresholds.minRouteAccuracy.toFixed(4)}`,
    });
  }

  if (
    thresholds.minOutcomeAccuracy !== undefined &&
    summary.metrics.outcomeAccuracy < thresholds.minOutcomeAccuracy
  ) {
    violations.push({
      metric: "minOutcomeAccuracy",
      message: `Outcome accuracy ${summary.metrics.outcomeAccuracy.toFixed(4)} is below minimum ${thresholds.minOutcomeAccuracy.toFixed(4)}`,
    });
  }

  if (comparison) {
    if (
      thresholds.hitAt5MaxDrop !== undefined &&
      comparison.deltas.hitAt5.absolute < -thresholds.hitAt5MaxDrop
    ) {
      violations.push({
        metric: "hitAt5MaxDrop",
        message: `Hit@5 drop ${comparison.deltas.hitAt5.absolute.toFixed(4)} exceeds allowed -${thresholds.hitAt5MaxDrop.toFixed(4)}`,
      });
    }

    if (
      thresholds.mrrAt10MaxDrop !== undefined &&
      comparison.deltas.mrrAt10.absolute < -thresholds.mrrAt10MaxDrop
    ) {
      violations.push({
        metric: "mrrAt10MaxDrop",
        message: `MRR@10 drop ${comparison.deltas.mrrAt10.absolute.toFixed(4)} exceeds allowed -${thresholds.mrrAt10MaxDrop.toFixed(4)}`,
      });
    }

    if (
      thresholds.rawDistinctTop3RatioMaxDrop !== undefined &&
      comparison.deltas.rawDistinctTop3Ratio.absolute < -thresholds.rawDistinctTop3RatioMaxDrop
    ) {
      violations.push({
        metric: "rawDistinctTop3RatioMaxDrop",
        message: `Raw Distinct Top@3 drop ${comparison.deltas.rawDistinctTop3Ratio.absolute.toFixed(4)} exceeds allowed -${thresholds.rawDistinctTop3RatioMaxDrop.toFixed(4)}`,
      });
    }

    if (thresholds.p95LatencyMaxMultiplier !== undefined) {
      const baselineP95 = comparison.deltas.latencyP95Ms.baseline;
      if (baselineP95 > BASELINE_P95_EPSILON_MS) {
        const allowed = baselineP95 * thresholds.p95LatencyMaxMultiplier;
        if (summary.metrics.latencyMs.p95 > allowed) {
          violations.push({
            metric: "p95LatencyMaxMultiplier",
            message: `p95 latency ${summary.metrics.latencyMs.p95.toFixed(3)}ms exceeds allowed ${allowed.toFixed(3)}ms (${thresholds.p95LatencyMaxMultiplier.toFixed(2)}x baseline)`,
          });
        }
      }
    }
  }

  if (
    thresholds.p95LatencyMaxAbsoluteMs !== undefined &&
    summary.metrics.latencyMs.p95 > thresholds.p95LatencyMaxAbsoluteMs
  ) {
    violations.push({
      metric: "p95LatencyMaxAbsoluteMs",
      message: `p95 latency ${summary.metrics.latencyMs.p95.toFixed(3)}ms exceeds absolute maximum ${thresholds.p95LatencyMaxAbsoluteMs.toFixed(3)}ms`,
    });
  }

  const context = summary.metrics.contextEfficiency;
  if (context.queryCount > 0) {
    if (
      thresholds.maxContextResponseTokensAverage !== undefined &&
      context.responseTokens.average > thresholds.maxContextResponseTokensAverage
    ) {
      violations.push({
        metric: "maxContextResponseTokensAverage",
        message: `Context response average ${context.responseTokens.average.toFixed(1)} tokens exceeds maximum ${thresholds.maxContextResponseTokensAverage.toFixed(1)}`,
      });
    }

    if (
      thresholds.maxContextResponseTokensP95 !== undefined &&
      context.responseTokens.p95 > thresholds.maxContextResponseTokensP95
    ) {
      violations.push({
        metric: "maxContextResponseTokensP95",
        message: `Context response p95 ${context.responseTokens.p95.toFixed(1)} tokens exceeds maximum ${thresholds.maxContextResponseTokensP95.toFixed(1)}`,
      });
    }

    if (
      thresholds.maxContextResponseTokensMax !== undefined &&
      context.responseTokens.max > thresholds.maxContextResponseTokensMax
    ) {
      violations.push({
        metric: "maxContextResponseTokensMax",
        message: `Context response maximum ${context.responseTokens.max.toFixed(1)} tokens exceeds maximum ${thresholds.maxContextResponseTokensMax.toFixed(1)}`,
      });
    }

    if (
      thresholds.maxContextDuplicateCandidateRatio !== undefined &&
      context.duplicateCandidateRatio > thresholds.maxContextDuplicateCandidateRatio
    ) {
      violations.push({
        metric: "maxContextDuplicateCandidateRatio",
        message: `Context duplicate candidate ratio ${context.duplicateCandidateRatio.toFixed(4)} exceeds maximum ${thresholds.maxContextDuplicateCandidateRatio.toFixed(4)}`,
      });
    }

    if (
      thresholds.minContextSelectedFileRatio !== undefined &&
      context.selectedFileRatio < thresholds.minContextSelectedFileRatio
    ) {
      violations.push({
        metric: "minContextSelectedFileRatio",
        message: `Context selected-file ratio ${context.selectedFileRatio.toFixed(4)} is below minimum ${thresholds.minContextSelectedFileRatio.toFixed(4)}`,
      });
    }

    if (
      thresholds.minContextHitAt5Per1kResponseTokens !== undefined &&
      context.hitAt5Per1kResponseTokens < thresholds.minContextHitAt5Per1kResponseTokens
    ) {
      violations.push({
        metric: "minContextHitAt5Per1kResponseTokens",
        message: `Context Hit@5 per 1k response tokens ${context.hitAt5Per1kResponseTokens.toFixed(4)} is below minimum ${thresholds.minContextHitAt5Per1kResponseTokens.toFixed(4)}`,
      });
    }

    if (
      thresholds.minContextMrrAt10Per1kResponseTokens !== undefined &&
      context.mrrAt10Per1kResponseTokens < thresholds.minContextMrrAt10Per1kResponseTokens
    ) {
      violations.push({
        metric: "minContextMrrAt10Per1kResponseTokens",
        message: `Context MRR@10 per 1k response tokens ${context.mrrAt10Per1kResponseTokens.toFixed(4)} is below minimum ${thresholds.minContextMrrAt10Per1kResponseTokens.toFixed(4)}`,
      });
    }
  }

  return {
    passed: violations.length === 0,
    budgetName: budget.name,
    violations,
  };
}
