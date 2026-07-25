import { estimateTokens } from "../utils/cost.js";
import { normalizePathSeparators } from "../utils/paths.js";

import type {
  EvalResolvedRoute,
  EvalMetrics,
  FailureBucket,
  GoldenQuery,
  PerQueryEvalResult,
} from "./types.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const x = p * (sorted.length - 1);
  const lowerIndex = Math.floor(x);
  const upperIndex = Math.ceil(x);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const fraction = x - lowerIndex;
  return sorted[lowerIndex] + fraction * (sorted[upperIndex] - sorted[lowerIndex]);
}

function normalizePath(input: string): string {
  return normalizePathSeparators(input);
}

function uniqueResultsByPath(results: PerQueryEvalResult["results"]): PerQueryEvalResult["results"] {
  const seen = new Set<string>();
  const unique: PerQueryEvalResult["results"] = [];

  for (const result of results) {
    const normalized = normalizePath(result.filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(result);
  }

  return unique;
}

function distinctTopKRatio(results: PerQueryEvalResult["results"], k: number): number {
  const top = results.slice(0, k);
  if (top.length === 0) return 0;
  const distinct = new Set(top.map((result) => normalizePath(result.filePath))).size;
  return distinct / top.length;
}

export function pathMatchesExpected(actualPath: string, expectedPath: string): boolean {
  const actual = normalizePath(actualPath);
  const expected = normalizePath(expectedPath);
  if (actual === expected) return true;
  return actual.endsWith(`/${expected}`) || expected.endsWith(`/${actual}`);
}

export function getRelevantPaths(query: GoldenQuery): string[] {
  const fromExact = query.expected.filePath ? [query.expected.filePath] : [];
  const fromAcceptable = query.expected.acceptableFiles ?? [];
  return Array.from(new Set([...fromExact, ...fromAcceptable]));
}

function isRelevantResult(filePath: string, relevantPaths: string[]): boolean {
  return relevantPaths.some((expected) => pathMatchesExpected(filePath, expected));
}

function reciprocalRankAtK(results: PerQueryEvalResult["results"], relevantPaths: string[], k: number): number {
  const top = uniqueResultsByPath(results).slice(0, k);
  for (let i = 0; i < top.length; i += 1) {
    if (isRelevantResult(top[i].filePath, relevantPaths)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function ndcgAtK(results: PerQueryEvalResult["results"], relevantPaths: string[], k: number): number {
  const top = uniqueResultsByPath(results).slice(0, k);
  const dcg = top.reduce((sum, result, i) => {
    const rel = isRelevantResult(result.filePath, relevantPaths) ? 1 : 0;
    return sum + rel / Math.log2(i + 2);
  }, 0);

  const idealLen = Math.min(k, relevantPaths.length);
  const idcg = Array.from({ length: idealLen }, (_, i) => 1 / Math.log2(i + 2)).reduce(
    (sum, value) => sum + value,
    0
  );

  return idcg === 0 ? 0 : dcg / idcg;
}

function isDocsOrTestsPath(filePath: string): boolean {
  const lowered = normalizePath(filePath).toLowerCase();
  return (
    lowered.includes("/docs/") ||
    lowered.includes("/test/") ||
    lowered.includes("/tests/") ||
    lowered.includes("readme") ||
    lowered.includes("/benchmarks/")
  );
}

export function classifyFailureBucket(
  query: GoldenQuery,
  results: PerQueryEvalResult["results"],
  k: number
): FailureBucket | undefined {
  const relevantPaths = getRelevantPaths(query);
  const top = uniqueResultsByPath(results).slice(0, k);
  const hasRelevantTopK = top.some((result) => isRelevantResult(result.filePath, relevantPaths));

  if (!hasRelevantTopK) {
    return "no-relevant-hit-top-k";
  }

  if (query.expected.symbol) {
    const hasSymbol = top.some(
      (result) =>
        isRelevantResult(result.filePath, relevantPaths) && result.name === query.expected.symbol
    );
    if (!hasSymbol) return "wrong-symbol";
  }

  const top1 = top[0];
  if (top1 && !isRelevantResult(top1.filePath, relevantPaths) && isDocsOrTestsPath(top1.filePath)) {
    return "docs-tests-outranking-source";
  }

  if (top1 && !isRelevantResult(top1.filePath, relevantPaths)) {
    return "wrong-file";
  }

  return undefined;
}

export function buildPerQueryResult(
  query: GoldenQuery,
  results: PerQueryEvalResult["results"],
  latencyMs: number,
  k: number,
  route: { resolvedRoute: EvalResolvedRoute; routedQuery: string } = {
    resolvedRoute: "search",
    routedQuery: query.query,
  },
  context?: {
    tokenBudget: number;
    responseTokens: number;
    candidateCount: number;
    deduplicatedCount: number;
    omittedCount: number;
  },
): PerQueryEvalResult {
  const relevantPaths = getRelevantPaths(query);
  const deduped = uniqueResultsByPath(results);
  const hitAt = (cutoff: number): boolean =>
    deduped.slice(0, cutoff).some((result) => isRelevantResult(result.filePath, relevantPaths));

  const perQuery: PerQueryEvalResult = {
    id: query.id,
    query: query.query,
    queryType: query.queryType,
    retrievalMode: query.retrievalMode ?? "search",
    resolvedRoute: route.resolvedRoute,
    routedQuery: route.routedQuery,
    latencyMs,
    hitAt1: hitAt(1),
    hitAt3: hitAt(3),
    hitAt5: hitAt(5),
    hitAt10: hitAt(10),
    reciprocalRankAt10: reciprocalRankAtK(deduped, relevantPaths, 10),
    ndcgAt10: ndcgAtK(deduped, relevantPaths, 10),
    failureBucket: classifyFailureBucket(query, results, k),
    rawTop3DistinctRatio: distinctTopKRatio(results, 3),
    tokenBudget: context?.tokenBudget,
    responseTokens: context?.responseTokens ?? 0,
    candidateCount: context?.candidateCount ?? results.length,
    deduplicatedCount: context?.deduplicatedCount ?? results.length,
    selectedCount: results.length,
    omittedCount: context?.omittedCount ?? 0,
    duplicateCandidateRatio: context && context.candidateCount > 0
      ? (context.candidateCount - context.deduplicatedCount) / context.candidateCount
      : 0,
    selectedFileRatio: results.length === 0
      ? 0
      : new Set(results.map((result) => normalizePath(result.filePath))).size / results.length,
    results: deduped,
  };

  return perQuery;
}

export function computeEvalMetrics(
  queries: GoldenQuery[],
  perQuery: PerQueryEvalResult[],
  embeddingCallCount: number,
  embeddingTokensUsed: number,
  costPer1MTokensUsd: number
): EvalMetrics {
  const count = perQuery.length;
  const safeDiv = (value: number): number => (count === 0 ? 0 : value / count);

  const sum = {
    hitAt1: 0,
    hitAt3: 0,
    hitAt5: 0,
    hitAt10: 0,
    mrrAt10: 0,
    ndcgAt10: 0,
    distinctTop3Ratio: 0,
    rawDistinctTop3Ratio: 0,
  };

  const failureBuckets: Record<FailureBucket, number> = {
    "wrong-file": 0,
    "wrong-symbol": 0,
    "docs-tests-outranking-source": 0,
    "no-relevant-hit-top-k": 0,
  };

  const latencies = perQuery.map((item) => item.latencyMs);
  const contextQueries = perQuery.filter((item) => item.retrievalMode === "context");
  const contextResponseTokens = contextQueries.map((item) => item.responseTokens);
  const totalContextResponseTokens = contextResponseTokens.reduce((sum, value) => sum + value, 0);
  const contextTokenUnits = totalContextResponseTokens / 1000;

  for (const query of perQuery) {
    if (query.hitAt1) sum.hitAt1 += 1;
    if (query.hitAt3) sum.hitAt3 += 1;
    if (query.hitAt5) sum.hitAt5 += 1;
    if (query.hitAt10) sum.hitAt10 += 1;
    sum.mrrAt10 += query.reciprocalRankAt10;
    sum.ndcgAt10 += query.ndcgAt10;
    sum.distinctTop3Ratio += distinctTopKRatio(query.results, 3);
    sum.rawDistinctTop3Ratio += query.rawTop3DistinctRatio;
    if (query.failureBucket) {
      failureBuckets[query.failureBucket] += 1;
    }
  }

  const queryTokens = queries.reduce((acc, q) => acc + estimateTokens(q.query), 0);

  return {
    hitAt1: safeDiv(sum.hitAt1),
    hitAt3: safeDiv(sum.hitAt3),
    hitAt5: safeDiv(sum.hitAt5),
    hitAt10: safeDiv(sum.hitAt10),
    mrrAt10: safeDiv(sum.mrrAt10),
    ndcgAt10: safeDiv(sum.ndcgAt10),
    distinctTop3Ratio: safeDiv(sum.distinctTop3Ratio),
    rawDistinctTop3Ratio: safeDiv(sum.rawDistinctTop3Ratio),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    tokenEstimate: {
      queryTokens,
      embeddingTokensUsed,
    },
    embedding: {
      callCount: embeddingCallCount,
      estimatedCostUsd: (embeddingTokensUsed / 1_000_000) * costPer1MTokensUsd,
      costPer1MTokensUsd,
    },
    contextEfficiency: {
      queryCount: contextQueries.length,
      responseTokens: {
        total: totalContextResponseTokens,
        average: contextQueries.length === 0 ? 0 : totalContextResponseTokens / contextQueries.length,
        p95: percentile(contextResponseTokens, 0.95),
        max: contextResponseTokens.length === 0 ? 0 : Math.max(...contextResponseTokens),
      },
      duplicateCandidateRatio: contextQueries.length === 0
        ? 0
        : contextQueries.reduce((sum, item) => sum + item.duplicateCandidateRatio, 0) / contextQueries.length,
      selectedFileRatio: contextQueries.length === 0
        ? 0
        : contextQueries.reduce((sum, item) => sum + item.selectedFileRatio, 0) / contextQueries.length,
      hitAt5Per1kResponseTokens: contextTokenUnits === 0
        ? 0
        : contextQueries.filter((item) => item.hitAt5).length / contextTokenUnits,
      mrrAt10Per1kResponseTokens: contextTokenUnits === 0
        ? 0
        : contextQueries.reduce((sum, item) => sum + item.reciprocalRankAt10, 0) / contextTokenUnits,
    },
    failureBuckets,
  };
}
