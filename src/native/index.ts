import * as path from "path";
import * as os from "os";
import * as module from "module";
import { fileURLToPath } from "url";

function getNativeBinding() {
  const platform = os.platform();
  const arch = os.arch();

  let bindingName: string;
  
  if (platform === "darwin" && arch === "arm64") {
    bindingName = "codebase-index-native.darwin-arm64.node";
  } else if (platform === "darwin" && arch === "x64") {
    bindingName = "codebase-index-native.darwin-x64.node";
  } else if (platform === "linux" && arch === "x64") {
    bindingName = "codebase-index-native.linux-x64-gnu.node";
  } else if (platform === "linux" && arch === "arm64") {
    bindingName = "codebase-index-native.linux-arm64-gnu.node";
  } else if (platform === "win32" && arch === "x64") {
    bindingName = "codebase-index-native.win32-x64-msvc.node";
  } else {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  // Determine the current directory - handle ESM, CJS, and bundled contexts
  let currentDir: string;
  let requireTarget: string;
  
  // Check for ESM context with valid import.meta.url
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
    requireTarget = import.meta.url;
  } 
  // Fallback to __dirname for CJS/bundled contexts
  else if (typeof __dirname !== 'undefined') {
    currentDir = __dirname;
    requireTarget = __filename;
  }
  // Last resort: use process.cwd() - shouldn't normally hit this
  else {
    currentDir = process.cwd();
    requireTarget = path.join(currentDir, "index.js");
  }
  
  // The native module is in the 'native' folder at package root
  // From dist/index.js, we go up one level to package root, then into native/
  // From src/native/index.ts (dev/test), we go up two levels to package root
  const normalizedDir = currentDir.replace(/\\/g, '/');
  const isDevMode = normalizedDir.includes('/src/native') || currentDir.includes(path.join('src', 'native'));
  const packageRoot = isDevMode
    ? path.resolve(currentDir, '../..')
    : path.resolve(currentDir, '..');
  const nativePath = path.join(packageRoot, 'native', bindingName);
  
  // Load the native module - use standard require for .node files
  const require = module.createRequire(requireTarget);
  return require(nativePath);
}

function createMockNativeBinding() {
  const error = new Error("Native module not available. Please rebuild with 'npm run build:native'.");
  
  return {
    parseFile: () => { throw error; },
    parseFiles: () => { throw error; },
    hashContent: () => { throw error; },
    hashFile: () => { throw error; },
    extractCalls: () => { throw error; },
    VectorStore: class {
      constructor() { throw error; }
    },
    InvertedIndex: class {
      constructor() { throw error; }
      serialize() { throw error; }
      deserialize() { throw error; }
    },
    Database: class {
      constructor() { throw error; }
      static openReadOnly() { throw error; }
      static createEmptyReadOnly() { throw error; }
      close() { throw error; }
      getTransitiveReachability() { throw error; }
      detectCommunities() { throw error; }
      computeCentrality() { throw error; }
    },
}
}

let native: any;
try {
  native = getNativeBinding();
} catch (e) {
  console.error("[codebase-index] Failed to load native module:", e);
  native = createMockNativeBinding();
}

export interface FileInput {
  path: string;
  content: string;
}

export interface CodeChunk {
  content: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
}

export type ChunkType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "impl"
  | "trait"
  | "module"
  | "import"
  | "export"
  | "comment"
  | "other";

export interface ParsedFile {
  path: string;
  chunks: CodeChunk[];
  hash: string;
}


export type Confidence = "Direct" | "Inferred";

export type CallType = "Call" | "MethodCall" | "Constructor" | "Import" | "Inherits" | "Implements";

export interface CallSiteData {
  calleeName: string;
  line: number;
  column: number;
  callType: CallType;
  confidence: Confidence;
}

export interface SymbolData {
  id: string;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  language: string;
}

export interface CallEdgeData {
  id: string;
  fromSymbolId: string;
  fromSymbolName?: string;
  fromSymbolFilePath?: string;
  targetName: string;
  toSymbolId?: string;
  callType: string;
  confidence: string;
  line: number;
  col: number;
  isResolved: boolean;
}

export interface PathHopData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  line: number;
  callType: string;
}

export interface ReachabilityData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  depth: number;
}

export interface CommunityData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  communityId: number;
  communityLabel: string;
}

export interface CentralityData {
  symbolId: string;
  symbolName: string;
  filePath: string;
  callerCount: number;
  calleeCount: number;
  totalConnections: number;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  filePath: string;
  startLine: number;
  endLine: number;
  chunkType: ChunkType;
  name?: string;
  language: string;
  hash: string;
  blameSha?: string;
  blameAuthor?: string;
  blameAuthorEmail?: string;
  blameCommittedAt?: number;
  blameSummary?: string;
}

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
    hash: f.hash,
  }));
}

function mapChunk(c: any): CodeChunk {
  return {
    content: c.content,
    startLine: c.startLine ?? c.start_line,
    endLine: c.endLine ?? c.end_line,
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

// Token estimation: ~4 chars per token for code (conservative)
const CHARS_PER_TOKEN = 4;
const MAX_BATCH_TOKENS = 7500; // Leave buffer under 8192 API limit
const MAX_SINGLE_CHUNK_TOKENS = 2000; // Default truncation cap for individual chunks

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function getEmbeddingHeaderParts(chunk: CodeChunk, filePath: string): string[] {
  const parts: string[] = [];

  const fileName = filePath.split("/").pop() || filePath;
  const dirPath = filePath.split("/").slice(-3, -1).join("/");

  const langDescriptors: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript",
    python: "Python",
    rust: "Rust",
    go: "Go",
    java: "Java",
  };

  const typeDescriptors: Record<string, string> = {
    function_declaration: "function",
    function: "function",
    arrow_function: "arrow function",
    method_definition: "method",
    class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type alias",
    enum_declaration: "enum",
    export_statement: "export",
    lexical_declaration: "variable declaration",
    function_definition: "function",
    class_definition: "class",
    function_item: "function",
    impl_item: "implementation",
    struct_item: "struct",
    enum_item: "enum",
    trait_item: "trait",
  };

  const lang = langDescriptors[chunk.language] || chunk.language;
  const typeDesc = typeDescriptors[chunk.chunkType] || chunk.chunkType;

  if (chunk.name) {
    parts.push(`${lang} ${typeDesc} "${chunk.name}"`);
  } else {
    parts.push(`${lang} ${typeDesc}`);
  }

  if (dirPath) {
    parts.push(`in ${dirPath}/${fileName}`);
  } else {
    parts.push(`in ${fileName}`);
  }

  const semanticHints = extractSemanticHints(chunk.name || "", chunk.content);
  if (semanticHints.length > 0) {
    parts.push(`Purpose: ${semanticHints.join(", ")}`);
  }

  return parts;
}

function buildEmbeddingText(headerParts: string[], content: string, partIndex?: number, partCount?: number): string {
  const parts = [...headerParts];
  if (partCount && partCount > 1 && partIndex) {
    parts.push(`Part ${partIndex}/${partCount}`);
  }
  parts.push("");
  parts.push(content);
  return parts.join("\n");
}

function splitOversizedContent(content: string, maxContentChars: number): string[] {
  if (content.length <= maxContentChars) {
    return [content];
  }

  const overlapChars = Math.max(CHARS_PER_TOKEN * 32, Math.min(Math.floor(maxContentChars * 0.15), CHARS_PER_TOKEN * 128));
  const stepChars = Math.max(1, maxContentChars - overlapChars);
  const segments: string[] = [];

  for (let start = 0; start < content.length; start += stepChars) {
    const end = Math.min(content.length, start + maxContentChars);
    segments.push(content.slice(start, end));
    if (end >= content.length) {
      break;
    }
  }

  return segments;
}

export function createEmbeddingTexts(chunk: CodeChunk, filePath: string, maxChunkTokens = MAX_SINGLE_CHUNK_TOKENS): string[] {
  const headerParts = getEmbeddingHeaderParts(chunk, filePath);
  const headerLength = buildEmbeddingText(headerParts, "", 1, 9).length;
  const maxContentChars = Math.max(1, (maxChunkTokens * CHARS_PER_TOKEN) - headerLength);
  const segments = splitOversizedContent(chunk.content, maxContentChars);

  if (segments.length === 1) {
    return [buildEmbeddingText(headerParts, segments[0])];
  }

  return segments.map((segment, index) => buildEmbeddingText(headerParts, segment, index + 1, segments.length));
}

export function createEmbeddingText(chunk: CodeChunk, filePath: string, maxChunkTokens = MAX_SINGLE_CHUNK_TOKENS): string {
  const text = createEmbeddingTexts(chunk, filePath, maxChunkTokens)[0];
  if (!text) {
    return "";
  }

  const maxChars = maxChunkTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, Math.max(0, maxChars - 17)) + "\n... [truncated]";
}

export interface DynamicBatchOptions {
  maxBatchTokens?: number;
  maxBatchItems?: number;
}

export function createDynamicBatches<T extends { text: string; tokenCount?: number }>(chunks: T[], options: DynamicBatchOptions = {}): T[][] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];
  let currentTokens = 0;
  const maxBatchTokens = Math.max(1, options.maxBatchTokens ?? MAX_BATCH_TOKENS);
  const maxBatchItems = Math.max(1, options.maxBatchItems ?? Number.MAX_SAFE_INTEGER);
  
  for (const chunk of chunks) {
    const chunkTokens = chunk.tokenCount ?? estimateTokens(chunk.text);

    if (
      currentBatch.length > 0
      && (currentTokens + chunkTokens > maxBatchTokens || currentBatch.length >= maxBatchItems)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    
    currentBatch.push(chunk);
    currentTokens += chunkTokens;
  }
  
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  
  return batches;
}

function extractSemanticHints(name: string, content: string): string[] {
  const hints: string[] = [];
  const combined = `${name} ${content}`.toLowerCase();
  
  const signature = extractFunctionSignature(content);
  if (signature) {
    hints.push(signature);
  }
  
  const patterns: Array<[RegExp, string]> = [
    [/auth|login|logout|signin|signout|credential/i, "authentication"],
    [/password|hash|bcrypt|argon/i, "password handling"],
    [/token|jwt|bearer|oauth/i, "token management"],
    [/user|account|profile|member/i, "user management"],
    [/permission|role|access|authorize/i, "authorization"],
    [/validate|verify|check|assert/i, "validation"],
    [/error|exception|throw|catch/i, "error handling"],
    [/log|debug|trace|info|warn/i, "logging"],
    [/cache|memoize|store/i, "caching"],
    [/fetch|request|response|api|http/i, "HTTP/API"],
    [/database|db|query|sql|mongo/i, "database"],
    [/file|read|write|stream|path/i, "file operations"],
    [/parse|serialize|json|xml/i, "data parsing"],
    [/encrypt|decrypt|crypto|secret|cipher|cryptographic/i, "encryption/cryptography"],
    [/test|spec|mock|stub|expect/i, "testing"],
    [/config|setting|option|env/i, "configuration"],
    [/route|endpoint|handler|controller|middleware/i, "routing/middleware"],
    [/render|component|view|template/i, "UI rendering"],
    [/state|redux|store|dispatch/i, "state management"],
    [/hook|effect|memo|callback/i, "React hooks"],
  ];
  
  for (const [pattern, hint] of patterns) {
    if (pattern.test(combined) && !hints.includes(hint)) {
      hints.push(hint);
    }
  }
  
  return hints.slice(0, 6);
}

function extractFunctionSignature(content: string): string | null {
  const tsJsPatterns = [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>{]+))?\s*=>/,
    /(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/,
  ];
  
  const pyPatterns = [
    /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
    /async\s+def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/,
  ];
  
  const goPatterns = [
    /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|([^{\n]+))?/,
  ];
  
  const rustPatterns = [
    /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/,
  ];
  
  for (const pattern of [...tsJsPatterns, ...pyPatterns, ...goPatterns, ...rustPatterns]) {
    const match = content.match(pattern);
    if (match) {
      const funcName = match[1];
      const params = match[2]?.trim() || "";
      const returnType = (match[3] || match[4])?.trim();
      
      const paramNames = extractParamNames(params);
      
      let sig = `${funcName}(${paramNames.join(", ")})`;
      if (returnType && returnType.length < 50) {
        sig += ` -> ${returnType.replace(/\s+/g, " ").trim()}`;
      }
      
      if (sig.length < 100) {
        return sig;
      }
    }
  }
  
  return null;
}

function extractParamNames(params: string): string[] {
  if (!params.trim()) return [];
  
  const names: string[] = [];
  const parts = params.split(",");
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    const tsMatch = trimmed.match(/^(\w+)\s*[?:]?/);
    const pyMatch = trimmed.match(/^(\w+)\s*(?::|=)/);
    const goMatch = trimmed.match(/^(\w+)\s+\w/);
    const rustMatch = trimmed.match(/^(\w+)\s*:/);
    
    const match = tsMatch || pyMatch || goMatch || rustMatch;
    if (match && match[1] !== "self" && match[1] !== "this") {
      names.push(match[1]);
    }
  }
  
  return names.slice(0, 5);
}

export function generateChunkId(filePath: string, chunk: CodeChunk): string {
  const hash = hashContent(`${filePath}:${chunk.startLine}:${chunk.endLine}:${chunk.content}`);
  return `chunk_${hash.slice(0, 16)}`;
}

export function generateChunkHash(chunk: CodeChunk): string {
  return hashContent(chunk.content);
}

export interface KeywordSearchResult {
  chunkId: string;
  score: number;
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

export interface ChunkData {
  chunkId: string;
  contentHash: string;
  filePath: string;
  startLine: number;
  endLine: number;
  nodeType?: string;
  name?: string;
  language: string;
  blameSha?: string;
  blameAuthor?: string;
  blameAuthorEmail?: string;
  blameCommittedAt?: number;
  blameSummary?: string;
}

export interface BranchDelta {
  added: string[];
  removed: string[];
}

export interface DatabaseStats {
  embeddingCount: number;
  chunkCount: number;
  branchChunkCount: number;
  branchCount: number;
  symbolCount: number;
  callEdgeCount: number;
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

  getCallersWithContext(targetName: string, branch: string, callTypeFilter?: string): CallEdgeData[] {
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

  findShortestPath(fromName: string, toName: string, branch: string, maxDepth?: number): PathHopData[] {
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
