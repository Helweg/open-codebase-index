import { readFileSync } from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { RankedCandidate } from "../src/indexer/intent-aware-ranking.js";
import { rankIntentAwareCandidates } from "../src/indexer/intent-aware-ranking.js";

interface FixtureCandidate {
  id: string;
  score: number;
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: string;
  name?: string;
}

interface FixtureQuery {
  id: string;
  query: string;
  relevantIds: string[];
  conceptualGuardrail?: boolean;
  candidates: FixtureCandidate[];
}

interface RankingFixture {
  version: string;
  name: string;
  methodology: {
    baseline: string;
    candidatePools: string;
    metrics: string;
    limitations: string;
  };
  topK: number;
  queries: FixtureQuery[];
}

interface QueryMetrics {
  id: string;
  baselineRecallAt3: number;
  intentAwareRecallAt3: number;
  baselineReciprocalRank: number;
  intentAwareReciprocalRank: number;
}

interface GoldenComparison {
  fixtureVersion: string;
  queryCount: number;
  topK: number;
  baseline: { evidenceRecallAt3: number; mrr: number };
  intentAware: { evidenceRecallAt3: number; mrr: number };
  perQuery: QueryMetrics[];
}

const fixturePath = path.join(process.cwd(), "benchmarks", "fixtures", "intent-aware-ranking.json");
const goldenPath = path.join(process.cwd(), "benchmarks", "baselines", "intent-aware-ranking.json");

function toCandidate(candidate: FixtureCandidate): RankedCandidate {
  return {
    id: candidate.id,
    score: candidate.score,
    metadata: {
      filePath: candidate.filePath,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      chunkType: candidate.chunkType,
      name: candidate.name,
      language: "typescript",
      hash: candidate.id,
    },
  };
}

function fixtureCandidate(
  id: string,
  filePath: string,
  score: number,
  name: string,
  chunkType = "function_item",
): RankedCandidate {
  return toCandidate({ id, filePath, score, name, chunkType, startLine: 1, endLine: 4 });
}

function evidenceRecallAtK(ids: string[], relevantIds: string[], k: number): number {
  const relevant = new Set(relevantIds);
  const found = new Set(ids.slice(0, k).filter((id) => relevant.has(id)));
  return relevant.size === 0 ? 0 : found.size / relevant.size;
}

function reciprocalRank(ids: string[], relevantIds: string[]): number {
  const relevant = new Set(relevantIds);
  const rank = ids.findIndex((id) => relevant.has(id));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function evaluate(fixture: RankingFixture): GoldenComparison {
  const perQuery = fixture.queries.map((query): QueryMetrics => {
    const candidates = query.candidates.map(toCandidate);
    const baselineIds = [...candidates]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((candidate) => candidate.id);
    const intentAwareIds = rankIntentAwareCandidates(query.query, candidates, candidates.length)
      .map((candidate) => candidate.id);

    if (query.conceptualGuardrail) {
      expect(reciprocalRank(intentAwareIds, query.relevantIds)).toBeGreaterThanOrEqual(
        reciprocalRank(baselineIds, query.relevantIds),
      );
    }

    return {
      id: query.id,
      baselineRecallAt3: rounded(evidenceRecallAtK(baselineIds, query.relevantIds, fixture.topK)),
      intentAwareRecallAt3: rounded(evidenceRecallAtK(intentAwareIds, query.relevantIds, fixture.topK)),
      baselineReciprocalRank: rounded(reciprocalRank(baselineIds, query.relevantIds)),
      intentAwareReciprocalRank: rounded(reciprocalRank(intentAwareIds, query.relevantIds)),
    };
  });

  const average = (values: number[]): number => rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    fixtureVersion: fixture.version,
    queryCount: fixture.queries.length,
    topK: fixture.topK,
    baseline: {
      evidenceRecallAt3: average(perQuery.map((query) => query.baselineRecallAt3)),
      mrr: average(perQuery.map((query) => query.baselineReciprocalRank)),
    },
    intentAware: {
      evidenceRecallAt3: average(perQuery.map((query) => query.intentAwareRecallAt3)),
      mrr: average(perQuery.map((query) => query.intentAwareReciprocalRank)),
    },
    perQuery,
  };
}

describe("intent-aware local ranking evaluation", () => {
  it("matches the transparent golden comparison and improves aggregate evidence recall and MRR", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as RankingFixture;
    const golden = JSON.parse(readFileSync(goldenPath, "utf-8")) as GoldenComparison;
    const actual = evaluate(fixture);

    expect(fixture.methodology.baseline).toContain("supplied candidate pool");
    expect(fixture.methodology.limitations).toContain("does not measure embedding recall");
    expect(actual).toEqual(golden);
    expect(actual.intentAware.evidenceRecallAt3).toBeGreaterThan(actual.baseline.evidenceRecallAt3);
    expect(actual.intentAware.mrr).toBeGreaterThan(actual.baseline.mrr);
  });

  it("keeps source-oriented conceptual queries ahead of benchmark artifacts", () => {
    const rankedConceptual = rankIntentAwareCandidates(
      "std io buffer",
      [
        fixtureCandidate("bench", "crates/abc/benches/buf.rs", 0.95, "bench_artifact", "function_item"),
        fixtureCandidate("source", "src/buf/reader.rs", 0.9, "source_artifact", "function_item"),
      ],
      2,
    ).map((candidate) => candidate.id);

    const rankedBenchmark = rankIntentAwareCandidates(
      "std io benchmark",
      [
        fixtureCandidate("source", "src/buf/reader.rs", 0.9, "source_artifact", "function_item"),
        fixtureCandidate("bench", "crates/abc/benches/buf.rs", 0.95, "bench_artifact", "function_item"),
      ],
      2,
    ).map((candidate) => candidate.id);

    expect(rankedConceptual).toEqual(["source", "bench"]);
    expect(rankedBenchmark).toEqual(["bench", "source"]);
  });
});
