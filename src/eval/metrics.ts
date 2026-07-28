import { estimateTokens } from "../utils/cost.js";
import { normalizePathSeparators } from "../utils/paths.js";

import type {
  EvalResolvedRoute,
  EvalMetrics,
  FailureBucket,
  GoldenGradedEvidence,
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

function uniqueResultsByEvidence(results: PerQueryEvalResult["results"]): PerQueryEvalResult["results"] {
  const seen = new Set<string>();
  const unique: PerQueryEvalResult["results"] = [];

  for (const result of results) {
    const key = `${normalizePath(result.filePath)}::${result.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(result);
  }

  return unique;
}

function uniqueResultsByPath(results: PerQueryEvalResult["results"]): PerQueryEvalResult["results"] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = normalizePath(result.filePath);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  return actual.endsWith(`/${expected}`);
}

export function getRelevantPaths(query: GoldenQuery): string[] {
  const evidence = getRelevantEvidence(query);
  return Array.from(new Set(evidence.map((entry) => entry.path)));
}

function getRelevantEvidence(query: GoldenQuery): GoldenGradedEvidence[] {
  const legacyEvidence: GoldenGradedEvidence[] = [];

  if (query.expected.filePath !== undefined) {
    legacyEvidence.push({
      path: query.expected.filePath,
      ...(query.expected.symbol !== undefined ? { symbol: query.expected.symbol } : {}),
      relevance: 1,
    });
  }

  if (query.expected.acceptableFiles) {
    for (const path of query.expected.acceptableFiles) {
      legacyEvidence.push({
        path,
        ...(query.expected.symbol !== undefined ? { symbol: query.expected.symbol } : {}),
        relevance: 1,
      });
    }
  }

  const gradedEvidence = query.expected.gradedEvidence ?? [];
  const allEvidence = [...legacyEvidence, ...gradedEvidence];

  const dedupeKey = (entry: GoldenGradedEvidence): string => {
    return `${normalizePath(entry.path)}::${entry.symbol ?? ""}`;
  };

  const unique = new Map<string, GoldenGradedEvidence>();
  for (const entry of allEvidence) {
    unique.set(dedupeKey(entry), entry);
  }

  return Array.from(unique.values());
}

function hasSymbolRequirement(query: GoldenQuery): boolean {
  return getRelevantEvidence(query).some((entry) => entry.symbol !== undefined);
}

function isExpectedFile(filePath: string, relevant: GoldenGradedEvidence[]): boolean {
  return relevant.some((entry) => pathMatchesExpected(filePath, entry.path));
}

function resultRelevance(
  filePath: string,
  symbol: string | undefined,
  relevant: GoldenGradedEvidence[],
): number {
  let relevance = 0;
  for (const entry of relevant) {
    if (!pathMatchesExpected(filePath, entry.path)) {
      continue;
    }

    if (entry.symbol === undefined) {
      relevance = Math.max(relevance, entry.relevance);
      continue;
    }

    if (symbol !== undefined && symbol === entry.symbol) {
      relevance = Math.max(relevance, entry.relevance);
    }
  }
  return relevance;
}

function isRelevantResult(
  filePath: string,
  symbol: string | undefined,
  relevant: GoldenGradedEvidence[],
): boolean {
  return resultRelevance(filePath, symbol, relevant) > 0;
}

function hasGradeBasedEvidence(query: GoldenQuery): boolean {
  return (query.expected.gradedEvidence?.length ?? 0) > 0;
}

function dedupeRelevantEvidence(relevant: GoldenGradedEvidence[]): GoldenGradedEvidence[] {
  const deduped = new Map<string, GoldenGradedEvidence>();

  for (const entry of relevant) {
    const key = `${normalizePath(entry.path)}::${entry.symbol ?? ""}`;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }

  return [...deduped.values()];
}

function reciprocalRankAtK(
  results: PerQueryEvalResult["results"],
  relevant: GoldenGradedEvidence[],
  k: number,
): number {
  const top = uniqueResultsByEvidence(results).slice(0, k);
  for (let i = 0; i < top.length; i += 1) {
    if (isRelevantResult(top[i].filePath, top[i].name, relevant)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function ndcgAtK(
  query: GoldenQuery,
  results: PerQueryEvalResult["results"],
  relevant: GoldenGradedEvidence[],
  k: number,
): number {
  const top = uniqueResultsByEvidence(results).slice(0, k);
  const dcg = top.reduce((sum, result, i) => {
    const rel = resultRelevance(result.filePath, result.name, relevant);
    return sum + (2 ** rel - 1) / Math.log2(i + 2);
  }, 0);

  const dedupedRelevant = dedupeRelevantEvidence(relevant);
  const idealRelevances = hasGradeBasedEvidence(query)
    ? dedupedRelevant
        .map((entry) => entry.relevance)
        .sort((a, b) => b - a)
        .slice(0, k)
    : relevant.length > 0
      ? [1]
      : [];
  const idcg = idealRelevances.reduce(
    (sum, rel, index) => sum + (2 ** rel - 1) / Math.log2(index + 2),
    0,
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
  const relevant = getRelevantEvidence(query);
  if (query.expected.expectedOutcome === "no-results") return undefined;
  const top = uniqueResultsByEvidence(results).slice(0, k);
  const hasRelevantTopK = top.some((result) =>
    isRelevantResult(result.filePath, result.name, relevant)
  );

  if (!hasRelevantTopK) {
    const hasExpectedFileTopK = top.some((result) => isExpectedFile(result.filePath, relevant));
    if (hasExpectedFileTopK && hasSymbolRequirement(query)) {
      return "wrong-symbol";
    }
    return "no-relevant-hit-top-k";
  }

  const top1 = top[0];
  if (top1 && !isExpectedFile(top1.filePath, relevant) && isDocsOrTestsPath(top1.filePath)) {
    return "docs-tests-outranking-source";
  }

  if (top1 && !isExpectedFile(top1.filePath, relevant)) {
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
    recoveryRelaxed?: boolean;
    recoveryUsed?: boolean;
  },
): PerQueryEvalResult {
  const relevant = getRelevantEvidence(query);
  const deduped = uniqueResultsByEvidence(results);

  const hitAt = (cutoff: number): boolean =>
    deduped.slice(0, cutoff).some((result) => isRelevantResult(result.filePath, result.name, relevant));

  const perQuery: PerQueryEvalResult = {
    id: query.id,
    query: query.query,
    queryType: query.queryType,
    retrievalMode: query.retrievalMode ?? "search",
    resolvedRoute: route.resolvedRoute,
    routedQuery: route.routedQuery,
    routeMatched: query.expected.expectedRoute
      ? query.expected.expectedRoute === route.resolvedRoute
      : undefined,
    outcomeMatched: query.expected.expectedOutcome === undefined
      ? undefined
      : query.expected.expectedOutcome === "results"
        ? deduped.length > 0
        : deduped.length === 0,
    recoveryMatched: query.expected.recoveryExpectation === undefined
      ? undefined
      : query.expected.recoveryExpectation === "filter-relaxed"
        ? context?.recoveryRelaxed === true
        : context?.recoveryUsed !== true,
    language: query.language,
    difficulty: query.difficulty,
    tags: query.tags,
    latencyMs,
    hitAt1: hitAt(1),
    hitAt3: hitAt(3),
    hitAt5: hitAt(5),
    hitAt10: hitAt(10),
    reciprocalRankAt10: reciprocalRankAtK(deduped, relevant, 10),
    ndcgAt10: ndcgAtK(query, deduped, relevant, 10),
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
  const positiveQueryIds = new Set(
    queries
      .filter((query) => query.expected.expectedOutcome !== "no-results")
      .map((query) => query.id),
  );
  const positiveCount = perQuery.filter((query) => positiveQueryIds.has(query.id)).length;
  const safePositiveDiv = (value: number): number => positiveCount === 0 ? 0 : value / positiveCount;

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

  let routeMatchedCount = 0;
  let routeExpectedCount = 0;
  let outcomeMatchedCount = 0;
  let outcomeExpectedCount = 0;
  let recoveryMatchedCount = 0;
  let recoveryExpectedCount = 0;

  for (const query of perQuery) {
    if (positiveQueryIds.has(query.id)) {
      if (query.hitAt1) sum.hitAt1 += 1;
      if (query.hitAt3) sum.hitAt3 += 1;
      if (query.hitAt5) sum.hitAt5 += 1;
      if (query.hitAt10) sum.hitAt10 += 1;
      sum.mrrAt10 += query.reciprocalRankAt10;
      sum.ndcgAt10 += query.ndcgAt10;
    }
    sum.distinctTop3Ratio += distinctTopKRatio(uniqueResultsByPath(query.results), 3);
    sum.rawDistinctTop3Ratio += query.rawTop3DistinctRatio;
    if (query.failureBucket) {
      failureBuckets[query.failureBucket] += 1;
    }

    if (query.routeMatched !== undefined) {
      routeExpectedCount += 1;
      if (query.routeMatched) {
        routeMatchedCount += 1;
      }
    }
    if (query.outcomeMatched !== undefined) {
      outcomeExpectedCount += 1;
      if (query.outcomeMatched) outcomeMatchedCount += 1;
    }
    if (query.recoveryMatched !== undefined) {
      recoveryExpectedCount += 1;
      if (query.recoveryMatched) recoveryMatchedCount += 1;
    }
  }

  const queryTokens = queries.reduce((acc, q) => acc + estimateTokens(q.query), 0);

  return {
    hitAt1: safePositiveDiv(sum.hitAt1),
    hitAt3: safePositiveDiv(sum.hitAt3),
    hitAt5: safePositiveDiv(sum.hitAt5),
    hitAt10: safePositiveDiv(sum.hitAt10),
    mrrAt10: safePositiveDiv(sum.mrrAt10),
    ndcgAt10: safePositiveDiv(sum.ndcgAt10),
    routeAccuracy: routeExpectedCount === 0 ? 0 : routeMatchedCount / routeExpectedCount,
    outcomeAccuracy: outcomeExpectedCount === 0 ? 0 : outcomeMatchedCount / outcomeExpectedCount,
    recoveryAccuracy: recoveryExpectedCount === 0 ? 0 : recoveryMatchedCount / recoveryExpectedCount,
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
        : contextQueries.reduce((sum, item) => sum + item.duplicateCandidateRatio, 0) /
          contextQueries.length,
      selectedFileRatio: contextQueries.length === 0
        ? 0
        : contextQueries.reduce((sum, item) => sum + item.selectedFileRatio, 0) /
          contextQueries.length,
      hitAt5Per1kResponseTokens: contextTokenUnits === 0
        ? 0
        : contextQueries.filter((item) => item.hitAt5).length / contextTokenUnits,
      mrrAt10Per1kResponseTokens: contextTokenUnits === 0
        ? 0
        : contextQueries.reduce((sum, item) => sum + item.reciprocalRankAt10, 0) /
          contextTokenUnits,
    },
    failureBuckets,
  };
}
