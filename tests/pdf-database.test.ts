import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database, type ChunkData } from "../src/native/index.js";

function pdfChunk(overrides: Partial<ChunkData> = {}): ChunkData {
  return {
    chunkId: "pdf-chunk-1",
    contentHash: "pdf-hash-1",
    filePath: "/documents/guide.pdf",
    startLine: 1,
    endLine: 20,
    nodeType: "document_section",
    name: "Installation",
    language: "text",
    documentKind: "pdf",
    pageStart: 2,
    pageEnd: 4,
    sourceText: "Extracted text from physical PDF pages 2 through 4.",
    ...overrides,
  };
}

describe("PDF database metadata persistence", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-db-test-"));
    dbPath = path.join(tempDir, "index.db");
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists PDF metadata through single upserts and file/name lookups", () => {
    db = new Database(dbPath);
    const chunk = pdfChunk();

    db.upsertChunk(chunk);

    expect(db.getChunk(chunk.chunkId)).toMatchObject(chunk);
    expect(db.getChunksByFile(chunk.filePath)).toEqual([expect.objectContaining(chunk)]);
    expect(db.getChunksByName(chunk.name!)).toEqual([expect.objectContaining(chunk)]);
    expect(db.getChunksByNameCi(chunk.name!.toUpperCase())).toEqual([
      expect.objectContaining(chunk),
    ]);
  });

  it("persists batch metadata, shared branch references, and restart reads", () => {
    db = new Database(dbPath);
    const first = pdfChunk();
    const second = pdfChunk({
      chunkId: "pdf-chunk-2",
      contentHash: "pdf-hash-2",
      startLine: 21,
      endLine: 35,
      name: "Configuration",
      pageStart: 5,
      pageEnd: 5,
      sourceText: "Extracted text from physical PDF page 5.",
    });

    db.upsertChunksBatch([first, second]);
    db.addChunksToBranchBatch("main", [first.chunkId, second.chunkId]);
    db.addChunksToBranchBatch("release", [first.chunkId]);
    db.close();

    db = new Database(dbPath);
    expect(db.getBranchChunkIds("main")).toEqual([first.chunkId, second.chunkId]);
    expect(db.getBranchChunkIds("release")).toEqual([first.chunkId]);
    expect(db.getChunk(first.chunkId)).toMatchObject(first);
    expect(db.getChunk(second.chunkId)).toMatchObject(second);
  });

  it("orders page-local line ranges by physical page", () => {
    db = new Database(dbPath);
    const laterPage = pdfChunk({
      chunkId: "page-8",
      contentHash: "page-8-hash",
      name: "Later page",
      startLine: 1,
      endLine: 10,
      pageStart: 8,
      pageEnd: 8,
    });
    const earlierPage = pdfChunk({
      chunkId: "page-3",
      contentHash: "page-3-hash",
      name: "Earlier page",
      startLine: 1,
      endLine: 10,
      pageStart: 3,
      pageEnd: 3,
    });

    db.upsertChunksBatch([laterPage, earlierPage]);

    expect(db.getChunksByFile(laterPage.filePath).map((chunk) => chunk.chunkId)).toEqual([
      earlierPage.chunkId,
      laterPage.chunkId,
    ]);
  });

  it("migrates schema 7 additively and preserves existing chunk rows", () => {
    new Database(dbPath).close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      ALTER TABLE chunks DROP COLUMN document_kind;
      ALTER TABLE chunks DROP COLUMN page_start;
      ALTER TABLE chunks DROP COLUMN page_end;
      ALTER TABLE chunks DROP COLUMN source_text;
      UPDATE metadata SET value = '7' WHERE key = 'schema_version';
      INSERT INTO chunks (
        chunk_id, content_hash, file_path, start_line, end_line, node_type, name, language
      ) VALUES (
        'legacy-code', 'legacy-hash', '/src/legacy.ts', 1, 3, 'function', 'legacy', 'typescript'
      );
    `);
    legacy.close();

    db = new Database(dbPath);

    expect(db.getMetadata("schema_version")).toBe("9");
    const migrated = db.getChunk("legacy-code")!;
    expect(migrated).toMatchObject({
      chunkId: "legacy-code",
      contentHash: "legacy-hash",
      filePath: "/src/legacy.ts",
      startLine: 1,
      endLine: 3,
      nodeType: "function",
      name: "legacy",
      language: "typescript",
    });
    expect(migrated).not.toHaveProperty("documentKind");
    expect(migrated).not.toHaveProperty("pageStart");
    expect(migrated).not.toHaveProperty("pageEnd");
    expect(migrated).not.toHaveProperty("sourceText");
  });
});
