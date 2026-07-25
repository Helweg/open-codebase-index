import type { EvalComparison, EvalSummary, MetricDelta } from "./types.js";

function metricDelta(current: number, baseline: number): MetricDelta {
  const absolute = current - baseline;
  const relativePct = baseline === 0 ? (current === 0 ? 0 : 100) : (absolute / baseline) * 100;
  return {
    current,
    baseline,
    absolute,
    relativePct,
  };
}

export function compareSummaries(current: EvalSummary, baseline: EvalSummary, againstPath: string): EvalComparison {
  if (
    current.datasetName !== baseline.datasetName ||
    current.datasetVersion !== baseline.datasetVersion ||
    current.queryCount !== baseline.queryCount
  ) {
    throw new Error(
      `Cannot compare incompatible evaluation datasets: current=${current.datasetName}@${current.datasetVersion} (${current.queryCount} queries), ` +
      `baseline=${baseline.datasetName}@${baseline.datasetVersion} (${baseline.queryCount} queries) at ${againstPath}`,
    );
  }

  return {
    againstPath,
    deltas: {
      hitAt1: metricDelta(current.metrics.hitAt1, baseline.metrics.hitAt1),
      hitAt3: metricDelta(current.metrics.hitAt3, baseline.metrics.hitAt3),
      hitAt5: metricDelta(current.metrics.hitAt5, baseline.metrics.hitAt5),
      hitAt10: metricDelta(current.metrics.hitAt10, baseline.metrics.hitAt10),
      mrrAt10: metricDelta(current.metrics.mrrAt10, baseline.metrics.mrrAt10),
      ndcgAt10: metricDelta(current.metrics.ndcgAt10, baseline.metrics.ndcgAt10),
      distinctTop3Ratio: metricDelta(current.metrics.distinctTop3Ratio, baseline.metrics.distinctTop3Ratio),
      rawDistinctTop3Ratio: metricDelta(current.metrics.rawDistinctTop3Ratio, baseline.metrics.rawDistinctTop3Ratio),
      latencyP50Ms: metricDelta(current.metrics.latencyMs.p50, baseline.metrics.latencyMs.p50),
      latencyP95Ms: metricDelta(current.metrics.latencyMs.p95, baseline.metrics.latencyMs.p95),
      latencyP99Ms: metricDelta(current.metrics.latencyMs.p99, baseline.metrics.latencyMs.p99),
      embeddingCallCount: metricDelta(
        current.metrics.embedding.callCount,
        baseline.metrics.embedding.callCount
      ),
      estimatedCostUsd: metricDelta(
        current.metrics.embedding.estimatedCostUsd,
        baseline.metrics.embedding.estimatedCostUsd
      ),
      contextResponseTokensAverage: metricDelta(
        current.metrics.contextEfficiency.responseTokens.average,
        baseline.metrics.contextEfficiency.responseTokens.average,
      ),
      contextResponseTokensP95: metricDelta(
        current.metrics.contextEfficiency.responseTokens.p95,
        baseline.metrics.contextEfficiency.responseTokens.p95,
      ),
      contextResponseTokensMax: metricDelta(
        current.metrics.contextEfficiency.responseTokens.max,
        baseline.metrics.contextEfficiency.responseTokens.max,
      ),
      contextDuplicateCandidateRatio: metricDelta(
        current.metrics.contextEfficiency.duplicateCandidateRatio,
        baseline.metrics.contextEfficiency.duplicateCandidateRatio,
      ),
      contextSelectedFileRatio: metricDelta(
        current.metrics.contextEfficiency.selectedFileRatio,
        baseline.metrics.contextEfficiency.selectedFileRatio,
      ),
      contextHitAt5Per1kResponseTokens: metricDelta(
        current.metrics.contextEfficiency.hitAt5Per1kResponseTokens,
        baseline.metrics.contextEfficiency.hitAt5Per1kResponseTokens,
      ),
      contextMrrAt10Per1kResponseTokens: metricDelta(
        current.metrics.contextEfficiency.mrrAt10Per1kResponseTokens,
        baseline.metrics.contextEfficiency.mrrAt10Per1kResponseTokens,
      ),
    },
  };
}
