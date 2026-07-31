import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

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
});
