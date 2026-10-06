import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCompetitiveReport,
  loadCompetitiveRows,
  repositoryClusterBootstrap,
} from "../scripts/competitive-report.js";
import type { CompetitiveArtifactRow } from "../scripts/competitive-report.js";
import type { CompetitiveQueryScore, CompetitiveRunStatus } from "../scripts/competitive-scoring.js";

const rivals = ["codegraph", "codebase-memory", "grepai"] as const;

function score(queryId: string, hitAt5: number, status: CompetitiveRunStatus = "success"): CompetitiveQueryScore {
  return {
    queryId,
    status,
    rankedPaths: [],
    ...(status === "unsupported" ? {} : {
      metrics: { hitAt1: hitAt5, hitAt5, mrrAt10: hitAt5, ndcgAt10: hitAt5 },
    }),
  };
}

function row(
  repository: string,
  condition: string,
  queryId: string,
  hitAt5: number,
  track: CompetitiveArtifactRow["track"] = "explicit-symbol",
  status: CompetitiveRunStatus = "success",
): CompetitiveArtifactRow {
  return { repository, condition, queryId, track, score: score(queryId, hitAt5, status) };
}

function completeRows(): CompetitiveArtifactRow[] {
  const baseline = [
    row("repo-a", "ocbi-hybrid", "q1", 1),
    row("repo-a", "ocbi-hybrid", "q2", 1),
    row("repo-b", "ocbi-hybrid", "q3", 0),
  ];
  return [
    ...baseline,
    ...rivals.flatMap((rival) => [
      row("repo-a", rival, "q1", 0),
      row("repo-a", rival, "q2", 1),
      row("repo-b", rival, "q3", 1),
    ]),
  ];
}

function reportOptions(rows: readonly CompetitiveArtifactRow[], bootstrapSamples = 100) {
  const baseline = rows.filter((candidate) => candidate.condition === "ocbi-hybrid");
  return {
    bootstrapSamples,
    conditions: ["ocbi-hybrid", ...rivals],
    expectedTasks: baseline.map(({ repository, queryId, track }) => ({ repository, queryId, track })),
  };
}

describe("competitive report", () => {
  it("computes hand-checkable paired and repository-weighted Hit@5 deltas", () => {
    const rows = completeRows();
    const report = buildCompetitiveReport(rows, reportOptions(rows));
    const pair = report.primaryPairs[0];

    expect(report).toMatchObject({ cohort: "development-only", exploratory: true });
    expect(pair).toMatchObject({
      baseline: "ocbi-hybrid",
      rival: "codegraph",
      track: "explicit-symbol",
      queryCount: 3,
      repositoryCount: 2,
      queryWeightedHitAt5Delta: 0,
      equalRepositoryHitAt5Delta: -0.25,
      perRepository: [
        { repository: "repo-a", queryCount: 2, hitAt5Delta: 0.5 },
        { repository: "repo-b", queryCount: 1, hitAt5Delta: -1 },
      ],
      leaveOneRepositoryOut: [
        { omittedRepository: "repo-a", queryWeightedHitAt5Delta: -1 },
        { omittedRepository: "repo-b", queryWeightedHitAt5Delta: 0.5 },
      ],
      exploratory: true,
    });
  });

  it("keeps natural-language rows out of the 54-query primary pairing", () => {
    const rows = completeRows();
    for (const condition of ["ocbi-hybrid", ...rivals]) {
      rows.push(row("repo-a", condition, "natural", condition === "ocbi-hybrid" ? 1 : 0, "natural-language"));
    }

    const report = buildCompetitiveReport(rows, reportOptions(rows, 10));
    expect(report.primaryPairs[0].queryCount).toBe(3);
    expect(report.tracks["ocbi-hybrid"]["natural-language"]?.rowCount).toBe(1);
  });

  it("preserves error, unsupported, and empty-result denominators", () => {
    const rows = completeRows();
    rows.push(row("repo-a", "ocbi-hybrid", "natural-success", 1, "natural-language"));
    rows.push(row("repo-a", "ocbi-hybrid", "natural-error", 0, "natural-language", "error"));
    rows.push(row("repo-b", "ocbi-hybrid", "natural-unsupported", 0, "natural-language", "unsupported"));
    for (const rival of rivals) {
      rows.push(row("repo-a", rival, "natural-success", 0, "natural-language"));
      rows.push(row("repo-a", rival, "natural-error", 0, "natural-language", "error"));
      rows.push(row("repo-b", rival, "natural-unsupported", 0, "natural-language", "unsupported"));
    }
    const track = buildCompetitiveReport(rows, reportOptions(rows, 10)).tracks["ocbi-hybrid"]["natural-language"];

    expect(track).toMatchObject({
      rowCount: 3,
      repositoryCount: 2,
      supportedQueryCount: 2,
      queryWeightedHitAt5: 0.5,
      equalRepositoryHitAt5: 0.5,
      metrics: { supportedCount: 2, successCount: 1, errorCount: 1, unsupportedCount: 1 },
    });
  });

  it("exposes per-task wins, losses, ties, paths, and all existing metric deltas on both tracks", () => {
    const rows = completeRows();
    for (const candidate of [...rows]) {
      const queryId = `natural-${candidate.queryId}`;
      rows.push({
        ...candidate,
        queryId,
        track: "natural-language",
        score: { ...candidate.score, queryId },
      });
    }
    rows[0].score.rankedPaths = ["src/baseline.ts", "src/shared.ts"];
    rows[0].score.metrics = { hitAt1: 0, hitAt5: 1, mrrAt10: 0.5, ndcgAt10: 0.75 };
    rows[3].score.rankedPaths = ["src/rival.ts"];
    const report = buildCompetitiveReport(rows, reportOptions(rows, 10));
    const reversed = buildCompetitiveReport([...rows].reverse(), reportOptions(rows, 10));
    expect(reversed.taskComparisons).toEqual(report.taskComparisons);
    expect(reversed.comparisonCounts).toEqual(report.comparisonCounts);

    for (const rival of rivals) {
      for (const track of ["explicit-symbol", "natural-language"] as const) {
        const comparisons = report.taskComparisons.filter((comparison) => comparison.rival === rival && comparison.track === track);
        expect(comparisons.map((comparison) => comparison.hitAt5Outcome)).toEqual(["win", "tie", "loss"]);
        expect(report.comparisonCounts.find((counts) => counts.rival === rival && counts.track === track)).toMatchObject({
          queryCount: 3, supportedPairedCount: 3, winCount: 1, lossCount: 1, tieCount: 1, unsupportedCount: 0,
          baselineErrorCount: 0, rivalErrorCount: 0, operationalErrorPairCount: 0,
        });
      }
    }
    expect(report.taskComparisons.find((comparison) => comparison.rival === "codegraph" && comparison.queryId === "q1")).toEqual({
      repository: "repo-a",
      queryId: "q1",
      track: "explicit-symbol",
      baseline: "ocbi-hybrid",
      rival: "codegraph",
      baselineResult: {
        status: "success", rankedPaths: ["src/baseline.ts", "src/shared.ts"],
        metrics: { hitAt1: 0, hitAt5: 1, mrrAt10: 0.5, ndcgAt10: 0.75 }, retrievalOutcome: "hit-at-5",
      },
      rivalResult: {
        status: "success", rankedPaths: ["src/rival.ts"],
        metrics: { hitAt1: 0, hitAt5: 0, mrrAt10: 0, ndcgAt10: 0 }, retrievalOutcome: "miss-at-5",
      },
      metricDeltas: { hitAt1: 0, hitAt5: 1, mrrAt10: 0.5, ndcgAt10: 0.75 },
      hitAt5Outcome: "win",
    });
  });

  it("separates unsupported pairs and operational errors from successful misses", () => {
    const rows = completeRows();
    const tasks = [
      { id: "baseline-unsupported", baseline: "unsupported", rival: "success", baselineHit: 0, rivalHit: 1 },
      { id: "rival-unsupported", baseline: "success", rival: "unsupported", baselineHit: 1, rivalHit: 0 },
      { id: "error-vs-miss", baseline: "error", rival: "success", baselineHit: 0, rivalHit: 0 },
      { id: "hit-vs-error", baseline: "success", rival: "error", baselineHit: 1, rivalHit: 0 },
      { id: "error-vs-hit", baseline: "error", rival: "success", baselineHit: 0, rivalHit: 1 },
      { id: "unsupported-vs-error", baseline: "unsupported", rival: "error", baselineHit: 0, rivalHit: 0 },
    ] as const;
    for (const task of tasks) {
      rows.push(row("repo-a", "ocbi-hybrid", task.id, task.baselineHit, "natural-language", task.baseline));
      for (const rival of rivals) {
        rows.push(row("repo-a", rival, task.id, task.rivalHit, "natural-language", task.rival));
      }
    }
    const report = buildCompetitiveReport(rows, reportOptions(rows, 10));
    const comparisons = new Map(report.taskComparisons
      .filter((comparison) => comparison.rival === "codegraph" && comparison.track === "natural-language")
      .map((comparison) => [comparison.queryId, comparison]));

    expect(comparisons.get("baseline-unsupported")).toMatchObject({
      hitAt5Outcome: "unsupported", metricDeltas: null,
      baselineResult: { status: "unsupported", metrics: null, retrievalOutcome: "unsupported" },
      rivalResult: { status: "success", metrics: { hitAt5: 1 }, retrievalOutcome: "hit-at-5" },
    });
    expect(comparisons.get("rival-unsupported")).toMatchObject({
      hitAt5Outcome: "unsupported", metricDeltas: null,
      baselineResult: { status: "success", metrics: { hitAt5: 1 } }, rivalResult: { status: "unsupported", metrics: null },
    });
    expect(comparisons.get("error-vs-miss")).toMatchObject({
      hitAt5Outcome: "tie", metricDeltas: { hitAt5: 0 },
      baselineResult: { status: "error", metrics: { hitAt5: 0 }, retrievalOutcome: "operational-error" },
      rivalResult: { status: "success", metrics: { hitAt5: 0 }, retrievalOutcome: "miss-at-5" },
    });
    expect(comparisons.get("hit-vs-error")).toMatchObject({
      hitAt5Outcome: "win", rivalResult: { status: "error", retrievalOutcome: "operational-error" },
    });
    expect(comparisons.get("error-vs-hit")).toMatchObject({
      hitAt5Outcome: "loss", baselineResult: { status: "error", retrievalOutcome: "operational-error" },
    });
    expect(comparisons.get("unsupported-vs-error")).toMatchObject({
      hitAt5Outcome: "unsupported", metricDeltas: null, rivalResult: { status: "error", retrievalOutcome: "operational-error" },
    });
    expect(report.comparisonCounts.filter((counts) => counts.track === "natural-language")).toEqual(
      [...rivals].sort().map((rival) => ({
        baseline: "ocbi-hybrid", rival, track: "natural-language",
        queryCount: 6, supportedPairedCount: 3, winCount: 1, lossCount: 1, tieCount: 1, unsupportedCount: 3,
        baselineErrorCount: 2, rivalErrorCount: 2, operationalErrorPairCount: 4,
      })),
    );
  });

  it("keeps explicit-symbol operational errors in supported comparisons without calling them retrieval misses", () => {
    const rows = completeRows();
    rows[0].score = score("q1", 0, "error");
    const report = buildCompetitiveReport(rows, reportOptions(rows, 10));
    expect(report.taskComparisons.find((comparison) => comparison.rival === "codegraph" && comparison.queryId === "q1")).toMatchObject({
      hitAt5Outcome: "tie", baselineResult: { status: "error", retrievalOutcome: "operational-error" },
      rivalResult: { status: "success", retrievalOutcome: "miss-at-5" },
    });
    expect(report.comparisonCounts.find((counts) => counts.rival === "codegraph" && counts.track === "explicit-symbol")).toMatchObject({
      supportedPairedCount: 3, winCount: 0, lossCount: 1, tieCount: 2, unsupportedCount: 0, operationalErrorPairCount: 1,
    });
    expect(report.primaryPairs[0].queryCount).toBe(3);
    expect(report.primaryPairs[0].queryWeightedHitAt5Delta).toBe(-1 / 3);
  });

  it("pairs the same query ID separately in different repositories and sorts diagnostics independently of input order", () => {
    const rows = completeRows().map((candidate) => candidate.queryId === "q3"
      ? { ...candidate, queryId: "q1", score: { ...candidate.score, queryId: "q1" } }
      : candidate);
    const options = reportOptions(rows, 10);
    const report = buildCompetitiveReport(rows, options);
    const reversed = buildCompetitiveReport([...rows].reverse(), { ...options,
      expectedTasks: [...options.expectedTasks].reverse(), conditions: [...options.conditions].reverse() });

    expect(reversed.taskComparisons).toEqual(report.taskComparisons);
    expect(reversed.comparisonCounts).toEqual(report.comparisonCounts);
    expect(report.taskComparisons.filter((comparison) => comparison.rival === "codegraph" && comparison.queryId === "q1")
      .map(({ repository, hitAt5Outcome }) => ({ repository, hitAt5Outcome }))).toEqual([
      { repository: "repo-a", hitAt5Outcome: "win" }, { repository: "repo-b", hitAt5Outcome: "loss" },
    ]);
    expect(report.taskComparisons.map(({ rival, repository, queryId }) => `${rival}/${repository}/${queryId}`)).toEqual([
      "codebase-memory/repo-a/q1", "codebase-memory/repo-a/q2", "codebase-memory/repo-b/q1",
      "codegraph/repo-a/q1", "codegraph/repo-a/q2", "codegraph/repo-b/q1",
      "grepai/repo-a/q1", "grepai/repo-a/q2", "grepai/repo-b/q1",
    ]);
  });

  it.each(["success", "error"] as const)("rejects missing metrics for supported %s rows instead of fabricating ties", (status) => {
    const rows = completeRows();
    rows[0].score = { queryId: "q1", status, rankedPaths: [] };
    expect(() => buildCompetitiveReport(rows, reportOptions(rows, 10))).toThrow(/Missing supported benchmark metrics/);
  });

  it.each([
    { metric: "hitAt5", value: undefined },
    { metric: "hitAt1", value: 0.5 },
    { metric: "mrrAt10", value: Number.NaN },
    { metric: "ndcgAt10", value: Number.POSITIVE_INFINITY },
    { metric: "ndcgAt10", value: -0.1 },
  ] as const)("rejects malformed consumed $metric metrics", ({ metric, value }) => {
    const rows = completeRows();
    rows[0].score.metrics = { ...rows[0].score.metrics!, [metric]: value } as NonNullable<CompetitiveQueryScore["metrics"]>;
    expect(() => buildCompetitiveReport(rows, reportOptions(rows, 10))).toThrow(/Invalid benchmark metric/);
  });

  it("rejects nonzero error metrics rather than presenting an operational failure as a retrieval hit", () => {
    const rows = completeRows();
    rows[0].score = score("q1", 1, "error");
    expect(() => buildCompetitiveReport(rows, reportOptions(rows, 10))).toThrow(/Invalid benchmark metric/);
  });

  it("rejects unsupported explicit-symbol primary rows instead of silently changing the frozen paired denominator", () => {
    const rows = completeRows();
    rows[0].score = score("q1", 0, "unsupported");
    expect(() => buildCompetitiveReport(rows, reportOptions(rows, 10))).toThrow(/Unsupported row in frozen explicit-symbol primary track/);
  });

  it("produces zero-width intervals when every paired result is tied", () => {
    const tied = [
      { repository: "a", delta: 0 },
      { repository: "a", delta: 0 },
      { repository: "b", delta: 0 },
    ];

    expect(repositoryClusterBootstrap(tied, 100)).toEqual({
      confidence95: { lower: 0, upper: 0 },
      confidence98_333: { lower: 0, upper: 0 },
    });
  });

  it("rejects missing primary task pairs", () => {
    const rows = completeRows().filter((candidate) => !(
      candidate.condition === "grepai" && candidate.queryId === "q3"
    ));

    expect(() => buildCompetitiveReport(rows, reportOptions(completeRows(), 10))).toThrow(/Missing frozen benchmark rows/);
  });

  it("rejects a frozen task missing from every condition", () => {
    const complete = completeRows();
    const rows = complete.filter((candidate) => candidate.queryId !== "q3");
    expect(() => buildCompetitiveReport(rows, reportOptions(complete, 10))).toThrow(/Missing frozen benchmark rows/);
  });

  it("rejects duplicate primary task pairs", () => {
    const rows = completeRows();
    rows.push(row("repo-a", "codegraph", "q1", 0));

    expect(() => buildCompetitiveReport(rows, reportOptions(completeRows(), 10))).toThrow(/Duplicate benchmark row/);
  });

  it("rejects duplicate natural-language and structural rows", () => {
    const rows = completeRows();
    for (const condition of ["ocbi-hybrid", ...rivals]) {
      rows.push(row("repo-a", condition, "natural", 0, "natural-language"));
    }
    const options = reportOptions(rows, 10);
    rows.push(row("repo-a", "ocbi-hybrid", "natural", 0, "natural-language"));
    expect(() => buildCompetitiveReport(rows, options)).toThrow(/Duplicate benchmark row/);

    const structuralRows = completeRows();
    structuralRows.push(...options.expectedTasks.map((task) => row(task.repository, "ocbi-structural", task.queryId, 0, task.track)));
    structuralRows.push(row("repo-a", "ocbi-structural", "q1", 0));
    expect(() => buildCompetitiveReport(structuralRows, {
      ...options,
      conditions: [...options.conditions, "ocbi-structural"],
    })).toThrow(/Duplicate benchmark row/);
  });

  it("reports null supported-only quality means when a track is entirely unsupported", () => {
    const rows = completeRows();
    for (const condition of ["ocbi-hybrid", ...rivals]) {
      rows.push(row("repo-a", condition, "natural", 0, "natural-language", "unsupported"));
    }
    const track = buildCompetitiveReport(rows, reportOptions(rows, 10)).tracks["codebase-memory"]["natural-language"];
    expect(track).toMatchObject({ supportedQueryCount: 0, queryWeightedHitAt5: null, equalRepositoryHitAt5: null });
  });

  it("is reproducible for the preregistered seed", () => {
    const rows = [
      { repository: "a", delta: 1 },
      { repository: "a", delta: 0 },
      { repository: "b", delta: -1 },
      { repository: "c", delta: 1 },
    ];

    const first = repositoryClusterBootstrap(rows, 10_000, 20260910);
    expect(repositoryClusterBootstrap(rows, 10_000, 20260910)).toEqual(first);
  });

  it("loads only repeat one as the primary quality observation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "competitive-report-"));
    try {
      const condition = path.join(root, "repo-a", "ocbi-hybrid");
      await fs.mkdir(path.join(condition, "repeat-1"), { recursive: true });
      await fs.mkdir(path.join(condition, "repeat-2"), { recursive: true });
      const artifact = {
        queryId: "q1",
        condition: "ocbi-hybrid",
        input: { symbol: "findMe" },
        repeat: 1,
        score: score("q1", 1),
      };
      await fs.writeFile(path.join(condition, "repeat-1", "q1.json"), JSON.stringify(artifact));
      await fs.writeFile(path.join(condition, "repeat-2", "q1.json"), JSON.stringify({ ...artifact, repeat: 2 }));

      await expect(loadCompetitiveRows(root)).resolves.toEqual([
        row("repo-a", "ocbi-hybrid", "q1", 1),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an empty primary quality directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "competitive-report-empty-"));
    try {
      await fs.mkdir(path.join(root, "repo-a", "ocbi-hybrid", "repeat-1"), { recursive: true });
      await expect(loadCompetitiveRows(root)).rejects.toThrow(/Empty primary quality directory/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
