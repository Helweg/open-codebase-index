import { describe, it, expect } from "vitest";
import {
  formatIndexStats,
  formatStatus,
  formatProgressTitle,
  calculatePercentage,
  formatCodebasePeek,
  formatHealthCheck,
  formatLogs,
  formatSearchResults,
  buildContextPack,
  countContextTokens,
  fitTextToContextBudget,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
  MAX_CONTEXT_PACK_TOKEN_BUDGET,
} from "../src/tools/utils.js";
import type { IndexStats, IndexProgress, SearchResult, HealthCheckResult, StatusResult } from "../src/indexer/index.js";
import type { LogEntry } from "../src/utils/logger.js";

function createBaseStats(overrides: Partial<IndexStats> = {}): IndexStats {
  return {
    totalFiles: 0,
    totalChunks: 0,
    indexedChunks: 0,
    failedChunks: 0,
    tokensUsed: 0,
    durationMs: 0,
    existingChunks: 0,
    removedChunks: 0,
    skippedFiles: [],
    parseFailures: [],
    failedBatchesPath: undefined,
    ...overrides,
  };
}

describe("tools utils", () => {
  describe("formatIndexStats", () => {
    it("should show up-to-date message when nothing changed", () => {
      const stats = createBaseStats({ totalFiles: 50, existingChunks: 200 });
      const result = formatIndexStats(stats);

      expect(result).toContain("50 files processed");
      expect(result).toContain("200 code chunks already up to date");
    });

    it("should show removal message when only chunks removed", () => {
      const stats = createBaseStats({ totalFiles: 10, removedChunks: 5, existingChunks: 15 });
      const result = formatIndexStats(stats);

      expect(result).toContain("removed 5 stale chunks");
      expect(result).toContain("15 chunks remain");
    });

    it("should show new chunks embedded", () => {
      const stats = createBaseStats({
        totalFiles: 20,
        indexedChunks: 30,
        tokensUsed: 5000,
        durationMs: 2500,
      });
      const result = formatIndexStats(stats);

      expect(result).toContain("30 new chunks embedded");
      expect(result).toContain("5,000");
      expect(result).toContain("2.5s");
    });

    it("should show existing chunks skipped alongside new chunks", () => {
      const stats = createBaseStats({ totalFiles: 20, indexedChunks: 10, existingChunks: 40, tokensUsed: 1000, durationMs: 1000 });
      const result = formatIndexStats(stats);

      expect(result).toContain("10 new chunks embedded");
      expect(result).toContain("40 unchanged chunks skipped");
    });

    it("should show removed chunks when new chunks were also embedded", () => {
      const stats = createBaseStats({ totalFiles: 20, indexedChunks: 5, removedChunks: 3, tokensUsed: 500, durationMs: 500 });
      const result = formatIndexStats(stats);

      expect(result).toContain("Removed 3 stale chunks");
    });

    it("should show failed chunks", () => {
      const stats = createBaseStats({ totalFiles: 10, indexedChunks: 5, failedChunks: 2, tokensUsed: 500, durationMs: 500 });
      const result = formatIndexStats(stats);

      expect(result).toContain("Failed: 2 chunks");
    });

    it("should highlight failed batch path when chunks fail", () => {
      const stats = createBaseStats({
        totalFiles: 10,
        indexedChunks: 5,
        failedChunks: 2,
        failedBatchesPath: "/tmp/failed-batches.json",
        tokensUsed: 500,
        durationMs: 500,
      });
      const result = formatIndexStats(stats);

      expect(result).toContain("INDEXING WARNING");
      expect(result).toContain("/tmp/failed-batches.json");
    });

    it("should surface corrupted index reset guidance instead of a success summary", () => {
      const stats = createBaseStats({
        totalFiles: 10,
        indexedChunks: 5,
        removedChunks: 2,
        resetCorruptedIndex: true,
        warning: "Detected a corrupted local SQLite index and reset the local index. Run index_codebase to rebuild search data.",
      });
      const result = formatIndexStats(stats);

      expect(result).toContain("corrupted local SQLite index");
      expect(result).toContain("Run index_codebase to rebuild search data");
      expect(result).not.toContain("5 new chunks embedded");
    });

    it("should not include verbose details by default", () => {
      const stats = createBaseStats({
        totalFiles: 10,
        indexedChunks: 5,
        tokensUsed: 500,
        durationMs: 500,
        skippedFiles: [{ path: "big.js", reason: "too_large" }],
        parseFailures: ["empty.ts"],
      });
      const result = formatIndexStats(stats);

      expect(result).not.toContain("Skipped files");
      expect(result).not.toContain("big.js");
      expect(result).not.toContain("no extractable chunks");
    });

    it("should include verbose skipped file details", () => {
      const stats = createBaseStats({
        totalFiles: 10,
        indexedChunks: 5,
        tokensUsed: 500,
        durationMs: 500,
        skippedFiles: [
          { path: "big.js", reason: "too_large" },
          { path: "vendor.js", reason: "excluded" },
          { path: ".env", reason: "gitignore" },
        ],
      });
      const result = formatIndexStats(stats, true);

      expect(result).toContain("Skipped files: 3");
      expect(result).toContain("Too large (1)");
      expect(result).toContain("big.js");
      expect(result).toContain("Excluded (1)");
      expect(result).toContain("vendor.js");
      expect(result).toContain("Gitignored (1)");
      expect(result).toContain(".env");
    });

    it("should include verbose parse failures", () => {
      const stats = createBaseStats({
        totalFiles: 5,
        indexedChunks: 3,
        tokensUsed: 300,
        durationMs: 300,
        parseFailures: ["empty.ts", "broken.js"],
      });
      const result = formatIndexStats(stats, true);

      expect(result).toContain("no extractable chunks (2)");
      expect(result).toContain("empty.ts");
      expect(result).toContain("broken.js");
    });
  });

  describe("formatStatus", () => {
    it("should return not-indexed message when not indexed", () => {
      const status: StatusResult = {
        indexed: false,
        vectorCount: 0,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: null,
        failedBatchesCount: 0,
        failedBatchesPath: undefined,
      };
      const result = formatStatus(status);

      expect(result).toContain("not indexed");
      expect(result).toContain("Run index_codebase");
    });

    it("should show basic status for indexed codebase on default branch", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 500,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: { compatible: true },
        failedBatchesCount: 0,
        failedBatchesPath: undefined,
      };
      const result = formatStatus(status);

      expect(result).toContain("500");
      expect(result).toContain("openai");
      expect(result).toContain("text-embedding-3-small");
      expect(result).toContain("/tmp/index");
      expect(result).not.toContain("Current branch");
      expect(result).toContain("compatible");
    });

    it("should show branch info when not on default branch", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "github-copilot",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "feature-x",
        baseBranch: "main",
        compatibility: { compatible: true },
        failedBatchesCount: 0,
        failedBatchesPath: undefined,
      };
      const result = formatStatus(status);

      expect(result).toContain("Current branch: feature-x");
      expect(result).toContain("Base branch: main");
    });

    it("should show compatibility warning when incompatible", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: {
          compatible: false,
          reason: "Dimension mismatch",
          storedMetadata: {
            indexVersion: "1",
            embeddingProvider: "google",
            embeddingModel: "text-embedding-004",
            embeddingDimensions: 768,
            createdAt: "2025-01-01",
            updatedAt: "2025-01-01",
          },
        },
        failedBatchesCount: 0,
        failedBatchesPath: undefined,
      };
      const result = formatStatus(status);

      expect(result).toContain("COMPATIBILITY WARNING");
      expect(result).toContain("Dimension mismatch");
      expect(result).toContain("google/text-embedding-004");
      expect(result).toContain("768D");
    });

    it("should show no-compatibility-info message when compatibility is null", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "openai",
        model: "text-embedding-3-small",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: null,
        failedBatchesCount: 0,
        failedBatchesPath: undefined,
      };
      const result = formatStatus(status);

      expect(result).toContain("No compatibility information found");
    });

    it("should surface failed batches when index is not yet usable", () => {
      const status: StatusResult = {
        indexed: false,
        vectorCount: 0,
        provider: "google",
        model: "gemini-embedding-001",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: null,
        failedBatchesCount: 2,
        failedBatchesPath: "/tmp/index/failed-batches.json",
      };
      const result = formatStatus(status);

      expect(result).toContain("failed embedding batches");
      expect(result).toContain("/tmp/index/failed-batches.json");
    });

    it("should surface startup reset guidance before generic not-indexed messaging", () => {
      const status: StatusResult = {
        indexed: false,
        vectorCount: 0,
        provider: "google",
        model: "gemini-embedding-001",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: null,
        failedBatchesCount: 0,
        failedBatchesPath: undefined,
        warning: "Detected a corrupted local SQLite index at /tmp/index/codebase.db and reset the local index. Run index_codebase to rebuild search data.",
      };
      const result = formatStatus(status);

      expect(result).toContain("corrupted local SQLite index");
      expect(result).toContain("Run index_codebase to rebuild search data");
      expect(result).not.toContain("Codebase is not indexed");
    });

    it("should warn when indexed data exists alongside failed batches", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "google",
        model: "gemini-embedding-001",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: { compatible: true },
        failedBatchesCount: 1,
        failedBatchesPath: "/tmp/index/failed-batches.json",
      };
      const result = formatStatus(status);

      expect(result).toContain("INDEXING WARNING");
      expect(result).toContain("failed-batches.json");
    });

    it("should surface a degraded reader warning while semantic data remains usable", () => {
      const status: StatusResult = {
        indexed: true,
        vectorCount: 100,
        provider: "google",
        model: "gemini-embedding-001",
        indexPath: "/tmp/index",
        currentBranch: "default",
        baseBranch: "default",
        compatibility: { compatible: true },
        failedBatchesCount: 0,
        warning: "Keyword index could not be read; semantic search remains available. Run index_codebase to repair it under the writer lease.",
      };
      const result = formatStatus(status);

      expect(result).toContain("Indexed chunks: 100");
      expect(result).toContain("INDEX WARNING");
      expect(result).toContain("semantic search remains available");
    });
  });

  describe("formatProgressTitle", () => {
    it("should format scanning phase", () => {
      expect(formatProgressTitle({ phase: "scanning", filesProcessed: 0, totalFiles: 0, chunksProcessed: 0, totalChunks: 0 })).toBe("Scanning files...");
    });

    it("should format parsing phase with counts", () => {
      expect(formatProgressTitle({ phase: "parsing", filesProcessed: 5, totalFiles: 20, chunksProcessed: 0, totalChunks: 0 })).toBe("Parsing: 5/20 files");
    });

    it("should format embedding phase with counts", () => {
      expect(formatProgressTitle({ phase: "embedding", filesProcessed: 20, totalFiles: 20, chunksProcessed: 30, totalChunks: 100 })).toBe("Embedding: 30/100 chunks");
    });

    it("should format storing phase", () => {
      expect(formatProgressTitle({ phase: "storing", filesProcessed: 20, totalFiles: 20, chunksProcessed: 100, totalChunks: 100 })).toBe("Storing index...");
    });

    it("should format complete phase", () => {
      expect(formatProgressTitle({ phase: "complete", filesProcessed: 20, totalFiles: 20, chunksProcessed: 100, totalChunks: 100 })).toBe("Indexing complete");
    });
  });

  describe("calculatePercentage", () => {
    const progress = (phase: IndexProgress["phase"], opts: Partial<IndexProgress> = {}): IndexProgress => ({
      phase,
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
      ...opts,
    });

    it("should return 0 for scanning", () => {
      expect(calculatePercentage(progress("scanning"))).toBe(0);
    });

    it("should return 100 for complete", () => {
      expect(calculatePercentage(progress("complete"))).toBe(100);
    });

    it("should return 5 for parsing with zero total files", () => {
      expect(calculatePercentage(progress("parsing", { totalFiles: 0 }))).toBe(5);
    });

    it("should calculate parsing percentage in 5-20 range", () => {
      const result = calculatePercentage(progress("parsing", { filesProcessed: 5, totalFiles: 10 }));
      expect(result).toBeGreaterThanOrEqual(5);
      expect(result).toBeLessThanOrEqual(20);
    });

    it("should return 20 at end of parsing", () => {
      expect(calculatePercentage(progress("parsing", { filesProcessed: 10, totalFiles: 10 }))).toBe(20);
    });

    it("should return 20 for embedding with zero total chunks", () => {
      expect(calculatePercentage(progress("embedding", { totalChunks: 0 }))).toBe(20);
    });

    it("should calculate embedding percentage in 20-90 range", () => {
      const result = calculatePercentage(progress("embedding", { chunksProcessed: 50, totalChunks: 100 }));
      expect(result).toBeGreaterThanOrEqual(20);
      expect(result).toBeLessThanOrEqual(90);
    });

    it("should return 90 at end of embedding", () => {
      expect(calculatePercentage(progress("embedding", { chunksProcessed: 100, totalChunks: 100 }))).toBe(90);
    });

    it("should return 95 for storing", () => {
      expect(calculatePercentage(progress("storing"))).toBe(95);
    });
  });

  describe("formatCodebasePeek", () => {
    it("should return empty message for no results", () => {
      const result = formatCodebasePeek([]);

      expect(result).toContain("No matching code found");
    });

    it("should format results with names", () => {
      const results: SearchResult[] = [{
        filePath: "src/index.ts",
        startLine: 10,
        endLine: 20,
        content: "",
        score: 0.85,
        chunkType: "function",
        name: "initialize",
      }];
      const result = formatCodebasePeek(results);

      expect(result).toContain('"initialize"');
      expect(result).toContain("src/index.ts:10-20");
      expect(result).toContain("0.85");
      expect(result).toContain("function");
    });

    it("should format results without names as anonymous", () => {
      const results: SearchResult[] = [{
        filePath: "src/utils.ts",
        startLine: 1,
        endLine: 5,
        content: "",
        score: 0.70,
        chunkType: "other",
      }];
      const result = formatCodebasePeek(results);

      expect(result).toContain("(anonymous)");
    });

    it("should include query in output", () => {
      const results: SearchResult[] = [{
        filePath: "a.ts",
        startLine: 1,
        endLine: 2,
        content: "",
        score: 0.5,
        chunkType: "function",
        name: "foo",
      }];
      const result = formatCodebasePeek(results);

      expect(result).toContain('"foo"');
      expect(result).toContain("a.ts:1-2");
      expect(result).toContain("0.5");
    });

    it("should include git blame annotation when present", () => {
      const result = formatCodebasePeek([{
        filePath: "src/auth.ts",
        startLine: 45,
        endLine: 67,
        content: "",
        score: 0.92,
        chunkType: "function",
        name: "validateSession",
        blame: {
          sha: "abc123456789",
          author: "Jane Doe",
          authorEmail: "jane@example.com",
          committedAt: 1741953600,
          summary: "auth: add session validation",
        },
      }]);

      expect(result).toContain("abc1234 | Jane Doe | 2025-03-14 | auth: add session validation");
    });

    it("adds a bounded, deduplicated exact-search handoff from named results", () => {
      const results: SearchResult[] = ["first", "first", "second", "third", "fourth"].map((name, index) => ({
        filePath: `src/${index}.ts`,
        startLine: 1,
        endLine: 2,
        content: "",
        score: 1 - index / 10,
        chunkType: "function",
        name,
      }));

      const result = formatCodebasePeek(results);

      expect(result).toContain('Exact-search handoff: use exact grep/search for "first", "second", "third"');
      expect(result).not.toContain('grep/search for "first", "second", "third", "fourth"');
    });

    it("omits anonymous and overlong names while safely quoting exact names", () => {
      const anonymous = formatCodebasePeek([{
        filePath: "src/anonymous.ts",
        startLine: 1,
        endLine: 2,
        content: "",
        score: 1,
        chunkType: "other",
      }]);
      const overlongName = `${"x".repeat(100)}dangerous`;
      const unsafeName = `dangerous\"\nrm example`;
      const named = formatCodebasePeek([{
        filePath: "src/named.ts",
        startLine: 1,
        endLine: 2,
        content: "",
        score: 1,
        chunkType: "function",
        name: overlongName,
      }, {
        filePath: "src/short.ts",
        startLine: 3,
        endLine: 4,
        content: "",
        score: 0.9,
        chunkType: "function",
        name: unsafeName,
      }]);
      const handoff = named.split("\n\n").at(-1) ?? "";

      expect(anonymous).not.toContain("Exact-search handoff");
      expect(handoff).toContain("Exact-search handoff");
      expect(handoff).toContain("\\n");
      expect(handoff).not.toContain(overlongName);
      expect(handoff).toContain(JSON.stringify(unsafeName));
    });
  });

  describe("formatHealthCheck", () => {
    it("should show corruption reset warning when health check reset the local index", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
        resetCorruptedIndex: true,
        warning: "Detected a corrupted local SQLite index and reset the local index.",
      });

      expect(result).toContain("corrupted local SQLite index");
      expect(result).toContain("reset the local index");
    });

    it("should return healthy message when nothing to clean", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
      });

      expect(result).toBe("Index is healthy. No stale entries found.");
    });

    it("should show removed stale entries", () => {
      const result = formatHealthCheck({
        removed: 5,
        filePaths: ["src/old.ts", "src/deleted.ts"],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
      });

      expect(result).toContain("Removed stale entries: 5");
      expect(result).toContain("src/old.ts");
      expect(result).toContain("src/deleted.ts");
    });

    it("should show orphan embeddings", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 10,
        gcOrphanChunks: 0,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
      });

      expect(result).toContain("orphan embeddings: 10");
    });

    it("should show orphan chunks", () => {
      const result = formatHealthCheck({
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 3,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
      });

      expect(result).toContain("orphan chunks: 3");
    });

    it("should show all fields when all have values", () => {
      const result = formatHealthCheck({
        removed: 2,
        filePaths: ["a.ts"],
        gcOrphanEmbeddings: 5,
        gcOrphanChunks: 3,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
      });

      expect(result).toContain("Removed stale entries: 2");
      expect(result).toContain("orphan embeddings: 5");
      expect(result).toContain("orphan chunks: 3");
      expect(result).toContain("a.ts");
    });
  });

  describe("buildContextPack", () => {
    it("caps and validates token budgets", () => {
      const sampleResult: SearchResult = {
        filePath: "src/example.ts",
        startLine: 10,
        endLine: 20,
        content: "const ok = true;",
        score: 0.98,
        chunkType: "function",
        name: "example",
      };

      const tooSmall = buildContextPack([sampleResult], { tokenBudget: 1 });
      const tooLarge = buildContextPack([sampleResult], { tokenBudget: Number.MAX_SAFE_INTEGER });

      expect(tooSmall.tokenBudget).toBe(MIN_CONTEXT_PACK_TOKEN_BUDGET);
      expect(tooLarge.tokenBudget).toBe(MAX_CONTEXT_PACK_TOKEN_BUDGET);
      expect(tooSmall.results).toHaveLength(1);
      expect(tooSmall.tokenEstimate).toBe(countContextTokens(tooSmall.text));
      expect(tooSmall.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
    });

    it("deduplicates exact and overlapping same-file hits", () => {
      const results: SearchResult[] = [
        {
          filePath: "src/foo.ts",
          startLine: 10,
          endLine: 30,
          content: "a",
          score: 0.90,
          chunkType: "function",
          name: "outer",
        },
        {
          filePath: "src/foo.ts",
          startLine: 12,
          endLine: 18,
          content: "b",
          score: 0.95,
          chunkType: "function",
          name: "inner",
        },
        {
          filePath: "src/foo.ts",
          startLine: 40,
          endLine: 45,
          content: "c",
          score: 0.85,
          chunkType: "function",
          name: "later",
        },
        {
          filePath: "src/foo.ts",
          startLine: 10,
          endLine: 30,
          content: "d",
          score: 0.40,
          chunkType: "function",
          name: "exactDup",
        },
      ];

      const packed = buildContextPack(results, { tokenBudget: 2048 });
      expect(packed.results).toHaveLength(2);
      expect(packed.candidateCount).toBe(4);
      expect(packed.deduplicatedCount).toBe(2);
      expect(packed.duplicateCount).toBe(2);
      expect(packed.omittedCount).toBe(2);
      const names = packed.results.map((r) => r.name);
      expect(names).toEqual(["inner", "later"]);
      expect(names).not.toContain("overlap");
    });

    it("diversifies selection across files before taking additional same-file matches", () => {
      const results: SearchResult[] = [
        {
          filePath: "src/a.ts",
          startLine: 1,
          endLine: 10,
          content: "a1",
          score: 0.99,
          chunkType: "function",
          name: "a1",
        },
        {
          filePath: "src/a.ts",
          startLine: 20,
          endLine: 22,
          content: "a2",
          score: 0.95,
          chunkType: "function",
          name: "a2",
        },
        {
          filePath: "src/b.ts",
          startLine: 1,
          endLine: 8,
          content: "b1",
          score: 0.98,
          chunkType: "function",
          name: "b1",
        },
        {
          filePath: "src/c.ts",
          startLine: 1,
          endLine: 5,
          content: "c1",
          score: 0.97,
          chunkType: "function",
          name: "c1",
        },
      ];

      const packed = buildContextPack(results, { tokenBudget: 2048 });
      const names = packed.results.map((result) => result.name);
      expect(names).toEqual(["a1", "b1", "c1", "a2"]);
    });

    it("puts implementation files before docs and tests when source evidence is requested", () => {
      const results: SearchResult[] = [
        {
          filePath: "README.md",
          startLine: 1,
          endLine: 5,
          content: "docs",
          score: 0.99,
          chunkType: "other",
        },
        {
          filePath: "tests/feature.test.ts",
          startLine: 1,
          endLine: 8,
          content: "test",
          score: 0.98,
          chunkType: "function",
        },
        {
          filePath: "src/feature.ts",
          startLine: 10,
          endLine: 20,
          content: "implementation",
          score: 0.60,
          chunkType: "function",
          name: "implementFeature",
        },
      ];

      const packed = buildContextPack(results, {
        tokenBudget: 2048,
        preferImplementationPaths: true,
      });

      expect(packed.results.map((result) => result.filePath)).toEqual([
        "src/feature.ts",
        "README.md",
        "tests/feature.test.ts",
      ]);
    });

    it("puts source files ahead of benchmark artifacts when source evidence is requested", () => {
      const results: SearchResult[] = [
        {
          filePath: "crates/abc/benches/feature.rs",
          startLine: 1,
          endLine: 20,
          content: "benchmark",
          score: 0.99,
          chunkType: "function",
          name: "bench_impl",
        },
        {
          filePath: "src/feature.ts",
          startLine: 1,
          endLine: 30,
          content: "implementation",
          score: 0.60,
          chunkType: "function",
          name: "feature",
        },
      ];

      const packed = buildContextPack(results, {
        tokenBudget: 2048,
        preferImplementationPaths: true,
      });

      expect(packed.results.map((result) => result.filePath)).toEqual([
        "src/feature.ts",
        "crates/abc/benches/feature.rs",
      ]);
    });

    it("preserves score ordering when implementation preference is disabled", () => {
      const results: SearchResult[] = [
        {
          filePath: "README.md",
          startLine: 1,
          endLine: 5,
          content: "docs",
          score: 0.99,
          chunkType: "other",
        },
        {
          filePath: "src/feature.ts",
          startLine: 10,
          endLine: 20,
          content: "implementation",
          score: 0.60,
          chunkType: "function",
        },
      ];

      const packed = buildContextPack(results, { tokenBudget: 2048 });
      expect(packed.results.map((result) => result.filePath)).toEqual([
        "README.md",
        "src/feature.ts",
      ]);
    });

    it("is deterministic for identical input", () => {
      const results: SearchResult[] = [
        {
          filePath: "src/b.ts",
          startLine: 1,
          endLine: 3,
          content: "b",
          score: 0.88,
          chunkType: "function",
          name: "b",
        },
        {
          filePath: "src/a.ts",
          startLine: 2,
          endLine: 4,
          content: "a",
          score: 0.88,
          chunkType: "function",
          name: "a",
        },
      ];

      const first = buildContextPack(results, { tokenBudget: 2048 });
      const second = buildContextPack(results, { tokenBudget: 2048 });

      expect(first.text).toBe(second.text);
      expect(first.results).toEqual(second.results);
    });

    it("handles tiny budgets and still tracks omitted candidates when budget is tight", () => {
      const results: SearchResult[] = [
        {
          filePath: "src/foo.ts",
          startLine: 1,
          endLine: 2,
          content: "a",
          score: 0.99,
          chunkType: "function",
          name: "first",
        },
        {
          filePath: "src/foo.ts",
          startLine: 3,
          endLine: 4,
          content: "b",
          score: 0.98,
          chunkType: "function",
          name: "second",
        },
        {
          filePath: "src/foo.ts",
          startLine: 5,
          endLine: 6,
          content: "c",
          score: 0.97,
          chunkType: "function",
          name: "third",
        },
      ];

      const packed = buildContextPack(results, { tokenBudget: 1 });
      const maxBudget = packed.tokenBudget;
      expect(packed.results.length).toBeGreaterThan(0);
      expect(countContextTokens(packed.text)).toBeLessThanOrEqual(maxBudget);
    });

    it("adds a clear omitted-count footer when candidates are dropped", () => {
      const results: SearchResult[] = [
        {
          filePath: `/tmp/example/${"a".repeat(180)}/a.ts`,
          startLine: 1,
          endLine: 6,
          content: "a",
          score: 0.95,
          chunkType: "function",
          name: "a1",
        },
        {
          filePath: `/tmp/example/${"b".repeat(180)}/b.ts`,
          startLine: 1,
          endLine: 6,
          content: "b",
          score: 0.94,
          chunkType: "function",
          name: "b1",
        },
        {
          filePath: `/tmp/example/${"c".repeat(180)}/c.ts`,
          startLine: 1,
          endLine: 6,
          content: "c",
          score: 0.93,
          chunkType: "function",
          name: "c1",
        },
      ];

      const packed = buildContextPack(results, { tokenBudget: 1 });
      expect(packed.results.length + packed.omittedCount).toBe(results.length);
      expect(packed.text).toContain("omitted by token budget");
      expect(countContextTokens(packed.text)).toBeLessThanOrEqual(packed.tokenBudget);
    });

    it("honors maxResults and reports budget omissions separately from duplicates", () => {
      const results: SearchResult[] = Array.from({ length: 4 }, (_, index) => ({
        filePath: `src/file-${index}.ts`,
        startLine: 1,
        endLine: 5,
        content: `content-${index}`,
        score: 1 - index / 10,
        chunkType: "function",
        name: `symbol${index}`,
      }));

      const packed = buildContextPack(results, { tokenBudget: 2048, maxResults: 2 });

      expect(packed.selectedCount).toBe(2);
      expect(packed.duplicateCount).toBe(0);
      expect(packed.limitOmittedCount).toBe(2);
      expect(packed.budgetOmittedCount).toBe(0);
      expect(packed.omittedCount).toBe(2);
      expect(packed.text).toContain("excluded by result limit");
      expect(packed.text).not.toContain("omitted by token budget");
    });

    it("keeps worst-case headings and paths within the minimum budget", () => {
      const result: SearchResult = {
        filePath: `${"very-long-directory/".repeat(40)}implementation.ts`,
        startLine: 1,
        endLine: 999999,
        content: "full source must not appear",
        score: 0.99,
        chunkType: "function",
        name: "extremelyLongSymbolName".repeat(30),
      };

      const packed = buildContextPack([result], {
        tokenBudget: MIN_CONTEXT_PACK_TOKEN_BUDGET,
        heading: "Extremely long context heading ".repeat(30),
      });

      expect(packed.selectedCount).toBe(1);
      expect(packed.tokenEstimate).toBe(countContextTokens(packed.text));
      expect(packed.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
      expect(packed.text).not.toContain(result.content);
    });

    it("does not split Unicode surrogate pairs while compacting evidence", () => {
      const result: SearchResult = {
        filePath: `src/${"😀".repeat(160)}.ts`,
        startLine: 1,
        endLine: 2,
        content: "hidden",
        score: 1,
        chunkType: "function",
        name: "𐐷".repeat(100),
      };

      const packed = buildContextPack([result], { tokenBudget: 4000 });

      expect(Buffer.from(packed.text, "utf8").toString("utf8")).toBe(packed.text);
    });

    it("does not claim a result was selected when no evidence line fits", () => {
      const rareCharacter = String.fromCodePoint(0x10ffff);
      const result: SearchResult = {
        filePath: rareCharacter.repeat(300),
        startLine: 1,
        endLine: 2,
        content: "hidden",
        score: 1,
        chunkType: rareCharacter.repeat(100),
        name: rareCharacter.repeat(100),
      };

      const packed = buildContextPack([result], { tokenBudget: MIN_CONTEXT_PACK_TOKEN_BUDGET });

      expect(packed.selectedCount).toBe(0);
      expect(packed.results).toEqual([]);
      expect(packed.budgetOmittedCount).toBe(1);
      expect(packed.text).toContain("omitted by token budget");
      expect(packed.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
    });

    it("returns a bounded empty evidence pack", () => {
      const packed = buildContextPack([], { tokenBudget: MIN_CONTEXT_PACK_TOKEN_BUDGET });

      expect(packed.results).toEqual([]);
      expect(packed.candidateCount).toBe(0);
      expect(packed.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
    });

    it("includes exact-search handoffs only when requested and only for selected evidence", () => {
      const results: SearchResult[] = Array.from({ length: 4 }, (_, index) => ({
        filePath: `src/file-${index}.ts`,
        startLine: 1,
        endLine: 2,
        content: "hidden",
        score: 1 - index / 10,
        chunkType: "function",
        name: `symbol${index}`,
      }));

      const withoutHandoff = buildContextPack(results, { tokenBudget: 2048, maxResults: 2 });
      const withHandoff = buildContextPack(results, {
        tokenBudget: 2048,
        maxResults: 2,
        includeExactSearchHandoff: true,
      });

      expect(withoutHandoff.text).not.toContain("Exact-search handoff");
      expect(withHandoff.text).toContain('exact grep/search for "symbol0", "symbol1"');
      expect(withHandoff.text).not.toContain('"symbol2"');
      expect(withHandoff.tokenEstimate).toBe(countContextTokens(withHandoff.text));
    });

    it("accounts for the handoff while selecting evidence under the minimum token budget", () => {
      const results: SearchResult[] = Array.from({ length: 8 }, (_, index) => ({
        filePath: `src/${"long-directory/".repeat(4)}file-${index}.ts`,
        startLine: 1,
        endLine: 20,
        content: "hidden",
        score: 1 - index / 100,
        chunkType: "function",
        name: `exactSearchSymbol${index}`,
      }));

      const packed = buildContextPack(results, {
        tokenBudget: MIN_CONTEXT_PACK_TOKEN_BUDGET,
        includeExactSearchHandoff: true,
      });

      expect(packed.tokenEstimate).toBe(countContextTokens(packed.text));
      expect(packed.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
      expect(packed.results.length + packed.omittedCount).toBe(results.length);
      for (const result of packed.results) {
        expect(packed.text).toContain(result.name!.slice(-20));
      }
    });
  });

  describe("fitTextToContextBudget", () => {
    it("truncates long text without exceeding the effective budget", () => {
      const fitted = fitTextToContextBudget("x".repeat(5000), MIN_CONTEXT_PACK_TOKEN_BUDGET);

      expect(fitted.truncated).toBe(true);
      expect(fitted.tokenEstimate).toBe(countContextTokens(fitted.text));
      expect(fitted.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
      expect(fitted.text).toContain("truncated to context token budget");
    });

    it("enforces the budget with multilingual and emoji input", () => {
      const fitted = fitTextToContextBudget("😀 漢字 café مرحبا ".repeat(500), MIN_CONTEXT_PACK_TOKEN_BUDGET);

      expect(fitted.tokenEstimate).toBe(countContextTokens(fitted.text));
      expect(fitted.tokenEstimate).toBeLessThanOrEqual(MIN_CONTEXT_PACK_TOKEN_BUDGET);
    });
  });

  describe("formatLogs", () => {
    it("should return empty message for no logs", () => {
      const result = formatLogs([]);

      expect(result).toContain("No logs recorded yet");
    });

    it("should format log entries with timestamp, level, category, and message", () => {
      const logs: LogEntry[] = [{
        timestamp: "2025-01-15T10:00:00Z",
        level: "info",
        category: "search",
        message: "Query completed",
      }];
      const result = formatLogs(logs);

      expect(result).toContain("[2025-01-15T10:00:00Z]");
      expect(result).toContain("[INFO]");
      expect(result).toContain("[search]");
      expect(result).toContain("Query completed");
    });

    it("should include data as JSON when present", () => {
      const logs: LogEntry[] = [{
        timestamp: "2025-01-15T10:00:00Z",
        level: "debug",
        category: "embedding",
        message: "Batch sent",
        data: { batchSize: 10, tokensUsed: 500 },
      }];
      const result = formatLogs(logs);

      expect(result).toContain("[DEBUG]");
      expect(result).toContain('"batchSize":10');
      expect(result).toContain('"tokensUsed":500');
    });

    it("should format multiple log entries on separate lines", () => {
      const logs: LogEntry[] = [
        { timestamp: "T1", level: "info", category: "search", message: "First" },
        { timestamp: "T2", level: "warn", category: "gc", message: "Second" },
      ];
      const result = formatLogs(logs);
      const lines = result.split("\n");

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("First");
      expect(lines[1]).toContain("Second");
    });
  });

  describe("formatSearchResults", () => {
    it("should format results with names", () => {
      const results: SearchResult[] = [{
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        content: "function validateToken() {\n  return true;\n}",
        score: 0.92,
        chunkType: "function",
        name: "validateToken",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain('[1] function "validateToken" in src/auth.ts:10-25');
      expect(result).toContain("92.0%");
      expect(result).toContain("```");
      expect(result).toContain("function validateToken()");
    });

    it("should format results without names", () => {
      const results: SearchResult[] = [{
        filePath: "src/config.ts",
        startLine: 1,
        endLine: 3,
        content: "const x = 1;",
        score: 0.50,
        chunkType: "other",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain("[1] other in src/config.ts:1-3");
      expect(result).not.toContain('"null"');
    });

    it("should truncate content longer than 30 lines", () => {
      const longContent = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const results: SearchResult[] = [{
        filePath: "src/big.ts",
        startLine: 1,
        endLine: 50,
        content: longContent,
        score: 0.80,
        chunkType: "function",
        name: "bigFunction",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain("line 1");
      expect(result).toContain("line 30");
      expect(result).not.toContain("line 31");
      expect(result).toContain("20 more lines");
    });

    it("should not truncate content with exactly 30 lines", () => {
      const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
      const results: SearchResult[] = [{
        filePath: "src/exact.ts",
        startLine: 1,
        endLine: 30,
        content,
        score: 0.75,
        chunkType: "function",
        name: "exactFunction",
      }];
      const result = formatSearchResults(results);

      expect(result).toContain("line 30");
      expect(result).not.toContain("more lines");
    });

    it("should format multiple results with numbered indices", () => {
      const results: SearchResult[] = [
        { filePath: "a.ts", startLine: 1, endLine: 2, content: "a", score: 0.9, chunkType: "function", name: "first" },
        { filePath: "b.ts", startLine: 3, endLine: 4, content: "b", score: 0.8, chunkType: "class", name: "second" },
        { filePath: "c.ts", startLine: 5, endLine: 6, content: "c", score: 0.7, chunkType: "method", name: "third" },
      ];
      const result = formatSearchResults(results);

      expect(result).toContain("[1]");
      expect(result).toContain("[2]");
      expect(result).toContain("[3]");
      expect(result).toContain('"first"');
      expect(result).toContain('"second"');
      expect(result).toContain('"third"');
    });

    it("should use raw score format when scoreFormat is 'score'", () => {
      const results: SearchResult[] = [{
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        content: "function validateToken() {\n  return true;\n}",
        score: 0.85,
        chunkType: "function",
        name: "validateToken",
      }];
      const result = formatSearchResults(results, "score");

      expect(result).toContain("(score: 0.85)");
      expect(result).not.toContain("similarity");
      expect(result).not.toContain("%");
    });

    it("should use similarity percentage format when scoreFormat is 'similarity'", () => {
      const results: SearchResult[] = [{
        filePath: "src/auth.ts",
        startLine: 10,
        endLine: 25,
        content: "function validateToken() {\n  return true;\n}",
        score: 0.92,
        chunkType: "function",
        name: "validateToken",
      }];
      const result = formatSearchResults(results, "similarity");

      expect(result).toContain("(similarity: 92.0%)");
      expect(result).not.toContain("(score:");
    });

    it("should include git blame annotation with full search results", () => {
      const result = formatSearchResults([{
        filePath: "src/auth.ts",
        startLine: 45,
        endLine: 67,
        content: "export function validateSession() { return true; }",
        score: 0.92,
        chunkType: "function",
        name: "validateSession",
        blame: {
          sha: "abc123456789",
          author: "Jane Doe",
          authorEmail: "jane@example.com",
          committedAt: 1741953600,
          summary: "auth: add session validation",
        },
      }]);

      expect(result).toContain("abc1234 | Jane Doe | 2025-03-14 | auth: add session validation");
      expect(result).toContain("export function validateSession()");
    });
  });
});
