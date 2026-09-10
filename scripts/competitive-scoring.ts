import type { GoldenQuery } from "../src/eval/types.js";

export type CompetitiveRunStatus = "success" | "error" | "unsupported";

export interface CompetitiveMetrics {
  hitAt1: number;
  hitAt5: number;
  mrrAt10: number;
  ndcgAt10: number;
}

export interface CompetitiveQueryScore {
  queryId: string;
  status: CompetitiveRunStatus;
  rankedPaths: string[];
  metrics?: CompetitiveMetrics;
}

export type CompetitiveMetricMeans = CompetitiveMetrics;

export interface CompetitiveAggregate {
  totalCount: number;
  supportedCount: number;
  successCount: number;
  errorCount: number;
  unsupportedCount: number;
  supportedTrack: CompetitiveMetricMeans;
  successOnly: CompetitiveMetricMeans;
}

const ZERO_METRICS: CompetitiveMetrics = {
  hitAt1: 0,
  hitAt5: 0,
  mrrAt10: 0,
  ndcgAt10: 0,
};

/** Normalize and validate a repository-relative path for exact comparison. */
export function normalizeCompetitivePath(input: string): string {
  if (input.length === 0 || input.includes("\0")) {
    throw new Error("Path must be a non-empty repository-relative path without NUL bytes");
  }

  const normalized = input.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || normalized.startsWith("//")
    || /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`Absolute paths are not allowed: ${input}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Path must be a normalized repository-relative path: ${input}`);
  }

  return segments.join("/");
}

function relevantGrades(query: GoldenQuery): Map<string, number> {
  const grades = new Map<string, number>();
  const add = (path: string, relevance: number): void => {
    const normalized = normalizeCompetitivePath(path);
    grades.set(normalized, Math.max(grades.get(normalized) ?? 0, relevance));
  };

  if (query.expected.filePath !== undefined) add(query.expected.filePath, 1);
  for (const path of query.expected.acceptableFiles ?? []) add(path, 1);
  for (const evidence of query.expected.gradedEvidence ?? []) {
    if (evidence.relevance > 0) add(evidence.path, evidence.relevance);
  }

  return grades;
}

function distinctTopTen(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];

  for (const path of paths) {
    const normalized = normalizeCompetitivePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (distinct.length < 10) distinct.push(normalized);
  }

  return distinct;
}

function discountedGain(grades: readonly number[]): number {
  return grades.reduce((total, relevance, index) => {
    return total + (2 ** relevance - 1) / Math.log2(index + 2);
  }, 0);
}

function computeMetrics(query: GoldenQuery, rankedPaths: readonly string[]): CompetitiveMetrics {
  const grades = relevantGrades(query);
  const observedGrades = rankedPaths.map((path) => grades.get(path) ?? 0);
  const firstRelevantIndex = observedGrades.findIndex((grade) => grade > 0);
  const idealGrades = [...grades.values()].sort((a, b) => b - a).slice(0, 10);
  const idealGain = discountedGain(idealGrades);

  return {
    hitAt1: observedGrades[0] > 0 ? 1 : 0,
    hitAt5: observedGrades.slice(0, 5).some((grade) => grade > 0) ? 1 : 0,
    mrrAt10: firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1),
    ndcgAt10: idealGain === 0 ? 0 : discountedGain(observedGrades) / idealGain,
  };
}

export function scoreQuery(
  query: GoldenQuery,
  rankedPaths: readonly string[],
  status: CompetitiveRunStatus = "success",
): CompetitiveQueryScore {
  const normalizedPaths = distinctTopTen(rankedPaths);

  if (status === "unsupported") {
    return { queryId: query.id, status, rankedPaths: normalizedPaths };
  }

  return {
    queryId: query.id,
    status,
    rankedPaths: normalizedPaths,
    metrics: status === "error" ? { ...ZERO_METRICS } : computeMetrics(query, normalizedPaths),
  };
}

export const scoreCompetitiveQuery = scoreQuery;

function meanMetrics(scores: readonly CompetitiveQueryScore[], denominator: number): CompetitiveMetricMeans {
  if (denominator === 0) return { ...ZERO_METRICS };

  const totals = scores.reduce<CompetitiveMetrics>((sum, score) => {
    const metrics = score.metrics ?? ZERO_METRICS;
    return {
      hitAt1: sum.hitAt1 + metrics.hitAt1,
      hitAt5: sum.hitAt5 + metrics.hitAt5,
      mrrAt10: sum.mrrAt10 + metrics.mrrAt10,
      ndcgAt10: sum.ndcgAt10 + metrics.ndcgAt10,
    };
  }, { ...ZERO_METRICS });

  return {
    hitAt1: totals.hitAt1 / denominator,
    hitAt5: totals.hitAt5 / denominator,
    mrrAt10: totals.mrrAt10 / denominator,
    ndcgAt10: totals.ndcgAt10 / denominator,
  };
}

export function aggregateScores(
  scores: readonly CompetitiveQueryScore[],
): CompetitiveAggregate {
  const successes = scores.filter((score) => score.status === "success");
  const errors = scores.filter((score) => score.status === "error");
  const unsupported = scores.filter((score) => score.status === "unsupported");
  const supported = [...successes, ...errors];

  return {
    totalCount: scores.length,
    supportedCount: supported.length,
    successCount: successes.length,
    errorCount: errors.length,
    unsupportedCount: unsupported.length,
    supportedTrack: meanMetrics(supported, supported.length),
    successOnly: meanMetrics(successes, successes.length),
  };
}

export const aggregateCompetitiveScores = aggregateScores;
