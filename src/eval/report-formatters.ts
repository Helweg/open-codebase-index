import type { EvalSummary } from "./types.js";

export interface LoadSummaryOptions {
  allowLegacyDiversityMetrics?: boolean;
}

export function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

export function validateSummary(
  summary: EvalSummary,
  summaryPath: string,
  options?: LoadSummaryOptions
): EvalSummary {
  assertFiniteNumber(summary.metrics.hitAt1, `${summaryPath}.metrics.hitAt1`);
  assertFiniteNumber(summary.metrics.hitAt3, `${summaryPath}.metrics.hitAt3`);
  assertFiniteNumber(summary.metrics.hitAt5, `${summaryPath}.metrics.hitAt5`);
  assertFiniteNumber(summary.metrics.hitAt10, `${summaryPath}.metrics.hitAt10`);
  assertFiniteNumber(summary.metrics.mrrAt10, `${summaryPath}.metrics.mrrAt10`);
  assertFiniteNumber(summary.metrics.ndcgAt10, `${summaryPath}.metrics.ndcgAt10`);

  const metrics = summary.metrics as EvalSummary["metrics"] & {
    distinctTop3Ratio?: number;
    rawDistinctTop3Ratio?: number;
  };

  if (metrics.distinctTop3Ratio === undefined && options?.allowLegacyDiversityMetrics) {
    metrics.distinctTop3Ratio = 0;
  }
  if (metrics.rawDistinctTop3Ratio === undefined && options?.allowLegacyDiversityMetrics) {
    metrics.rawDistinctTop3Ratio = 0;
  }

  assertFiniteNumber(metrics.distinctTop3Ratio, `${summaryPath}.metrics.distinctTop3Ratio`);
  assertFiniteNumber(metrics.rawDistinctTop3Ratio, `${summaryPath}.metrics.rawDistinctTop3Ratio`);
  assertFiniteNumber(summary.metrics.latencyMs.p50, `${summaryPath}.metrics.latencyMs.p50`);
  assertFiniteNumber(summary.metrics.latencyMs.p95, `${summaryPath}.metrics.latencyMs.p95`);
  assertFiniteNumber(summary.metrics.latencyMs.p99, `${summaryPath}.metrics.latencyMs.p99`);
  assertFiniteNumber(summary.metrics.embedding.callCount, `${summaryPath}.metrics.embedding.callCount`);
  assertFiniteNumber(summary.metrics.embedding.estimatedCostUsd, `${summaryPath}.metrics.embedding.estimatedCostUsd`);

  if (!summary.metrics.contextEfficiency) {
    summary.metrics.contextEfficiency = {
      queryCount: 0,
      responseTokens: { total: 0, average: 0, p95: 0, max: 0 },
      duplicateCandidateRatio: 0,
      selectedFileRatio: 0,
      hitAt5Per1kResponseTokens: 0,
      mrrAt10Per1kResponseTokens: 0,
    };
  }
  assertFiniteNumber(summary.metrics.contextEfficiency.queryCount, `${summaryPath}.metrics.contextEfficiency.queryCount`);
  assertFiniteNumber(summary.metrics.contextEfficiency.responseTokens.total, `${summaryPath}.metrics.contextEfficiency.responseTokens.total`);
  assertFiniteNumber(summary.metrics.contextEfficiency.responseTokens.average, `${summaryPath}.metrics.contextEfficiency.responseTokens.average`);
  assertFiniteNumber(summary.metrics.contextEfficiency.responseTokens.p95, `${summaryPath}.metrics.contextEfficiency.responseTokens.p95`);
  assertFiniteNumber(summary.metrics.contextEfficiency.responseTokens.max, `${summaryPath}.metrics.contextEfficiency.responseTokens.max`);
  assertFiniteNumber(summary.metrics.contextEfficiency.duplicateCandidateRatio, `${summaryPath}.metrics.contextEfficiency.duplicateCandidateRatio`);
  assertFiniteNumber(summary.metrics.contextEfficiency.selectedFileRatio, `${summaryPath}.metrics.contextEfficiency.selectedFileRatio`);
  assertFiniteNumber(summary.metrics.contextEfficiency.hitAt5Per1kResponseTokens, `${summaryPath}.metrics.contextEfficiency.hitAt5Per1kResponseTokens`);
  assertFiniteNumber(summary.metrics.contextEfficiency.mrrAt10Per1kResponseTokens, `${summaryPath}.metrics.contextEfficiency.mrrAt10Per1kResponseTokens`);

  return summary;
}

export function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatMs(value: number): string {
  return `${value.toFixed(3)}ms`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function signed(value: number, digits = 4): string {
  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}
