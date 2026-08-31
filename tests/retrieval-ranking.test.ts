import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChunkMetadata } from "../src/native/index.js";
import {
  Indexer,
  extractFilePathHint,
  fuseResultsRrf,
  fuseResultsWeighted,
  rankSemanticOnlyResults,
  mergeTieredResults,
  rankHybridResults,
  selectChunksWithFileCoverage,
  selectIndexableChunks,
  stripFilePathHint,
  rerankResults,
} from "../src/indexer/index.js";
import { parseConfig } from "../src/config/schema.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";

type Candidate = { id: string; score: number; metadata: ChunkMetadata };

const tempDirs: string[] = [];

function meta(overrides: Partial<ChunkMetadata>): ChunkMetadata {
  return {
    filePath: "/repo/src/unknown.ts",
    startLine: 1,
    endLine: 10,
    chunkType: "other",
    language: "typescript",
    hash: "hash",
    ...overrides,
  };
}

function createTempFile(relativePath: string, content: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reranker-doc-"));
  tempDirs.push(tempDir);
  const filePath = path.join(tempDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("retrieval ranking", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("fuses hybrid results using RRF rank ordering", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.91, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "b", score: 0.89, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
      { id: "c", score: 0.88, metadata: meta({ filePath: "/repo/src/cache.ts", name: "readCache", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "d", score: 50, metadata: meta({ filePath: "/repo/src/auth-route.ts", name: "authRoute", chunkType: "function" }) },
      { id: "c", score: 30, metadata: meta({ filePath: "/repo/src/cache.ts", name: "readCache", chunkType: "function" }) },
      { id: "a", score: 1, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf(semantic, keyword, 60, 10);
    expect(fused.map(r => r.id).slice(0, 3)).toEqual(["a", "c", "d"]);
    expect(fused[0]?.score ?? 0).toBeLessThanOrEqual(1);
    expect(fused[0]?.score ?? 0).toBeGreaterThan(0);
  });

  it("keeps both semantic-only and keyword-only candidates in top fused results", () => {
    const semantic: Candidate[] = [
      { id: "semanticOnly", score: 0.95, metadata: meta({ filePath: "/repo/src/semantic.ts", name: "semanticBest", chunkType: "function" }) },
      { id: "both", score: 0.9, metadata: meta({ filePath: "/repo/src/both.ts", name: "bothCandidate", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "keywordOnly", score: 100, metadata: meta({ filePath: "/repo/src/keyword.ts", name: "keywordBest", chunkType: "function" }) },
      { id: "both", score: 1, metadata: meta({ filePath: "/repo/src/both.ts", name: "bothCandidate", chunkType: "function" }) },
    ];

    const fused = fuseResultsRrf(semantic, keyword, 60, 5);
    const top3 = fused.map(r => r.id).slice(0, 3);
    expect(top3[0]).toBe("both");
    expect(top3).toContain("semanticOnly");
    expect(top3).toContain("keywordOnly");
    for (const result of fused) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("reranks deterministically using name/path/chunk-type signals", () => {
    const candidates: Candidate[] = [
      { id: "generic", score: 0.9, metadata: meta({ filePath: "/repo/src/misc.ts", name: "handler", chunkType: "other" }) },
      { id: "pathOverlap", score: 0.9, metadata: meta({ filePath: "/repo/src/auth/handler.ts", name: "handler", chunkType: "other" }) },
      { id: "exactName", score: 0.9, metadata: meta({ filePath: "/repo/src/services/auth.ts", name: "auth", chunkType: "function" }) },
    ];

    const reranked = rerankResults("auth handler", candidates, 10);
    expect(reranked.map(r => r.id)).toEqual(["exactName", "pathOverlap", "generic"]);

    const rerankedAgain = rerankResults("auth handler", candidates, 10);
    expect(rerankedAgain.map(r => r.id)).toEqual(["exactName", "pathOverlap", "generic"]);
  });

  it("diversifies exploratory queries to avoid same-file duplicates dominating top results", () => {
    const candidates: Candidate[] = [
      { id: "fileA-1", score: 0.96, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "fileA-2", score: 0.95, metadata: meta({ filePath: "/repo/src/auth.ts", name: "refreshAuth", chunkType: "function" }) },
      { id: "fileB-1", score: 0.94, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
    ];

    const reranked = rerankResults("auth flow", candidates, 10);
    expect(reranked.map((candidate) => candidate.id).slice(0, 2)).toEqual(["fileA-1", "fileB-1"]);
  });

  it("treats same-symbol duplicates as lower priority before distinct symbols", () => {
    const candidates: Candidate[] = [
      { id: "same-symbol-1", score: 0.96, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "same-symbol-2", score: 0.95, metadata: meta({ filePath: "/repo/src/auth.ts", name: "validateAuth", chunkType: "function" }) },
      { id: "different-symbol", score: 0.94, metadata: meta({ filePath: "/repo/src/auth.ts", name: "refreshAuth", chunkType: "function" }) },
    ];

    const reranked = rerankResults("auth flow", candidates, 10);
    expect(reranked.map((candidate) => candidate.id).slice(0, 2)).toEqual(["same-symbol-1", "different-symbol"]);
  });

  it("does not diversify away exact-definition ranking for identifier queries", () => {
    const candidates: Candidate[] = [
      { id: "target", score: 0.96, metadata: meta({ filePath: "/repo/src/auth.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "same-file-secondary", score: 0.95, metadata: meta({ filePath: "/repo/src/auth.ts", name: "rankHybridResultsHelper", chunkType: "function" }) },
      { id: "other-file", score: 0.94, metadata: meta({ filePath: "/repo/src/session.ts", name: "loadSession", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults implementation", candidates, 10);
    expect(reranked.map((candidate) => candidate.id).slice(0, 2)).toEqual(["target", "same-file-secondary"]);
  });

  it("applies hybrid ranking path for search and semantic-only rerank for findSimilar", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.95, metadata: meta({ filePath: "/repo/src/auth.ts", name: "auth", chunkType: "function" }) },
      { id: "s2", score: 0.92, metadata: meta({ filePath: "/repo/src/util.ts", name: "helper", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 42, metadata: meta({ filePath: "/repo/src/routes/auth.ts", name: "authRoute", chunkType: "function" }) },
    ];

    const searchRanked = rankHybridResults("auth", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 5,
      limit: 5,
      hybridWeight: 0.5,
    });
    expect(searchRanked.some(r => r.id === "k1")).toBe(true);

    const similarRanked = rankSemanticOnlyResults("auth", semantic, {
      rerankTopN: 5,
      limit: 5,
    });
    expect(similarRanked.map(r => r.id)).not.toContain("k1");
  });

  it("returns pre-rerank order when rerankTopN is 0", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 0.92, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.90, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 0.88, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 80, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "x", score: 79, metadata: meta({ filePath: "/repo/src/x.ts", name: "x", chunkType: "function" }) },
    ];

    const preRerank = fuseResultsRrf(semantic, keyword, 60, 10);
    const ranked = rankHybridResults("query", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 0,
      limit: 10,
      hybridWeight: 0.5,
    });

    expect(ranked.map(r => r.id)).toEqual(preRerank.map(r => r.id));
  });

  it("supports weighted fusion strategy fallback", () => {
    const semantic: Candidate[] = [
      { id: "a", score: 1.0, metadata: meta({ filePath: "/repo/src/a.ts", name: "a", chunkType: "function" }) },
      { id: "b", score: 0.8, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "b", score: 4.0, metadata: meta({ filePath: "/repo/src/b.ts", name: "b", chunkType: "function" }) },
      { id: "c", score: 3.0, metadata: meta({ filePath: "/repo/src/c.ts", name: "c", chunkType: "function" }) },
    ];

    const weighted = fuseResultsWeighted(semantic, keyword, 0.5, 10);
    expect(weighted.map(r => r.id).slice(0, 2)).toEqual(["b", "c"]);
  });

  it("handles edge cases for disjoint and empty candidate sets", () => {
    const semantic: Candidate[] = [
      { id: "s1", score: 0.9, metadata: meta({ filePath: "/repo/src/s1.ts", name: "s1", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "k1", score: 2.5, metadata: meta({ filePath: "/repo/src/k1.ts", name: "k1", chunkType: "function" }) },
    ];

    const disjoint = fuseResultsRrf(semantic, keyword, 60, 10);
    expect(disjoint).toHaveLength(2);
    expect(disjoint.map(r => r.id)).toContain("s1");
    expect(disjoint.map(r => r.id)).toContain("k1");

    expect(fuseResultsRrf([], [], 60, 10)).toEqual([]);
    expect(rankSemanticOnlyResults("q", [], { rerankTopN: 10, limit: 5 })).toEqual([]);
  });

  it("prefers src implementation paths over tests/docs for implementation-intent queries", () => {
    const candidates: Candidate[] = [
      { id: "testCase", score: 0.92, metadata: meta({ filePath: "/repo/tests/retrieval-ranking.test.ts", name: "retrieval ranking", chunkType: "function" }) },
      { id: "readme", score: 0.92, metadata: meta({ filePath: "/repo/README.md", name: "retrieval docs", chunkType: "other" }) },
      { id: "srcImpl", score: 0.9, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults implementation", candidates, 10);
    expect(reranked[0]?.id).toBe("srcImpl");
  });

  it("keeps production evidence in the fused pool for identifier-rich keyword searches", () => {
    const testCandidates: Candidate[] = Array.from({ length: 60 }, (_value, index) => ({
      id: `test-${index}`,
      score: 1 - index / 1000,
      metadata: meta({
        filePath: `/repo/flag_groups_test_${index}.go`,
        name: `TestValidateFlagGroups${index}`,
        chunkType: "function_declaration",
      }),
    }));
    const source: Candidate = {
      id: "source",
      score: 0.5,
      metadata: meta({
        filePath: "/repo/flag_groups.go",
        name: "ValidateFlagGroups",
        chunkType: "function_declaration",
      }),
    };
    const candidates = [...testCandidates, source];

    const ranked = rankHybridResults(
      "MarkFlagsRequiredTogether MarkFlagsOneRequired ValidateFlagGroups",
      candidates,
      candidates,
      { fusionStrategy: "rrf", rrfK: 60, rerankTopN: 100, limit: 10, hybridWeight: 0.5 },
    );

    expect(ranked[0]?.id).toBe("source");
  });

  it("does not force src priority for doc/test-intent queries", () => {
    const candidates: Candidate[] = [
      { id: "srcImpl", score: 0.92, metadata: meta({ filePath: "/repo/stacks/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "readme", score: 0.9, metadata: meta({ filePath: "/repo/README.md", name: "retrieval docs", chunkType: "other" }) },
      { id: "testCase", score: 0.89, metadata: meta({ filePath: "/repo/tests/retrieval-ranking.test.ts", name: "retrieval test", chunkType: "function" }) },
    ];

    const reranked = rerankResults("README retrieval docs", candidates, 10);
    expect(reranked[0]?.id).toBe("readme");
  });

  it("prioritizes exact identifier hints for implementation-intent queries", () => {
    const candidates: Candidate[] = [
      { id: "noise1", score: 0.93, metadata: meta({ filePath: "/repo/native/src/lib.rs", name: "VectorStore", chunkType: "other" }) },
      { id: "noise2", score: 0.92, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "isRateLimitError", chunkType: "function" }) },
      { id: "target", score: 0.9, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults implementation", candidates, 10);
    expect(reranked[0]?.id).toBe("target");
  });

  it("promotes implementation symbol matches in hybrid ranking for identifier queries", () => {
    const semantic: Candidate[] = [
      { id: "noiseA", score: 0.96, metadata: meta({ filePath: "/repo/tests/fixtures/edge.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "noiseB", score: 0.95, metadata: meta({ filePath: "/repo/native/src/lib.rs", name: "VectorStore", chunkType: "other" }) },
      { id: "target", score: 0.84, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "target", score: 0.6, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "noiseA", score: 0.7, metadata: meta({ filePath: "/repo/tests/fixtures/edge.ts", name: "entryPoint", chunkType: "function" }) },
    ];

    const ranked = rankHybridResults("where is rankHybridResults implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 5,
      hybridWeight: 0.5,
    });

    expect(ranked[0]?.id).toBe("target");
  });

  it("keeps symbol-lane candidates ahead of hybrid lane in tiered merge", () => {
    const symbolLane: Candidate[] = [
      { id: "def1", score: 0.99, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "def2", score: 0.88, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rerankResults", chunkType: "function" }) },
    ];
    const hybridLane: Candidate[] = [
      { id: "noise", score: 1, metadata: meta({ filePath: "/repo/tests/fixtures/noise.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "def1", score: 0.7, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "other", score: 0.69, metadata: meta({ filePath: "/repo/stacks/search/pipeline.ts", name: "pipeline", chunkType: "function" }) },
    ];

    const merged = mergeTieredResults(symbolLane, hybridLane, 5);
    expect(merged.map((r) => r.id).slice(0, 2)).toEqual(["def1", "def2"]);
    expect(merged.map((r) => r.id)).toContain("noise");
  });

  it("preserves coverage across large files when enforcing a chunk limit", () => {
    const chunks = Array.from({ length: 201 }, (_, index) => index);

    const selected = selectChunksWithFileCoverage(chunks, 5);

    expect(selected).toEqual([0, 50, 100, 150, 200]);
  });

  it("handles whole-file chunk coverage edge cases", () => {
    expect(selectChunksWithFileCoverage([0, 1, 2], 5)).toEqual([0, 1, 2]);
    expect(selectChunksWithFileCoverage([0, 1, 2], 1)).toEqual([1]);
    expect(selectChunksWithFileCoverage([0, 1, 2], 0)).toEqual([]);
  });

  it("filters generic chunks before sampling a semantic-only file", () => {
    const chunks = [
      ...Array.from({ length: 100 }, (_, id) => ({ id: `other-${id}`, chunkType: "other" })),
      ...Array.from({ length: 10 }, (_, id) => ({ id: `function-${id}`, chunkType: "function" })),
    ];

    const selected = selectIndexableChunks(chunks, 5, true);

    expect(selected.map((chunk) => chunk.id)).toEqual([
      "function-0",
      "function-2",
      "function-5",
      "function-7",
      "function-9",
    ]);
  });

  it("builds fallback lane from implementation code-term hints when exact symbol names are unavailable", () => {
    const hybridLane: Candidate[] = [
      { id: "target", score: 0.65, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "buildSymbolDefinitionLane", chunkType: "function" }) },
      { id: "noise", score: 0.9, metadata: meta({ filePath: "/repo/tests/fixtures/call-graph/same-file-refs.ts", name: "entryPoint", chunkType: "function" }) },
    ];

    const symbolLane: Candidate[] = [
      { id: "target", score: 0.88, metadata: meta({ filePath: "/repo/app/indexer/index.ts", name: "buildSymbolDefinitionLane", chunkType: "function" }) },
    ];

    const merged = mergeTieredResults(symbolLane, hybridLane, 5);
    expect(merged[0]?.id).toBe("target");
  });

  it("prefers exact identifier implementation chunks over noisy fixture chunks", () => {
    const semantic: Candidate[] = [
      { id: "fixture", score: 0.96, metadata: meta({ filePath: "/repo/tests/fixtures/noise.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "bench", score: 0.95, metadata: meta({ filePath: "/repo/benchmarks/run.ts", name: "runBenchmarks", chunkType: "function" }) },
      { id: "target", score: 0.7, metadata: meta({ filePath: "/repo/app/indexer/system.ts", name: "createSystem", chunkType: "export" }) },
    ];
    const keyword: Candidate[] = [
      { id: "fixture", score: 0.9, metadata: meta({ filePath: "/repo/tests/fixtures/noise.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "target", score: 0.65, metadata: meta({ filePath: "/repo/app/indexer/system.ts", name: "createSystem", chunkType: "export" }) },
    ];

    const ranked = rankHybridResults("where is createSystem implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 5,
      hybridWeight: 0.5,
    });

    expect(ranked[0]?.id).toBe("target");
  });

  it("deterministically prefers exact name chunk even when fixture has higher base score", () => {
    const semantic: Candidate[] = [
      { id: "fixture", score: 0.98, metadata: meta({ filePath: "/repo/tests/fixtures/same-file-refs.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "target", score: 0.61, metadata: meta({ filePath: "/repo/packages/react/src/styled-system/system.ts", name: "createSystem", chunkType: "function" }) },
    ];
    const keyword: Candidate[] = [
      { id: "fixture", score: 0.97, metadata: meta({ filePath: "/repo/tests/fixtures/same-file-refs.ts", name: "entryPoint", chunkType: "function" }) },
      { id: "target", score: 0.62, metadata: meta({ filePath: "/repo/packages/react/src/styled-system/system.ts", name: "createSystem", chunkType: "function" }) },
    ];

    const ranked = rankHybridResults("where is createSystem implementation", semantic, keyword, {
      fusionStrategy: "rrf",
      rrfK: 60,
      rerankTopN: 20,
      limit: 5,
      hybridWeight: 0.5,
    });

    expect(ranked[0]?.id).toBe("target");
  });

  it("classifies implementation intent correctly with explicit implementation signal, and avoids over-routing doc/test phrasing", () => {
    const candidates: Candidate[] = [
      { id: "impl", score: 0.88, metadata: meta({ filePath: "/repo/src/indexer/system.ts", name: "createSystem", chunkType: "function" }) },
      { id: "bench", score: 0.92, metadata: meta({ filePath: "/repo/benchmarks/run.ts", name: "runBenchmarks", chunkType: "function" }) },
      { id: "tests", score: 0.9, metadata: meta({ filePath: "/repo/tests/system.test.ts", name: "createSystem test", chunkType: "function" }) },
    ];

    const implementationQuery = "where is createSystem implementation";
    const implementationReranked = rerankResults(implementationQuery, candidates, 10);
    expect(implementationReranked[0]?.id).toBe("impl");

    const docTestWeightedQueries = [
      "where is createSystem implementation benchmark test",
      "where is createSystem benchmark",
    ];
    for (const query of docTestWeightedQueries) {
      const reranked = rerankResults(query, candidates, 10);
      expect(reranked[0]?.id).not.toBe("impl");
    }
  });

  it("does not over-route doc phrasing with 'where is ... documentation' to source intent", () => {
    const candidates: Candidate[] = [
      { id: "impl", score: 0.91, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "rankHybridResults", chunkType: "function" }) },
      { id: "docs", score: 0.9, metadata: meta({ filePath: "/repo/README.md", name: "retrieval documentation", chunkType: "other" }) },
      { id: "tests", score: 0.89, metadata: meta({ filePath: "/repo/tests/retrieval.test.ts", name: "rankHybridResults test", chunkType: "function" }) },
    ];

    const reranked = rerankResults("where is rankHybridResults documentation", candidates, 10);
    expect(reranked[0]?.id).toBe("docs");
  });

  it("strongly prefers an exact authoritative symbol over imports, containers, tests, docs, and vendor copies", () => {
    const candidates: Candidate[] = [
      { id: "import", score: 0.99, metadata: meta({ filePath: "/repo/src/index.ts", name: "normalizeSession", chunkType: "import_statement", startLine: 1, endLine: 1, hash: "import" }) },
      { id: "container", score: 0.98, metadata: meta({ filePath: "/repo/src/session.ts", name: "normalizeSession", chunkType: "export_statement", startLine: 10, endLine: 24, hash: "container" }) },
      { id: "test", score: 0.97, metadata: meta({ filePath: "/repo/tests/session.test.ts", name: "normalizeSession", chunkType: "function", hash: "test" }) },
      { id: "docs", score: 0.96, metadata: meta({ filePath: "/repo/docs/session.md", name: "normalizeSession", chunkType: "other", hash: "docs" }) },
      { id: "vendor", score: 0.95, metadata: meta({ filePath: "/repo/vendor/session.ts", name: "normalizeSession", chunkType: "function", hash: "vendor" }) },
      { id: "definition", score: 0.72, metadata: meta({ filePath: "/repo/src/session.ts", name: "normalizeSession", chunkType: "function_declaration", startLine: 11, endLine: 24, hash: "definition" }) },
    ];

    const ranked = rerankResults("where is normalizeSession defined", candidates, candidates.length);
    expect(ranked[0]?.id).toBe("definition");
    expect(ranked.map((candidate) => candidate.id)).not.toContain("container");
  });

  it("matches identifiers with deterministic NFKC and case normalization", () => {
    const candidates: Candidate[] = [
      { id: "noise", score: 0.99, metadata: meta({ filePath: "/repo/src/noise.ts", name: "CafeServiceFactory", chunkType: "function", hash: "noise" }) },
      { id: "target", score: 0.6, metadata: meta({ filePath: "/repo/src/cafe.ts", name: "Cafe\u0301Service", chunkType: "class_declaration", hash: "target" }) },
    ];

    const ranked = rerankResults("where is CAFÉSERVICE implemented", candidates, candidates.length);
    expect(ranked[0]?.id).toBe("target");
  });

  it("uses explicit test, docs, config, and call-flow intent instead of always preferring source definitions", () => {
    const candidates: Candidate[] = [
      { id: "definition", score: 0.98, metadata: meta({ filePath: "/repo/src/session.ts", name: "resolveSession", chunkType: "function", hash: "definition" }) },
      { id: "test", score: 0.88, metadata: meta({ filePath: "/repo/tests/session.test.ts", name: "resolveSession test", chunkType: "test_declaration", hash: "test" }) },
      { id: "docs", score: 0.87, metadata: meta({ filePath: "/repo/docs/session.md", name: "session guide", chunkType: "other", hash: "docs" }) },
      { id: "config", score: 0.86, metadata: meta({ filePath: "/repo/config/session.yaml", name: "session settings", chunkType: "other", hash: "config" }) },
      { id: "call-flow", score: 0.85, metadata: meta({ filePath: "/repo/src/call-graph/session-callers.ts", name: "findSessionCallers", chunkType: "function", hash: "call-flow" }) },
    ];

    expect(rerankResults("tests for resolveSession", candidates, candidates.length)[0]?.id).toBe("test");
    expect(rerankResults("documentation for resolveSession", candidates, candidates.length)[0]?.id).toBe("docs");
    expect(rerankResults("session configuration settings", candidates, candidates.length)[0]?.id).toBe("config");
    expect(rerankResults("who calls resolveSession", candidates, candidates.length)[0]?.id).toBe("call-flow");
  });

  it("removes nested same-symbol containers without collapsing distinct nested symbols", () => {
    const candidates: Candidate[] = [
      { id: "target", score: 0.9, metadata: meta({ filePath: "/repo/src/session.ts", name: "resolveSession", chunkType: "function", startLine: 10, endLine: 20, hash: "target" }) },
      { id: "container", score: 0.89, metadata: meta({ filePath: "/repo/src/session.ts", name: "resolveSession", chunkType: "export_statement", startLine: 9, endLine: 20, hash: "container" }) },
      { id: "distinct", score: 0.88, metadata: meta({ filePath: "/repo/src/session.ts", name: "refreshSession", chunkType: "function", startLine: 22, endLine: 30, hash: "distinct" }) },
    ];

    const ranked = rerankResults("session lifecycle", candidates, candidates.length);
    expect(ranked.map((candidate) => candidate.id)).toEqual(["target", "distinct"]);
  });

  it("keeps stable input order for true ties and preserves strong conceptual relevance", () => {
    const tied: Candidate[] = [
      { id: "z", score: 0.9, metadata: meta({ filePath: "/repo/src/a.ts", name: "alpha", chunkType: "function", hash: "z" }) },
      { id: "a", score: 0.9, metadata: meta({ filePath: "/repo/src/b.ts", name: "beta", chunkType: "function", hash: "a" }) },
    ];
    const conceptual: Candidate[] = [
      { id: "relevant", score: 0.96, metadata: meta({ filePath: "/repo/src/recovery.ts", name: "recoverCorruptedIndex", chunkType: "function", hash: "relevant" }) },
      { id: "generated", score: 0.94, metadata: meta({ filePath: "/repo/generated/recovery.ts", name: "recoverCorruptedIndex", chunkType: "function", hash: "generated" }) },
      { id: "docs", score: 0.93, metadata: meta({ filePath: "/repo/docs/recovery.md", name: "recovery guide", chunkType: "other", hash: "docs" }) },
    ];

    expect(rerankResults("unrelated", tied, tied.length).map((candidate) => candidate.id)).toEqual(["z", "a"]);
    expect(rerankResults("unrelated", tied, tied.length).map((candidate) => candidate.id)).toEqual(["z", "a"]);
    expect(rerankResults("recover corrupted sqlite index safely", conceptual, conceptual.length)[0]?.id).toBe("relevant");

    const acronymConcept: Candidate[] = [
      { id: "metrics", score: 0.96, metadata: meta({ filePath: "/repo/src/eval/metrics.ts", name: "computeEvalMetrics", chunkType: "function", hash: "metrics" }) },
      { id: "acronym", score: 0.9, metadata: meta({ filePath: "/repo/src/constants.ts", name: "MRR", chunkType: "other", hash: "acronym" }) },
    ];
    expect(rerankResults("calculate retrieval recall MRR and discounted gain", acronymConcept, acronymConcept.length)[0]?.id)
      .toBe("metrics");
  });

  it("extracts file path hint from path-constrained implementation query", () => {
    const query = "where is createSystem implementation in packages/react/src/styled-system/system.ts";
    expect(extractFilePathHint(query)).toBe("packages/react/src/styled-system/system.ts");
  });

  it("returns null for queries without file path hint", () => {
    const query = "where is createSystem implementation";
    expect(extractFilePathHint(query)).toBeNull();
  });

  it("strips file path suffix from embedding query text", () => {
    const query = "where is createSystem implementation in packages/react/src/styled-system/system.ts";
    expect(stripFilePathHint(query)).toBe("where is createSystem implementation");
  });

  it("applies external reranker ordering when configured", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 3,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");

    const firstPath = createTempFile("src/first.ts", "const SECRET_BEFORE = 'private';\nexport function firstThing() {\n  return 'first';\n}\nconst SECRET_AFTER = 'private';\n");
    const secondPath = createTempFile("src/second.ts", "export function secondThing() {\n  return 'second';\n}\n");
    const thirdPath = createTempFile("src/third.ts", "export function thirdThing() {\n  return 'third';\n}\n");

    const fetchSpy = globalThis.fetch;
    let rerankBody: { documents?: string[] } | undefined;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/rerank")) {
        rerankBody = JSON.parse(String(init?.body ?? "{}")) as { documents?: string[] };
        return new Response(JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.72 },
            { index: 1, relevance_score: 0.4 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }], usage: { total_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;

    const candidates: Candidate[] = [
      { id: "first", score: 0.9, metadata: meta({ filePath: firstPath, name: "firstThing", chunkType: "function", startLine: 2, endLine: 4 }) },
      { id: "second", score: 0.89, metadata: meta({ filePath: secondPath, name: "secondThing", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "third", score: 0.88, metadata: meta({ filePath: thirdPath, name: "thirdThing", chunkType: "function", startLine: 1, endLine: 3 }) },
    ];

    const reranked = await (indexer as unknown as {
      rerankCandidatesWithApi(query: string, items: Candidate[]): Promise<Candidate[]>;
    }).rerankCandidatesWithApi("find third thing", candidates);

    expect(reranked.map((candidate) => candidate.id)).toEqual(["third", "first", "second"]);
    expect(rerankBody?.documents?.[0]).toContain("snippet:");
    expect(rerankBody?.documents?.[0]).toContain("export function firstThing()");
    expect(rerankBody?.documents?.[0]).toContain("intent_hint: implementation");
    expect(rerankBody?.documents?.[0]).not.toContain("SECRET_BEFORE");
    expect(rerankBody?.documents?.[0]).not.toContain("SECRET_AFTER");
    globalThis.fetch = fetchSpy;
  });

  it("falls back to deterministic order when external reranker fails", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 2,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");

    const firstPath = createTempFile("src/first.ts", "export function firstThing() {\n  return 'first';\n}\n");
    const secondPath = createTempFile("src/second.ts", "export function secondThing() {\n  return 'second';\n}\n");
    const thirdPath = createTempFile("src/third.ts", "export function thirdThing() {\n  return 'third';\n}\n");

    const fetchSpy = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/rerank")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }], usage: { total_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;

    const candidates: Candidate[] = [
      { id: "first", score: 0.9, metadata: meta({ filePath: firstPath, name: "firstThing", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "second", score: 0.89, metadata: meta({ filePath: secondPath, name: "secondThing", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "third", score: 0.88, metadata: meta({ filePath: thirdPath, name: "thirdThing", chunkType: "function", startLine: 1, endLine: 3 }) },
    ];

    const reranked = await (indexer as unknown as {
      rerankCandidatesWithApi(query: string, items: Candidate[]): Promise<Candidate[]>;
    }).rerankCandidatesWithApi("find third thing", candidates);

    expect(reranked.map((candidate) => candidate.id)).toEqual(["first", "second", "third"]);
    globalThis.fetch = fetchSpy;
  });

  it("cancels a blocked external reranker request without falling back", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 2,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");
    const candidates: Candidate[] = [
      { id: "first", score: 0.9, metadata: meta({ filePath: "/repo/src/first.ts", name: "firstThing", chunkType: "function" }) },
      { id: "second", score: 0.89, metadata: meta({ filePath: "/repo/src/second.ts", name: "secondThing", chunkType: "function" }) },
    ];
    const originalFetch = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    let markRequestStarted: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      markRequestStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        if (!requestSignal) {
          reject(new Error("Expected a reranker request signal."));
          return;
        }
        const rejectCancellation = (): void => reject(requestSignal?.reason ?? new Error("cancelled"));
        if (requestSignal.aborted) rejectCancellation();
        else requestSignal.addEventListener("abort", rejectCancellation, { once: true });
      });
    }) as typeof fetch;

    try {
      const controller = new AbortController();
      const reranking = (indexer as unknown as {
        rerankCandidatesWithApi(
          query: string,
          items: Candidate[],
          options?: { signal?: AbortSignal },
        ): Promise<Candidate[]>;
      }).rerankCandidatesWithApi("find first thing", candidates, { signal: controller.signal });
      await requestStarted;
      controller.abort();

      await expect(reranking).rejects.toBeInstanceOf(OperationCancelledError);
      expect(requestSignal?.aborted).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips external reranker for definition-intent queries with identifier hints", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 3,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");

    const fetchSpy = globalThis.fetch;
    let rerankCalled = false;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/rerank")) {
        rerankCalled = true;
        return new Response(JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.72 },
            { index: 1, relevance_score: 0.4 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }], usage: { total_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;

    const candidates: Candidate[] = [
      { id: "first", score: 0.9, metadata: meta({ filePath: "/repo/src/first.ts", name: "rankHybridResults", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "second", score: 0.89, metadata: meta({ filePath: "/repo/src/second.ts", name: "otherThing", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "third", score: 0.88, metadata: meta({ filePath: "/repo/README.md", name: "docs", chunkType: "other", startLine: 1, endLine: 3 }) },
    ];

    const reranked = await (indexer as unknown as {
      rerankCandidatesWithApi(
        query: string,
        items: Candidate[],
        options?: { definitionIntent?: boolean; hasIdentifierHints?: boolean }
      ): Promise<Candidate[]>;
    }).rerankCandidatesWithApi("where is rankHybridResults implementation", candidates, {
      hasIdentifierHints: true,
    });

    expect(rerankCalled).toBe(false);
    expect(reranked.map((candidate) => candidate.id)).toEqual(["first", "second", "third"]);
    globalThis.fetch = fetchSpy;
  });

  it("allows external reranker for documentation intent even when identifier hints are present", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 3,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");

    const fetchSpy = globalThis.fetch;
    let rerankCalled = false;
    let rerankDocuments: string[] | undefined;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes("/rerank")) {
        rerankCalled = true;
        rerankDocuments = (JSON.parse(String(init?.body ?? "{}")) as { documents?: string[] }).documents;
        return new Response(JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.6 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }], usage: { total_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;

    const candidates: Candidate[] = [
      { id: "impl", score: 0.9, metadata: meta({ filePath: "/repo/src/indexer/index.ts", name: "rankHybridResults", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "docs-readme", score: 0.89, metadata: meta({ filePath: "/repo/README.md", name: "retrieval documentation", chunkType: "other", startLine: 1, endLine: 3 }) },
      { id: "docs-guide", score: 0.88, metadata: meta({ filePath: "/repo/docs/guide.md", name: "rankHybridResults guide", chunkType: "other", startLine: 1, endLine: 3 }) },
    ];
    const setPhase = vi.fn(async () => undefined);

    const reranked = await (indexer as unknown as {
      rerankCandidatesWithApi(
        query: string,
        items: Candidate[],
        options?: {
          definitionIntent?: boolean;
          hasIdentifierHints?: boolean;
          setPhase?: (phase: string) => void | Promise<void>;
        }
      ): Promise<Candidate[]>;
    }).rerankCandidatesWithApi("rankHybridResults documentation guide", candidates, {
      hasIdentifierHints: true,
      setPhase,
    });

    expect(rerankCalled).toBe(true);
    expect(reranked.map((candidate) => candidate.id)).toEqual(["docs-guide", "docs-readme", "impl"]);
    expect(rerankDocuments?.length).toBe(2);
    expect(rerankDocuments?.[0]).toContain("path: /repo/README.md");
    expect(rerankDocuments?.[1]).toContain("path: /repo/docs/guide.md");
    expect(setPhase).toHaveBeenCalledWith("reranking");
    globalThis.fetch = fetchSpy;
  });

  it("diversifies external reranker output for exploratory queries", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 3,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");

    const fileA1 = createTempFile("src/auth.ts", "export function validateAuth() {\n  return true;\n}\n");
    const fileA2 = fileA1;
    const fileB = createTempFile("src/session.ts", "export function loadSession() {\n  return 'session';\n}\n");

    const fetchSpy = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.99 },
            { index: 1, relevance_score: 0.98 },
            { index: 2, relevance_score: 0.4 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }], usage: { total_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;

    const candidates: Candidate[] = [
      { id: "fileA-1", score: 0.95, metadata: meta({ filePath: fileA1, name: "validateAuth", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "fileA-2", score: 0.94, metadata: meta({ filePath: fileA2, name: "refreshAuth", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "fileB", score: 0.93, metadata: meta({ filePath: fileB, name: "loadSession", chunkType: "function", startLine: 1, endLine: 3 }) },
    ];

    const reranked = await (indexer as unknown as {
      rerankCandidatesWithApi(
        query: string,
        items: Candidate[],
        options?: { definitionIntent?: boolean; hasIdentifierHints?: boolean }
      ): Promise<Candidate[]>;
    }).rerankCandidatesWithApi("auth flow", candidates);

    expect(reranked.map((candidate) => candidate.id).slice(0, 2)).toEqual(["fileA-1", "fileB"]);
    globalThis.fetch = fetchSpy;
  });

  it("diversifies external reranker duplicates by symbol before repeating the same symbol", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embed",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 3,
      },
    });
    const indexer = new Indexer("/repo", config, "opencode");

    const authFile = createTempFile("src/auth.ts", "export function validateAuth() {\n  return true;\n}\nexport function refreshAuth() {\n  return false;\n}\n");

    const fetchSpy = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.99 },
            { index: 1, relevance_score: 0.98 },
            { index: 2, relevance_score: 0.4 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }], usage: { total_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;

    const candidates: Candidate[] = [
      { id: "same-symbol-1", score: 0.95, metadata: meta({ filePath: authFile, name: "validateAuth", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "same-symbol-2", score: 0.94, metadata: meta({ filePath: authFile, name: "validateAuth", chunkType: "function", startLine: 1, endLine: 3 }) },
      { id: "different-symbol", score: 0.93, metadata: meta({ filePath: authFile, name: "refreshAuth", chunkType: "function", startLine: 4, endLine: 6 }) },
    ];

    const reranked = await (indexer as unknown as {
      rerankCandidatesWithApi(
        query: string,
        items: Candidate[],
        options?: { definitionIntent?: boolean; hasIdentifierHints?: boolean }
      ): Promise<Candidate[]>;
    }).rerankCandidatesWithApi("auth flow", candidates);

    expect(reranked.map((candidate) => candidate.id).slice(0, 2)).toEqual(["same-symbol-1", "different-symbol"]);
    globalThis.fetch = fetchSpy;
  });
});
