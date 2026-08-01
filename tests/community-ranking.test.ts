import { describe, expect, it } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import { applyCommunityBoost } from "../src/indexer/index.js";

type Candidate = { id: string; score: number; metadata: ChunkMetadata };

function candidate(id: string, score: number): Candidate {
  return {
    id,
    score,
    metadata: {
      filePath: `src/${id}.ts`,
      startLine: 1,
      endLine: 10,
      chunkType: "function",
      language: "typescript",
      hash: id,
      name: id,
    },
  };
}

describe("community-aware local ranking", () => {
  it("is byte-for-byte unchanged when disabled", () => {
    const candidates = [candidate("outside", 0.9), candidate("related", 0.8)];
    expect(applyCommunityBoost(candidates, new Set(["related"]), 0)).toBe(candidates);
  });

  it("deterministically promotes only supplied same-community candidates", () => {
    const candidates = [
      candidate("outside", 0.9),
      candidate("related", 0.8),
      candidate("excluded-before-ranking", 0.99),
    ];
    const scopedCandidates = candidates.slice(0, 2);

    const first = applyCommunityBoost(scopedCandidates, new Set(["related", "excluded-before-ranking"]), 0.25);
    const second = applyCommunityBoost(scopedCandidates, new Set(["related", "excluded-before-ranking"]), 0.25);

    expect(first.map((entry) => entry.id)).toEqual(["related", "outside"]);
    expect(second).toEqual(first);
    expect(first.some((entry) => entry.id === "excluded-before-ranking")).toBe(false);
  });

  it("falls back without copying or reordering when no community context exists", () => {
    const candidates = [candidate("a", 0.9), candidate("b", 0.8)];
    expect(applyCommunityBoost(candidates, new Set(), 0.5)).toBe(candidates);
  });

  it("preserves the existing relative order of unaffected tiered candidates", () => {
    const candidates = [
      candidate("definition-lane", 0.4),
      candidate("high-score-unaffected", 0.95),
      candidate("related", 0.8),
      candidate("low-score-unaffected", 0.3),
    ];

    const ranked = applyCommunityBoost(candidates, new Set(["related"]), 0.25);

    expect(ranked.map((entry) => entry.id)).toEqual([
      "definition-lane",
      "related",
      "high-score-unaffected",
      "low-score-unaffected",
    ]);
    expect(ranked.filter((entry) => entry.id !== "related").map((entry) => entry.id)).toEqual([
      "definition-lane",
      "high-score-unaffected",
      "low-score-unaffected",
    ]);
  });

  it("improves reciprocal rank on a transparent fixed candidate pool", () => {
    const candidates = [candidate("unrelated", 0.9), candidate("same-community", 0.8)];
    const baseline = candidates.map((entry) => entry.id);
    const enabled = applyCommunityBoost(candidates, new Set(["same-community"]), 0.25)
      .map((entry) => entry.id);
    const reciprocalRank = (ids: string[], relevant: string): number => 1 / (ids.indexOf(relevant) + 1);

    expect(reciprocalRank(enabled, "same-community")).toBeGreaterThan(
      reciprocalRank(baseline, "same-community"),
    );
  });
});
