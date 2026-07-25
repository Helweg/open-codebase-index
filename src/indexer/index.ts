import { existsSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync, promises as fsPromises } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { execFile } from "child_process";
import { promisify } from "util";
import PQueue from "p-queue";
import pRetry from "p-retry";

import { ParsedCodebaseIndexConfig, type RerankerConfig } from "../config/schema.js";
import { detectEmbeddingProvider, ConfiguredProviderInfo, tryDetectProvider, createCustomProviderInfo } from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
  CustomProviderNonRetryableError,
} from "../embeddings/provider.js";
import { createReranker, RerankerInterface } from "../rerank/index.js";
import { collectFiles, SkippedFile } from "../utils/files.js";
import { createCostEstimate, CostEstimate } from "../utils/cost.js";
import { Logger, initializeLogger } from "../utils/logger.js";
import {
  VectorStore,
  InvertedIndex,
  Database,
  parseFiles,
  createEmbeddingTexts,
  generateChunkId,
  generateChunkHash,
  ChunkMetadata,
  ChunkData,
  createDynamicBatches,
  hashFile,
  hashContent,
  extractCalls,
  parseFileAsText,
  estimateTokens,
} from "../native/index.js";
import type { SymbolData, CallEdgeData, PathHopData, ReachabilityData, CommunityData, CentralityData } from "../native/index.js";
import { getBranchOrDefault, getBaseBranch, isGitRepo } from "../git/index.js";
import type { HostMode } from "../config/host.js";
import { getHostProjectIndexRelativePath, resolveProjectIndexPath } from "../config/paths.js";
import { getChangedFiles } from "../tools/changed-files.js";
import type { PrImpactResult } from "./pr-impact-types.js";
import { getChunkGitBlame, type GitBlameMetadata } from "./git-blame.js";
import {
  acquireIndexLock,
  completeLeaseRecovery,
  createLeaseTemporaryPath,
  recoverLeaseArtifacts,
  releaseIndexLock,
  removeLeaseTemporaryPath,
  type IndexLockLease,
  type IndexLockOwner,
  type IndexMutationOperation,
} from "./index-lock.js";

export const CALL_GRAPH_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "php", "apex", "zig", "gdscript", "matlab", "bash"]);
// Languages whose identifiers are case-insensitive at the language level.
// The Rust call_extractor lowercases callee names for these languages (except
// constructors and imports), so same-file resolution in this file must use
// the same normalization when looking up symbols by name. Keep this set in
// sync with the matching branch in native/src/call_extractor.rs.
export const CASE_INSENSITIVE_LANGUAGES = new Set(["apex"]);
export const CALL_GRAPH_SYMBOL_CHUNK_TYPES = new Set([
  "function_declaration",
  "function",
  "arrow_function",
  "export_statement",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "function_definition",
  "class_definition",
  "decorated_definition",
  "method_declaration",
  "type_declaration",
  "type_spec",
  "function_item",
  "impl_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "mod_item",
  "trait_declaration",
  "trigger_declaration",
  "test_declaration",
  "struct_declaration",
  "union_declaration",
  // GDScript declarations whose names participate in the call graph.
  // `function_definition` and `class_definition` are already in the set
  // above (shared with Python/C/Bash and Python, respectively).
  "constructor_definition",
  "enum_definition",
  "signal_statement",
  "const_statement",
  "class_name_statement",
]);

function float32ArrayToBuffer(arr: number[]): Buffer {
  const float32 = new Float32Array(arr);
  return Buffer.from(float32.buffer);
}

function bufferToFloat32Array(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isRateLimitError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes("429") || message.toLowerCase().includes("rate limit") || message.toLowerCase().includes("too many requests");
}

function getSafeEmbeddingChunkTokenLimit(provider: ConfiguredProviderInfo): number {
  const providerMaxTokens = provider.modelInfo.maxTokens;
  const maxChunkTokens = Math.max(256, Math.floor(providerMaxTokens * 0.75));
  return Math.min(2000, maxChunkTokens);
}

function getDynamicBatchOptions(provider: ConfiguredProviderInfo): { maxBatchTokens?: number; maxBatchItems?: number } {
  if (provider.provider === "ollama") {
    return {
      maxBatchTokens: provider.modelInfo.maxTokens,
      maxBatchItems: 1,
    };
  }

  return {};
}

function isSqliteCorruptionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("database disk image is malformed")
    || message.includes("file is not a database")
    || message.includes("database schema is corrupt")
    || message.includes("sqlite_corrupt");
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  durationMs: number;
  existingChunks: number;
  removedChunks: number;
  skippedFiles: SkippedFile[];
  parseFailures: string[];
  failedBatchesPath?: string;
  warning?: string;
  resetCorruptedIndex?: boolean;
}

interface CorruptedIndexResetResult {
  warning: string;
  resetCorruptedIndex: true;
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  chunkType: string;
  name?: string;
  blame?: GitBlameMetadata;
}

export interface HealthCheckResult {
  removed: number;
  filePaths: string[];
  gcOrphanEmbeddings: number;
  gcOrphanChunks: number;
  gcOrphanSymbols: number;
  gcOrphanCallEdges: number;
  warning?: string;
  resetCorruptedIndex?: boolean;
}

export interface StatusResult {
  indexed: boolean;
  vectorCount: number;
  provider: string;
  model: string;
  indexPath: string;
  currentBranch: string;
  baseBranch: string;
  compatibility: IndexCompatibility | null;
  failedBatchesCount: number;
  failedBatchesPath?: string;
  warning?: string;
}

type InitializationMode = "none" | "reader" | "writer";

interface IndexReadIssue {
  component: "vectors" | "keyword" | "database";
  message: string;
  blocking: boolean;
}

interface ReaderArtifactFingerprint {
  vectors: string;
  keyword: string;
  database: string;
  databaseIdentity: string;
}

const STARTUP_WARNING_METADATA_KEY = "index.startupWarning";
const READER_ARTIFACT_RETRY_INTERVAL_MS = 1_000;

export interface IndexProgress {
  phase: "scanning" | "parsing" | "embedding" | "storing" | "complete";
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  currentFile?: string;
}

export type ProgressCallback = (progress: IndexProgress) => void;

interface PendingChunk {
  id: string;
  texts: Array<{
    text: string;
    tokenCount: number;
  }>;
  storageText: string;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

interface PendingEmbeddingRequest {
  chunk: PendingChunk;
  partIndex: number;
  text: string;
  tokenCount: number;
}

interface FailedBatch {
  chunks: PendingChunk[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

interface RetryableFailedChunk {
  chunk: PendingChunk;
  attemptCount: number;
}

interface SerializedFailedBatch {
  chunks: unknown[];
  error: string;
  attemptCount: number;
  lastAttempt: string;
}

type RankedCandidate = { id: string; score: number; metadata: ChunkMetadata };
type SearchFilterOptions = {
  fileType?: string;
  directory?: string;
  chunkType?: string;
  blameAuthor?: string;
  blameSha?: string;
  blameSince?: string;
};

function metadataFromBlame(blame: GitBlameMetadata | undefined): Partial<ChunkMetadata> {
  if (!blame) {
    return {};
  }

  return {
    blameSha: blame.sha,
    blameAuthor: blame.author,
    blameAuthorEmail: blame.authorEmail,
    blameCommittedAt: blame.committedAt,
    blameSummary: blame.summary,
  };
}

function blameFromChunkData(chunk: ChunkData | null): GitBlameMetadata | undefined {
  if (!chunk?.blameSha || !chunk.blameAuthor || !chunk.blameAuthorEmail || chunk.blameCommittedAt === undefined || !chunk.blameSummary) {
    return undefined;
  }

  return {
    sha: chunk.blameSha,
    author: chunk.blameAuthor,
    authorEmail: chunk.blameAuthorEmail,
    committedAt: chunk.blameCommittedAt,
    summary: chunk.blameSummary,
  };
}

function blameFromMetadata(metadata: ChunkMetadata): GitBlameMetadata | undefined {
  if (!metadata.blameSha || !metadata.blameAuthor || !metadata.blameAuthorEmail || metadata.blameCommittedAt === undefined || !metadata.blameSummary) {
    return undefined;
  }

  return {
    sha: metadata.blameSha,
    author: metadata.blameAuthor,
    authorEmail: metadata.blameAuthorEmail,
    committedAt: metadata.blameCommittedAt,
    summary: metadata.blameSummary,
  };
}

function hasBlameMetadata(metadata: ChunkMetadata): boolean {
  return blameFromMetadata(metadata) !== undefined;
}

interface RerankDocumentPayload {
  id: string;
  text: string;
}

type ExternalRerankBand = "implementation" | "documentation" | "test" | "other";

interface HybridRankOptions {
  fusionStrategy: "weighted" | "rrf";
  rrfK: number;
  rerankTopN: number;
  limit: number;
  hybridWeight: number;
}

interface SemanticRankOptions {
  rerankTopN: number;
  limit: number;
  prioritizeSourcePaths?: boolean;
}

interface IndexMetadata {
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingStrategyVersion: string;
  createdAt: string;
  updatedAt: string;
}

enum IncompatibilityCode {
  DIMENSION_MISMATCH = "DIMENSION_MISMATCH",
  MODEL_MISMATCH = "MODEL_MISMATCH",
  EMBEDDING_STRATEGY_MISMATCH = "EMBEDDING_STRATEGY_MISMATCH",
}

interface IndexCompatibility {
  compatible: boolean;
  code?: IncompatibilityCode;
  reason?: string;
  storedMetadata?: IndexMetadata;
}

const INDEX_METADATA_VERSION = "1";
const EMBEDDING_STRATEGY_VERSION = "2";
const RANKING_TOKEN_CACHE_LIMIT = 4096;
const RANK_HYBRID_CACHE_LIMIT = 256;

function createPendingChunkStorageText(texts: PendingChunk["texts"]): string {
  const primaryText = texts[0]?.text ?? "";
  if (texts.length <= 1) {
    return primaryText;
  }

  return `${primaryText}\n\n... [split into ${texts.length} parts for embedding]`;
}

function normalizePendingChunk(rawChunk: unknown, maxChunkTokens?: number): PendingChunk | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }

  const chunk = rawChunk as {
    id?: unknown;
    text?: unknown;
    texts?: Array<{ text?: unknown; tokenCount?: unknown }>;
    storageText?: unknown;
    content?: unknown;
    contentHash?: unknown;
    metadata?: unknown;
  };

  if (typeof chunk.id !== "string" || typeof chunk.contentHash !== "string" || !chunk.metadata || typeof chunk.metadata !== "object") {
    return null;
  }

  const texts = Array.isArray(chunk.texts)
    ? chunk.texts
      .map((entry) => {
        if (!entry || typeof entry.text !== "string") {
          return null;
        }

        return {
          text: entry.text,
          tokenCount: typeof entry.tokenCount === "number" && Number.isFinite(entry.tokenCount)
            ? entry.tokenCount
            : estimateTokens(entry.text),
        };
      })
      .filter((entry): entry is PendingChunk["texts"][number] => entry !== null)
    : [];

  if (texts.length === 0 && typeof chunk.text === "string") {
    if (typeof chunk.content === "string" && chunk.content.length > 0 && chunk.metadata && typeof chunk.metadata === "object") {
      const metadata = chunk.metadata as Partial<ChunkMetadata>;
      const rebuiltChunk = {
        content: chunk.content,
        startLine: typeof metadata.startLine === "number" ? metadata.startLine : 1,
        endLine: typeof metadata.endLine === "number" ? metadata.endLine : 1,
        chunkType: typeof metadata.chunkType === "string" ? metadata.chunkType : "other",
        name: typeof metadata.name === "string" ? metadata.name : undefined,
        language: typeof metadata.language === "string" ? metadata.language : "text",
      };
      const filePath = typeof metadata.filePath === "string" ? metadata.filePath : "unknown";
      texts.push(
        ...createEmbeddingTexts(rebuiltChunk, filePath, maxChunkTokens).map((text) => ({
          text,
          tokenCount: estimateTokens(text),
        }))
      );
    } else {
      texts.push({
        text: chunk.text,
        tokenCount: estimateTokens(chunk.text),
      });
    }
  }

  if (texts.length === 0) {
    return null;
  }

  return {
    id: chunk.id,
    texts,
    storageText: typeof chunk.storageText === "string" ? chunk.storageText : createPendingChunkStorageText(texts),
    content: typeof chunk.content === "string" ? chunk.content : "",
    contentHash: chunk.contentHash,
    metadata: chunk.metadata as ChunkMetadata,
  };
}

function getPendingChunkFilePath(rawChunk: unknown): string | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }

  const chunk = rawChunk as { metadata?: unknown };
  if (!chunk.metadata || typeof chunk.metadata !== "object") {
    return null;
  }

  const metadata = chunk.metadata as { filePath?: unknown };
  return typeof metadata.filePath === "string" ? metadata.filePath : null;
}

function normalizeFailedBatch(batch: SerializedFailedBatch, maxChunkTokens?: number): FailedBatch | null {
  const chunks = batch.chunks
    .map((chunk) => normalizePendingChunk(chunk, maxChunkTokens))
    .filter((chunk): chunk is PendingChunk => chunk !== null);

  if (chunks.length === 0) {
    return null;
  }

  return {
    chunks,
    error: batch.error,
    attemptCount: batch.attemptCount,
    lastAttempt: batch.lastAttempt,
  } satisfies FailedBatch;
}

function createPendingEmbeddingRequests(chunks: PendingChunk[]): PendingEmbeddingRequest[] {
  return chunks.flatMap((chunk) =>
    chunk.texts.map((textPart, partIndex) => ({
      chunk,
      partIndex,
      text: textPart.text,
      tokenCount: textPart.tokenCount,
    }))
  );
}

function createPendingEmbeddingRequestBatches(
  chunks: PendingChunk[],
  options: { maxBatchTokens?: number; maxBatchItems?: number } = {}
): PendingEmbeddingRequest[][] {
  return createDynamicBatches(createPendingEmbeddingRequests(chunks), options);
}

function getUniquePendingChunksFromRequests(requests: PendingEmbeddingRequest[]): PendingChunk[] {
  const uniqueChunks = new Map<string, PendingChunk>();
  for (const request of requests) {
    uniqueChunks.set(request.chunk.id, request.chunk);
  }
  return Array.from(uniqueChunks.values());
}

function coalesceFailedBatches(batches: FailedBatch[]): FailedBatch[] {
  const grouped = new Map<string, FailedBatch>();

  for (const batch of batches) {
    const key = `${batch.attemptCount}:${batch.lastAttempt}:${batch.error}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...batch,
        chunks: [...batch.chunks],
      });
      continue;
    }

    existing.chunks.push(...batch.chunks);
  }

  return Array.from(grouped.values());
}

function poolEmbeddingVectors(vectors: number[][], weights: number[]): number[] {
  const firstVector = vectors[0];
  if (!firstVector) {
    return [];
  }

  const pooled = new Array<number>(firstVector.length).fill(0);
  let totalWeight = 0;

  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index];
    const weight = Math.max(1, weights[index] ?? 1);
    totalWeight += weight;

    for (let dimension = 0; dimension < vector.length; dimension++) {
      pooled[dimension] += vector[dimension] * weight;
    }
  }

  if (totalWeight === 0) {
    return firstVector;
  }

  return pooled.map((value) => value / totalWeight);
}

function hasAllEmbeddingParts(
  parts: Array<{ vector: number[]; tokenCount: number } | undefined>,
  expectedPartCount: number
): boolean {
  if (parts.length !== expectedPartCount) {
    return false;
  }

  for (let index = 0; index < expectedPartCount; index++) {
    if (parts[index] === undefined) {
      return false;
    }
  }

  return true;
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootPath);
  return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}${path.sep}`);
}

const rankingQueryTokenCache = new Map<string, Set<string>>();
const rankingNameTokenCache = new Map<string, Set<string>>();
const rankingPathTokenCache = new Map<string, Set<string>>();
const rankingTextTokenCache = new Map<string, Set<string>>();
const rankHybridResultsCache = new WeakMap<RankedCandidate[], WeakMap<RankedCandidate[], Map<string, RankedCandidate[]>>>();

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "using", "where",
  "what", "when", "why", "how", "are", "was", "were", "be", "been", "being",
  "find", "show", "get", "run", "use", "code", "function", "implementation",
  "retrieve", "results", "result", "search", "pipeline", "top", "in", "on", "of",
  "to", "by", "as", "or", "an", "a",
]);

const TEST_PATH_SEGMENTS = [
  "tests/",
  "__tests__/",
  "/test/",
  "fixtures/",
  "benchmark",
  "README",
  "ARCHITECTURE",
  "docs/",
];

const IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS = [
  "tests/",
  "__tests__/",
  "/test/",
  "fixtures/",
  "benchmark",
  "readme",
  "architecture",
  "docs/",
  "examples/",
  "example/",
  ".github/",
  "/scripts/",
  "/migrations/",
  "/generated/",
];

const SOURCE_INTENT_HINTS = new Set([
  "implement",
  "implementation",
  "function",
  "method",
  "class",
  "logic",
  "algorithm",
  "pipeline",
  "indexer",
  "where",
]);

const DOC_TEST_INTENT_HINTS = new Set([
  "test",
  "tests",
  "fixture",
  "fixtures",
  "benchmark",
  "readme",
  "docs",
  "documentation",
]);

const DOC_INTENT_HINTS = new Set([
  "readme",
  "docs",
  "documentation",
  "guide",
  "usage",
]);

function setBoundedCache(
  cache: Map<string, Set<string>>,
  key: string,
  value: Set<string>
): void {
  if (cache.size >= RANKING_TOKEN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

function tokenizeTextForRanking(text: string): Set<string> {
  if (!text) {
    return new Set<string>();
  }

  const lowered = text.toLowerCase();
  const cache = rankingQueryTokenCache.get(lowered) ?? rankingTextTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const tokens = new Set(
    lowered
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );

  setBoundedCache(rankingQueryTokenCache, lowered, tokens);
  setBoundedCache(rankingTextTokenCache, lowered, tokens);
  return tokens;
}

function splitPathTokens(filePath: string): Set<string> {
  const lowered = filePath.toLowerCase();
  const cache = rankingPathTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const normalized = lowered
    .replace(/[^a-z0-9/._-]/g, " ")
    .split(/[/._-]+/)
    .filter((token) => token.length > 1);
  const tokens = new Set(normalized);
  setBoundedCache(rankingPathTokenCache, lowered, tokens);
  return tokens;
}

function splitNameTokens(name: string): Set<string> {
  if (!name) {
    return new Set<string>();
  }

  const lowered = name.toLowerCase();
  const cache = rankingNameTokenCache.get(lowered);
  if (cache) {
    return cache;
  }

  const tokens = new Set(
    lowered
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
  setBoundedCache(rankingNameTokenCache, lowered, tokens);
  return tokens;
}

function chunkTypeBoost(chunkType: string): number {
  switch (chunkType) {
    case "function":
    case "function_declaration":
    case "method":
    case "method_definition":
    case "class":
    case "class_declaration":
      return 0.2;
    case "interface":
    case "type":
    case "enum":
    case "struct":
    case "impl":
    case "trait":
    case "module":
      return 0.1;
    default:
      return 0;
  }
}

function isTestOrDocPath(filePath: string): boolean {
  return TEST_PATH_SEGMENTS.some((segment) => filePath.includes(segment));
}

function isLikelyImplementationPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  if (IMPLEMENTATION_EXCLUDE_PATH_SEGMENTS.some((segment) => lowered.includes(segment))) {
    return false;
  }

  const ext = lowered.split(".").pop() ?? "";
  if (["md", "mdx", "txt", "rst", "adoc", "snap", "json", "yaml", "yml", "lock"].includes(ext)) {
    return false;
  }

  return true;
}

function isDocumentationPath(filePath: string): boolean {
  const lowered = filePath.toLowerCase();
  const ext = lowered.split(".").pop() ?? "";
  return lowered.includes("readme") || ["md", "mdx", "rst", "adoc", "txt"].includes(ext);
}

function classifyExternalRerankBand(
  candidate: RankedCandidate,
  preferSourcePaths: boolean,
  docIntent: boolean
): ExternalRerankBand {
  const isDocOrTest = isTestOrDocPath(candidate.metadata.filePath);
  const isDocumentation = isDocumentationPath(candidate.metadata.filePath);
  const isImplementation = isLikelyImplementationPath(candidate.metadata.filePath) &&
    isImplementationChunkType(candidate.metadata.chunkType);

  if (preferSourcePaths) {
    if (isImplementation) return "implementation";
    if (isDocumentation) return "documentation";
    if (isDocOrTest) return "test";
    return "other";
  }

  if (docIntent) {
    if (isDocumentation) return "documentation";
    if (isImplementation) return "implementation";
    if (isDocOrTest) return "test";
    return "other";
  }

  if (isImplementation) return "implementation";
  if (isDocumentation) return "documentation";
  if (isDocOrTest) return "test";
  return "other";
}

function classifyQueryIntent(tokens: string[]): "source" | "doc_test" | "neutral" {
  const sourceIntentHits = tokens.filter((t) => SOURCE_INTENT_HINTS.has(t)).length;
  const docTestIntentHits = tokens.filter((t) => DOC_TEST_INTENT_HINTS.has(t)).length;

  if (sourceIntentHits === 0 && docTestIntentHits === 0) {
    return "neutral";
  }

  if (sourceIntentHits > docTestIntentHits) {
    return "source";
  }

  if (docTestIntentHits > sourceIntentHits) {
    return "doc_test";
  }

  return "neutral";
}

function classifyQueryIntentRaw(query: string): "source" | "doc_test" | "neutral" {
  const lowerQuery = query.toLowerCase();
  const docTestRawHits = Array.from(DOC_TEST_INTENT_HINTS).filter((hint) =>
    new RegExp(`\\b${hint}\\b`).test(lowerQuery)
  ).length;
  const sourceRawHits = [
    "implement",
    "implementation",
    "implements",
    "function",
    "method",
    "class",
    "logic",
    "algorithm",
    "pipeline",
    "indexer",
  ].filter((hint) => new RegExp(`\\b${hint}\\b`).test(lowerQuery)).length;

  if (docTestRawHits > sourceRawHits) {
    return "doc_test";
  }

  if (sourceRawHits > docTestRawHits && sourceRawHits > 0) {
    return "source";
  }

  const hasWhereIsPattern = /\bwhere\s+is\b/.test(lowerQuery);
  const hasIdentifierHints = extractIdentifierHints(query).length > 0;
  if (hasWhereIsPattern && hasIdentifierHints && docTestRawHits === 0) {
    return "source";
  }

  const queryTokens = Array.from(tokenizeTextForRanking(query));
  return classifyQueryIntent(queryTokens);
}

function classifyDocIntent(tokens: string[]): "docs" | "test" | "mixed" | "none" {
  const docHits = tokens.filter((t) => DOC_INTENT_HINTS.has(t)).length;
  const testHits = tokens.filter((t) => ["test", "tests", "fixture", "fixtures", "benchmark"].includes(t)).length;

  if (docHits > 0 && testHits === 0) return "docs";
  if (testHits > 0 && docHits === 0) return "test";
  if (testHits > 0 || docHits > 0) return "mixed";
  return "none";
}

function isImplementationChunkType(chunkType: string): boolean {
  return [
    "export_statement",
    "function",
    "function_declaration",
    "method",
    "method_definition",
    "class",
    "class_declaration",
    "interface",
    "type",
    "enum",
    "module",
  ].includes(chunkType);
}

function extractIdentifierHints(query: string): string[] {
  const identifiers = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return identifiers
    .filter((id) => id.length >= 3)
    .filter((id) => {
      const lower = id.toLowerCase();
      if (STOPWORDS.has(lower)) return false;
      return /[A-Z]/.test(id) || id.includes("_") || id.endsWith("Results") || id.endsWith("Result");
    })
    .map((id) => id.toLowerCase());
}

function extractCodeTermHints(query: string): string[] {
  const terms = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return terms
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3)
    .filter((term) => !STOPWORDS.has(term));
}

function normalizeIdentifierVariants(identifier: string): string[] {
  const lower = identifier.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, "");
  const snake = compact.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const kebab = snake.replace(/_/g, "-");
  const variants = [lower, compact, snake, kebab].filter((value) => value.length > 0);
  return Array.from(new Set(variants));
}

function scoreIdentifierMatch(name: string | undefined, filePath: string, hints: string[]): number {
  const nameLower = (name ?? "").toLowerCase();
  const pathLower = filePath.toLowerCase();

  let best = 0;
  for (const hint of hints) {
    const variants = normalizeIdentifierVariants(hint);
    for (const variant of variants) {
      if (nameLower === variant) {
        best = Math.max(best, 1);
      } else if (nameLower.includes(variant)) {
        best = Math.max(best, 0.8);
      } else if (pathLower.includes(variant)) {
        best = Math.max(best, 0.6);
      }
    }
  }

  return best;
}

function extractPrimaryIdentifierQueryHint(query: string): string | null {
  const identifiers = extractIdentifierHints(query);
  if (identifiers.length > 0) {
    return identifiers[0] ?? null;
  }

  const codeTerms = extractCodeTermHints(query);
  const best = codeTerms.find((term) => term.length >= 6);
  return best ?? null;
}

const FILE_PATH_HINT_EXTENSIONS = [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "rs", "go", "java", "kt", "kts", "swift", "rb", "php",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "scala", "lua",
  "sh", "bash", "zsh", "json", "yaml", "yml", "toml",
];

const FILE_PATH_HINT_SUFFIX_REGEX = new RegExp(
  "\\s+\\bin\\s+[\"'`]?((?:\\.\\/)?(?:[A-Za-z0-9._-]+\\/)+[A-Za-z0-9._-]+\\.(?:" +
  FILE_PATH_HINT_EXTENSIONS.join("|") +
  "))[\"'`]?[\\])}>.,;!?]*\\s*$",
  "i"
);

function normalizeFilePathForHintMatch(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase().replace(/^\.\//, "");
}

function pathMatchesHint(filePath: string, hint: string): boolean {
  const normalizedPath = normalizeFilePathForHintMatch(filePath);
  const normalizedHint = normalizeFilePathForHintMatch(hint);

  return normalizedPath.endsWith(normalizedHint) ||
    normalizedPath.includes(`/${normalizedHint}`) ||
    normalizedPath.includes(normalizedHint);
}

export function extractFilePathHint(query: string): string | null {
  const match = query.match(FILE_PATH_HINT_SUFFIX_REGEX);
  const rawPath = match?.[1];
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^\.\//, "");
}

export function stripFilePathHint(query: string): string {
  const stripped = query.replace(FILE_PATH_HINT_SUFFIX_REGEX, "").trim();
  return stripped.length > 0 ? stripped : query;
}

function buildDeterministicIdentifierPass(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primary = extractPrimaryIdentifierQueryHint(query);
  if (!primary) {
    return [];
  }
  const filePathHint = extractFilePathHint(query);
  const primaryVariants = normalizeIdentifierVariants(primary);

  const hints = [primary, ...extractIdentifierHints(query), ...extractCodeTermHints(query)]
    .map((value) => value.toLowerCase())
    .filter((value, idx, arr) => value.length >= 3 && arr.indexOf(value) === idx)
    .slice(0, 8);

  const deterministic = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();
      let maxMatch = 0;
      const nameMatchesPrimary = primaryVariants.some((variant) =>
        nameLower === variant || nameLower.replace(/[^a-z0-9]/g, "") === variant.replace(/[^a-z0-9]/g, "")
      );
      const pathMatchesFileHint = filePathHint ? pathMatchesHint(candidate.metadata.filePath, filePathHint) : false;

      for (const hint of hints) {
        const variants = normalizeIdentifierVariants(hint);
        for (const variant of variants) {
          if (nameLower === variant) {
            maxMatch = Math.max(maxMatch, 1);
          } else if (nameLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.85);
          } else if (pathLower.includes(variant)) {
            maxMatch = Math.max(maxMatch, 0.7);
          }
        }
      }

      if (pathMatchesFileHint && nameMatchesPrimary) {
        maxMatch = Math.max(maxMatch, 1);
      }

      return {
        candidate,
        maxMatch,
        pathMatchesFileHint,
        nameMatchesPrimary,
      };
    })
    .filter((entry) => entry.maxMatch >= 0.7)
    .sort((a, b) => {
      const aAnchored = a.pathMatchesFileHint && a.nameMatchesPrimary ? 1 : 0;
      const bAnchored = b.pathMatchesFileHint && b.nameMatchesPrimary ? 1 : 0;
      if (aAnchored !== bAnchored) return bAnchored - aAnchored;
      if (b.maxMatch !== a.maxMatch) return b.maxMatch - a.maxMatch;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 12));

  return deterministic.map((entry) => ({
    id: entry.candidate.id,
    score: entry.pathMatchesFileHint && entry.nameMatchesPrimary
      ? 0.995
      : Math.min(1, 0.9 + entry.maxMatch * 0.09),
    metadata: entry.candidate.metadata,
  }));
}

export function fuseResultsWeighted(
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  keywordWeight: number,
  limit: number
): RankedCandidate[] {
  const semanticWeight = 1 - keywordWeight;
  const fusedScores = new Map<string, { score: number; metadata: ChunkMetadata }>();

  for (const r of semanticResults) {
    fusedScores.set(r.id, {
      score: r.score * semanticWeight,
      metadata: r.metadata,
    });
  }

  for (const r of keywordResults) {
    const existing = fusedScores.get(r.id);
    if (existing) {
      existing.score += r.score * keywordWeight;
    } else {
      fusedScores.set(r.id, {
        score: r.score * keywordWeight,
        metadata: r.metadata,
      });
    }
  }

  const results = Array.from(fusedScores.entries()).map(([id, data]) => ({
    id,
    score: data.score,
    metadata: data.metadata,
  }));

  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, limit);
}

export function fuseResultsRrf(
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  rrfK: number,
  limit: number
): RankedCandidate[] {
  const maxPossibleRaw = 2 / (rrfK + 1);
  const rankByIdSemantic = new Map<string, number>();
  const rankByIdKeyword = new Map<string, number>();
  const metadataById = new Map<string, ChunkMetadata>();

  semanticResults.forEach((result, index) => {
    rankByIdSemantic.set(result.id, index + 1);
    metadataById.set(result.id, result.metadata);
  });

  keywordResults.forEach((result, index) => {
    rankByIdKeyword.set(result.id, index + 1);
    if (!metadataById.has(result.id)) {
      metadataById.set(result.id, result.metadata);
    }
  });

  const allIds = new Set<string>([...rankByIdSemantic.keys(), ...rankByIdKeyword.keys()]);
  const fused: RankedCandidate[] = [];

  for (const id of allIds) {
    const semanticRank = rankByIdSemantic.get(id);
    const keywordRank = rankByIdKeyword.get(id);

    const semanticScore = semanticRank ? 1 / (rrfK + semanticRank) : 0;
    const keywordScore = keywordRank ? 1 / (rrfK + keywordRank) : 0;

    const metadata = metadataById.get(id);
    if (!metadata) continue;

    fused.push({
      id,
      score: maxPossibleRaw > 0 ? (semanticScore + keywordScore) / maxPossibleRaw : 0,
      metadata,
    });
  }

  fused.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return fused.slice(0, limit);
}

export function rerankResults(
  query: string,
  candidates: RankedCandidate[],
  rerankTopN: number,
  options?: { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  if (rerankTopN <= 0 || candidates.length <= 1) {
    return candidates;
  }

  const topN = Math.min(rerankTopN, candidates.length);
  const queryTokens = tokenizeTextForRanking(query);
  if (queryTokens.size === 0) {
    return candidates;
  }

  const queryTokenList = Array.from(queryTokens);
  const docIntent = classifyDocIntent(queryTokenList);
  const preferSourcePaths = options?.prioritizeSourcePaths ?? classifyQueryIntentRaw(query) === "source";
  const identifierHints = extractIdentifierHints(query);

  const head = candidates.slice(0, topN).map((candidate, idx) => {
    const pathTokens = splitPathTokens(candidate.metadata.filePath);
    const nameTokens = splitNameTokens(candidate.metadata.name ?? "");
    const chunkTypeTokens = tokenizeTextForRanking(candidate.metadata.chunkType);
    let exactOrPrefixNameHits = 0;
    let pathOverlap = 0;
    let chunkTypeHits = 0;

    for (const token of queryTokenList) {
      if (nameTokens.has(token)) {
        exactOrPrefixNameHits += 1;
      } else {
        for (const nameToken of nameTokens) {
          if (nameToken.startsWith(token) || token.startsWith(nameToken)) {
            exactOrPrefixNameHits += 1;
            break;
          }
        }
      }

      if (pathTokens.has(token)) {
        pathOverlap += 1;
      }

      if (chunkTypeTokens.has(token)) {
        chunkTypeHits += 1;
      }
    }

    const likelyTestOrDoc = isTestOrDocPath(candidate.metadata.filePath);
    const lowerPath = candidate.metadata.filePath.toLowerCase();
    const lowerName = (candidate.metadata.name ?? "").toLowerCase();
    const hasIdentifierMatch = identifierHints.some((id) => lowerPath.includes(id) || lowerName.includes(id));

    const implementationPathBoost = preferSourcePaths && isLikelyImplementationPath(candidate.metadata.filePath) ? 0.08 : 0;
    const isReadmePath = candidate.metadata.filePath.toLowerCase().includes("readme");
    const testDocPenalty = preferSourcePaths && likelyTestOrDoc ? 0.12 : 0;
    const readmeDocBoost = !preferSourcePaths && isReadmePath ? 0.08 : 0;
    const identifierBoost = hasIdentifierMatch ? 0.12 : 0;
    const tokenCoverage = queryTokenList.length > 0
      ? (exactOrPrefixNameHits + pathOverlap + chunkTypeHits) / queryTokenList.length
      : 0;
    const coverageBoost = Math.min(0.12, tokenCoverage * 0.06);

    const deterministicBoost =
      exactOrPrefixNameHits * 0.08 +
      pathOverlap * 0.03 +
      chunkTypeHits * 0.02 +
      coverageBoost +
      identifierBoost +
      implementationPathBoost -
      testDocPenalty +
      readmeDocBoost +
      chunkTypeBoost(candidate.metadata.chunkType);

    return {
      candidate,
      boostedScore: candidate.score + deterministicBoost,
      originalIndex: idx,
      hasIdentifierMatch,
      implementationChunk: isImplementationChunkType(candidate.metadata.chunkType),
      isLikelyImplementationPath: isLikelyImplementationPath(candidate.metadata.filePath),
      isTestOrDocPath: likelyTestOrDoc,
      isReadmePath,
    };
  });

  head.sort((a, b) => {
    if (b.boostedScore !== a.boostedScore) return b.boostedScore - a.boostedScore;
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
    if (a.originalIndex !== b.originalIndex) return a.originalIndex - b.originalIndex;
    return a.candidate.id.localeCompare(b.candidate.id);
  });

  if (preferSourcePaths) {
    head.sort((a, b) => {
      const aId = a.hasIdentifierMatch ? 1 : 0;
      const bId = b.hasIdentifierMatch ? 1 : 0;
      if (aId !== bId) return bId - aId;

      const aImpl = a.implementationChunk ? 1 : 0;
      const bImpl = b.implementationChunk ? 1 : 0;
      if (aImpl !== bImpl) return bImpl - aImpl;

      const aImplementationPath = a.isLikelyImplementationPath ? 1 : 0;
      const bImplementationPath = b.isLikelyImplementationPath ? 1 : 0;
      if (aImplementationPath !== bImplementationPath) return bImplementationPath - aImplementationPath;

      const aTestDoc = a.isTestOrDocPath ? 1 : 0;
      const bTestDoc = b.isTestOrDocPath ? 1 : 0;
      if (aTestDoc !== bTestDoc) return aTestDoc - bTestDoc;

      return 0;
    });
  } else if (docIntent === "docs") {
    head.sort((a, b) => {
      const aReadme = a.isReadmePath ? 1 : 0;
      const bReadme = b.isReadmePath ? 1 : 0;
      if (aReadme !== bReadme) return bReadme - aReadme;
      return 0;
    });
  }

  const shouldDiversify = !(preferSourcePaths && identifierHints.length > 0);
  const diversifiedHead = diversifyEntriesByFileAndSymbol(head, (entry) => entry.candidate, shouldDiversify);

  const tail = candidates.slice(topN);
  return [...diversifiedHead.map((entry) => entry.candidate), ...tail];
}

function diversifyEntriesByFileAndSymbol<T>(
  entries: T[],
  getCandidate: (entry: T) => RankedCandidate,
  enabled: boolean
): T[] {
  if (!enabled || entries.length <= 2) {
    return entries;
  }

  const groups = new Map<string, T[]>();
  const groupOrder: string[] = [];

  for (const entry of entries) {
    const candidate = getCandidate(entry);
    const filePath = candidate.metadata.filePath;
    if (!groups.has(filePath)) {
      groups.set(filePath, []);
      groupOrder.push(filePath);
    }
    groups.get(filePath)?.push(entry);
  }

  const diversifiedGroups = groupOrder.map((filePath) => {
    const group = groups.get(filePath) ?? [];
    return diversifyGroupBySymbol(group, getCandidate);
  });

  const result: T[] = [];
  let added = true;
  let round = 0;
  while (added) {
    added = false;
    for (const group of diversifiedGroups) {
      const entry = group[round];
      if (entry !== undefined) {
        result.push(entry);
        added = true;
      }
    }
    round += 1;
  }

  return result;
}

function diversifyCandidatesByFile(candidates: RankedCandidate[], enabled: boolean): RankedCandidate[] {
  return diversifyEntriesByFileAndSymbol(candidates, (candidate) => candidate, enabled);
}

function diversifyGroupBySymbol<T>(
  entries: T[],
  getCandidate: (entry: T) => RankedCandidate
): T[] {
  if (entries.length <= 2) {
    return entries;
  }

  const seenKeys = new Set<string>();
  const primary: T[] = [];
  const remainder: T[] = [];

  for (const entry of entries) {
    const key = buildDiversityKey(getCandidate(entry).metadata);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      primary.push(entry);
    } else {
      remainder.push(entry);
    }
  }

  return [...primary, ...remainder];
}

function buildDiversityKey(metadata: ChunkMetadata): string {
  const normalizedPath = metadata.filePath.toLowerCase();
  const normalizedName = (metadata.name ?? "").trim().toLowerCase();
  if (normalizedName.length > 0) {
    return `${normalizedPath}#${normalizedName}`;
  }
  return normalizedPath;
}

export function rankHybridResults(
  query: string,
  semanticResults: RankedCandidate[],
  keywordResults: RankedCandidate[],
  options: HybridRankOptions & { prioritizeSourcePaths?: boolean }
): RankedCandidate[] {
  const prioritizeSourcePaths = options.prioritizeSourcePaths ?? classifyQueryIntentRaw(query) === "source";
  const cacheKey = `${query}\u0001${options.fusionStrategy}|${options.rrfK}|${options.hybridWeight}|${options.rerankTopN}|${options.limit}|${prioritizeSourcePaths ? 1 : 0}`;

  let byKeyword = rankHybridResultsCache.get(semanticResults);
  if (!byKeyword) {
    byKeyword = new WeakMap<RankedCandidate[], Map<string, RankedCandidate[]>>();
    rankHybridResultsCache.set(semanticResults, byKeyword);
  }

  let bucket = byKeyword.get(keywordResults);
  if (!bucket) {
    bucket = new Map<string, RankedCandidate[]>();
    byKeyword.set(keywordResults, bucket);
  } else {
    const cached = bucket.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const fused = options.fusionStrategy === "rrf"
    ? fuseResultsRrf(semanticResults, keywordResults, options.rrfK, overfetchLimit)
    : fuseResultsWeighted(semanticResults, keywordResults, options.hybridWeight, overfetchLimit);

  const rerankPoolLimit = Math.max(overfetchLimit, options.rerankTopN * 3, options.limit * 6);
  const rerankPool = fused.slice(0, rerankPoolLimit);
  const ranked = rerankResults(query, rerankPool, options.rerankTopN, {
    prioritizeSourcePaths,
  });

  if (bucket.size >= RANK_HYBRID_CACHE_LIMIT) {
    const oldest = bucket.keys().next().value;
    if (oldest !== undefined) {
      bucket.delete(oldest);
    }
  }
  bucket.set(cacheKey, ranked);

  return ranked;
}

export function rankSemanticOnlyResults(
  query: string,
  semanticResults: RankedCandidate[],
  options: SemanticRankOptions
): RankedCandidate[] {
  const overfetchLimit = Math.max(options.limit * 4, options.limit);
  const bounded = semanticResults.slice(0, overfetchLimit);
  return rerankResults(query, bounded, options.rerankTopN, {
    prioritizeSourcePaths: options.prioritizeSourcePaths ?? false,
  });
}

function promoteIdentifierMatches(
  query: string,
  combined: RankedCandidate[],
  semanticCandidates: RankedCandidate[],
  keywordCandidates: RankedCandidate[],
  database?: Database,
  branchChunkIds?: Set<string> | null,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (combined.length === 0) {
    return combined;
  }

  if (!prioritizeSourcePaths) {
    return combined;
  }

  const identifierHints = extractIdentifierHints(query);
  if (identifierHints.length === 0) {
    return combined;
  }

  const combinedById = new Map(combined.map((candidate) => [candidate.id, candidate]));
  const candidateUnion = new Map<string, RankedCandidate>();
  for (const candidate of semanticCandidates) {
    candidateUnion.set(candidate.id, candidate);
  }
  for (const candidate of keywordCandidates) {
    if (!candidateUnion.has(candidate.id)) {
      candidateUnion.set(candidate.id, candidate);
    }
  }

  if (database) {
    for (const identifier of identifierHints) {
      const symbols = database.getSymbolsByName(identifier);
      for (const symbol of symbols) {
        const chunks = database.getChunksByFile(symbol.filePath);
        for (const chunk of chunks) {
          if (branchChunkIds && !branchChunkIds.has(chunk.chunkId)) {
            continue;
          }

          const chunkType = ((chunk.nodeType ?? "other") as ChunkMetadata["chunkType"]);
          if (!isImplementationChunkType(chunkType)) {
            continue;
          }

          if (!isLikelyImplementationPath(chunk.filePath)) {
            continue;
          }

          if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
            continue;
          }

          const existing = combinedById.get(chunk.chunkId) ?? candidateUnion.get(chunk.chunkId);
          const metadata: ChunkMetadata = existing?.metadata ?? {
            filePath: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            chunkType,
            name: chunk.name ?? undefined,
            language: chunk.language,
            hash: chunk.contentHash,
            ...metadataFromBlame(blameFromChunkData(chunk)),
          };

          const baselineScore = existing?.score ?? 0.5;
          candidateUnion.set(chunk.chunkId, {
            id: chunk.chunkId,
            score: Math.min(1, baselineScore + 0.5),
            metadata,
          });
        }
      }
    }
  }

  const promoted: RankedCandidate[] = [];
  for (const candidate of candidateUnion.values()) {
    const filePathLower = candidate.metadata.filePath.toLowerCase();
    const nameLower = (candidate.metadata.name ?? "").toLowerCase();
    const exactIdentifierMatch = identifierHints.some((hint) => nameLower === hint);
    const hasIdentifierMatch = exactIdentifierMatch || identifierHints.some((hint) =>
      nameLower.includes(hint) ||
      filePathLower.includes(hint)
    );

    if (!hasIdentifierMatch) {
      continue;
    }

    if (!isImplementationChunkType(candidate.metadata.chunkType)) {
      continue;
    }

    if (!isLikelyImplementationPath(candidate.metadata.filePath)) {
      continue;
    }

    const existing = combinedById.get(candidate.id) ?? candidate;
    const rescueBoost = exactIdentifierMatch ? 0.45 : 0.25;
    const boostedScore = Math.min(1, Math.max(existing.score, candidate.score) + rescueBoost);
    promoted.push({
      id: existing.id,
      score: boostedScore,
      metadata: existing.metadata,
    });
  }

  if (promoted.length === 0) {
    return combined;
  }

  promoted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const promotedIds = new Set(promoted.map((candidate) => candidate.id));
  const remainder = combined.filter((candidate) => !promotedIds.has(candidate.id));
  return [...promoted, ...remainder];
}

function buildSymbolDefinitionLane(
  query: string,
  database: Database,
  branchChunkIds: Set<string> | null,
  limit: number,
  fallbackCandidates: RankedCandidate[],
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const identifierHints = extractIdentifierHints(query);
  const codeTermHints = extractCodeTermHints(query);
  if (identifierHints.length === 0 && codeTermHints.length === 0) {
    return [];
  }

  const symbolCandidates = new Map<string, RankedCandidate>();
  const filePathHint = extractFilePathHint(query);
  const primaryHint = extractPrimaryIdentifierQueryHint(query);

  const upsertChunkCandidate = (
    chunk: ReturnType<Database["getChunksByName"]>[number],
    identifier: string,
    normalizedIdentifier: string,
    baseScore?: number
  ) => {
    if (branchChunkIds && !branchChunkIds.has(chunk.chunkId)) {
      return;
    }

    const chunkType = (chunk.nodeType ?? "other") as ChunkMetadata["chunkType"];
    if (!isImplementationChunkType(chunkType)) {
      return;
    }

    if (!isLikelyImplementationPath(chunk.filePath)) {
      return;
    }

    const nameLower = (chunk.name ?? "").toLowerCase();
    const exactName =
      nameLower === identifier ||
      nameLower.replace(/_/g, "") === normalizedIdentifier;
    const base = baseScore ?? (exactName ? 0.99 : 0.88);

    const existing = symbolCandidates.get(chunk.chunkId);
    if (!existing || base > existing.score) {
      symbolCandidates.set(chunk.chunkId, {
        id: chunk.chunkId,
        score: base,
        metadata: {
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType,
          name: chunk.name ?? undefined,
          language: chunk.language,
          hash: chunk.contentHash,
          ...metadataFromBlame(blameFromChunkData(chunk)),
        },
      });
    }
  };

  const normalizedHints = identifierHints
    .flatMap((hint) => [
      hint,
      hint.replace(/_/g, ""),
      hint.replace(/_/g, "-")
    ])
    .filter((hint, idx, arr) => hint.length >= 3 && arr.indexOf(hint) === idx)
    .slice(0, 6);

  for (const identifier of normalizedHints) {
    const symbols = [
      ...database.getSymbolsByName(identifier),
      ...database.getSymbolsByNameCi(identifier),
    ];

    const chunksByName = [
      ...database.getChunksByName(identifier),
      ...database.getChunksByNameCi(identifier),
    ];

    const normalizedIdentifier = identifier.replace(/_/g, "");

    const dedupSymbols = new Map<string, typeof symbols[number]>();
    for (const symbol of symbols) {
      dedupSymbols.set(symbol.id, symbol);
    }

    for (const symbol of dedupSymbols.values()) {
      const chunks = database.getChunksByFile(symbol.filePath);
      for (const chunk of chunks) {
        if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
          continue;
        }

        upsertChunkCandidate(chunk, identifier, normalizedIdentifier);
      }
    }

    const dedupChunksByName = new Map<string, typeof chunksByName[number]>();
    for (const chunk of chunksByName) {
      dedupChunksByName.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupChunksByName.values()) {
      upsertChunkCandidate(chunk, identifier, normalizedIdentifier);
    }
  }

  if (filePathHint && primaryHint) {
    const primaryChunks = [
      ...database.getChunksByName(primaryHint),
      ...database.getChunksByNameCi(primaryHint),
    ];
    const dedupPrimaryChunks = new Map<string, typeof primaryChunks[number]>();
    for (const chunk of primaryChunks) {
      dedupPrimaryChunks.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupPrimaryChunks.values()) {
      if (!pathMatchesHint(chunk.filePath, filePathHint)) {
        continue;
      }
      const normalizedPrimary = primaryHint.replace(/_/g, "");
      upsertChunkCandidate(chunk, primaryHint, normalizedPrimary, 1.0);
    }
  }

  const ranked = Array.from(symbolCandidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (ranked.length === 0) {
    const implementationFallback = fallbackCandidates.filter((candidate) =>
      isImplementationChunkType(candidate.metadata.chunkType) &&
      isLikelyImplementationPath(candidate.metadata.filePath)
    );

    for (const candidate of implementationFallback) {
      const nameLower = (candidate.metadata.name ?? "").toLowerCase();
      const pathLower = candidate.metadata.filePath.toLowerCase();

      const exactHintMatch = normalizedHints.some((hint) => nameLower === hint || nameLower.replace(/_/g, "") === hint.replace(/_/g, ""));
      const tokenizedName = tokenizeTextForRanking(nameLower);
      const tokenHits = codeTermHints.filter((term) => tokenizedName.has(term) || pathLower.includes(term)).length;

      if (!exactHintMatch && tokenHits === 0) {
        continue;
      }

      const laneScore = exactHintMatch
        ? Math.min(1, Math.max(candidate.score, 0.97))
        : Math.min(0.95, Math.max(candidate.score, 0.82 + tokenHits * 0.03));
      symbolCandidates.set(candidate.id, {
        id: candidate.id,
        score: laneScore,
        metadata: candidate.metadata,
      });
    }

    if (symbolCandidates.size === 0) {
      const queryTokenSet = tokenizeTextForRanking(query);
      const rankedFallback = implementationFallback
        .map((candidate) => {
          const nameTokens = tokenizeTextForRanking(candidate.metadata.name ?? "");
          const pathTokens = splitPathTokens(candidate.metadata.filePath);
          let overlap = 0;
          for (const token of queryTokenSet) {
            if (nameTokens.has(token) || pathTokens.has(token)) {
              overlap += 1;
            }
          }
          const overlapScore = queryTokenSet.size > 0 ? overlap / queryTokenSet.size : 0;
          return {
            candidate,
            overlapScore,
          };
        })
        .filter((entry) => entry.overlapScore > 0)
        .sort((a, b) => b.overlapScore - a.overlapScore || b.candidate.score - a.candidate.score)
        .slice(0, Math.max(limit, 3));

      for (const entry of rankedFallback) {
        symbolCandidates.set(entry.candidate.id, {
          id: entry.candidate.id,
          score: Math.min(0.94, Math.max(entry.candidate.score, 0.8 + entry.overlapScore * 0.1)),
          metadata: entry.candidate.metadata,
        });
      }
    }
  }

  const withFallback = Array.from(symbolCandidates.values()).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return withFallback.slice(0, Math.max(limit * 2, limit));
}

function buildIdentifierDefinitionLane(
  query: string,
  candidates: RankedCandidate[],
  limit: number,
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source"
): RankedCandidate[] {
  if (!prioritizeSourcePaths) {
    return [];
  }

  const primaryHint = extractPrimaryIdentifierQueryHint(query);
  if (!primaryHint) {
    return [];
  }

  const hints = [primaryHint, ...extractIdentifierHints(query), ...extractCodeTermHints(query)].slice(0, 8);
  const scored = candidates
    .filter((candidate) =>
      isLikelyImplementationPath(candidate.metadata.filePath) &&
      isImplementationChunkType(candidate.metadata.chunkType)
    )
    .map((candidate) => {
      const matchScore = scoreIdentifierMatch(candidate.metadata.name, candidate.metadata.filePath, hints);
      return {
        candidate,
        matchScore,
      };
    })
    .filter((entry) => entry.matchScore > 0)
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .slice(0, Math.max(limit * 2, 10));

  return scored.map((entry) => ({
    id: entry.candidate.id,
    score: Math.min(1, 0.9 + entry.matchScore * 0.09),
    metadata: entry.candidate.metadata,
  }));
}

export function mergeTieredResults(
  symbolLane: RankedCandidate[],
  hybridLane: RankedCandidate[],
  limit: number
): RankedCandidate[] {
  if (symbolLane.length === 0) {
    return hybridLane.slice(0, limit);
  }

  const out: RankedCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of symbolLane) {
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
    if (out.length >= limit) return out;
  }

  for (const candidate of hybridLane) {
    if (seen.has(candidate.id)) continue;
    out.push(candidate);
    seen.add(candidate.id);
    if (out.length >= limit) return out;
  }

  return out;
}

export function selectChunksWithFileCoverage<T>(chunks: T[], limit: number): T[] {
  if (limit <= 0 || chunks.length === 0) {
    return [];
  }

  if (chunks.length <= limit) {
    return chunks;
  }

  if (limit === 1) {
    return [chunks[Math.floor((chunks.length - 1) / 2)]!];
  }

  const selected: T[] = [];
  for (let index = 0; index < limit; index++) {
    const sourceIndex = Math.round(index * (chunks.length - 1) / (limit - 1));
    selected.push(chunks[sourceIndex]!);
  }
  return selected;
}

function matchesSearchFilters(
  candidate: RankedCandidate,
  options: SearchFilterOptions | undefined,
  minScore: number
): boolean {
  if (candidate.score < minScore) return false;

  if (options?.fileType) {
    const ext = candidate.metadata.filePath.split(".").pop()?.toLowerCase();
    if (ext !== options.fileType.toLowerCase().replace(/^\./, "")) return false;
  }

  if (options?.directory) {
    const normalizedDir = options.directory.replace(/^\/|\/$/g, "");
    if (!candidate.metadata.filePath.includes(`/${normalizedDir}/`) &&
      !candidate.metadata.filePath.includes(`${normalizedDir}/`)) return false;
  }

  if (options?.chunkType && candidate.metadata.chunkType !== options.chunkType) {
    return false;
  }

  if (options?.blameAuthor) {
    const author = options.blameAuthor.toLowerCase();
    const candidateAuthor = candidate.metadata.blameAuthor?.toLowerCase();
    const candidateEmail = candidate.metadata.blameAuthorEmail?.toLowerCase();
    if (candidateAuthor !== author && candidateEmail !== author) return false;
  }

  if (options?.blameSha && !candidate.metadata.blameSha?.toLowerCase().startsWith(options.blameSha.toLowerCase())) {
    return false;
  }

  if (options?.blameSince) {
    const sinceMs = Date.parse(options.blameSince);
    if (Number.isNaN(sinceMs)) return false;
    const committedAt = candidate.metadata.blameCommittedAt;
    if (committedAt === undefined || committedAt < Math.floor(sinceMs / 1000)) return false;
  }

  return true;
}

function unionCandidates(
  semanticCandidates: RankedCandidate[],
  keywordCandidates: RankedCandidate[]
): RankedCandidate[] {
  const byId = new Map<string, RankedCandidate>();
  for (const candidate of semanticCandidates) {
    byId.set(candidate.id, candidate);
  }
  for (const candidate of keywordCandidates) {
    const existing = byId.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      byId.set(candidate.id, candidate);
    }
  }
  return Array.from(byId.values());
}

export class Indexer {
  private readonly host: HostMode;
  private config: ParsedCodebaseIndexConfig;
  private projectRoot: string;
  private indexPath: string;
  private store: VectorStore | null = null;
  private invertedIndex: InvertedIndex | null = null;
  private database: Database | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private configuredProviderInfo: ConfiguredProviderInfo | null = null;
  private reranker: RerankerInterface | null = null;
  private fileHashCache: Map<string, string> = new Map();
  private fileHashCachePath: string = "";
  private failedBatchesPath: string = "";
  private currentBranch: string = "default";
  private baseBranch: string = "main";
  private logger: Logger;
  private queryEmbeddingCache: Map<string, { embedding: number[]; timestamp: number }> = new Map();
  private readonly maxQueryCacheSize = 100;
  private readonly queryCacheTtlMs = 5 * 60 * 1000;
  private readonly querySimilarityThreshold = 0.85;
  private indexCompatibility: IndexCompatibility | null = null;
  private activeIndexLease: IndexLockLease | null = null;
  private initializationPromise: Promise<void> | null = null;
  private initializationMode: InitializationMode = "none";
  private readIssues: IndexReadIssue[] = [];
  private retiredDatabases: Database[] = [];
  private readerArtifactFingerprint: ReaderArtifactFingerprint | null = null;
  private writerArtifactFingerprint: ReaderArtifactFingerprint | null = null;
  private readerArtifactRetryAfter = new Map<IndexReadIssue["component"], number>();

  constructor(projectRoot: string, config: ParsedCodebaseIndexConfig, host: HostMode = "opencode") {
    this.projectRoot = projectRoot;
    this.config = config;
    this.host = host;
    this.indexPath = this.getIndexPath();
    this.fileHashCachePath = path.join(this.indexPath, "file-hashes.json");
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
    this.logger = initializeLogger(config.debug);
  }

  private getIndexPath(): string {
    return resolveProjectIndexPath(this.projectRoot, this.config.scope, this.host);
  }

  private isLocalProjectIndexPath(): boolean {
    const localProjectIndexPaths = [path.join(this.projectRoot, getHostProjectIndexRelativePath(this.host))];
    if (this.host !== "opencode") {
      localProjectIndexPaths.push(path.join(this.projectRoot, getHostProjectIndexRelativePath("opencode")));
    }

    return localProjectIndexPaths.some((localPath) => {
      if (!existsSync(localPath) || !existsSync(this.indexPath)) {
        return path.resolve(this.indexPath) === path.resolve(localPath);
      }
      const indexStats = statSync(this.indexPath);
      const localStats = statSync(localPath);
      return indexStats.dev === localStats.dev && indexStats.ino === localStats.ino;
    });
  }

  private resetLoadedIndexState(retireDatabase = false): void {
    if (this.database) {
      if (retireDatabase) {
        this.retiredDatabases.push(this.database);
      } else {
        this.database.close();
      }
    }
    this.store = null;
    this.invertedIndex = null;
    this.database = null;
    this.provider = null;
    this.configuredProviderInfo = null;
    this.reranker = null;
    this.indexCompatibility = null;
    this.initializationMode = "none";
    this.readIssues = [];
    this.readerArtifactFingerprint = null;
    this.writerArtifactFingerprint = null;
    this.readerArtifactRetryAfter.clear();
    this.fileHashCache.clear();
  }

  private refreshLoadedIndexState(): void {
    if (!this.store || !this.invertedIndex || !this.configuredProviderInfo) return;
    this.store.load();
    this.invertedIndex.load();
    this.fileHashCache.clear();
    this.loadFileHashCache();
    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    this.readIssues = [];
    this.readerArtifactRetryAfter.clear();
  }

  private async withIndexMutationLease<T>(
    operation: IndexMutationOperation,
    callback: (recoveredOwners: readonly IndexLockOwner[]) => Promise<T>,
  ): Promise<T> {
    const lease = acquireIndexLock(this.indexPath, operation);
    this.indexPath = lease.canonicalIndexPath;
    this.fileHashCachePath = path.join(this.indexPath, "file-hashes.json");
    this.failedBatchesPath = path.join(this.indexPath, "failed-batches.json");
    this.activeIndexLease = lease;

    let result: T | undefined;
    let callbackError: unknown;
    let callbackFailed = false;
    try {
      result = await callback(lease.recoveries.map(({ owner }) => owner));
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
    if (!callbackFailed) {
      try {
        completeLeaseRecovery(lease);
        this.writerArtifactFingerprint = this.captureReaderArtifactFingerprint();
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
      }
    }
    let releaseError: unknown;
    try {
      if (!releaseIndexLock(lease)) {
        releaseError = new Error(`Lost ownership of index mutation lease ${lease.owner.token}`);
        this.writerArtifactFingerprint = null;
        if (this.activeIndexLease?.owner.token === lease.owner.token) {
          this.activeIndexLease = null;
        }
      } else if (this.activeIndexLease?.owner.token === lease.owner.token) {
        this.activeIndexLease = null;
      }
    } catch (error) {
      releaseError = error;
      this.writerArtifactFingerprint = null;
      if (!existsSync(lease.lockPath) && this.activeIndexLease?.owner.token === lease.owner.token) {
        this.activeIndexLease = null;
      }
    }
    if (releaseError !== undefined) {
      if (callbackFailed) throw new AggregateError([callbackError, releaseError], "Index mutation and lease release both failed");
      throw releaseError;
    }
    if (callbackFailed) throw callbackError;
    return result as T;
  }

  private requireActiveLease(): IndexLockLease {
    if (!this.activeIndexLease) {
      throw new Error("Index mutation attempted without an active interprocess lease");
    }
    return this.activeIndexLease;
  }

  private loadFileHashCache(): void {
    if (!existsSync(this.fileHashCachePath)) {
      return;
    }

    try {
      const data = readFileSync(this.fileHashCachePath, "utf-8");
      const parsed = JSON.parse(data);
      this.fileHashCache = new Map(Object.entries(parsed));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Failed to load file hash cache, resetting cache state", {
        fileHashCachePath: this.fileHashCachePath,
        error: message,
      });
      this.fileHashCache = new Map();
    }
  }

  private saveFileHashCache(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.fileHashCache) {
      obj[k] = v;
    }
    this.atomicWriteSync(this.fileHashCachePath, JSON.stringify(obj));
  }

  private atomicWriteSync(targetPath: string, data: string): void {
    const lease = this.requireActiveLease();
    const tempPath = createLeaseTemporaryPath(targetPath, lease.owner, "tmp");
    mkdirSync(path.dirname(targetPath), { recursive: true });
    try {
      writeFileSync(tempPath, data);
      renameSync(tempPath, targetPath);
    } finally {
      removeLeaseTemporaryPath(tempPath);
    }
  }

  private saveInvertedIndex(invertedIndex: InvertedIndex): void {
    this.atomicWriteSync(
      path.join(this.indexPath, "inverted-index.json"),
      invertedIndex.serialize(),
    );
  }

  private getScopedRoots(): string[] {
    const roots = new Set<string>([path.resolve(this.projectRoot)]);

    for (const kbRoot of this.config.knowledgeBases) {
      roots.add(path.resolve(this.projectRoot, kbRoot));
    }

    return Array.from(roots);
  }

  private getBranchCatalogKey(): string {
    const branchName = this.currentBranch || "default";
    if (this.config.scope !== "global") {
      return branchName;
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `${projectHash}:${branchName}`;
  }

  private getBranchCatalogKeyFor(branchName: string): string {
    if (this.config.scope !== "global") {
      return branchName;
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `${projectHash}:${branchName}`;
  }

  private getLegacyBranchCatalogKey(): string {
    return this.currentBranch || "default";
  }

  private getLegacyMigrationMetadataKey(): string {
    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `index.globalBranchMigration.${projectHash}`;
  }

  private getProjectEmbeddingStrategyMetadataKey(): string {
    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `index.embeddingStrategyVersion.${projectHash}`;
  }

  private getProjectForceReembedMetadataKey(): string {
    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    return `index.forceReembed.${projectHash}`;
  }

  private hasProjectForceReembedPending(): boolean {
    return this.config.scope === "global" && this.database?.getMetadata(this.getProjectForceReembedMetadataKey()) === "true";
  }

  private hasScopedIndexedData(): boolean {
    if (!this.store || this.config.scope !== "global") {
      return false;
    }

    if (this.hasProjectForceReembedPending()) {
      return false;
    }

    const roots = this.getScopedRoots();

    if (Array.from(this.fileHashCache.keys()).some((filePath) => this.isFileInCurrentScope(filePath, roots))) {
      return true;
    }

    if (this.loadSerializedFailedBatches().some((batch) =>
      batch.chunks.some((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath !== null && this.isFileInCurrentScope(filePath, roots);
      })
    )) {
      return true;
    }

    if (!this.database) {
      return false;
    }

    if (this.getBranchCatalogKeys().some((branchKey) => {
      const branchChunkIds = this.database!.getBranchChunkIds(branchKey);
      if (branchChunkIds.length > 0) {
        return true;
      }

      return this.database!.getBranchSymbolIds(branchKey).length > 0;
    })) {
      return true;
    }

    const hasAnyBranchRows = this.database.getAllBranches().some((branchKey) => {
      const branchChunkIds = this.database!.getBranchChunkIds(branchKey);
      if (branchChunkIds.length > 0) {
        return true;
      }

      return this.database!.getBranchSymbolIds(branchKey).length > 0;
    });
    if (hasAnyBranchRows) {
      return false;
    }

    return this.store.getAllMetadata().some(({ metadata }) => this.isFileInCurrentScope(metadata.filePath, roots));
  }

  private loadStoredEmbeddingStrategyVersion(): string | null {
    if (!this.database) {
      return null;
    }

    if (this.hasProjectForceReembedPending()) {
      return null;
    }

    if (this.config.scope !== "global") {
      return this.database.getMetadata("index.embeddingStrategyVersion") ?? "1";
    }

    const projectVersion = this.database.getMetadata(this.getProjectEmbeddingStrategyMetadataKey());
    if (projectVersion) {
      return projectVersion;
    }

    const legacySharedVersion = this.database.getMetadata("index.embeddingStrategyVersion");
    if (legacySharedVersion && this.hasScopedIndexedData()) {
      return legacySharedVersion;
    }

    return null;
  }

  private getBranchCatalogKeys(): string[] {
    const primary = this.getBranchCatalogKey();
    if (this.config.scope !== "global") {
      return [primary];
    }

    if (this.database?.getMetadata(this.getLegacyMigrationMetadataKey()) === "done") {
      return [primary];
    }

    const legacy = this.getLegacyBranchCatalogKey();
    return primary === legacy ? [primary] : [primary, legacy];
  }

  private getBranchCatalogCleanupKeys(): string[] {
    const primary = this.getBranchCatalogKey();
    if (this.config.scope !== "global") {
      return [primary];
    }

    const legacy = this.getLegacyBranchCatalogKey();
    return primary === legacy ? [primary] : [primary, legacy];
  }

  private getProjectLocalScopedOwnershipIds(roots: string[]): {
    chunkIds: Set<string>;
    symbolIds: Set<string>;
  } {
    const chunkIds = new Set<string>();
    const symbolIds = new Set<string>();
    if (!this.database) {
      return { chunkIds, symbolIds };
    }

    const projectRootPath = path.resolve(this.projectRoot);
    const projectLocalFilePaths = new Set<string>([
      ...Array.from(this.fileHashCache.keys()).filter(
        (filePath) => this.isFileInCurrentScope(filePath, roots) && isPathWithinRoot(filePath, projectRootPath)
      ),
      ...(this.store?.getAllMetadata() ?? [])
        .map(({ metadata }) => metadata.filePath)
        .filter(
          (filePath) => this.isFileInCurrentScope(filePath, roots) && isPathWithinRoot(filePath, projectRootPath)
        ),
    ]);

    for (const filePath of projectLocalFilePaths) {
      for (const chunk of this.database.getChunksByFile(filePath)) {
        chunkIds.add(chunk.chunkId);
      }

      for (const symbol of this.database.getSymbolsByFile(filePath)) {
        symbolIds.add(symbol.id);
      }
    }

    return { chunkIds, symbolIds };
  }

  private getProjectScopedBranchCatalogCleanupKeys(projectChunkIds: string[], projectSymbolIds: string[]): string[] {
    if (this.config.scope !== "global") {
      return this.getBranchCatalogCleanupKeys();
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    const keys = new Set<string>();
    const projectChunkIdSet = new Set(projectChunkIds);
    const projectSymbolIdSet = new Set(projectSymbolIds);

    for (const branchKey of this.database?.getAllBranches() ?? []) {
      if (branchKey.startsWith(`${projectHash}:`)) {
        keys.add(branchKey);
        continue;
      }

      if (branchKey.includes(":")) {
        continue;
      }

      const referencesProjectChunks = this.database?.getBranchChunkIds(branchKey).some((chunkId) => projectChunkIdSet.has(chunkId)) ?? false;
      const referencesProjectSymbols = this.database?.getBranchSymbolIds(branchKey).some((symbolId) => projectSymbolIdSet.has(symbolId)) ?? false;
      if (referencesProjectChunks || referencesProjectSymbols) {
        keys.add(branchKey);
      }
    }

    for (const branchKey of this.getBranchCatalogCleanupKeys()) {
      keys.add(branchKey);
    }

    return Array.from(keys);
  }

  private isFileInCurrentScope(filePath: string, roots: string[]): boolean {
    return roots.some((root) => isPathWithinRoot(filePath, root));
  }

  private clearScopedFileHashCache(roots: string[]): void {
    for (const filePath of Array.from(this.fileHashCache.keys())) {
      if (this.isFileInCurrentScope(filePath, roots)) {
        this.fileHashCache.delete(filePath);
      }
    }
    this.saveFileHashCache();
  }

  private replaceScopedFileHashCache(currentFileHashes: Map<string, string>, roots: string[]): void {
    for (const filePath of Array.from(this.fileHashCache.keys())) {
      if (this.isFileInCurrentScope(filePath, roots)) {
        this.fileHashCache.delete(filePath);
      }
    }

    for (const [filePath, hash] of currentFileHashes) {
      this.fileHashCache.set(filePath, hash);
    }

    this.saveFileHashCache();
  }

  private partitionFailedBatches(roots: string[], maxChunkTokens?: number): { scoped: FailedBatch[]; retained: SerializedFailedBatch[] } {
    const scoped: FailedBatch[] = [];
    const retained: SerializedFailedBatch[] = [];

    for (const batch of this.loadSerializedFailedBatches()) {
      const scopedChunks = batch.chunks.filter((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath !== null && this.isFileInCurrentScope(filePath, roots);
      });
      const retainedChunks = batch.chunks.filter((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath === null || !this.isFileInCurrentScope(filePath, roots);
      });

      if (scopedChunks.length > 0) {
        const normalizedBatch = normalizeFailedBatch({ ...batch, chunks: scopedChunks }, maxChunkTokens);
        if (normalizedBatch) {
          scoped.push(normalizedBatch);
        }
      }

      if (retainedChunks.length > 0) {
        retained.push({ ...batch, chunks: retainedChunks });
      }
    }

    return { scoped, retained };
  }

  private clearScopedFailedBatches(roots: string[]): void {
    const { retained: retainedBatches } = this.partitionFailedBatches(roots);
    this.saveFailedBatches(retainedBatches);
  }

  private hasForeignScopedFileHashData(roots: string[]): boolean {
    return Array.from(this.fileHashCache.keys()).some((filePath) => !this.isFileInCurrentScope(filePath, roots));
  }

  private hasForeignScopedFailedBatches(roots: string[]): boolean {
    const { retained } = this.partitionFailedBatches(roots);
    return retained.length > 0;
  }

  private hasForeignScopedBranchData(): boolean {
    if (!this.database || this.config.scope !== "global") {
      return false;
    }

    const projectHash = hashContent(path.resolve(this.projectRoot)).slice(0, 16);
    const roots = this.getScopedRoots();
    const { chunkIds: projectLocalChunkIds, symbolIds: projectLocalSymbolIds } = this.getProjectLocalScopedOwnershipIds(roots);

    return this.database.getAllBranches().some(
      (branchKey) => {
        const branchChunkIds = this.database!.getBranchChunkIds(branchKey);
        const branchSymbolIds = this.database!.getBranchSymbolIds(branchKey);
        const hasBranchData = branchChunkIds.length > 0 || branchSymbolIds.length > 0;
        if (!hasBranchData) {
          return false;
        }

        if (branchKey.startsWith(`${projectHash}:`)) {
          return false;
        }

        if (!branchKey.includes(":")) {
          const referencesCurrentProjectChunks = branchChunkIds.some((chunkId) => projectLocalChunkIds.has(chunkId));
          const referencesCurrentProjectSymbols = branchSymbolIds.some((symbolId) => projectLocalSymbolIds.has(symbolId));
          return !(referencesCurrentProjectChunks || referencesCurrentProjectSymbols);
        }

        return true;
      }
    );
  }

  private saveScopedFailedBatches(batches: FailedBatch[], roots: string[]): void {
    const { retained } = this.partitionFailedBatches(roots);
    this.saveFailedBatches([...retained, ...batches]);
  }

  private clearSharedIndexProjectData(
    store: VectorStore,
    invertedIndex: InvertedIndex,
    database: Database,
    roots: string[]
  ): { removedChunkIds: string[]; hasForeignData: boolean } {
    const allMetadata = store.getAllMetadata();
    const scopedEntries = allMetadata.filter(({ metadata }) => this.isFileInCurrentScope(metadata.filePath, roots));
    const filePaths = new Set<string>([
      ...Array.from(this.fileHashCache.keys()).filter((filePath) => this.isFileInCurrentScope(filePath, roots)),
      ...scopedEntries.map(({ metadata }) => metadata.filePath),
    ]);

    const projectRootPath = path.resolve(this.projectRoot);
    const projectLocalFilePaths = new Set<string>(
      Array.from(filePaths).filter((filePath) => isPathWithinRoot(filePath, projectRootPath))
    );

    const removedChunkIds = new Set<string>(scopedEntries.map(({ key }) => key));
    for (const filePath of filePaths) {
      for (const chunk of database.getChunksByFile(filePath)) {
        removedChunkIds.add(chunk.chunkId);
      }
    }
    const removedChunkIdList = Array.from(removedChunkIds);

    const projectLocalChunkIds = new Set<string>(
      scopedEntries
        .filter(({ metadata }) => isPathWithinRoot(metadata.filePath, projectRootPath))
        .map(({ key }) => key)
    );
    for (const filePath of projectLocalFilePaths) {
      for (const chunk of database.getChunksByFile(filePath)) {
        projectLocalChunkIds.add(chunk.chunkId);
      }
    }

    const symbolIds: string[] = [];
    const projectLocalSymbolIds = new Set<string>();
    for (const filePath of filePaths) {
      for (const symbol of database.getSymbolsByFile(filePath)) {
        symbolIds.push(symbol.id);
        if (projectLocalFilePaths.has(filePath)) {
          projectLocalSymbolIds.add(symbol.id);
        }
      }
    }

    for (const branchKey of this.getProjectScopedBranchCatalogCleanupKeys(Array.from(projectLocalChunkIds), Array.from(projectLocalSymbolIds))) {
      database.deleteBranchChunksForBranch(branchKey, removedChunkIdList);
    }
    const sharedChunkIds = new Set(database.getReferencedChunkIds(removedChunkIdList));
    const removableChunkIds = removedChunkIdList.filter((chunkId) => !sharedChunkIds.has(chunkId));

    if (removableChunkIds.length > 0) {
      this.rebuildVectorStoreExcludingChunkIds(store, database, removableChunkIds);
      for (const chunkId of removableChunkIds) {
        invertedIndex.removeChunk(chunkId);
      }
    }

    for (const branchKey of this.getProjectScopedBranchCatalogCleanupKeys(Array.from(projectLocalChunkIds), Array.from(projectLocalSymbolIds))) {
      database.deleteBranchSymbolsForBranch(branchKey, symbolIds);
    }
    const sharedSymbolIds = new Set(database.getReferencedSymbolIds(symbolIds));
    const removableSymbolIds = symbolIds.filter((symbolId) => !sharedSymbolIds.has(symbolId));

    database.clearCallEdgeTargetsForSymbols(removableSymbolIds);

    for (const filePath of filePaths) {
      const fileChunkIds = database.getChunksByFile(filePath).map((chunk) => chunk.chunkId);
      const fileSymbols = database.getSymbolsByFile(filePath);

      if (fileChunkIds.every((chunkId) => !sharedChunkIds.has(chunkId))) {
        database.deleteChunksByFile(filePath);
      }

      if (fileSymbols.every((symbol) => !sharedSymbolIds.has(symbol.id))) {
        database.deleteCallEdgesByFile(filePath);
        database.deleteSymbolsByFile(filePath);
      }
    }

    database.gcOrphanCallEdges();
    database.gcOrphanSymbols();
    database.gcOrphanEmbeddings();
    database.gcOrphanChunks();

    store.save();
    this.saveInvertedIndex(invertedIndex);

    return {
      removedChunkIds: removedChunkIdList,
      hasForeignData: allMetadata.some(({ metadata }) => !this.isFileInCurrentScope(metadata.filePath, roots)),
    };
  }

  private async recoverFromInterruptedIndexingUnlocked(owners: readonly IndexLockOwner[]): Promise<void> {
    for (const owner of owners) {
      this.logger.warn("Detected interrupted indexing session, recovering...", {
        pid: owner.pid,
        hostname: owner.hostname,
        operation: owner.operation,
        startedAt: owner.startedAt,
      });
    }

    if (this.config.scope === "global") {
      if (existsSync(this.fileHashCachePath)) {
        unlinkSync(this.fileHashCachePath);
      }

      await this.healthCheckUnlocked();
    }

    this.logger.info("Recovery complete, next index will re-process all files");
  }

  private loadFailedBatches(maxChunkTokens?: number): FailedBatch[] {
    try {
      return this.loadSerializedFailedBatches()
        .map((batch) => normalizeFailedBatch(batch, maxChunkTokens))
        .filter((batch): batch is FailedBatch => batch !== null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("Failed to load failed batch state, skipping persisted retries", {
        failedBatchesPath: this.failedBatchesPath,
        error: message,
      });
      return [];
    }
  }

  private loadSerializedFailedBatches(): SerializedFailedBatch[] {
    if (!existsSync(this.failedBatchesPath)) {
      return [];
    }

    const data = readFileSync(this.failedBatchesPath, "utf-8");
    const parsed = JSON.parse(data) as Array<{
      chunks?: unknown[];
      error?: unknown;
      attemptCount?: unknown;
      lastAttempt?: unknown;
    }>;

    return parsed
      .map((batch) => {
        const chunks = Array.isArray(batch.chunks) ? batch.chunks : [];
        if (chunks.length === 0) {
          return null;
        }

        return {
          chunks,
          error: typeof batch.error === "string" ? batch.error : "Unknown embedding error",
          attemptCount: typeof batch.attemptCount === "number" ? batch.attemptCount : 1,
          lastAttempt: typeof batch.lastAttempt === "string" ? batch.lastAttempt : new Date().toISOString(),
        } satisfies SerializedFailedBatch;
      })
      .filter((batch): batch is SerializedFailedBatch => batch !== null);
  }

  private saveFailedBatches(batches: SerializedFailedBatch[]): void {
    if (batches.length === 0) {
      if (existsSync(this.failedBatchesPath)) {
        try {
          unlinkSync(this.failedBatchesPath);
        } catch {
          // Ignore cleanup failures; stale diagnostics are best-effort only.
        }
      }
      return;
    }
    this.atomicWriteSync(this.failedBatchesPath, JSON.stringify(batches, null, 2));
  }

  private collectRetryableFailedChunks(
    currentFileHashes: Map<string, string>,
    unchangedFilePaths: Set<string>,
    maxChunkTokens?: number
  ): RetryableFailedChunk[] {
    const retryableById = new Map<string, RetryableFailedChunk>();

    for (const batch of this.loadFailedBatches(maxChunkTokens)) {
      for (const chunk of batch.chunks) {
        const filePath = chunk.metadata.filePath;
        if (!currentFileHashes.has(filePath)) {
          continue;
        }
        if (!unchangedFilePaths.has(filePath)) {
          continue;
        }

        const existing = retryableById.get(chunk.id);
        if (!existing || batch.attemptCount > existing.attemptCount) {
          retryableById.set(chunk.id, {
            chunk,
            attemptCount: batch.attemptCount,
          });
        }
      }
    }

    return Array.from(retryableById.values());
  }

  private getProviderRateLimits(provider: string): {
    concurrency: number;
    intervalMs: number;
    minRetryMs: number;
    maxRetryMs: number;
  } {
    switch (provider) {
      case "github-copilot":
        return { concurrency: 1, intervalMs: 4000, minRetryMs: 5000, maxRetryMs: 60000 };
      case "openai":
        return { concurrency: 3, intervalMs: 500, minRetryMs: 1000, maxRetryMs: 30000 };
      case "google":
        return { concurrency: 5, intervalMs: 200, minRetryMs: 1000, maxRetryMs: 30000 };
      case "ollama":
        return { concurrency: 5, intervalMs: 0, minRetryMs: 500, maxRetryMs: 5000 };
      case "custom": {
        // Custom providers allow user-configurable concurrency and request interval.
        // Defaults are conservative (3 concurrent, 1s interval) for cloud endpoints;
        // users running local servers should set concurrency higher and intervalMs to 0.
        const customConfig = this.config.customProvider;
        return {
          concurrency: customConfig?.concurrency ?? 3,
          intervalMs: customConfig?.requestIntervalMs ?? 1000,
          minRetryMs: 1000,
          maxRetryMs: 30000,
        };
      }
      default:
        return { concurrency: 3, intervalMs: 1000, minRetryMs: 1000, maxRetryMs: 30000 };
    }
  }

  private async rerankCandidatesWithApi(
    query: string,
    candidates: RankedCandidate[],
    options?: {
      definitionIntent?: boolean;
      hasIdentifierHints?: boolean;
    }
  ): Promise<RankedCandidate[]> {
    const reranker = this.config.reranker;
    if (!reranker || !reranker.enabled || candidates.length <= 1) {
      return candidates;
    }

    const queryTokens = Array.from(tokenizeTextForRanking(query));
    const preferSourcePaths = classifyQueryIntentRaw(query) === "source";
    const docIntent = classifyDocIntent(queryTokens) === "docs";

    if (options?.definitionIntent === true) {
      return candidates;
    }

    if (options?.hasIdentifierHints === true && preferSourcePaths && !docIntent) {
      return candidates;
    }

    const topN = Math.min(reranker.topN, candidates.length);
    const head = candidates.slice(0, topN);
    const tail = candidates.slice(topN);
    const grouped = new Map<ExternalRerankBand, RankedCandidate[]>([
      ["implementation", []],
      ["documentation", []],
      ["test", []],
      ["other", []],
    ]);

    for (const candidate of head) {
      const band = classifyExternalRerankBand(candidate, preferSourcePaths, docIntent);
      grouped.get(band)?.push(candidate);
    }

    const orderedBands: ExternalRerankBand[] = preferSourcePaths
      ? ["implementation", "other", "documentation", "test"]
      : docIntent
        ? ["documentation", "implementation", "other", "test"]
        : ["implementation", "other", "documentation", "test"];

    try {
      const rerankedHead: RankedCandidate[] = [];
      for (const band of orderedBands) {
        const bandCandidates = grouped.get(band) ?? [];
        if (bandCandidates.length <= 1) {
          rerankedHead.push(...bandCandidates);
          continue;
        }

        const documents = await Promise.all(
          bandCandidates.map(async (candidate) => ({
            id: candidate.id,
            text: await this.createRerankerDocumentText(candidate),
          }))
        );
        const rankedIds = await this.callExternalReranker(query, documents, reranker);
        if (rankedIds.length === 0) {
          rerankedHead.push(...bandCandidates);
          continue;
        }

        const order = new Map(rankedIds.map((id, index) => [id, index]));
        const bandReranked = [...bandCandidates].sort((a, b) => {
          const aRank = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const bRank = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          if (aRank !== bRank) {
            return aRank - bRank;
          }
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return a.id.localeCompare(b.id);
        });
        const shouldDiversifyBand = !options?.hasIdentifierHints;
        rerankedHead.push(...diversifyCandidatesByFile(bandReranked, shouldDiversifyBand));
      }

      this.logger.search("debug", "Applied external reranker", {
        provider: reranker.provider,
        model: reranker.model,
        candidateCount: head.length,
        bands: orderedBands,
      });

      return [...rerankedHead, ...tail];
    } catch (error) {
      this.logger.search("warn", "External reranker failed; using deterministic order", {
        provider: reranker.provider,
        model: reranker.model,
        error: getErrorMessage(error),
      });
      return candidates;
    }
  }

  private async callExternalReranker(
    query: string,
    documents: RerankDocumentPayload[],
    reranker: RerankerConfig
  ): Promise<string[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (reranker.apiKey) {
      headers.Authorization = `Bearer ${reranker.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), reranker.timeoutMs);
    try {
      const response = await fetch(`${reranker.baseUrl}/rerank`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: reranker.model,
          query,
          documents: documents.map((document) => document.text),
          top_n: documents.length,
          return_documents: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Reranker API error: ${response.status} - ${await response.text()}`);
      }

      const body = await response.json() as {
        results?: Array<{ index?: number; relevance_score?: number }>;
      };
      if (!Array.isArray(body.results)) {
        throw new Error("Reranker API returned unexpected response format.");
      }

      return body.results
        .map((result) => {
          const index = typeof result.index === "number" ? result.index : -1;
          return documents[index]?.id;
        })
        .filter((id): id is string => typeof id === "string");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Reranker request timed out after ${reranker.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async createRerankerDocumentText(candidate: RankedCandidate): Promise<string> {
    const parts = [
      `path: ${candidate.metadata.filePath}`,
      `chunk_type: ${candidate.metadata.chunkType}`,
      `language: ${candidate.metadata.language}`,
      `lines: ${candidate.metadata.startLine}-${candidate.metadata.endLine}`,
    ];

    if (candidate.metadata.name) {
      parts.push(`name: ${candidate.metadata.name}`);
    }

    const intent = isLikelyImplementationPath(candidate.metadata.filePath) ? "implementation" : "doc_or_test";
    parts.push(`intent_hint: ${intent}`);

    try {
      const fileContent = await fsPromises.readFile(candidate.metadata.filePath, "utf-8");
      const lines = fileContent.split("\n");
      const snippetStartLine = Math.max(1, candidate.metadata.startLine - 2);
      const snippetEndLine = Math.min(lines.length, candidate.metadata.endLine + 2);
      const snippet = lines.slice(snippetStartLine - 1, snippetEndLine).join("\n").trim();
      parts.push("snippet:");
      parts.push(snippet.length > 0 ? snippet : "[empty]");
    } catch {
      parts.push("snippet:");
      parts.push("[unavailable]");
    }

    return parts.join("\n");
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    }
    if (this.isInitializedFor("reader")) {
      return;
    }
    await this.initializeOnce("reader", [], { skipAutoGc: true });
  }

  private async initializeOnce(
    mode: Exclude<InitializationMode, "none">,
    recoveredOwners: readonly IndexLockOwner[],
    options: { skipAutoGc?: boolean },
  ): Promise<void> {
    if (this.initializationPromise) {
      await this.initializationPromise;
      if (this.isInitializedFor(mode)) {
        return;
      }
      return this.initializeOnce(mode, recoveredOwners, options);
    }

    if (this.isInitializedFor(mode)) {
      return;
    }

    const initialization = this.initializeUnlocked(mode, recoveredOwners, options)
      .catch((error) => {
        this.resetLoadedIndexState();
        throw error;
      })
      .finally(() => {
        if (this.initializationPromise === initialization) {
          this.initializationPromise = null;
        }
      });
    this.initializationPromise = initialization;
    await initialization;
  }

  private isInitializedFor(mode: Exclude<InitializationMode, "none">): boolean {
    const hasState = Boolean(
      this.store &&
      this.provider &&
      this.invertedIndex &&
      this.configuredProviderInfo &&
      this.database,
    );
    if (!hasState) {
      return false;
    }
    return mode === "reader"
      ? this.initializationMode !== "none"
      : this.initializationMode === "writer";
  }

  private recordReadIssue(
    component: IndexReadIssue["component"],
    message: string,
    error?: unknown,
  ): void {
    this.readIssues.push(this.createReadIssue(component, message));
    this.readerArtifactRetryAfter.set(component, Date.now() + READER_ARTIFACT_RETRY_INTERVAL_MS);
    this.logger.warn(message, error === undefined ? undefined : { error: getErrorMessage(error) });
  }

  private createReadIssue(
    component: IndexReadIssue["component"],
    message: string,
  ): IndexReadIssue {
    return {
      component,
      message,
      blocking: component !== "keyword",
    };
  }

  private getVectorReadIssueMessage(): string {
    if (this.config.scope === "global") {
      return "Shared vector index could not be read. Restore or repair the complete fingerprinted shared vector artifacts; automatic reset is disabled for global scope.";
    }
    if (!this.isLocalProjectIndexPath()) {
      return "Vector index could not be read from an inherited project index. Restore or fingerprint it from the checkout that owns the index; do not remove or rebuild it from this worktree.";
    }
    return "Vector index could not be read. Run index_codebase after the active writer finishes to fingerprint a structurally valid legacy pair, or remove this checkout's local index directory and run index_codebase to rebuild it.";
  }

  private getKeywordReadIssueMessage(): string {
    if (this.config.scope === "global") {
      return "Shared keyword index could not be read; semantic search remains available. Restore or repair the shared keyword artifact; automatic reset is disabled for global scope.";
    }
    if (!this.isLocalProjectIndexPath()) {
      return "Keyword index could not be read from an inherited project index; semantic search remains available. Restore or repair it from the checkout that owns the index; do not rebuild it from this worktree.";
    }
    return "Keyword index could not be read; semantic search remains available. Restore a readable published keyword index, or run index_codebase with force=true after the active writer finishes.";
  }

  private getDatabaseReadIssueMessage(): string {
    if (this.config.scope === "global") {
      return "Shared index database could not be read. Restore or repair the shared SQLite database; automatic reset is disabled for global scope.";
    }
    if (!this.isLocalProjectIndexPath()) {
      return "Index database could not be read from an inherited project index. Restore or repair it from the checkout that owns the index; do not migrate or rebuild it from this worktree.";
    }
    return "Index database could not be read. Run index_codebase after the active writer finishes to repair or migrate it under the writer lease.";
  }

  private getReaderFileFingerprint(filePath: string, identityOnly = false): string {
    try {
      const stats = statSync(filePath);
      if (identityOnly) {
        return `${stats.dev}:${stats.ino}`;
      }
      return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    } catch (error) {
      return `unavailable:${getErrorMessage(error)}`;
    }
  }

  private captureReaderArtifactFingerprint(): ReaderArtifactFingerprint {
    const storePath = path.join(this.indexPath, "vectors");
    return {
      vectors: `${this.getReaderFileFingerprint(storePath)}|${this.getReaderFileFingerprint(`${storePath}.meta.json`)}`,
      keyword: this.getReaderFileFingerprint(path.join(this.indexPath, "inverted-index.json")),
      database: this.getReaderFileFingerprint(path.join(this.indexPath, "codebase.db")),
      databaseIdentity: this.getReaderFileFingerprint(path.join(this.indexPath, "codebase.db"), true),
    };
  }

  private refreshReaderArtifacts(): void {
    if (this.initializationMode !== "reader" || !this.configuredProviderInfo) {
      return;
    }

    const previousFingerprint = this.readerArtifactFingerprint;
    const currentFingerprint = this.captureReaderArtifactFingerprint();
    const issues = new Map(this.readIssues.map((issue) => [issue.component, issue]));
    const retryDue = (component: IndexReadIssue["component"]): boolean =>
      issues.has(component) && Date.now() >= (this.readerArtifactRetryAfter.get(component) ?? 0);
    const vectorsChanged = !previousFingerprint || currentFingerprint.vectors !== previousFingerprint.vectors;
    const keywordChanged = !previousFingerprint || currentFingerprint.keyword !== previousFingerprint.keyword;
    const databaseChanged = !previousFingerprint || currentFingerprint.database !== previousFingerprint.database;
    const databaseReplaced = !previousFingerprint || currentFingerprint.databaseIdentity !== previousFingerprint.databaseIdentity;
    if (
      previousFingerprint &&
      !vectorsChanged &&
      !keywordChanged &&
      !databaseChanged &&
      !Array.from(issues.keys()).some(retryDue)
    ) {
      return;
    }

    const setIssue = (
      component: IndexReadIssue["component"],
      message: string,
      error?: unknown,
    ): void => {
      if (!issues.has(component)) {
        this.logger.warn(message, error === undefined ? undefined : { error: getErrorMessage(error) });
      }
      issues.set(component, this.createReadIssue(component, message));
      this.readerArtifactRetryAfter.set(component, Date.now() + READER_ARTIFACT_RETRY_INTERVAL_MS);
    };

    const storePath = path.join(this.indexPath, "vectors");
    const vectorMetadataPath = `${storePath}.meta.json`;
    const invertedIndexPath = path.join(this.indexPath, "inverted-index.json");
    const dbPath = path.join(this.indexPath, "codebase.db");

    if (
      vectorsChanged ||
      retryDue("vectors")
    ) {
      const vectorStoreExists = existsSync(storePath);
      const vectorMetadataExists = existsSync(vectorMetadataPath);
      if (vectorStoreExists && vectorMetadataExists) {
        try {
          const store = new VectorStore(storePath, this.configuredProviderInfo.modelInfo.dimensions);
          store.loadStrict();
          this.store = store;
          issues.delete("vectors");
          this.readerArtifactRetryAfter.delete("vectors");
        } catch (error) {
          setIssue("vectors", this.getVectorReadIssueMessage(), error);
        }
      } else if (vectorStoreExists !== vectorMetadataExists || issues.has("vectors")) {
        setIssue("vectors", this.getVectorReadIssueMessage());
      }
    }

    if (
      keywordChanged ||
      retryDue("keyword") ||
      (!existsSync(invertedIndexPath) && (this.store?.count() ?? 0) > 0)
    ) {
      if (existsSync(invertedIndexPath)) {
        try {
          const invertedIndex = new InvertedIndex(invertedIndexPath);
          invertedIndex.load();
          this.invertedIndex = invertedIndex;
          issues.delete("keyword");
          this.readerArtifactRetryAfter.delete("keyword");
        } catch (error) {
          setIssue("keyword", this.getKeywordReadIssueMessage(), error);
        }
      } else if ((this.store?.count() ?? 0) > 0 || issues.has("keyword")) {
        setIssue("keyword", this.getKeywordReadIssueMessage());
      }
    }

    if (
      databaseReplaced ||
      (databaseChanged && issues.has("database")) ||
      retryDue("database")
    ) {
      if (existsSync(dbPath)) {
        try {
          const database = Database.openReadOnly(dbPath);
          if (this.database) {
            this.retiredDatabases.push(this.database);
          }
          this.database = database;
          issues.delete("database");
          this.readerArtifactRetryAfter.delete("database");
        } catch (error) {
          setIssue("database", this.getDatabaseReadIssueMessage(), error);
        }
      } else if ((this.store?.count() ?? 0) > 0 || issues.has("database")) {
        setIssue("database", this.getDatabaseReadIssueMessage());
      }
    }

    if (!issues.has("database")) {
      try {
        this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
      } catch (error) {
        setIssue("database", this.getDatabaseReadIssueMessage(), error);
      }
    }

    this.readIssues = Array.from(issues.values());
    this.readerArtifactFingerprint = currentFingerprint;
  }

  private refreshInactiveWriterArtifacts(): boolean {
    if (this.initializationMode !== "writer" || this.activeIndexLease) {
      return true;
    }

    const previousFingerprint = this.writerArtifactFingerprint;
    const currentFingerprint = this.captureReaderArtifactFingerprint();
    const retryDue = this.readIssues.some((issue) =>
      Date.now() >= (this.readerArtifactRetryAfter.get(issue.component) ?? 0)
    );
    const artifactsChanged = !previousFingerprint ||
      currentFingerprint.vectors !== previousFingerprint.vectors ||
      currentFingerprint.keyword !== previousFingerprint.keyword ||
      currentFingerprint.database !== previousFingerprint.database ||
      currentFingerprint.databaseIdentity !== previousFingerprint.databaseIdentity;
    if (!artifactsChanged && !retryDue) {
      return true;
    }
    if (
      !previousFingerprint ||
      currentFingerprint.databaseIdentity !== previousFingerprint.databaseIdentity
    ) {
      return false;
    }

    this.initializationMode = "reader";
    this.readerArtifactFingerprint = previousFingerprint;
    try {
      this.refreshReaderArtifacts();
      this.writerArtifactFingerprint = this.readerArtifactFingerprint ?? currentFingerprint;
    } finally {
      this.readerArtifactFingerprint = null;
      this.initializationMode = "writer";
    }
    return true;
  }

  private async initializeUnlocked(
    mode: Exclude<InitializationMode, "none">,
    recoveredOwners: readonly IndexLockOwner[] = [],
    options: { skipAutoGc?: boolean } = {},
  ): Promise<void> {
    if (mode === "writer") {
      this.requireActiveLease();
    }
    this.readIssues = [];
    this.readerArtifactRetryAfter.clear();

    if (this.config.embeddingProvider === 'custom') {
      if (!this.config.customProvider) {
        throw new Error("embeddingProvider is 'custom' but customProvider config is missing.");
      }
      this.configuredProviderInfo = createCustomProviderInfo(this.config.customProvider);
    } else if (this.config.embeddingProvider === 'auto') {
      this.configuredProviderInfo = await tryDetectProvider();
    } else {
      this.configuredProviderInfo = await detectEmbeddingProvider(this.config.embeddingProvider, this.config.embeddingModel);
    }

    if (!this.configuredProviderInfo) {
      throw new Error(
        "No embedding provider available. Configure GitHub Copilot, OpenAI, Google, Ollama, or a custom OpenAI-compatible endpoint."
      );
    }

    this.logger.info("Initializing indexer", {
      provider: this.configuredProviderInfo.provider,
      model: this.configuredProviderInfo.modelInfo.model,
      scope: this.config.scope,
      rerankerEnabled: this.config.reranker?.enabled ?? false,
    });

    this.provider = createEmbeddingProvider(this.configuredProviderInfo);

    if (this.config.reranker?.enabled) {
      this.reranker = createReranker(this.config.reranker);
      if (this.reranker.isAvailable()) {
        this.logger.info("Reranker initialized", {
          model: this.config.reranker.model,
          baseUrl: this.config.reranker.baseUrl,
        });
      }
    }

    const dimensions = this.configuredProviderInfo.modelInfo.dimensions;
    const storePath = path.join(this.indexPath, "vectors");
    const vectorMetadataPath = `${storePath}.meta.json`;
    const invertedIndexPath = path.join(this.indexPath, "inverted-index.json");
    const dbPath = path.join(this.indexPath, "codebase.db");
    let dbIsNew = !existsSync(dbPath);
    const readerArtifactFingerprint = mode === "reader"
      ? this.captureReaderArtifactFingerprint()
      : null;

    if (mode === "writer") {
      await fsPromises.mkdir(this.indexPath, { recursive: true });

      // Interrupted recovery remains entirely under the writer lease.
      if (recoveredOwners.length > 0 && this.config.scope === "project" && !this.isLocalProjectIndexPath()) {
        throw new Error(
          "Interrupted indexing recovery is unsafe while using an inherited worktree index. " +
          "Run index_codebase with force=true to create a local project index boundary."
        );
      }
      for (const recoveredOwner of recoveredOwners) {
        recoverLeaseArtifacts(this.indexPath, recoveredOwner, [
          storePath,
          `${storePath}.meta.json`,
        ]);
      }
      if (recoveredOwners.length > 0 && this.config.scope === "project") {
        await this.resetLocalIndexArtifacts();
      }

      this.store = new VectorStore(storePath, dimensions);
      if (existsSync(storePath) || existsSync(vectorMetadataPath)) {
        this.store.load();
      }

      this.invertedIndex = new InvertedIndex(invertedIndexPath);
      try {
        this.invertedIndex.load();
      } catch {
        if (existsSync(invertedIndexPath)) {
          await fsPromises.unlink(invertedIndexPath);
        }
        this.invertedIndex = new InvertedIndex(invertedIndexPath);
      }

      try {
        this.database = new Database(dbPath);
      } catch (error) {
        if (!(await this.tryResetCorruptedIndex("initializing index database", error))) {
          throw error;
        }

        this.store = new VectorStore(storePath, dimensions);
        this.invertedIndex = new InvertedIndex(invertedIndexPath);
        this.database = new Database(dbPath);
        dbIsNew = true;
      }
    } else {
      this.store = new VectorStore(storePath, dimensions);
      const vectorStoreExists = existsSync(storePath);
      const vectorMetadataExists = existsSync(vectorMetadataPath);
      const vectorReadFailureMessage = this.getVectorReadIssueMessage();
      if (vectorStoreExists !== vectorMetadataExists) {
        this.recordReadIssue("vectors", vectorReadFailureMessage);
      } else if (vectorStoreExists) {
        try {
          this.store.loadStrict();
        } catch (error) {
          this.recordReadIssue("vectors", vectorReadFailureMessage, error);
          this.store = new VectorStore(storePath, dimensions);
        }
      }

      this.invertedIndex = new InvertedIndex(invertedIndexPath);
      if (existsSync(invertedIndexPath)) {
        try {
          this.invertedIndex.load();
        } catch (error) {
          this.recordReadIssue(
            "keyword",
            this.getKeywordReadIssueMessage(),
            error,
          );
          this.invertedIndex = new InvertedIndex(invertedIndexPath);
        }
      } else if (this.store.count() > 0) {
        this.recordReadIssue("keyword", this.getKeywordReadIssueMessage());
      }

      if (existsSync(dbPath)) {
        try {
          this.database = Database.openReadOnly(dbPath);
        } catch (error) {
          this.recordReadIssue(
            "database",
            this.getDatabaseReadIssueMessage(),
            error,
          );
          this.database = Database.createEmptyReadOnly();
        }
      } else {
        this.database = Database.createEmptyReadOnly();
        if (this.store.count() > 0) {
          this.recordReadIssue(
            "database",
            `Index database is missing for the published vectors. ${this.getDatabaseReadIssueMessage()}`,
          );
        }
      }
    }

    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
      this.logger.branch("info", "Detected git repository", {
        currentBranch: this.currentBranch,
        baseBranch: this.baseBranch,
      });
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
      this.logger.branch("debug", "Not a git repository, using default branch");
    }

    if (mode === "writer" && recoveredOwners.length > 0) {
      await this.recoverFromInterruptedIndexingUnlocked(recoveredOwners);
    }

    if (mode === "writer" && dbIsNew && this.store.count() > 0) {
      this.migrateFromLegacyIndex();
    }

    this.loadFileHashCache();

    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    if (!this.indexCompatibility.compatible) {
      this.logger.warn("Index compatibility issue detected", {
        reason: this.indexCompatibility.reason,
        storedMetadata: this.indexCompatibility.storedMetadata,
        configuredProviderInfo: this.configuredProviderInfo,
      });
    }

    if (mode === "writer" && this.config.indexing.autoGc && !options.skipAutoGc) {
      await this.maybeRunAutoGc();
    }

    this.initializationMode = mode;
    this.readerArtifactFingerprint = readerArtifactFingerprint;
  }

  private async maybeRunAutoGc(): Promise<void> {
    if (!this.database) return;

    const lastGcTimestamp = this.database.getMetadata("lastGcTimestamp");
    const now = Date.now();
    const intervalMs = this.config.indexing.gcIntervalDays * 24 * 60 * 60 * 1000;

    let shouldRunGc = false;
    if (!lastGcTimestamp) {
      // Never run GC before, run it now
      shouldRunGc = true;
    } else {
      const lastGcTime = parseInt(lastGcTimestamp, 10);
      if (!isNaN(lastGcTime) && now - lastGcTime > intervalMs) {
        shouldRunGc = true;
      }
    }

    if (shouldRunGc) {
      const result = await this.healthCheckUnlocked();
      if (result.warning) {
        this.database.setMetadata(STARTUP_WARNING_METADATA_KEY, result.warning);
      } else {
        this.database.deleteMetadata(STARTUP_WARNING_METADATA_KEY);
      }
      this.database.setMetadata("lastGcTimestamp", now.toString());
    }
  }

  private async maybeRunOrphanGc(): Promise<CorruptedIndexResetResult | null> {
    if (!this.database) return null;

    const stats = this.database.getStats();
    if (!stats) return null;

    const orphanCount = stats.embeddingCount - stats.chunkCount;
    if (orphanCount > this.config.indexing.gcOrphanThreshold) {
      try {
        this.database.gcOrphanEmbeddings();
        this.database.gcOrphanChunks();
      } catch (error) {
        if (await this.tryResetCorruptedIndex("running automatic orphan garbage collection", error)) {
          return {
            resetCorruptedIndex: true,
            warning: this.getCorruptedIndexWarning(path.join(this.indexPath, "codebase.db")),
          };
        }
        throw error;
      }
      this.database.setMetadata("lastGcTimestamp", Date.now().toString());
    }

    return null;
  }

  private rebuildVectorStoreExcludingChunkIds(
    store: VectorStore,
    database: Database,
    excludedChunkIds: Iterable<string>
  ): void {
    const excludedSet = new Set(excludedChunkIds);
    if (excludedSet.size === 0) {
      return;
    }

    const retainedEntries = store
      .getAllMetadata()
      .filter(({ key }) => !excludedSet.has(key));

    const storeBasePath = path.join(this.indexPath, "vectors");
    const storeIndexPath = storeBasePath;
    const storeMetadataPath = `${storeBasePath}.meta.json`;
    const lease = this.requireActiveLease();
    const backupIndexPath = createLeaseTemporaryPath(storeIndexPath, lease.owner, "bak");
    const backupMetadataPath = createLeaseTemporaryPath(storeMetadataPath, lease.owner, "bak");

    let backedUpIndex = false;
    let backedUpMetadata = false;
    let rebuiltCount = 0;
    let skippedCount = 0;

    if (existsSync(backupIndexPath)) {
      unlinkSync(backupIndexPath);
    }
    if (existsSync(backupMetadataPath)) {
      unlinkSync(backupMetadataPath);
    }

    try {
      if (existsSync(storeIndexPath)) {
        renameSync(storeIndexPath, backupIndexPath);
        backedUpIndex = true;
      }
      if (existsSync(storeMetadataPath)) {
        renameSync(storeMetadataPath, backupMetadataPath);
        backedUpMetadata = true;
      }

      store.clear();

      for (const { key, metadata } of retainedEntries) {
        const chunk = database.getChunk(key);
        if (!chunk) {
          skippedCount += 1;
          continue;
        }

        const embeddingBuffer = database.getEmbedding(chunk.contentHash);
        if (!embeddingBuffer) {
          skippedCount += 1;
          continue;
        }

        const vector = bufferToFloat32Array(embeddingBuffer);
        store.add(key, Array.from(vector), metadata);
        rebuiltCount += 1;
      }

      store.save();

      if (backedUpIndex && existsSync(backupIndexPath)) {
        unlinkSync(backupIndexPath);
      }
      if (backedUpMetadata && existsSync(backupMetadataPath)) {
        unlinkSync(backupMetadataPath);
      }

      this.logger.gc("info", "Rebuilt vector store to avoid native remove", {
        excludedChunks: excludedSet.size,
        rebuiltChunks: rebuiltCount,
        skippedChunks: skippedCount,
      });
    } catch (error) {
      try {
        store.clear();
      } catch {
        // Ignore best-effort cleanup before restore.
      }

      if (existsSync(storeIndexPath)) {
        unlinkSync(storeIndexPath);
      }
      if (existsSync(storeMetadataPath)) {
        unlinkSync(storeMetadataPath);
      }

      if (backedUpIndex && existsSync(backupIndexPath)) {
        renameSync(backupIndexPath, storeIndexPath);
      }
      if (backedUpMetadata && existsSync(backupMetadataPath)) {
        renameSync(backupMetadataPath, storeMetadataPath);
      }

      if (backedUpIndex || backedUpMetadata) {
        store.load();
      }

      throw error;
    }
  }

  private getCorruptedIndexWarning(dbPath: string): string {
    if (this.config.scope === "global") {
      return `Detected a corrupted shared global SQLite index at ${dbPath}. Automatic repair is disabled for global scope because it may delete other projects' index data. Remove or repair the shared index manually, then rerun index_codebase with force=true.`;
    }

    return `Detected a corrupted local SQLite index at ${dbPath} and reset the local index. Run index_codebase to rebuild search data.`;
  }

  private async resetLocalIndexArtifacts(): Promise<void> {
    this.store = null;
    this.invertedIndex = null;
    this.database?.close();
    this.database = null;
    this.indexCompatibility = null;
    this.initializationMode = "none";
    this.readIssues = [];
    this.readerArtifactFingerprint = null;
    this.writerArtifactFingerprint = null;
    this.readerArtifactRetryAfter.clear();
    this.fileHashCache.clear();

    const resetPaths = [
      path.join(this.indexPath, "codebase.db"),
      path.join(this.indexPath, "codebase.db-shm"),
      path.join(this.indexPath, "codebase.db-wal"),
      path.join(this.indexPath, "vectors"),
      path.join(this.indexPath, "vectors.usearch"),
      path.join(this.indexPath, "vectors.meta.json"),
      path.join(this.indexPath, "inverted-index.json"),
      path.join(this.indexPath, "file-hashes.json"),
      path.join(this.indexPath, "failed-batches.json"),
    ];

    await Promise.all(resetPaths.map((targetPath) => fsPromises.rm(targetPath, { recursive: true, force: true })));
    await fsPromises.mkdir(this.indexPath, { recursive: true });
  }

  private async tryResetCorruptedIndex(stage: string, error: unknown): Promise<boolean> {
    if (!isSqliteCorruptionError(error)) {
      return false;
    }

    const dbPath = path.join(this.indexPath, "codebase.db");
    const warning = this.getCorruptedIndexWarning(dbPath);
    const errorMessage = getErrorMessage(error);

    if (this.config.scope === "global") {
      this.logger.error("Detected corrupted shared global index database", {
        stage,
        dbPath,
        error: errorMessage,
      });
      throw new Error(`${warning} Original SQLite error: ${errorMessage}`);
    }

    this.logger.warn("Detected corrupted local index database, resetting local index", {
      stage,
      dbPath,
      error: errorMessage,
    });

    await this.resetLocalIndexArtifacts();
    return true;
  }

  private migrateFromLegacyIndex(): void {
    if (!this.store || !this.database) return;

    const allMetadata = this.store.getAllMetadata();
    const chunkIds: string[] = [];
    const chunkDataBatch: ChunkData[] = [];

    for (const { key, metadata } of allMetadata) {
      const chunkData: ChunkData = {
        chunkId: key,
        contentHash: metadata.hash,
        filePath: metadata.filePath,
        startLine: metadata.startLine,
        endLine: metadata.endLine,
        nodeType: metadata.chunkType,
        name: metadata.name,
        language: metadata.language,
      };
      chunkDataBatch.push(chunkData);
      chunkIds.push(key);
    }

    if (chunkDataBatch.length > 0) {
      this.database.upsertChunksBatch(chunkDataBatch);
    }
    this.database.addChunksToBranchBatch(this.getBranchCatalogKey(), chunkIds);
  }

  private loadIndexMetadata(): IndexMetadata | null {
    if (!this.database) return null;

    const version = this.database.getMetadata("index.version");
    if (!version) return null;

      return {
        indexVersion: version,
        embeddingProvider: this.database.getMetadata("index.embeddingProvider") ?? "",
        embeddingModel: this.database.getMetadata("index.embeddingModel") ?? "",
        embeddingDimensions: parseInt(this.database.getMetadata("index.embeddingDimensions") ?? "0", 10),
        embeddingStrategyVersion: this.loadStoredEmbeddingStrategyVersion() ?? EMBEDDING_STRATEGY_VERSION,
        createdAt: this.database.getMetadata("index.createdAt") ?? "",
        updatedAt: this.database.getMetadata("index.updatedAt") ?? "",
      };
  }

  private saveIndexMetadata(provider: ConfiguredProviderInfo): void {
    if (!this.database) return;

    const now = new Date().toISOString();
    const existingCreatedAt = this.database.getMetadata("index.createdAt");
    const completeProjectEmbeddingStrategyReset = !this.hasProjectForceReembedPending();

    this.database.setMetadata("index.version", INDEX_METADATA_VERSION);
    this.database.setMetadata("index.embeddingProvider", provider.provider);
    this.database.setMetadata("index.embeddingModel", provider.modelInfo.model);
    this.database.setMetadata("index.embeddingDimensions", provider.modelInfo.dimensions.toString());
    if (this.config.scope === "global") {
      if (completeProjectEmbeddingStrategyReset) {
        this.database.setMetadata(this.getProjectEmbeddingStrategyMetadataKey(), EMBEDDING_STRATEGY_VERSION);
      }
      this.database.setMetadata(this.getLegacyMigrationMetadataKey(), "done");
      if (completeProjectEmbeddingStrategyReset) {
        this.database.deleteMetadata(this.getProjectForceReembedMetadataKey());
      }
    } else {
      this.database.setMetadata("index.embeddingStrategyVersion", EMBEDDING_STRATEGY_VERSION);
    }
    this.database.setMetadata("index.updatedAt", now);

    if (!existingCreatedAt) {
      this.database.setMetadata("index.createdAt", now);
    }
  }

  private validateIndexCompatibility(provider: ConfiguredProviderInfo): IndexCompatibility {
    const storedMetadata = this.loadIndexMetadata();

    if (!storedMetadata) {
      return { compatible: true };
    }

    const currentProvider = provider.provider;
    const currentModel = provider.modelInfo.model;
    const currentDimensions = provider.modelInfo.dimensions;

    if (storedMetadata.embeddingDimensions !== currentDimensions) {
      return {
        compatible: false,
        code: IncompatibilityCode.DIMENSION_MISMATCH,
        reason: `Dimension mismatch: index has ${storedMetadata.embeddingDimensions}D vectors (${storedMetadata.embeddingProvider}/${storedMetadata.embeddingModel}), but current provider uses ${currentDimensions}D (${currentProvider}/${currentModel}). Run index_codebase with force=true to rebuild.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingModel !== currentModel) {
      return {
        compatible: false,
        code: IncompatibilityCode.MODEL_MISMATCH,
        reason: `Model mismatch: index was built with "${storedMetadata.embeddingModel}", but current model is "${currentModel}". Embeddings are incompatible. Run index_codebase with force=true to rebuild.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingStrategyVersion !== EMBEDDING_STRATEGY_VERSION) {
      return {
        compatible: false,
        code: IncompatibilityCode.EMBEDDING_STRATEGY_MISMATCH,
        reason: `Embedding strategy mismatch: index was built with embedding strategy v${storedMetadata.embeddingStrategyVersion}, but the current code requires v${EMBEDDING_STRATEGY_VERSION}. Run index_codebase with force=true to rebuild cached embeddings.`,
        storedMetadata,
      };
    }

    if (storedMetadata.embeddingProvider !== currentProvider) {
      this.logger.warn("Provider changed", {
        storedProvider: storedMetadata.embeddingProvider,
        currentProvider,
      });
    }

    return {
      compatible: true,
      storedMetadata,
    };
  }

  checkCompatibility(): IndexCompatibility {
    if (!this.indexCompatibility) {
      if (!this.configuredProviderInfo) {
        throw new Error('No embedding provider info, you must initialize the indexer first.');
      }

      this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo);
    }
    return this.indexCompatibility;
  }

  private async ensureInitialized(): Promise<{
    store: VectorStore;
    provider: EmbeddingProviderInterface;
    invertedIndex: InvertedIndex;
    configuredProviderInfo: ConfiguredProviderInfo;
    database: Database;
    readIssues: readonly IndexReadIssue[];
    compatibility: IndexCompatibility;
  }> {
    let initializedReader = false;
    while (true) {
      if (this.initializationPromise) {
        await this.initializationPromise;
      }
      if (!this.isInitializedFor("reader")) {
        await this.initialize();
        initializedReader = true;
        continue;
      }
      if (
        this.initializationMode === "writer" &&
        !this.activeIndexLease &&
        !initializedReader
      ) {
        if (!this.refreshInactiveWriterArtifacts()) {
          this.resetLoadedIndexState(true);
          await this.initialize();
          initializedReader = true;
          continue;
        }
      }
      if (
        this.initializationMode === "reader" &&
        !initializedReader
      ) {
        this.refreshReaderArtifacts();
      }
      const state = this.requireLoadedIndexState();
      return {
        ...state,
        readIssues: [...this.readIssues],
        compatibility: this.indexCompatibility ?? this.validateIndexCompatibility(state.configuredProviderInfo),
      };
    }
  }

  private async ensureInitializedUnlocked(recoveredOwners: readonly IndexLockOwner[] = []): Promise<{
    store: VectorStore;
    provider: EmbeddingProviderInterface;
    invertedIndex: InvertedIndex;
    configuredProviderInfo: ConfiguredProviderInfo;
    database: Database;
  }> {
    this.requireActiveLease();

    if (this.initializationPromise) {
      await this.initializationPromise;
    }

    if (recoveredOwners.length > 0 || !this.isInitializedFor("writer")) {
      const retireReaderDatabase = this.initializationMode === "reader";
      this.resetLoadedIndexState(retireReaderDatabase);
      await this.initializeOnce("writer", recoveredOwners, { skipAutoGc: true });
    } else {
      this.refreshLoadedIndexState();
    }
    if (this.config.indexing.autoGc) {
      await this.maybeRunAutoGc();
    }
    return this.requireLoadedIndexState();
  }

  private requireReadableComponents(
    readIssues: readonly IndexReadIssue[],
    ...components: IndexReadIssue["component"][]
  ): void {
    const componentSet = new Set(components);
    const issues = readIssues.filter((issue) => issue.blocking && componentSet.has(issue.component));
    if (issues.length > 0) {
      throw new Error(issues.map((issue) => issue.message).join(" "));
    }
  }

  private requireLoadedIndexState(): {
    store: VectorStore;
    provider: EmbeddingProviderInterface;
    invertedIndex: InvertedIndex;
    configuredProviderInfo: ConfiguredProviderInfo;
    database: Database;
  } {
    if (!this.store || !this.provider || !this.invertedIndex || !this.configuredProviderInfo || !this.database) {
      throw new Error("Index state is not initialized");
    }
    return {
      store: this.store,
      provider: this.provider,
      invertedIndex: this.invertedIndex,
      configuredProviderInfo: this.configuredProviderInfo,
      database: this.database,
    };
  }

  async estimateCost(): Promise<CostEstimate> {
    const { configuredProviderInfo } = await this.ensureInitialized();

    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files } = await collectFiles(
      this.projectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.config.knowledgeBases,
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory }
    );

    return createCostEstimate(files, configuredProviderInfo);
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    return this.withIndexMutationLease("index", async (recoveredOwners) => {
      return this.indexUnlocked(onProgress, recoveredOwners);
    });
  }

  private async indexUnlocked(
    onProgress?: ProgressCallback,
    recoveredOwners: readonly IndexLockOwner[] = [],
    stateReady = false,
  ): Promise<IndexStats> {
    const { store, provider, invertedIndex, database, configuredProviderInfo } = stateReady
      ? this.requireLoadedIndexState()
      : await this.ensureInitializedUnlocked(recoveredOwners);
    const scopedRoots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const branchCatalogKey = this.getBranchCatalogKey();
    const forceScopedReembed = scopedRoots !== null && database.getMetadata(this.getProjectForceReembedMetadataKey()) === "true";
    const failedForcedChunkIds = new Set<string>();

    if (!this.indexCompatibility?.compatible) {
      throw new Error(
        `${this.indexCompatibility?.reason} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    this.logger.recordIndexingStart();
    this.logger.info("Starting indexing", { projectRoot: this.projectRoot });

    const startTime = Date.now();
    const stats: IndexStats = {
      totalFiles: 0,
      totalChunks: 0,
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      durationMs: 0,
      existingChunks: 0,
      removedChunks: 0,
      skippedFiles: [],
      parseFailures: [],
    };
    const failedBatchesForCurrentRun: FailedBatch[] = [];

    onProgress?.({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    this.loadFileHashCache();

    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files, skipped } = await collectFiles(
      this.projectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.config.knowledgeBases,
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory }
    );

    stats.totalFiles = files.length;
    stats.skippedFiles = skipped;

    this.logger.recordFilesScanned(files.length);
    this.logger.cache("debug", "Scanning files for changes", {
      totalFiles: files.length,
      skippedFiles: skipped.length,
    });

    const changedFiles: Array<{ path: string; content: string; hash: string }> = [];
    const unchangedFilePaths = new Set<string>();
    const currentFileHashes = new Map<string, string>();

    for (const f of files) {
      const currentHash = hashFile(f.path);
      currentFileHashes.set(f.path, currentHash);

      if (this.fileHashCache.get(f.path) === currentHash) {
        unchangedFilePaths.add(f.path);
        this.logger.recordCacheHit();
      } else {
        const content = await fsPromises.readFile(f.path, "utf-8");
        changedFiles.push({ path: f.path, content, hash: currentHash });
        this.logger.recordCacheMiss();
      }
    }

    this.logger.cache("info", "File hash cache results", {
      unchanged: unchangedFilePaths.size,
      changed: changedFiles.length,
    });

    onProgress?.({
      phase: "parsing",
      filesProcessed: 0,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const parseStartTime = performance.now();
    const parsedFiles = parseFiles(changedFiles);
    const parseMs = performance.now() - parseStartTime;

    this.logger.recordFilesParsed(parsedFiles.length);
    this.logger.recordParseDuration(parseMs);
    this.logger.debug("Parsed changed files", { parsedCount: parsedFiles.length, parseMs: parseMs.toFixed(2) });

    const existingChunks = new Map<string, string>();
    const existingChunksByFile = new Map<string, Set<string>>();
    const existingMetadataById = new Map<string, ChunkMetadata>();
    for (const { key, metadata } of store.getAllMetadata()) {
      if (scopedRoots && !this.isFileInCurrentScope(metadata.filePath, scopedRoots)) {
        continue;
      }
      if (forceScopedReembed && scopedRoots && this.isFileInCurrentScope(metadata.filePath, scopedRoots)) {
        continue;
      }
      existingChunks.set(key, metadata.hash);
      existingMetadataById.set(key, metadata);
      const fileChunks = existingChunksByFile.get(metadata.filePath) || new Set();
      fileChunks.add(key);
      existingChunksByFile.set(metadata.filePath, fileChunks);
    }

    const currentChunkIds = new Set<string>();
    const currentFilePaths = new Set<string>();
    const pendingChunks: PendingChunk[] = [];
    const gitBlameEnabled = this.config.indexing.gitBlame.enabled && isGitRepo(this.projectRoot);
    let backfilledBlameMetadata = false;

    for (const filePath of unchangedFilePaths) {
      currentFilePaths.add(filePath);
      const fileChunks = existingChunksByFile.get(filePath);
      if (fileChunks) {
        for (const chunkId of fileChunks) {
          currentChunkIds.add(chunkId);
        }
      }
    }

    const chunkDataBatch: ChunkData[] = [];

    if (gitBlameEnabled) {
      const backfillItems: Array<{ id: string; vector: number[]; metadata: ChunkMetadata }> = [];

      for (const chunkId of currentChunkIds) {
        const metadata = existingMetadataById.get(chunkId);
        if (!metadata || hasBlameMetadata(metadata)) {
          continue;
        }

        const chunk = database.getChunk(chunkId);
        if (!chunk) {
          continue;
        }

        const blame = await getChunkGitBlame(this.projectRoot, chunk.filePath, chunk.startLine, chunk.endLine);
        const blameMetadata = metadataFromBlame(blame);
        if (!blameMetadata.blameSha) {
          continue;
        }

        chunkDataBatch.push({
          ...chunk,
          blameSha: blameMetadata.blameSha,
          blameAuthor: blameMetadata.blameAuthor,
          blameAuthorEmail: blameMetadata.blameAuthorEmail,
          blameCommittedAt: blameMetadata.blameCommittedAt,
          blameSummary: blameMetadata.blameSummary,
        });

        const embeddingBuffer = database.getEmbedding(chunk.contentHash);
        if (!embeddingBuffer) {
          continue;
        }

        backfillItems.push({
          id: chunkId,
          vector: Array.from(bufferToFloat32Array(embeddingBuffer)),
          metadata: {
            ...metadata,
            ...blameMetadata,
          },
        });
      }

      if (backfillItems.length > 0) {
        store.addBatch(backfillItems);
        backfilledBlameMetadata = true;
      }
    }

    for (const parsed of parsedFiles) {
      currentFilePaths.add(parsed.path);

      if (parsed.chunks.length === 0) {
        const relativePath = path.relative(this.projectRoot, parsed.path);
        stats.parseFailures.push(relativePath);
      }

      let chunksToProcess = parsed.chunks;

      if (this.config.indexing.fallbackToTextOnMaxChunks && chunksToProcess.length > this.config.indexing.maxChunksPerFile) {
        const changedFile = changedFiles.find(f => f.path === parsed.path);
        if (changedFile) {
          const textChunks = parseFileAsText(parsed.path, changedFile.content);
          chunksToProcess = textChunks;
        }
      }

      chunksToProcess = selectChunksWithFileCoverage(
        chunksToProcess,
        this.config.indexing.maxChunksPerFile,
      );

      for (const chunk of chunksToProcess) {

        if (this.config.indexing.semanticOnly && chunk.chunkType === "other") {
          continue;
        }

        const id = generateChunkId(parsed.path, chunk);
        const contentHash = generateChunkHash(chunk);
        const existingContentHash = existingChunks.get(id);
        const existingChunk = gitBlameEnabled ? database.getChunk(id) : null;
        const blame = gitBlameEnabled && existingContentHash !== contentHash
          ? await getChunkGitBlame(this.projectRoot, parsed.path, chunk.startLine, chunk.endLine)
          : blameFromChunkData(existingChunk);
        const blameMetadata = metadataFromBlame(blame);
        currentChunkIds.add(id);

        chunkDataBatch.push({
          chunkId: id,
          contentHash,
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          nodeType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
          blameSha: blameMetadata.blameSha,
          blameAuthor: blameMetadata.blameAuthor,
          blameAuthorEmail: blameMetadata.blameAuthorEmail,
          blameCommittedAt: blameMetadata.blameCommittedAt,
          blameSummary: blameMetadata.blameSummary,
        });

        if (existingContentHash === contentHash) {
          continue;
        }

        const texts = createEmbeddingTexts(chunk, parsed.path, getSafeEmbeddingChunkTokenLimit(configuredProviderInfo)).map((text) => ({
          text,
          tokenCount: estimateTokens(text),
        }));
        const metadata: ChunkMetadata = {
          filePath: parsed.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          chunkType: chunk.chunkType,
          name: chunk.name,
          language: chunk.language,
          hash: contentHash,
          ...blameMetadata,
        };

        pendingChunks.push({
          id,
          texts,
          storageText: createPendingChunkStorageText(texts),
          content: chunk.content,
          contentHash,
          metadata,
        });
      }
    }

    const retryableFailedChunks = this.collectRetryableFailedChunks(
      currentFileHashes,
      unchangedFilePaths,
      getSafeEmbeddingChunkTokenLimit(configuredProviderInfo)
    );
    const retryableFailedAttemptCounts = new Map<string, number>();
    const retryableChunksWithExistingData = new Set<string>();
    if (retryableFailedChunks.length > 0) {
      const pendingChunkIds = new Set(pendingChunks.map((chunk) => chunk.id));
      for (const { chunk, attemptCount } of retryableFailedChunks) {
        retryableFailedAttemptCounts.set(chunk.id, attemptCount);
        if (existingChunks.has(chunk.id)) {
          retryableChunksWithExistingData.add(chunk.id);
        }
        if (!pendingChunkIds.has(chunk.id)) {
          pendingChunks.push(chunk);
          pendingChunkIds.add(chunk.id);
          currentChunkIds.add(chunk.id);
        }
      }
    }

    if (chunkDataBatch.length > 0) {
      database.upsertChunksBatch(chunkDataBatch);
    }

    const allSymbolIds = new Set<string>();
    const symbolsByFile = new Map<string, SymbolData[]>();

    for (let i = 0; i < parsedFiles.length; i++) {
      const parsed = parsedFiles[i];
      const changedFile = changedFiles[i];

      database.deleteCallEdgesByFile(parsed.path);
      database.deleteSymbolsByFile(parsed.path);

      const fileSymbols: SymbolData[] = [];

      for (const chunk of parsed.chunks) {
        if (!chunk.name || !CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(chunk.chunkType)) continue;

        const symbolId = `sym_${hashContent(parsed.path + ":" + chunk.name + ":" + chunk.chunkType + ":" + chunk.startLine).slice(0, 16)}`;
        const symbol: SymbolData = {
          id: symbolId,
          filePath: parsed.path,
          name: chunk.name,
          kind: chunk.chunkType,
          startLine: chunk.startLine,
          startCol: 0,
          endLine: chunk.endLine,
          endCol: 0,
          language: chunk.language,
        };
        fileSymbols.push(symbol);
        allSymbolIds.add(symbolId);
      }

      // For case-insensitive languages (e.g. Apex), the Rust call extractor
      // already lowercases non-constructor / non-import callee names, so we
      // must lowercase the symbol-map keys here too. Otherwise a declaration
      // like `MyMethod` would not match a lowercased call edge target like
      // `mymethod`, leaving same-file calls unresolved (toSymbolId = NULL).
      const fileLanguage = parsed.chunks[0]?.language;
      const isCaseInsensitiveLanguage =
        !!fileLanguage && CASE_INSENSITIVE_LANGUAGES.has(fileLanguage);
      const normalizeSymbolKey = (name: string): string =>
        isCaseInsensitiveLanguage ? name.toLowerCase() : name;

      const symbolsByName = new Map<string, SymbolData[]>();
      for (const symbol of fileSymbols) {
        const key = normalizeSymbolKey(symbol.name);
        const existing = symbolsByName.get(key) ?? [];
        existing.push(symbol);
        symbolsByName.set(key, existing);
      }

      if (fileSymbols.length > 0) {
        database.upsertSymbolsBatch(fileSymbols);
        symbolsByFile.set(parsed.path, fileSymbols);
      }

      if (!fileLanguage || !CALL_GRAPH_LANGUAGES.has(fileLanguage)) continue;

      const callSites = extractCalls(changedFile.content, fileLanguage);
      if (callSites.length === 0) continue;

      const edges: CallEdgeData[] = [];
      for (const site of callSites) {
        const enclosingSymbol = fileSymbols.find(
          (sym) => site.line >= sym.startLine && site.line <= sym.endLine
        );
        if (!enclosingSymbol) continue;

        const edgeId = `edge_${hashContent(enclosingSymbol.id + ":" + site.calleeName + ":" + site.line + ":" + site.column).slice(0, 16)}`;
        edges.push({
          id: edgeId,
          fromSymbolId: enclosingSymbol.id,
          targetName: site.calleeName,
          toSymbolId: undefined,
          callType: site.callType,
          confidence: site.confidence,
          line: site.line,
          col: site.column,
          isResolved: false,
        });
      }

      if (edges.length > 0) {
        database.upsertCallEdgesBatch(edges);

        // Resolve same-file calls (with the same case-insensitivity rules
        // used to build symbolsByName above).
        for (const edge of edges) {
          const candidates = symbolsByName.get(normalizeSymbolKey(edge.targetName));
          if (candidates && candidates.length === 1) {
            database.resolveCallEdge(edge.id, candidates[0].id);
          }
        }
      }
    }

    for (const filePath of unchangedFilePaths) {
      const existingSymbols = database.getSymbolsByFile(filePath);
      for (const sym of existingSymbols) {
        allSymbolIds.add(sym.id);
      }
    }

    const removedChunkIds: string[] = [];
    for (const [chunkId] of existingChunks) {
      if (!currentChunkIds.has(chunkId)) {
        removedChunkIds.push(chunkId);
      }
    }

    if (removedChunkIds.length > 0) {
      this.rebuildVectorStoreExcludingChunkIds(store, database, removedChunkIds);
      for (const chunkId of removedChunkIds) {
        invertedIndex.removeChunk(chunkId);
      }
      database.deleteChunksByIds(removedChunkIds);
    }

    const removedCount = removedChunkIds.length;

    stats.totalChunks = pendingChunks.length;
    stats.existingChunks = currentChunkIds.size - pendingChunks.length;
    stats.removedChunks = removedCount;

    this.logger.recordChunksProcessed(currentChunkIds.size);
    this.logger.recordChunksRemoved(removedCount);
    this.logger.info("Chunk analysis complete", {
      pending: pendingChunks.length,
      existing: stats.existingChunks,
      removed: removedCount,
    });

    if (pendingChunks.length === 0 && removedCount === 0) {
      database.clearBranch(branchCatalogKey);
      database.addChunksToBranchBatch(branchCatalogKey, Array.from(currentChunkIds));
      database.clearBranchSymbols(branchCatalogKey);
      database.addSymbolsToBranchBatch(branchCatalogKey, Array.from(allSymbolIds));
      const vectorPath = path.join(this.indexPath, "vectors");
      const shouldFingerprintLegacyPair = !store.hasFingerprint() &&
        existsSync(vectorPath) &&
        existsSync(`${vectorPath}.meta.json`);
      if (backfilledBlameMetadata || shouldFingerprintLegacyPair) {
        store.save();
      }
      if (scopedRoots) {
        this.replaceScopedFileHashCache(currentFileHashes, scopedRoots);
        this.clearScopedFailedBatches(scopedRoots);
      } else {
        this.fileHashCache = currentFileHashes;
        this.saveFileHashCache();
        this.saveFailedBatches([]);
      }
      this.saveIndexMetadata(configuredProviderInfo);
      this.indexCompatibility = { compatible: true };
      stats.durationMs = Date.now() - startTime;
      onProgress?.({
        phase: "complete",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      return stats;
    }

    if (pendingChunks.length === 0) {
      database.clearBranch(branchCatalogKey);
      database.addChunksToBranchBatch(branchCatalogKey, Array.from(currentChunkIds));
      database.clearBranchSymbols(branchCatalogKey);
      database.addSymbolsToBranchBatch(branchCatalogKey, Array.from(allSymbolIds));
      store.save();
      this.saveInvertedIndex(invertedIndex);
      if (scopedRoots) {
        this.replaceScopedFileHashCache(currentFileHashes, scopedRoots);
        this.clearScopedFailedBatches(scopedRoots);
      } else {
        this.fileHashCache = currentFileHashes;
        this.saveFileHashCache();
        this.saveFailedBatches([]);
      }
      this.saveIndexMetadata(configuredProviderInfo);
      this.indexCompatibility = { compatible: true };
      stats.durationMs = Date.now() - startTime;
      onProgress?.({
        phase: "complete",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      return stats;
    }

    onProgress?.({
      phase: "embedding",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: pendingChunks.length,
    });

    const allContentHashes = pendingChunks.map((c) => c.contentHash);
    const missingHashes = new Set(database.getMissingEmbeddings(allContentHashes));
    const forcedReembedChunkIds = forceScopedReembed
      ? new Set(pendingChunks.map((chunk) => chunk.id))
      : new Set<string>();

    const chunksNeedingEmbedding = pendingChunks.filter((c) => forcedReembedChunkIds.has(c.id) || missingHashes.has(c.contentHash));
    const chunksWithExistingEmbedding = pendingChunks.filter((c) => !forcedReembedChunkIds.has(c.id) && !missingHashes.has(c.contentHash));

    this.logger.cache("info", "Embedding cache lookup", {
      needsEmbedding: chunksNeedingEmbedding.length,
      fromCache: chunksWithExistingEmbedding.length,
    });
    this.logger.recordChunksFromCache(chunksWithExistingEmbedding.length);

    for (const chunk of chunksWithExistingEmbedding) {
      const embeddingBuffer = database.getEmbedding(chunk.contentHash);
      if (embeddingBuffer) {
        const vector = bufferToFloat32Array(embeddingBuffer);
        store.add(chunk.id, Array.from(vector), chunk.metadata);
        invertedIndex.removeChunk(chunk.id);
        invertedIndex.addChunk(chunk.id, chunk.content);
        stats.indexedChunks++;
      }
    }

    const providerRateLimits = this.getProviderRateLimits(configuredProviderInfo.provider);
    const queue = new PQueue({
      concurrency: providerRateLimits.concurrency,
      interval: providerRateLimits.intervalMs,
      intervalCap: providerRateLimits.concurrency
    });
    const pendingChunksById = new Map(chunksNeedingEmbedding.map((chunk) => [chunk.id, chunk]));
    const embeddingPartsByChunk = new Map<string, Array<{ vector: number[]; tokenCount: number } | undefined>>();
    const completedChunkIds = new Set<string>();
    const failedChunkIds = new Set<string>();
    const requestBatches = createPendingEmbeddingRequestBatches(
      chunksNeedingEmbedding,
      getDynamicBatchOptions(configuredProviderInfo)
    );
    let rateLimitBackoffMs = 0;

    for (const requestBatch of requestBatches) {
      queue.add(async () => {
        if (rateLimitBackoffMs > 0) {
          await new Promise(resolve => setTimeout(resolve, rateLimitBackoffMs));
        }

        try {
          const result = await pRetry(
            async () => {
              const texts = requestBatch.map((request) => request.text);
              return provider.embedBatch(texts);
            },
            {
              retries: this.config.indexing.retries,
              minTimeout: Math.max(this.config.indexing.retryDelayMs, providerRateLimits.minRetryMs),
              maxTimeout: providerRateLimits.maxRetryMs,
              factor: 2,
              shouldRetry: (error) => !((error as { error?: Error }).error instanceof CustomProviderNonRetryableError),
              onFailedAttempt: (error) => {
                const message = getErrorMessage(error);
                if (isRateLimitError(error)) {
                  rateLimitBackoffMs = Math.min(providerRateLimits.maxRetryMs, (rateLimitBackoffMs || providerRateLimits.minRetryMs) * 2);
                  this.logger.embedding("warn", `Rate limited, backing off`, {
                    attempt: error.attemptNumber,
                    retriesLeft: error.retriesLeft,
                    backoffMs: rateLimitBackoffMs,
                  });
                } else {
                  this.logger.embedding("error", `Embedding batch failed`, {
                    attempt: error.attemptNumber,
                    error: message,
                  });
                }
              },
            }
          );

          if (rateLimitBackoffMs > 0) {
            rateLimitBackoffMs = Math.max(0, rateLimitBackoffMs - 2000);
          }

          const touchedChunkIds = new Set<string>();

          requestBatch.forEach((request, idx) => {
            if (failedChunkIds.has(request.chunk.id) || completedChunkIds.has(request.chunk.id)) {
              return;
            }

            const vector = result.embeddings[idx];
            if (!vector) {
              throw new Error(`Embedding API returned too few vectors for chunk ${request.chunk.id}`);
            }

            const parts = embeddingPartsByChunk.get(request.chunk.id) ?? [];
            parts[request.partIndex] = {
              vector,
              tokenCount: request.tokenCount,
            };
            embeddingPartsByChunk.set(request.chunk.id, parts);
            touchedChunkIds.add(request.chunk.id);
          });

          const pooledResults: Array<{ chunk: PendingChunk; vector: number[] }> = [];
          for (const chunkId of touchedChunkIds) {
            if (failedChunkIds.has(chunkId) || completedChunkIds.has(chunkId)) {
              continue;
            }

            const chunk = pendingChunksById.get(chunkId);
            if (!chunk) {
              continue;
            }

            const parts = embeddingPartsByChunk.get(chunk.id) ?? [];
            if (!hasAllEmbeddingParts(parts, chunk.texts.length)) {
              continue;
            }

            const orderedParts = parts as Array<{ vector: number[]; tokenCount: number }>;
            pooledResults.push({
              chunk,
              vector: poolEmbeddingVectors(
                orderedParts.map((part) => part.vector),
                orderedParts.map((part) => part.tokenCount)
              ),
            });
          }

          if (pooledResults.length > 0) {
            const items = pooledResults.map(({ chunk, vector }) => ({
              id: chunk.id,
              vector,
              metadata: chunk.metadata,
            }));

            store.addBatch(items);

            const embeddingBatchItems = pooledResults.map(({ chunk, vector }) => ({
              contentHash: chunk.contentHash,
              embedding: float32ArrayToBuffer(vector),
              chunkText: chunk.storageText,
              model: configuredProviderInfo.modelInfo.model,
            }));

            try {
              database.upsertEmbeddingsBatch(embeddingBatchItems);
            } catch (dbError) {
              this.rebuildVectorStoreExcludingChunkIds(
                store,
                database,
                pooledResults.map(({ chunk }) => chunk.id)
              );
              throw dbError;
            }

            for (const { chunk } of pooledResults) {
              invertedIndex.removeChunk(chunk.id);
              invertedIndex.addChunk(chunk.id, chunk.content);
              completedChunkIds.add(chunk.id);
              embeddingPartsByChunk.delete(chunk.id);
            }

            stats.indexedChunks += pooledResults.length;
            this.logger.recordChunksEmbedded(pooledResults.length);
          }

          stats.tokensUsed += result.totalTokensUsed;

          this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
          this.logger.embedding("debug", `Embedded batch`, {
            batchSize: pooledResults.length,
            requestCount: requestBatch.length,
            tokens: result.totalTokensUsed,
          });

          onProgress?.({
            phase: "embedding",
            filesProcessed: files.length,
            totalFiles: files.length,
            chunksProcessed: stats.indexedChunks,
            totalChunks: pendingChunks.length,
          });
        } catch (error) {
          const failedChunks = getUniquePendingChunksFromRequests(requestBatch)
            .filter((chunk) => !completedChunkIds.has(chunk.id));
          const failureMessage = getErrorMessage(error);
          const failureTimestamp = new Date().toISOString();

          for (const chunk of failedChunks) {
            if (!failedChunkIds.has(chunk.id)) {
              failedChunkIds.add(chunk.id);
              stats.failedChunks += 1;
            }

            if (forceScopedReembed) {
              failedForcedChunkIds.add(chunk.id);
            }

            embeddingPartsByChunk.delete(chunk.id);

            const existingFailedBatchIndex = failedBatchesForCurrentRun.findIndex(
              (failedBatch) => failedBatch.chunks[0]?.id === chunk.id
            );
            const existingFailedBatch = existingFailedBatchIndex === -1
              ? undefined
              : failedBatchesForCurrentRun[existingFailedBatchIndex];
            const failedBatch = {
              chunks: [chunk],
              error: failureMessage,
              attemptCount: (existingFailedBatch?.attemptCount ?? retryableFailedAttemptCounts.get(chunk.id) ?? 0) + 1,
              lastAttempt: failureTimestamp,
            } satisfies FailedBatch;

            if (existingFailedBatchIndex === -1) {
              failedBatchesForCurrentRun.push(failedBatch);
            } else {
              failedBatchesForCurrentRun[existingFailedBatchIndex] = failedBatch;
            }
          }

          this.logger.recordEmbeddingError();
          this.logger.embedding("error", `Failed to embed batch after retries`, {
            batchSize: failedChunks.length,
            requestCount: requestBatch.length,
            error: failureMessage,
          });
        }
      });
    }

    await queue.onIdle();
    if (scopedRoots) {
      this.saveScopedFailedBatches(coalesceFailedBatches(failedBatchesForCurrentRun), scopedRoots);
    } else {
      this.saveFailedBatches(coalesceFailedBatches(failedBatchesForCurrentRun));
    }

    onProgress?.({
      phase: "storing",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: pendingChunks.length,
    });

    const branchChunkIds = Array.from(currentChunkIds).filter(
      (chunkId) => {
        const isNewlyFailed = failedChunkIds.has(chunkId) && !retryableChunksWithExistingData.has(chunkId);
        const isForcedFailed = forceScopedReembed && failedForcedChunkIds.has(chunkId);
        return !isNewlyFailed && !isForcedFailed;
      }
    );
    database.clearBranch(branchCatalogKey);
    database.addChunksToBranchBatch(branchCatalogKey, branchChunkIds);
    database.clearBranchSymbols(branchCatalogKey);
    database.addSymbolsToBranchBatch(branchCatalogKey, Array.from(allSymbolIds));

    store.save();
    this.saveInvertedIndex(invertedIndex);
    if (scopedRoots) {
      this.replaceScopedFileHashCache(currentFileHashes, scopedRoots);
    } else {
      this.fileHashCache = currentFileHashes;
      this.saveFileHashCache();
    }

    if (this.config.indexing.autoGc && stats.removedChunks > 0) {
      const gcReset = await this.maybeRunOrphanGc();
      if (gcReset) {
        stats.durationMs = Date.now() - startTime;
        stats.warning = gcReset.warning;
        stats.resetCorruptedIndex = true;

        this.logger.recordIndexingEnd();
        this.logger.warn("Indexing ended after resetting corrupted local index during automatic GC", {
          files: stats.totalFiles,
          indexed: stats.indexedChunks,
          existing: stats.existingChunks,
          removed: stats.removedChunks,
          failed: stats.failedChunks,
          tokens: stats.tokensUsed,
          durationMs: stats.durationMs,
        });

        return stats;
      }
    }

    stats.durationMs = Date.now() - startTime;

    if (forceScopedReembed && failedForcedChunkIds.size === 0) {
      database.deleteMetadata(this.getProjectForceReembedMetadataKey());
    }
    this.saveIndexMetadata(configuredProviderInfo);
    this.indexCompatibility = { compatible: true };

    this.logger.recordIndexingEnd();
    this.logger.info("Indexing complete", {
      files: stats.totalFiles,
      indexed: stats.indexedChunks,
      existing: stats.existingChunks,
      removed: stats.removedChunks,
      failed: stats.failedChunks,
      tokens: stats.tokensUsed,
      durationMs: stats.durationMs,
    });

    if (stats.failedChunks > 0) {
      stats.failedBatchesPath = this.failedBatchesPath;
    }

    onProgress?.({
      phase: "complete",
      filesProcessed: files.length,
      totalFiles: files.length,
      chunksProcessed: stats.indexedChunks,
      totalChunks: pendingChunks.length,
    });

    return stats;
  }

  private async getQueryEmbedding(query: string, provider: EmbeddingProviderInterface): Promise<number[]> {
    const now = Date.now();
    const cached = this.queryEmbeddingCache.get(query);

    if (cached && (now - cached.timestamp) < this.queryCacheTtlMs) {
      this.logger.cache("debug", "Query embedding cache hit (exact)", { query: query.slice(0, 50) });
      this.logger.recordQueryCacheHit();
      return cached.embedding;
    }

    const similarMatch = this.findSimilarCachedQuery(query, now);
    if (similarMatch) {
      this.logger.cache("debug", "Query embedding cache hit (similar)", {
        query: query.slice(0, 50),
        similarTo: similarMatch.key.slice(0, 50),
        similarity: similarMatch.similarity.toFixed(3),
      });
      this.logger.recordQueryCacheSimilarHit();
      return similarMatch.embedding;
    }

    this.logger.cache("debug", "Query embedding cache miss", { query: query.slice(0, 50) });
    this.logger.recordQueryCacheMiss();
    const { embedding, tokensUsed } = await provider.embedQuery(query);
    this.logger.recordEmbeddingApiCall(tokensUsed);

    if (this.queryEmbeddingCache.size >= this.maxQueryCacheSize) {
      const oldestKey = this.queryEmbeddingCache.keys().next().value;
      if (oldestKey) {
        this.queryEmbeddingCache.delete(oldestKey);
      }
    }

    this.queryEmbeddingCache.set(query, { embedding, timestamp: now });
    return embedding;
  }

  private findSimilarCachedQuery(
    query: string,
    now: number
  ): { key: string; embedding: number[]; similarity: number } | null {
    const queryTokens = this.tokenize(query);
    if (queryTokens.size === 0) return null;

    let bestMatch: { key: string; embedding: number[]; similarity: number } | null = null;

    for (const [cachedQuery, { embedding, timestamp }] of this.queryEmbeddingCache) {
      if ((now - timestamp) >= this.queryCacheTtlMs) continue;

      const cachedTokens = this.tokenize(cachedQuery);
      const similarity = this.jaccardSimilarity(queryTokens, cachedTokens);

      if (similarity >= this.querySimilarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { key: cachedQuery, embedding, similarity };
        }
      }
    }

    return bestMatch;
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 1)
    );
  }

  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    for (const token of a) {
      if (b.has(token)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return intersection / union;
  }

  async search(
    query: string,
    limit?: number,
    options?: {
      hybridWeight?: number;
      fileType?: string;
      directory?: string;
      chunkType?: string;
      contextLines?: number;
      filterByBranch?: boolean;
      metadataOnly?: boolean;
      definitionIntent?: boolean;
      blameAuthor?: string;
      blameSha?: string;
      blameSince?: string;
    }
  ): Promise<SearchResult[]> {
    const { store, provider, invertedIndex, database, readIssues, compatibility } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "vectors", "database");

    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `A possible solution is to run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if (store.count() === 0) {
      this.logger.search("debug", "Search on empty index", { query });
      return [];
    }

    const maxResults = limit ?? this.config.search.maxResults;
    const hybridWeight = options?.hybridWeight ?? this.config.search.hybridWeight;
    const fusionStrategy = this.config.search.fusionStrategy;
    const effectiveHybridWeight = fusionStrategy === "weighted" &&
      readIssues.some((issue) => issue.component === "keyword")
      ? 0
      : hybridWeight;
    const rrfK = this.config.search.rrfK;
    const rerankTopN = this.config.search.rerankTopN;
    const filterByBranch = options?.filterByBranch ?? true;
    const sourceIntent = options?.definitionIntent === true || classifyQueryIntentRaw(query) === "source";
    const identifierHints = extractIdentifierHints(query);

    this.logger.search("debug", "Starting search", {
      query,
      maxResults,
      hybridWeight: effectiveHybridWeight,
      fusionStrategy,
      rrfK,
      rerankTopN,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const embeddingQuery = stripFilePathHint(query);
    let embedding: number[] | undefined;
    try {
      embedding = await this.getQueryEmbedding(embeddingQuery, provider);
    } catch (error) {
      this.logger.warn("Query embedding failed; falling back to keyword-only search", {
        query,
        error: getErrorMessage(error),
        action: "Check the embedding provider configuration and retry search after restoring provider health.",
      });
    }
    const embeddingMs = performance.now() - embeddingStartTime;

    const vectorStartTime = performance.now();
    const semanticResults = embedding ? store.search(embedding, maxResults * 4) : [];
    const vectorMs = performance.now() - vectorStartTime;

    const keywordStartTime = performance.now();
    const keywordResults = await this.keywordSearch(query, maxResults * 4, store, invertedIndex);
    const keywordMs = performance.now() - keywordStartTime;

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && (this.config.scope === "global" || this.currentBranch !== "default")) {
      branchChunkIds = new Set(
        this.getBranchCatalogKeys().flatMap((branchKey) => database.getBranchChunkIds(branchKey))
      );
    }

    const prefilterStartTime = performance.now();
    const shouldPrefilterByBranch = branchChunkIds !== null && (this.config.scope === "global" || branchChunkIds.size > 0);
    const allowBranchPrefilterFallback = this.config.scope !== "global";
    const prefilteredSemantic = shouldPrefilterByBranch && branchChunkIds
      ? semanticResults.filter((r) => branchChunkIds.has(r.id))
      : semanticResults;
    const prefilteredKeyword = shouldPrefilterByBranch && branchChunkIds
      ? keywordResults.filter((r) => branchChunkIds.has(r.id))
      : keywordResults;

    const semanticCandidates = (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0)
      ? semanticResults
      : prefilteredSemantic;
    const keywordCandidates = (allowBranchPrefilterFallback && shouldPrefilterByBranch && keywordResults.length > 0 && prefilteredKeyword.length === 0)
      ? keywordResults
      : prefilteredKeyword;
    const prefilterMs = performance.now() - prefilterStartTime;

    if (this.config.scope !== "global" && branchChunkIds && branchChunkIds.size === 0) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    if (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no semantic overlap, using unfiltered semantic candidates", {
        branch: this.currentBranch,
      });
    }

    if (allowBranchPrefilterFallback && shouldPrefilterByBranch && keywordResults.length > 0 && prefilteredKeyword.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no keyword overlap, using unfiltered keyword candidates", {
        branch: this.currentBranch,
      });
    }

    const fusionStartTime = performance.now();
    const rankingHybridWeight = embedding === undefined && fusionStrategy === "weighted"
      ? 1
      : effectiveHybridWeight;
    const combined = rankHybridResults(query, semanticCandidates, keywordCandidates, {
      fusionStrategy,
      rrfK,
      rerankTopN,
      limit: maxResults,
      hybridWeight: rankingHybridWeight,
      prioritizeSourcePaths: sourceIntent,
    });
    const rerankedCombined = await this.rerankCandidatesWithApi(query, combined, {
      definitionIntent: options?.definitionIntent === true,
      hasIdentifierHints: identifierHints.length > 0,
    });
    const fusionMs = performance.now() - fusionStartTime;

    const rescued = promoteIdentifierMatches(
      query,
      rerankedCombined,
      semanticCandidates,
      keywordCandidates,
      database,
      branchChunkIds,
      sourceIntent
    );

    const union = unionCandidates(semanticCandidates, keywordCandidates);

    const deterministicIdentifierLane = buildDeterministicIdentifierPass(
      query,
      union,
      maxResults,
      sourceIntent
    );

    const identifierLane = buildIdentifierDefinitionLane(
      query,
      union,
      maxResults,
      sourceIntent
    );

    const symbolLane = buildSymbolDefinitionLane(
      query,
      database,
      branchChunkIds,
      maxResults,
      union,
      sourceIntent
    );

    const prePrimaryLane = mergeTieredResults(deterministicIdentifierLane, identifierLane, maxResults * 4);
    const primaryLane = mergeTieredResults(prePrimaryLane, symbolLane, maxResults * 4);
    const tiered = mergeTieredResults(primaryLane, rescued, maxResults * 4);
    const hasCodeHints = extractCodeTermHints(query).length > 0 || identifierHints.length > 0;

    const baseFiltered = tiered.filter((r) => matchesSearchFilters(r, options, this.config.search.minScore));

    const implementationOnly = baseFiltered.filter((r) =>
      isLikelyImplementationPath(r.metadata.filePath) &&
      isImplementationChunkType(r.metadata.chunkType)
    );

    const filtered = (sourceIntent && hasCodeHints && implementationOnly.length > 0
      ? implementationOnly
      : baseFiltered
    ).slice(0, maxResults);

    const identifierFallback = (!options?.definitionIntent && filtered.length === 0 && identifierHints.length > 0)
      ? buildSymbolDefinitionLane(query, database, branchChunkIds, maxResults, union, true)
        .filter((r) => matchesSearchFilters(r, options, this.config.search.minScore))
        .slice(0, maxResults)
      : [];

    const finalResults = filtered.length > 0 ? filtered : identifierFallback;

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs,
      fusionMs,
    });
    this.logger.search("info", "Search complete", {
      query,
      results: finalResults.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      keywordMs: Math.round(keywordMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
      fusionMs: Math.round(fusionMs * 100) / 100,
    });

    const metadataOnly = options?.metadataOnly ?? false;

    return Promise.all(
      finalResults.map(async (r) => {
        let content = "";
        let contextStartLine = r.metadata.startLine;
        let contextEndLine = r.metadata.endLine;

        if (!metadataOnly && this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            const contextLines = options?.contextLines ?? this.config.search.contextLines;

            contextStartLine = Math.max(1, r.metadata.startLine - contextLines);
            contextEndLine = Math.min(lines.length, r.metadata.endLine + contextLines);

            content = lines
              .slice(contextStartLine - 1, contextEndLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: contextStartLine,
          endLine: contextEndLine,
          content,
          score: r.score,
          chunkType: r.metadata.chunkType,
          name: r.metadata.name,
          blame: blameFromMetadata(r.metadata),
        };
      })
    );
  }

  private async keywordSearch(
    query: string,
    limit: number,
    store: VectorStore,
    invertedIndex: InvertedIndex,
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const scores = invertedIndex.search(query);

    if (scores.size === 0) {
      return [];
    }

    // Only fetch metadata for chunks returned by BM25 (O(n) where n = result count)
    // instead of getAllMetadata() which fetches ALL chunks in the index
    const chunkIds = Array.from(scores.keys());
    const metadataMap = store.getMetadataBatch(chunkIds);

    const results: Array<{ id: string; score: number; metadata: ChunkMetadata }> = [];
    for (const [chunkId, score] of scores) {
      const metadata = metadataMap.get(chunkId);
      if (metadata && score > 0) {
        results.push({ id: chunkId, score, metadata });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async getStatus(): Promise<StatusResult> {
    const { store, configuredProviderInfo, database, readIssues, compatibility } = await this.ensureInitialized();
    const failedBatchesCount = this.getFailedBatchesCount();
    const vectorCount = store.count();
    const statusReadIssues = [...readIssues];
    let startupWarning = "";
    if (!statusReadIssues.some((issue) => issue.component === "database")) {
      try {
        startupWarning = database.getMetadata(STARTUP_WARNING_METADATA_KEY) ?? "";
      } catch (error) {
        const message = this.getDatabaseReadIssueMessage();
        statusReadIssues.push(this.createReadIssue("database", message));
        if (!this.readIssues.some((issue) => issue.component === "database")) {
          this.recordReadIssue("database", message, error);
        }
      }
    }
    const readWarning = statusReadIssues.map((issue) => issue.message).join(" ");
    const warning = [readWarning, startupWarning].filter((message) => message.length > 0).join(" ");
    const hasBlockingReadIssue = statusReadIssues.some((issue) => issue.blocking);

    return {
      indexed: vectorCount > 0 && !hasBlockingReadIssue,
      vectorCount,
      provider: configuredProviderInfo.provider,
      model: configuredProviderInfo.modelInfo.model,
      indexPath: this.indexPath,
      currentBranch: this.currentBranch,
      baseBranch: this.baseBranch,
      compatibility,
      failedBatchesCount,
      failedBatchesPath: failedBatchesCount > 0 ? this.failedBatchesPath : undefined,
      warning: warning || undefined,
    };
  }

  async forceIndex(onProgress?: ProgressCallback): Promise<IndexStats> {
    return this.withIndexMutationLease("force-index", async (recoveredOwners) => {
      await this.ensureInitializedUnlocked(recoveredOwners);
      await this.clearIndexUnlocked();
      return this.indexUnlocked(onProgress, [], true);
    });
  }

  async clearIndex(): Promise<void> {
    await this.withIndexMutationLease("clear", async (recoveredOwners) => {
      await this.ensureInitializedUnlocked(recoveredOwners);
      await this.clearIndexUnlocked();
    });
  }

  private async clearIndexUnlocked(): Promise<void> {
    const { store, invertedIndex, database } = this.requireLoadedIndexState();

    if (this.config.scope === "global") {
      store.load();
      invertedIndex.load();
      this.loadFileHashCache();
      const roots = this.getScopedRoots();
      const compatibility = this.checkCompatibility();
      const allMetadata = store.getAllMetadata();
      const hasForeignData =
        allMetadata.some(({ metadata }) => !this.isFileInCurrentScope(metadata.filePath, roots)) ||
        this.hasForeignScopedBranchData() ||
        this.hasForeignScopedFileHashData(roots) ||
        this.hasForeignScopedFailedBatches(roots);

      if (!compatibility.compatible && hasForeignData) {
        if (compatibility.code === IncompatibilityCode.EMBEDDING_STRATEGY_MISMATCH) {
          this.clearSharedIndexProjectData(store, invertedIndex, database, roots);
          this.clearScopedFileHashCache(roots);
          this.clearScopedFailedBatches(roots);
          database.setMetadata(this.getProjectForceReembedMetadataKey(), "true");
          database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey());
          this.indexCompatibility = { compatible: true };
          return;
        }

        throw new Error(
          `Global index compatibility reset is unsafe because the shared index contains files from other projects. ` +
          `The current global index cannot be force-rebuilt for ${this.projectRoot} without deleting other repositories' indexed data. ` +
          `Use scope="project" for isolated rebuilds, or manually delete the shared global index if you intend to rebuild all projects.`
        );
      }

      if (!hasForeignData) {
        store.clear();
        store.save();
        invertedIndex.clear();
        this.saveInvertedIndex(invertedIndex);

        this.fileHashCache.clear();
        this.saveFileHashCache();

        database.clearAllIndexedData();
        this.saveFailedBatches([]);

        database.deleteMetadata("index.version");
        database.deleteMetadata("index.embeddingProvider");
        database.deleteMetadata("index.embeddingModel");
        database.deleteMetadata("index.embeddingDimensions");
        database.deleteMetadata("index.embeddingStrategyVersion");
        database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey());
        database.deleteMetadata(this.getProjectForceReembedMetadataKey());
        database.deleteMetadata(this.getLegacyMigrationMetadataKey());
        database.deleteMetadata("index.createdAt");
        database.deleteMetadata("index.updatedAt");

        this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo!);
        return;
      }

      this.clearSharedIndexProjectData(store, invertedIndex, database, roots);
      this.clearScopedFileHashCache(roots);
      this.clearScopedFailedBatches(roots);
      this.indexCompatibility = compatibility;
      return;
    }

    if (!this.isLocalProjectIndexPath()) {
      throw new Error(
        "Project-scoped force rebuild is unsafe while using an inherited worktree index. " +
        "Create a local project config boundary before clearing the index."
      );
    }

    store.clear();
    store.save();
    invertedIndex.clear();
    this.saveInvertedIndex(invertedIndex);

    // Clear file hash cache so all files are re-parsed
    this.fileHashCache.clear();
    this.saveFileHashCache();

    // cannot reuse stale chunks, symbols, or embeddings from a prior provider.
    database.clearAllIndexedData();
    this.saveFailedBatches([]);

    database.deleteMetadata("index.version");
    database.deleteMetadata("index.embeddingProvider");
    database.deleteMetadata("index.embeddingModel");
    database.deleteMetadata("index.embeddingDimensions");
    database.deleteMetadata("index.embeddingStrategyVersion");
    database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey());
    database.deleteMetadata(this.getProjectForceReembedMetadataKey());
    database.deleteMetadata(this.getLegacyMigrationMetadataKey());
    database.deleteMetadata("index.createdAt");
    database.deleteMetadata("index.updatedAt");

    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo!);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return this.withIndexMutationLease("health-check", async (recoveredOwners) => {
      await this.ensureInitializedUnlocked(recoveredOwners);
      return this.healthCheckUnlocked();
    });
  }

  private async healthCheckUnlocked(): Promise<HealthCheckResult> {
    const { store, invertedIndex, database } = this.requireLoadedIndexState();

    this.logger.gc("info", "Starting health check");

    const allMetadata = store.getAllMetadata();
    const filePathsToChunkKeys = new Map<string, string[]>();

    for (const { key, metadata } of allMetadata) {
      const existing = filePathsToChunkKeys.get(metadata.filePath) || [];
      existing.push(key);
      filePathsToChunkKeys.set(metadata.filePath, existing);
    }

    const removedFilePaths: string[] = [];
    const removedChunkKeys: string[] = [];
    const chunkKeysByRemovedFile = new Map<string, string[]>();

    for (const [filePath, chunkKeys] of filePathsToChunkKeys) {
      if (!existsSync(filePath)) {
        chunkKeysByRemovedFile.set(filePath, chunkKeys);
        for (const key of chunkKeys) {
          removedChunkKeys.push(key);
        }
        removedFilePaths.push(filePath);
      }
    }

    if (removedChunkKeys.length > 0) {
      this.rebuildVectorStoreExcludingChunkIds(store, database, removedChunkKeys);
      for (const key of removedChunkKeys) {
        invertedIndex.removeChunk(key);
      }
    }

    for (const filePath of removedFilePaths) {
      const fileChunkKeys = chunkKeysByRemovedFile.get(filePath) ?? [];
      if (fileChunkKeys.length > 0) {
        database.deleteChunksByIds(fileChunkKeys);
      }
      database.deleteCallEdgesByFile(filePath);
      database.deleteSymbolsByFile(filePath);
    }

    const removedCount = removedChunkKeys.length;

    if (removedCount > 0) {
      store.save();
      this.saveInvertedIndex(invertedIndex);
    }

    let gcOrphanEmbeddings: number;
    let gcOrphanChunks: number;
    let gcOrphanSymbols: number;
    let gcOrphanCallEdges: number;

    try {
      gcOrphanEmbeddings = database.gcOrphanEmbeddings();
      gcOrphanChunks = database.gcOrphanChunks();
      gcOrphanSymbols = database.gcOrphanSymbols();
      gcOrphanCallEdges = database.gcOrphanCallEdges();
    } catch (error) {
      if (!(await this.tryResetCorruptedIndex("running index health check", error))) {
        throw error;
      }

      await this.initializeUnlocked("writer", [], { skipAutoGc: true });

      return {
        removed: 0,
        filePaths: [],
        gcOrphanEmbeddings: 0,
        gcOrphanChunks: 0,
        gcOrphanSymbols: 0,
        gcOrphanCallEdges: 0,
        resetCorruptedIndex: true,
        warning: this.getCorruptedIndexWarning(path.join(this.indexPath, "codebase.db")),
      };
    }

    this.logger.recordGc(removedCount, gcOrphanChunks, gcOrphanEmbeddings);
    this.logger.gc("info", "Health check complete", {
      removedStale: removedCount,
      orphanEmbeddings: gcOrphanEmbeddings,
      orphanChunks: gcOrphanChunks,
      removedFiles: removedFilePaths.length,
    });

    return { removed: removedCount, filePaths: removedFilePaths, gcOrphanEmbeddings, gcOrphanChunks, gcOrphanSymbols, gcOrphanCallEdges };
  }

  async retryFailedBatches(): Promise<{ succeeded: number; failed: number; remaining: number }> {
    return this.withIndexMutationLease("retry-failed-batches", async (recoveredOwners) => {
      await this.ensureInitializedUnlocked(recoveredOwners);
      return this.retryFailedBatchesUnlocked();
    });
  }

  private async retryFailedBatchesUnlocked(): Promise<{ succeeded: number; failed: number; remaining: number }> {
    const { store, provider, invertedIndex, database, configuredProviderInfo } = this.requireLoadedIndexState();
    const maxChunkTokens = getSafeEmbeddingChunkTokenLimit(configuredProviderInfo);
    const providerRateLimits = this.getProviderRateLimits(configuredProviderInfo.provider);

    const roots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const { scoped: scopedFailedBatches, retained: retainedFailedBatches } = roots
      ? this.partitionFailedBatches(roots, maxChunkTokens)
      : { scoped: this.loadFailedBatches(maxChunkTokens), retained: [] as FailedBatch[] };
    const failedBatches = scopedFailedBatches;
    if (failedBatches.length === 0) {
      return { succeeded: 0, failed: 0, remaining: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    const stillFailing: FailedBatch[] = [];

    for (const batch of failedBatches) {
      const batchChunksById = new Map(batch.chunks.map((chunk) => [chunk.id, chunk]));
      const embeddingPartsByChunk = new Map<string, Array<{ vector: number[]; tokenCount: number } | undefined>>();
      const completedChunkIds = new Set<string>();
      const failedChunkIds = new Set<string>();
      const failedChunksForBatch = new Map<string, FailedBatch>();
      const pooledResults: Array<{ chunk: PendingChunk; vector: number[] }> = [];
      try {
        const requestBatches = createPendingEmbeddingRequestBatches(
          batch.chunks,
          getDynamicBatchOptions(configuredProviderInfo)
        );

        for (const requestBatch of requestBatches) {
          try {
            const result = await pRetry(
              async () => {
                const texts = requestBatch.map((request) => request.text);
                return provider.embedBatch(texts);
              },
              {
                retries: this.config.indexing.retries,
                minTimeout: Math.max(this.config.indexing.retryDelayMs, providerRateLimits.minRetryMs),
                maxTimeout: providerRateLimits.maxRetryMs,
                factor: 2,
                shouldRetry: (error) => !((error as { error?: Error }).error instanceof CustomProviderNonRetryableError),
              }
            );

            const touchedChunkIds = new Set<string>();
            requestBatch.forEach((request, idx) => {
              if (failedChunkIds.has(request.chunk.id) || completedChunkIds.has(request.chunk.id)) {
                return;
              }

              const vector = result.embeddings[idx];
              if (!vector) {
                throw new Error(`Embedding API returned too few vectors for chunk ${request.chunk.id}`);
              }

              const parts = embeddingPartsByChunk.get(request.chunk.id) ?? [];
              parts[request.partIndex] = {
                vector,
                tokenCount: request.tokenCount,
              };
              embeddingPartsByChunk.set(request.chunk.id, parts);
              touchedChunkIds.add(request.chunk.id);
            });

            for (const chunkId of touchedChunkIds) {
              if (failedChunkIds.has(chunkId) || completedChunkIds.has(chunkId)) {
                continue;
              }

              const chunk = batchChunksById.get(chunkId);
              if (!chunk) {
                continue;
              }

              const parts = embeddingPartsByChunk.get(chunk.id) ?? [];
              if (!hasAllEmbeddingParts(parts, chunk.texts.length)) {
                continue;
              }

              const orderedParts = parts as Array<{ vector: number[]; tokenCount: number }>;
              pooledResults.push({
                chunk,
                vector: poolEmbeddingVectors(
                  orderedParts.map((part) => part.vector),
                  orderedParts.map((part) => part.tokenCount)
                ),
              });
            }

            this.logger.recordEmbeddingApiCall(result.totalTokensUsed);
          } catch (error) {
            const failureMessage = String(error);
            const failureTimestamp = new Date().toISOString();
            const failedChunks = getUniquePendingChunksFromRequests(requestBatch)
              .filter((chunk) => !completedChunkIds.has(chunk.id) && !failedChunkIds.has(chunk.id));

            for (const chunk of failedChunks) {
              failedChunkIds.add(chunk.id);
              embeddingPartsByChunk.delete(chunk.id);
              failedChunksForBatch.set(chunk.id, {
                chunks: [chunk],
                attemptCount: batch.attemptCount + 1,
                lastAttempt: failureTimestamp,
                error: failureMessage,
              });
            }

            failed += failedChunks.length;
            this.logger.recordEmbeddingError();
          }
        }

        const successfulResults = pooledResults.filter(({ chunk }) => !failedChunkIds.has(chunk.id));

        const items = successfulResults.map(({ chunk, vector }) => ({
          id: chunk.id,
          vector,
          metadata: chunk.metadata,
        }));

        if (items.length > 0) {
          store.addBatch(items);
        }

        if (successfulResults.length > 0) {
          try {
            database.upsertEmbeddingsBatch(
              successfulResults.map(({ chunk, vector }) => ({
                contentHash: chunk.contentHash,
                embedding: float32ArrayToBuffer(vector),
                chunkText: chunk.storageText,
                model: configuredProviderInfo.modelInfo.model,
              }))
            );
          } catch (dbError) {
            this.rebuildVectorStoreExcludingChunkIds(
              store,
              database,
              successfulResults.map(({ chunk }) => chunk.id)
            );
            throw dbError;
          }
        }

        for (const { chunk } of successfulResults) {
          invertedIndex.removeChunk(chunk.id);
          invertedIndex.addChunk(chunk.id, chunk.content);
          completedChunkIds.add(chunk.id);
          embeddingPartsByChunk.delete(chunk.id);
        }

        database.addChunksToBranchBatch(
          this.getBranchCatalogKey(),
          successfulResults.map(({ chunk }) => chunk.id)
        );

        this.logger.recordChunksEmbedded(successfulResults.length);

        succeeded += successfulResults.length;
        stillFailing.push(...failedChunksForBatch.values());
      } catch (error) {
        const failureMessage = getErrorMessage(error);
        const failureTimestamp = new Date().toISOString();
        const unaccountedChunks = batch.chunks.filter(
          (chunk) => !failedChunksForBatch.has(chunk.id) && !completedChunkIds.has(chunk.id)
        );

        for (const chunk of unaccountedChunks) {
          failedChunksForBatch.set(chunk.id, {
            chunks: [chunk],
            attemptCount: batch.attemptCount + 1,
            lastAttempt: failureTimestamp,
            error: failureMessage,
          });
        }

        failed += unaccountedChunks.length;
        this.logger.recordEmbeddingError();
        stillFailing.push(...coalesceFailedBatches(Array.from(failedChunksForBatch.values())));
      }
    }

    const persistedStillFailing = coalesceFailedBatches(stillFailing);

    if (roots) {
      this.saveFailedBatches([...retainedFailedBatches, ...persistedStillFailing]);
    } else {
      this.saveFailedBatches(persistedStillFailing);
    }

    if (succeeded > 0) {
      store.save();
      this.saveInvertedIndex(invertedIndex);
    }

    if (roots && succeeded > 0 && persistedStillFailing.length === 0 && this.hasProjectForceReembedPending()) {
      database.deleteMetadata(this.getProjectForceReembedMetadataKey());
      this.saveIndexMetadata(configuredProviderInfo);
      this.indexCompatibility = { compatible: true };
    }

    return { succeeded, failed, remaining: persistedStillFailing.length };
  }

  getFailedBatchesCount(): number {
    if (this.config.scope === "global") {
      return this.partitionFailedBatches(this.getScopedRoots()).scoped.length;
    }
    return this.loadFailedBatches().length;
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  getBaseBranch(): string {
    return this.baseBranch;
  }

  refreshBranchInfo(): void {
    if (isGitRepo(this.projectRoot)) {
      this.currentBranch = getBranchOrDefault(this.projectRoot);
      this.baseBranch = getBaseBranch(this.projectRoot);
    }
  }

  async getDatabaseStats(): Promise<{ embeddingCount: number; chunkCount: number; branchChunkCount: number; branchCount: number } | null> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    return database.getStats();
  }

  getLogger(): Logger {
    return this.logger;
  }

  async findSimilar(
    code: string,
    limit: number = this.config.search.maxResults,
    options?: {
      fileType?: string;
      directory?: string;
      chunkType?: string;
      excludeFile?: string;
      filterByBranch?: boolean;
    }
  ): Promise<SearchResult[]> {
    const { store, provider, database, readIssues, compatibility } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "vectors", "database");

    if (!compatibility.compatible) {
      throw new Error(
        `${compatibility.reason ?? "Index is incompatible with current embedding provider."} ` +
        `Run index_codebase with force=true to rebuild the index.`
      );
    }

    const searchStartTime = performance.now();

    if (store.count() === 0) {
      this.logger.search("debug", "Find similar on empty index");
      return [];
    }

    const filterByBranch = options?.filterByBranch ?? true;

    this.logger.search("debug", "Starting find similar", {
      codeLength: code.length,
      limit,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const { embedding, tokensUsed } = await provider.embedDocument(code);
    const embeddingMs = performance.now() - embeddingStartTime;
    this.logger.recordEmbeddingApiCall(tokensUsed);

    const vectorStartTime = performance.now();
    const semanticResults = store.search(embedding, limit * 2);
    const vectorMs = performance.now() - vectorStartTime;

    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && (this.config.scope === "global" || this.currentBranch !== "default")) {
      branchChunkIds = new Set(
        this.getBranchCatalogKeys().flatMap((branchKey) => database.getBranchChunkIds(branchKey))
      );
    }

    const prefilterStartTime = performance.now();
    const shouldPrefilterByBranch = branchChunkIds !== null && (this.config.scope === "global" || branchChunkIds.size > 0);
    const allowBranchPrefilterFallback = this.config.scope !== "global";
    const prefilteredSemantic = shouldPrefilterByBranch && branchChunkIds
      ? semanticResults.filter((r) => branchChunkIds.has(r.id))
      : semanticResults;
    const semanticCandidates = (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0)
      ? semanticResults
      : prefilteredSemantic;
    const prefilterMs = performance.now() - prefilterStartTime;

    if (this.config.scope !== "global" && branchChunkIds && branchChunkIds.size === 0) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    if (allowBranchPrefilterFallback && shouldPrefilterByBranch && semanticResults.length > 0 && prefilteredSemantic.length === 0) {
      this.logger.search("warn", "Branch prefilter produced no semantic overlap, using unfiltered semantic candidates", {
        branch: this.currentBranch,
      });
    }

    const rerankTopN = this.config.search.rerankTopN;

    const ranked = rankSemanticOnlyResults(code, semanticCandidates, {
      rerankTopN,
      limit,
      prioritizeSourcePaths: false,
    });

    const filtered = ranked.filter((r) => {
      if (r.score < this.config.search.minScore) return false;

      if (options?.excludeFile) {
        if (r.metadata.filePath === options.excludeFile) return false;
      }

      if (options?.fileType) {
        const ext = r.metadata.filePath.split(".").pop()?.toLowerCase();
        if (ext !== options.fileType.toLowerCase().replace(/^\./, "")) return false;
      }

      if (options?.directory) {
        const normalizedDir = options.directory.replace(/^\/|\/$/g, "");
        if (!r.metadata.filePath.includes(`/${normalizedDir}/`) &&
          !r.metadata.filePath.includes(`${normalizedDir}/`)) return false;
      }

      if (options?.chunkType) {
        if (r.metadata.chunkType !== options.chunkType) return false;
      }

      return true;
    }).slice(0, limit);

    const totalSearchMs = performance.now() - searchStartTime;
    this.logger.recordSearch(totalSearchMs, {
      embeddingMs,
      vectorMs,
      keywordMs: 0,
      fusionMs: 0,
    });
    this.logger.search("info", "Find similar complete", {
      codeLength: code.length,
      results: filtered.length,
      totalMs: Math.round(totalSearchMs * 100) / 100,
      embeddingMs: Math.round(embeddingMs * 100) / 100,
      vectorMs: Math.round(vectorMs * 100) / 100,
      prefilterMs: Math.round(prefilterMs * 100) / 100,
    });

    return Promise.all(
      filtered.map(async (r) => {
        let content = "";

        if (this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              r.metadata.filePath,
              "utf-8"
            );
            const lines = fileContent.split("\n");
            content = lines
              .slice(r.metadata.startLine - 1, r.metadata.endLine)
              .join("\n");
          } catch {
            content = "[File not accessible]";
          }
        }

        return {
          filePath: r.metadata.filePath,
          startLine: r.metadata.startLine,
          endLine: r.metadata.endLine,
          content,
          score: r.score,
          chunkType: r.metadata.chunkType,
          name: r.metadata.name,
          blame: blameFromMetadata(r.metadata),
        };
      })
    );
  }

  async getCallers(targetName: string, callTypeFilter?: string): Promise<CallEdgeData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const seen = new Set<string>();
    const results: CallEdgeData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      for (const edge of database.getCallersWithContext(targetName, branchKey, callTypeFilter)) {
        if (!seen.has(edge.id)) {
          seen.add(edge.id);
          results.push(edge);
        }
      }
    }

    return results;
  }

  async getCallees(symbolId: string, callTypeFilter?: string): Promise<CallEdgeData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const seen = new Set<string>();
    const results: CallEdgeData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      for (const edge of database.getCallees(symbolId, branchKey, callTypeFilter)) {
        if (!seen.has(edge.id)) {
          seen.add(edge.id);
          results.push(edge);
        }
      }
    }

    return results;
  }

  async findCallPath(fromName: string, toName: string, maxDepth?: number): Promise<PathHopData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    let shortest: PathHopData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      const path = database.findShortestPath(fromName, toName, branchKey, maxDepth);
      if (path.length > 0 && (shortest.length === 0 || path.length < shortest.length)) {
        shortest = path;
      }
    }

    return shortest;
  }

  async getSymbolsForBranch(branch?: string): Promise<SymbolData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = branch ?? this.getBranchCatalogKey();
    return database.getSymbolsForBranch(resolvedBranch);
  }

  async getSymbolsForFiles(filePaths: string[], branch?: string): Promise<SymbolData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = branch ?? this.getBranchCatalogKey();
    return database.getSymbolsForFiles(filePaths, resolvedBranch);
  }

  async getTransitiveReachability(
    rootSymbolIds: string[],
    direction: "callers" | "callees",
    maxDepth?: number
  ): Promise<ReachabilityData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const branch = this.getBranchCatalogKey();
    return database.getTransitiveReachability(rootSymbolIds, branch, direction, maxDepth);
  }

  async detectCommunities(branch?: string, symbolIds?: string[]): Promise<CommunityData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = branch ?? this.getBranchCatalogKey();
    return database.detectCommunities(resolvedBranch, symbolIds);
  }

  async computeCentrality(branch?: string): Promise<CentralityData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = branch ?? this.getBranchCatalogKey();
    return database.computeCentrality(resolvedBranch);
  }

  async getPrImpact(opts: {
    pr?: number;
    branch?: string;
    maxDepth?: number;
    hubThreshold?: number;
    checkConflicts?: boolean;
    direction?: "callers" | "callees" | "both";
  }): Promise<PrImpactResult> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const execFileAsync = promisify(execFile);

    const changedFilesResult = await getChangedFiles({
      pr: opts.pr,
      branch: opts.branch,
      projectRoot: this.projectRoot,
      baseBranch: this.baseBranch,
    });
    const changedFiles = changedFilesResult.files;
    const headRefName = changedFilesResult.headRefName;

    if (opts.pr !== undefined && headRefName === undefined) {
      throw new Error(
        `Could not resolve head branch for PR #${opts.pr}. Run index_codebase on the PR branch first.`,
      );
    }

    const resolvedBranch = opts.pr !== undefined
      ? headRefName
      : opts.branch || this.currentBranch;
    const branchKey = this.getBranchCatalogKeyFor(resolvedBranch || "default");

    const branchSymbols = database.getSymbolsForBranch(branchKey);
    if (branchSymbols.length === 0) {
      throw new Error(
        "Run index_codebase first to build the call graph and symbol index for this branch."
      );
    }

    const absoluteChangedFiles = changedFiles.map((f) => path.resolve(this.projectRoot, f));
    const directSymbols = database.getSymbolsForFiles(absoluteChangedFiles, branchKey);
    const directIds = directSymbols.map((s) => s.id);

    const direction = opts.direction ?? "both";
    const maxDepth = opts.maxDepth ?? 5;
    const transitiveCallers = database.getTransitiveReachability(
      directIds,
      branchKey,
      direction,
      maxDepth
    );

    const affectedIdsSet = new Set<string>(directIds);
    for (const caller of transitiveCallers) {
      affectedIdsSet.add(caller.symbolId);
    }
    const allAffectedIds = Array.from(affectedIdsSet);

    const communitiesData = database.detectCommunities(branchKey, allAffectedIds);
    const communityMap = new Map<string, { label: string; symbolCount: number; directSymbols: Set<string> }>();
    for (const c of communitiesData) {
      if (!communityMap.has(c.communityLabel)) {
        communityMap.set(c.communityLabel, {
          label: c.communityLabel,
          symbolCount: 0,
          directSymbols: new Set(),
        });
      }
      const entry = communityMap.get(c.communityLabel)!;
      entry.symbolCount++;
      if (directIds.includes(c.symbolId)) {
        entry.directSymbols.add(c.symbolId);
      }
    }
    const communities = Array.from(communityMap.values()).map((c) => ({
      label: c.label,
      symbolCount: c.symbolCount,
      directSymbols: Array.from(c.directSymbols),
    }));

    const centralityData = database.computeCentrality(branchKey);
    const hubThreshold = opts.hubThreshold ?? 10;
    const hubNodes = centralityData
      .filter((c) => directIds.includes(c.symbolId) && c.callerCount >= hubThreshold)
      .map((c) => ({
        id: c.symbolId,
        name: c.symbolName,
        callerCount: c.callerCount,
        filePath: c.filePath,
      }));

    const totalAffected = allAffectedIds.length;
    let riskLevel: "LOW" | "MEDIUM" | "HIGH";
    let riskReason: string;

    if (totalAffected < 5 && hubNodes.length === 0) {
      riskLevel = "LOW";
      riskReason = `Small impact: ${totalAffected} affected symbols, no hub nodes touched.`;
    } else if (totalAffected > 20 || hubNodes.length > 1) {
      riskLevel = "HIGH";
      riskReason = `Large impact: ${totalAffected} affected symbols${hubNodes.length > 0 ? `, ${hubNodes.length} hub nodes touched` : ""}.`;
    } else {
      riskLevel = "MEDIUM";
      riskReason = `Moderate impact: ${totalAffected} affected symbols${hubNodes.length === 1 ? ", 1 hub node touched" : ""}.`;
    }

    let conflictingPRs: PrImpactResult["conflictingPRs"];
    if (opts.checkConflicts) {
      conflictingPRs = [];
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "10000"],
          { cwd: this.projectRoot, timeout: 30000 }
        );
        const openPRs = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;

        const currentCommunityLabels = new Set(communities.map((c) => c.label));
        const allCommunitiesData = database.detectCommunities(branchKey);
        const symbolToCommunity = new Map<string, string>();
        const structuralKey = (filePath: string, name: string): string =>
          `${filePath.toLowerCase()}:${name.toLowerCase()}`;
        for (const c of allCommunitiesData) {
          symbolToCommunity.set(structuralKey(c.filePath, c.symbolName), c.communityLabel);
        }

        for (const openPr of openPRs) {
          if (openPr.number === opts.pr) continue;

          try {
            const otherChanged = await getChangedFiles({
              pr: openPr.number,
              projectRoot: this.projectRoot,
              baseBranch: this.baseBranch,
            });
            const otherAbsolute = otherChanged.files.map((f) => path.resolve(this.projectRoot, f));
            const otherBranchKey = this.getBranchCatalogKeyFor(openPr.headRefName);
            const otherSymbols = database.getSymbolsForFiles(otherAbsolute, otherBranchKey);
            const otherLabels = new Set<string>();
            for (const sym of otherSymbols) {
              const label = symbolToCommunity.get(structuralKey(sym.filePath, sym.name));
              if (label) {
                otherLabels.add(label);
              }
            }
            const overlapping = Array.from(otherLabels).filter((l) =>
              currentCommunityLabels.has(l)
            );
            if (overlapping.length > 0) {
              conflictingPRs.push({
                pr: openPr.number,
                branch: openPr.headRefName,
                overlappingCommunities: overlapping,
              });
            }
          } catch {
            /* skip PRs we can't analyze */
          }
        }
      } catch {
        /* gh CLI not available or failed; skip conflict detection */
      }
    }

    return {
      changedFiles,
      directSymbols: directSymbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
      })),
      transitiveCallers: transitiveCallers.map((c) => ({
        id: c.symbolId,
        name: c.symbolName,
        filePath: c.filePath,
        depth: c.depth,
      })),
      totalAffected,
      communities,
      hubNodes,
      riskLevel,
      riskReason,
      direction,
      conflictingPRs,
    };
  }

  async getVisualizationData(options?: { directory?: string }): Promise<{
    symbols: SymbolData[];
    edges: CallEdgeData[];
  }> {
    const { database, store, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "vectors", "database");
    const seenSymbols = new Map<string, SymbolData>();
    const seenEdges = new Map<string, CallEdgeData>();

    for (const branchKey of this.getBranchCatalogKeys()) {
      // Get all symbol IDs on this branch
      const symbolIds = database.getBranchSymbolIds(branchKey);
      const symbolIdSet = new Set(symbolIds);

      // Get unique file paths from branch chunks' metadata
      const chunkIds = database.getBranchChunkIds(branchKey);
      const metadataMap = chunkIds.length > 0 ? store.getMetadataBatch(chunkIds) : new Map<string, import("../native/index.js").ChunkMetadata>();
      const filePaths = new Set<string>();
      for (const [, meta] of metadataMap) {
        if (meta.filePath) filePaths.add(meta.filePath);
      }

      const directory = options?.directory?.replace(/\/$/, "");
      const absoluteDirectoryFilter = directory
        ? path.resolve(this.projectRoot, directory)
        : undefined;

      // Gather symbols from each file
      for (const filePath of filePaths) {
        if (directory) {
          const absoluteFilePath = path.resolve(filePath);
          const matchesRelative = filePath === directory || filePath.startsWith(directory + "/");
          const matchesProjectRelative = absoluteDirectoryFilter !== undefined && (
            absoluteFilePath === absoluteDirectoryFilter || absoluteFilePath.startsWith(absoluteDirectoryFilter + path.sep)
          );
          if (!matchesRelative && !matchesProjectRelative) {
            continue;
          }
        }
        for (const sym of database.getSymbolsByFile(filePath)) {
          if (symbolIdSet.has(sym.id) && !seenSymbols.has(sym.id)) {
            seenSymbols.set(sym.id, sym);
          }
        }
      }

      // Gather edges from each symbol
      for (const symbolId of seenSymbols.keys()) {
        for (const edge of database.getCallees(symbolId, branchKey)) {
          if (!seenEdges.has(edge.id)) {
            seenEdges.set(edge.id, edge);
          }
        }
      }
    }

    return { symbols: [...seenSymbols.values()], edges: [...seenEdges.values()] };
  }

  async close(): Promise<void> {
    this.database?.close();
    for (const database of this.retiredDatabases) {
      database.close();
    }
    this.retiredDatabases = [];
    this.database = null;
    this.store = null;
    this.invertedIndex = null;
    this.provider = null;
    this.reranker = null;
    this.configuredProviderInfo = null;
    this.indexCompatibility = null;
    this.initializationMode = "none";
    this.readIssues = [];
    this.readerArtifactFingerprint = null;
    this.writerArtifactFingerprint = null;
    this.readerArtifactRetryAfter.clear();
  }
}
