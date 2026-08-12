import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { readFailedBatchRecords } from "../src/indexer/failed-state-persistence.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, hashContent } from "../src/native/index.js";

function writeSourceFile(filePath: string, functionNames: string[]): void {
  fs.writeFileSync(
    filePath,
    functionNames.map((name, index) => (
      `export function ${name}() {\n` +
      `  const value = ${index};\n` +
      `  return value * 2;\n` +
      `}\n`
    )).join("\n"),
    "utf8",
  );
}

function countEmbeddedTexts(fetchSpy: ReturnType<typeof vi.spyOn>, fromCall = 0): number {
  let total = 0;
  for (let index = fromCall; index < fetchSpy.mock.calls.length; index++) {
    const body = JSON.parse(String(fetchSpy.mock.calls[index][1]?.body ?? "{}")) as { input?: string[] };
    total += body.input?.length ?? 0;
  }
  return total;
}

function canonicalPath(filePath: string): string {
  return fs.realpathSync.native(filePath);
}

function projectIdentityHash(projectRoot: string): string {
  return hashContent(canonicalPath(projectRoot)).slice(0, 16);
}

describe("indexer checkpoint resume", () => {
  let projectDir: string;
  let indexDir: string;
  let indexers: Indexer[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let failEmbeddingText: string | null;

  function createIndexer(checkpointIntervalChunks?: number, indexPath = indexDir): Indexer {
    const indexer = new Indexer(projectDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "checkpoint-test-model",
        dimensions: 8,
        maxBatchSize: 8,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        autoGc: false,
      },
    }), "opencode", {
      indexPath,
      checkpointIntervalChunks,
      // One file per batch so every batch triggers a checkpoint with
      // checkpointIntervalChunks: 1.
      fileBatchLimits: { maxFiles: 1, maxBytes: 8 * 1024 * 1024 },
    });
    indexers.push(indexer);
    return indexer;
  }

  function createGlobalIndexer(projectRoot: string, model: string, kbDir: string): Indexer {
    const indexer = new Indexer(projectRoot, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model,
        dimensions: 8,
        maxBatchSize: 8,
        concurrency: 1,
        requestIntervalMs: 0,
      },
      scope: "global",
      knowledgeBases: [kbDir],
      indexing: {
        watchFiles: false,
        retries: 0,
        autoGc: false,
      },
    }), "opencode", {
      indexPath: indexDir,
      checkpointIntervalChunks: 1,
      fileBatchLimits: { maxFiles: 1, maxBytes: 8 * 1024 * 1024 },
    });
    indexers.push(indexer);
    return indexer;
  }

  function setupGlobalScope(): { projectBDir: string; kbDir: string } {
    const projectBDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-project-b-"));
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-kb-"));
    const projectAFile = path.join(projectDir, "src", "alpha.ts");
    const projectBFile = path.join(projectBDir, "src", "beta.ts");
    const kbFile = path.join(kbDir, "docs", "shared.ts");
    fs.mkdirSync(path.dirname(projectBFile), { recursive: true });
    fs.mkdirSync(path.dirname(kbFile), { recursive: true });
    writeSourceFile(projectAFile, ["alphaOne", "alphaTwo"]);
    writeSourceFile(projectBFile, ["betaOne", "betaTwo"]);
    writeSourceFile(kbFile, ["sharedOne", "sharedTwo"]);
    return { projectBDir, kbDir };
  }

  beforeEach(() => {
    failEmbeddingText = null;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-project-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-index-"));
    indexers = [];
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = body.input ?? [];
      if (failEmbeddingText !== null && texts.some((text) => text.includes(failEmbeddingText))) {
        return new Response(JSON.stringify({ error: "simulated embedding failure" }), { status: 500 });
      }
      return new Response(JSON.stringify({
        data: texts.map((_text, index) => ({
          embedding: Array.from({ length: 8 }, (_, dimension) => (index + dimension + 1) / 10),
        })),
        usage: { total_tokens: Math.max(1, texts.length) },
      }), { status: 200 });
    });
  });

  afterEach(async () => {
    await Promise.all(indexers.map((indexer) => indexer.close()));
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("interrupted run after a checkpoint resumes incrementally", async () => {
    const indexer = createIndexer(1);
    const sourceFiles = [
      path.join(projectDir, "src", "alpha.ts"),
      path.join(projectDir, "src", "beta.ts"),
      path.join(projectDir, "src", "gamma.ts"),
    ];
    for (const [fileIndex, filePath] of sourceFiles.entries()) {
      writeSourceFile(
        filePath,
        ["first", "second", "third", "fourth", "fifth", "sixth"].map((name) => `${name}${fileIndex}`),
      );
    }

    // The embedding progress for the last batch fires after every previous
    // batch has been checkpointed, so throwing there interrupts the run with
    // the first two batches already durable.
    await expect(indexer.index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === progress.totalFiles) {
        throw new Error("simulated interruption after checkpoint");
      }
    })).rejects.toThrow("simulated interruption after checkpoint");

    const databasePath = path.join(indexDir, "codebase.db");
    const fileHashesPath = path.join(indexDir, "file-hashes.json");

    // The batch order is not guaranteed, so derive the committed files from
    // the partial hash cache: exactly two files were checkpointed before the
    // interruption, and the third remains pending.
    const partialHashes = JSON.parse(fs.readFileSync(fileHashesPath, "utf-8")) as Record<string, string>;
    const committedFiles = Object.keys(partialHashes);
    expect(committedFiles.length).toBe(2);
    const pendingFiles = sourceFiles
      .map((filePath) => path.relative(projectDir, filePath))
      .filter((filePath) => !committedFiles.includes(filePath));
    expect(pendingFiles.length).toBe(1);

    const after = Database.openReadOnly(databasePath);
    let committedChunks = 0;
    try {
      for (const filePath of committedFiles) {
        const chunks = after.getChunksByFile(filePath);
        expect(chunks.length).toBeGreaterThan(0);
        committedChunks += chunks.length;
      }
      expect(after.getChunksByFile(pendingFiles[0])).toEqual([]);
    } finally {
      after.close();
    }

    expect(fs.existsSync(path.join(indexDir, "vectors"))).toBe(true);

    const callsAfterRun1 = fetchSpy.mock.calls.length;
    const run1EmbeddedTexts = countEmbeddedTexts(fetchSpy, 0);

    const run2Stats = await indexer.index();
    expect(run2Stats.failedChunks).toBe(0);

    const run2EmbeddedTexts = countEmbeddedTexts(fetchSpy, callsAfterRun1);
    expect(run2EmbeddedTexts).toBeGreaterThan(0);
    expect(run2EmbeddedTexts).toBeLessThan(run1EmbeddedTexts);
    expect(run2Stats.indexedChunks).toBe(run2EmbeddedTexts);
    expect(run2Stats.existingChunks).toBe(committedChunks);

    const finalHashes = JSON.parse(fs.readFileSync(fileHashesPath, "utf-8")) as Record<string, string>;
    for (const filePath of [...committedFiles, ...pendingFiles]) {
      expect(finalHashes[filePath]).toBeDefined();
    }

    const finalDb = Database.openReadOnly(databasePath);
    try {
      for (const filePath of [...committedFiles, ...pendingFiles]) {
        expect(finalDb.getChunksByFile(filePath).length).toBeGreaterThan(0);
      }
    } finally {
      finalDb.close();
    }
  });

  it("checkpoint persists failed batches", async () => {
    const indexer = createIndexer(1);
    const sourceFiles = [
      path.join(projectDir, "src", "alpha.ts"),
      path.join(projectDir, "src", "beta.ts"),
      path.join(projectDir, "src", "gamma.ts"),
    ];
    // The batch order is not guaranteed, so every file contains a failing
    // chunk: whichever files are checkpointed before the interruption carry a
    // persisted failure record.
    writeSourceFile(
      sourceFiles[0],
      ["first", "second", "triggerFailure", "fourth", "fifth", "sixth"].map((name) => `${name}0`),
    );
    writeSourceFile(
      sourceFiles[1],
      ["first", "second", "triggerFailure", "fourth", "fifth", "sixth"].map((name) => `${name}1`),
    );
    writeSourceFile(
      sourceFiles[2],
      ["first", "second", "triggerFailure", "fourth", "fifth", "sixth"].map((name) => `${name}2`),
    );

    failEmbeddingText = "triggerFailure";
    await expect(indexer.index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === progress.totalFiles) {
        throw new Error("simulated interruption after failed batch checkpoint");
      }
    })).rejects.toThrow("simulated interruption after failed batch checkpoint");

    const failedBatchesPath = path.join(indexDir, "failed-batches.json");
    expect(fs.existsSync(failedBatchesPath)).toBe(true);
    const persistedChunks = Array.from(readFailedBatchRecords<{ content?: string }>(failedBatchesPath))
      .flatMap((record) => record.chunks);
    expect(persistedChunks.length).toBeGreaterThan(0);
    expect(persistedChunks.some((chunk) => chunk.content?.includes("triggerFailure"))).toBe(true);

    failEmbeddingText = null;
    const callsBeforeRun2 = fetchSpy.mock.calls.length;
    const run2Stats = await indexer.index();
    expect(run2Stats.failedChunks).toBe(0);
    expect(run2Stats.indexedChunks).toBeGreaterThan(0);

    const run2Texts = fetchSpy.mock.calls.slice(callsBeforeRun2).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(run2Texts.some((text) => text.includes("triggerFailure"))).toBe(true);
    expect(fs.existsSync(failedBatchesPath)).toBe(false);

    const finalDb = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      for (const filePath of ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]) {
        expect(finalDb.getChunksByFile(filePath).length).toBeGreaterThan(0);
      }
    } finally {
      finalDb.close();
    }
  });

  it("full run result is unchanged by checkpoints", async () => {
    const sourceFiles = [
      path.join(projectDir, "src", "alpha.ts"),
      path.join(projectDir, "src", "beta.ts"),
      path.join(projectDir, "src", "gamma.ts"),
    ];
    for (const [fileIndex, filePath] of sourceFiles.entries()) {
      writeSourceFile(
        filePath,
        ["first", "second", "third", "fourth", "fifth", "sixth"].map((name) => `${name}${fileIndex}`),
      );
    }

    const checkpointedIndexDir = path.join(indexDir, "checkpointed");
    const plainIndexDir = path.join(indexDir, "plain");
    fs.mkdirSync(checkpointedIndexDir, { recursive: true });
    fs.mkdirSync(plainIndexDir, { recursive: true });

    const checkpointedIndexer = createIndexer(1, checkpointedIndexDir);
    const plainIndexer = createIndexer(undefined, plainIndexDir);

    const checkpointedStats = await checkpointedIndexer.index();
    const plainStats = await plainIndexer.index();

    expect(checkpointedStats.totalChunks).toBe(plainStats.totalChunks);
    expect(checkpointedStats.indexedChunks).toBe(plainStats.indexedChunks);
    expect(checkpointedStats.existingChunks).toBe(plainStats.existingChunks);
    expect(checkpointedStats.removedChunks).toBe(plainStats.removedChunks);
    expect(checkpointedStats.failedChunks).toBe(plainStats.failedChunks);
    expect(checkpointedStats.tokensUsed).toBe(plainStats.tokensUsed);

    const checkpointedDb = Database.openReadOnly(path.join(checkpointedIndexDir, "codebase.db"));
    const plainDb = Database.openReadOnly(path.join(plainIndexDir, "codebase.db"));
    try {
      expect(checkpointedDb.getStats()).toEqual(plainDb.getStats());
      for (const filePath of ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]) {
        expect(checkpointedDb.getChunksByFile(filePath)).toEqual(plainDb.getChunksByFile(filePath));
      }
    } finally {
      checkpointedDb.close();
      plainDb.close();
    }
  });

  it("interrupted forced re-embed run keeps migration pending and re-embeds every scope file on resume", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    const db = new Database(path.join(indexDir, "codebase.db"));
    const projectAHash = projectIdentityHash(projectDir);
    db.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");

    const resettingIndexer = createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir);
    await resettingIndexer.clearIndex();
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBe("true");

    // Interrupt the forced re-embed run right after its first checkpoint.
    await expect(createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === 1) {
        throw new Error("simulated interruption during forced re-embed");
      }
    })).rejects.toThrow("simulated interruption during forced re-embed");

    // The checkpoint must not clear the migration flag: the store is still
    // partially migrated.
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBe("true");

    // Resuming without force re-runs the migration and re-embeds every scope
    // file, including the ones whose hashes were already checkpointed.
    const beforeResumeCalls = fetchSpy.mock.calls.length;
    const resumedStats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(resumedStats.failedChunks).toBe(0);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();

    const resumeInputs = fetchSpy.mock.calls.slice(beforeResumeCalls).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(resumeInputs.some((text) => text.includes("alphaOne"))).toBe(true);
    expect(resumeInputs.some((text) => text.includes("sharedOne"))).toBe(true);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("forced re-embed run re-embeds unchanged scope files while migration is pending", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    const db = new Database(path.join(indexDir, "codebase.db"));
    const projectAHash = projectIdentityHash(projectDir);
    // Simulate a pending migration whose scope files are already cached: the
    // run must still re-embed them instead of skipping them as unchanged.
    db.setMetadata(`index.forceReembed.${projectAHash}`, "true");

    const beforeCalls = fetchSpy.mock.calls.length;
    const stats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();

    const migrationInputs = fetchSpy.mock.calls.slice(beforeCalls).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(migrationInputs.some((text) => text.includes("alphaOne"))).toBe(true);
    expect(migrationInputs.some((text) => text.includes("sharedOne"))).toBe(true);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
});
