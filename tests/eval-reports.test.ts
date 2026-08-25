import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { createSummaryMarkdown, loadSummary } from "../src/eval/reports.js";

describe("eval reports", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads legacy summaries without context efficiency metrics", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-reports-"));
    const source = JSON.parse(
      readFileSync("benchmarks/baselines/eval-baseline-summary.json", "utf-8"),
    ) as { metrics: Record<string, unknown> };
    delete source.metrics.contextEfficiency;
    const summaryPath = path.join(tempDir, "legacy-summary.json");
    writeFileSync(summaryPath, JSON.stringify(source), "utf-8");

    const summary = loadSummary(summaryPath);

    expect(summary.metrics.contextEfficiency).toEqual({
      queryCount: 0,
      responseTokens: { total: 0, average: 0, p95: 0, max: 0 },
      duplicateCandidateRatio: 0,
      selectedFileRatio: 0,
      hitAt5Per1kResponseTokens: 0,
      mrrAt10Per1kResponseTokens: 0,
    });
    const markdown = createSummaryMarkdown(summary);
    expect(markdown).toContain("Context response tokens total");
    expect(markdown).toContain("Context response tokens max");
    expect(markdown).toContain("| Graph-neighbor recall | 0.0000 |");
  });

  it("reports measured graph-neighbor recall", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-reports-"));
    const source = JSON.parse(
      readFileSync("benchmarks/baselines/eval-baseline-summary.json", "utf-8"),
    ) as { metrics: Record<string, unknown> };
    source.metrics.graphNeighborRecall = 0.5;
    source.metrics.retrievalModeCounts = {
      search: 30,
      context: 7,
      "edit-context": 3,
      architecture: 4,
    };
    const summaryPath = path.join(tempDir, "summary.json");
    writeFileSync(summaryPath, JSON.stringify(source), "utf-8");
    const summary = loadSummary(summaryPath);

    expect(createSummaryMarkdown(summary)).toContain("| Graph-neighbor recall | 0.5000 |");
    expect(createSummaryMarkdown(summary)).toContain("## Retrieval Mode Distribution");
    expect(createSummaryMarkdown(summary)).toContain("| search | 30 |");
    expect(createSummaryMarkdown(summary)).toContain("| context | 7 |");
    expect(createSummaryMarkdown(summary)).toContain("| edit-context | 3 |");
    expect(createSummaryMarkdown(summary)).toContain("| architecture | 4 |");
  });
});
