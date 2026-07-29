import { native } from "./binding.js";

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
