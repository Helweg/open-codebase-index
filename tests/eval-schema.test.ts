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
            language: "typescript",
            difficulty: "easy",
            tags: ["definition", "typescript"],
            args: {
              symbol: "rankHybridResults",
              fileType: "ts",
              directory: "src/indexer",
            },
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
    expect(dataset.queries[0]?.difficulty).toBe("easy");
    expect(dataset.queries[0]?.tags).toEqual(["definition", "typescript"]);
    expect(dataset.queries[0]?.args?.symbol).toBe("rankHybridResults");
    expect(dataset.queries[0]?.args?.fileType).toBe("ts");
    expect(dataset.queries[0]?.args?.directory).toBe("src/indexer");
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

  it("parses architecture planning queries with bounded depth and token cost", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "architecture-context",
        queries: [{
          id: "architecture-map",
          query: "map the indexing and retrieval architecture before planning a change",
          queryType: "architecture",
          retrievalMode: "architecture",
          args: {
            directory: "src/indexer",
            depth: 3,
            tokenBudget: 900,
          },
          expected: {
            gradedEvidence: [{ path: "src/indexer/index.ts", symbol: "Indexer", relevance: 3 }],
          },
        }],
      },
      "dataset.json",
    );

    expect(dataset.queries[0]).toMatchObject({
      queryType: "architecture",
      retrievalMode: "architecture",
      args: { directory: "src/indexer", depth: 3, tokenBudget: 900 },
    });
  });

  it("rejects architecture depth above the public tool limit", () => {
    expect(() => parseGoldenDataset(
      {
        version: "1.0.0",
        name: "invalid-architecture",
        queries: [{
          id: "architecture-map",
          query: "map the architecture",
          queryType: "architecture",
          retrievalMode: "architecture",
          args: { depth: 4 },
          expected: { filePath: "src/indexer/index.ts" },
        }],
      },
      "dataset.json",
    )).toThrow(/args\.depth must be at most 3/);
  });

  it("parses edit-context queries with a direct graph-neighbor expectation", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "pre-edit-context",
        queries: [
          {
            id: "q1",
            query: "change rankHybridResults",
            queryType: "definition",
            retrievalMode: "edit-context",
            args: {
              symbol: "rankHybridResults",
              filePath: "src/indexer/index.ts",
              callerLimit: 2,
              calleeLimit: 3,
              tokenBudget: 512,
            },
            expected: {
              filePath: "src/indexer/index.ts",
              symbol: "rankHybridResults",
              graphNeighbor: {
                direction: "caller",
                filePath: "src/eval/runner.ts",
                symbol: "runEvaluation",
              },
            },
          },
        ],
      },
      "dataset.json",
    );

    expect(dataset.queries[0]).toMatchObject({
      retrievalMode: "edit-context",
      args: {
        filePath: "src/indexer/index.ts",
        callerLimit: 2,
        calleeLimit: 3,
        tokenBudget: 512,
      },
      expected: {
        graphNeighbor: {
          direction: "caller",
          filePath: "src/eval/runner.ts",
          symbol: "runEvaluation",
        },
      },
    });
  });

  it("rejects graph-neighbor expectations without a path or symbol", () => {
    expect(() => parseGoldenDataset(
      {
        version: "1.0.0",
        name: "invalid-edit-context",
        queries: [{
          id: "q1",
          query: "change rankHybridResults",
          queryType: "definition",
          retrievalMode: "edit-context",
          expected: {
            filePath: "src/indexer/index.ts",
            graphNeighbor: { direction: "caller" },
          },
        }],
      },
      "dataset.json",
    )).toThrow(/graphNeighbor.*filePath or symbol/);
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
    )).toThrow(/retrievalMode.*search, context, edit-context, architecture/);
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
    ).toThrow(/expected.filePath, expected.acceptableFiles, or expected.gradedEvidence/);
  });

  it("parses no-results expected outcomes without explicit evidence", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "negative",
        queries: [
          {
            id: "q1",
            query: "no such symbol exists",
            queryType: "definition",
            expected: {
              expectedOutcome: "no-results",
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.queries[0]?.expected.expectedOutcome).toBe("no-results");
  });

  it("rejects invalid difficulty values", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "invalid",
          queries: [
            {
              id: "q1",
              query: "where",
              queryType: "conceptual",
              difficulty: "extreme",
              expected: {
                filePath: "src/index.ts",
              },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/must be one of: easy, medium, hard/);
  });

  it("rejects invalid recovery expectations", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "invalid",
          queries: [
            {
              id: "q1",
              query: "where",
              queryType: "conceptual",
              expected: {
                filePath: "src/index.ts",
                recoveryExpectation: "unknown",
              },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/must be one of: none, filter-relaxed/);
  });

  it("accepts graded evidence-only expected entries", () => {
    const dataset = parseGoldenDataset(
      {
        version: "1.0.0",
        name: "graded-evidence",
        queries: [
          {
            id: "q1",
            query: "where is rankHybridResults implementation",
            queryType: "definition",
            expected: {
              gradedEvidence: [
                {
                  path: "src/indexer/index.ts",
                  symbol: "rankHybridResults",
                  relevance: 3,
                },
              ],
            },
          },
        ],
      },
      "dataset.json"
    );

    expect(dataset.queries[0]?.expected.gradedEvidence?.[0]).toEqual({
      path: "src/indexer/index.ts",
      symbol: "rankHybridResults",
      relevance: 3,
    });
  });

  it("parses nested filters and permits evidence-free no-result expectations", () => {
    const dataset = parseGoldenDataset({
      version: "2.0.0",
      name: "negative-filter",
      queries: [{
        id: "q1",
        query: "missing symbol",
        queryType: "definition",
        language: "typescript",
        difficulty: "hard",
        tags: ["negative", "filter"],
        args: { symbol: "missing", fileType: "ts", directory: "missing/path" },
        expected: { expectedOutcome: "no-results" },
      }],
    }, "dataset.json");

    expect(dataset.queries[0]).toMatchObject({
      args: { symbol: "missing", fileType: "ts", directory: "missing/path" },
      difficulty: "hard",
    });
  });

  it("rejects invalid difficulty and unbounded tags", () => {
    const base = {
      version: "2.0.0",
      name: "invalid-axes",
      queries: [{
        id: "q1",
        query: "query",
        queryType: "conceptual",
        expected: { filePath: "src/index.ts" },
      }],
    };
    expect(() => parseGoldenDataset({
      ...base,
      queries: [{ ...base.queries[0], difficulty: "extreme" }],
    }, "dataset.json")).toThrow(/difficulty.*easy, medium, hard/);
    expect(() => parseGoldenDataset({
      ...base,
      queries: [{ ...base.queries[0], tags: Array.from({ length: 17 }, (_, i) => `tag-${i}`) }],
    }, "dataset.json")).toThrow(/at most 16 tags/);
  });

  it("rejects invalid gradedEvidence entries", () => {
    expect(() =>
      parseGoldenDataset(
        {
          version: "1.0.0",
          name: "invalid",
          queries: [
            {
              id: "q1",
              query: "where",
              queryType: "conceptual",
              expected: {
                gradedEvidence: [{ path: 42, symbol: "rankHybridResults" }],
              },
            },
          ],
        },
        "dataset.json"
      )
    ).toThrow(/0\] must be an object|must be a non-empty string/i);
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
          minRouteAccuracy: 0.95,
          minOutcomeAccuracy: 0.85,
          maxContextResponseTokensAverage: 800,
          maxContextResponseTokensP95: 1200,
          maxContextResponseTokensMax: 1200,
          maxContextDuplicateCandidateRatio: 0.25,
          minContextSelectedFileRatio: 0.5,
          minContextHitAt5Per1kResponseTokens: 0.5,
          minContextMrrAt10Per1kResponseTokens: 0.25,
        },
      },
      "budget.json"
    );

    expect(budget.thresholds.hitAt5MaxDrop).toBe(0.05);
    expect(budget.thresholds.rawDistinctTop3RatioMaxDrop).toBe(0.1);
    expect(budget.thresholds.minRawDistinctTop3Ratio).toBe(0.7);
    expect(budget.thresholds.minRouteAccuracy).toBe(0.95);
    expect(budget.thresholds.minOutcomeAccuracy).toBe(0.85);
    expect(budget.thresholds.maxContextResponseTokensAverage).toBe(800);
    expect(budget.thresholds.maxContextResponseTokensP95).toBe(1200);
    expect(budget.thresholds.maxContextResponseTokensMax).toBe(1200);
    expect(budget.thresholds.maxContextDuplicateCandidateRatio).toBe(0.25);
    expect(budget.thresholds.minContextSelectedFileRatio).toBe(0.5);
    expect(budget.thresholds.minContextHitAt5Per1kResponseTokens).toBe(0.5);
    expect(budget.thresholds.minContextMrrAt10Per1kResponseTokens).toBe(0.25);
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
