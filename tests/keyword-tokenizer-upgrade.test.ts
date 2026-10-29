import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, InvertedIndex } from "../src/native/index.js";
import { configureAutoIndex, runCoordinatedIndex, stopAutoIndex, waitForAutoIndexForRetrieval } from "../src/utils/auto-index.js";

describe("keyword tokenizer upgrades", () => {
  it.each(["hybrid", "structural"] as const)(
    "keeps a legacy %s catalog readable and upgrades normal indexing without embedding again",
    async (mode) => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "keyword-tokenizer-upgrade-")));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "marker.ts"), "export function cacheTokenizerMarker() { return 7; }\n");
      let embeddingCalls = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        embeddingCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
        const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return new Response(JSON.stringify({
          data: texts.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
          usage: { total_tokens: texts.length },
        }), { status: 200 });
      });
      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: { baseUrl: "http://localhost:11434/v1", model: "keyword-upgrade", dimensions: 8 },
        indexing: { mode, autoIndex: false, watchFiles: false, requireProjectMarker: false },
        include: ["src/**/*.ts"],
        search: { minScore: 0 },
      });
      const first = new Indexer(root, config, "pi");
      let reader: Indexer | undefined;
      try {
        await first.index();
        const initial = await first.getStatus();
        await first.close();
        const keywordPath = path.join(initial.indexPath, "inverted-index.json");
        const databasePath = path.join(initial.indexPath, "codebase.db");
        const snapshot = JSON.parse(fs.readFileSync(keywordPath, "utf8")) as {
          chunk_tokens: Record<string, Record<string, number>>;
        };
        const chunkIds = Object.keys(snapshot.chunk_tokens);
        const legacyTerms = ["export", "function", "cachetokenizermarker", "return"];
        fs.writeFileSync(keywordPath, JSON.stringify({
          term_to_chunks: Object.fromEntries(legacyTerms.map((term) => [term, chunkIds])),
          chunk_tokens: Object.fromEntries(chunkIds.map((id) => [id, Object.fromEntries(legacyTerms.map((term) => [term, 1]))])),
          avg_doc_length: legacyTerms.length,
        }));
        const legacyBytes = fs.readFileSync(keywordPath);
        const catalogBytes = fs.readFileSync(databasePath);
        const vectorPath = path.join(initial.indexPath, "vectors");
        const vectorBytes = mode === "hybrid" ? fs.readFileSync(vectorPath) : undefined;
        const database = Database.openReadOnly(databasePath);
        let embedding: Buffer | null = null;
        let contentHash = "";
        try {
          contentHash = database.getChunk(chunkIds[0])!.contentHash;
          if (mode === "hybrid") embedding = database.getEmbedding(contentHash);
        } finally {
          database.close();
        }
        embeddingCalls = 0;
        reader = new Indexer(root, config, "pi");
        expect(await reader.getStatus()).toMatchObject({ indexed: true, mode, migrationRequired: false });
        expect(await reader.getIndexFreshness()).toEqual({ readable: true, current: false, reason: "keyword-index-outdated" });
        expect(fs.readFileSync(keywordPath)).toEqual(legacyBytes);
        expect(fs.readFileSync(databasePath)).toEqual(catalogBytes);
        if (vectorBytes) expect(fs.readFileSync(vectorPath)).toEqual(vectorBytes);
        expect(embeddingCalls).toBe(0);

        const refreshed = await reader.index();
        expect(refreshed.tokensUsed).toBe(0);
        expect(embeddingCalls).toBe(0);
        expect(await reader.getIndexFreshness()).toEqual({ readable: true, current: true, reason: "current" });
        await reader.close();
        const upgraded = new InvertedIndex(keywordPath);
        upgraded.load();
        expect(upgraded.hasCurrentTokenizer(chunkIds)).toBe(true);
        expect(new Set(upgraded.search("tokenizer").keys())).toEqual(new Set(chunkIds));
        const retained = Database.openReadOnly(databasePath);
        try {
          expect(retained.getChunk(chunkIds[0])?.contentHash).toBe(contentHash);
          if (mode === "hybrid") expect(retained.getEmbedding(contentHash)).toEqual(embedding);
        } finally {
          retained.close();
        }
      } finally {
        await reader?.close();
        await first.close();
        fetch.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["hybrid", "structural"] as const)(
    "rejects coordinated indexing of a future %s keyword snapshot without deleting catalog or vector data",
    async (mode) => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "keyword-future-version-")));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src", "marker.ts"), "export function futureFormatMarker() { return 7; }\n");
      let embeddingCalls = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        embeddingCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string | string[] };
        const texts = Array.isArray(body.input) ? body.input : [body.input ?? ""];
        return new Response(JSON.stringify({
          data: texts.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
          usage: { total_tokens: texts.length },
        }), { status: 200 });
      });
      const config = parseConfig({
        embeddingProvider: "custom",
        customProvider: { baseUrl: "http://localhost:11434/v1", model: "keyword-upgrade", dimensions: 8 },
        indexing: { mode, autoIndex: true, watchFiles: false, requireProjectMarker: false },
        include: ["src/**/*.ts"],
      });
      const first = new Indexer(root, config, "pi");
      let reader: Indexer | undefined;
      try {
        await first.index();
        const initial = await first.getStatus();
        await first.close();
        const keywordPath = path.join(initial.indexPath, "inverted-index.json");
        const snapshot = JSON.parse(fs.readFileSync(keywordPath, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(keywordPath, JSON.stringify({ ...snapshot, tokenizer_version: 2 }));
        const artifacts = new Map(
          ["inverted-index.json", "codebase.db", "vectors", "vectors.meta.json"]
            .map((name) => path.join(initial.indexPath, name))
            .filter((file) => fs.existsSync(file))
            .map((file) => [file, fs.readFileSync(file)]),
        );
        embeddingCalls = 0;
        reader = new Indexer(root, config, "pi");
        const currentReader = reader;
        configureAutoIndex(root, "pi", config, () => currentReader);
        if (mode === "hybrid") {
          await expect(waitForAutoIndexForRetrieval(root, "pi")).resolves.toEqual({ ready: true });
          expect((await reader.search("future format marker", 1))[0]).toMatchObject({
            name: "futureFormatMarker",
            filePath: path.join(root, "src", "marker.ts"),
          });
          const sourcePath = path.join(root, "src", "marker.ts");
          const sourceBytes = fs.readFileSync(sourcePath);
          fs.writeFileSync(sourcePath, "export function futureFormatMarker() { return 8; }\n");
          expect(await reader.getIndexFreshness()).toEqual({
            readable: true, current: false, reason: "files-changed",
          });
          fs.writeFileSync(sourcePath, sourceBytes);
          embeddingCalls = 0;
        }
        expect(await reader.getIndexFreshness()).toEqual({
          readable: mode === "hybrid",
          current: false,
          reason: mode === "hybrid" ? "keyword-index-unreadable" : "unreadable",
        });
        expect(await runCoordinatedIndex(root, "pi", false)).toMatchObject({
          outcome: "failed",
          error: expect.objectContaining({ code: "InvalidArg" }),
        });
        await reader.close();
        expect(embeddingCalls).toBe(0);
        for (const [file, bytes] of artifacts) {
          expect(fs.existsSync(file)).toBe(true);
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
      } finally {
        await stopAutoIndex(root, "pi", true);
        await reader?.close();
        await first.close();
        fetch.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
