import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { buildMalformedPdfFixture, buildPdfFixture } from "./fixtures/pdf.js";

describe("PDF Indexer integration", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let embeddingCalls: string[];
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
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string; input?: string[] };
      const texts = body.prompt === undefined ? body.input ?? [] : [body.prompt];
      embeddingCalls.push(...texts);
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

  function createIndexer(includeContext = true): Indexer {
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
});
