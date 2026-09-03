import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";

describe("indexing database transaction", () => {
  let projectDir: string;
  let indexDir: string;
  let indexer: Indexer;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "indexing-transaction-project-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "indexing-transaction-index-"));
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = body.input ?? [];
      return new Response(JSON.stringify({
        data: texts.map((_text, index) => ({
          embedding: Array.from({ length: 8 }, (_, dimension) => (index + dimension + 1) / 10),
        })),
        usage: { total_tokens: Math.max(1, texts.length) },
      }), { status: 200 });
    });

    indexer = new Indexer(projectDir, parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "transaction-test-model",
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
    }), "opencode", { indexPath: indexDir });
  });

  afterEach(async () => {
    await indexer.close();
    fetchSpy.mockRestore();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("does not expose parsed rows when indexing aborts before publication", async () => {
    fs.writeFileSync(
      path.join(projectDir, "src", "stable.ts"),
      "export function stable() { return 'stable'; }\n",
      "utf8",
    );
    await indexer.index();

    const databasePath = path.join(indexDir, "codebase.db");
    const before = Database.openReadOnly(databasePath);
    const beforeStats = before.getStats();
    const beforeBranches = before.getAllBranches().map((branch) => ({
      branch,
      chunks: before.getBranchChunkIds(branch),
      symbols: before.getBranchSymbolIds(branch),
    }));
    before.close();

    fs.writeFileSync(
      path.join(projectDir, "src", "transient.ts"),
      "export function transient() { return 'transient'; }\n",
      "utf8",
    );

    await expect(indexer.index((progress) => {
      if (progress.phase === "embedding") {
        throw new Error("simulated interruption after database staging");
      }
    })).rejects.toThrow("simulated interruption");

    const after = Database.openReadOnly(databasePath);
    try {
      expect(after.getStats()).toEqual(beforeStats);
      expect(after.getChunksByFile(path.join(projectDir, "src", "transient.ts"))).toEqual([]);
      expect(after.getSymbolsByFile(path.join(projectDir, "src", "transient.ts"))).toEqual([]);
      expect(after.getAllBranches().map((branch) => ({
        branch,
        chunks: after.getBranchChunkIds(branch),
        symbols: after.getBranchSymbolIds(branch),
      }))).toEqual(beforeBranches);
    } finally {
      after.close();
    }
  });

  it("keeps the previous SQLite and branch catalog generation after a late file-batch interruption", async () => {
    fs.writeFileSync(
      path.join(projectDir, "src", "stable.ts"),
      "export function stable() { return 'stable'; }\n",
      "utf8",
    );
    await indexer.index();

    const databasePath = path.join(indexDir, "codebase.db");
    const fileHashesPath = path.join(indexDir, "file-hashes.json");
    const failedBatchesPath = path.join(indexDir, "failed-batches.json");
    const previousFileHashes = fs.readFileSync(fileHashesPath, "utf-8");
    const before = Database.openReadOnly(databasePath);
    const beforeStats = before.getStats();
    const beforeBranches = before.getAllBranches().map((branch) => ({
      branch,
      chunks: before.getBranchChunkIds(branch),
      symbols: before.getBranchSymbolIds(branch),
    }));
    before.close();

    for (let fileIndex = 0; fileIndex < 65; fileIndex++) {
      fs.writeFileSync(
        path.join(projectDir, "src", `late-${fileIndex.toString().padStart(2, "0")}.ts`),
        `export function late${fileIndex}() { return ${fileIndex}; }\n// ${"x".repeat(100 + fileIndex)}\n`,
        "utf8",
      );
    }

    await expect(indexer.index((progress) => {
      if (progress.phase === "parsing" && progress.totalFiles === 66 && progress.filesProcessed === 66) {
        throw new Error("simulated interruption in the final file batch");
      }
    })).rejects.toThrow("simulated interruption in the final file batch");

    const after = Database.openReadOnly(databasePath);
    try {
      expect(after.getStats()).toEqual(beforeStats);
      expect(after.getChunksByFile("src/late-00.ts")).toEqual([]);
      expect(after.getChunksByFile("src/late-64.ts")).toEqual([]);
      expect(after.getSymbolsByFile("src/late-00.ts")).toEqual([]);
      expect(after.getSymbolsByFile("src/late-64.ts")).toEqual([]);
      expect(after.getAllBranches().map((branch) => ({
        branch,
        chunks: after.getBranchChunkIds(branch),
        symbols: after.getBranchSymbolIds(branch),
      }))).toEqual(beforeBranches);
      expect(fs.readFileSync(fileHashesPath, "utf-8")).toBe(previousFileHashes);
      expect(fs.existsSync(failedBatchesPath)).toBe(false);
      expect(fs.readdirSync(indexDir).some((entry) => (
        entry.startsWith(".failed-batches.json.") && entry.endsWith(".tmp")
      ))).toBe(false);
    } finally {
      after.close();
    }
  });

  it("rolls back and releases the lease when indexing is cancelled during embedding", async () => {
    fs.writeFileSync(
      path.join(projectDir, "src", "stable.ts"),
      "export function stable() { return 'stable'; }\n",
      "utf8",
    );
    await indexer.index();

    const databasePath = path.join(indexDir, "codebase.db");
    const fileHashesPath = path.join(indexDir, "file-hashes.json");
    const before = Database.openReadOnly(databasePath);
    const beforeStats = before.getStats();
    const beforeBranches = before.getAllBranches().map((branch) => ({
      branch,
      chunks: before.getBranchChunkIds(branch),
      symbols: before.getBranchSymbolIds(branch),
    }));
    before.close();
    const previousFileHashes = fs.readFileSync(fileHashesPath, "utf8");

    fs.writeFileSync(
      path.join(projectDir, "src", "cancelled.ts"),
      "export function cancelled() { return 'cancelled'; }\n",
      "utf8",
    );
    let providerSignal: AbortSignal | undefined;
    let markEmbeddingStarted: (() => void) | undefined;
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    fetchSpy.mockImplementationOnce(async (_url, init) => {
      providerSignal = init?.signal ?? undefined;
      markEmbeddingStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        if (!providerSignal) {
          reject(new Error("Expected an embedding request signal."));
          return;
        }
        const rejectCancellation = (): void => reject(providerSignal?.reason ?? new Error("cancelled"));
        if (providerSignal.aborted) rejectCancellation();
        else providerSignal.addEventListener("abort", rejectCancellation, { once: true });
      });
    });

    const controller = new AbortController();
    const operation = indexer.index(undefined, { signal: controller.signal });
    await embeddingStarted;
    controller.abort();

    await expect(operation).rejects.toBeInstanceOf(OperationCancelledError);
    expect(providerSignal?.aborted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const after = Database.openReadOnly(databasePath);
    try {
      expect(after.getStats()).toEqual(beforeStats);
      expect(after.getChunksByFile(path.join(projectDir, "src", "cancelled.ts"))).toEqual([]);
      expect(after.getSymbolsByFile(path.join(projectDir, "src", "cancelled.ts"))).toEqual([]);
      expect(after.getAllBranches().map((branch) => ({
        branch,
        chunks: after.getBranchChunkIds(branch),
        symbols: after.getBranchSymbolIds(branch),
      }))).toEqual(beforeBranches);
      expect(fs.readFileSync(fileHashesPath, "utf8")).toBe(previousFileHashes);
      expect(fs.existsSync(path.join(indexDir, "indexing.lock"))).toBe(false);
      expect(fs.readdirSync(indexDir).filter((entry) => entry.includes(".tmp."))).toEqual([]);
    } finally {
      after.close();
    }
  });
});
