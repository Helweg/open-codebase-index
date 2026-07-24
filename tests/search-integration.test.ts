import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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
      const disabledIndexer = new Indexer(authoredDir, disabledConfig);
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

      const indexer = new Indexer(authoredDir, config);
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
    await indexer.index();

    const results = await indexer.search("rankHybridResults documentation guide", 5, {
      metadataOnly: true,
      filterByBranch: false,
    });

    expect(results[0]?.filePath).toContain("README.md");
    expect(results[0]?.filePath).not.toContain(path.join("app", "indexer", "index.ts"));
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

    const indexer = _indexers[_indexers.push(new Indexer(tempDir, config)) - 1];
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
