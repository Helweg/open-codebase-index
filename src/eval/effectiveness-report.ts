import type { SearchResult } from "../indexer/index.js";
import {
  buildContextPack,
  countContextTokens,
  fitTextToContextBudget,
  formatCodebasePeek,
} from "../tools/utils.js";

export interface EffectivenessFixtureResult extends SearchResult {
  evidenceIds: string[];
}

export interface EffectivenessFixture {
  id: string;
  tokenBudget: number;
  maxResults: number;
  expectedEvidenceIds: string[];
  semanticResults: EffectivenessFixtureResult[];
}

export interface FixtureRouteMeasurement {
  tokens: number;
  evidenceRecall: number;
}

export interface FixtureEffectivenessMeasurement {
  id: string;
  context: FixtureRouteMeasurement;
  peek: FixtureRouteMeasurement;
  exactSearchSnippetBaseline: FixtureRouteMeasurement;
}

interface AggregateRouteMeasurement {
  tokens: {
    median: number;
    p95: number;
  };
  evidenceRecall: {
    mean: number;
    median: number;
    minimum: number;
  };
}

export interface EffectivenessEvaluationReport {
  schemaVersion: 3;
  benchmark: "privacy-safe-repository-tool-effectiveness";
  methodology: {
    fixtures: "versioned-synthetic-offline";
    queryModel: string;
    sourceCorpus: string;
    maxResultsCap: string;
    tokenBudgetParity: string;
    networkCalls: 0;
    warmupRuns: 0;
    measuredRunsPerFixture: 1;
    timing: "not-measured-deterministic-format-and-token-evaluation-only";
    tokenizer: "cl100k_base";
    tokenStatistic: "median-and-nearest-rank-p95-across-fixtures";
    evidenceRecall: string;
    determinism: string;
    exactSearchSnippetBaseline: string;
    limitation: string;
  };
  fixtureCount: number;
  routes: {
    context: AggregateRouteMeasurement;
    peek: AggregateRouteMeasurement;
    exactSearchSnippetBaseline: AggregateRouteMeasurement;
  };
  comparisons: {
    contextMedianTokenRatioToBaseline: number;
    peekMedianTokenRatioToBaseline: number;
  };
}

export function effectivenessEvidenceMarker(evidenceId: string): string {
  return `[[effectiveness-evidence:${evidenceId}]]`;
}

function evidenceRecall(expectedEvidenceIds: string[], routeText: string): number {
  if (expectedEvidenceIds.length === 0) return 1;
  const hits = expectedEvidenceIds.filter((id) => routeText.includes(effectivenessEvidenceMarker(id))).length;
  return hits / expectedEvidenceIds.length;
}

function exactSearchSnippetText(
  fixture: EffectivenessFixture,
  selectedResults: EffectivenessFixtureResult[],
): string {
  const markers = fixture.expectedEvidenceIds.map(effectivenessEvidenceMarker);
  const matches = selectedResults.flatMap((result) => result.content
    .split("\n")
    .map((line, index) => ({ line, lineNumber: result.startLine + index }))
    .filter(({ line }) => markers.some((marker) => line.includes(marker)))
    .map(({ line, lineNumber }) => `${result.filePath}:${lineNumber}:${line.trim()}`));
  return matches.length > 0
    ? `Exact-search matching lines:\n${matches.join("\n")}`
    : "Exact-search matching lines:\nNo matching evidence lines.";
}

export function evaluateEffectivenessFixture(fixture: EffectivenessFixture): FixtureEffectivenessMeasurement {
  const cappedResults = fixture.semanticResults.slice(0, fixture.maxResults);
  const context = buildContextPack(cappedResults, {
    tokenBudget: fixture.tokenBudget,
    maxResults: cappedResults.length,
    includeExactSearchHandoff: true,
  });
  const peek = fitTextToContextBudget(formatCodebasePeek(cappedResults), fixture.tokenBudget);
  const baseline = fitTextToContextBudget(
    exactSearchSnippetText(fixture, cappedResults),
    fixture.tokenBudget,
  );

  return {
    id: fixture.id,
    context: {
      tokens: countContextTokens(context.text),
      evidenceRecall: evidenceRecall(fixture.expectedEvidenceIds, context.text),
    },
    peek: {
      tokens: peek.tokenEstimate,
      evidenceRecall: evidenceRecall(fixture.expectedEvidenceIds, peek.text),
    },
    exactSearchSnippetBaseline: {
      tokens: baseline.tokenEstimate,
      evidenceRecall: evidenceRecall(fixture.expectedEvidenceIds, baseline.text),
    },
  };
}

function sorted(values: number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function nearestRankP95(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = sorted(values);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

function fixed(value: number): number {
  return Number(value.toFixed(4));
}

function aggregate(
  measurements: FixtureEffectivenessMeasurement[],
  route: "context" | "peek" | "exactSearchSnippetBaseline",
): AggregateRouteMeasurement {
  const tokens = measurements.map((measurement) => measurement[route].tokens);
  const recalls = measurements.map((measurement) => measurement[route].evidenceRecall);
  return {
    tokens: {
      median: median(tokens),
      p95: nearestRankP95(tokens),
    },
    evidenceRecall: {
      mean: fixed(recalls.reduce((sum, value) => sum + value, 0) / Math.max(1, recalls.length)),
      median: fixed(median(recalls)),
      minimum: fixed(recalls.length === 0 ? 0 : Math.min(...recalls)),
    },
  };
}

export function buildEffectivenessEvaluationReport(
  fixtures: EffectivenessFixture[],
): EffectivenessEvaluationReport {
  const measurements = fixtures.map(evaluateEffectivenessFixture);
  const context = aggregate(measurements, "context");
  const peek = aggregate(measurements, "peek");
  const exactSearchSnippetBaseline = aggregate(measurements, "exactSearchSnippetBaseline");
  const baselineMedian = exactSearchSnippetBaseline.tokens.median;

  return {
    schemaVersion: 3,
    benchmark: "privacy-safe-repository-tool-effectiveness",
    methodology: {
      fixtures: "versioned-synthetic-offline",
      queryModel: "Five checked-in scenario labels map to fixed ranked synthetic results; no retrieval model or embedding provider runs during this report.",
      sourceCorpus: "Every route starts from the same fixed ranked synthetic result objects. Context and peek format their actual metadata-oriented response text, while the baseline emits only exact matching lines from those same objects.",
      maxResultsCap: "Every route receives only the first fixture.maxResults ranked results before formatting.",
      tokenBudgetParity: "Every final route response is constrained by the same fixture.tokenBudget before token counting or evidence scoring.",
      networkCalls: 0,
      warmupRuns: 0,
      measuredRunsPerFixture: 1,
      timing: "not-measured-deterministic-format-and-token-evaluation-only",
      tokenizer: "cl100k_base",
      tokenStatistic: "median-and-nearest-rank-p95-across-fixtures",
      evidenceRecall: "Expected evidence markers visibly present in the final budgeted route text divided by expected evidence markers. Metadata-only results receive no hidden content credit.",
      determinism: "No clocks, randomness, embeddings, repository indexing, or network calls affect the generated aggregate report.",
      exactSearchSnippetBaseline:
        "An oracle exact-search baseline emits only matching source lines from the capped ranked chunks. It performs no arbitrary or complete file reads and excludes discovery cost.",
      limitation:
        "This synthetic formatting benchmark fixes rankings and uses oracle evidence markers. It does not measure retrieval quality, latency, end-to-end agent success, causal impact, or production-repository performance. Context and peek responses are metadata-oriented here, so content evidence is credited only if its literal marker is visible in returned text.",
    },
    fixtureCount: fixtures.length,
    routes: {
      context,
      peek,
      exactSearchSnippetBaseline,
    },
    comparisons: {
      contextMedianTokenRatioToBaseline: fixed(baselineMedian === 0 ? 0 : context.tokens.median / baselineMedian),
      peekMedianTokenRatioToBaseline: fixed(baselineMedian === 0 ? 0 : peek.tokens.median / baselineMedian),
    },
  };
}
