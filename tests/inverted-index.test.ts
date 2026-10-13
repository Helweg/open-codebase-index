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
