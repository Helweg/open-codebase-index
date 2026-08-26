import { spawnSync } from "node:child_process";
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

  function getClearRecoveryState(
    model = "checkpoint-test-model",
    compatibilityDecision: "compatible" | "embedding-strategy-mismatch" | "incompatible" = "compatible",
  ): {
    phase: "clearing";
    embeddingProvider: "custom";
    embeddingModel: string;
    embeddingDimensions: number;
    embeddingStrategyVersion: string;
    compatibilityDecision: "compatible" | "embedding-strategy-mismatch" | "incompatible";
  } {
    return {
      phase: "clearing",
      embeddingProvider: "custom",
      embeddingModel: model,
      embeddingDimensions: 8,
      embeddingStrategyVersion: "2",
      compatibilityDecision,
    };
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

  it("interrupted run on an existing branch keeps checkpointed chunks in the branch catalog after resume", async () => {
    const indexer = createIndexer(1);
    const alphaFile = path.join(projectDir, "src", "alpha.ts");
    writeSourceFile(alphaFile, ["alphaOne", "alphaTwo"]);

    // Full initial index publishes the branch catalog.
    await indexer.index();

    // Add two new files and interrupt the run after the first checkpoint.
    const betaFile = path.join(projectDir, "src", "beta.ts");
    const gammaFile = path.join(projectDir, "src", "gamma.ts");
    writeSourceFile(betaFile, ["betaOne", "betaTwo"]);
    writeSourceFile(gammaFile, ["gammaOne", "gammaTwo"]);
    await expect(indexer.index((progress) => {
      // `totalFiles` covers the indexed project, including unchanged alpha.
      // Interrupt after the first newly indexed file checkpoint instead.
      if (progress.phase === "embedding" && progress.filesProcessed === 1) {
        throw new Error("simulated interruption after new-file checkpoint");
      }
    })).rejects.toThrow("simulated interruption after new-file checkpoint");

    // The checkpointed file's chunks must survive in the branch catalog after
    // the resume, even though the file itself is skipped as unchanged.
    const resumedStats = await indexer.index();
    expect(resumedStats.failedChunks).toBe(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      const branchChunkIds = new Set(db.getBranchChunkIds("default"));
      for (const filePath of ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]) {
        const chunks = db.getChunksByFile(filePath);
        expect(chunks.length).toBeGreaterThan(0);
        for (const chunk of chunks) {
          expect(branchChunkIds.has(chunk.chunkId)).toBe(true);
        }
      }
      const branchSymbolIds = new Set(db.getBranchSymbolIds("default"));
      for (const filePath of ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]) {
        for (const symbol of db.getSymbolsByFile(filePath)) {
          expect(branchSymbolIds.has(symbol.id)).toBe(true);
        }
      }
    } finally {
      db.close();
    }
  });

  it("interrupted run with a modified file re-processes it on resume", async () => {
    const indexer = createIndexer(1);
    const alphaFile = path.join(projectDir, "src", "alpha.ts");
    writeSourceFile(alphaFile, ["alphaOne", "alphaTwo"]);

    await indexer.index();

    // Modify the file and add a new one; interrupt after the first checkpoint.
    writeSourceFile(alphaFile, ["alphaOne", "alphaThree"]);
    const betaFile = path.join(projectDir, "src", "beta.ts");
    writeSourceFile(betaFile, ["betaOne", "betaTwo"]);
    await expect(indexer.index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === progress.totalFiles) {
        throw new Error("simulated interruption after modified-file checkpoint");
      }
    })).rejects.toThrow("simulated interruption after modified-file checkpoint");

    // A modified file with stale chunks to evict must not be checkpointed.
    const fileHashesPath = path.join(indexDir, "file-hashes.json");
    const partialHashes = JSON.parse(fs.readFileSync(fileHashesPath, "utf-8")) as Record<string, string>;
    expect(partialHashes["src/alpha.ts"]).toBeUndefined();

    // The resume re-processes it and evicts the removed chunk.
    const resumedStats = await indexer.index();
    expect(resumedStats.failedChunks).toBe(0);
    expect(resumedStats.removedChunks).toBeGreaterThan(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      const chunks = db.getChunksByFile("src/alpha.ts");
      expect(chunks.some((chunk) => chunk.name === "alphaTwo")).toBe(false);
      expect(chunks.some((chunk) => chunk.name === "alphaThree")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("global lease recovery invalidates the hash cache after an interrupted clear", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    // Simulate a crashed clear: an orphaned lease owned by a dead pid.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "clear",
      token: "11111111-1111-4111-8111-111111111111",
      recoveryProtocolVersion: 1,
      projectRoot: projectDir,
      scopedRoots: [canonicalPath(projectDir), canonicalPath(kbDir)],
      clearRecovery: getClearRecoveryState(),
    }));

    const fileHashesPath = path.join(indexDir, "file-hashes.json");
    expect(fs.existsSync(fileHashesPath)).toBe(true);

    // A crashed clear wipes the store and inverted index before the hash cache
    // (clearIndexUnlocked order): simulate that partial state so the next run
    // would otherwise skip every file against an empty store.
    for (const artifact of ["vectors", "vectors.usearch", "vectors.meta.json", "inverted-index.json"]) {
      fs.rmSync(path.join(indexDir, artifact), { recursive: true, force: true });
    }

    // The recovery must invalidate the cache after an interrupted clear so the
    // next run re-embeds instead of skipping files against an empty store.
    const beforeCalls = fetchSpy.mock.calls.length;
    const stats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(beforeCalls);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("global lease recovery preserves the checkpointed hash cache", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    // Simulate a crashed indexing session: an orphaned lease owned by a dead pid.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "11111111-1111-4111-8111-111111111111",
    }));

    const fileHashesPath = path.join(indexDir, "file-hashes.json");
    expect(fs.existsSync(fileHashesPath)).toBe(true);

    // The recovery must keep the checkpointed hash cache: unchanged files are
    // skipped instead of being re-parsed and re-embedded.
    const beforeCalls = fetchSpy.mock.calls.length;
    const stats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    expect(fs.existsSync(fileHashesPath)).toBe(true);
    expect(fetchSpy.mock.calls.length).toBe(beforeCalls);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("retryFailedBatches does not close an interrupted strategy migration", async () => {
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

    // Interrupt the forced re-embed run after its first checkpoint, with a
    // failing chunk so the run leaves failed batches behind.
    failEmbeddingText = "One";
    await expect(createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === 1) {
        throw new Error("simulated interruption during forced re-embed");
      }
    })).rejects.toThrow("simulated interruption during forced re-embed");

    // The retry recovers the failed chunks but must not close the migration:
    // the main run never finished, so unprocessed scope files still hold old
    // vectors.
    failEmbeddingText = null;
    const retry = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).retryFailedBatches();
    expect(retry.remaining).toBe(0);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBe("true");

    // A full run completes the migration and clears the flag.
    const stats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBeNull();

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
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

  it("checkpoint preserves out-of-scope failed batches for later retries", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    // Project A leaves a failed batch behind.
    failEmbeddingText = "One";
    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    const failedBatchesPath = path.join(indexDir, "failed-batches.json");
    expect(fs.existsSync(failedBatchesPath)).toBe(true);

    // Project B's run checkpoints and must not drop A's failed batch.
    failEmbeddingText = null;
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();
    expect(fs.existsSync(failedBatchesPath)).toBe(true);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("checkpoint preserves pending retries alongside new failures", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    // Project A leaves a failed batch behind.
    failEmbeddingText = "One";
    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();

    // A second run checkpoints a new failure while the old retry is still
    // pending: the retry must survive the checkpoint and be re-attempted.
    writeSourceFile(path.join(kbDir, "docs", "shared.ts"), ["sharedOne", "sharedTwo", "sharedThree"]);
    failEmbeddingText = "Three";
    const beforeCalls = fetchSpy.mock.calls.length;
    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    const retryInputs = fetchSpy.mock.calls.slice(beforeCalls).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(retryInputs.some((text) => text.includes("alphaOne"))).toBe(true);

    // The resolved retry must not be republished in the final failed-batches
    // file: only the new failure remains.
    const persisted = fs.readFileSync(path.join(indexDir, "failed-batches.json"), "utf-8");
    expect(persisted).toContain("sharedThree");
    expect(persisted).not.toContain("alphaOne");

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("interrupted force-index run resumes from checkpoints instead of clearing", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    // The force-index clear phase completes, then the indexing phase is
    // interrupted after the first file is checkpointed.
    await expect(createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).forceIndex((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === 2) {
        throw new Error("simulated interruption during force-index");
      }
    })).rejects.toThrow("simulated interruption during force-index");

    // Simulate a crash during the indexing phase: an orphaned "force-index"
    // lease with no clearing-phase marker left behind.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "force-index",
      token: "11111111-1111-4111-8111-111111111111",
    }));

    // The recovery must not clear the checkpointed data: the next run resumes
    // incrementally instead of re-embedding the already checkpointed file.
    const beforeCalls = fetchSpy.mock.calls.length;
    const stats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    const resumeInputs = fetchSpy.mock.calls.slice(beforeCalls).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(resumeInputs.some((text) => text.includes("sharedOne"))).toBe(true);
    expect(resumeInputs.some((text) => text.includes("alphaOne"))).toBe(false);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("checkpoint persists the keyword index before vectors so a crash cannot orphan BM25 chunks", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    // Interrupt the first run between the vector store save and the keyword
    // index save: with the keyword index persisted first, the store is not yet
    // durable and the resume re-embeds, keeping BM25 complete.
    const invertedSave = vi.spyOn(
      Indexer.prototype as unknown as { saveInvertedIndex: () => void },
      "saveInvertedIndex",
    ).mockImplementation(() => {
      throw new Error("simulated crash between artifact writes");
    });
    await expect(createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index()).rejects.toThrow(
      "simulated crash between artifact writes",
    );
    invertedSave.mockRestore();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    const inverted = fs.readFileSync(path.join(indexDir, "inverted-index.json"), "utf-8");
    expect(inverted).toContain("alphaone");

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("project-scope dead-lease recovery preserves checkpoints for incremental resume", async () => {
    const projectOwnedIndex = path.join(projectDir, ".opencode", "index");
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

    // Interrupt after two files are checkpointed.
    const indexer = createIndexer(1, projectOwnedIndex);
    await expect(indexer.index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === progress.totalFiles) {
        throw new Error("simulated crash after checkpoint");
      }
    })).rejects.toThrow("simulated crash after checkpoint");

    // Simulate a dead "index" lease (not "clear" or "force-index"): recovery
    // must preserve checkpointed artifacts and resume incrementally.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(projectOwnedIndex, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "22222222-2222-4222-8222-222222222222",
    }));

    const beforeCalls = fetchSpy.mock.calls.length;
    const resumeIndexer = createIndexer(1, projectOwnedIndex);
    const stats = await resumeIndexer.index();
    expect(stats.failedChunks).toBe(0);

    // Only the pending file was re-embedded: the two checkpointed files are
    // preserved and skipped on resume.
    const resumeInputs = fetchSpy.mock.calls.slice(beforeCalls).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    expect(resumeInputs.some((text) => text.includes("first2"))).toBe(true);
    expect(resumeInputs.some((text) => text.includes("first0"))).toBe(false);
    expect(resumeInputs.some((text) => text.includes("first1"))).toBe(false);
  });
  it("checkpoint drops stale failures for files modified and reindexed successfully", async () => {
    const alphaFile = path.join(projectDir, "src", "alpha.ts");
    const gammaFile = path.join(projectDir, "src", "gamma.ts");
    writeSourceFile(alphaFile, ["alphaOne", "alphaTwo"]);

    // Run 1: alphaOne fails embedding, leaving a failed-batches record.
    failEmbeddingText = "alphaOne";
    const indexer1 = createIndexer(1);
    await indexer1.index();
    expect(fs.existsSync(path.join(indexDir, "failed-batches.json"))).toBe(true);
    const failedContent1 = fs.readFileSync(path.join(indexDir, "failed-batches.json"), "utf-8");
    expect(failedContent1).toContain("alphaOne");
    failEmbeddingText = null;

    // Run 2: alpha.ts is modified and reindexed successfully, while a new
    // file gamma.ts has a chunk that fails — ensuring the checkpoint's
    // failed-batches reconstruction path executes.
    writeSourceFile(alphaFile, ["alphaOne", "alphaTwo", "alphaThree"]);
    writeSourceFile(gammaFile, ["gammaOne"]);
    failEmbeddingText = "gammaOne";
    const indexer2 = createIndexer(1);
    await indexer2.index();

    // The old alphaOne failure must not survive: alpha.ts was modified and
    // all its chunks embedded successfully. Only gammaOne should remain.
    const failedContent2 = fs.readFileSync(path.join(indexDir, "failed-batches.json"), "utf-8");
    expect(failedContent2).toContain("gammaOne");
    expect(failedContent2).not.toContain("alphaOne");
  });

  async function verifyEmptyFailureStateBeforeHash(checkpointIntervalChunks?: number): Promise<void> {
    const alphaFile = path.join(projectDir, "src", "alpha.ts");
    const failedBatchesPath = path.join(indexDir, "failed-batches.json");
    writeSourceFile(alphaFile, ["alphaOne"]);

    failEmbeddingText = "alphaOne";
    await createIndexer(checkpointIntervalChunks).index();
    expect(fs.readFileSync(failedBatchesPath, "utf-8")).toContain("alphaOne");
    failEmbeddingText = null;

    writeSourceFile(alphaFile, ["alphaReplacement"]);
    const prototype = Indexer.prototype as unknown as {
      saveFileHashCache(this: Indexer): void;
    };
    const saveFileHashCache = prototype.saveFileHashCache;
    const hashSave = vi.spyOn(prototype, "saveFileHashCache").mockImplementation(function (this: Indexer) {
      saveFileHashCache.call(this);
      throw new Error("simulated interruption after empty failed-batch checkpoint");
    });
    try {
      await expect(createIndexer(checkpointIntervalChunks).index()).rejects.toThrow(
        "simulated interruption after empty failed-batch checkpoint",
      );
    } finally {
      hashSave.mockRestore();
    }

    expect(fs.existsSync(failedBatchesPath)).toBe(false);
    const beforeResumeCalls = fetchSpy.mock.calls.length;
    await createIndexer(checkpointIntervalChunks).index();
    expect(countEmbeddedTexts(fetchSpy, beforeResumeCalls)).toBe(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      const branchChunkIds = new Set(db.getBranchChunkIds("default"));
      const staleChunks = db.getChunksByName("alphaOne");
      const currentChunks = db.getChunksByName("alphaReplacement");
      expect(staleChunks.every((chunk) => !branchChunkIds.has(chunk.chunkId))).toBe(true);
      expect(currentChunks.some((chunk) => branchChunkIds.has(chunk.chunkId))).toBe(true);
    } finally {
      db.close();
    }
  }

  it("empty checkpoint state removes stale failures before persisting the new file hash", async () => {
    await verifyEmptyFailureStateBeforeHash(1);
  });

  it("final empty failed-batch state is published before the new file hash", async () => {
    await verifyEmptyFailureStateBeforeHash();
  });

  it("checkpoint does not duplicate pending retry chunks across multiple checkpoints", async () => {
    const alphaFile = path.join(projectDir, "src", "alpha.ts");
    const betaFile = path.join(projectDir, "src", "beta.ts");
    const gammaFile = path.join(projectDir, "src", "gamma.ts");
    writeSourceFile(alphaFile, ["alphaOne", "alphaTwo"]);

    // Run 1: alphaOne fails, leaving a failed-batches record.
    failEmbeddingText = "alphaOne";
    await createIndexer(1).index();
    failEmbeddingText = null;

    // Run 2: alpha.ts is unchanged (alphaOne stays in latestById for retry),
    // while two new files beta.ts and gamma.ts each fail — triggering two
    // separate checkpoints. Without deduplication, alphaOne would be
    // re-written from latestById at every checkpoint, duplicating it.
    writeSourceFile(betaFile, ["betaOne", "betaTwo"]);
    writeSourceFile(gammaFile, ["gammaOne", "gammaTwo"]);
    failEmbeddingText = "One";
    await createIndexer(1).index();

    // The failed-batches file should contain exactly one record for
    // alphaOne, not one per checkpoint.
    const failedContent = fs.readFileSync(path.join(indexDir, "failed-batches.json"), "utf-8");
    const alphaOneOccurrences = (failedContent.match(/"name":"alphaOne"/g) ?? []).length;
    expect(alphaOneOccurrences).toBe(1);
  });

  it("global lease recovery replays an interrupted clear against the originating project scope", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    // Simulate a crashed clear started by project A: the lease records the
    // originating project scope so the recovery replays the clear against A
    // instead of the project that reclaims the lease.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "clear",
      token: "11111111-1111-4111-8111-111111111111",
      recoveryProtocolVersion: 1,
      projectRoot: projectDir,
      scopedRoots: [canonicalPath(projectDir), canonicalPath(kbDir)],
      clearRecovery: getClearRecoveryState(),
    }));

    // Project B reclaims the lease. The recovery must clear A's data (and the
    // shared knowledge base) while preserving B's checkpointed data. B's run
    // only scans B and the knowledge base, so A's removal is observable in
    // the shared database and hash cache, not in B's embedding calls.
    const beforeCalls = fetchSpy.mock.calls.length;
    const stats = await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    const resumeInputs = fetchSpy.mock.calls.slice(beforeCalls).flatMap((call) => {
      const body = JSON.parse(String(call[1]?.body ?? "{}")) as { input?: string[] };
      return body.input ?? [];
    });
    // B's checkpointed data is preserved: B's files are not re-embedded, and
    // the shared knowledge base (cleared with A's scope) is re-cataloged by
    // B's run (reusing the cached embeddings, so no new embedding calls).
    expect(resumeInputs.some((text) => text.includes("betaOne"))).toBe(false);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      expect(db.getChunksByName("alphaOne").length).toBe(0);
      expect(db.getChunksByName("betaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("sharedOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    const fileHashes = JSON.parse(fs.readFileSync(path.join(indexDir, "file-hashes.json"), "utf-8")) as Record<string, string>;
    expect(Object.keys(fileHashes).some((filePath) => filePath.includes("alpha.ts"))).toBe(false);
    expect(Object.keys(fileHashes).some((filePath) => filePath.includes("beta.ts"))).toBe(true);

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("cross-project clear recovery preserves the reclaiming project branch catalog", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    // Simulate a crashed clear started by project A, reclaimed by project B
    // through a retry run: the recovery must not remove the shared knowledge
    // base entries from B's branch catalog, because B never re-scans them.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "clear",
      token: "11111111-1111-4111-8111-111111111111",
      recoveryProtocolVersion: 1,
      projectRoot: projectDir,
      scopedRoots: [canonicalPath(projectDir), canonicalPath(kbDir)],
      clearRecovery: getClearRecoveryState(),
    }));

    // B reclaims the lease through retryFailedBatches, which runs the
    // recovery but never re-scans the knowledge base.
    const retry = await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).retryFailedBatches();
    expect(retry.remaining).toBe(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      const branchKey = `${projectIdentityHash(projectBDir)}:default`;
      const branchChunkIds = db.getBranchChunkIds(branchKey);
      expect(branchChunkIds.length).toBeGreaterThan(0);
      expect(db.getChunksByName("sharedOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("betaOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("recovery health check does not orphan checkpointed failed chunk rows", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    // Every project A file contains a failing chunk so whichever files are
    // checkpointed before the interruption carry a persisted failure record
    // with a committed SQLite chunk row.
    const sourceFiles = [
      path.join(projectDir, "src", "alpha.ts"),
      path.join(projectDir, "src", "beta.ts"),
      path.join(projectDir, "src", "gamma.ts"),
    ];
    for (const [fileIndex, filePath] of sourceFiles.entries()) {
      writeSourceFile(
        filePath,
        ["first", "second", "triggerFailure", "fourth", "fifth", "sixth"].map((name) => `${name}${fileIndex}`),
      );
    }

    failEmbeddingText = "triggerFailure";
    await expect(createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index((progress) => {
      if (progress.phase === "embedding" && progress.filesProcessed === progress.totalFiles) {
        throw new Error("simulated interruption after failed batch checkpoint");
      }
    })).rejects.toThrow("simulated interruption after failed batch checkpoint");
    failEmbeddingText = null;

    // Simulate a crashed indexing session: the recovery health check runs
    // gcOrphanChunks() and deletes the committed rows of failed chunks that
    // have no branch association yet.
    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "index",
      token: "11111111-1111-4111-8111-111111111111",
    }));

    // The dedicated retry must restore the missing chunk rows before
    // re-embedding, so the branch catalog never references a chunk without
    // metadata.
    const retry = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).retryFailedBatches();
    expect(retry.remaining).toBe(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      const branchKey = `${projectIdentityHash(projectDir)}:default`;
      const branchChunkIds = db.getBranchChunkIds(branchKey);
      expect(branchChunkIds.length).toBeGreaterThan(0);
      for (const chunkId of branchChunkIds) {
        expect(db.getChunk(chunkId)).not.toBeNull();
      }
      for (const filePath of ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]) {
        expect(db.getChunksByFile(path.join(projectDir, filePath)).length).toBeGreaterThan(0);
      }
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("global recovery retains legacy clear markers when the originating state is unknown", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const token = "22222222-2222-4222-8222-222222222222";
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "clear",
      token,
    }));

    await expect(
      createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).retryFailedBatches(),
    ).rejects.toThrow("originating recovery state is unknown");

    expect(fs.existsSync(path.join(indexDir, `indexing.lock.recovery.${token}`))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      expect(db.getChunksByName("alphaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("betaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("sharedOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("cross-project clear recovery rejects a different embedding configuration", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const token = "33333333-3333-4333-8333-333333333333";
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "clear",
      token,
      recoveryProtocolVersion: 1,
      projectRoot: projectDir,
      scopedRoots: [canonicalPath(projectDir), canonicalPath(kbDir)],
      clearRecovery: getClearRecoveryState("originating-model"),
    }));

    await expect(
      createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).retryFailedBatches(),
    ).rejects.toThrow("embedding configuration does not match the originating lease");

    expect(fs.existsSync(path.join(indexDir, `indexing.lock.recovery.${token}`))).toBe(true);
    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      expect(db.getChunksByName("alphaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("betaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("sharedOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("cross-project clear recovery preserves the originating compatibility decision", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).index();

    const projectAHash = projectIdentityHash(projectDir);
    const writableDb = new Database(path.join(indexDir, "codebase.db"));
    writableDb.setMetadata(`index.embeddingStrategyVersion.${projectAHash}`, "1");
    writableDb.close();

    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "clear",
      token: "66666666-6666-4666-8666-666666666666",
      recoveryProtocolVersion: 1,
      projectRoot: projectDir,
      scopedRoots: [canonicalPath(projectDir), canonicalPath(kbDir)],
      clearRecovery: getClearRecoveryState("checkpoint-test-model", "embedding-strategy-mismatch"),
    }));

    const retry = await createGlobalIndexer(projectBDir, "checkpoint-test-model", kbDir).retryFailedBatches();
    expect(retry.remaining).toBe(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      expect(db.getMetadata(`index.forceReembed.${projectAHash}`)).toBe("true");
      expect(db.getMetadata(`index.embeddingStrategyVersion.${projectAHash}`)).toBeNull();
      expect(db.getChunksByName("alphaOne").length).toBe(0);
      expect(db.getChunksByName("betaOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("stale force-index phase markers cannot clear another recovered owner", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    const beforeCalls = fetchSpy.mock.calls.length;

    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "force-index",
      token: "44444444-4444-4444-8444-444444444444",
      recoveryProtocolVersion: 1,
      projectRoot: projectDir,
      scopedRoots: [canonicalPath(projectDir), canonicalPath(kbDir)],
    }));
    fs.writeFileSync(path.join(indexDir, "force-index-phase"), JSON.stringify({
      phase: "clearing",
      ownerToken: "55555555-5555-4555-8555-555555555555",
    }));

    const stats = await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();
    expect(stats.failedChunks).toBe(0);
    expect(countEmbeddedTexts(fetchSpy, beforeCalls)).toBe(0);

    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      expect(db.getChunksByName("alphaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("sharedOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("legacy force-index phase markers fail closed when ownership is unknown", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-resume-home-"));
    vi.stubEnv("HOME", tempHome);
    vi.stubEnv("USERPROFILE", tempHome);
    const { projectBDir, kbDir } = setupGlobalScope();

    await createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index();

    const deadProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const token = "77777777-7777-4777-8777-777777777777";
    const lockPath = path.join(indexDir, "indexing.lock");
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: deadProcess.pid!,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      operation: "force-index",
      token,
    }));
    fs.writeFileSync(path.join(indexDir, "force-index-phase"), "clearing");

    await expect(
      createGlobalIndexer(projectDir, "checkpoint-test-model", kbDir).index(),
    ).rejects.toThrow("legacy clearing phase ownership is unknown");

    expect(fs.existsSync(path.join(indexDir, `indexing.lock.recovery.${token}`))).toBe(true);
    const db = Database.openReadOnly(path.join(indexDir, "codebase.db"));
    try {
      expect(db.getChunksByName("alphaOne").length).toBeGreaterThan(0);
      expect(db.getChunksByName("sharedOne").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    fs.rmSync(projectBDir, { recursive: true, force: true });
    fs.rmSync(kbDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
});
