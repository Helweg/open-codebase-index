import { readFileSync } from "fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EFFECTIVENESS_FIXTURES } from "../benchmarks/fixtures/privacy-safe-effectiveness.js";
import {
  buildEffectivenessEvaluationReport,
  evaluateEffectivenessFixture,
} from "../src/eval/effectiveness-report.js";

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function p95(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline privacy-safe effectiveness evaluation", () => {
  it("is deterministic, offline, and matches the checked-in report byte-for-byte", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access is forbidden in the offline effectiveness benchmark");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const first = `${JSON.stringify(buildEffectivenessEvaluationReport(EFFECTIVENESS_FIXTURES), null, 2)}\n`;
    const second = `${JSON.stringify(buildEffectivenessEvaluationReport(EFFECTIVENESS_FIXTURES), null, 2)}\n`;
    const checkedIn = readFileSync("benchmarks/baselines/privacy-safe-effectiveness.json", "utf8");

    expect(first).toBe(second);
    expect(first).toBe(checkedIn);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("independently recomputes median, nearest-rank p95, and evidence recall", () => {
    const measurements = EFFECTIVENESS_FIXTURES.map(evaluateEffectivenessFixture);
    const report = buildEffectivenessEvaluationReport(EFFECTIVENESS_FIXTURES);

    for (const route of ["context", "peek", "exactReadGrepBaseline"] as const) {
      const tokens = measurements.map((measurement) => measurement[route].tokens);
      const recalls = measurements.map((measurement) => measurement[route].evidenceRecall);
      expect(report.routes[route].tokens.median).toBe(median(tokens));
      expect(report.routes[route].tokens.p95).toBe(p95(tokens));
      expect(report.routes[route].evidenceRecall.mean).toBe(
        Number((recalls.reduce((sum, value) => sum + value, 0) / recalls.length).toFixed(4)),
      );
      expect(report.routes[route].evidenceRecall.minimum).toBe(Math.min(...recalls));
    }
  });

  it("defines the baseline and avoids unverifiable causal claims", () => {
    const report = buildEffectivenessEvaluationReport(EFFECTIVENESS_FIXTURES);

    expect(report.methodology.networkCalls).toBe(0);
    expect(report.methodology.exactReadGrepBaseline).toContain("exact-match lines");
    expect(report.methodology.exactReadGrepBaseline).toContain("complete reads");
    expect(report.methodology.limitation).toContain("does not establish causal agent improvement");
    expect(report.routes.context.tokens).toEqual(expect.objectContaining({ median: expect.any(Number), p95: expect.any(Number) }));
    expect(report.routes.peek.tokens).toEqual(expect.objectContaining({ median: expect.any(Number), p95: expect.any(Number) }));
    expect(report.routes.exactReadGrepBaseline.tokens).toEqual(expect.objectContaining({ median: expect.any(Number), p95: expect.any(Number) }));
  });

  it("does not include fixture queries, source, symbols, paths, repositories, or evidence identifiers in the report", () => {
    const serialized = JSON.stringify(buildEffectivenessEvaluationReport(EFFECTIVENESS_FIXTURES));
    const sensitiveFixtureValues = EFFECTIVENESS_FIXTURES.flatMap((fixture) => [
      fixture.id,
      ...fixture.expectedEvidenceIds,
      ...fixture.semanticResults.flatMap((result) => [
        result.filePath,
        result.name ?? "",
        result.content,
        ...result.evidenceIds,
      ]),
      fixture.baseline.grepOutput,
      fixture.baseline.exactReadOutput,
      ...fixture.baseline.evidenceIds,
    ]).filter(Boolean);

    for (const value of sensitiveFixtureValues) {
      expect(serialized).not.toContain(value);
    }
  });
});
