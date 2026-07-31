import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { readFailedBatchRecords } from "../src/indexer/failed-state-persistence.js";
import { Indexer, type IndexProgress } from "../src/indexer/index.js";

function writeMultiBatchFixture(projectDir: string): void {
  const sourceDir = path.join(projectDir, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "shared-early.ts"),
    "export function sharedAcrossBatches() { return 7; }\n",
    "utf-8",
  );

  for (let index = 0; index < 63; index++) {
    fs.writeFileSync(
      path.join(sourceDir, `filler-${index.toString().padStart(2, "0")}.ts`),
      `export function filler${index}() { return ${index}; }\n// ${"x".repeat(100 + index)}\n`,
      "utf-8",
    );
  }

  const lateFile = path.join(sourceDir, "shared-late.ts");
  fs.writeFileSync(
    lateFile,
    [
      "export function sharedAcrossBatches() { return 7; }",
      "export function lateOnlyMarker() { return 99; }",
      `// ${"z".repeat(10_000)}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function expectMonotonic(values: number[]): void {
  for (let index = 1; index < values.length; index++) {
    expect(values[index]).toBeGreaterThanOrEqual(values[index - 1] ?? 0);
  }
}

describe("bounded file-level indexing integration", () => {
  let projectDir: string;
  let indexDir: string;
  let indexer: Indexer;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-file-batches-project-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "index-file-batches-index-"));
  });

  afterEach(async () => {
    await indexer?.close();
    fetchSpy?.mockRestore();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  function createIndexer(): Indexer {
    return new Indexer(projectDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "bounded-batch-test-model",
        dimensions: 8,
        maxBatchSize: 128,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
        autoGc: false,
      },
    }), "opencode", { indexPath: indexDir });
  }

  it("keeps progress cumulative and reuses duplicate embeddings across file batches", async () => {
    writeMultiBatchFixture(projectDir);
    const embeddedTexts: string[] = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = body.input ?? [];
      embeddedTexts.push(...texts);
      return new Response(JSON.stringify({
        data: texts.map((_text, itemIndex) => ({
          embedding: Array.from({ length: 8 }, (_, dimension) => (itemIndex + dimension + 1) / 10),
        })),
        usage: { total_tokens: Math.max(1, texts.length) },
      }), { status: 200 });
    });
    indexer = createIndexer();

    const progress: IndexProgress[] = [];
    const stats = await indexer.index((entry) => progress.push({ ...entry }));

    const parsingFiles = progress
      .filter((entry) => entry.phase === "parsing" && entry.filesProcessed > 0)
      .map((entry) => entry.filesProcessed);
    expect(parsingFiles).toContain(64);
    expect(parsingFiles.at(-1)).toBe(65);

    const embeddingProgress = progress.filter((entry) => entry.phase === "embedding");
    expect(embeddingProgress.length).toBeGreaterThan(1);
    expectMonotonic(embeddingProgress.map((entry) => entry.chunksProcessed));
    expectMonotonic(embeddingProgress.map((entry) => entry.totalChunks));
    expect(progress.at(-1)).toMatchObject({
      phase: "complete",
      chunksProcessed: stats.indexedChunks,
      totalChunks: stats.totalChunks,
    });

    expect(embeddedTexts.filter((text) => text.includes("sharedAcrossBatches"))).toHaveLength(1);
    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBe(stats.totalChunks);
  });

  it("flushes outage failures before the next file batch and streams them through retry", async () => {
    writeMultiBatchFixture(projectDir);
    let outage = true;
    let failedRecordsBeforeLateBatch = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = body.input ?? [];
      if (outage) {
        if (texts.some((text) => text.includes("shared-late.ts"))) {
          const temporaryState = fs.readdirSync(indexDir)
            .find((entry) => entry.startsWith(".failed-batches") && entry.endsWith(".tmp"));
          if (temporaryState) {
            failedRecordsBeforeLateBatch = fs.readFileSync(path.join(indexDir, temporaryState), "utf-8")
              .split("\n")
              .filter((line) => line.length > 0)
              .length;
          }
        }
        return new Response(JSON.stringify({ error: "provider unavailable" }), { status: 503 });
      }

      return new Response(JSON.stringify({
        data: texts.map((_text, itemIndex) => ({
          embedding: Array.from({ length: 8 }, (_, dimension) => (itemIndex + dimension + 1) / 10),
        })),
        usage: { total_tokens: Math.max(1, texts.length) },
      }), { status: 200 });
    });
    indexer = createIndexer();

    const failedStats = await indexer.index();
    const failedBatchesPath = path.join(indexDir, "failed-batches.json");
    const records = Array.from(readFailedBatchRecords<{ id: string }>(failedBatchesPath));
    const failedChunkIds = new Set(records.flatMap((record) => record.chunks.map((chunk) => chunk.id)));

    expect(failedRecordsBeforeLateBatch).toBeGreaterThan(0);
    expect(records.length).toBeGreaterThan(64);
    expect(records.every((record) => record.chunks.length === 1)).toBe(true);
    expect(failedChunkIds.size).toBe(failedStats.failedChunks);
    expect(fs.readFileSync(failedBatchesPath, "utf-8").trimStart().startsWith("[")).toBe(false);

    outage = false;
    const retry = await indexer.retryFailedBatches();

    expect(retry).toEqual({
      succeeded: failedChunkIds.size,
      failed: 0,
      remaining: 0,
    });
    expect(fs.existsSync(failedBatchesPath)).toBe(false);
  });
});
