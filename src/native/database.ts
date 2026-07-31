import type {
  BranchDelta,
  CallEdgeData,
  CentralityData,
  ChunkData,
  CommunityData,
  DatabaseStats,
  PathHopData,
  ReachabilityData,
  SymbolData,
} from "./types.js";
import { native } from "./binding.js";

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

  beginWriteTransaction(): void {
    this.throwIfClosed();
    this.inner.beginWriteTransaction();
  }

  commitWriteTransaction(): void {
    this.throwIfClosed();
    this.inner.commitWriteTransaction();
  }

  rollbackWriteTransaction(): void {
    this.throwIfClosed();
    this.inner.rollbackWriteTransaction();
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
