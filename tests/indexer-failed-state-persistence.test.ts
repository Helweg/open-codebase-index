import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFailedBatchWriter,
  readFailedBatchRecords,
  type FailedBatchReadOptions,
  type FailedBatchRecord,
  type FailedBatchRecordInput,
  writeFailedBatchRecords,
} from "../src/indexer/failed-state-persistence.js";

interface FixtureChunk {
  id: string;
  text: string;
}

function makeChunk(id: string, text = `chunk-${id}`): FixtureChunk {
  return { id, text };
}

function nowIso(): string {
  return "2026-07-31T00:00:00.000Z";
}

async function collectFailedBatches<TChunk>(
  filePath: string,
  options?: FailedBatchReadOptions,
): Promise<FailedBatchRecord<TChunk>[]> {
  const result: FailedBatchRecord<TChunk>[] = [];
  for await (const batch of readFailedBatchRecords<TChunk>(filePath, options)) {
    result.push(batch);
  }
  return result;
}

describe("failed state persistence utility", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-state-persistence-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips failed batches through versioned JSONL", async () => {
    const failedBatchesPath = path.join(tempDir, "failed-batches.json");
    const writer = createFailedBatchWriter<FixtureChunk>(failedBatchesPath);

    const recordA: FailedBatchRecordInput<FixtureChunk> = {
      chunks: [makeChunk("a", "alpha")],
      error: "rate limited",
      attemptCount: 1,
      lastAttempt: nowIso(),
    };
    const recordB: FailedBatchRecordInput<FixtureChunk> = {
      chunks: [makeChunk("b", "beta"), makeChunk("c", "gamma")],
      error: "overloaded",
      attemptCount: 2,
      lastAttempt: nowIso(),
    };

    writer.write(recordA);
    writer.write(recordB);
    writer.commit();

    const records = await collectFailedBatches<FixtureChunk>(failedBatchesPath);

    expect(records).toHaveLength(3);
    expect(records).toEqual([
      {
        version: 1,
        chunks: [makeChunk("a", "alpha")],
        error: "rate limited",
        attemptCount: 1,
        lastAttempt: nowIso(),
      },
      {
        version: 1,
        chunks: [makeChunk("b", "beta")],
        error: "overloaded",
        attemptCount: 2,
        lastAttempt: nowIso(),
      },
      {
        version: 1,
        chunks: [makeChunk("c", "gamma")],
        error: "overloaded",
        attemptCount: 2,
        lastAttempt: nowIso(),
      },
    ]);
  });

  it("reads legacy failed-batch JSON arrays with backward compatibility", async () => {
    const failedBatchesPath = path.join(tempDir, "failed-batches.json");
    fs.writeFileSync(
      failedBatchesPath,
      JSON.stringify([
        {
          chunks: [makeChunk("legacy", "legacy")],
          error: "legacy failure",
          attemptCount: 4,
          lastAttempt: "2010-01-01T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );

    const records = await collectFailedBatches<FixtureChunk>(failedBatchesPath);

    expect(records).toEqual([
      {
        version: 1,
        chunks: [makeChunk("legacy", "legacy")],
        error: "legacy failure",
        attemptCount: 4,
        lastAttempt: "2010-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("supports malformed-line handling policies", async () => {
    const failedBatchesPath = path.join(tempDir, "failed-batches.json");
    const validLine = JSON.stringify({
      version: 1,
      chunks: [makeChunk("valid")],
      error: "retryable",
      attemptCount: 1,
      lastAttempt: nowIso(),
    });

    fs.writeFileSync(
      failedBatchesPath,
      [validLine, "{ nope", validLine].join("\n"),
      "utf-8",
    );

    const callbacks: string[] = [];
    const skipped = await collectFailedBatches<FixtureChunk>(failedBatchesPath, {
      malformedLineAction: "skip",
      onMalformedLine: (error) => {
        callbacks.push(error.message);
      },
    });
    expect(skipped).toHaveLength(2);
    expect(callbacks).toHaveLength(1);

    await expect(
      collectFailedBatches<FixtureChunk>(failedBatchesPath, {
        malformedLineAction: "fail",
      }),
    ).rejects.toBeInstanceOf(Error);

    const fatalCallbacks: string[] = [];
    await expect(
      collectFailedBatches<FixtureChunk>(failedBatchesPath, {
        malformedLineAction: "fail",
        onMalformedLine: (error) => {
          fatalCallbacks.push(error.message);
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(fatalCallbacks).toHaveLength(1);
  });

  it("uses atomic temp-file replacement with cleanup helpers", async () => {
    const failedBatchesPath = path.join(tempDir, "failed-batches.json");
    fs.writeFileSync(failedBatchesPath, JSON.stringify({ stale: true }), "utf-8");

    const writer = createFailedBatchWriter<FixtureChunk>(failedBatchesPath);
    writer.write({
      chunks: [makeChunk("committed", "committed")],
      error: "replace me",
      attemptCount: 1,
      lastAttempt: nowIso(),
    });
    writer.commit();

    expect(writer.temporaryPath).not.toBe(failedBatchesPath);
    expect(fs.existsSync(writer.temporaryPath)).toBe(false);

    const committedText = fs.readFileSync(failedBatchesPath, "utf-8");
    expect(committedText).toContain("\"replace me\"");
    expect(committedText).toContain("\"version\":1");

    const abortedWriter = createFailedBatchWriter<FixtureChunk>(failedBatchesPath);
    abortedWriter.write({
      chunks: [makeChunk("aborted", "aborted")],
      error: "aborted",
      attemptCount: 1,
      lastAttempt: nowIso(),
    });
    const snapshot = fs.readFileSync(failedBatchesPath, "utf-8");
    abortedWriter.cleanup();

    expect(fs.existsSync(abortedWriter.temporaryPath)).toBe(false);
    expect(fs.readFileSync(failedBatchesPath, "utf-8")).toBe(snapshot);
  });

  it("streams a large fixture without materializing an array result", async () => {
    const failedBatchesPath = path.join(tempDir, "failed-batches.json");
    const largeText = "payload".repeat(200_000);

    const writer = createFailedBatchWriter<FixtureChunk>(failedBatchesPath);
    writer.write({
      chunks: [makeChunk("large", largeText)],
      error: "large payload",
      attemptCount: 1,
      lastAttempt: nowIso(),
    });
    writer.write({
      chunks: [makeChunk("small", "small")],
      error: "small payload",
      attemptCount: 1,
      lastAttempt: nowIso(),
    });
    writer.commit();

    const iterator = readFailedBatchRecords<FixtureChunk>(failedBatchesPath);
    expect(Symbol.iterator in iterator).toBe(true);

    let seen = 0;
    for await (const batch of iterator) {
      expect((batch.chunks[0] as FixtureChunk).text).toBe(largeText);
      seen += 1;
      break;
    }

    expect(seen).toBe(1);

    const all = await collectFailedBatches<FixtureChunk>(failedBatchesPath);
    expect(all).toHaveLength(2);
  });

  it("replaces an entire file from an iterable of batches", async () => {
    const failedBatchesPath = path.join(tempDir, "failed-batches.json");
    writeFailedBatchRecords(failedBatchesPath, [
      {
        chunks: [makeChunk("iter", "iter")],
        error: "iterative",
        attemptCount: 1,
        lastAttempt: nowIso(),
      },
    ]);

    const all = await collectFailedBatches<FixtureChunk>(failedBatchesPath);
    expect(all).toHaveLength(1);
    expect(all[0]?.chunks[0]?.id).toBe("iter");
  });
});
