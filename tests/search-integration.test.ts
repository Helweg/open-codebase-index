import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { buildSymbolDefinitionLane, Indexer } from "../src/indexer/index.js";
import { Database, hashContent } from "../src/native/index.js";

describe("search integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let _indexers: Indexer[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-integration-"));

    fs.mkdirSync(path.join(tempDir, "app", "indexer"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "tests", "fixtures", "call-graph"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "benchmarks"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "app", "indexer", "index.ts"),
      `export function rankHybridResults(query: string) { return query.length; }
export function rerankResults(query: string) { return rankHybridResults(query); }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "tests", "fixtures", "call-graph", "same-file-refs.ts"),
      `function entryPoint() { return "where is rankHybridResults implementation fixture rankHybridResults"; }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "benchmarks", "run.ts"),
      `export function runBenchmarks() { return "rankHybridResults benchmark implementation"; }
`,
      "utf-8"
    );

    fs.writeFileSync(
      path.join(tempDir, "README.md"),
      "# Retrieval Documentation\n\nThis doc explains rankHybridResults usage.",
      "utf-8"
    );
  });

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns implementation definitions before fixture/benchmark noise for implementation-intent query", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    const stats = await indexer.index();
    expect(stats.totalFiles).toBeGreaterThan(0);

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain(path.join("app", "indexer", "index.ts"));
    expect(topPaths).not.toContain(path.join("tests", "fixtures", "call-graph", "same-file-refs.ts"));
    expect(topPaths).not.toContain(path.join("benchmarks", "run.ts"));
  });

  it("treats relative and absolute directory filters equivalently", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
      search: { maxResults: 10, minScore: 0 },
    });
    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const relativeDirectory = path.join("app", "indexer");
    const absoluteDirectory = `${path.join(tempDir, relativeDirectory)}${path.sep}`;
    const source = fs.readFileSync(path.join(tempDir, relativeDirectory, "index.ts"), "utf-8");

    const relativeSearch = await indexer.search("rankHybridResults implementation", 10, {
      metadataOnly: true,
      filterByBranch: false,
      directory: relativeDirectory,
    });
    const absoluteSearch = await indexer.search("rankHybridResults implementation", 10, {
      metadataOnly: true,
      filterByBranch: false,
      directory: absoluteDirectory,
    });

    expect(relativeSearch.length).toBeGreaterThan(0);
    expect(absoluteSearch.map((result) => result.filePath)).toEqual(
      relativeSearch.map((result) => result.filePath),
    );

    const relativeSimilar = await indexer.findSimilar(source, 10, {
      filterByBranch: false,
      directory: relativeDirectory,
    });
    const absoluteSimilar = await indexer.findSimilar(source, 10, {
      filterByBranch: false,
      directory: absoluteDirectory,
    });

    expect(relativeSimilar.length).toBeGreaterThan(0);
    expect(absoluteSimilar.map((result) => result.filePath)).toEqual(
      relativeSimilar.map((result) => result.filePath),
    );
  });

  it("returns exact symbols whose semantic chunks were omitted by the per-file cap", async () => {
    const largeFile = path.join(tempDir, "app", "indexer", "large.ts");
    const declarations = Array.from({ length: 30 }, (_, index) =>
      index === 15
        ? `export function cappedExactDefinition() {
  const values = [
    "target",
    "semantic",
    "definition",
    "omitted",
    "from",
    "embedding",
    "chunks",
  ];
  return values.join("-");
}`
        : `export function filler${index}() {
  const value = ${index};
  return value;
}`
    );
    fs.writeFileSync(largeFile, `${declarations.join("\n\n")}\n`, "utf-8");

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 2,
        fallbackToTextOnMaxChunks: true,
      },
      search: {
        maxResults: 10,
        minScore: 0,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    try {
      expect(database.getSymbolsByName("cappedExactDefinition")).toEqual([
        expect.objectContaining({ filePath: "app/indexer/large.ts" }),
      ]);
      expect(database.getChunksByName("cappedExactDefinition")).toHaveLength(0);
    } finally {
      database.close();
    }

    const results = await indexer.search("where is cappedExactDefinition implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]).toMatchObject({
      filePath: largeFile,
      name: "cappedExactDefinition",
    });
    expect(results[0]?.startLine).toBeGreaterThan(1);
    expect(results[0]?.endLine).toBeGreaterThanOrEqual(results[0]?.startLine ?? 0);
  });

  it("keeps an exact large C# definition ahead of prefix matches", async () => {
    const sourceFile = path.join(tempDir, "app", "indexer", "LargeDefinition.cs");
    const noisyFile = path.join(tempDir, "app", "indexer", "LargeDefinitionProxy.cs");
    fs.writeFileSync(
      sourceFile,
      `public class LargeDefinition {
${Array.from({ length: 120 }, (_, index) => `  public int Value${index} { get; set; }`).join("\n")}
}
`,
      "utf-8",
    );
    fs.writeFileSync(noisyFile, "public class LargeDefinitionProxy { }\n", "utf-8");

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-embedding-model", dimensions: 8 },
      indexing: { watchFiles: false, maxChunksPerFile: 2, fallbackToTextOnMaxChunks: true },
      search: { maxResults: 10, minScore: 0 },
    });
    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const results = await indexer.search("LargeDefinition", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(results[0]).toMatchObject({ filePath: sourceFile, name: "LargeDefinition" });
  });

  it("returns nested class methods that are not standalone semantic chunks", async () => {
    const classFile = path.join(tempDir, "app", "indexer", "service.ts");
    fs.writeFileSync(classFile, `export class Service {
  async getStatus(): Promise<string> {
    return "ready";
  }
}
`, "utf-8");

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
      search: { maxResults: 10, minScore: 0 },
    });
    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const status = await indexer.getStatus();
    const database = new Database(path.join(status.indexPath, "codebase.db"));
    try {
      expect(database.getSymbolsByName("getStatus")).toEqual([
        expect.objectContaining({ filePath: "app/indexer/service.ts", kind: "method_definition" }),
      ]);
      expect(database.getChunksByName("getStatus")).toHaveLength(0);
    } finally {
      database.close();
    }

    const results = await indexer.search("find the getStatus method definition", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(results[0]).toMatchObject({ filePath: classFile, name: "getStatus" });
  });

  it("reparses symbols for unchanged files with stale symbolExtractorVersion metadata and restores nested class methods", async () => {
    const classFile = path.join(tempDir, "app", "indexer", "service.ts");
    const storedClassFile = "app/indexer/service.ts";
    fs.writeFileSync(
      classFile,
      `export class Service {
  getStatus(): string {
    return "ready";
  }
}
`,
      "utf-8",
    );

    const symbolExtractorVersionKey = `index.symbolExtractorVersion.${hashContent("default").slice(0, 24)}`;
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
      search: { maxResults: 10, minScore: 0 },
    });

    const firstIndexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await firstIndexer.index();

    const firstStatus = await firstIndexer.getStatus();
    const initialDb = new Database(path.join(firstStatus.indexPath, "codebase.db"));
    try {
      const beforeReindex = initialDb.getSymbolsByFile(storedClassFile);
      expect(beforeReindex).toContainEqual(expect.objectContaining({
        filePath: storedClassFile,
        name: "getStatus",
        kind: "method_definition",
      }));
      expect(initialDb.getChunksByName("getStatus")).toHaveLength(0);
    } finally {
      initialDb.close();
    }

    await firstIndexer.close();

    const staleDb = new Database(path.join(firstStatus.indexPath, "codebase.db"));
    try {
      staleDb.deleteSymbolsByFile(storedClassFile);
      staleDb.setMetadata(symbolExtractorVersionKey, "stale");
    } finally {
      staleDb.close();
    }

    const secondIndexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    const embeddingCallsBeforeReindex = fetchSpy.mock.calls.length;
    await secondIndexer.index();

    const secondStatus = await secondIndexer.getStatus();
    const restoredDb = new Database(path.join(secondStatus.indexPath, "codebase.db"));
    try {
      const restoredSymbols = restoredDb.getSymbolsByName("getStatus");
      expect(restoredSymbols).toContainEqual(expect.objectContaining({
        filePath: storedClassFile,
        name: "getStatus",
        kind: "method_definition",
      }));
      expect(restoredDb.getMetadata(symbolExtractorVersionKey)).toBe("1");
    } finally {
      restoredDb.close();
    }

    expect(fetchSpy.mock.calls.length).toBe(embeddingCallsBeforeReindex);
  });

  it("keeps global-scope database paths absolute", async () => {
    const sourceFile = path.join(tempDir, "app", "indexer", "index.ts");
    const indexPath = path.join(tempDir, "global-index");
    const config = parseConfig({
      embeddingProvider: "custom",
      scope: "global",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
      search: { maxResults: 10, minScore: 0 },
    });
    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode", { indexPath })) - 1];
    await indexer.index();

    const database = new Database(path.join(indexPath, "codebase.db"));
    try {
      expect(database.getSymbolsByName("rankHybridResults")).toContainEqual(
        expect.objectContaining({ filePath: sourceFile }),
      );
    } finally {
      database.close();
    }

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(results[0]?.filePath).toBe(sourceFile);
  });

  it("does not rescue capped symbols from another branch", () => {
    const database = new Database(path.join(tempDir, "branch-symbols.db"));
    try {
      const symbol = {
        id: "sym_feature_only",
        filePath: path.join(tempDir, "app", "feature.ts"),
        name: "featureOnlyCappedDefinition",
        kind: "export_statement",
        startLine: 31,
        startCol: 0,
        endLine: 31,
        endCol: 64,
        language: "typescript",
      };
      database.upsertSymbol(symbol);
      database.addSymbolsToBranch("feature", [symbol.id]);

      const featureResults = buildSymbolDefinitionLane(
        "where is featureOnlyCappedDefinition implementation",
        database,
        new Set(),
        new Set(database.getBranchSymbolIds("feature")),
        5,
        [],
        true,
      );
      const mainResults = buildSymbolDefinitionLane(
        "where is featureOnlyCappedDefinition implementation",
        database,
        new Set(),
        new Set(database.getBranchSymbolIds("main")),
        5,
        [],
        true,
      );

      expect(featureResults[0]).toMatchObject({
        id: symbol.id,
        metadata: { name: symbol.name, filePath: symbol.filePath },
      });
      expect(mainResults).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps language-specific symbol kinds eligible after rescue", async () => {
    const pythonFile = path.join(tempDir, "app", "indexer", "large.py");
    const declarations = Array.from({ length: 30 }, (_, index) =>
      index === 15
        ? `def capped_python_definition():
    values = [
        "python",
        "semantic",
        "definition",
        "omitted",
        "from",
        "embedding",
        "chunks",
    ]
    return "-".join(values)`
        : `def python_filler_${index}():
    value = ${index}
    return value`
    );
    fs.writeFileSync(pythonFile, `${declarations.join("\n\n")}\n`, "utf-8");

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        maxChunksPerFile: 2,
        fallbackToTextOnMaxChunks: true,
      },
      search: { maxResults: 10, minScore: 0 },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();
    const results = await indexer.search("where is capped_python_definition implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]).toMatchObject({
      filePath: pythonFile,
      name: "capped_python_definition",
      chunkType: "function_definition",
    });
  });

  it("honors explicit file hints when duplicate rescued symbols exist", () => {
    const database = new Database(path.join(tempDir, "path-symbols.db"));
    try {
      const symbols = ["first", "second"].map((directory, index) => ({
        id: `sym_duplicate_${directory}`,
        filePath: path.join(tempDir, "app", directory, "target.ts"),
        name: "duplicateCappedDefinition",
        kind: "export_statement",
        startLine: index + 10,
        startCol: 0,
        endLine: index + 12,
        endCol: 1,
        language: "typescript",
      }));
      database.upsertSymbolsBatch(symbols);
      database.upsertChunksBatch(["first", "third", "fourth"].map((directory, index) => ({
        chunkId: `chunk_duplicate_${index}`,
        contentHash: `hash_duplicate_${index}`,
        filePath: path.join(tempDir, "app", directory, "target.ts"),
        startLine: index + 20,
        endLine: index + 22,
        nodeType: "export_statement",
        name: "duplicateCappedDefinition",
        language: "typescript",
      })));

      const results = buildSymbolDefinitionLane(
        "where is duplicateCappedDefinition implementation in app/second/target.ts",
        database,
        null,
        null,
        1,
        [],
        true,
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.metadata.filePath).toBe(symbols[1]?.filePath);
    } finally {
      database.close();
    }
  });

  it("annotates indexed chunks with git blame and filters by blame author", async () => {
    const authoredDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-blame-"));
    try {
      execFileSync("git", ["init"], { cwd: authoredDir });
      execFileSync("git", ["config", "user.name", "Default User"], { cwd: authoredDir });
      execFileSync("git", ["config", "user.email", "default@example.com"], { cwd: authoredDir });

      fs.writeFileSync(
        path.join(authoredDir, "auth.ts"),
        `export function validateSession() { return "auth session token"; }\n`,
        "utf-8"
      );
      execFileSync("git", ["add", "auth.ts"], { cwd: authoredDir });
      execFileSync("git", ["commit", "-m", "auth: add session validation"], {
        cwd: authoredDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Jane Doe",
          GIT_AUTHOR_EMAIL: "jane@example.com",
          GIT_AUTHOR_DATE: "2025-03-14T12:00:00Z",
          GIT_COMMITTER_NAME: "Jane Doe",
          GIT_COMMITTER_EMAIL: "jane@example.com",
          GIT_COMMITTER_DATE: "2025-03-14T12:00:00Z",
        },
      });

      fs.writeFileSync(
        path.join(authoredDir, "payments.ts"),
        `export function chargeCard() { return "payment flow"; }\n`,
        "utf-8"
      );
      execFileSync("git", ["add", "payments.ts"], { cwd: authoredDir });
      execFileSync("git", ["commit", "-m", "payments: add card charge"], {
        cwd: authoredDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Alex Roe",
          GIT_AUTHOR_EMAIL: "alex@example.com",
          GIT_AUTHOR_DATE: "2025-04-01T12:00:00Z",
          GIT_COMMITTER_NAME: "Alex Roe",
          GIT_COMMITTER_EMAIL: "alex@example.com",
          GIT_COMMITTER_DATE: "2025-04-01T12:00:00Z",
        },
      });

      const disabledConfig = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-embedding-model",
          dimensions: 8,
        },
        indexing: {
          watchFiles: false,
          gitBlame: { enabled: false },
        },
        search: {
          maxResults: 10,
          minScore: 0,
        },
      });
      const disabledIndexer = new Indexer(authoredDir, disabledConfig, "opencode");
      await disabledIndexer.index();
      await disabledIndexer.close();

      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-embedding-model",
          dimensions: 8,
        },
        indexing: {
          watchFiles: false,
          gitBlame: { enabled: true },
        },
        search: {
          maxResults: 10,
          minScore: 0,
        },
      });

      const indexer = new Indexer(authoredDir, config, "opencode");
      _indexers.push(indexer);
      await indexer.index();

      const janeResults = await indexer.search("session token", 5, {
        metadataOnly: true,
        filterByBranch: false,
        blameAuthor: "jane@example.com",
      });

      expect(janeResults).toHaveLength(1);
      expect(janeResults[0]?.filePath).toContain("auth.ts");
      expect(janeResults[0]?.blame?.authorEmail).toBe("jane@example.com");
      expect(janeResults[0]?.blame?.summary).toBe("auth: add session validation");

      const blameSha = janeResults[0]?.blame?.sha.slice(0, 8);
      if (!blameSha) {
        throw new Error("expected blame SHA");
      }

      const shaResults = await indexer.search("session token", 5, {
        metadataOnly: true,
        filterByBranch: false,
        blameSha,
      });
      expect(shaResults).toHaveLength(1);
      expect(shaResults[0]?.filePath).toContain("auth.ts");

      const sinceResults = await indexer.search("payment flow", 5, {
        metadataOnly: true,
        filterByBranch: false,
        blameSince: "2025-03-20",
      });
      expect(sinceResults).toHaveLength(1);
      expect(sinceResults[0]?.filePath).toContain("payments.ts");

      const untilResults = await indexer.search("session token payment flow", 5, {
        metadataOnly: true,
        filterByBranch: false,
        blameUntil: "2025-03-14",
      });
      expect(untilResults).toHaveLength(1);
      expect(untilResults[0]?.filePath).toContain("auth.ts");

      const boundedResults = await indexer.search("session token payment flow", 5, {
        metadataOnly: true,
        filterByBranch: false,
        blameSince: "2025-03-01T00:00:00Z",
        blameUntil: "2025-03-31T23:59:59Z",
      });
      expect(boundedResults).toHaveLength(1);
      expect(boundedResults[0]?.filePath).toContain("auth.ts");

      const recentSimilar = await indexer.findSimilar(
        `export function validateSession() { return "auth session token"; }`,
        5,
        {
          filterByBranch: false,
          blameSince: "2025-03-20T00:00:00Z",
        },
      );
      expect(recentSimilar).toHaveLength(1);
      expect(recentSimilar[0]?.filePath).toContain("payments.ts");

      const olderSimilar = await indexer.findSimilar(
        `export function chargeCard() { return "payment flow"; }`,
        5,
        {
          filterByBranch: false,
          blameUntil: "2025-03-14",
        },
      );
      expect(olderSimilar).toHaveLength(1);
      expect(olderSimilar[0]?.filePath).toContain("auth.ts");
    } finally {
      fs.rmSync(authoredDir, { recursive: true, force: true });
    }
  });

  it("prefers documentation paths for doc-intent phrasing with 'where is'", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults documentation guide", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("README.md");
  });

  it("returns implementation definitions with definitionIntent option even for ambiguous queries", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain(path.join("app", "indexer", "index.ts"));
  });

  it("keeps plain identifier queries discoverable without definitionIntent", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.slice(0, 3).map((r) => r.filePath);
    expect(topPaths[0]).toContain(path.join("app", "indexer", "index.ts"));
  });

  it("forces definition lanes for doc-leaning queries when definitionIntent is true", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const withoutOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });
    expect(withoutOverride[0]?.filePath).toContain("README.md");

    const withOverride = await indexer.search("where is rankHybridResults documentation", 5, {
      metadataOnly: true,
      filterByBranch: false,
      definitionIntent: true,
    });

    expect(withOverride.length).toBeGreaterThan(0);
    expect(withOverride[0]?.filePath).toContain(path.join("app", "indexer", "index.ts"));
    expect(withOverride[0]?.filePath).not.toContain("README.md");
  });

  it("keeps implementation results ahead of docs even when external reranker prefers docs for implementation intent", async () => {
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.99 },
            { index: 1, relevance_score: 0.5 },
          ],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 10,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const results = await indexer.search("where is rankHybridResults implementation", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("app", "indexer", "index.ts"));
    expect(results[0]?.filePath).not.toContain("README.md");
  });

  it("keeps documentation results ahead of code when external reranker prefers code for doc intent", async () => {
    fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.99 },
            { index: 0, relevance_score: 0.4 },
          ],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      reranker: {
        enabled: true,
        provider: "custom",
        model: "mock-reranker",
        baseUrl: "https://rerank.example/v1",
        topN: 10,
      },
      indexing: {
        watchFiles: false,
      },
      search: {
        maxResults: 10,
        minScore: 0,
        fusionStrategy: "rrf",
        rrfK: 60,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults documentation guide", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("README.md");
    expect(results[0]?.filePath).not.toContain(path.join("app", "indexer", "index.ts"));
  });

  it("applies directory, file type, and blame scopes before sending candidates to an external reranker", async () => {
    const scopedDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-reranker-scope-"));
    let scopedIndexer: Indexer | undefined;
    try {
      execFileSync("git", ["init"], { cwd: scopedDir });
      execFileSync("git", ["config", "user.name", "Default User"], { cwd: scopedDir });
      execFileSync("git", ["config", "user.email", "default@example.com"], { cwd: scopedDir });
      fs.mkdirSync(path.join(scopedDir, "private", "scope"), { recursive: true });
      fs.mkdirSync(path.join(scopedDir, "public"), { recursive: true });

      fs.writeFileSync(path.join(scopedDir, "private", "scope", "allowed-a.ts"),
        "export function authorizeRequest() { return 'active session request'; }\n", "utf-8");
      fs.writeFileSync(path.join(scopedDir, "private", "scope", "allowed-b.ts"),
        "export function refreshAuthorization() { return 'active session request'; }\n", "utf-8");
      execFileSync("git", ["add", "."], { cwd: scopedDir });
      execFileSync("git", ["commit", "-m", "add allowed scoped sources"], {
        cwd: scopedDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Jane Doe",
          GIT_AUTHOR_EMAIL: "jane@example.com",
          GIT_COMMITTER_NAME: "Jane Doe",
          GIT_COMMITTER_EMAIL: "jane@example.com",
        },
      });

      fs.writeFileSync(path.join(scopedDir, "private", "scope", "excluded.md"),
        "# active session request FILE_TYPE_SECRET\n", "utf-8");
      fs.writeFileSync(path.join(scopedDir, "private", "scope", "excluded-blame.ts"),
        "export function leakedByBlame() { return 'active session request BLAME_SECRET'; }\n", "utf-8");
      fs.writeFileSync(path.join(scopedDir, "public", "excluded-directory.ts"),
        "export function leakedByDirectory() { return 'active session request DIRECTORY_SECRET'; }\n", "utf-8");
      execFileSync("git", ["add", "."], { cwd: scopedDir });
      execFileSync("git", ["commit", "-m", "add excluded sources"], {
        cwd: scopedDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Alex Roe",
          GIT_AUTHOR_EMAIL: "alex@example.com",
          GIT_COMMITTER_NAME: "Alex Roe",
          GIT_COMMITTER_EMAIL: "alex@example.com",
        },
      });

      const rerankerRequests: string[][] = [];
      fetchSpy.mockImplementation(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(url).includes("/rerank")) {
          const documents = (JSON.parse(String(init?.body ?? "{}")) as { documents?: string[] }).documents ?? [];
          rerankerRequests.push(documents);
          return new Response(JSON.stringify({
            results: documents.map((_, index) => ({ index, relevance_score: 1 - index / 100 })),
          }), { status: 200 });
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
        const texts = Array.isArray(body.input) ? body.input : [];
        return new Response(JSON.stringify({
          data: texts.map((text) => ({
            embedding: Array.from({ length: 8 }, (_, index) => ((text.length + index * 13) % 97) / 97),
          })),
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }), { status: 200 });
      });

      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "mock-embedding-model",
          dimensions: 8,
        },
        reranker: {
          enabled: true,
          provider: "custom",
          model: "mock-reranker",
          baseUrl: "https://rerank.example/v1",
          topN: 10,
        },
        indexing: {
          watchFiles: false,
          gitBlame: { enabled: true },
        },
        search: {
          maxResults: 10,
          minScore: 0,
          rerankTopN: 20,
        },
      });

      scopedIndexer = new Indexer(scopedDir, config, "opencode");
      await scopedIndexer.index();
      const results = await scopedIndexer.search("authorize incoming requests with active sessions", 10, {
        metadataOnly: true,
        filterByBranch: false,
        directory: "private/scope",
        fileType: "ts",
        blameAuthor: "jane@example.com",
      });

      expect(results).toHaveLength(2);
      expect(results.every((result) => result.filePath.includes(path.join("private", "scope", "allowed-")))).toBe(true);
      expect(rerankerRequests.length).toBeGreaterThan(0);
      const sentDocuments = rerankerRequests.flat();
      expect(sentDocuments).toHaveLength(2);
      expect(sentDocuments.every((document) => document.includes(path.join("private", "scope", "allowed-")))).toBe(true);
      expect(sentDocuments.join("\n")).not.toContain("FILE_TYPE_SECRET");
      expect(sentDocuments.join("\n")).not.toContain("BLAME_SECRET");
      expect(sentDocuments.join("\n")).not.toContain("DIRECTORY_SECRET");
    } finally {
      await scopedIndexer?.close();
      fs.rmSync(scopedDir, { recursive: true, force: true });
    }
  });

  it("falls back to weighted keyword search when query embedding generation fails", async () => {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
      search: {
        maxResults: 10,
        minScore: 0.01,
        fusionStrategy: "weighted",
        hybridWeight: 0,
        rerankTopN: 20,
      },
    });

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config, "opencode")) - 1];
    await indexer.index();
    fetchSpy.mockRejectedValue(new Error("embedding endpoint unavailable"));
    const warningLog = vi.spyOn(indexer.getLogger(), "warn");

    const results = await indexer.search("rankHybridResults", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain(path.join("app", "indexer", "index.ts"));
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(warningLog).toHaveBeenCalledWith(
      "Query embedding failed; falling back to keyword-only search",
      expect.objectContaining({
        error: "embedding endpoint unavailable",
        action: expect.stringContaining("embedding provider"),
      })
    );
  });
});
