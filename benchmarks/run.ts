/**
 * Synthetic benchmark for open-codebase-index
 * 
 * Measures performance of:
 * - File parsing (tree-sitter)
 * - Vector store operations (add, search)
 * - Inverted index operations (add, search)
 * - Database operations
 * 
 * Run with: npx tsx benchmarks/run.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const nativePath = path.join(__dirname, "../native/codebase-index-native.darwin-arm64.node");
const native = require(nativePath);

interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: string;
  name?: string;
  language: string;
}

interface ParsedFile {
  path: string;
  chunks: CodeChunk[];
  hash: string;
}

interface ChunkMetadata {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: string;
  name?: string;
  language: string;
  hash: string;
}

interface SearchResult {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

function parseFiles(files: { path: string; content: string; hash: string }[]): ParsedFile[] {
  return native.parseFiles(files);
}

class VectorStore {
  private inner: any;
  private dimensions: number;

  constructor(indexPath: string, dimensions: number) {
    this.inner = new native.VectorStore(indexPath, dimensions);
    this.dimensions = dimensions;
  }

  add(id: string, vector: number[], metadata: ChunkMetadata): void {
    this.inner.add(id, vector, JSON.stringify(metadata));
  }

  addBatch(items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>): void {
    const ids = items.map((i) => i.id);
    const vectors = items.map((i) => i.vector);
    const metadataArr = items.map((i) => JSON.stringify(i.metadata));
    this.inner.addBatch(ids, vectors, metadataArr);
  }

  search(queryVector: number[], limit: number = 10): SearchResult[] {
    const results = this.inner.search(queryVector, limit);
    return results.map((r: any) => ({
      id: r.id,
      score: r.score,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  save(): void {
    this.inner.save();
  }

  load(): void {
    this.inner.load();
  }

  count(): number {
    return this.inner.count();
  }
}

class InvertedIndex {
  private inner: any;

  constructor(indexPath: string) {
    this.inner = new native.InvertedIndex(indexPath);
  }

  load(): void {
    this.inner.load();
  }

  save(): void {
    this.inner.save();
  }

  addChunk(chunkId: string, content: string): void {
    this.inner.addChunk(chunkId, content);
  }

  search(query: string, limit?: number): Map<string, number> {
    const results = this.inner.search(query, limit ?? 100);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.chunkId, r.score);
    }
    return map;
  }
}

class Database {
  private inner: any;

  constructor(dbPath: string) {
    this.inner = new native.Database(dbPath);
  }

  upsertEmbedding(contentHash: string, embedding: Buffer, chunkText: string, model: string): void {
    this.inner.upsertEmbedding(contentHash, embedding, chunkText, model);
  }

  upsertEmbeddingsBatch(items: Array<{
    contentHash: string;
    embedding: Buffer;
    chunkText: string;
    model: string;
  }>): void {
    this.inner.upsertEmbeddingsBatch(items);
  }

  upsertChunk(data: {
    chunkId: string;
    contentHash: string;
    filePath: string;
    startLine: number;
    endLine: number;
    nodeType?: string;
    name?: string;
    language: string;
  }): void {
    this.inner.upsertChunk(data);
  }

  upsertChunksBatch(chunks: Array<{
    chunkId: string;
    contentHash: string;
    filePath: string;
    startLine: number;
    endLine: number;
    nodeType?: string;
    name?: string;
    language: string;
  }>): void {
    this.inner.upsertChunksBatch(chunks);
  }

  addChunksToBranch(branch: string, chunkIds: string[]): void {
    this.inner.addChunksToBranch(branch, chunkIds);
  }

  addChunksToBranchBatch(branch: string, chunkIds: string[]): void {
    this.inner.addChunksToBranchBatch(branch, chunkIds);
  }

  getBranchChunkIds(branch: string): string[] {
    return this.inner.getBranchChunkIds(branch);
  }

  embeddingExists(contentHash: string): boolean {
    return this.inner.embeddingExists(contentHash);
  }

  getMissingEmbeddings(hashes: string[]): string[] {
    return this.inner.getMissingEmbeddings(hashes);
  }
}

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  opsPerSec: number;
  metadata?: Record<string, number | string>;
}

const results: BenchmarkResult[] = [];

function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function benchmark(
  name: string,
  fn: () => void,
  iterations: number = 1,
  metadata?: Record<string, number | string>
): BenchmarkResult {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const totalMs = performance.now() - start;
  const avgMs = totalMs / iterations;
  const opsPerSec = 1000 / avgMs;

  const result: BenchmarkResult = {
    name,
    iterations,
    totalMs,
    avgMs,
    opsPerSec,
    metadata,
  };
  results.push(result);

  console.log(
    `  ${name}: ${formatNumber(avgMs)}ms avg (${formatNumber(opsPerSec)} ops/sec)${
      metadata ? ` | ${JSON.stringify(metadata)}` : ""
    }`
  );

  return result;
}

async function benchmarkAsync(
  name: string,
  fn: () => Promise<void>,
  iterations: number = 1,
  metadata?: Record<string, number | string>
): Promise<BenchmarkResult> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const totalMs = performance.now() - start;
  const avgMs = totalMs / iterations;
  const opsPerSec = 1000 / avgMs;

  const result: BenchmarkResult = {
    name,
    iterations,
    totalMs,
    avgMs,
    opsPerSec,
    metadata,
  };
  results.push(result);

  console.log(
    `  ${name}: ${formatNumber(avgMs)}ms avg (${formatNumber(opsPerSec)} ops/sec)${
      metadata ? ` | ${JSON.stringify(metadata)}` : ""
    }`
  );

  return result;
}

function generateTypeScriptFile(numFunctions: number): string {
  const lines: string[] = [];
  lines.push('import { something } from "./utils";');
  lines.push("");

  for (let i = 0; i < numFunctions; i++) {
    lines.push(`/**`);
    lines.push(` * Function ${i} that performs calculation ${i}`);
    lines.push(` * @param input - The input value`);
    lines.push(` * @returns The computed result`);
    lines.push(` */`);
    lines.push(`export function calculate${i}(input: number): number {`);
    lines.push(`  const result = input * ${i + 1};`);
    lines.push(`  if (result > 100) {`);
    lines.push(`    return result / 2;`);
    lines.push(`  }`);
    lines.push(`  return result + ${i};`);
    lines.push(`}`);
    lines.push("");
  }

  lines.push(`export interface DataModel${numFunctions} {`);
  lines.push(`  id: string;`);
  lines.push(`  name: string;`);
  lines.push(`  value: number;`);
  lines.push(`  metadata: Record<string, unknown>;`);
  lines.push(`}`);
  lines.push("");

  lines.push(`export class Service${numFunctions} {`);
  lines.push(`  private data: DataModel${numFunctions}[] = [];`);
  lines.push("");
  lines.push(`  async fetchData(): Promise<DataModel${numFunctions}[]> {`);
  lines.push(`    return this.data;`);
  lines.push(`  }`);
  lines.push("");
  lines.push(`  async saveData(item: DataModel${numFunctions}): Promise<void> {`);
  lines.push(`    this.data.push(item);`);
  lines.push(`  }`);
  lines.push(`}`);

  return lines.join("\n");
}

function generateRandomEmbedding(dimensions: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    embedding.push(Math.random() * 2 - 1);
  }
  return embedding;
}

async function runBenchmarks(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-"));
  console.log(`\nBenchmark temp directory: ${tempDir}\n`);

  try {
    // ============================================
    // 1. FILE GENERATION
    // ============================================
    console.log("=== File Generation ===");

    const fileCounts = [10, 50, 100, 500];
    const functionsPerFile = 10;

    for (const fileCount of fileCounts) {
      const filesDir = path.join(tempDir, `files-${fileCount}`);
      fs.mkdirSync(filesDir, { recursive: true });

      benchmark(
        `Generate ${fileCount} files (${functionsPerFile} funcs each)`,
        () => {
          for (let i = 0; i < fileCount; i++) {
            const content = generateTypeScriptFile(functionsPerFile);
            fs.writeFileSync(path.join(filesDir, `file${i}.ts`), content);
          }
        },
        1,
        { files: fileCount, functionsPerFile }
      );
    }

    // ============================================
    // 2. PARSING PERFORMANCE
    // ============================================
    console.log("\n=== Parsing Performance (tree-sitter) ===");

    for (const fileCount of fileCounts) {
      const filesDir = path.join(tempDir, `files-${fileCount}`);
      const files: { path: string; content: string; hash: string }[] = [];

      const fileNames = fs.readdirSync(filesDir);
      for (const fileName of fileNames) {
        const filePath = path.join(filesDir, fileName);
        const content = fs.readFileSync(filePath, "utf-8");
        files.push({ path: filePath, content, hash: `hash-${fileName}` });
      }

      let totalChunks = 0;
      benchmark(
        `Parse ${fileCount} files`,
        () => {
          const parsed = parseFiles(files);
          totalChunks = parsed.reduce((sum, p) => sum + p.chunks.length, 0);
        },
        3,
        { files: fileCount }
      );

      console.log(`    -> Total chunks: ${totalChunks}`);
    }

    // ============================================
    // 3. VECTOR STORE PERFORMANCE
    // ============================================
    console.log("\n=== Vector Store Performance (usearch) ===");

    const dimensions = 1536;
    const vectorCounts = [100, 1000, 5000, 10000];

    for (const vectorCount of vectorCounts) {
      const storePath = path.join(tempDir, `vectors-${vectorCount}`);
      const store = new VectorStore(storePath, dimensions);

      const embeddings = Array.from({ length: vectorCount }, () =>
        generateRandomEmbedding(dimensions)
      );
      const ids = Array.from({ length: vectorCount }, (_, i) => `chunk-${i}`);
      const metadata = ids.map((id, i) => ({
        filePath: `/file${i % 100}.ts`,
        startLine: i * 10,
        endLine: i * 10 + 10,
        chunkType: "function" as const,
        name: `func${i}`,
        language: "typescript",
        hash: `hash-${i}`,
      }));

      benchmark(
        `Add ${vectorCount} vectors (sequential)`,
        () => {
          for (let i = 0; i < vectorCount; i++) {
            store.add(ids[i], embeddings[i], metadata[i]);
          }
        },
        1,
        { vectors: vectorCount, dimensions }
      );

      const storeBatch = new VectorStore(path.join(tempDir, `vectors-batch-${vectorCount}`), dimensions);
      const batchItems = ids.map((id, i) => ({
        id,
        vector: embeddings[i],
        metadata: metadata[i],
      }));

      benchmark(
        `Add ${vectorCount} vectors (batch)`,
        () => {
          storeBatch.addBatch(batchItems);
        },
        1,
        { vectors: vectorCount, dimensions }
      );

      const queryEmbedding = generateRandomEmbedding(dimensions);
      benchmark(
        `Search ${vectorCount} vectors (top 20)`,
        () => {
          store.search(queryEmbedding, 20);
        },
        100,
        { vectors: vectorCount }
      );

      benchmark(
        `Save ${vectorCount} vectors to disk`,
        () => {
          store.save();
        },
        1,
        { vectors: vectorCount }
      );

      const store2 = new VectorStore(storePath, dimensions);
      benchmark(
        `Load ${vectorCount} vectors from disk`,
        () => {
          store2.load();
        },
        1,
        { vectors: vectorCount }
      );
    }

    // ============================================
    // 4. INVERTED INDEX PERFORMANCE
    // ============================================
    console.log("\n=== Inverted Index Performance (BM25) ===");

    const docCounts = [100, 1000, 5000, 10000];

    for (const docCount of docCounts) {
      const indexPath = path.join(tempDir, `inverted-${docCount}.json`);
      const index = new InvertedIndex(indexPath);

      const docs = Array.from({ length: docCount }, (_, i) => ({
        id: `chunk-${i}`,
        content: `function calculate${i}(input: number): number { return input * ${i}; } // calculation helper utility method`,
      }));

      benchmark(
        `Add ${docCount} documents`,
        () => {
          for (const doc of docs) {
            index.addChunk(doc.id, doc.content);
          }
        },
        1,
        { documents: docCount }
      );

      benchmark(
        `Search ${docCount} documents`,
        () => {
          index.search("calculate input number");
        },
        100,
        { documents: docCount }
      );

      benchmark(
        `Save ${docCount} documents to disk`,
        () => {
          index.save();
        },
        1,
        { documents: docCount }
      );

      const index2 = new InvertedIndex(indexPath);
      benchmark(
        `Load ${docCount} documents from disk`,
        () => {
          index2.load();
        },
        1,
        { documents: docCount }
      );
    }

    // ============================================
    // 5. DATABASE PERFORMANCE
    // ============================================
    console.log("\n=== Database Performance (SQLite) ===");

    const chunkCounts = [100, 1000, 5000, 10000];

    for (const chunkCount of chunkCounts) {
      const dbPath = path.join(tempDir, `benchmark-${chunkCount}.db`);
      const db = new Database(dbPath);
      const dbBatch = new Database(path.join(tempDir, `benchmark-batch-${chunkCount}.db`));

      const embedding = Buffer.from(
        new Float32Array(generateRandomEmbedding(dimensions)).buffer
      );

      benchmark(
        `Insert ${chunkCount} embeddings (sequential)`,
        () => {
          for (let i = 0; i < chunkCount; i++) {
            db.upsertEmbedding(`hash-${chunkCount}-${i}`, embedding, `text-${i}`, "test-model");
          }
        },
        1,
        { embeddings: chunkCount }
      );

      const embeddingBatchItems = Array.from({ length: chunkCount }, (_, i) => ({
        contentHash: `hash-batch-${chunkCount}-${i}`,
        embedding,
        chunkText: `text-${i}`,
        model: "test-model",
      }));

      benchmark(
        `Insert ${chunkCount} embeddings (batch)`,
        () => {
          dbBatch.upsertEmbeddingsBatch(embeddingBatchItems);
        },
        1,
        { embeddings: chunkCount }
      );

      benchmark(
        `Insert ${chunkCount} chunks (sequential)`,
        () => {
          for (let i = 0; i < chunkCount; i++) {
            db.upsertChunk({
              chunkId: `chunk-${chunkCount}-${i}`,
              contentHash: `hash-${chunkCount}-${i}`,
              filePath: `/file${i % 100}.ts`,
              startLine: i * 10,
              endLine: i * 10 + 10,
              nodeType: "function",
              name: `func${i}`,
              language: "typescript",
            });
          }
        },
        1,
        { chunks: chunkCount }
      );

      const chunkBatchItems = Array.from({ length: chunkCount }, (_, i) => ({
        chunkId: `chunk-batch-${chunkCount}-${i}`,
        contentHash: `hash-batch-${chunkCount}-${i}`,
        filePath: `/file${i % 100}.ts`,
        startLine: i * 10,
        endLine: i * 10 + 10,
        nodeType: "function",
        name: `func${i}`,
        language: "typescript",
      }));

      benchmark(
        `Insert ${chunkCount} chunks (batch)`,
        () => {
          dbBatch.upsertChunksBatch(chunkBatchItems);
        },
        1,
        { chunks: chunkCount }
      );

      const chunkIds = Array.from(
        { length: chunkCount },
        (_, i) => `chunk-${chunkCount}-${i}`
      );
      benchmark(
        `Add ${chunkCount} chunks to branch (sequential)`,
        () => {
          db.addChunksToBranch(`branch-${chunkCount}`, chunkIds);
        },
        1,
        { chunks: chunkCount }
      );

      const chunkIdsBatch = Array.from(
        { length: chunkCount },
        (_, i) => `chunk-batch-${chunkCount}-${i}`
      );
      benchmark(
        `Add ${chunkCount} chunks to branch (batch)`,
        () => {
          dbBatch.addChunksToBranchBatch(`branch-batch-${chunkCount}`, chunkIdsBatch);
        },
        1,
        { chunks: chunkCount }
      );

      benchmark(
        `Get branch chunk IDs (${chunkCount})`,
        () => {
          db.getBranchChunkIds(`branch-${chunkCount}`);
        },
        100,
        { chunks: chunkCount }
      );

      benchmark(
        `Check embedding exists (${chunkCount} in DB)`,
        () => {
          db.embeddingExists(`hash-${chunkCount}-0`);
        },
        1000,
        { embeddings: chunkCount }
      );

      benchmark(
        `Get missing embeddings (batch of 100)`,
        () => {
          const hashes = Array.from({ length: 100 }, (_, i) => 
            i < 50 ? `hash-${chunkCount}-${i}` : `missing-${i}`
          );
          db.getMissingEmbeddings(hashes);
        },
        100,
        { batchSize: 100 }
      );
    }

    // ============================================
    // 6. SUMMARY
    // ============================================
    console.log("\n=== Summary ===");
    console.log(`Total benchmarks run: ${results.length}`);

    const slowest = [...results].sort((a, b) => b.avgMs - a.avgMs).slice(0, 5);
    console.log("\nSlowest operations:");
    for (const r of slowest) {
      console.log(`  ${r.name}: ${formatNumber(r.avgMs)}ms`);
    }

    const fastest = [...results].sort((a, b) => a.avgMs - b.avgMs).slice(0, 5);
    console.log("\nFastest operations:");
    for (const r of fastest) {
      console.log(`  ${r.name}: ${formatNumber(r.avgMs)}ms`);
    }

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`\nCleaned up: ${tempDir}`);
  }
}

runBenchmarks().catch(console.error);
