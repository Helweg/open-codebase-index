import { describe, expect, it } from "vitest";

import type { EvalMetrics } from "../src/eval/types.js";
import {
  buildQueryWeightedQualityAggregates,
  buildReportMarkdown,
  type CliOptions,
  type RepoBenchmarkResult,
} from "../scripts/cross-repo-benchmark.js";

function metrics(hitAt5: number): EvalMetrics {
  return {
    hitAt1: hitAt5,
    hitAt3: hitAt5,
    hitAt5,
    hitAt10: hitAt5,
    mrrAt10: hitAt5,
    ndcgAt10: hitAt5,
    routeAccuracy: 1,
    outcomeAccuracy: 1,
    recoveryAccuracy: 1,
    distinctTop3Ratio: 1,
    rawDistinctTop3Ratio: 1,
    latencyMs: { p50: 1, p95: 2, p99: 3 },
    tokenEstimate: { queryTokens: 0, embeddingTokensUsed: 0 },
    embedding: { callCount: 0, estimatedCostUsd: 0, costPer1MTokensUsd: 0 },
    contextEfficiency: {
      queryCount: 0,
      responseTokens: { total: 0, average: 0, p95: 0, max: 0 },
      duplicateCandidateRatio: 0,
      selectedFileRatio: 0,
      hitAt5Per1kResponseTokens: 0,
      mrrAt10Per1kResponseTokens: 0,
    },
    failureBuckets: {
      "wrong-file": 0,
      "wrong-symbol": 0,
      "docs-tests-outranking-source": 0,
      "no-relevant-hit-top-k": 0,
    },
  };
}

function repo(name: string, queryCount: number, hitAt5: number): RepoBenchmarkResult {
  return {
    repoName: name,
    repoPath: `/${name}`,
    datasetPath: `${name}.json`,
    datasetQueryCount: queryCount,
    fileSampling: {
      parsedFileCount: 1,
      truncated: false,
      maxParseFiles: 10,
      fileSizeLimitBytes: 1_000_000,
    },
    plugin: {
      outputDir: "plugin",
      summaryPath: "summary.json",
      perQueryPath: "per-query.json",
      metrics: metrics(hitAt5),
      repeatSummaries: [],
    },
  };
}

const options: CliOptions = {
  repos: ["/small", "/large"],
  outputRoot: "output",
  reindex: false,
  repeats: 1,
  maxParseFiles: 10,
  persistDatasets: false,
  skipRipgrep: true,
  skipSg: true,
  codegraph: false,
  codebaseMemoryMcp: false,
  embeddingModel: "nomic-embed-text",
};

describe("cross-repo query-weighted quality reporting", () => {
  it("distinguishes query-weighted quality from the macro average for uneven cohorts", () => {
    const results = [repo("small", 1, 1), repo("large", 9, 0)];

    expect(buildQueryWeightedQualityAggregates(results).plugin).toMatchObject({
      queryCount: 10,
      hitAt5: 0.1,
    });

    const report = buildReportMarkdown("2026-08-19T00:00:00.000Z", options, "run", results);
    expect(report).toContain("## Aggregate quality (Macro average across repos)");
    expect(report).toContain("| Hit@5 | 50.00% | N/A | N/A |");
    expect(report).toContain("## Aggregate (Query-weighted quality)");
    expect(report).toContain("| Plugin | 10 | 10.00% | 10.00% | 10.00% | 10.00% | 0.1000 | 0.1000 |");
  });

  it("uses comparator-specific query-count denominators for query-weighted aggregation", () => {
    const weighted = buildQueryWeightedQualityAggregates([
      {
        ...repo("small", 1, 1),
        ripgrep: {
          metrics: metrics(0),
          perQueryCount: 2,
          repeatMetrics: [metrics(0)],
        },
        sg: {
          metrics: metrics(1),
          perQueryCount: 3,
          repeatMetrics: [metrics(1)],
          queryTypeScope: ["definition", "keyword-heavy"],
          scopedQueryCount: 1,
          totalQueryCount: 3,
        },
      },
      {
        ...repo("large", 9, 0),
        ripgrep: {
          metrics: metrics(1),
          perQueryCount: 1,
          repeatMetrics: [metrics(1)],
        },
        sg: {
          metrics: metrics(0),
          perQueryCount: 4,
          repeatMetrics: [metrics(0)],
          queryTypeScope: ["definition", "keyword-heavy"],
          scopedQueryCount: 3,
          totalQueryCount: 4,
        },
      },
    ]);

    expect(weighted.plugin).toMatchObject({ queryCount: 10, hitAt5: 0.1 });
    expect(weighted.ripgrep).toMatchObject({ queryCount: 3, hitAt5: 1 / 3 });
    expect(weighted.sg).toMatchObject({ queryCount: 4, hitAt5: 0.25 });

    const report = buildReportMarkdown("2026-08-19T00:00:00.000Z", {
      ...options,
      skipRipgrep: false,
      skipSg: false,
    }, "run", [
      {
        ...repo("small", 1, 1),
        ripgrep: {
          metrics: metrics(0),
          perQueryCount: 2,
          repeatMetrics: [metrics(0)],
        },
        sg: {
          metrics: metrics(1),
          perQueryCount: 3,
          repeatMetrics: [metrics(1)],
          queryTypeScope: ["definition", "keyword-heavy"],
          scopedQueryCount: 1,
          totalQueryCount: 3,
        },
      },
      {
        ...repo("large", 9, 0),
        ripgrep: {
          metrics: metrics(1),
          perQueryCount: 1,
          repeatMetrics: [metrics(1)],
        },
        sg: {
          metrics: metrics(0),
          perQueryCount: 4,
          repeatMetrics: [metrics(0)],
          queryTypeScope: ["definition", "keyword-heavy"],
          scopedQueryCount: 3,
          totalQueryCount: 4,
        },
      },
    ]);

    expect(report).toContain("## Aggregate (Query-weighted quality)");
    expect(report).toContain("| Plugin | 10 | 10.00% | 10.00% | 10.00% | 10.00% | 0.1000 | 0.1000 |");
    expect(report).toContain("| Ripgrep | 3 | 33.33% | 33.33% | 33.33% | 33.33% | 0.3333 | 0.3333 |");
    expect(report).toContain("| ast-grep | 4 | 25.00% | 25.00% | 25.00% | 25.00% | 0.2500 | 0.2500 |");
  });
});
