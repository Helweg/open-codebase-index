import type { CallSiteData, CodeChunk, FileInput, ParsedFile, ParsedSymbol, ChunkType } from "./types.js";
import { native } from "./binding.js";

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

export function generateChunkId(filePath: string, chunk: CodeChunk): string {
  const hash = hashContent(`${filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content}`);
  return `chunk_${hash.slice(0, 16)}`;
}

export function generateChunkHash(chunk: CodeChunk): string {
  return hashContent(chunk.content);
}
