import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import { applyCommunityBoost } from "../src/indexer/index.js";

interface FixtureCandidate { id: string; score: number }
interface FixtureQuery {
  id: string;
  relevantId: string;
  sameCommunityIds: string[];
  candidates: FixtureCandidate[];
}
interface Fixture {
  version: string;
  methodology: { baseline: string; limitations: string };
  boost: number;
  queries: FixtureQuery[];
}

const fixturePath = path.join(process.cwd(), "benchmarks", "fixtures", "community-aware-ranking.json");
const baselinePath = path.join(process.cwd(), "benchmarks", "baselines", "community-aware-ranking.json");

function metadata(id: string): ChunkMetadata {
  return {
    filePath: `src/${id}.ts`,
    startLine: 1,
    endLine: 10,
    chunkType: "function",
    language: "typescript",
    hash: id,
    name: id,
  };
}

function reciprocalRank(ids: string[], relevantId: string): number {
  const index = ids.indexOf(relevantId);
  return index < 0 ? 0 : 1 / (index + 1);
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

describe("community-aware ranking evaluation", () => {
  it("matches the checked-in comparison and improves aggregate MRR without guardrail regressions", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;
    const expected = JSON.parse(readFileSync(baselinePath, "utf-8")) as unknown;
    const perQuery = fixture.queries.map((query) => {
      const candidates = query.candidates.map((candidate) => ({
        ...candidate,
        metadata: metadata(candidate.id),
      }));
      const baselineIds = [...candidates]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .map((candidate) => candidate.id);
      const enabledIds = applyCommunityBoost(candidates, new Set(query.sameCommunityIds), fixture.boost)
        .map((candidate) => candidate.id);
      const baselineReciprocalRank = reciprocalRank(baselineIds, query.relevantId);
      const communityAwareReciprocalRank = reciprocalRank(enabledIds, query.relevantId);
      expect(communityAwareReciprocalRank).toBeGreaterThanOrEqual(baselineReciprocalRank);
      return {
        id: query.id,
        baselineReciprocalRank,
        communityAwareReciprocalRank,
      };
    });
    const mean = (values: number[]): number => rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
    const actual = {
      fixtureVersion: fixture.version,
      queryCount: fixture.queries.length,
      baselineMrr: mean(perQuery.map((query) => query.baselineReciprocalRank)),
      communityAwareMrr: mean(perQuery.map((query) => query.communityAwareReciprocalRank)),
      perQuery,
    };

    expect(fixture.methodology.baseline).toContain("supplied retrieval score");
    expect(fixture.methodology.limitations).toContain("does not measure embedding recall");
    expect(actual).toEqual(expected);
    expect(actual.communityAwareMrr).toBeGreaterThan(actual.baselineMrr);
  });
});
