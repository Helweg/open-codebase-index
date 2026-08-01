import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

function config(communityBoost: number) {
  return parseConfig({
    embeddingProvider: "custom",
    customProvider: {
      baseUrl: "http://localhost:11434/v1",
      model: "mock-model",
      dimensions: 8,
    },
    indexing: { watchFiles: false },
    search: { communityBoost, minScore: 0 },
  });
}

describe("community-aware search integration", () => {
  let tempDir: string;
  let indexers: Indexer[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "community-ranking-search-"));
    indexers = [];
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "auth.ts"), [
      "export function validateToken() { return refreshToken(); }",
      "export function refreshToken() { return authHelper(); }",
      "export function authHelper() { return true; }",
    ].join("\n"));
    fs.writeFileSync(path.join(tempDir, "src", "database.ts"), [
      "export function openDatabase() { return runQuery(); }",
      "export function runQuery() { return true; }",
    ].join("\n"));

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      return new Response(JSON.stringify({
        data: texts.map((text) => ({
          embedding: Array.from({ length: 8 }, (_, index) => ((text.length + index * 13) % 101) / 101),
        })),
        usage: { total_tokens: Math.max(1, texts.length * 4) },
      }), { status: 200 });
    });
  });

  afterEach(async () => {
    await Promise.all(indexers.map((indexer) => indexer.close()));
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("boosts same-community results only when enabled and preserves filtered scope", async () => {
    const indexPath = path.join(tempDir, ".index");
    const baselineIndexer = new Indexer(tempDir, config(0), "opencode", { indexPath });
    indexers.push(baselineIndexer);
    await baselineIndexer.index();

    const baseline = await baselineIndexer.search("validateToken", 20, { metadataOnly: true });
    await baselineIndexer.close();
    indexers = [];

    const enabledIndexer = new Indexer(tempDir, config(0.5), "opencode", { indexPath });
    indexers.push(enabledIndexer);
    const enabled = await enabledIndexer.search("validateToken", 20, { metadataOnly: true });
    const filtered = await enabledIndexer.search("validateToken", 20, {
      metadataOnly: true,
      directory: "src/database",
    });

    const baselineAuth = baseline.find((result) => result.filePath.endsWith("src/auth.ts"));
    const enabledAuth = enabled.find((result) => result.filePath.endsWith("src/auth.ts"));
    expect(baselineAuth).toBeDefined();
    expect(enabledAuth).toBeDefined();
    expect(enabledAuth!.score).toBeGreaterThan(baselineAuth!.score);
    expect(filtered).toEqual([]);
  });
});
