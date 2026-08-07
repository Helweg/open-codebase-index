import type { SearchConfig } from "../config/schema.js";

export type GoldenQueryType =
  | "definition"
  | "implementation-intent"
  | "similarity"
  | "keyword-heavy"
  | "conceptual";

export type GoldenQueryDifficulty = "easy" | "medium" | "hard";
export type GoldenQueryExpectedOutcome = "results" | "no-results";
export type GoldenQueryRecoveryExpectation = "none" | "filter-relaxed";
export type GoldenRetrievalMode = "search" | "context" | "edit-context";
export type EvalResolvedRoute = "search" | "definition";
export type GoldenExpectedRoute = "search" | "definition";
export type GoldenGraphNeighborDirection = "caller" | "callee";

export interface GoldenGradedEvidence {
  path: string;
  symbol?: string;
  relevance: 1 | 2 | 3;
}

export interface GoldenQueryArgs {
  symbol?: string;
  filePath?: string;
  fileType?: string;
  directory?: string;
  callerLimit?: number;
  calleeLimit?: number;
  tokenBudget?: number;
}

export interface GoldenExpectedGraphNeighbor {
  direction: GoldenGraphNeighborDirection;
  filePath?: string;
  symbol?: string;
}

export interface GoldenExpected {
  filePath?: string;
  acceptableFiles?: string[];
  symbol?: string;
  branch?: string;
  expectedRoute?: GoldenExpectedRoute;
  expectedOutcome?: GoldenQueryExpectedOutcome;
  recoveryExpectation?: GoldenQueryRecoveryExpectation;
  gradedEvidence?: GoldenGradedEvidence[];
  graphNeighbor?: GoldenExpectedGraphNeighbor;
}

export interface GoldenQuery {
  id: string;
  query: string;
  queryType: GoldenQueryType;
  retrievalMode?: GoldenRetrievalMode;
  language?: string;
  difficulty?: GoldenQueryDifficulty;
  args?: GoldenQueryArgs;
  tags?: string[];
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
    minGraphNeighborRecall?: number;
    minRouteAccuracy?: number;
    minOutcomeAccuracy?: number;
    maxContextResponseTokensAverage?: number;
    maxContextResponseTokensP95?: number;
    maxContextResponseTokensMax?: number;
    maxContextDuplicateCandidateRatio?: number;
    minContextSelectedFileRatio?: number;
    minContextHitAt5Per1kResponseTokens?: number;
    minContextMrrAt10Per1kResponseTokens?: number;
  };
}

export interface EvalSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string;
  graphDirection?: GoldenGraphNeighborDirection;
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
  routeMatched?: boolean;
  outcomeMatched?: boolean;
  recoveryMatched?: boolean;
  graphNeighborMatched?: boolean;
  language?: string;
  difficulty?: GoldenQueryDifficulty;
  tags?: string[];
  latencyMs: number;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRankAt10: number;
  ndcgAt10: number;
  failureBucket?: FailureBucket;
  rawTop3DistinctRatio: number;
  tokenBudget?: number;
  responseTokens: number;
  candidateCount: number;
  deduplicatedCount: number;
  selectedCount: number;
  omittedCount: number;
  duplicateCandidateRatio: number;
  selectedFileRatio: number;
  results: EvalSearchResult[];
}

export interface ContextEfficiencyMetrics {
  queryCount: number;
  responseTokens: {
    total: number;
    average: number;
    p95: number;
    max: number;
  };
  duplicateCandidateRatio: number;
  selectedFileRatio: number;
  hitAt5Per1kResponseTokens: number;
  mrrAt10Per1kResponseTokens: number;
}

export interface EvalMetrics {
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  hitAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  routeAccuracy: number;
  outcomeAccuracy: number;
  recoveryAccuracy: number;
  graphNeighborRecall?: number;
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
  contextEfficiency: ContextEfficiencyMetrics;
  failureBuckets: Record<FailureBucket, number>;
}

export interface EvalSummary {
  generatedAt: string;
  projectRoot: string;
  datasetPath: string;
  datasetName: string;
  datasetVersion: string;
  datasetFingerprint?: string;
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
    contextResponseTokensAverage: MetricDelta;
    contextResponseTokensP95: MetricDelta;
    contextResponseTokensMax: MetricDelta;
    contextDuplicateCandidateRatio: MetricDelta;
    contextSelectedFileRatio: MetricDelta;
    contextHitAt5Per1kResponseTokens: MetricDelta;
    contextMrrAt10Per1kResponseTokens: MetricDelta;
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
