import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { loadBudget, loadGoldenDataset, parseBudget, parseGoldenDataset } from "../src/eval/schema.js";

describe("eval schema", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("parses a valid dataset", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "small",
        queries: [
          {
            id: "q1",
            query: "where is rankHybridResults implementation",
            queryType: "definition",
            expected: {
              filePath: "src/indexer/index.ts",
              symbol: "rankHybridResults",
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.name).toBe("small");
    expect(dataset.queries).toHaveLength(1);
    expect(dataset.queries[0]?.retrievalMode).toBe("search");
  });

  it("parses agent-facing context retrieval queries", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "agent-context",
        queries: [
          {
            id: "q1",
            query: "where is createMcpServer defined",
            queryType: "conceptual",
            retrievalMode: "context",
            expected: { filePath: "src/mcp-server.ts" },
          },
        ],
      },
      "dataset.json",
    );

    expect(dataset.queries[0]?.queryType).toBe("conceptual");
    expect(dataset.queries[0]?.retrievalMode).toBe("context");
  });

  it("rejects unknown retrieval modes", () => {
    expect(() => parseGoldenDataset(
      {
        version: "1.0.0",
        name: "invalid",
        queries: [
          {
            id: "q1",
            query: "where",
            queryType: "conceptual",
            retrievalMode: "magic",
            expected: { filePath: "src/index.ts" },
          },
        ],
      },
      "dataset.json",
    )).toThrow(/retrievalMode.*search, context/);
  });

  it("rejects dataset with missing expected path", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "where",
              queryType: "definition",
              expected: {},
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/expected.filePath or expected.acceptableFiles/);
  });

  it("rejects duplicate query ids", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "small",
          queries: [
            {
              id: "q1",
              query: "a",
              queryType: "definition",
              expected: { filePath: "a.ts" },
            },
            {
              id: "q1",
              query: "b",
              queryType: "definition",
              expected: { filePath: "b.ts" },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/duplicate id/);
  });

  it("parses budget and validates threshold types", () => {
    const budget = parseBudget(
      {
        name: "default",
        baselinePath: "benchmarks/baselines/eval-baseline-summary.json",
        failOnMissingBaseline: true,
        thresholds: {
          hitAt5MaxDrop: 0.05,
          mrrAt10MaxDrop: 0.02,
          rawDistinctTop3RatioMaxDrop: 0.1,
          p95LatencyMaxMultiplier: 1.5,
          minRawDistinctTop3Ratio: 0.7,
        },
      },
      "budget.json"
    );

    expect(budget.thresholds.hitAt5MaxDrop).toBe(0.05);
    expect(budget.thresholds.rawDistinctTop3RatioMaxDrop).toBe(0.1);
    expect(budget.thresholds.minRawDistinctTop3Ratio).toBe(0.7);
    expect(budget.failOnMissingBaseline).toBe(true);
  });

  it("rejects invalid threshold types", () => {
    expect(() =>
      parseBudget(
        {
          name: "default",
          thresholds: {
            rawDistinctTop3RatioMaxDrop: "bad",
          },
        },
        "budget.json"
      )
    ).toThrow(/must be a non-negative number/);
  });

  it("includes the dataset file path when JSON parsing fails", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-schema-"));
    const datasetPath = path.join(tempDir, "broken-dataset.json");
    writeFileSync(datasetPath, '{"version":"1.0.0",', "utf-8");

    expect(() => loadGoldenDataset(datasetPath)).toThrow(
      new RegExp(`Failed to parse JSON from ${datasetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });

  it("includes the budget file path when JSON parsing fails", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "eval-schema-"));
    const budgetPath = path.join(tempDir, "broken-budget.json");
    writeFileSync(budgetPath, '{"name":"default",', "utf-8");

    expect(() => loadBudget(budgetPath)).toThrow(
      new RegExp(`Failed to parse JSON from ${budgetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });
});
