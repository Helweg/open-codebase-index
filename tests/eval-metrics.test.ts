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
    expect(pathMatchesExpected("src/indexer/index.ts", "/repo/src/indexer/index.ts")).toBe(false);
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

  it("builds relevant path set from graded evidence", () => {
    const q = query({
      expected: {
        gradedEvidence: [
          { path: "src/indexer/index.ts", symbol: "rankHybridResults", relevance: 3 },
          { path: "src/tools/index.ts", symbol: "toolSymbol", relevance: 2 },
        ],
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

  it("classifies wrong symbol using graded evidence even when path matches", () => {
    const q = query({
      expected: {
        gradedEvidence: [{ path: "src/indexer/index.ts", symbol: "rankHybridResults", relevance: 3 }],
      },
    });

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
    expect(wrongSymbol.hitAt1).toBe(false);
  });

  it("keeps distinct symbols in one file and rewards higher graded evidence", () => {
    const q = query({
      expected: {
        gradedEvidence: [
          { path: "src/indexer/index.ts", symbol: "rankHybridResults", relevance: 3 },
          { path: "src/indexer/index.ts", symbol: "rerankResults", relevance: 1 },
        ],
      },
    });
    const highFirst = buildPerQueryResult(q, [
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
        startLine: 3,
        endLine: 4,
        score: 0.9,
        chunkType: "function",
        name: "rerankResults",
      },
    ], 10, 10);
    const lowFirst = buildPerQueryResult(q, [...highFirst.results].reverse(), 10, 10);

    expect(highFirst.results).toHaveLength(2);
    expect(highFirst.ndcgAt10).toBeGreaterThan(lowFirst.ndcgAt10);
    expect(highFirst.ndcgAt10).toBeCloseTo(1, 8);
  });

  it("does not inflate nDCG ideal with multiple legacy acceptable files", () => {
    const q = query({
      expected: {
        filePath: "src/indexer/index.ts",
        acceptableFiles: ["src/tools/index.ts", "src/indexer/index.ts", "src/tools/index.ts"],
      },
    });

    const per = buildPerQueryResult(
      q,
      [{
        filePath: "/repo/src/tools/index.ts",
        startLine: 1,
        endLine: 2,
        score: 0.95,
        chunkType: "function",
        name: "codebase_search",
      }],
      20,
      10
    );

    expect(per.ndcgAt10).toBeCloseTo(1, 8);
  });

  it("keeps nDCG bounded when duplicate same-path results match a single path label", () => {
    const q = query({
      expected: {
        filePath: "src/indexer/index.ts",
      },
    });

    const per = buildPerQueryResult(q, [
      {
        filePath: "/repo/src/indexer/index.ts",
        startLine: 1,
        endLine: 2,
        score: 0.99,
        chunkType: "function",
        name: "rankHybridResults",
      },
      {
        filePath: "/repo/src/indexer/index.ts",
        startLine: 3,
        endLine: 4,
        score: 0.98,
        chunkType: "function",
        name: "otherFunction",
      },
      {
        filePath: "/repo/src/indexer/index.ts",
        startLine: 5,
        endLine: 6,
        score: 0.97,
        chunkType: "function",
        name: "thirdFunction",
      },
    ], 20, 10);

    expect(per.hitAt1).toBe(true);
    expect(per.ndcgAt10).toBe(1);
    expect(per.results).toHaveLength(3);
  });

  it("does not let wrong-symbol-only hits pass symbol-intended mixed evidence", () => {
    const q = {
      id: "q-symbol-intended-path-label",
      query: "where is rankHybridResults implementation",
      queryType: "definition" as const,
      expected: {
        symbol: "rankHybridResults",
        gradedEvidence: [{ path: "src/indexer/index.ts", relevance: 3 }],
      },
    };

    const per = buildPerQueryResult(
      q,
      [
        {
          filePath: "/repo/src/indexer/index.ts",
          startLine: 1,
          endLine: 2,
          score: 0.99,
          chunkType: "function",
          name: "wrongSymbol",
        },
      ],
      20,
      10,
    );

    expect(per.hitAt1).toBe(false);
    expect(per.ndcgAt10).toBe(0);
    expect(per.failureBucket).toBe("wrong-symbol");
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
    expect(metrics.routeAccuracy).toBe(0);
    expect(metrics.mrrAt10).toBeCloseTo(0.75, 5);
    expect(metrics.distinctTop3Ratio).toBe(1);
    expect(metrics.rawDistinctTop3Ratio).toBe(1);
    expect(metrics.latencyMs.p50).toBeGreaterThan(0);
    expect(metrics.embedding.callCount).toBe(20);
    expect(metrics.embedding.estimatedCostUsd).toBeCloseTo(0.00002, 8);
  });

  it("tracks route accuracy only for queries with expected routes", () => {
    const routeQueries: GoldenQuery[] = [
      query({
        id: "route-matched",
        expected: {
          filePath: "src/indexer/index.ts",
          expectedRoute: "search",
        },
      }),
      query({
        id: "route-mismatch",
        expected: {
          filePath: "src/indexer/index.ts",
          expectedRoute: "search",
        },
      }),
    ];

    const routeResults = [
      buildPerQueryResult(
        routeQueries[0],
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
        10,
        { resolvedRoute: "search", routedQuery: "rankHybridResults" }
      ),
      buildPerQueryResult(
        routeQueries[1],
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
        10,
        { resolvedRoute: "definition", routedQuery: "rankHybridResults" }
      ),
    ];

    const routeMetrics = computeEvalMetrics(routeQueries, routeResults, 0, 0, 0);

    expect(routeMetrics.routeAccuracy).toBe(0.5);
    expect(routeResults[0]?.routeMatched).toBe(true);
    expect(routeResults[1]?.routeMatched).toBe(false);
  });

  it("tracks result outcomes and filter-relaxation recovery without penalizing positive hit denominators", () => {
    const positive = query({
      id: "positive",
      expected: {
        filePath: "src/indexer/index.ts",
        symbol: "rankHybridResults",
        expectedOutcome: "results",
        recoveryExpectation: "filter-relaxed",
      },
    });
    const negative = query({
      id: "negative",
      expected: { expectedOutcome: "no-results" },
    });
    const positiveResult = buildPerQueryResult(
      positive,
      [{
        filePath: "/repo/src/indexer/index.ts",
        startLine: 1,
        endLine: 2,
        score: 1,
        chunkType: "function",
        name: "rankHybridResults",
      }],
      10,
      10,
      undefined,
      {
        tokenBudget: 1200,
        responseTokens: 50,
        candidateCount: 1,
        deduplicatedCount: 1,
        omittedCount: 0,
        recoveryRelaxed: true,
      },
    );
    const negativeResult = buildPerQueryResult(negative, [], 10, 10);
    const metrics = computeEvalMetrics([positive, negative], [positiveResult, negativeResult], 0, 0, 0);

    expect(metrics.hitAt5).toBe(1);
    expect(metrics.outcomeAccuracy).toBe(1);
    expect(metrics.recoveryAccuracy).toBe(1);
    expect(negativeResult.failureBucket).toBeUndefined();
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
