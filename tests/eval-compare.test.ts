import { describe, expect, it } from "vitest";

import { compareSummaries } from "../src/eval/compare.js";
import type { EvalSummary } from "../src/eval/types.js";

function summary(
  overrides: Partial<
    Pick<EvalSummary, "datasetName" | "datasetVersion" | "queryCount" | "datasetFingerprint">
  > = {},
): EvalSummary {
  return {
    generatedAt: "2026-07-25T00:00:00.000Z",
    projectRoot: "/repo",
    datasetPath: "dataset.json",
    datasetName: overrides.datasetName ?? "agent-context",
    datasetVersion: overrides.datasetVersion ?? "1.0.0",
    datasetFingerprint: overrides.datasetFingerprint,
    queryCount: overrides.queryCount ?? 12,
    topK: 10,
    searchConfig: { fusionStrategy: "rrf", hybridWeight: 0.4, rrfK: 60, rerankTopN: 20 },
    metrics: {
      hitAt1: 0,
      hitAt3: 0,
      hitAt5: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      distinctTop3Ratio: 0,
      rawDistinctTop3Ratio: 0,
      latencyMs: { p50: 0, p95: 0, p99: 0 },
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
    },
  };
}

describe("evaluation comparison", () => {
  it("compares matching datasets", () => {
    expect(compareSummaries(summary(), summary(), "baseline.json").deltas.hitAt5.absolute).toBe(0);
  });

  it("compares matching datasets when fingerprints match", () => {
    const comparison = compareSummaries(
      summary({ datasetFingerprint: "abc123" }),
      summary({ datasetFingerprint: "abc123" }),
      "baseline.json"
    );

    expect(comparison.deltas.hitAt5.absolute).toBe(0);
  });

  it("rejects when dataset fingerprints do not match", () => {
    expect(() =>
      compareSummaries(
        summary({ datasetFingerprint: "abc123" }),
        summary({ datasetFingerprint: "def456" }),
        "baseline.json"
      )
    ).toThrow(/incompatible evaluation datasets by fingerprint/);
  });

  it("rejects comparison when one summary has a fingerprint and the other does not", () => {
    expect(() => compareSummaries(summary(), summary({ datasetFingerprint: "abc123" }), "baseline.json")).toThrow(/mismatched dataset fingerprint presence/);
    expect(() => compareSummaries(summary({ datasetFingerprint: "abc123" }), summary(), "baseline.json")).toThrow(/mismatched dataset fingerprint presence/);
  });

  it.each([
    [{ datasetName: "other" }, "other@1.0.0"],
    [{ datasetVersion: "2.0.0" }, "agent-context@2.0.0"],
    [{ queryCount: 11 }, "11 queries"],
  ] as const)("rejects an incompatible baseline %#", (overrides, expected) => {
    expect(() => compareSummaries(summary(), summary(overrides), "baseline.json"))
      .toThrow(new RegExp(`incompatible evaluation datasets.*${expected}`));
  });
});
