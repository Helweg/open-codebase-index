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
