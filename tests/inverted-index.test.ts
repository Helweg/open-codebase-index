import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InvertedIndex } from "../src/native/index.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("InvertedIndex", () => {
  let tempDir: string;
  let indexPath: string;
  let index: InvertedIndex;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "inverted-index-test-"));
    indexPath = path.join(tempDir, "inverted-index.json");
    index = new InvertedIndex(indexPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("addChunk and search", () => {
    it("should index and find a single chunk", () => {
      index.addChunk("chunk1", "function validateEmail checks email format");

      const results = index.search("validate email");

      expect(results.size).toBe(1);
      expect(results.has("chunk1")).toBe(true);
      expect(results.get("chunk1")).toBeGreaterThan(0);
    });

    it("should return empty results for non-matching query", () => {
      index.addChunk("chunk1", "database connection pooling");

      const results = index.search("authentication");

      expect(results.size).toBe(0);
    });

    it("should rank chunks by relevance", () => {
      index.addChunk("chunk1", "user authentication login");
      index.addChunk("chunk2", "authentication middleware validates tokens");
      index.addChunk("chunk3", "database connection");

      const results = index.search("authentication");

      expect(results.size).toBe(2);
      expect(results.has("chunk1")).toBe(true);
      expect(results.has("chunk2")).toBe(true);
      expect(results.has("chunk3")).toBe(false);
    });

    it("should handle multi-word queries", () => {
      index.addChunk("chunk1", "validate user input data");
      index.addChunk("chunk2", "user profile settings");
      index.addChunk("chunk3", "validate email format");

      const results = index.search("validate user");

      expect(results.has("chunk1")).toBe(true);
      const chunk1Score = results.get("chunk1") || 0;
      const chunk2Score = results.get("chunk2") || 0;
      expect(chunk1Score).toBeGreaterThan(chunk2Score);
    });

    it("keeps tied ranks and cutoff membership stable across queries and reloads", () => {
      const tiedIds = ["tie-f", "tie-b", "tie-e", "tie-a", "tie-d", "tie-c"];
      for (const id of tiedIds) {
        index.addChunk(id, "needle padding padding");
      }
      index.addChunk("strong", "needle needle needle");
      index.addChunk("weak", "needle padding padding padding padding padding padding");
      index.save();

      const loaded = new InvertedIndex(indexPath);
      loaded.load();
      const independentlyBuilt = new InvertedIndex(path.join(tempDir, "independent.json"));
      independentlyBuilt.addChunk("weak", "needle padding padding padding padding padding padding");
      for (const id of [...tiedIds].reverse()) {
        independentlyBuilt.addChunk(id, "needle padding padding");
      }
      independentlyBuilt.addChunk("strong", "needle needle needle");

      const expectedIds = ["strong", ...[...tiedIds].sort(), "weak"];
      const expected = [...index.search("needle", expectedIds.length)];
      expect(expected.map(([id]) => id)).toEqual(expectedIds);
      expect(expected[0][1]).toBeGreaterThan(expected[1][1]);
      expect(new Set(expected.slice(1, -1).map(([, score]) => score)).size).toBe(1);
      expect(expected[expected.length - 2][1]).toBeGreaterThan(expected[expected.length - 1][1]);

      for (const candidate of [index, loaded, independentlyBuilt]) {
        for (let round = 0; round < 5; round += 1) {
          expect([...candidate.search("needle", expectedIds.length)]).toEqual(expected);
          expect([...candidate.search("needle", 4)]).toEqual(expected.slice(0, 4));
        }
      }
    });

    it("matches identifier words and preserves complete identifiers across reloads", () => {
      index.addChunk("fusion", "function blendOrderedScores(semanticResults, keywordResults) { const semanticRank = 1; }");
      index.addChunk("transport", "class HTTPClient { readResponsePayload() {} }");
      index.addChunk("unicode", "function processÉtat() {}");
      index.save();
      const loaded = new InvertedIndex(indexPath);
      loaded.load();
      for (const candidate of [index, loaded]) {
        for (const [query, expected] of [
          ["semantic", "fusion"], ["keyword", "fusion"], ["rank", "fusion"],
          ["BLENDORDEREDSCORES", "fusion"], ["http", "transport"],
          ["response", "transport"], ["payload", "transport"], ["état", "unicode"],
        ]) {
          expect([...candidate.search(query).keys()]).toEqual([expected]);
        }
      }
    });

    it("keeps whole identifier queries distinct from identifier-word queries", () => {
      index.addChunk("retained", "const durableNeedle = true;");
      index.save();
      const loaded = new InvertedIndex(indexPath);
      loaded.load();
      for (const candidate of [index, loaded]) {
        expect([...candidate.search("replacementNeedle").keys()]).toEqual([]);
        expect([...candidate.search("durableNeedle").keys()]).toEqual(["retained"]);
        expect([...candidate.search("DURABLENEEDLE").keys()]).toEqual(["retained"]);
        expect([...candidate.search("needle").keys()]).toEqual(["retained"]);
      }
    });

    it("tracks legacy tokenizer coverage per chunk through partial upgrades and persistence", () => {
      index.deserialize(JSON.stringify({
        term_to_chunks: { persistfailedbatches: ["old-a"], loadstoredrecords: ["old-b"] },
        chunk_tokens: { "old-a": { persistfailedbatches: 1 }, "old-b": { loadstoredrecords: 1 } },
        avg_doc_length: 1,
      }));
      expect([...index.search("PERSISTFAILEDBATCHES").keys()]).toEqual(["old-a"]);
      expect([...index.search("failed").keys()]).toEqual([]);
      expect(index.hasCurrentTokenizer(["old-a"])).toBe(false);
      index.addChunk("current", "currentImplementation");
      expect(index.hasCurrentTokenizer(["current"])).toBe(true);
      expect(index.outdatedTokenizerChunkIds(["current", "old-b", "old-a", "old-a"])).toEqual(["old-a", "old-b"]);

      index.removeChunk("old-a");
      index.addChunk("old-a", "persistFailedBatches");
      index.save();
      const loaded = new InvertedIndex(indexPath);
      loaded.load();
      expect([...loaded.search("failed").keys()]).toEqual(["old-a"]);
      expect(loaded.hasCurrentTokenizer(["old-a", "current"])).toBe(true);
      expect(loaded.hasCurrentTokenizer(["old-b"])).toBe(false);
      expect(loaded.hasCurrentTokenizer()).toBe(false);

      const restored = new InvertedIndex(path.join(tempDir, "restored.json"));
      restored.deserialize(loaded.serialize());
      expect(restored.hasCurrentTokenizer(["old-b"])).toBe(false);
      restored.removeChunk("old-b");
      expect(restored.hasCurrentTokenizer()).toBe(true);
      expect([...restored.search("loadstoredrecords").keys()]).toEqual([]);
    });

    it("rejects a future tokenizer version without discarding readable state", () => {
      index.addChunk("retained", "retainedEvidence");
      const future = { ...JSON.parse(index.serialize()), tokenizer_version: 999 };
      expect(() => index.deserialize(JSON.stringify(future))).toThrow();
      expect([...index.search("retained").keys()]).toEqual(["retained"]);
    });

    it("validates persisted versions without replacing unsaved keyword state", () => {
      index.addChunk("saved", "originalNeedle");
      index.save();
      const persisted = fs.readFileSync(indexPath);
      index.clear();
      index.addChunk("pending", "replacementNeedle");

      index.validateSnapshotVersion();
      expect([...index.search("replacementNeedle").keys()]).toEqual(["pending"]);
      expect([...index.search("originalNeedle").keys()]).toEqual([]);
      expect(fs.readFileSync(indexPath)).toEqual(persisted);

      const future = Buffer.from(JSON.stringify({
        ...JSON.parse(persisted.toString("utf8")),
        tokenizer_version: 2,
      }));
      fs.writeFileSync(indexPath, future);
      expect(() => index.validateSnapshotVersion()).toThrow("unsupported tokenizer version");
      expect([...index.search("replacementNeedle").keys()]).toEqual(["pending"]);
      expect([...index.search("originalNeedle").keys()]).toEqual([]);
      expect(fs.readFileSync(indexPath)).toEqual(future);
    });
  });

  describe("removeChunk", () => {
    it("should remove chunk from index", () => {
      index.addChunk("chunk1", "authentication logic");
      index.addChunk("chunk2", "authentication middleware");

      index.removeChunk("chunk1");

      const results = index.search("authentication");
      expect(results.size).toBe(1);
      expect(results.has("chunk2")).toBe(true);
      expect(results.has("chunk1")).toBe(false);
    });

    it("should handle removing non-existent chunk", () => {
      index.addChunk("chunk1", "test content");

      expect(() => index.removeChunk("nonexistent")).not.toThrow();
    });
  });

  describe("persistence", () => {
    it("should save and load index", () => {
      index.addChunk("chunk1", "authentication login");
      index.addChunk("chunk2", "database connection");
      index.save();

      const newIndex = new InvertedIndex(indexPath);
      newIndex.load();

      const results = newIndex.search("authentication");
      expect(results.size).toBe(1);
      expect(results.has("chunk1")).toBe(true);
    });

    it("roundtrips streamed snapshots and legacy JSON without changing scores or the default destination", () => {
      const destination = path.join(tempDir, "staging", "snapshot.json");
      index.save();
      const empty = fs.readFileSync(indexPath, "utf-8");

      index.addChunk("removed", "obsolete needle");
      for (let i = 0; i < 2000; i++) {
        index.addChunk(`chunk-${i}-日本語`, `café needle group${i} repeated repeated`);
      }
      index.removeChunk("removed");
      const expected = [...index.search("café needle", 2000)];
      index.save(destination);
      expect(fs.readFileSync(indexPath, "utf-8")).toBe(empty);
      const streamed = new InvertedIndex(destination);
      streamed.load();
      const legacy = new InvertedIndex(path.join(tempDir, "legacy.json"));
      legacy.deserialize(index.serialize());
      for (const candidate of [streamed, legacy]) {
        expect(candidate.getDocumentCount()).toBe(2000);
        expect(candidate.hasChunk("removed")).toBe(false);
        expect(candidate.search("obsolete").size).toBe(0);
        expect([...candidate.search("café needle", 2000)]).toEqual(expected);
      }
      index.save();
      const reloaded = new InvertedIndex(indexPath);
      reloaded.load();
      expect([...reloaded.search("café needle", 2000)]).toEqual(expected);
    });

    it("should handle loading empty index", () => {
      const newIndex = new InvertedIndex(indexPath);
      expect(() => newIndex.load()).not.toThrow();
      expect(newIndex.getDocumentCount()).toBe(0);
    });
  });

  describe("clear", () => {
    it("should clear all data", () => {
      index.addChunk("chunk1", "test content");
      index.addChunk("chunk2", "more content");

      index.clear();

      expect(index.getDocumentCount()).toBe(0);
      expect(index.search("test").size).toBe(0);
    });
  });

  describe("hasChunk", () => {
    it("should return true for existing chunk", () => {
      index.addChunk("chunk1", "test content");

      expect(index.hasChunk("chunk1")).toBe(true);
    });

    it("should return false for non-existing chunk", () => {
      expect(index.hasChunk("nonexistent")).toBe(false);
    });
  });
});
