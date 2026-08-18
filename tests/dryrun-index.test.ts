import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

// dryRunCost() is the parse-only counterpart of index()/forceIndex(): it parses
// the real file set with the same chunking path (parseFiles + fallback-to-text
// + maxChunksPerFile cap + selectIndexableChunks + createEmbeddingTexts) and
// sums estimateTokens over the embedding text of every indexable chunk WITHOUT
// calling the embedding provider or writing to the index. These tests pin the
// three guarantees the feature relies on: no embedding provider call and no
// indexed result; the parse path mirrors forceIndex exactly so the token total
// matches a real force index for an estimate-based provider (ollama counts
// ceil(len/4) for every embedded text, the same basis dryRunCost sums); and the
// fallback-to-text + maxChunksPerFile cap path is exercised.
describe("indexer dryRunCost", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let embeddingCalls: string[] = [];
  let _indexers: Indexer[] = [];

  beforeEach(() => {
    embeddingCalls = [];
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string; input?: string[] };
      // ollama single-text /api/embeddings path (legacy / single-text request).
      if (body.prompt !== undefined) {
        embeddingCalls.push(body.prompt);
        return new Response(JSON.stringify({ embedding: Array.from({ length: 768 }, () => 0.1) }), { status: 200 });
      }
      // ollama batched /api/embed path (PR #300): input is an array of texts.
      // Record each text so the force-index call count is observable, and return
      // one embedding vector per input text.
      if (Array.isArray(body.input)) {
        for (const text of body.input) embeddingCalls.push(text);
        const embeddings = body.input.map(() => Array.from({ length: 768 }, () => 0.1));
        return new Response(JSON.stringify({ embeddings }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 400 });
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dryrun-indexer-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    // AST-parsed file: one function chunk.
    fs.writeFileSync(path.join(tempDir, "src", "alpha.ts"), "export function alpha() { return 1; }\n", "utf-8");
    // More AST chunks than maxChunksPerFile so the fallback-to-text path runs
    // (parseFileAsText -> chunk_by_lines) and selectIndexableChunks caps it.
    fs.writeFileSync(
      path.join(tempDir, "src", "big.ts"),
      [
        "export function a() { return 1; }",
        "export function b() { return 2; }",
        "export function c() { return 3; }",
        "export function d() { return 4; }",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createIndexer(): Indexer {
    const config = parseConfig({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
        maxChunksPerFile: 2,
        fallbackToTextOnMaxChunks: true,
        linesPerChunk: 3,
      },
    });
    const indexer = new Indexer(tempDir, config, "opencode");
    _indexers.push(indexer);
    return indexer;
  }

  it("does not call the embedding provider and leaves the index unindexed", async () => {
    const indexer = createIndexer();
    const dryRun = await indexer.dryRunCost();

    expect(embeddingCalls.length).toBe(0);
    expect(dryRun.filesCount).toBeGreaterThanOrEqual(2);
    expect(dryRun.chunksCount).toBeGreaterThan(0);
    expect(dryRun.tokensToEmbed).toBeGreaterThan(0);

    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
  });

  it("matches a force-index token total for an estimate-based provider (ollama)", async () => {
    const indexer = createIndexer();
    const dryRun = await indexer.dryRunCost();

    const stats = await indexer.forceIndex();

    expect(embeddingCalls.length).toBeGreaterThan(0);
    // ollama reports ceil(len/4) per embedded text, the same basis dryRunCost
    // sums, so a force index (cache cleared) climbs to exactly this total.
    expect(stats.tokensUsed).toBe(dryRun.tokensToEmbed);
    expect(stats.indexedChunks).toBe(dryRun.chunksCount);
  });

  it("is idempotent and writes no embeddings across repeated calls", async () => {
    const indexer = createIndexer();
    const first = await indexer.dryRunCost();
    const second = await indexer.dryRunCost();

    expect(second).toEqual(first);
    expect(embeddingCalls.length).toBe(0);

    const status = await indexer.getStatus();
    expect(status.indexed).toBe(false);
  });

  it("counts a source chunk once even when it splits into multiple embedding texts", async () => {
    // One exported function whose body is a >6100-char string: a single source
    // chunk whose embedding text exceeds nomic-embed-text's maxChunkTokens
    // (1536 -> maxContentChars ~6100), so createEmbeddingTexts splits it into
    // multiple embedding texts.
    fs.writeFileSync(
      path.join(tempDir, "src", "huge.ts"),
      `export function huge() { return "${"x".repeat(7000)}"; }\n`,
      "utf-8",
    );
    const indexer = createIndexer();
    const dryRun = await indexer.dryRunCost();

    const stats = await indexer.forceIndex();

    // chunksCount counts source chunks (like indexedChunks), not embedding texts,
    // so it still matches after a chunk splits.
    expect(stats.indexedChunks).toBe(dryRun.chunksCount);
    // tokens are summed per embedding text, so the token totals still match.
    expect(stats.tokensUsed).toBe(dryRun.tokensToEmbed);
    // The oversized chunk split: more embedding requests than source chunks.
    expect(embeddingCalls.length).toBeGreaterThan(dryRun.chunksCount);
  });
});