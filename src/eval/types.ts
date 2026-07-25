import type { SearchConfig } from "../config/schema.js";

export type GoldenQueryType =
  | "definition"
  | "implementation-intent"
  | "similarity"
  | "keyword-heavy"
  | "conceptual";

export type GoldenRetrievalMode = "search" | "context";
export type EvalResolvedRoute = "search" | "definition";

export interface GoldenExpected {
  filePath?: string;
  acceptableFiles?: string[];
  symbol?: string;
  branch?: string;
}

export interface GoldenQuery {
  id: string;
  query: string;
  queryType: GoldenQueryType;
  retrievalMode?: GoldenRetrievalMode;
  expected: GoldenExpected;
}

export interface GoldenDataset {
  version: string;
  name: string;
  description?: string;
  queries: GoldenQuery[];
}

export interface EvalBudget {
  name: string;
  baselinePath?: string;
  failOnMissingBaseline: boolean;
  thresholds: {
    hitAt5MaxDrop?: number;
    mrrAt10MaxDrop?: number;
    rawDistinctTop3RatioMaxDrop?: number;
    p95LatencyMaxMultiplier?: number;
    p95LatencyMaxAbsoluteMs?: number;
    minHitAt5?: number;
    minMrrAt10?: number;
    minRawDistinctTop3Ratio?: number;
  };
}

export interface EvalSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string;
}

export type FailureBucket =
  | "wrong-file"
  | "wrong-symbol"
  | "docs-tests-outranking-source"
  | "no-relevant-hit-top-k";

export interface PerQueryEvalResult {
  id: string;
  query: string;
  queryType: GoldenQueryType;
  retrievalMode: GoldenRetrievalMode;
  resolvedRoute: EvalResolvedRoute;
  routedQuery: string;
  latencyMs: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRankAt10: number;
  ndcgAt10: number;
  failureBucket?: FailureBucket;
  rawTop3DistinctRatio: number;
  results: EvalSearchResult[];
}

export interface EvalMetrics {
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  hitAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  distinctTop3Ratio: number;
  rawDistinctTop3Ratio: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
  };
  tokenEstimate: {
    queryTokens: number;
    embeddingTokensUsed: number;
  };
  embedding: {
    callCount: number;
    estimatedCostUsd: number;
    costPer1MTokensUsd: number;
  };
  failureBuckets: Record<FailureBucket, number>;
}

export interface EvalSummary {
  generatedAt: string;
  projectRoot: string;
  datasetPath: string;
  datasetName: string;
  datasetVersion: string;
  queryCount: number;
  topK: number;
  searchConfig: Pick<SearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">;
  metrics: EvalMetrics;
}

export interface MetricDelta {
  current: number;
  baseline: number;
  absolute: number;
  relativePct: number;
}

export interface EvalComparison {
  againstPath: string;
  deltas: {
    hitAt1: MetricDelta;
    hitAt3: MetricDelta;
    hitAt5: MetricDelta;
    hitAt10: MetricDelta;
    mrrAt10: MetricDelta;
    ndcgAt10: MetricDelta;
    distinctTop3Ratio: MetricDelta;
    rawDistinctTop3Ratio: MetricDelta;
    latencyP50Ms: MetricDelta;
    latencyP95Ms: MetricDelta;
    latencyP99Ms: MetricDelta;
    embeddingCallCount: MetricDelta;
    estimatedCostUsd: MetricDelta;
  };
}

export interface EvalGateViolation {
  metric: string;
  message: string;
}

export interface EvalGateResult {
  passed: boolean;
  budgetName?: string;
  violations: EvalGateViolation[];
}

export interface SweepDefinition {
  fusionStrategy?: Array<"rrf" | "weighted">;
  hybridWeight?: number[];
  rrfK?: number[];
  rerankTopN?: number[];
}

export interface SweepRunSummary {
  searchConfig: EvalSummary["searchConfig"];
  summary: EvalSummary;
  comparison?: EvalComparison;
  gate?: EvalGateResult;
}

export interface SweepAggregateReport {
  generatedAt: string;
  againstPath?: string;
  runCount: number;
  runs: SweepRunSummary[];
  gatePassed?: boolean;
  failedGateRuns?: number;
  bestByHitAt5?: SweepRunSummary;
  bestByMrrAt10?: SweepRunSummary;
  bestByP95Latency?: SweepRunSummary;
}

export interface EvalRunOptions {
  projectRoot: string;
  datasetPath: string;
  configPath?: string;
  outputRoot: string;
  againstPath?: string;
  ciMode: boolean;
  budgetPath?: string;
  reindex: boolean;
  searchOverrides?: Partial<Pick<SearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">>;
}
