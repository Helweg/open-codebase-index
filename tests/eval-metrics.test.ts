import { describe, expect, it } from "vitest";

import { buildPerQueryResult, computeEvalMetrics, getRelevantPaths, pathMatchesExpected } from "../src/eval/metrics.js";
import type { GoldenQuery } from "../src/eval/types.js";

function query(overrides: Partial<GoldenQuery> = {}): GoldenQuery {
  return {
    id: "q1",
    query: "where is rankHybridResults implementation",
    queryType: "definition",
    expected: {
      filePath: "src/indexer/index.ts",
      symbol: "rankHybridResults",
    },
    ...overrides,
  };
}

describe("eval metrics", () => {
  it("matches expected paths with suffix support", () => {
    expect(pathMatchesExpected("/repo/src/indexer/index.ts", "src/indexer/index.ts")).toBe(true);
    expect(pathMatchesExpected("src/indexer/index.ts", "/repo/src/indexer/index.ts")).toBe(true);
    expect(pathMatchesExpected("/repo/src/tools/index.ts", "src/indexer/index.ts")).toBe(false);
  });

  it("builds relevant path set from exact and acceptable files", () => {
    const q = query({
      expected: {
        filePath: "src/indexer/index.ts",
        acceptableFiles: ["src/tools/index.ts", "src/indexer/index.ts"],
      },
    });

    expect(getRelevantPaths(q)).toEqual(["src/indexer/index.ts", "src/tools/index.ts"]);
  });

  it("computes hit and ranking metrics for per-query results", () => {
    const q = query();
    const per = buildPerQueryResult(
      q,
      [
        {
          filePath: "/repo/src/tools/index.ts",
          startLine: 1,
          endLine: 10,
          score: 0.95,
          chunkType: "function",
          name: "codebase_search",
        },
        {
          filePath: "/repo/src/indexer/index.ts",
          startLine: 100,
          endLine: 120,
          score: 0.9,
          chunkType: "function",
          name: "rankHybridResults",
        },
      ],
      20,
      10
    );

    expect(per.hitAt1).toBe(false);
    expect(per.hitAt3).toBe(true);
    expect(per.hitAt5).toBe(true);
    expect(per.reciprocalRankAt10).toBe(0.5);
    expect(per.ndcgAt10).toBeGreaterThan(0);
  });

  it("classifies failure buckets", () => {
    const q = query();
    const wrongFile = buildPerQueryResult(
      q,
      [
        {
          filePath: "/repo/src/tools/index.ts",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          chunkType: "function",
          name: "codebase_search",
        },
      ],
      10,
      10
    );
    expect(wrongFile.failureBucket).toBe("no-relevant-hit-top-k");

    const wrongSymbol = buildPerQueryResult(
      q,
      [
        {
          filePath: "/repo/src/indexer/index.ts",
          startLine: 1,
          endLine: 2,
          score: 0.9,
          chunkType: "function",
          name: "someOtherFunction",
        },
      ],
      10,
      10
    );
    expect(wrongSymbol.failureBucket).toBe("wrong-symbol");
  });

  it("aggregates eval metrics including latency percentiles and costs", () => {
    const queries: GoldenQuery[] = [
      query({ id: "q1" }),
      query({
        id: "q2",
        expected: {
          filePath: "src/tools/index.ts",
        },
      }),
    ];

    const perQuery = [
      buildPerQueryResult(
        queries[0],
        [
          {
            filePath: "/repo/src/indexer/index.ts",
            startLine: 1,
            endLine: 2,
            score: 1,
            chunkType: "function",
            name: "rankHybridResults",
          },
        ],
        10,
        10
      ),
      buildPerQueryResult(
        queries[1],
        [
          {
            filePath: "/repo/src/README.md",
            startLine: 1,
            endLine: 2,
            score: 1,
            chunkType: "other",
            name: "docs",
          },
          {
            filePath: "/repo/src/tools/index.ts",
            startLine: 1,
            endLine: 2,
            score: 0.8,
            chunkType: "function",
          },
        ],
        100,
        10
      ),
    ];

    const metrics = computeEvalMetrics(queries, perQuery, 20, 1000, 0.02);

    expect(metrics.hitAt1).toBe(0.5);
    expect(metrics.hitAt3).toBe(1);
    expect(metrics.mrrAt10).toBeCloseTo(0.75, 5);
    expect(metrics.distinctTop3Ratio).toBe(1);
    expect(metrics.rawDistinctTop3Ratio).toBe(1);
    expect(metrics.latencyMs.p50).toBeGreaterThan(0);
    expect(metrics.embedding.callCount).toBe(20);
    expect(metrics.embedding.estimatedCostUsd).toBeCloseTo(0.00002, 8);
  });

  it("tracks deduped and raw distinctTop3 ratios separately", () => {
    const queries: GoldenQuery[] = [query({ id: "q-dup" })];
    const perQuery = [
      buildPerQueryResult(
        queries[0],
        [
          {
            filePath: "/repo/src/indexer/index.ts",
            startLine: 1,
            endLine: 2,
            score: 1,
            chunkType: "function",
            name: "rankHybridResults",
          },
          {
            filePath: "/repo/src/indexer/index.ts",
            startLine: 10,
            endLine: 20,
            score: 0.95,
            chunkType: "function",
            name: "rerankResults",
          },
          {
            filePath: "/repo/src/tools/index.ts",
            startLine: 1,
            endLine: 2,
            score: 0.9,
            chunkType: "function",
            name: "codebase_search",
          },
        ],
        10,
        10
      ),
    ];

    const metrics = computeEvalMetrics(queries, perQuery, 0, 0, 0);
    expect(metrics.distinctTop3Ratio).toBe(1);
    expect(metrics.rawDistinctTop3Ratio).toBeCloseTo(2 / 3, 6);
    expect(perQuery[0].rawTop3DistinctRatio).toBeCloseTo(2 / 3, 6);
  });

  it("measures context response tokens, candidate compression, and quality per token", () => {
    const queries: GoldenQuery[] = [
      query({ id: "q1", retrievalMode: "context" }),
      query({ id: "q2", retrievalMode: "context" }),
    ];
    const result = (id: string, responseTokens: number, relevant: boolean) => buildPerQueryResult(
      { ...queries[0], id },
      [{
        filePath: relevant ? "/repo/src/indexer/index.ts" : "/repo/src/tools/index.ts",
        startLine: 1,
        endLine: 2,
        score: 1,
        chunkType: "function",
        name: relevant ? "rankHybridResults" : "other",
      }],
      10,
      10,
      { resolvedRoute: "definition", routedQuery: "rankHybridResults" },
      {
        tokenBudget: 1200,
        responseTokens,
        candidateCount: 4,
        deduplicatedCount: 3,
        omittedCount: 3,
      },
    );
    const perQuery = [result("q1", 100, true), result("q2", 300, false)];

    const metrics = computeEvalMetrics(queries, perQuery, 0, 0, 0);

    expect(perQuery[0].duplicateCandidateRatio).toBe(0.25);
    expect(perQuery[0].selectedFileRatio).toBe(1);
    expect(metrics.contextEfficiency.queryCount).toBe(2);
    expect(metrics.contextEfficiency.responseTokens).toEqual({
      total: 400,
      average: 200,
      p95: 290,
      max: 300,
    });
    expect(metrics.contextEfficiency.duplicateCandidateRatio).toBe(0.25);
    expect(metrics.contextEfficiency.hitAt5Per1kResponseTokens).toBe(2.5);
    expect(metrics.contextEfficiency.mrrAt10Per1kResponseTokens).toBe(2.5);
  });

  it("uses deterministic percentile behavior for tiny samples", () => {
    const q = query();
    const build = (id: string, latencyMs: number) =>
      buildPerQueryResult(
        { ...q, id },
        [
          {
            filePath: "/repo/src/indexer/index.ts",
            startLine: 1,
            endLine: 2,
            score: 1,
            chunkType: "function",
            name: "rankHybridResults",
          },
        ],
        latencyMs,
        10
      );

    const one = computeEvalMetrics([q], [build("q1", 10)], 0, 0, 0);
    expect(one.latencyMs.p50).toBe(10);
    expect(one.latencyMs.p95).toBe(10);
    expect(one.latencyMs.p99).toBe(10);

    const two = computeEvalMetrics(
      [{ ...q, id: "q1" }, { ...q, id: "q2" }],
      [build("q1", 10), build("q2", 110)],
      0,
      0,
      0
    );
    expect(two.latencyMs.p50).toBeCloseTo(60, 6);
    expect(two.latencyMs.p95).toBeCloseTo(105, 6);
    expect(two.latencyMs.p99).toBeCloseTo(109, 6);

    const five = computeEvalMetrics(
      [{ ...q, id: "q1" }, { ...q, id: "q2" }, { ...q, id: "q3" }, { ...q, id: "q4" }, { ...q, id: "q5" }],
      [build("q1", 1), build("q2", 2), build("q3", 3), build("q4", 4), build("q5", 5)],
      0,
      0,
      0
    );
    expect(five.latencyMs.p50).toBe(3);
    expect(five.latencyMs.p95).toBeCloseTo(4.8, 6);
    expect(five.latencyMs.p99).toBeCloseTo(4.96, 6);
  });
});
