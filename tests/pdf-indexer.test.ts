import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { readFailedBatchRecords } from "../src/indexer/failed-state-persistence.js";
import { Indexer } from "../src/indexer/index.js";
import { buildMalformedPdfFixture, buildPdfFixture } from "./fixtures/pdf.js";

describe("PDF Indexer integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let embeddingCalls: string[];
  let failEmbeddings: boolean;
  let rerankerDocuments: string[][];
  const indexers: Indexer[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-indexer-"));
    fs.writeFileSync(path.join(tempDir, "package.json"), "{}\n");
    fs.writeFileSync(path.join(tempDir, "source.ts"), "export const sourceMarker = 'source';\n");
    fs.writeFileSync(path.join(tempDir, "guide.pdf"), buildPdfFixture([
      { lines: ["First page marker"] },
      { lines: ["Second page searchable marker"] },
    ]));
    embeddingCalls = [];
    failEmbeddings = false;
    rerankerDocuments = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }), { status: 200 });
      }
      if (String(url).endsWith("/rerank")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { documents?: string[] };
        rerankerDocuments.push(body.documents ?? []);
        return new Response(JSON.stringify({
          results: (body.documents ?? []).map((_, index) => ({ index, relevance_score: 1 - index / 100 })),
        }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string; input?: string[] };
      const texts = body.prompt === undefined ? body.input ?? [] : [body.prompt];
      embeddingCalls.push(...texts);
      if (failEmbeddings && texts.some((text) => text.includes("Second page searchable marker"))) {
        return new Response(JSON.stringify({ error: "temporary failure" }), { status: 429 });
      }
      const vectors = texts.map(() => Array.from({ length: 768 }, () => 0.1));
      return body.prompt === undefined
        ? new Response(JSON.stringify({ embeddings: vectors }), { status: 200 })
        : new Response(JSON.stringify({ embedding: vectors[0] }), { status: 200 });
    });
  });

  afterEach(async () => {
    await Promise.all(indexers.splice(0).map((indexer) => indexer.close()));
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createIndexer(includeContext = true, extraConfig: Record<string, unknown> = {}): Indexer {
    const indexer = new Indexer(tempDir, parseConfig({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      additionalInclude: ["**/*.pdf"],
      indexing: {
        watchFiles: false,
        retries: 0,
        maxChunksPerFile: 100,
        fallbackToTextOnMaxChunks: true,
        semanticOnly: true,
      },
      search: { includeContext, minScore: 0 },
      ...extraConfig,
    }), "opencode");
    indexers.push(indexer);
    return indexer;
  }

  it("indexes, persists, restarts, skips unchanged files, and removes invalid replacements", async () => {
    const indexer = createIndexer();
    const dryRun = await indexer.dryRunCost();
    expect(dryRun.filesCount).toBe(2);
    expect(dryRun.chunksCount).toBeGreaterThanOrEqual(3);
    expect(embeddingCalls).toEqual([]);

    const forced = await indexer.forceIndex();
    expect(forced.tokensUsed).toBe(dryRun.tokensToEmbed);
    expect(embeddingCalls.some((text) => text.includes("Second page searchable marker"))).toBe(true);

    const result = (await indexer.search("Second page searchable marker", 10))
      .find((item) => item.filePath.endsWith("guide.pdf"));
    expect(result).toMatchObject({
      content: "Second page searchable marker",
      documentLocation: { kind: "pdf", pageStart: 2, pageEnd: 2 },
    });

    const callsAfterForce = embeddingCalls.length;
    const unchanged = await indexer.index();
    expect(unchanged.indexedChunks).toBe(0);
    expect(embeddingCalls).toHaveLength(callsAfterForce);
    await indexer.close();

    const restarted = createIndexer(false);
    const metadataOnlyContent = (await restarted.search("Second page searchable marker", 10))
      .find((item) => item.filePath.endsWith("guide.pdf"));
    expect(metadataOnlyContent?.documentLocation?.pageStart).toBe(2);
    expect(metadataOnlyContent?.content).toBe("");

    fs.writeFileSync(path.join(tempDir, "guide.pdf"), buildMalformedPdfFixture());
    const invalid = await restarted.index();
    expect(invalid.parseFailures.join("\n")).toContain("[INVALID_PDF]");
    expect(invalid.removedChunks).toBeGreaterThan(0);
    expect((await restarted.search("Second page searchable marker", 10))
      .some((item) => item.filePath.endsWith("guide.pdf"))).toBe(false);
  });

  it("returns both physical PDF pages across a blank middle page before and after restart", async () => {
    fs.writeFileSync(path.join(tempDir, "guide.pdf"), buildPdfFixture([
      { lines: ["Repeated searchable page marker"] },
      { empty: true },
      { lines: ["Repeated searchable page marker"] },
    ]));
    const indexer = createIndexer();
    await indexer.forceIndex();
    const assertPages = async (active: Indexer): Promise<void> => {
      const results = (await active.search("Repeated searchable page marker", 10))
        .filter((result) => result.filePath.endsWith("guide.pdf"));
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.documentLocation?.pageStart).sort()).toEqual([1, 3]);
      for (const result of results) {
        expect(result.content).toBe("Repeated searchable page marker");
        expect(result.documentLocation).toEqual({
          kind: "pdf", pageStart: result.documentLocation?.pageStart, pageEnd: result.documentLocation?.pageStart,
        });
      }
    };
    await assertPages(indexer);
    await indexer.close();
    await assertPages(createIndexer());
  });

  it("excludes PDF passages from definition intent while retaining code definitions", async () => {
    const indexer = createIndexer();
    await indexer.forceIndex();

    const pdfOnly = await indexer.search("Second page searchable marker", 10, { definitionIntent: true });
    expect(pdfOnly.some((result) => result.documentLocation?.kind === "pdf")).toBe(false);

    const codeDefinitions = await indexer.search("sourceMarker", 10, { definitionIntent: true });
    expect(codeDefinitions.some((result) => result.filePath.endsWith("source.ts"))).toBe(true);
  });

  it("sends persisted PDF text and page metadata to the reranker after hard scope filters", async () => {
    fs.writeFileSync(path.join(tempDir, "appendix.pdf"), buildPdfFixture([
      { lines: ["Appendix page marker"] },
    ]));
    const rerankerConfig = {
      reranker: {
        enabled: true,
        provider: "custom",
        model: "test-reranker",
        baseUrl: "https://reranker.test/v1",
        topN: 10,
      },
    };
    const indexer = createIndexer(true, rerankerConfig);
    await indexer.forceIndex();
    await indexer.close();

    const restarted = createIndexer(true, rerankerConfig);
    await restarted.search("page marker", 10, { fileType: "pdf" });

    const documents = rerankerDocuments.flat();
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every((document) => document.includes("path: ") && document.includes(".pdf"))).toBe(true);
    expect(documents.some((document) => document.includes("guide.pdf"))).toBe(true);
    expect(documents.some((document) => /pages: \d+-\d+/.test(document))).toBe(true);
    expect(documents.some((document) => /snippet:\n(?:First page marker|Second page searchable marker|Appendix page marker)/.test(document))).toBe(true);
    expect(documents.every((document) => !document.includes("sourceMarker"))).toBe(true);
  });

  it("persists PDF retry fields and restores page-aware search after retry", async () => {
    failEmbeddings = true;
    const indexer = createIndexer();
    const failed = await indexer.forceIndex();
    expect(failed.failedChunks).toBeGreaterThan(0);

    const failedPath = path.join(tempDir, ".opencode", "index", "failed-batches.json");
    const records = Array.from(readFailedBatchRecords<{
      content?: string;
      metadata?: {
        documentLocation?: { kind?: string; pageStart?: number; pageEnd?: number };
        sourceText?: string;
      };
    }>(failedPath));
    const pdfChunk = records.flatMap((record) => record.chunks)
      .find((chunk) => chunk.content?.includes("Second page searchable marker"));
    expect(pdfChunk).toMatchObject({
      content: "Second page searchable marker",
      metadata: {
        documentLocation: { kind: "pdf", pageStart: 2, pageEnd: 2 },
        sourceText: "Second page searchable marker",
      },
    });

    await indexer.close();
    failEmbeddings = false;
    const restarted = createIndexer();
    expect(await restarted.retryFailedBatches()).toMatchObject({ failed: 0, remaining: 0 });
    expect((await restarted.search("Second page searchable marker", 10)).find((result) =>
      result.filePath.endsWith("guide.pdf")
    )).toMatchObject({
      content: "Second page searchable marker",
      documentLocation: { kind: "pdf", pageStart: 2, pageEnd: 2 },
    });
  });

  it("does not discover PDFs by default and honors explicit PDF exclusion", async () => {
    const defaultIndexer = createIndexer(true, { additionalInclude: [] });
    expect((await defaultIndexer.dryRunCost()).filesCount).toBe(1);
    await defaultIndexer.close();

    const excludedIndexer = createIndexer(true, { exclude: ["**/*.pdf"] });
    expect((await excludedIndexer.dryRunCost()).filesCount).toBe(1);
  });
});
