import { readFileSync } from "fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EFFECTIVENESS_FIXTURES } from "../benchmarks/fixtures/privacy-safe-effectiveness.js";
import {
  buildEffectivenessEvaluationReport,
  effectivenessEvidenceMarker,
  evaluateEffectivenessFixture,
  type EffectivenessFixture,
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

    for (const route of ["context", "peek", "exactSearchSnippetBaseline"] as const) {
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
    expect(report.methodology.warmupRuns).toBe(0);
    expect(report.methodology.measuredRunsPerFixture).toBe(1);
    expect(report.methodology.timing).toBe("not-measured-deterministic-format-and-token-evaluation-only");
    expect(report.methodology.sourceCorpus).toContain("same fixed ranked synthetic result objects");
    expect(report.methodology.maxResultsCap).toContain("fixture.maxResults");
    expect(report.methodology.tokenBudgetParity).toContain("same fixture.tokenBudget");
    expect(report.methodology.evidenceRecall).toContain("visibly present");
    expect(report.methodology.evidenceRecall).toContain("no hidden content credit");
    expect(report.methodology.exactSearchSnippetBaseline).toContain("only matching source lines");
    expect(report.methodology.exactSearchSnippetBaseline).toContain("no arbitrary or complete file reads");
    expect(report.methodology.limitation).toContain("does not measure retrieval quality");
    expect(report.methodology.limitation).toContain("causal impact");
    expect(report.routes.context.tokens).toEqual(expect.objectContaining({ median: expect.any(Number), p95: expect.any(Number) }));
    expect(report.routes.peek.tokens).toEqual(expect.objectContaining({ median: expect.any(Number), p95: expect.any(Number) }));
    expect(report.routes.exactSearchSnippetBaseline.tokens).toEqual(expect.objectContaining({ median: expect.any(Number), p95: expect.any(Number) }));
  });

  it("enforces the same result cap and final-response token budget on every route", () => {
    for (const fixture of EFFECTIVENESS_FIXTURES) {
      const measurement = evaluateEffectivenessFixture(fixture);
      expect(measurement.context.tokens).toBeLessThanOrEqual(fixture.tokenBudget);
      expect(measurement.peek.tokens).toBeLessThanOrEqual(fixture.tokenBudget);
      expect(measurement.exactSearchSnippetBaseline.tokens).toBeLessThanOrEqual(fixture.tokenBudget);
      expect(measurement.peek.evidenceRecall).toBe(0);
    }

    const cappedFixture = EFFECTIVENESS_FIXTURES.find((fixture) => fixture.maxResults === 1);
    expect(cappedFixture).toBeDefined();
    const cappedMeasurement = evaluateEffectivenessFixture(cappedFixture!);
    expect(cappedMeasurement.context.evidenceRecall).toBe(0);
    expect(cappedMeasurement.peek.evidenceRecall).toBe(0);
    expect(cappedMeasurement.exactSearchSnippetBaseline.evidenceRecall).toBe(0.5);
  });

  it("credits evidence only when its marker is visible in the final route text", () => {
    const hiddenEvidenceFixture: EffectivenessFixture = {
      id: "hidden-evidence",
      tokenBudget: 128,
      maxResults: 1,
      expectedEvidenceIds: ["hidden"],
      semanticResults: [{
        filePath: "src/hidden.ts",
        startLine: 1,
        endLine: 3,
        content: "export function hidden() { return true; }",
        score: 1,
        chunkType: "function",
        name: "hidden",
        evidenceIds: ["hidden"],
      }],
    };

    const hidden = evaluateEffectivenessFixture(hiddenEvidenceFixture);
    expect(hidden.context.evidenceRecall).toBe(0);
    expect(hidden.peek.evidenceRecall).toBe(0);
    expect(hidden.exactSearchSnippetBaseline.evidenceRecall).toBe(0);

    const marker = effectivenessEvidenceMarker("late");
    const budgetedFixture: EffectivenessFixture = {
      ...hiddenEvidenceFixture,
      id: "budgeted-evidence",
      expectedEvidenceIds: ["late"],
      semanticResults: [{
        ...hiddenEvidenceFixture.semanticResults[0],
        filePath: `src/${"very-long-segment/".repeat(80)}late.ts`,
        content: `export function late() {\n  const evidence = ${JSON.stringify(marker)};\n}`,
        evidenceIds: ["late"],
      }],
    };
    const budgeted = evaluateEffectivenessFixture(budgetedFixture);
    expect(budgeted.context.tokens).toBeLessThanOrEqual(128);
    expect(budgeted.peek.tokens).toBeLessThanOrEqual(128);
    expect(budgeted.exactSearchSnippetBaseline.tokens).toBeLessThanOrEqual(128);
    expect(budgeted.exactSearchSnippetBaseline.evidenceRecall).toBe(0);
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
    ]).filter(Boolean);

    for (const value of sensitiveFixtureValues) {
      expect(serialized).not.toContain(value);
    }
  });
});
