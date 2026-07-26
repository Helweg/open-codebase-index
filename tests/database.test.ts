import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Database, ChunkData, SymbolData } from "../src/native/index.js";

describe("Database", () => {
  let tempDir: string;
  let db: Database;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-test-"));
    db = new Database(path.join(tempDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("close semantics", () => {
    it("should allow repeated close calls", () => {
      expect(() => db.close()).not.toThrow();
      expect(() => db.close()).not.toThrow();
    });

    it("should fail fast after close", () => {
      db.close();

      expect(() => db.getStats()).toThrow("Database is closed");
      expect(() => db.embeddingExists("hash123")).toThrow("Database is closed");
      expect(() => db.setMetadata("key", "value")).toThrow("Database is closed");
    });

    it("should fail fast for wrapper no-op batch helpers after close", () => {
      db.close();

      expect(() => db.upsertEmbeddingsBatch([])).toThrow("Database is closed");
      expect(() => db.upsertChunksBatch([])).toThrow("Database is closed");
      expect(() => db.addChunksToBranchBatch("main", [])).toThrow("Database is closed");
      expect(() => db.getReferencedChunkIds([])).toThrow("Database is closed");
      expect(() => db.clearCallEdgeTargetsForSymbols([])).toThrow("Database is closed");
    });

    it("should release the database file when closed", () => {
      const dbPath = path.join(tempDir, "test.db");

      db.close();

      if (process.platform !== "win32") {
        return;
      }

      expect(() => fs.rmSync(dbPath, { force: true })).not.toThrow();
    });
  });

  describe("read-only connections", () => {
    it("should read a live WAL database without allowing mutations", () => {
      const dbPath = path.join(tempDir, "test.db");
      db.setMetadata("reader-visible", "yes");
      const reader = Database.openReadOnly(dbPath);

      try {
        expect(reader.getMetadata("reader-visible")).toBe("yes");
        expect(() => reader.setMetadata("reader-write", "forbidden")).toThrow(/read.?only/i);
        expect(db.getMetadata("reader-write")).toBeNull();
      } finally {
        reader.close();
      }
    });

    it("should reject a missing database without creating its parent directory", () => {
      const dbPath = path.join(tempDir, "missing", "index.db");

      expect(() => Database.openReadOnly(dbPath)).toThrow();
      expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
    });

    it("should reject an old schema without migrating the live database", () => {
      const dbPath = path.join(tempDir, "test.db");
      db.setMetadata("schema_version", "5");

      expect(() => Database.openReadOnly(dbPath)).toThrow(/found version 5, expected 6/i);
      expect(db.getMetadata("schema_version")).toBe("5");
    });

    it("should reject a corrupt database without changing its bytes", () => {
      const dbPath = path.join(tempDir, "corrupt.db");
      const content = Buffer.from("not a sqlite database");
      fs.writeFileSync(dbPath, content);

      expect(() => Database.openReadOnly(dbPath)).toThrow();
      expect(fs.readFileSync(dbPath)).toEqual(content);
    });

    it("should provide an empty read-only fallback without creating files", () => {
      const filesBefore = fs.readdirSync(tempDir).sort();
      const reader = Database.createEmptyReadOnly();

      try {
        expect(reader.getStats()).toEqual({
          embeddingCount: 0,
          chunkCount: 0,
          branchChunkCount: 0,
          branchCount: 0,
          symbolCount: 0,
          callEdgeCount: 0,
        });
        expect(() => reader.setMetadata("reader-write", "forbidden")).toThrow(/read.?only/i);
        expect(fs.readdirSync(tempDir).sort()).toEqual(filesBefore);
      } finally {
        reader.close();
      }
    });
  });

  describe("embeddings", () => {
    it("should check if embedding exists", () => {
      expect(db.embeddingExists("hash123")).toBe(false);
    });

    it("should upsert and retrieve embedding", () => {
      const embedding = Buffer.from(new Float32Array([1.0, 2.0, 3.0]).buffer);
      db.upsertEmbedding("hash123", embedding, "test chunk text", "test-model");

      expect(db.embeddingExists("hash123")).toBe(true);

      const retrieved = db.getEmbedding("hash123");
      expect(retrieved).not.toBeNull();

      const floats = new Float32Array(retrieved!.buffer, retrieved!.byteOffset, retrieved!.byteLength / 4);
      expect(floats[0]).toBeCloseTo(1.0);
      expect(floats[1]).toBeCloseTo(2.0);
      expect(floats[2]).toBeCloseTo(3.0);
    });

    it("should return null for non-existent embedding", () => {
      expect(db.getEmbedding("nonexistent")).toBeNull();
    });

    it("should get missing embeddings from a list", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("exists", embedding, "text", "model");

      const missing = db.getMissingEmbeddings(["exists", "missing1", "missing2"]);

      expect(missing).toContain("missing1");
      expect(missing).toContain("missing2");
      expect(missing).not.toContain("exists");
    });
  });

  describe("chunks", () => {
    const testChunk: ChunkData = {
      chunkId: "chunk_abc123",
      contentHash: "hash456",
      filePath: "/path/to/file.ts",
      startLine: 10,
      endLine: 20,
      nodeType: "function",
      name: "testFunction",
      language: "typescript",
    };

    it("should upsert and retrieve chunk", () => {
      db.upsertChunk(testChunk);

      const retrieved = db.getChunk("chunk_abc123");

      expect(retrieved).not.toBeNull();
      expect(retrieved!.chunkId).toBe("chunk_abc123");
      expect(retrieved!.contentHash).toBe("hash456");
      expect(retrieved!.filePath).toBe("/path/to/file.ts");
      expect(retrieved!.startLine).toBe(10);
      expect(retrieved!.endLine).toBe(20);
      expect(retrieved!.nodeType).toBe("function");
      expect(retrieved!.name).toBe("testFunction");
      expect(retrieved!.language).toBe("typescript");
    });

    it("should return null for non-existent chunk", () => {
      expect(db.getChunk("nonexistent")).toBeNull();
    });

    it("should get chunks by file path", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({
        ...testChunk,
        chunkId: "chunk_def456",
        startLine: 30,
        endLine: 40,
      });

      const chunks = db.getChunksByFile("/path/to/file.ts");

      expect(chunks.length).toBe(2);
    });

    it("should delete chunks by file path", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({
        ...testChunk,
        chunkId: "chunk_def456",
      });

      const deleted = db.deleteChunksByFile("/path/to/file.ts");

      expect(deleted).toBe(2);
      expect(db.getChunk("chunk_abc123")).toBeNull();
    });

    it("should delete chunks by ids", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({
        ...testChunk,
        chunkId: "chunk_def456",
      });

      const deleted = db.deleteChunksByIds(["chunk_abc123"]);

      expect(deleted).toBe(1);
      expect(db.getChunk("chunk_abc123")).toBeNull();
      expect(db.getChunk("chunk_def456")).not.toBeNull();
    });
  });

  describe("branch_chunks", () => {
    const testChunk: ChunkData = {
      chunkId: "chunk_abc123",
      contentHash: "hash456",
      filePath: "/path/to/file.ts",
      startLine: 10,
      endLine: 20,
      nodeType: "function",
      language: "typescript",
    };

    it("should add chunks to branch", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);

      const chunkIds = db.getBranchChunkIds("main");

      expect(chunkIds).toContain("chunk_abc123");
    });

    it("should check if chunk exists on branch", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);

      expect(db.chunkExistsOnBranch("main", "chunk_abc123")).toBe(true);
      expect(db.chunkExistsOnBranch("main", "nonexistent")).toBe(false);
      expect(db.chunkExistsOnBranch("other-branch", "chunk_abc123")).toBe(false);
    });

    it("should clear branch", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);

      const cleared = db.clearBranch("main");

      expect(cleared).toBe(1);
      expect(db.getBranchChunkIds("main").length).toBe(0);
    });

    it("should get all branches", () => {
      db.upsertChunk(testChunk);
      db.addChunksToBranch("main", ["chunk_abc123"]);
      db.addChunksToBranch("feature", ["chunk_abc123"]);

      const branches = db.getAllBranches();

      expect(branches).toContain("main");
      expect(branches).toContain("feature");
    });

    it("should include branches that only have symbols", () => {
      const testSymbol: SymbolData = {
        id: "sym_abc123",
        filePath: "/path/to/file.ts",
        name: "testFunction",
        kind: "function",
        startLine: 10,
        startCol: 0,
        endLine: 20,
        endCol: 0,
        language: "typescript",
      };

      db.upsertSymbol(testSymbol);
      db.addSymbolsToBranchBatch("symbols-only", [testSymbol.id]);
      db.upsertChunk(testChunk);
      db.addChunksToBranch("chunks-only", [testChunk.chunkId]);

      const branches = db.getAllBranches();

      expect(branches).toContain("symbols-only");
      expect(branches).toContain("chunks-only");
    });

    it("should compute branch delta", () => {
      db.upsertChunk(testChunk);
      db.upsertChunk({ ...testChunk, chunkId: "chunk_main_only" });
      db.upsertChunk({ ...testChunk, chunkId: "chunk_feature_only" });

      db.addChunksToBranch("main", ["chunk_abc123", "chunk_main_only"]);
      db.addChunksToBranch("feature", ["chunk_abc123", "chunk_feature_only"]);

      const delta = db.getBranchDelta("feature", "main");

      expect(delta.added).toContain("chunk_feature_only");
      expect(delta.removed).toContain("chunk_main_only");
      expect(delta.added).not.toContain("chunk_abc123");
      expect(delta.removed).not.toContain("chunk_abc123");
    });
  });

  describe("metadata", () => {
    it("should set and get metadata", () => {
      db.setMetadata("version", "1.0.0");

      expect(db.getMetadata("version")).toBe("1.0.0");
    });

    it("should return null for non-existent metadata", () => {
      expect(db.getMetadata("nonexistent")).toBeNull();
    });

    it("should delete metadata", () => {
      db.setMetadata("key", "value");

      const deleted = db.deleteMetadata("key");

      expect(deleted).toBe(true);
      expect(db.getMetadata("key")).toBeNull();
    });

    it("should update existing metadata", () => {
      db.setMetadata("key", "value1");
      db.setMetadata("key", "value2");

      expect(db.getMetadata("key")).toBe("value2");
    });
  });

  describe("index metadata contract", () => {
    it("should store index metadata fields", () => {
      db.setMetadata("index.version", "1");
      db.setMetadata("index.embeddingProvider", "openai");
      db.setMetadata("index.embeddingModel", "text-embedding-3-small");
      db.setMetadata("index.embeddingDimensions", "1536");
      db.setMetadata("index.createdAt", "2025-01-19T00:00:00Z");
      db.setMetadata("index.updatedAt", "2025-01-19T00:00:00Z");

      expect(db.getMetadata("index.version")).toBe("1");
      expect(db.getMetadata("index.embeddingProvider")).toBe("openai");
      expect(db.getMetadata("index.embeddingModel")).toBe("text-embedding-3-small");
      expect(db.getMetadata("index.embeddingDimensions")).toBe("1536");
    });

    it("should persist index metadata across database reopening", () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-test-persist-"));
      let db1: InstanceType<typeof Database> | undefined;
      let db2: InstanceType<typeof Database> | undefined;
      try {
        const dbPath = path.join(tempDir, "persist-test.db");
        db1 = new Database(dbPath);
        db1.setMetadata("index.embeddingProvider", "ollama");
        db1.setMetadata("index.embeddingDimensions", "768");
        db2 = new Database(dbPath);
        expect(db2.getMetadata("index.embeddingProvider")).toBe("ollama");
        expect(db2.getMetadata("index.embeddingDimensions")).toBe("768");
      } finally {
        try { db1?.close(); } catch { /* best-effort */ }
        try { db2?.close(); } catch { /* best-effort */ }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    });

    it("should update index metadata on reindex", () => {
      db.setMetadata("index.embeddingProvider", "openai");
      db.setMetadata("index.embeddingDimensions", "1536");
      db.setMetadata("index.updatedAt", "2025-01-18T00:00:00Z");

      db.setMetadata("index.updatedAt", "2025-01-19T12:00:00Z");

      expect(db.getMetadata("index.embeddingProvider")).toBe("openai");
      expect(db.getMetadata("index.updatedAt")).toBe("2025-01-19T12:00:00Z");
    });
  });

  describe("garbage collection", () => {
    it("should gc orphan embeddings", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("orphan_hash", embedding, "text", "model");

      const gcCount = db.gcOrphanEmbeddings();

      expect(gcCount).toBe(1);
      expect(db.embeddingExists("orphan_hash")).toBe(false);
    });

    it("should not gc referenced embeddings", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("referenced_hash", embedding, "text", "model");
      db.upsertChunk({
        chunkId: "chunk1",
        contentHash: "referenced_hash",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });

      const gcCount = db.gcOrphanEmbeddings();

      expect(gcCount).toBe(0);
      expect(db.embeddingExists("referenced_hash")).toBe(true);
    });

    it("should gc orphan chunks", () => {
      db.upsertChunk({
        chunkId: "orphan_chunk",
        contentHash: "hash",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });

      const gcCount = db.gcOrphanChunks();

      expect(gcCount).toBe(1);
      expect(db.getChunk("orphan_chunk")).toBeNull();
    });

    it("should not gc chunks referenced by branches", () => {
      db.upsertChunk({
        chunkId: "referenced_chunk",
        contentHash: "hash",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("main", ["referenced_chunk"]);

      const gcCount = db.gcOrphanChunks();

      expect(gcCount).toBe(0);
      expect(db.getChunk("referenced_chunk")).not.toBeNull();
    });
  });

  describe("stats", () => {
    it("should return database stats", () => {
      const embedding = Buffer.from(new Float32Array([1.0]).buffer);
      db.upsertEmbedding("hash1", embedding, "text", "model");
      db.upsertChunk({
        chunkId: "chunk1",
        contentHash: "hash1",
        filePath: "/file.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("main", ["chunk1"]);

      const stats = db.getStats();

      expect(stats.embeddingCount).toBe(1);
      expect(stats.chunkCount).toBe(1);
      expect(stats.branchChunkCount).toBe(1);
      expect(stats.branchCount).toBe(1);
    });

    it("should count branches that only have symbols", () => {
      const testSymbol: SymbolData = {
        id: "sym_stats",
        filePath: "/file.ts",
        name: "statsFunction",
        kind: "function",
        startLine: 1,
        startCol: 0,
        endLine: 5,
        endCol: 0,
        language: "typescript",
      };

      db.upsertChunk({
        chunkId: "chunk_stats",
        contentHash: "hash_stats",
        filePath: "/chunk.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });
      db.addChunksToBranch("chunk-branch", ["chunk_stats"]);
      db.upsertSymbol(testSymbol);
      db.addSymbolsToBranchBatch("symbol-branch", [testSymbol.id]);

      const stats = db.getStats();

      expect(stats.branchChunkCount).toBe(1);
      expect(stats.branchCount).toBe(2);
      expect(stats.symbolCount).toBe(1);
    });
  });

  describe("batch operations", () => {
    it("should upsert embeddings in batch", () => {
      const items = [
        {
          contentHash: "batch_hash1",
          embedding: Buffer.from(new Float32Array([1.0, 2.0]).buffer),
          chunkText: "text1",
          model: "test-model",
        },
        {
          contentHash: "batch_hash2",
          embedding: Buffer.from(new Float32Array([3.0, 4.0]).buffer),
          chunkText: "text2",
          model: "test-model",
        },
        {
          contentHash: "batch_hash3",
          embedding: Buffer.from(new Float32Array([5.0, 6.0]).buffer),
          chunkText: "text3",
          model: "test-model",
        },
      ];

      db.upsertEmbeddingsBatch(items);

      expect(db.embeddingExists("batch_hash1")).toBe(true);
      expect(db.embeddingExists("batch_hash2")).toBe(true);
      expect(db.embeddingExists("batch_hash3")).toBe(true);

      const retrieved = db.getEmbedding("batch_hash2");
      expect(retrieved).not.toBeNull();
      const floats = new Float32Array(retrieved!.buffer, retrieved!.byteOffset, retrieved!.byteLength / 4);
      expect(floats[0]).toBeCloseTo(3.0);
      expect(floats[1]).toBeCloseTo(4.0);
    });

    it("should handle empty embeddings batch", () => {
      db.upsertEmbeddingsBatch([]);
      expect(db.getStats().embeddingCount).toBe(0);
    });

    it("should upsert chunks in batch", () => {
      const chunks: ChunkData[] = [
        {
          chunkId: "batch_chunk1",
          contentHash: "hash1",
          filePath: "/file1.ts",
          startLine: 1,
          endLine: 10,
          nodeType: "function",
          name: "func1",
          language: "typescript",
        },
        {
          chunkId: "batch_chunk2",
          contentHash: "hash2",
          filePath: "/file2.ts",
          startLine: 20,
          endLine: 30,
          nodeType: "class",
          name: "MyClass",
          language: "typescript",
        },
        {
          chunkId: "batch_chunk3",
          contentHash: "hash3",
          filePath: "/file1.ts",
          startLine: 50,
          endLine: 60,
          language: "typescript",
        },
      ];

      db.upsertChunksBatch(chunks);

      const chunk1 = db.getChunk("batch_chunk1");
      expect(chunk1).not.toBeNull();
      expect(chunk1!.filePath).toBe("/file1.ts");
      expect(chunk1!.name).toBe("func1");

      const chunk2 = db.getChunk("batch_chunk2");
      expect(chunk2).not.toBeNull();
      expect(chunk2!.nodeType).toBe("class");

      const chunk3 = db.getChunk("batch_chunk3");
      expect(chunk3).not.toBeNull();

      const file1Chunks = db.getChunksByFile("/file1.ts");
      expect(file1Chunks.length).toBe(2);
    });

    it("should handle empty chunks batch", () => {
      db.upsertChunksBatch([]);
      expect(db.getStats().chunkCount).toBe(0);
    });

    it("should persist git blame metadata on chunks", () => {
      db.upsertChunksBatch([{
        chunkId: "blamed_chunk",
        contentHash: "hash_blame",
        filePath: "/auth.ts",
        startLine: 1,
        endLine: 5,
        nodeType: "function",
        name: "validateSession",
        language: "typescript",
        blameSha: "abc123456789",
        blameAuthor: "Jane Doe",
        blameAuthorEmail: "jane@example.com",
        blameCommittedAt: 1741953600,
        blameSummary: "auth: add session validation",
      }]);

      const chunk = db.getChunk("blamed_chunk");
      expect(chunk?.blameSha).toBe("abc123456789");
      expect(chunk?.blameAuthor).toBe("Jane Doe");
      expect(chunk?.blameAuthorEmail).toBe("jane@example.com");
      expect(chunk?.blameCommittedAt).toBe(1741953600);
      expect(chunk?.blameSummary).toBe("auth: add session validation");
    });

    it("should add chunks to branch in batch", () => {
      const chunks: ChunkData[] = [
        { chunkId: "c1", contentHash: "h1", filePath: "/f.ts", startLine: 1, endLine: 5, language: "ts" },
        { chunkId: "c2", contentHash: "h2", filePath: "/f.ts", startLine: 10, endLine: 15, language: "ts" },
        { chunkId: "c3", contentHash: "h3", filePath: "/f.ts", startLine: 20, endLine: 25, language: "ts" },
      ];
      db.upsertChunksBatch(chunks);

      db.addChunksToBranchBatch("feature-branch", ["c1", "c2", "c3"]);

      const branchChunks = db.getBranchChunkIds("feature-branch");
      expect(branchChunks.length).toBe(3);
      expect(branchChunks).toContain("c1");
      expect(branchChunks).toContain("c2");
      expect(branchChunks).toContain("c3");
    });

    it("should handle empty branch batch", () => {
      db.addChunksToBranchBatch("empty-branch", []);
      expect(db.getBranchChunkIds("empty-branch").length).toBe(0);
    });

    it("should update existing chunks in batch", () => {
      db.upsertChunk({
        chunkId: "update_chunk",
        contentHash: "old_hash",
        filePath: "/old.ts",
        startLine: 1,
        endLine: 5,
        language: "typescript",
      });

      db.upsertChunksBatch([{
        chunkId: "update_chunk",
        contentHash: "new_hash",
        filePath: "/new.ts",
        startLine: 10,
        endLine: 20,
        language: "typescript",
      }]);

      const chunk = db.getChunk("update_chunk");
      expect(chunk!.contentHash).toBe("new_hash");
      expect(chunk!.filePath).toBe("/new.ts");
      expect(chunk!.startLine).toBe(10);
    });
  });
});
