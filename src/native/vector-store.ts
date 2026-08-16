import type { ChunkMetadata, SearchResult } from "./types.js";
import { native } from "./binding.js";

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

  search(queryVector: number[], limit: number = 10, allowedIds?: string[]): SearchResult[] {
    if (queryVector.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${queryVector.length}`
      );
    }
    const results = allowedIds === undefined
      ? this.inner.search(queryVector, limit)
      : this.inner.searchFiltered(queryVector, limit, allowedIds);
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
