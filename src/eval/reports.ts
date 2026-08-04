import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

import {
  formatMs,
  formatPct,
  formatUsd,
  signed,
  type LoadSummaryOptions,
  validateSummary,
} from "./report-formatters.js";
import type {
  EvalComparison,
  EvalGateResult,
  EvalSummary,
  PerQueryEvalResult,
  SweepAggregateReport,
} from "./types.js";

export function loadSummary(summaryPath: string, options?: LoadSummaryOptions): EvalSummary {
  try {
    const raw = readFileSync(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as EvalSummary;
    return validateSummary(parsed, summaryPath, options);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      const message = error.message;
      throw new Error(`Failed to parse eval summary JSON at ${summaryPath}: ${message}`);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Failed to load eval summary at ${summaryPath}: ${String(error)}`);
  }
}

export function createRunDirectory(outputRoot: string, timestampOverride?: string): string {
  const timestamp = (timestampOverride ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const dir = path.join(outputRoot, timestamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

export function writeText(filePath: string, value: string): void {
  writeFileSync(filePath, value, "utf-8");
}

export function createSummaryMarkdown(
  summary: EvalSummary,
  comparison?: EvalComparison,
  gate?: EvalGateResult,
  sweep?: SweepAggregateReport
): string {
  const lines: string[] = [];

  lines.push("# Evaluation Summary");
  lines.push("");
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Dataset: ${summary.datasetName} (v${summary.datasetVersion})`);
  lines.push(`- Query count: ${summary.queryCount}`);
  lines.push(
    `- Search config: fusion=${summary.searchConfig.fusionStrategy}, hybridWeight=${summary.searchConfig.hybridWeight}, rrfK=${summary.searchConfig.rrfK}, rerankTopN=${summary.searchConfig.rerankTopN}`
  );
  lines.push("");

  lines.push("## Metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Hit@1 | ${formatPct(summary.metrics.hitAt1)} |`);
  lines.push(`| Hit@3 | ${formatPct(summary.metrics.hitAt3)} |`);
  lines.push(`| Hit@5 | ${formatPct(summary.metrics.hitAt5)} |`);
  lines.push(`| Hit@10 | ${formatPct(summary.metrics.hitAt10)} |`);
  lines.push(`| MRR@10 | ${summary.metrics.mrrAt10.toFixed(4)} |`);
  lines.push(`| nDCG@10 | ${summary.metrics.ndcgAt10.toFixed(4)} |`);
  lines.push(`| Graph-neighbor recall | ${(summary.metrics.graphNeighborRecall ?? 0).toFixed(4)} |`);
  lines.push(`| Distinct Top@3 | ${formatPct(summary.metrics.distinctTop3Ratio)} |`);
  lines.push(`| Raw Distinct Top@3 | ${formatPct(summary.metrics.rawDistinctTop3Ratio)} |`);
  lines.push(`| Latency p50 | ${formatMs(summary.metrics.latencyMs.p50)} |`);
  lines.push(`| Latency p95 | ${formatMs(summary.metrics.latencyMs.p95)} |`);
  lines.push(`| Latency p99 | ${formatMs(summary.metrics.latencyMs.p99)} |`);
  lines.push(`| Embedding calls | ${summary.metrics.embedding.callCount} |`);
  lines.push(`| Embedding tokens | ${summary.metrics.tokenEstimate.embeddingTokensUsed} |`);
  lines.push(`| Estimated embedding cost | ${formatUsd(summary.metrics.embedding.estimatedCostUsd)} |`);
  lines.push(`| Context queries | ${summary.metrics.contextEfficiency.queryCount} |`);
  lines.push(`| Context response tokens total | ${summary.metrics.contextEfficiency.responseTokens.total} |`);
  lines.push(`| Context response tokens avg | ${summary.metrics.contextEfficiency.responseTokens.average.toFixed(1)} |`);
  lines.push(`| Context response tokens p95 | ${summary.metrics.contextEfficiency.responseTokens.p95.toFixed(1)} |`);
  lines.push(`| Context response tokens max | ${summary.metrics.contextEfficiency.responseTokens.max.toFixed(1)} |`);
  lines.push(`| Context duplicate candidate ratio | ${formatPct(summary.metrics.contextEfficiency.duplicateCandidateRatio)} |`);
  lines.push(`| Context selected-file ratio | ${formatPct(summary.metrics.contextEfficiency.selectedFileRatio)} |`);
  lines.push(`| Context Hit@5 / 1k response tokens | ${summary.metrics.contextEfficiency.hitAt5Per1kResponseTokens.toFixed(4)} |`);
  lines.push(`| Context MRR@10 / 1k response tokens | ${summary.metrics.contextEfficiency.mrrAt10Per1kResponseTokens.toFixed(4)} |`);
  lines.push("");

  lines.push("## Failure Buckets");
  lines.push("");
  lines.push("| Bucket | Count |");
  lines.push("|---|---:|");
  lines.push(
    `| wrong-file | ${summary.metrics.failureBuckets["wrong-file"]} |`
  );
  lines.push(
    `| wrong-symbol | ${summary.metrics.failureBuckets["wrong-symbol"]} |`
  );
  lines.push(
    `| docs/tests outranking source | ${summary.metrics.failureBuckets["docs-tests-outranking-source"]} |`
  );
  lines.push(
    `| no relevant hit in top-k | ${summary.metrics.failureBuckets["no-relevant-hit-top-k"]} |`
  );
  lines.push("");

  if (comparison) {
    lines.push("## Comparison vs Baseline");
    lines.push("");
    lines.push(`- Against: ${comparison.againstPath}`);
    lines.push("");
    lines.push("| Metric | Baseline | Current | Delta |");
    lines.push("|---|---:|---:|---:|");
    lines.push(
      `| Hit@5 | ${formatPct(comparison.deltas.hitAt5.baseline)} | ${formatPct(comparison.deltas.hitAt5.current)} | ${signed(comparison.deltas.hitAt5.absolute)} |`
    );
    lines.push(
      `| MRR@10 | ${comparison.deltas.mrrAt10.baseline.toFixed(4)} | ${comparison.deltas.mrrAt10.current.toFixed(4)} | ${signed(comparison.deltas.mrrAt10.absolute)} |`
    );
    lines.push(
      `| nDCG@10 | ${comparison.deltas.ndcgAt10.baseline.toFixed(4)} | ${comparison.deltas.ndcgAt10.current.toFixed(4)} | ${signed(comparison.deltas.ndcgAt10.absolute)} |`
    );
    lines.push(
      `| Distinct Top@3 | ${formatPct(comparison.deltas.distinctTop3Ratio.baseline)} | ${formatPct(comparison.deltas.distinctTop3Ratio.current)} | ${signed(comparison.deltas.distinctTop3Ratio.absolute)} |`
    );
    lines.push(
      `| Raw Distinct Top@3 | ${formatPct(comparison.deltas.rawDistinctTop3Ratio.baseline)} | ${formatPct(comparison.deltas.rawDistinctTop3Ratio.current)} | ${signed(comparison.deltas.rawDistinctTop3Ratio.absolute)} |`
    );
    lines.push(
      `| p95 latency (ms) | ${comparison.deltas.latencyP95Ms.baseline.toFixed(3)} | ${comparison.deltas.latencyP95Ms.current.toFixed(3)} | ${signed(comparison.deltas.latencyP95Ms.absolute, 3)} |`
    );
    lines.push(
      `| Context response tokens avg | ${comparison.deltas.contextResponseTokensAverage.baseline.toFixed(1)} | ${comparison.deltas.contextResponseTokensAverage.current.toFixed(1)} | ${signed(comparison.deltas.contextResponseTokensAverage.absolute, 1)} |`
    );
    lines.push(
      `| Context response tokens p95 | ${comparison.deltas.contextResponseTokensP95.baseline.toFixed(1)} | ${comparison.deltas.contextResponseTokensP95.current.toFixed(1)} | ${signed(comparison.deltas.contextResponseTokensP95.absolute, 1)} |`
    );
    lines.push(
      `| Context response tokens max | ${comparison.deltas.contextResponseTokensMax.baseline.toFixed(1)} | ${comparison.deltas.contextResponseTokensMax.current.toFixed(1)} | ${signed(comparison.deltas.contextResponseTokensMax.absolute, 1)} |`
    );
    lines.push(
      `| Context duplicate candidate ratio | ${formatPct(comparison.deltas.contextDuplicateCandidateRatio.baseline)} | ${formatPct(comparison.deltas.contextDuplicateCandidateRatio.current)} | ${signed(comparison.deltas.contextDuplicateCandidateRatio.absolute)} |`
    );
    lines.push(
      `| Context selected-file ratio | ${formatPct(comparison.deltas.contextSelectedFileRatio.baseline)} | ${formatPct(comparison.deltas.contextSelectedFileRatio.current)} | ${signed(comparison.deltas.contextSelectedFileRatio.absolute)} |`
    );
    lines.push(
      `| Context Hit@5 / 1k response tokens | ${comparison.deltas.contextHitAt5Per1kResponseTokens.baseline.toFixed(4)} | ${comparison.deltas.contextHitAt5Per1kResponseTokens.current.toFixed(4)} | ${signed(comparison.deltas.contextHitAt5Per1kResponseTokens.absolute)} |`
    );
    lines.push(
      `| Context MRR@10 / 1k response tokens | ${comparison.deltas.contextMrrAt10Per1kResponseTokens.baseline.toFixed(4)} | ${comparison.deltas.contextMrrAt10Per1kResponseTokens.current.toFixed(4)} | ${signed(comparison.deltas.contextMrrAt10Per1kResponseTokens.absolute)} |`
    );
    lines.push("");
  }

  if (gate) {
    lines.push("## CI Gate");
    lines.push("");
    lines.push(`- Result: ${gate.passed ? "PASS ✅" : "FAIL ❌"}`);
    if (gate.violations.length > 0) {
      lines.push("- Violations:");
      for (const violation of gate.violations) {
        lines.push(`  - ${violation.metric}: ${violation.message}`);
      }
    }
    lines.push("");
  }

  if (sweep) {
    lines.push("## Parameter Sweep");
    lines.push("");
    lines.push(`- Run count: ${sweep.runCount}`);
    if (sweep.bestByHitAt5) {
      lines.push(
        `- Best Hit@5: ${formatPct(sweep.bestByHitAt5.summary.metrics.hitAt5)} with fusion=${sweep.bestByHitAt5.searchConfig.fusionStrategy}, hybridWeight=${sweep.bestByHitAt5.searchConfig.hybridWeight}, rrfK=${sweep.bestByHitAt5.searchConfig.rrfK}, rerankTopN=${sweep.bestByHitAt5.searchConfig.rerankTopN}`
      );
    }
    if (sweep.bestByMrrAt10) {
      lines.push(
        `- Best MRR@10: ${sweep.bestByMrrAt10.summary.metrics.mrrAt10.toFixed(4)} with fusion=${sweep.bestByMrrAt10.searchConfig.fusionStrategy}, hybridWeight=${sweep.bestByMrrAt10.searchConfig.hybridWeight}, rrfK=${sweep.bestByMrrAt10.searchConfig.rrfK}, rerankTopN=${sweep.bestByMrrAt10.searchConfig.rerankTopN}`
      );
    }
    if (sweep.bestByP95Latency) {
      lines.push(
        `- Best p95 latency: ${formatMs(sweep.bestByP95Latency.summary.metrics.latencyMs.p95)} with fusion=${sweep.bestByP95Latency.searchConfig.fusionStrategy}, hybridWeight=${sweep.bestByP95Latency.searchConfig.hybridWeight}, rrfK=${sweep.bestByP95Latency.searchConfig.rrfK}, rerankTopN=${sweep.bestByP95Latency.searchConfig.rerankTopN}`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function buildPerQueryArtifact(perQuery: PerQueryEvalResult[]): {
  queryCount: number;
  queries: PerQueryEvalResult[];
} {
  return {
    queryCount: perQuery.length,
    queries: [...perQuery].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
