import type { SearchResult } from "../indexer/index.js";
import { buildContextPack, countContextTokens, formatCodebasePeek } from "../tools/utils.js";

export interface EffectivenessFixtureResult extends SearchResult {
  evidenceIds: string[];
}

export interface EffectivenessFixture {
  id: string;
  tokenBudget: number;
  maxResults: number;
  expectedEvidenceIds: string[];
  semanticResults: EffectivenessFixtureResult[];
  baseline: {
    grepOutput: string;
    exactReadOutput: string;
    evidenceIds: string[];
  };
}

export interface FixtureRouteMeasurement {
  tokens: number;
  evidenceRecall: number;
}

export interface FixtureEffectivenessMeasurement {
  id: string;
  context: FixtureRouteMeasurement;
  peek: FixtureRouteMeasurement;
  exactReadGrepBaseline: FixtureRouteMeasurement;
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
  schemaVersion: 1;
  benchmark: "privacy-safe-repository-tool-effectiveness";
  methodology: {
    fixtures: "versioned-synthetic-offline";
    networkCalls: 0;
    tokenizer: "cl100k_base";
    tokenStatistic: "median-and-nearest-rank-p95-across-fixtures";
    evidenceRecall: "expected-evidence-items-covered-divided-by-expected-evidence-items";
    exactReadGrepBaseline: string;
    limitation: string;
  };
  fixtureCount: number;
  routes: {
    context: AggregateRouteMeasurement;
    peek: AggregateRouteMeasurement;
    exactReadGrepBaseline: AggregateRouteMeasurement;
  };
  comparisons: {
    contextMedianTokenRatioToBaseline: number;
    peekMedianTokenRatioToBaseline: number;
  };
}

function evidenceRecall(expectedEvidenceIds: string[], coveredEvidenceIds: Iterable<string>): number {
  if (expectedEvidenceIds.length === 0) return 1;
  const covered = new Set(coveredEvidenceIds);
  const hits = expectedEvidenceIds.filter((id) => covered.has(id)).length;
  return hits / expectedEvidenceIds.length;
}

function selectedEvidence(
  selected: SearchResult[],
  fixtureResults: EffectivenessFixtureResult[],
): string[] {
  const byResult = new Map<SearchResult, string[]>();
  for (const result of fixtureResults) {
    byResult.set(result, result.evidenceIds);
  }
  return selected.flatMap((result) => byResult.get(result) ?? []);
}

function exactReadGrepText(fixture: EffectivenessFixture): string {
  return [
    "Exact grep output:",
    fixture.baseline.grepOutput,
    "",
    "Exact file reads:",
    fixture.baseline.exactReadOutput,
  ].join("\n");
}

export function evaluateEffectivenessFixture(fixture: EffectivenessFixture): FixtureEffectivenessMeasurement {
  const context = buildContextPack(fixture.semanticResults, {
    tokenBudget: fixture.tokenBudget,
    maxResults: fixture.maxResults,
    includeExactSearchHandoff: true,
  });
  const peekText = formatCodebasePeek(fixture.semanticResults);
  const baselineText = exactReadGrepText(fixture);

  return {
    id: fixture.id,
    context: {
      tokens: countContextTokens(context.text),
      evidenceRecall: evidenceRecall(
        fixture.expectedEvidenceIds,
        selectedEvidence(context.results, fixture.semanticResults),
      ),
    },
    peek: {
      tokens: countContextTokens(peekText),
      evidenceRecall: evidenceRecall(
        fixture.expectedEvidenceIds,
        fixture.semanticResults.flatMap((result) => result.evidenceIds),
      ),
    },
    exactReadGrepBaseline: {
      tokens: countContextTokens(baselineText),
      evidenceRecall: evidenceRecall(fixture.expectedEvidenceIds, fixture.baseline.evidenceIds),
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
  route: "context" | "peek" | "exactReadGrepBaseline",
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
  const exactReadGrepBaseline = aggregate(measurements, "exactReadGrepBaseline");
  const baselineMedian = exactReadGrepBaseline.tokens.median;

  return {
    schemaVersion: 1,
    benchmark: "privacy-safe-repository-tool-effectiveness",
    methodology: {
      fixtures: "versioned-synthetic-offline",
      networkCalls: 0,
      tokenizer: "cl100k_base",
      tokenStatistic: "median-and-nearest-rank-p95-across-fixtures",
      evidenceRecall: "expected-evidence-items-covered-divided-by-expected-evidence-items",
      exactReadGrepBaseline:
        "For each synthetic fixture, concatenate deterministic exact-match lines with complete reads of the exact fixture files selected by those matches, then count the full response tokens.",
      limitation:
        "This report describes only the checked-in synthetic fixtures. It does not establish causal agent improvement or production-repository performance.",
    },
    fixtureCount: fixtures.length,
    routes: {
      context,
      peek,
      exactReadGrepBaseline,
    },
    comparisons: {
      contextMedianTokenRatioToBaseline: fixed(baselineMedian === 0 ? 0 : context.tokens.median / baselineMedian),
      peekMedianTokenRatioToBaseline: fixed(baselineMedian === 0 ? 0 : peek.tokens.median / baselineMedian),
    },
  };
}
