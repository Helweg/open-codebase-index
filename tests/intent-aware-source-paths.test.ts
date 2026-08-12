import { describe, expect, it } from "vitest";

import type { RankedCandidate } from "../src/indexer/intent-aware-ranking.js";
import { rankIntentAwareCandidates } from "../src/indexer/intent-aware-ranking.js";

function candidate(
  id: string,
  score: number,
  filePath: string,
  chunkType: string,
): RankedCandidate {
  return {
    id,
    score,
    metadata: {
      filePath,
      startLine: 1,
      endLine: 5,
      chunkType,
      language: "typescript",
      hash: id,
    },
  };
}

describe("intent-aware source path preference", () => {
  it("only promotes implementation evidence for an explicit source preference", () => {
    const candidates = [
      candidate("test", 0.82, "tests/search-ranking.test.ts", "function"),
      candidate("source", 0.55, "src/indexer/search-ranking.ts", "function"),
    ];
    const query = "explain how semantic and keyword rankings are combined";

    expect(rankIntentAwareCandidates(query, candidates, candidates.length).map(({ id }) => id))
      .toEqual(["test", "source"]);
    expect(rankIntentAwareCandidates(query, candidates, candidates.length, { prioritizeSourcePaths: true }).map(({ id }) => id))
      .toEqual(["source", "test"]);
  });
});
