import type {
  BranchDelta,
  CallEdgeData,
  CallSiteData,
  CentralityData,
  ChunkData,
  ChunkMetadata,
  CodeChunk,
  CommunityData,
  DatabaseStats,
  DynamicBatchOptions,
  FileInput,
  KeywordSearchResult,
  ParsedFile,
  ParsedSymbol,
  PathHopData,
  ReachabilityData,
  SearchResult,
  SymbolData,
  CallType,
  Confidence,
  ChunkType,
} from "./types.js";
import { native } from "./binding.js";
import {
  createDynamicBatches,
  createEmbeddingText,
  createEmbeddingTexts,
  estimateTokens,
} from "./embedding.js";

export type {
  BranchDelta,
  CallEdgeData,
  CallSiteData,
  CallType,
  CentralityData,
  ChunkData,
  ChunkMetadata,
  ChunkType,
  Confidence,
  CodeChunk,
  CommunityData,
  DatabaseStats,
  DynamicBatchOptions,
  FileInput,
  KeywordSearchResult,
  ParsedFile,
  ParsedSymbol,
  PathHopData,
  ReachabilityData,
  SearchResult,
  SymbolData,
};

export { estimateTokens, createDynamicBatches, createEmbeddingText, createEmbeddingTexts };

export function parseFile(filePath: string, content: string): CodeChunk[] {
  const result = native.parseFile(filePath, content);
  return result.map(mapChunk);
}

export function parseFileAsText(filePath: string, content: string): CodeChunk[] {
  const result = native.parseFileAsText(filePath, content);
  return result.map(mapChunk);
}

export function parseFiles(files: FileInput[]): ParsedFile[] {
  const result = native.parseFiles(files);
  return result.map((f: any) => ({
    path: f.path,
    chunks: f.chunks.map(mapChunk),
    symbols: (f.symbols ?? []).map(mapParsedSymbol),
    hash: f.hash,
  }));
}

function mapParsedSymbol(symbol: any): ParsedSymbol {
  return {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.startLine ?? symbol.start_line,
    startCol: symbol.startCol ?? symbol.start_col,
    endLine: symbol.endLine ?? symbol.end_line,
    endCol: symbol.endCol ?? symbol.end_col,
    language: symbol.language,
  };
}

function mapChunk(c: any): CodeChunk {
  return {
    content: c.content,
    startLine: c.startLine ?? c.start_line,
    startCol: c.startCol ?? c.start_col,
    endLine: c.endLine ?? c.end_line,
    endCol: c.endCol ?? c.end_col,
    chunkType: (c.chunkType ?? c.chunk_type) as ChunkType,
    name: c.name ?? undefined,
    language: c.language,
  };
}

export function hashContent(content: string): string {
  return native.hashContent(content);
}

export function hashFile(filePath: string): string {
  return native.hashFile(filePath);
}

export function extractCalls(content: string, language: string): CallSiteData[] {
  return native.extractCalls(content, language);
}

export class VectorStore {
  private inner: any;
  private dimensions: number;

  constructor(indexPath: string, dimensions: number) {
    this.inner = new native.VectorStore(indexPath, dimensions);
    this.dimensions = dimensions;
  }

  add(id: string, vector: number[], metadata: ChunkMetadata): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }
    this.inner.add(id, vector, JSON.stringify(metadata));
  }

  addBatch(
    items: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }>
  ): void {
    const ids = items.map((i) => i.id);
    const vectors = items.map((i) => {
      if (i.vector.length !== this.dimensions) {
        throw new Error(
          `Vector dimension mismatch for ${i.id}: expected ${this.dimensions}, got ${i.vector.length}`
        );
      }
      return i.vector;
    });
    const metadata = items.map((i) => JSON.stringify(i.metadata));
    this.inner.addBatch(ids, vectors, metadata);
  }

  search(queryVector: number[], limit: number = 10): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }
    const results = this.inner.search(queryVector, limit);
    return results.map((r: any) => ({
      id: r.id,
      score: r.score,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  remove(id: string): boolean {
    return this.inner.remove(id);
  }

  save(): void {
    this.inner.save();
  }

  load(): void {
    this.inner.load();
  }

  loadStrict(): void {
    this.inner.loadStrict();
  }

  hasFingerprint(): boolean {
    return this.inner.hasFingerprint();
  }

  count(): number {
    return this.inner.count();
  }

  clear(): void {
    this.inner.clear();
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getAllKeys(): string[] {
    return this.inner.getAllKeys();
  }

  getAllMetadata(): Array<{ key: string; metadata: ChunkMetadata }> {
    const results = this.inner.getAllMetadata();
    return results.map((r: { key: string; metadata: string }) => ({
      key: r.key,
      metadata: JSON.parse(r.metadata) as ChunkMetadata,
    }));
  }

  getMetadata(id: string): ChunkMetadata | undefined {
    const result = this.inner.getMetadata(id);
    if (result === null || result === undefined) {
      return undefined;
    }
    return JSON.parse(result) as ChunkMetadata;
  }

  getMetadataBatch(ids: string[]): Map<string, ChunkMetadata> {
    const results = this.inner.getMetadataBatch(ids);
    const map = new Map<string, ChunkMetadata>();
    for (const { key, metadata } of results) {
      map.set(key, JSON.parse(metadata) as ChunkMetadata);
    }
    return map;
  }
}

export class InvertedIndex {
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

  serialize(): string {
    return this.inner.serialize();
  }

  deserialize(json: string): void {
    this.inner.deserialize(json);
  }

  addChunk(chunkId: string, content: string): void {
    this.inner.addChunk(chunkId, content);
  }

  removeChunk(chunkId: string): boolean {
    return this.inner.removeChunk(chunkId);
  }

  search(query: string, limit?: number): Map<string, number> {
    const results = this.inner.search(query, limit ?? 100);
    const map = new Map<string, number>();
    for (const r of results) {
      map.set(r.chunkId, r.score);
    }
    return map;
  }

  hasChunk(chunkId: string): boolean {
    return this.inner.hasChunk(chunkId);
  }

  clear(): void {
    this.inner.clear();
  }

  getDocumentCount(): number {
    return this.inner.documentCount();
  }
}

export class Database {
  private inner: any;
  private closed = false;

  constructor(dbPath: string) {
    this.inner = new native.Database(dbPath);
  }

  private static fromNative(inner: any): Database {
    const database = Object.create(Database.prototype) as Database;
    database.inner = inner;
    database.closed = false;
    return database;
  }

  static openReadOnly(dbPath: string): Database {
    return Database.fromNative(native.Database.openReadOnly(dbPath));
  }

  static createEmptyReadOnly(): Database {
    return Database.fromNative(native.Database.createEmptyReadOnly());
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw new Error("Database is closed");
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    if (typeof this.inner.close === "function") {
      this.inner.close();
    }

    this.closed = true;
  }

  embeddingExists(contentHash: string): boolean {
    this.throwIfClosed();
    return this.inner.embeddingExists(contentHash);
  }

  getEmbedding(contentHash: string): Buffer | null {
    this.throwIfClosed();
    return this.inner.getEmbedding(contentHash) ?? null;
  }

  upsertEmbedding(
    contentHash: string,
    embedding: Buffer,
    chunkText: string,
    model: string
  ): void {
    this.throwIfClosed();
    this.inner.upsertEmbedding(contentHash, embedding, chunkText, model);
  }

  upsertEmbeddingsBatch(
    items: Array<{
      contentHash: string;
      embedding: Buffer;
      chunkText: string;
      model: string;
    }>
  ): void {
    this.throwIfClosed();
    if (items.length === 0) return;
    this.inner.upsertEmbeddingsBatch(items);
  }

  getMissingEmbeddings(contentHashes: string[]): string[] {
    this.throwIfClosed();
    return this.inner.getMissingEmbeddings(contentHashes);
  }

  upsertChunk(chunk: ChunkData): void {
    this.throwIfClosed();
    this.inner.upsertChunk(chunk);
  }

  upsertChunksBatch(chunks: ChunkData[]): void {
    this.throwIfClosed();
    if (chunks.length === 0) return;
    this.inner.upsertChunksBatch(chunks);
  }

  getChunk(chunkId: string): ChunkData | null {
    this.throwIfClosed();
    return this.inner.getChunk(chunkId) ?? null;
  }

  getChunksByFile(filePath: string): ChunkData[] {
    this.throwIfClosed();
    return this.inner.getChunksByFile(filePath);
  }

  getChunksByName(name: string): ChunkData[] {
    this.throwIfClosed();
    return this.inner.getChunksByName(name);
  }

  getChunksByNameCi(name: string): ChunkData[] {
    this.throwIfClosed();
    return this.inner.getChunksByNameCi(name);
  }

  deleteChunksByFile(filePath: string): number {
    this.throwIfClosed();
    return this.inner.deleteChunksByFile(filePath);
  }

  deleteChunksByIds(chunkIds: string[]): number {
    this.throwIfClosed();
    if (chunkIds.length === 0) return 0;
    return this.inner.deleteChunksByIds(chunkIds);
  }

  addChunksToBranch(branch: string, chunkIds: string[]): void {
    this.throwIfClosed();
    this.inner.addChunksToBranch(branch, chunkIds);
  }

  addChunksToBranchBatch(branch: string, chunkIds: string[]): void {
    this.throwIfClosed();
    if (chunkIds.length === 0) return;
    this.inner.addChunksToBranchBatch(branch, chunkIds);
  }

  clearBranch(branch: string): number {
    this.throwIfClosed();
    return this.inner.clearBranch(branch);
  }

  deleteBranchChunksByChunkIds(chunkIds: string[]): number {
    this.throwIfClosed();
    if (chunkIds.length === 0) return 0;
    return this.inner.deleteBranchChunksByChunkIds(chunkIds);
  }

  deleteBranchChunksForBranch(branch: string, chunkIds: string[]): number {
    this.throwIfClosed();
    if (chunkIds.length === 0) return 0;
    return this.inner.deleteBranchChunksForBranch(branch, chunkIds);
  }

  getBranchChunkIds(branch: string): string[] {
    this.throwIfClosed();
    return this.inner.getBranchChunkIds(branch);
  }

  getBranchDelta(branch: string, baseBranch: string): BranchDelta {
    this.throwIfClosed();
    return this.inner.getBranchDelta(branch, baseBranch);
  }

  getReferencedChunkIds(chunkIds: string[]): string[] {
    this.throwIfClosed();
    if (chunkIds.length === 0) return [];
    return this.inner.getReferencedChunkIds(chunkIds);
  }

  chunkExistsOnBranch(branch: string, chunkId: string): boolean {
    this.throwIfClosed();
    return this.inner.chunkExistsOnBranch(branch, chunkId);
  }

  getAllBranches(): string[] {
    this.throwIfClosed();
    return this.inner.getAllBranches();
  }

  getMetadata(key: string): string | null {
    this.throwIfClosed();
    return this.inner.getMetadata(key) ?? null;
  }

  setMetadata(key: string, value: string): void {
    this.throwIfClosed();
    this.inner.setMetadata(key, value);
  }

  deleteMetadata(key: string): boolean {
    this.throwIfClosed();
    return this.inner.deleteMetadata(key);
  }

  clearAllIndexedData(): void {
    this.throwIfClosed();
    this.inner.clearAllIndexedData();
  }

  clearCallEdgeTargetsForSymbols(symbolIds: string[]): number {
    this.throwIfClosed();
    if (symbolIds.length === 0) return 0;
    return this.inner.clearCallEdgeTargetsForSymbols(symbolIds);
  }

  gcOrphanEmbeddings(): number {
    this.throwIfClosed();
    return this.inner.gcOrphanEmbeddings();
  }

  gcOrphanChunks(): number {
    this.throwIfClosed();
    return this.inner.gcOrphanChunks();
  }

  getStats(): DatabaseStats {
    this.throwIfClosed();
    return this.inner.getStats();
  }

  upsertSymbol(symbol: SymbolData): void {
    this.throwIfClosed();
    this.inner.upsertSymbol(symbol);
  }

  upsertSymbolsBatch(symbols: SymbolData[]): void {
    this.throwIfClosed();
    if (symbols.length === 0) return;
    this.inner.upsertSymbolsBatch(symbols);
  }

  getSymbolsByFile(filePath: string): SymbolData[] {
    this.throwIfClosed();
    return this.inner.getSymbolsByFile(filePath);
  }

  getSymbolByName(name: string, filePath: string): SymbolData | null {
    this.throwIfClosed();
    return this.inner.getSymbolByName(name, filePath) ?? null;
  }

  getSymbolsByName(name: string): SymbolData[] {
    this.throwIfClosed();
    return this.inner.getSymbolsByName(name);
  }

  getSymbolsByNameCi(name: string): SymbolData[] {
    this.throwIfClosed();
    return this.inner.getSymbolsByNameCi(name);
  }
  getSymbolsForBranch(branch: string): SymbolData[] {
    this.throwIfClosed();
    return this.inner.getSymbolsForBranch(branch);
  }

  getSymbolsForFiles(filePaths: string[], branch: string): SymbolData[] {
    this.throwIfClosed();
    return this.inner.getSymbolsForFiles(filePaths, branch);
  }

  deleteSymbolsByFile(filePath: string): number {
    this.throwIfClosed();
    return this.inner.deleteSymbolsByFile(filePath);
  }

  upsertCallEdge(edge: CallEdgeData): void {
    this.throwIfClosed();
    this.inner.upsertCallEdge(edge);
  }

  upsertCallEdgesBatch(edges: CallEdgeData[]): void {
    this.throwIfClosed();
    if (edges.length === 0) return;
    this.inner.upsertCallEdgesBatch(edges);
  }

  getCallers(targetName: string, branch: string, callTypeFilter?: string): CallEdgeData[] {
    this.throwIfClosed();
    return this.inner.getCallers(targetName, branch, callTypeFilter ?? null);
  }

  getCallersWithContext(
    targetName: string,
    branch: string,
    callTypeFilter?: string
  ): CallEdgeData[] {
    this.throwIfClosed();
    return this.inner.getCallersWithContext(targetName, branch, callTypeFilter ?? null);
  }

  getCallees(symbolId: string, branch: string, callTypeFilter?: string): CallEdgeData[] {
    this.throwIfClosed();
    return this.inner.getCallees(symbolId, branch, callTypeFilter ?? null);
  }

  deleteCallEdgesByFile(filePath: string): number {
    this.throwIfClosed();
    return this.inner.deleteCallEdgesByFile(filePath);
  }

  resolveCallEdge(edgeId: string, toSymbolId: string): void {
    this.throwIfClosed();
    this.inner.resolveCallEdge(edgeId, toSymbolId);
  }

  findShortestPath(
    fromName: string,
    toName: string,
    branch: string,
    maxDepth?: number
  ): PathHopData[] {
    this.throwIfClosed();
    return this.inner.findShortestPath(fromName, toName, branch, maxDepth ?? null);
  }

  addSymbolsToBranch(branch: string, symbolIds: string[]): void {
    this.throwIfClosed();
    this.inner.addSymbolsToBranch(branch, symbolIds);
  }

  addSymbolsToBranchBatch(branch: string, symbolIds: string[]): void {
    this.throwIfClosed();
    if (symbolIds.length === 0) return;
    this.inner.addSymbolsToBranchBatch(branch, symbolIds);
  }

  getBranchSymbolIds(branch: string): string[] {
    this.throwIfClosed();
    return this.inner.getBranchSymbolIds(branch);
  }

  clearBranchSymbols(branch: string): number {
    this.throwIfClosed();
    return this.inner.clearBranchSymbols(branch);
  }

  getReferencedSymbolIds(symbolIds: string[]): string[] {
    this.throwIfClosed();
    if (symbolIds.length === 0) return [];
    return this.inner.getReferencedSymbolIds(symbolIds);
  }

  deleteBranchSymbolsBySymbolIds(symbolIds: string[]): number {
    this.throwIfClosed();
    if (symbolIds.length === 0) return 0;
    return this.inner.deleteBranchSymbolsBySymbolIds(symbolIds);
  }

  deleteBranchSymbolsForBranch(branch: string, symbolIds: string[]): number {
    this.throwIfClosed();
    if (symbolIds.length === 0) return 0;
    return this.inner.deleteBranchSymbolsForBranch(branch, symbolIds);
  }

  gcOrphanSymbols(): number {
    this.throwIfClosed();
    return this.inner.gcOrphanSymbols();
  }

  gcOrphanCallEdges(): number {
    this.throwIfClosed();
    return this.inner.gcOrphanCallEdges();
  }

  getTransitiveReachability(
    rootSymbolIds: string[],
    branch: string,
    direction: string,
    maxDepth?: number
  ): ReachabilityData[] {
    this.throwIfClosed();
    return this.inner.getTransitiveReachability(
      rootSymbolIds,
      branch,
      direction,
      maxDepth ?? null
    );
  }

  detectCommunities(
    branch: string,
    symbolIds?: string[]
  ): CommunityData[] {
    this.throwIfClosed();
    return this.inner.detectCommunities(branch, symbolIds ?? null);
  }

  computeCentrality(branch: string): CentralityData[] {
    this.throwIfClosed();
    return this.inner.computeCentrality(branch);
  }
}

export function generateChunkId(filePath: string, chunk: CodeChunk): string {
  const hash = hashContent(`${filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content}`);
  return `chunk_${hash.slice(0, 16)}`;
}

export function generateChunkHash(chunk: CodeChunk): string {
  return hashContent(chunk.content);
}
