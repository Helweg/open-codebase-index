import { describe, expect, it } from "vitest";

import {
  aggregateScores,
  normalizeCompetitivePath,
  scoreQuery,
} from "../scripts/competitive-scoring.js";
import type { GoldenQuery } from "../src/eval/types.js";

function query(expected: GoldenQuery["expected"]): GoldenQuery {
  return {
    id: "q1",
    query: "find the implementation",
    queryType: "definition",
    expected,
  };
}

describe("competitive scoring", () => {
  it("uses normalized exact paths and never suffix matching", () => {
    const q = query({ filePath: "src/index.ts" });

    expect(scoreQuery(q, ["src\\index.ts"]).metrics).toMatchObject({
      hitAt1: 1,
      hitAt5: 1,
      mrrAt10: 1,
      ndcgAt10: 1,
    });
    expect(scoreQuery(q, ["repo/src/index.ts"]).metrics).toEqual({
      hitAt1: 0,
      hitAt5: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
    });
  });

  it("deduplicates normalized files at their first rank and limits to ten distinct files", () => {
    const paths = [
      "src/a.ts",
      "src\\a.ts",
      ...Array.from({ length: 10 }, (_, index) => `src/${index}.ts`),
      "src/target.ts",
    ];
    const score = scoreQuery(query({ filePath: "src/1.ts" }), paths);

    expect(score.rankedPaths).toHaveLength(10);
    expect(score.rankedPaths.slice(0, 3)).toEqual(["src/a.ts", "src/0.ts", "src/1.ts"]);
    expect(score.metrics?.mrrAt10).toBeCloseTo(1 / 3, 10);
    expect(score.rankedPaths).not.toContain("src/target.ts");
  });

  it("uses the distinct graded evidence as the ideal nDCG ranking", () => {
    const q = query({
      filePath: "src/high.ts",
      acceptableFiles: ["src/low.ts"],
      gradedEvidence: [
        { path: "src/high.ts", relevance: 3 },
        { path: "src/mid.ts", relevance: 2 },
        { path: "src/low.ts", relevance: 1 },
      ],
    });

    expect(scoreQuery(q, ["src/high.ts", "src/mid.ts", "src/low.ts"]).metrics?.ndcgAt10)
      .toBeCloseTo(1, 10);
    expect(scoreQuery(q, ["src/low.ts", "src/mid.ts", "src/high.ts"]).metrics?.ndcgAt10)
      .toBeLessThan(1);
  });

  it("scores irrelevant and empty successful results as zero", () => {
    const q = query({ filePath: "src/expected.ts" });
    const zero = { hitAt1: 0, hitAt5: 0, mrrAt10: 0, ndcgAt10: 0 };

    expect(scoreQuery(q, ["src/other.ts"]).metrics).toEqual(zero);
    expect(scoreQuery(q, []).metrics).toEqual(zero);
    expect(scoreQuery(query({}), ["src/other.ts"]).metrics).toEqual(zero);
  });

  it("counts errors as supported zero scores and excludes unsupported queries", () => {
    const q = query({ filePath: "src/expected.ts" });
    const success = scoreQuery(q, ["src/expected.ts"]);
    const error = scoreQuery(q, ["src/expected.ts"], "error");
    const unsupported = scoreQuery(q, ["src/expected.ts"], "unsupported");
    const aggregate = aggregateScores([success, error, unsupported]);

    expect(error.metrics).toEqual({ hitAt1: 0, hitAt5: 0, mrrAt10: 0, ndcgAt10: 0 });
    expect(unsupported.metrics).toBeUndefined();
    expect(aggregate).toMatchObject({
      totalCount: 3,
      supportedCount: 2,
      successCount: 1,
      errorCount: 1,
      unsupportedCount: 1,
      supportedTrack: { hitAt1: 0.5, hitAt5: 0.5, mrrAt10: 0.5, ndcgAt10: 0.5 },
      successOnly: { hitAt1: 1, hitAt5: 1, mrrAt10: 1, ndcgAt10: 1 },
    });
  });

  it("returns zero means for empty aggregation tracks", () => {
    const aggregate = aggregateScores([
      scoreQuery(query({ filePath: "src/a.ts" }), [], "unsupported"),
    ]);

    expect(aggregate.supportedTrack).toEqual({ hitAt1: 0, hitAt5: 0, mrrAt10: 0, ndcgAt10: 0 });
    expect(aggregate.successOnly).toEqual({ hitAt1: 0, hitAt5: 0, mrrAt10: 0, ndcgAt10: 0 });
  });

  it.each([
    "",
    "/src/index.ts",
    "../src/index.ts",
    "src/../index.ts",
    "src//index.ts",
    "src/./index.ts",
    "src/index.ts\0ignored",
    "C:\\repo\\src\\index.ts",
    "C:/repo/src/index.ts",
    "C:src/index.ts",
    "\\\\server\\share\\index.ts",
  ])("rejects dangerous or non-normalized path %j", (path) => {
    expect(() => normalizeCompetitivePath(path)).toThrow();
    expect(() => scoreQuery(query({ filePath: "src/index.ts" }), [path])).toThrow();
  });

  it("rejects dangerous expected evidence paths", () => {
    expect(() => scoreQuery(query({ filePath: "../secret.ts" }), [])).toThrow();
    expect(() => scoreQuery(query({
      gradedEvidence: [{ path: "/absolute.ts", relevance: 3 }],
    }), [])).toThrow();
  });

  it("validates paths beyond the top-ten scoring cutoff", () => {
    const paths = [
      ...Array.from({ length: 10 }, (_, index) => `src/${index}.ts`),
      "../hidden-after-cutoff.ts",
    ];

    expect(() => scoreQuery(query({ filePath: "src/0.ts" }), paths)).toThrow();
  });
});
