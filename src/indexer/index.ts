import { existsSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync, promises as fsPromises } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { execFile } from "child_process";
import { promisify } from "util";
import PQueue from "p-queue";
import pRetry from "p-retry";

import { type EmbeddingBatchConfig, ParsedCodebaseIndexConfig, type RerankerConfig } from "../config/schema.js";
import { detectEmbeddingProvider, ConfiguredProviderInfo, tryDetectProvider, createCustomProviderInfo } from "../embeddings/detector.js";
import {
  createEmbeddingProvider,
  EmbeddingProviderInterface,
  CustomProviderNonRetryableError,
} from "../embeddings/provider.js";
import { collectFiles, isExcludedByPatterns, type SkippedFile } from "../utils/files.js";
import { createCostEstimate, CostEstimate, DryRunEstimate } from "../utils/cost.js";
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
  hashFile,
  hashContent,
  extractCalls,
  parseFileAsText,
  estimateTokens,
} from "../native/index.js";
import type { ParsedFile, SymbolData, CallEdgeData, PathHopData, ReachabilityData, CommunityData, CommunityCouplingData, CentralityData } from "../native/index.js";
import { getBranchOrDefault, getBaseBranch, isGitRepo } from "../git/index.js";
import { isFullGitCommit, resolveLocalGitCommit, withMaterializedBranch } from "../git/branch-materialization.js";
import type { HostMode } from "../config/host.js";
import { isProjectIndexPathOwnedByProject, resolveProjectIndexPath } from "../config/paths.js";
import { getChangedFiles } from "../tools/changed-files.js";
import type { PrImpactResult } from "./pr-impact-types.js";
import { getChunkGitBlame, type GitBlameMetadata } from "./git-blame.js";
import { analyzeQueryIntent } from "./intent-aware-ranking.js";
import {
  applyCommunityBoost,
  classifyQueryIntentRaw,
  diversifyCandidatesByFile,
  rankHybridResults,
  rankSemanticOnlyResults,
  type RankedCandidate,
} from "./search-ranking.js";
export {
  applyCommunityBoost,
  fuseResultsRrf,
  fuseResultsWeighted,
  rankHybridResults,
  rankSemanticOnlyResults,
  rerankResults,
} from "./search-ranking.js";
import { inferExactSymbolFromQuery } from "../tools/symbol-inference.js";
import { CALL_GRAPH_SYMBOL_CHUNK_TYPES } from "./call-graph-constants.js";
export { CALL_GRAPH_SYMBOL_CHUNK_TYPES } from "./call-graph-constants.js";
import {
  buildDeterministicIdentifierPass,
  buildIdentifierDefinitionLane,
  classifyExternalRerankBand,
  extractCodeTermHints,
  extractFilePathHint,
  extractIdentifierHints,
  extractPrimaryIdentifierQueryHint,
  isImplementationChunkType,
  isLikelyImplementationPath,
  pathMatchesHint,
  splitPathTokens,
  stripFilePathHint,
  tokenizeTextForRanking,
  type ExternalRerankBand,
} from "./definition-ranking.js";
export { extractFilePathHint, stripFilePathHint } from "./definition-ranking.js";
import {
  acquireIndexLock,
  completeLeaseRecovery,
  createLeaseTemporaryPath,
  recoverLeaseArtifacts,
  releaseIndexLock,
  removeLeaseTemporaryPath,
  setIndexLockClearRecoveryState,
  type IndexLockClearRecoveryState,
  type IndexLockLease,
  type IndexLockOwner,
  type IndexMutationOperation,
} from "./index-lock.js";
import {
  type PendingChunk,
  type SerializedFailedBatch,
  createPendingChunkStorageText,
  createPendingEmbeddingRequestBatches,
  getPendingChunkFilePath,
  getUniquePendingChunksFromRequests,
  hasAllEmbeddingParts,
  normalizeFailedBatch,
  poolEmbeddingVectors,
} from "./embedding-batches.js";
import {
  createFailedBatchWriter,
  readFailedBatchRecords,
  writeFailedBatchRecords,
  type FailedBatchRecordInput,
  type FailedBatchWriter,
} from "./failed-state-persistence.js";
import { iterateOrderedFileBatches, type FileBatchLimits } from "./file-batches.js";
import { canonicalizePathForComparison } from "../utils/canonical-path.js";
import { summarizeCallGraphCoverage, type CallGraphCoverage } from "./call-graph-coverage.js";
import { createGoDirectCallClassifier, isGoFilePath } from "./go-package-resolution.js";
import {
  getLocalWorkspacePackageManifestPaths,
  getLocalWorkspacePackages,
  isJavaScriptFamilyFilePath,
  LocalModuleCallResolver,
  TsConfigPathAliasCache,
} from "./local-module-resolution.js";

export const CALL_GRAPH_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "python", "go", "rust", "swift", "php", "apex", "zig", "gdscript", "matlab", "bash", "c", "cpp", "metal"]);
// Languages whose identifiers are case-insensitive at the language level.
// The Rust call_extractor lowercases callee names for these languages (except
// constructors and imports), so same-file resolution in this file must use
// the same normalization when looking up symbols by name. Keep this set in
// sync with the matching branch in native/src/call_extractor.rs.
export const CASE_INSENSITIVE_LANGUAGES = new Set(["apex", "php"]);

function candidateOverlapsSymbol(candidate: RankedCandidate, symbol: SymbolData): boolean {
  return candidate.metadata.filePath === symbol.filePath &&
    candidate.metadata.startLine <= symbol.endLine &&
    candidate.metadata.endLine >= symbol.startLine;
}

function resolveSameCommunityCandidateIds(
  query: string,
  candidates: RankedCandidate[],
  database: Database,
  branchCatalogKeys: string[],
): Set<string> {
  const anchorName = inferExactSymbolFromQuery(query);
  if (!anchorName || candidates.length === 0) {
    return new Set();
  }

  const catalogs = branchCatalogKeys.map((branchKey) => ({
    branchKey,
    symbols: database.getSymbolsForBranch(branchKey),
  }));
  const exactAnchors = catalogs.flatMap(({ branchKey, symbols }) => symbols
    .filter((symbol) => symbol.name === anchorName)
    .map((symbol) => ({ branchKey, symbol })));
  const anchors = exactAnchors.length > 0
    ? exactAnchors
    : catalogs.flatMap(({ branchKey, symbols }) => symbols
      .filter((symbol) => symbol.name.toLowerCase() === anchorName.toLowerCase())
      .map((symbol) => ({ branchKey, symbol })));

  const uniqueAnchors = new Map(anchors.map((anchor) => [anchor.symbol.id, anchor]));
  if (uniqueAnchors.size !== 1) {
    return new Set();
  }

  const anchor = uniqueAnchors.values().next().value as { branchKey: string; symbol: SymbolData };
  const branchSymbols = catalogs.find((catalog) => catalog.branchKey === anchor.branchKey)?.symbols ?? [];
  const candidateSymbols = branchSymbols.filter((symbol) =>
    candidates.some((candidate) => candidateOverlapsSymbol(candidate, symbol))
  );
  const assignments = database.detectCommunities(
    anchor.branchKey,
    [anchor.symbol.id, ...candidateSymbols.map((symbol) => symbol.id)],
  );
  const anchorCommunity = assignments.find((assignment) => assignment.symbolId === anchor.symbol.id)?.communityId;
  if (anchorCommunity === undefined) {
    return new Set();
  }

  const sameCommunitySymbolIds = new Set(assignments
    .filter((assignment) => assignment.communityId === anchorCommunity)
    .map((assignment) => assignment.symbolId));

  return new Set(candidates
    .filter((candidate) => candidateSymbols.some((symbol) =>
      sameCommunitySymbolIds.has(symbol.id) && candidateOverlapsSymbol(candidate, symbol)
    ))
    .map((candidate) => candidate.id));
}
// Existing indexes without this metadata are the implicit version 1.
const CALL_GRAPH_RESOLUTION_VERSION = "9";
const PHP_FUNCTION_SYMBOL_CHUNK_TYPES = new Set([
  "function_declaration",
  "function",
  "function_definition",
]);
const PHP_CLASS_SYMBOL_CHUNK_TYPES = new Set([
  "class_declaration",
  "class_definition",
]);
const C_FAMILY_TYPE_SYMBOL_CHUNK_TYPES = new Set(["class_specifier", "struct_specifier"]);

function isCompatibleCFamilyCallTarget(
  language: string,
  callType: string,
  symbolKind: string,
): boolean {
  if (language !== "c" && language !== "cpp") return true;
  if (symbolKind === "namespace_definition") return callType === "Import";
  const isTypeSymbol = C_FAMILY_TYPE_SYMBOL_CHUNK_TYPES.has(symbolKind);
  if (callType === "Constructor" || callType === "Inherits" || callType === "Implements") {
    return isTypeSymbol;
  }
  return !isTypeSymbol;
}

const EXECUTABLE_SYMBOL_CHUNK_TYPES = new Set([
  "function_declaration",
  "function",
  "arrow_function",
  "method_definition",
  "function_definition",
  "method_declaration",
  "function_item",
  "protocol_function_declaration",
  "init_declaration",
  "deinit_declaration",
  "subscript_declaration",
  "constructor_definition",
  "trigger_declaration",
  "test_declaration",
]);

// A type and its methods often cover the same lines. The shortest range is the
// most precise symbol to own an edge. For equal ranges, executable symbols are
// more specific than container types.
export function findEnclosingSymbol(
  symbols: readonly SymbolData[],
  line: number,
  column?: number,
): SymbolData | undefined {
  let best: SymbolData | undefined;

  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (
      column !== undefined &&
      ((line === symbol.startLine && column < symbol.startCol) ||
        (line === symbol.endLine && column >= symbol.endCol))
    ) {
      continue;
    }
    if (!best) {
      best = symbol;
      continue;
    }

    const span = symbol.endLine - symbol.startLine;
    const bestSpan = best.endLine - best.startLine;
    const isNarrowerPositionRange = column !== undefined &&
      span === bestSpan &&
      symbol.startLine === best.startLine &&
      symbol.endLine === best.endLine &&
      symbol.startCol >= best.startCol &&
      symbol.endCol <= best.endCol &&
      (symbol.startCol > best.startCol || symbol.endCol < best.endCol);
    const isMoreSpecificTie = span === bestSpan &&
      symbol.startLine === best.startLine &&
      EXECUTABLE_SYMBOL_CHUNK_TYPES.has(symbol.kind) &&
      !EXECUTABLE_SYMBOL_CHUNK_TYPES.has(best.kind);
    if (
      span < bestSpan ||
      (span === bestSpan && symbol.startLine > best.startLine) ||
      isNarrowerPositionRange ||
      isMoreSpecificTie
    ) {
      best = symbol;
    }
  }

  return best;
}

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

// Ollama default batch caps. maxBatchItems is the count limiter; maxBatchTokens is a
// request size/time guard (ollama encodes each input independently, so the per-batch
// token sum is not bounded by the model context). 65536 allows the default 16 items
// (each input is split to <= ~1536 tokens) and is overridable via embedding.batch.
// 16 (not 32) bounds the in-flight workload: ollama concurrency is fixed at 5, so the
// worst case is 5 concurrent batches * 16 inputs (~80 texts) rather than 160.
const DEFAULT_OLLAMA_MAX_BATCH_ITEMS = 16;
const DEFAULT_OLLAMA_MAX_BATCH_TOKENS = 65_536;

export function getDynamicBatchOptions(
  provider: ConfiguredProviderInfo,
  embeddingBatch?: EmbeddingBatchConfig,
): { maxBatchTokens?: number; maxBatchItems?: number } {
  // embedding.batch.* is documented as ollama-only. Non-ollama providers keep
  // their existing (unbatched-by-this-layer) behavior, so return an empty
  // options object regardless of any user-supplied batch config.
  if (provider.provider !== "ollama") {
    return {};
  }
  const base = { maxBatchTokens: DEFAULT_OLLAMA_MAX_BATCH_TOKENS, maxBatchItems: DEFAULT_OLLAMA_MAX_BATCH_ITEMS };
  return {
    ...base,
    ...(typeof embeddingBatch?.maxBatchTokens === "number" && Number.isFinite(embeddingBatch.maxBatchTokens) ? { maxBatchTokens: embeddingBatch.maxBatchTokens } : {}),
    ...(typeof embeddingBatch?.maxBatchItems === "number" && Number.isFinite(embeddingBatch.maxBatchItems) ? { maxBatchItems: embeddingBatch.maxBatchItems } : {}),
  };
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

export interface IndexerRuntimeOptions {
  materializedProjectRoot?: string;
  branchName?: string;
  catalogIdentity?: string;
  expectedCommit?: string;
  indexPath?: string;
  /** Internal test and benchmark override. Production uses the fixed limits. */
  fileBatchLimits?: FileBatchLimits;
  /** Internal test and benchmark override. Production uses a fixed default. */
  checkpointIntervalChunks?: number;
}

export interface BranchIndexResult {
  prepared: boolean;
  stats?: IndexStats;
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

interface CandidateSnapshot {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string;
}

export interface SearchTrace {
  semanticCandidates: CandidateSnapshot[];
  keywordCandidates: CandidateSnapshot[];
  hybridCandidates: CandidateSnapshot[];
  postExternalRerankCandidates: CandidateSnapshot[];
  tieredCandidates: CandidateSnapshot[];
  finalCandidates: CandidateSnapshot[];
}

interface SearchOptions {
  hybridWeight?: number;
  fileType?: string;
  directory?: string;
  chunkType?: string;
  contextLines?: number;
  filterByBranch?: boolean;
  metadataOnly?: boolean;
  definitionIntent?: boolean;
  /** Soft ranking preference for context retrieval. Unlike definitionIntent, this never filters candidates. */
  prioritizeSourcePaths?: boolean;
  blameAuthor?: string;
  blameSha?: string;
  blameSince?: string;
  blameUntil?: string;
  trace?: (trace: SearchTrace) => void;
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

export type IndexFreshnessReason =
  | "current"
  | "missing"
  | "unreadable"
  | "incompatible"
  | "failed-batches"
  | "files-changed"
  | "metadata-changed"
  | "branch-changed"
  | "migration-required";

export interface IndexFreshnessResult {
  readable: boolean;
  current: boolean;
  reason: IndexFreshnessReason;
}

interface LocalModuleResolutionState {
  configHash: string;
  pathAliasCache: TsConfigPathAliasCache;
  workspacePackages: ReturnType<typeof getLocalWorkspacePackages>;
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

interface ChangedFileDescriptor {
  storedPath: string;
  materializedPath: string;
  hash: string;
  sourceBytes: number;
}

interface RetryableFailedChunkRecord {
  chunk: PendingChunk;
  attemptCount: number;
}

interface FailedChunkRecordMetadata {
  attemptCount: number;
  error: string;
  lastAttempt: string;
  chunks: unknown[];
}

interface FailedBatchWriteState {
  writer: FailedBatchWriter<unknown>;
  recordsWritten: number;
}

interface FailedBatchProcessingState {
  state: FailedBatchWriteState;
  latestById: Map<string, FailedChunkRecordMetadata>;
  materializedRetryIds: Set<string>;
  discardedExistingRecords: boolean;
}

interface EmbeddingRateLimitState {
  backoffMs: number;
}

interface PendingChunkBatchResult {
  indexedChunks: number;
  failedChunks: number;
  tokensUsed: number;
  failedChunkIds: Set<string>;
}

function getFailedBatchGroupKey(record: Pick<SerializedFailedBatch, "error" | "attemptCount" | "lastAttempt">): string {
  return `${record.attemptCount}:${record.lastAttempt}:${record.error}`;
}

function getPendingChunkId(rawChunk: unknown): string | null {
  if (!rawChunk || typeof rawChunk !== "object") {
    return null;
  }
  const id = (rawChunk as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

type SearchFilterOptions = {
  fileType?: string;
  directory?: string;
  chunkType?: string;
  blameAuthor?: string;
  blameSha?: string;
  blameSince?: string;
  blameUntil?: string;
};

function parseBlameTimestamp(value: string, endOfDay: boolean): number | null {
  let timestampMs = Date.parse(value);
  if (Number.isNaN(timestampMs)) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    timestampMs += 24 * 60 * 60 * 1000 - 1;
  }
  return Math.floor(timestampMs / 1000);
}

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

interface IndexMetadata {
  indexVersion: string;
  pathStorageVersion: string;
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
  PATH_STORAGE_MISMATCH = "PATH_STORAGE_MISMATCH",
}

interface IndexCompatibility {
  compatible: boolean;
  code?: IncompatibilityCode;
  reason?: string;
  storedMetadata?: IndexMetadata;
}

const INDEX_METADATA_VERSION = "1";
const PROJECT_PATH_STORAGE_VERSION = "2";
const GLOBAL_PATH_STORAGE_VERSION = "1";
const EMBEDDING_STRATEGY_VERSION = "2";
const SWIFT_PARSER_VERSION = "1";
const METAL_PARSER_VERSION = "1";
const SYMBOL_EXTRACTOR_VERSION = "1";

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootPath);
  return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}${path.sep}`);
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

export function buildSymbolDefinitionLane(
  query: string,
  database: Database,
  branchChunkIds: Set<string> | null,
  branchSymbolIds: Set<string> | null,
  limit: number,
  fallbackCandidates: RankedCandidate[],
  prioritizeSourcePaths: boolean = classifyQueryIntentRaw(query) === "source",
  allowNonSourcePaths: boolean = false,
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
  ): boolean => {
    if (branchChunkIds && !branchChunkIds.has(chunk.chunkId)) {
      return false;
    }

    const chunkType = (chunk.nodeType ?? "other") as ChunkMetadata["chunkType"];
    if (!isImplementationChunkType(chunkType)) {
      return false;
    }

    if (!allowNonSourcePaths && !isLikelyImplementationPath(chunk.filePath)) {
      return false;
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
    return true;
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
      if (branchSymbolIds && !branchSymbolIds.has(symbol.id)) {
        continue;
      }
      if (filePathHint && !pathMatchesHint(symbol.filePath, filePathHint)) {
        continue;
      }

      const chunks = database.getChunksByFile(symbol.filePath);
      let foundCoveringChunk = false;
      for (const chunk of chunks) {
        if (chunk.startLine > symbol.startLine || chunk.endLine < symbol.endLine) {
          continue;
        }

        const chunkName = (chunk.name ?? "").toLowerCase();
        const symbolName = symbol.name.toLowerCase();
        if (chunkName !== symbolName && chunkName.replace(/_/g, "") !== symbolName.replace(/_/g, "")) {
          continue;
        }

        foundCoveringChunk = upsertChunkCandidate(chunk, identifier, normalizedIdentifier) || foundCoveringChunk;
      }

      if (foundCoveringChunk || (!allowNonSourcePaths && !isLikelyImplementationPath(symbol.filePath))) {
        continue;
      }

      const symbolName = symbol.name.toLowerCase();
      const exactName =
        symbolName === identifier ||
        symbolName.replace(/_/g, "") === normalizedIdentifier;
      const score = exactName ? 0.99 : 0.88;
      const existing = symbolCandidates.get(symbol.id);
      if (!existing || score > existing.score) {
        symbolCandidates.set(symbol.id, {
          id: symbol.id,
          score,
          metadata: {
            filePath: symbol.filePath,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            chunkType: symbol.kind as ChunkMetadata["chunkType"],
            name: symbol.name,
            language: symbol.language,
            hash: symbol.id,
          },
        });
      }
    }

    const dedupChunksByName = new Map<string, typeof chunksByName[number]>();
    for (const chunk of chunksByName) {
      dedupChunksByName.set(chunk.chunkId, chunk);
    }

    for (const chunk of dedupChunksByName.values()) {
      if (filePathHint && !pathMatchesHint(chunk.filePath, filePathHint)) {
        continue;
      }
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
      (allowNonSourcePaths || isLikelyImplementationPath(candidate.metadata.filePath))
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

export function selectIndexableChunks<T extends { chunkType: string }>(
  chunks: T[],
  limit: number,
  semanticOnly: boolean,
): T[] {
  const indexableChunks = semanticOnly
    ? chunks.filter((chunk) => chunk.chunkType !== "other")
    : chunks;
  return selectChunksWithFileCoverage(indexableChunks, limit);
}

function matchesHardSearchFilters(
  candidate: RankedCandidate,
  options: SearchFilterOptions | undefined,
  projectRoot: string,
): boolean {
  if (options?.fileType) {
    const ext = candidate.metadata.filePath.split(".").pop()?.toLowerCase();
    const requestedExtension = options.fileType.trim().toLowerCase().replace(/^\./, "");
    if (ext !== requestedExtension) return false;
  }

  if (options?.directory) {
    const candidatePath = canonicalizePathForComparison(
      path.resolve(projectRoot, candidate.metadata.filePath.replace(/\\/g, path.sep)),
    );
    const directoryPath = canonicalizePathForComparison(
      path.resolve(projectRoot, options.directory.trim().replace(/\\/g, path.sep)),
    );
    if (!isPathWithinRoot(candidatePath, directoryPath)) return false;
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
    const since = parseBlameTimestamp(options.blameSince, false);
    if (since === null) return false;
    const committedAt = candidate.metadata.blameCommittedAt;
    if (committedAt === undefined || committedAt < since) return false;
  }

  if (options?.blameUntil) {
    const until = parseBlameTimestamp(options.blameUntil, true);
    if (until === null) return false;
    const committedAt = candidate.metadata.blameCommittedAt;
    if (committedAt === undefined || committedAt > until) return false;
  }

  return true;
}

function matchesSearchFilters(
  candidate: RankedCandidate,
  options: SearchFilterOptions | undefined,
  minScore: number,
  projectRoot: string,
): boolean {
  return candidate.score >= minScore && matchesHardSearchFilters(candidate, options, projectRoot);
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
  private readonly materializedProjectRoot: string;
  private readonly branchNameOverride: string | undefined;
  private readonly catalogIdentityOverride: string | undefined;
  private readonly expectedCommitOverride: string | undefined;
  private readonly indexPathOverride: string | undefined;
  private readonly projectIdentityHash: string;
  private indexPath: string;
  private store: VectorStore | null = null;
  private invertedIndex: InvertedIndex | null = null;
  private database: Database | null = null;
  private provider: EmbeddingProviderInterface | null = null;
  private configuredProviderInfo: ConfiguredProviderInfo | null = null;
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
  private readonly fileBatchLimits?: FileBatchLimits;
  private readonly checkpointIntervalChunks?: number;
  private localModuleResolutionConfigHash: string | null = null;

  constructor(
    projectRoot: string,
    config: ParsedCodebaseIndexConfig,
    host: HostMode,
    runtimeOptions: IndexerRuntimeOptions = {},
  ) {
    this.projectRoot = projectRoot;
    this.projectIdentityHash = this.getProjectIdentityHash(projectRoot);
    this.materializedProjectRoot = runtimeOptions.materializedProjectRoot ?? projectRoot;
    this.branchNameOverride = runtimeOptions.branchName;
    this.catalogIdentityOverride = runtimeOptions.catalogIdentity;
    if (runtimeOptions.expectedCommit !== undefined && !isFullGitCommit(runtimeOptions.expectedCommit)) {
      throw new Error(`Expected Git commit is invalid: ${JSON.stringify(runtimeOptions.expectedCommit)}`);
    }
    this.expectedCommitOverride = runtimeOptions.expectedCommit?.toLowerCase();
    this.indexPathOverride = runtimeOptions.indexPath;
    this.fileBatchLimits = runtimeOptions.fileBatchLimits;
    this.checkpointIntervalChunks = runtimeOptions.checkpointIntervalChunks;
    this.config = config;
    this.host = host;
    if (isGitRepo(this.materializedProjectRoot)) {
      this.currentBranch = this.branchNameOverride ?? getBranchOrDefault(this.materializedProjectRoot);
      this.baseBranch = getBaseBranch(this.materializedProjectRoot);
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
    }
    this.indexPath = this.getIndexPath();
    this.refreshRuntimeArtifactPaths();
    this.logger = initializeLogger(config.debug);
  }

  private getIndexPath(): string {
    return this.indexPathOverride ?? resolveProjectIndexPath(this.projectRoot, this.config.scope, this.host);
  }

  private toCanonicalFilePath(filePath: string): string {
    if (!path.isAbsolute(filePath)) {
      return this.resolveStoredFilePath(filePath, this.projectRoot);
    }
    if (
      path.resolve(this.materializedProjectRoot) === path.resolve(this.projectRoot)
      || !isPathWithinRoot(filePath, this.materializedProjectRoot)
    ) {
      return filePath;
    }
    return path.resolve(this.projectRoot, path.relative(this.materializedProjectRoot, filePath));
  }

  private toStoredFilePath(filePath: string): string {
    const canonicalFilePath = this.toCanonicalFilePath(filePath);
    if (
      this.config.scope !== "project"
      || !isPathWithinRoot(canonicalFilePath, this.projectRoot)
    ) {
      return canonicalFilePath;
    }

    return path.relative(this.projectRoot, canonicalFilePath).split(path.sep).join("/");
  }

  private isStoredPathExcluded(storedPath: string): boolean {
    let matchPath = storedPath.split(path.sep).join("/");
    if (path.isAbsolute(storedPath)) {
      const relativePath = path.relative(this.projectRoot, storedPath).split(path.sep).join("/");
      // Knowledge-base files live outside the project. A `../` prefix would
      // false-match hidden-file globs such as **/.*/** because `..` starts with a dot.
      // Glob-matching the raw absolute path has the same problem: default **/.*/**
      // would treat a hidden parent such as /Users/me/.work/project as excluded.
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return false;
      }
      matchPath = relativePath;
    }
    return isExcludedByPatterns(matchPath, this.config.exclude);
  }

  private resolveStoredFilePath(filePath: string, rootPath = this.projectRoot): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    const resolvedPath = path.resolve(rootPath, ...filePath.split("/"));
    if (!isPathWithinRoot(resolvedPath, rootPath)) {
      throw new Error(`Stored project path escapes project root: ${JSON.stringify(filePath)}`);
    }
    return resolvedPath;
  }

  private getCanonicalStoredFilePath(filePath: string): string {
    return this.getCanonicalPath(this.resolveStoredFilePath(filePath));
  }

  private resolveFilePathRecord<T extends { filePath: string }>(record: T): T {
    return {
      ...record,
      filePath: this.resolveStoredFilePath(record.filePath),
    };
  }

  private resolveCallEdgeFilePath(edge: CallEdgeData): CallEdgeData {
    if (!edge.fromSymbolFilePath) return edge;
    return {
      ...edge,
      fromSymbolFilePath: this.resolveStoredFilePath(edge.fromSymbolFilePath),
    };
  }

  private toMaterializedFilePath(filePath: string): string {
    const storedFilePath = this.toStoredFilePath(filePath);
    if (path.isAbsolute(storedFilePath)) {
      return storedFilePath;
    }
    return this.resolveStoredFilePath(storedFilePath, this.materializedProjectRoot);
  }

  private getPreparedBranchNamespace(): string | null {
    if (!this.branchNameOverride && !this.catalogIdentityOverride) return null;
    return hashContent(this.getBranchCatalogKey()).slice(0, 16);
  }

  private getRuntimeArtifactNamespace(): string | null {
    if (this.config.scope !== "project" || this.getBranchCatalogIdentity() === "default") {
      return this.getPreparedBranchNamespace();
    }
    return hashContent(this.getBranchCatalogKey()).slice(0, 16);
  }

  private getRuntimeArtifactPath(fileName: string): string {
    const namespace = this.getRuntimeArtifactNamespace();
    if (!namespace) return path.join(this.indexPath, fileName);
    const extension = path.extname(fileName);
    const baseName = fileName.slice(0, fileName.length - extension.length);
    return path.join(this.indexPath, `${baseName}.${namespace}${extension}`);
  }

  private refreshRuntimeArtifactPaths(): void {
    this.fileHashCachePath = this.getRuntimeArtifactPath("file-hashes.json");
    this.failedBatchesPath = this.getRuntimeArtifactPath("failed-batches.json");
  }

  private buildCallGraphSymbols(parsed: ParsedFile, sourceHash: string): SymbolData[] {
    const preparedNamespace = this.getPreparedBranchNamespace();
    return parsed.symbols
      .filter((parsedSymbol) => CALL_GRAPH_SYMBOL_CHUNK_TYPES.has(parsedSymbol.kind))
      .map((parsedSymbol) => {
        const symbolId = `sym_${hashContent(
          (preparedNamespace ? `${preparedNamespace}:` : "")
          + parsed.path + ":" + parsedSymbol.name + ":" + parsedSymbol.kind + ":"
          + parsedSymbol.startLine + ":" + parsedSymbol.startCol + ":" + sourceHash,
        ).slice(0, 16)}`;
        return {
          id: symbolId,
          filePath: parsed.path,
          name: parsedSymbol.name,
          kind: parsedSymbol.kind,
          startLine: parsedSymbol.startLine,
          startCol: parsedSymbol.startCol,
          endLine: parsedSymbol.endLine,
          endCol: parsedSymbol.endCol,
          language: parsedSymbol.language,
        };
      });
  }

  private getPreparedChunkId(chunkId: string): string {
    const namespace = this.getPreparedBranchNamespace();
    return namespace ? `${chunkId}_${namespace}` : chunkId;
  }

  private getMaterializedKnowledgeBases(): string[] {
    const canonicalProjectRoot = this.getCanonicalPath(this.projectRoot);
    return this.config.knowledgeBases.map((knowledgeBase) => {
      const configuredPath = path.isAbsolute(knowledgeBase)
        ? knowledgeBase
        : path.resolve(this.projectRoot, knowledgeBase);
      const canonicalPath = this.getCanonicalPath(configuredPath);
      if (!isPathWithinRoot(canonicalPath, canonicalProjectRoot)) {
        return canonicalPath;
      }
      return path.resolve(
        this.materializedProjectRoot,
        path.relative(canonicalProjectRoot, canonicalPath),
      );
    });
  }

  private getCanonicalPath(targetPath: string): string {
    try {
      return canonicalizePathForComparison(targetPath);
    } catch {
      return path.resolve(targetPath);
    }
  }

  private getProjectIdentityHash(projectRoot: string): string {
    return hashContent(this.getCanonicalPath(projectRoot)).slice(0, 16);
  }

  private isProjectOwnedIndexPath(): boolean {
    return isProjectIndexPathOwnedByProject(this.projectRoot, this.indexPath, this.host);
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
    this.refreshBranchInfo();
    const lease = acquireIndexLock(this.indexPath, operation, {
      projectRoot: this.projectRoot,
      scopedRoots: this.getScopedRoots(),
    });
    this.indexPath = lease.canonicalIndexPath;
    this.refreshRuntimeArtifactPaths();
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
      this.fileHashCache = new Map();
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

  private getScopedRoots(projectRoot = this.projectRoot): string[] {
    const roots = new Set<string>([this.getCanonicalPath(projectRoot)]);

    for (const kbRoot of this.config.knowledgeBases) {
      roots.add(this.getCanonicalPath(path.resolve(projectRoot, kbRoot)));
    }

    return Array.from(roots);
  }

  private getBranchCatalogKey(): string {
    return this.getBranchCatalogKeyFor(this.getBranchCatalogIdentity());
  }

  private getBranchCatalogIdentity(): string {
    return (this.catalogIdentityOverride
      ?? this.branchNameOverride
      ?? this.currentBranch)
      || "default";
  }

  private getBranchCatalogKeyFor(branchName: string): string {
    if (this.config.scope !== "global") {
      return branchName;
    }

    return `${this.projectIdentityHash}:${branchName}`;
  }

  private resolveBranchCatalogKey(branchName?: string): string {
    return branchName === undefined
      ? this.getBranchCatalogKey()
      : this.getBranchCatalogKeyFor(branchName);
  }

  private getBranchCommitMetadataKey(catalogIdentity = this.getBranchCatalogIdentity()): string {
    const branchKey = this.getBranchCatalogKeyFor(catalogIdentity);
    return `index.branchCommit.${hashContent(branchKey).slice(0, 24)}`;
  }

  private getBranchCommitMetadataKeyForCatalogKey(branchKey: string): string {
    return `index.branchCommit.${hashContent(branchKey).slice(0, 24)}`;
  }

  private getStoredBranchCommit(database: Database, catalogIdentity = this.getBranchCatalogIdentity()): string | null {
    return database.getMetadata(this.getBranchCommitMetadataKey(catalogIdentity));
  }

  private saveBranchCommit(database: Database, commit: string | null): void {
    const metadataKey = this.getBranchCommitMetadataKey();
    if (commit) {
      database.setMetadata(metadataKey, commit);
    } else {
      database.deleteMetadata(metadataKey);
    }
  }

  private deleteBranchCommitMetadata(database: Database, branchKeys: readonly string[]): void {
    for (const branchKey of new Set(branchKeys)) {
      database.deleteMetadata(this.getBranchCommitMetadataKeyForCatalogKey(branchKey));
    }
  }

  private replaceBranchCatalog(
    store: VectorStore,
    invertedIndex: InvertedIndex,
    database: Database,
    branchCatalogKey: string,
    previousChunkIds: readonly string[],
    currentChunkIds: readonly string[],
    previousSymbolIds: readonly string[],
    currentSymbolIds: readonly string[],
  ): boolean {
    database.clearBranch(branchCatalogKey);
    database.addChunksToBranchBatch(branchCatalogKey, [...currentChunkIds]);
    database.clearBranchSymbols(branchCatalogKey);
    database.addSymbolsToBranchBatch(branchCatalogKey, [...currentSymbolIds]);

    const currentChunkIdSet = new Set(currentChunkIds);
    const removedChunkCandidates = previousChunkIds.filter((chunkId) => !currentChunkIdSet.has(chunkId));
    const referencedChunkIds = new Set(database.getReferencedChunkIds(removedChunkCandidates));
    const removableChunkIds = removedChunkCandidates.filter((chunkId) => !referencedChunkIds.has(chunkId));
    if (removableChunkIds.length > 0) {
      this.rebuildVectorStoreExcludingChunkIds(store, database, removableChunkIds);
      for (const chunkId of removableChunkIds) {
        invertedIndex.removeChunk(chunkId);
      }
      database.deleteChunksByIds(removableChunkIds);
    }

    const currentSymbolIdSet = new Set(currentSymbolIds);
    const removedSymbolCandidates = previousSymbolIds.filter((symbolId) => !currentSymbolIdSet.has(symbolId));
    const referencedSymbolIds = new Set(database.getReferencedSymbolIds(removedSymbolCandidates));
    const removableSymbolIds = removedSymbolCandidates.filter((symbolId) => !referencedSymbolIds.has(symbolId));
    database.clearCallEdgeTargetsForSymbols(removableSymbolIds);
    database.gcOrphanSymbols();
    database.gcOrphanCallEdges();
    database.gcOrphanEmbeddings();

    return removableChunkIds.length > 0;
  }

  private getLegacyBranchCatalogKey(): string {
    return this.currentBranch || "default";
  }

  private getLegacyMigrationMetadataKey(projectIdentityHash = this.projectIdentityHash): string {
    return `index.globalBranchMigration.${projectIdentityHash}`;
  }

  private getProjectEmbeddingStrategyMetadataKey(projectIdentityHash = this.projectIdentityHash): string {
    return `index.embeddingStrategyVersion.${projectIdentityHash}`;
  }

  private getProjectForceReembedMetadataKey(projectIdentityHash = this.projectIdentityHash): string {
    return `index.forceReembed.${projectIdentityHash}`;
  }

  private getProjectMigrationFinalizedMetadataKey(projectIdentityHash = this.projectIdentityHash): string {
    return `index.migrationFinalized.${projectIdentityHash}`;
  }

  private getBranchMigrationMetadataKey(
    prefix: string,
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): string {
    const branchKey = this.getBranchCatalogKeyFor(catalogIdentity);
    return `${prefix}.${hashContent(branchKey).slice(0, 24)}`;
  }

  private getCallGraphResolutionMetadataKey(
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): string {
    return this.getBranchMigrationMetadataKey("index.callGraphResolutionVersion", catalogIdentity);
  }

  private getLocalModuleResolutionConfigMetadataKey(
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): string {
    return this.getBranchMigrationMetadataKey("index.localModuleResolutionConfigHash", catalogIdentity);
  }

  private getSwiftParserVersionMetadataKey(
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): string {
    return this.getBranchMigrationMetadataKey("index.parser.swiftVersion", catalogIdentity);
  }

  private getMetalParserVersionMetadataKey(
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): string {
    return this.getBranchMigrationMetadataKey("index.parser.metalVersion", catalogIdentity);
  }

  private getSymbolExtractorVersionMetadataKey(
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): string {
    return this.getBranchMigrationMetadataKey("index.symbolExtractorVersion", catalogIdentity);
  }

  private areBranchMigrationVersionsCurrent(
    database: Database,
    catalogIdentity = this.getBranchCatalogIdentity(),
  ): boolean {
    return database.getMetadata(this.getCallGraphResolutionMetadataKey(catalogIdentity))
      === CALL_GRAPH_RESOLUTION_VERSION
      && database.getMetadata(this.getSwiftParserVersionMetadataKey(catalogIdentity))
      === SWIFT_PARSER_VERSION
      && database.getMetadata(this.getMetalParserVersionMetadataKey(catalogIdentity))
      === METAL_PARSER_VERSION
      && database.getMetadata(this.getSymbolExtractorVersionMetadataKey(catalogIdentity))
      === SYMBOL_EXTRACTOR_VERSION;
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

    for (const batch of this.loadSerializedFailedBatches()) {
      if (batch.chunks.some((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath !== null && this.isFileInCurrentScope(filePath, roots);
      })) {
        return true;
      }
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

  private getProjectLocalScopedOwnershipIds(roots: string[], projectRoot = this.projectRoot): {
    chunkIds: Set<string>;
    symbolIds: Set<string>;
  } {
    const chunkIds = new Set<string>();
    const symbolIds = new Set<string>();
    if (!this.database) {
      return { chunkIds, symbolIds };
    }

    const projectLocalFilePaths = new Set<string>([
      ...Array.from(this.fileHashCache.keys()).filter(
        (filePath) => this.isFileInCurrentScope(filePath, roots) && this.isFileInProjectRoot(filePath, projectRoot)
      ),
      ...(this.store?.getAllMetadata() ?? [])
        .map(({ metadata }) => metadata.filePath)
        .filter(
          (filePath) => this.isFileInCurrentScope(filePath, roots) && this.isFileInProjectRoot(filePath, projectRoot)
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

  private getProjectScopedBranchCatalogCleanupKeys(
    projectChunkIds: string[],
    projectSymbolIds: string[],
    projectRoot = this.projectRoot,
  ): string[] {
    if (this.config.scope !== "global") {
      return this.getBranchCatalogCleanupKeys();
    }

    const keys = new Set<string>();
    const projectChunkIdSet = new Set(projectChunkIds);
    const projectSymbolIdSet = new Set(projectSymbolIds);
    const projectIdentityHash = this.getProjectIdentityHash(projectRoot);

    for (const branchKey of this.database?.getAllBranches() ?? []) {
      if (branchKey.startsWith(`${projectIdentityHash}:`)) {
        keys.add(branchKey);
        continue;
      }

      const referencesProjectChunks = this.database?.getBranchChunkIds(branchKey).some((chunkId) => projectChunkIdSet.has(chunkId)) ?? false;
      const referencesProjectSymbols = this.database?.getBranchSymbolIds(branchKey).some((symbolId) => projectSymbolIdSet.has(symbolId)) ?? false;
      if (referencesProjectChunks || referencesProjectSymbols) {
        keys.add(branchKey);
      }
    }

    if (projectRoot === this.projectRoot) {
      for (const branchKey of this.getBranchCatalogCleanupKeys()) {
        keys.add(branchKey);
      }
    }

    return Array.from(keys);
  }

  private isFileInCurrentScope(filePath: string, roots: string[]): boolean {
    const canonicalFilePath = this.getCanonicalStoredFilePath(filePath);
    return roots.some((root) => isPathWithinRoot(canonicalFilePath, root));
  }

  private isFileInProjectRoot(filePath: string, projectRoot = this.projectRoot): boolean {
    return isPathWithinRoot(
      this.getCanonicalStoredFilePath(filePath),
      this.getCanonicalPath(projectRoot),
    );
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

  private clearScopedFailedBatches(roots: string[]): void {
    this.rewriteFailedBatchState((chunk) => {
      const filePath = getPendingChunkFilePath(chunk);
      return filePath === null || !this.isFileInCurrentScope(filePath, roots);
    });
  }

  private hasForeignScopedFileHashData(roots: string[]): boolean {
    return Array.from(this.fileHashCache.keys()).some((filePath) => !this.isFileInCurrentScope(filePath, roots));
  }

  private hasForeignScopedFailedBatches(roots: string[]): boolean {
    for (const batch of this.loadSerializedFailedBatches()) {
      if (batch.chunks.some((chunk) => {
        const filePath = getPendingChunkFilePath(chunk);
        return filePath === null || !this.isFileInCurrentScope(filePath, roots);
      })) {
        return true;
      }
    }
    return false;
  }

  private hasForeignScopedBranchData(
    projectRoot = this.projectRoot,
    roots = this.getScopedRoots(projectRoot),
  ): boolean {
    if (!this.database || this.config.scope !== "global") {
      return false;
    }

    const projectIdentityHash = this.getProjectIdentityHash(projectRoot);
    const { chunkIds: projectLocalChunkIds, symbolIds: projectLocalSymbolIds } = this.getProjectLocalScopedOwnershipIds(roots, projectRoot);

    return this.database.getAllBranches().some(
      (branchKey) => {
        const branchChunkIds = this.database!.getBranchChunkIds(branchKey);
        const branchSymbolIds = this.database!.getBranchSymbolIds(branchKey);
        const hasBranchData = branchChunkIds.length > 0 || branchSymbolIds.length > 0;
        if (!hasBranchData) {
          return false;
        }

        if (branchKey.startsWith(`${projectIdentityHash}:`)) {
          return false;
        }

        const referencesCurrentProjectChunks = branchChunkIds.some((chunkId) => projectLocalChunkIds.has(chunkId));
        const referencesCurrentProjectSymbols = branchSymbolIds.some((symbolId) => projectLocalSymbolIds.has(symbolId));
        return !(referencesCurrentProjectChunks || referencesCurrentProjectSymbols);
      }
    );
  }

  private clearSharedIndexProjectData(
    store: VectorStore,
    invertedIndex: InvertedIndex,
    database: Database,
    roots: string[],
    projectRoot = this.projectRoot,
  ): { removedChunkIds: string[]; hasForeignData: boolean } {
    const allMetadata = store.getAllMetadata();
    const scopedEntries = allMetadata.filter(({ metadata }) => this.isFileInCurrentScope(metadata.filePath, roots));
    const filePaths = new Set<string>([
      ...Array.from(this.fileHashCache.keys()).filter((filePath) => this.isFileInCurrentScope(filePath, roots)),
      ...scopedEntries.map(({ metadata }) => metadata.filePath),
    ]);

    const projectLocalFilePaths = new Set<string>(
      Array.from(filePaths).filter((filePath) => this.isFileInProjectRoot(filePath, projectRoot))
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
        .filter(({ metadata }) => this.isFileInProjectRoot(metadata.filePath, projectRoot))
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

    const branchCleanupKeys = this.getProjectScopedBranchCatalogCleanupKeys(
      Array.from(projectLocalChunkIds),
      Array.from(projectLocalSymbolIds),
      projectRoot,
    );
    for (const branchKey of branchCleanupKeys) {
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

    for (const branchKey of branchCleanupKeys) {
      database.deleteBranchSymbolsForBranch(branchKey, symbolIds);
    }
    this.deleteBranchCommitMetadata(database, branchCleanupKeys);
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

    // Persist the keyword index before the vector store: a crash between the
    // two leaves the store as the conservative resume authority, so the next
    // run re-embeds and repopulates BM25 instead of skipping addChunk for
    // chunks whose vectors are already durable.
    this.saveInvertedIndex(invertedIndex);
    store.save();

    return {
      removedChunkIds: removedChunkIdList,
      hasForeignData: allMetadata.some(({ metadata }) => !this.isFileInCurrentScope(metadata.filePath, roots)),
    };
  }

  private getCurrentClearRecoveryState(): IndexLockClearRecoveryState {
    if (!this.configuredProviderInfo) {
      throw new Error("Cannot persist clear recovery state before the embedding provider is initialized");
    }
    const compatibility = this.checkCompatibility();
    const compatibilityDecision = compatibility.compatible
      ? "compatible"
      : compatibility.code === IncompatibilityCode.EMBEDDING_STRATEGY_MISMATCH
        ? "embedding-strategy-mismatch"
        : "incompatible";
    return {
      phase: "clearing",
      embeddingProvider: this.configuredProviderInfo.provider,
      embeddingModel: this.configuredProviderInfo.modelInfo.model,
      embeddingDimensions: this.configuredProviderInfo.modelInfo.dimensions,
      embeddingStrategyVersion: EMBEDDING_STRATEGY_VERSION,
      compatibilityDecision,
    };
  }

  private beginClearRecoveryState(): IndexLockClearRecoveryState {
    const recovery = this.getCurrentClearRecoveryState();
    setIndexLockClearRecoveryState(this.requireActiveLease(), recovery);
    return recovery;
  }

  private finishClearRecoveryState(): void {
    setIndexLockClearRecoveryState(this.requireActiveLease(), null);
  }

  private matchesCurrentClearRecoveryConfiguration(recovery: IndexLockClearRecoveryState): boolean {
    const configuredProviderInfo = this.configuredProviderInfo;
    return configuredProviderInfo !== null
      && recovery.embeddingProvider === configuredProviderInfo.provider
      && recovery.embeddingModel === configuredProviderInfo.modelInfo.model
      && recovery.embeddingDimensions === configuredProviderInfo.modelInfo.dimensions
      && recovery.embeddingStrategyVersion === EMBEDDING_STRATEGY_VERSION;
  }

  private hasUnknownLegacyForceIndexClear(owner: IndexLockOwner): boolean {
    return owner.operation === "force-index"
      && owner.clearRecovery === undefined
      && owner.recoveryProtocolVersion !== 1
      && existsSync(path.join(this.indexPath, "force-index-phase"));
  }

  private async recoverFromInterruptedIndexingUnlocked(owners: readonly IndexLockOwner[]): Promise<void> {
    for (const owner of owners) {
      this.logger.warn("Detected interrupted indexing session, recovering...", {
        pid: owner.pid,
        hostname: owner.hostname,
        operation: owner.operation,
        startedAt: owner.startedAt,
        projectRoot: owner.projectRoot,
      });
    }

    if (this.config.scope === "global") {
      const clearScopes: Array<{
        projectRoot: string;
        scopedRoots: string[];
        compatibilityDecision: IndexLockClearRecoveryState["compatibilityDecision"];
      }> = [];
      for (const owner of owners) {
        if (this.hasUnknownLegacyForceIndexClear(owner)) {
          throw new Error(
            `Cannot automatically recover interrupted force-index ${owner.token}: ` +
            "the legacy clearing phase ownership is unknown. The recovery marker was retained for manual inspection."
          );
        }
        if (
          owner.operation === "clear"
          && owner.clearRecovery === undefined
          && owner.recoveryProtocolVersion !== 1
        ) {
          throw new Error(
            `Cannot automatically recover interrupted global clear ${owner.token}: ` +
            "the originating recovery state is unknown. The recovery marker was retained for manual inspection."
          );
        }
        if (owner.clearRecovery === undefined) continue;
        if (!owner.projectRoot || !owner.scopedRoots || owner.scopedRoots.length === 0) {
          throw new Error(
            `Cannot automatically recover interrupted global clear ${owner.token}: ` +
            "the originating project scope is unknown. The recovery marker was retained for manual inspection."
          );
        }
        if (!this.matchesCurrentClearRecoveryConfiguration(owner.clearRecovery)) {
          throw new Error(
            `Cannot automatically recover interrupted global clear ${owner.token}: ` +
            "the current embedding configuration does not match the originating lease. " +
            "The recovery marker was retained; retry from the originating project with matching settings."
          );
        }
        clearScopes.push({
          projectRoot: owner.projectRoot,
          scopedRoots: owner.scopedRoots,
          compatibilityDecision: owner.clearRecovery.compatibilityDecision,
        });
      }
      if (clearScopes.length > 0) {
        // The scoped clear purges the file-hash cache entries of the
        // originating project: load the persisted cache first so the purge
        // is written back instead of being lost on an empty in-memory map.
        this.loadFileHashCache();
      }
      for (const { projectRoot, scopedRoots, compatibilityDecision } of clearScopes) {
        // Re-apply the clear decision against the originating project scope:
        // a global clear only wipes the whole shared index when no foreign
        // project data is present, otherwise it stays scoped to the project
        // that started the clear.
        this.clearGlobalIndexUnlocked(projectRoot, scopedRoots, compatibilityDecision);
      }
      await this.healthCheckUnlocked();
      this.logger.info(
        clearScopes.length > 0
          ? "Recovery complete, next index will rebuild all files"
          : "Recovery complete, next index will resume from the last checkpoint",
      );
      return;
    }

    this.logger.info("Recovery complete, next index will resume from the last checkpoint");
  }

  private *loadSerializedFailedBatches(): Generator<SerializedFailedBatch> {
    let warned = false;
    const warn = (error: unknown): void => {
      if (warned) return;
      warned = true;
      this.logger.warn("Failed to load failed batch state, skipping persisted retries", {
        failedBatchesPath: this.failedBatchesPath,
        error: getErrorMessage(error),
      });
    };

    try {
      for (const record of readFailedBatchRecords<unknown>(this.failedBatchesPath, {
        malformedLineAction: "skip",
        onMalformedLine: (error) => warn(error),
      })) {
        yield {
          chunks: record.chunks,
          error: record.error,
          attemptCount: record.attemptCount,
          lastAttempt: record.lastAttempt,
        };
      }
    } catch (error) {
      warn(error);
    }
  }

  private createFailedBatchWriteState(): FailedBatchWriteState {
    return {
      writer: createFailedBatchWriter<unknown>(this.failedBatchesPath),
      recordsWritten: 0,
    };
  }

  private writeFailedBatchRecord(
    state: FailedBatchWriteState,
    record: FailedBatchRecordInput<unknown>,
  ): void {
    state.writer.write(record);
    state.recordsWritten += record.chunks.length;
  }

  private finalizeFailedBatchWriteState(
    state: FailedBatchWriteState,
    resolvedChunkIds: ReadonlySet<string> = new Set(),
  ): void {
    if (state.recordsWritten > 0) {
      // Deduplicate by chunk ID and drop resolved retries. Process in reverse
      // so the last-written record (highest attemptCount) wins; the
      // checkpoint reconstruction loop and the retry phase can both
      // materialize the same pending retry.
      const seenChunkIds = new Set<string>();
      const retained: FailedBatchRecordInput<unknown>[] = [];
      const records = Array.from(readFailedBatchRecords<unknown>(state.writer.temporaryPath));
      for (let i = records.length - 1; i >= 0; i--) {
        const chunks = records[i].chunks.filter((rawChunk) => {
          const chunkId = getPendingChunkId(rawChunk);
          if (chunkId !== null) {
            if (resolvedChunkIds.has(chunkId)) return false;
            if (seenChunkIds.has(chunkId)) return false;
            seenChunkIds.add(chunkId);
          }
          return true;
        });
        if (chunks.length > 0) {
          retained.unshift({ ...records[i], chunks });
        }
      }
      state.writer.cleanup();
      if (retained.length > 0) {
        writeFailedBatchRecords(this.failedBatchesPath, retained);
      } else {
        writeFailedBatchRecords(this.failedBatchesPath, []);
        this.clearFailedBatchState();
      }
      return;
    }

    state.writer.commit();
    this.clearFailedBatchState();
  }

  private getCheckpointIntervalChunks(totalChunks: number): number {
    return Math.max(
      this.checkpointIntervalChunks ?? 2000,
      Math.floor(totalChunks / 10),
    );
  }

  private checkpointIndexRun(
    database: Database,
    store: VectorStore,
    invertedIndex: InvertedIndex,
    failedProcessing: FailedBatchProcessingState,
    resolvedRetryChunkIds: ReadonlySet<string>,
    currentFileHashes: Map<string, string>,
    committedFilePaths: Set<string>,
    scopedRoots: string[] | null,
    configuredProviderInfo: ConfiguredProviderInfo,
  ): void {
    if (!this.hasProjectForceReembedPending()) {
      this.saveIndexMetadata(configuredProviderInfo);
      this.indexCompatibility = { compatible: true };
    }
    database.commitWriteTransaction();
    database.beginWriteTransaction();
    // Persist the keyword index before the vector store: a crash between the
    // two leaves the store as the conservative resume authority, so the next
    // run re-embeds and repopulates BM25 instead of skipping addChunk for
    // chunks whose vectors are already durable.
    this.saveInvertedIndex(invertedIndex);
    store.save();
    if (
      failedProcessing.state.recordsWritten > 0
      || failedProcessing.latestById.size > 0
      || failedProcessing.discardedExistingRecords
    ) {
      // Persist the pending retries alongside the written records so a crash
      // after this checkpoint cannot lose them.
      for (const metadata of failedProcessing.latestById.values()) {
        const alreadyMaterialized = metadata.chunks.some((rawChunk) => {
          const chunkId = getPendingChunkId(rawChunk);
          return chunkId !== null && failedProcessing.materializedRetryIds.has(chunkId);
        });
        if (alreadyMaterialized) continue;
        this.writeFailedBatchRecord(failedProcessing.state, {
          chunks: metadata.chunks,
          attemptCount: metadata.attemptCount,
          error: metadata.error,
          lastAttempt: metadata.lastAttempt,
        });
        for (const rawChunk of metadata.chunks) {
          const chunkId = getPendingChunkId(rawChunk);
          if (chunkId !== null) {
            failedProcessing.materializedRetryIds.add(chunkId);
          }
        }
      }
      this.finalizeFailedBatchWriteState(failedProcessing.state, resolvedRetryChunkIds);
      failedProcessing.state = this.createFailedBatchWriteState();
      failedProcessing.discardedExistingRecords = false;
      // Preserve the committed records (including out-of-scope projects'
      // failed batches) so finalization never deletes them.
      for (const record of this.loadSerializedFailedBatches()) {
        for (const rawChunk of record.chunks) {
          const chunkId = getPendingChunkId(rawChunk);
          this.writeFailedBatchRecord(failedProcessing.state, { ...record, chunks: [rawChunk] });
          if (chunkId !== null) {
            failedProcessing.materializedRetryIds.add(chunkId);
          }
        }
      }
    }
    const partialHashes = new Map<string, string>();
    for (const filePath of committedFilePaths) {
      const hash = currentFileHashes.get(filePath);
      if (hash !== undefined) {
        partialHashes.set(filePath, hash);
      }
    }
    if (scopedRoots) {
      this.replaceScopedFileHashCache(partialHashes, scopedRoots);
    } else {
      this.fileHashCache = partialHashes;
      this.saveFileHashCache();
    }
  }

  private clearFailedBatchState(): void {
    if (existsSync(this.failedBatchesPath)) {
      try {
        unlinkSync(this.failedBatchesPath);
      } catch {
        // Ignore cleanup failures; stale diagnostics are best-effort only.
      }
    }
  }

  private rewriteFailedBatchState(shouldRetain: (chunk: unknown) => boolean): void {
    const state = this.createFailedBatchWriteState();
    try {
      for (const batch of this.loadSerializedFailedBatches()) {
        const retainedChunks = batch.chunks.filter(shouldRetain);
        if (retainedChunks.length > 0) {
          this.writeFailedBatchRecord(state, { ...batch, chunks: retainedChunks });
        }
      }
      this.finalizeFailedBatchWriteState(state);
    } catch (error) {
      state.writer.cleanup();
      throw error;
    }
  }

  private prepareFailedBatchProcessing(
    roots: string[] | null,
    shouldProcess: (filePath: string | null) => boolean,
  ): FailedBatchProcessingState {
    const state = this.createFailedBatchWriteState();
    const latestById = new Map<string, FailedChunkRecordMetadata>();
    let discardedExistingRecords = false;

    try {
      for (const batch of this.loadSerializedFailedBatches()) {
        for (const rawChunk of batch.chunks) {
          const filePath = getPendingChunkFilePath(rawChunk);
          const inScope = roots === null || (filePath !== null && this.isFileInCurrentScope(filePath, roots));
          if (!inScope) {
            this.writeFailedBatchRecord(state, { ...batch, chunks: [rawChunk] });
            continue;
          }
          if (!shouldProcess(filePath)) {
            discardedExistingRecords = true;
            continue;
          }

          const chunkId = getPendingChunkId(rawChunk);
          if (!chunkId) {
            discardedExistingRecords = true;
            continue;
          }
          const existing = latestById.get(chunkId);
          if (!existing || batch.attemptCount >= existing.attemptCount) {
            latestById.set(chunkId, {
              attemptCount: batch.attemptCount,
              error: batch.error,
              lastAttempt: batch.lastAttempt,
              chunks: [rawChunk],
            });
          }
        }
      }
      return {
        state,
        latestById,
        materializedRetryIds: new Set(),
        discardedExistingRecords,
      };
    } catch (error) {
      state.writer.cleanup();
      throw error;
    }
  }

  private *iterateLatestFailedChunks(
    latestById: ReadonlyMap<string, FailedChunkRecordMetadata>,
    roots: string[] | null,
    shouldProcess: (filePath: string | null) => boolean,
    maxChunkTokens?: number,
  ): Generator<RetryableFailedChunkRecord> {
    const yielded = new Set<string>();
    for (const batch of this.loadSerializedFailedBatches()) {
      for (const rawChunk of batch.chunks) {
        const chunkId = getPendingChunkId(rawChunk);
        if (!chunkId || yielded.has(chunkId)) {
          continue;
        }
        const latest = latestById.get(chunkId);
        if (
          !latest ||
          latest.attemptCount !== batch.attemptCount ||
          latest.error !== batch.error ||
          latest.lastAttempt !== batch.lastAttempt
        ) {
          continue;
        }

        const filePath = getPendingChunkFilePath(rawChunk);
        const inScope = roots === null || (filePath !== null && this.isFileInCurrentScope(filePath, roots));
        if (!inScope || !shouldProcess(filePath)) {
          continue;
        }

        const normalized = normalizeFailedBatch({ ...batch, chunks: [rawChunk] }, maxChunkTokens);
        const chunk = normalized?.chunks[0];
        if (!chunk) {
          continue;
        }
        yielded.add(chunkId);
        yield {
          chunk,
          attemptCount: batch.attemptCount,
        };
      }
    }
  }

  private restoreMissingChunkRows(database: Database, chunks: readonly PendingChunk[]): void {
    const missing: ChunkData[] = [];
    for (const chunk of chunks) {
      if (database.getChunk(chunk.id)) {
        continue;
      }
      missing.push({
        chunkId: chunk.id,
        contentHash: chunk.contentHash,
        filePath: chunk.metadata.filePath,
        startLine: chunk.metadata.startLine,
        endLine: chunk.metadata.endLine,
        nodeType: chunk.metadata.chunkType,
        name: chunk.metadata.name,
        language: chunk.metadata.language,
        blameSha: chunk.metadata.blameSha,
        blameAuthor: chunk.metadata.blameAuthor,
        blameAuthorEmail: chunk.metadata.blameAuthorEmail,
        blameCommittedAt: chunk.metadata.blameCommittedAt,
        blameSummary: chunk.metadata.blameSummary,
      });
    }
    if (missing.length > 0) {
      database.upsertChunksBatch(missing);
    }
  }

  private getProviderRateLimits(provider: string): {
    concurrency: number;
    intervalMs: number;
    minRetryMs: number;
    maxRetryMs: number;
  } {
    switch (provider) {
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

  private async processPendingChunkBatch(
    chunks: PendingChunk[],
    options: {
      store: VectorStore;
      provider: EmbeddingProviderInterface;
      invertedIndex: InvertedIndex;
      database: Database;
      configuredProviderInfo: ConfiguredProviderInfo;
      queue: PQueue;
      providerRateLimits: ReturnType<Indexer["getProviderRateLimits"]>;
      rateLimitState: EmbeddingRateLimitState;
      failedState: FailedBatchWriteState;
      attemptCounts: Map<string, number>;
      forceReembed: boolean;
      reuseCachedEmbeddings: boolean;
      incrementRepeatedFailures: boolean;
      // When true (recovery path), embed previously-failed chunks one per request
      // so a permanently-failing chunk is isolated instead of failing its batch.
      forceSingleItemBatches?: boolean;
      onSucceeded?: (chunks: PendingChunk[]) => void;
      onProgress?: (progress: Readonly<PendingChunkBatchResult>) => void;
    },
  ): Promise<PendingChunkBatchResult> {
    const result: PendingChunkBatchResult = {
      indexedChunks: 0,
      failedChunks: 0,
      tokensUsed: 0,
      failedChunkIds: new Set<string>(),
    };
    if (chunks.length === 0) {
      return result;
    }

    const chunksNeedingEmbedding: PendingChunk[] = [];
    let cachedChunkCount = 0;
    if (options.reuseCachedEmbeddings && !options.forceReembed) {
      const missingHashes = new Set(options.database.getMissingEmbeddings(chunks.map((chunk) => chunk.contentHash)));
      for (const chunk of chunks) {
        if (missingHashes.has(chunk.contentHash)) {
          chunksNeedingEmbedding.push(chunk);
          continue;
        }

        const embeddingBuffer = options.database.getEmbedding(chunk.contentHash);
        if (!embeddingBuffer) {
          chunksNeedingEmbedding.push(chunk);
          continue;
        }

        options.store.add(chunk.id, Array.from(bufferToFloat32Array(embeddingBuffer)), chunk.metadata);
        options.invertedIndex.removeChunk(chunk.id);
        options.invertedIndex.addChunk(chunk.id, chunk.content);
        options.onSucceeded?.([chunk]);
        result.indexedChunks += 1;
        cachedChunkCount += 1;
      }
    } else {
      chunksNeedingEmbedding.push(...chunks);
    }

    this.logger.cache("info", "Embedding cache lookup", {
      needsEmbedding: chunksNeedingEmbedding.length,
      fromCache: cachedChunkCount,
    });
    if (cachedChunkCount > 0) {
      this.logger.recordChunksFromCache(cachedChunkCount);
      options.onProgress?.(result);
    }

    if (chunksNeedingEmbedding.length === 0) {
      return result;
    }

    const pendingChunksById = new Map(chunksNeedingEmbedding.map((chunk) => [chunk.id, chunk]));
    const embeddingPartsByChunk = new Map<string, Array<{ vector: number[]; tokenCount: number } | undefined>>();
    const completedVectorsByChunkId = new Map<string, number[]>();
    const completedChunkIds = new Set<string>();
    const batchOptions = getDynamicBatchOptions(options.configuredProviderInfo, this.config.embedding?.batch);
    // On the recovery path, embed previously-failed chunks one per request so a
    // permanently-failing chunk is isolated instead of failing its whole batch.
    // Scoped to ollama (whose default batch size groups chunks); other providers
    // keep their existing recovery batching.
    if (options.forceSingleItemBatches && options.configuredProviderInfo.provider === "ollama") {
      batchOptions.maxBatchItems = 1;
    }
    const requestBatches = createPendingEmbeddingRequestBatches(chunksNeedingEmbedding, batchOptions);
    let fatalError: unknown;

    for (const requestBatch of requestBatches) {
      await options.queue.onSizeLessThan(Math.max(1, options.providerRateLimits.concurrency));
      const task = options.queue.add(async () => {
        if (options.rateLimitState.backoffMs > 0) {
          await new Promise(resolve => setTimeout(resolve, options.rateLimitState.backoffMs));
        }

        try {
          const embeddingResult = await pRetry(
            async () => {
              const texts = requestBatch.map((request) => request.text);
              return options.provider.embedBatch(texts);
            },
            {
              retries: this.config.indexing.retries,
              minTimeout: Math.max(this.config.indexing.retryDelayMs, options.providerRateLimits.minRetryMs),
              maxTimeout: options.providerRateLimits.maxRetryMs,
              factor: 2,
              shouldRetry: (error) => !((error as { error?: Error }).error instanceof CustomProviderNonRetryableError),
              onFailedAttempt: (error) => {
                const message = getErrorMessage(error);
                if (isRateLimitError(error)) {
                  options.rateLimitState.backoffMs = Math.min(
                    options.providerRateLimits.maxRetryMs,
                    (options.rateLimitState.backoffMs || options.providerRateLimits.minRetryMs) * 2,
                  );
                  this.logger.embedding("warn", "Rate limited, backing off", {
                    attempt: error.attemptNumber,
                    retriesLeft: error.retriesLeft,
                    backoffMs: options.rateLimitState.backoffMs,
                  });
                } else {
                  this.logger.embedding("error", "Embedding batch failed", {
                    attempt: error.attemptNumber,
                    error: message,
                  });
                }
              },
            },
          );

          if (options.rateLimitState.backoffMs > 0) {
            options.rateLimitState.backoffMs = Math.max(0, options.rateLimitState.backoffMs - 2000);
          }

          const touchedChunkIds = new Set<string>();
          requestBatch.forEach((request, index) => {
            if (result.failedChunkIds.has(request.chunk.id) || completedChunkIds.has(request.chunk.id)) {
              return;
            }

            const vector = embeddingResult.embeddings[index];
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
            if (result.failedChunkIds.has(chunkId) || completedChunkIds.has(chunkId)) {
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
                orderedParts.map((part) => part.tokenCount),
              ),
            });
          }

          if (pooledResults.length > 0) {
            options.database.upsertEmbeddingsBatch(pooledResults.map(({ chunk, vector }) => ({
              contentHash: chunk.contentHash,
              embedding: float32ArrayToBuffer(vector),
              chunkText: chunk.storageText,
              model: options.configuredProviderInfo.modelInfo.model,
            })));

            const succeededChunks = pooledResults.map(({ chunk }) => chunk);
            for (const { chunk, vector } of pooledResults) {
              completedVectorsByChunkId.set(chunk.id, vector);
            }
            for (const chunk of succeededChunks) {
              completedChunkIds.add(chunk.id);
              embeddingPartsByChunk.delete(chunk.id);
            }

          }

          result.tokensUsed += embeddingResult.totalTokensUsed;
          this.logger.recordEmbeddingApiCall(embeddingResult.totalTokensUsed);
          this.logger.embedding("debug", "Embedded batch", {
            batchSize: pooledResults.length,
            requestCount: requestBatch.length,
            tokens: embeddingResult.totalTokensUsed,
          });
        } catch (error) {
          const failedChunks = getUniquePendingChunksFromRequests(requestBatch)
            .filter((chunk) => !completedChunkIds.has(chunk.id))
            .filter((chunk) => options.incrementRepeatedFailures || !result.failedChunkIds.has(chunk.id));
          const failureMessage = getErrorMessage(error);
          const failureTimestamp = new Date().toISOString();

          for (const chunk of failedChunks) {
            if (!result.failedChunkIds.has(chunk.id)) {
              result.failedChunkIds.add(chunk.id);
              result.failedChunks += 1;
            }
            embeddingPartsByChunk.delete(chunk.id);
            const attemptCount = (options.attemptCounts.get(chunk.id) ?? 0) + 1;
            options.attemptCounts.set(chunk.id, attemptCount);
            this.writeFailedBatchRecord(options.failedState, {
              chunks: [chunk],
              error: failureMessage,
              attemptCount,
              lastAttempt: failureTimestamp,
            });
          }

          this.logger.recordEmbeddingError();
          this.logger.embedding("error", "Failed to embed batch after retries", {
            batchSize: failedChunks.length,
            requestCount: requestBatch.length,
            error: failureMessage,
          });
        }

        options.onProgress?.(result);
      });
      void task.catch((error: unknown) => {
        fatalError ??= error;
      });
    }

    await options.queue.onIdle();
    if (fatalError !== undefined) {
      throw fatalError;
    }

    const orderedSucceededChunks = chunksNeedingEmbedding.filter((chunk) => completedVectorsByChunkId.has(chunk.id));
    if (orderedSucceededChunks.length > 0) {
      try {
        options.store.addBatch(orderedSucceededChunks.map((chunk) => ({
          id: chunk.id,
          vector: completedVectorsByChunkId.get(chunk.id)!,
          metadata: chunk.metadata,
        })));
        for (const chunk of orderedSucceededChunks) {
          options.invertedIndex.removeChunk(chunk.id);
          options.invertedIndex.addChunk(chunk.id, chunk.content);
        }
        options.onSucceeded?.(orderedSucceededChunks);
        result.indexedChunks += orderedSucceededChunks.length;
        this.logger.recordChunksEmbedded(orderedSucceededChunks.length);
      } catch (error) {
        const failureMessage = getErrorMessage(error);
        const failureTimestamp = new Date().toISOString();
        for (const chunk of orderedSucceededChunks) {
          options.store.remove(chunk.id);
          options.invertedIndex.removeChunk(chunk.id);
          result.failedChunkIds.add(chunk.id);
          result.failedChunks += 1;
          const attemptCount = (options.attemptCounts.get(chunk.id) ?? 0) + 1;
          options.attemptCounts.set(chunk.id, attemptCount);
          this.writeFailedBatchRecord(options.failedState, {
            chunks: [chunk],
            error: failureMessage,
            attemptCount,
            lastAttempt: failureTimestamp,
          });
        }
        this.logger.recordEmbeddingError();
        this.logger.embedding("error", "Failed to publish embedded chunks", {
          batchSize: orderedSucceededChunks.length,
          error: failureMessage,
        });
      }
      options.onProgress?.(result);
    }
    return result;
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

    const queryIntent = analyzeQueryIntent(query);
    const preferSourcePaths = queryIntent.preferSourcePaths;
    const docIntent = queryIntent.primary === "docs";

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
      ["config", []],
      ["other", []],
    ]);

    for (const candidate of head) {
      const band = classifyExternalRerankBand(candidate, queryIntent);
      grouped.get(band)?.push(candidate);
    }

    const orderedBands: ExternalRerankBand[] = preferSourcePaths
      ? ["implementation", "other", "config", "documentation", "test"]
      : queryIntent.primary === "docs"
        ? ["documentation", "implementation", "config", "other", "test"]
        : queryIntent.primary === "test"
          ? ["test", "implementation", "other", "documentation", "config"]
          : queryIntent.primary === "config"
            ? ["config", "implementation", "other", "documentation", "test"]
            : ["implementation", "other", "config", "documentation", "test"];

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
      const fileContent = await fsPromises.readFile(
        this.toMaterializedFilePath(candidate.metadata.filePath),
        "utf-8",
      );
      const lines = fileContent.split("\n");
      const snippetStartLine = Math.max(1, candidate.metadata.startLine);
      const snippetEndLine = Math.min(lines.length, candidate.metadata.endLine);
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
    if (!this.isProjectOwnedIndexPath()) {
      return "Vector index could not be read from an inherited project index. Restore or fingerprint it from the checkout that owns the index; do not remove or rebuild it from this worktree.";
    }
    return "Vector index could not be read. Run index_codebase after the active writer finishes to fingerprint a structurally valid legacy pair, or remove this checkout's local index directory and run index_codebase to rebuild it.";
  }

  private getKeywordReadIssueMessage(): string {
    if (this.config.scope === "global") {
      return "Shared keyword index could not be read; semantic search remains available. Restore or repair the shared keyword artifact; automatic reset is disabled for global scope.";
    }
    if (!this.isProjectOwnedIndexPath()) {
      return "Keyword index could not be read from an inherited project index; semantic search remains available. Restore or repair it from the checkout that owns the index; do not rebuild it from this worktree.";
    }
    return "Keyword index could not be read; semantic search remains available. Restore a readable published keyword index, or run index_codebase with force=true after the active writer finishes.";
  }

  private getDatabaseReadIssueMessage(): string {
    if (this.config.scope === "global") {
      return "Shared index database could not be read. Restore or repair the shared SQLite database; automatic reset is disabled for global scope.";
    }
    if (!this.isProjectOwnedIndexPath()) {
      return "Index database could not be read from an inherited project index. Restore or repair it from the checkout that owns the index; do not migrate or rebuild it from this worktree.";
    }
    return "Index database could not be read. Run index_codebase with force=true to rebuild a legacy absolute-path schema, or repair the database after the active writer finishes.";
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
        "No embedding provider available. Configure OpenAI, Google, Ollama, or a custom OpenAI-compatible endpoint."
      );
    }

    this.logger.info("Initializing indexer", {
      provider: this.configuredProviderInfo.provider,
      model: this.configuredProviderInfo.modelInfo.model,
      scope: this.config.scope,
      rerankerEnabled: this.config.reranker?.enabled ?? false,
    });

    this.provider = createEmbeddingProvider(this.configuredProviderInfo);

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
      if (recoveredOwners.length > 0 && this.config.scope === "project" && !this.isProjectOwnedIndexPath()) {
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
        const unknownLegacyForceIndex = recoveredOwners.find(
          (owner) => this.hasUnknownLegacyForceIndexClear(owner),
        );
        if (unknownLegacyForceIndex) {
          throw new Error(
            `Cannot automatically recover interrupted force-index ${unknownLegacyForceIndex.token}: ` +
            "the legacy clearing phase ownership is unknown. The recovery marker was retained for manual inspection."
          );
        }
        const shouldReset = recoveredOwners.some(
          (owner) => owner.clearRecovery !== undefined
            || (owner.operation === "clear" && owner.recoveryProtocolVersion !== 1),
        );
        if (shouldReset) {
          await this.resetLocalIndexArtifacts();
        }
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

    if (isGitRepo(this.materializedProjectRoot)) {
      this.currentBranch = this.branchNameOverride ?? getBranchOrDefault(this.materializedProjectRoot);
      this.baseBranch = getBaseBranch(this.materializedProjectRoot);
      this.logger.branch("info", "Detected git repository", {
        currentBranch: this.currentBranch,
        baseBranch: this.baseBranch,
      });
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
      this.logger.branch("debug", "Not a git repository, using default branch");
    }
    this.refreshRuntimeArtifactPaths();

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

  private async removeProjectRuntimeStateArtifacts(): Promise<void> {
    if (!existsSync(this.indexPath)) return;

    const names = await fsPromises.readdir(this.indexPath);
    const runtimeStatePattern = /^(?:file-hashes|failed-batches)(?:\.[a-f0-9]{16})?\.json$/;
    await Promise.all(
      names
        .filter((name) => runtimeStatePattern.test(name))
        .map((name) => fsPromises.rm(path.join(this.indexPath, name), { force: true })),
    );
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
    ];

    await Promise.all(resetPaths.map((targetPath) => fsPromises.rm(targetPath, { recursive: true, force: true })));
    await this.removeProjectRuntimeStateArtifacts();
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

  private getExpectedPathStorageVersion(): string {
    return this.config.scope === "project"
      ? PROJECT_PATH_STORAGE_VERSION
      : GLOBAL_PATH_STORAGE_VERSION;
  }

  private hasStoredIndexData(): boolean {
    const stats = this.database?.getStats();
    return (this.store?.count() ?? 0) > 0
      || (stats?.chunkCount ?? 0) > 0
      || (stats?.symbolCount ?? 0) > 0
      || this.fileHashCache.size > 0;
  }

  private loadIndexMetadata(): IndexMetadata | null {
    if (!this.database) return null;

    const version = this.database.getMetadata("index.version");
    if (!version) return null;

    return {
      indexVersion: version,
      pathStorageVersion: this.database.getMetadata("index.pathStorageVersion") ?? GLOBAL_PATH_STORAGE_VERSION,
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
    this.database.setMetadata("index.pathStorageVersion", this.getExpectedPathStorageVersion());
    this.database.setMetadata("index.embeddingProvider", provider.provider);
    this.database.setMetadata("index.embeddingModel", provider.modelInfo.model);
    this.database.setMetadata("index.embeddingDimensions", provider.modelInfo.dimensions.toString());
    this.database.setMetadata(this.getCallGraphResolutionMetadataKey(), CALL_GRAPH_RESOLUTION_VERSION);
    if (this.localModuleResolutionConfigHash !== null) {
      this.database.setMetadata(
        this.getLocalModuleResolutionConfigMetadataKey(),
        this.localModuleResolutionConfigHash,
      );
    }
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

    const storedPathStorageVersion = this.database?.getMetadata("index.pathStorageVersion")
      ?? GLOBAL_PATH_STORAGE_VERSION;
    const expectedPathStorageVersion = this.getExpectedPathStorageVersion();
    if (this.hasStoredIndexData() && storedPathStorageVersion !== expectedPathStorageVersion) {
      return {
        compatible: false,
        code: IncompatibilityCode.PATH_STORAGE_MISMATCH,
        reason: `Path storage format mismatch: index uses v${storedPathStorageVersion} checkout-absolute paths, but this project requires portable v${expectedPathStorageVersion} paths. Run index_codebase with force=true to rebuild the shared project index once.`,
        storedMetadata: storedMetadata ?? undefined,
      };
    }

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
    this.refreshBranchInfo();
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
      this.materializedProjectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.getMaterializedKnowledgeBases(),
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory }
    );

    return createCostEstimate(files, configuredProviderInfo);
  }

  // Dry-run counterpart to index()/forceIndex(): parse the real file set and sum
  // estimateTokens over the embedding text of every indexable chunk, without
  // calling the embedding provider or writing to the index. Read-only and
  // lock-free (mirrors estimateCost). The token sum is the exact value "Tokens
  // used" climbs to for a force index (cache bypassed); for an incremental it is
  // an upper bound because cached chunks are counted here but not re-embedded.
  // Used by index_codebase(dryRun:true) to give a stable, monotonic progress
  // denominator that matches the live "Tokens used" basis.
  async dryRunCost(): Promise<DryRunEstimate> {
    const { configuredProviderInfo } = await this.ensureInitialized();
    const maxChunkTokens = getSafeEmbeddingChunkTokenLimit(configuredProviderInfo);
    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files } = await collectFiles(
      this.materializedProjectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.getMaterializedKnowledgeBases(),
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory },
    );

    let filesCount = 0;
    let chunksCount = 0;
    let tokensToEmbed = 0;
    // Parse in the same ordered batches as index() (fileBatchLimits) so the
    // memory profile matches a real run. For each file: read, parse, apply the
    // same fallback-to-text + maxChunksPerFile cap + selectIndexableChunks path,
    // then sum estimateTokens over the embedding text (createEmbeddingTexts)
    // — the identical basis the provider reports as "Tokens used".
    for (const batch of iterateOrderedFileBatches(files, (f) => f.size, this.fileBatchLimits)) {
      const loadedFiles = await Promise.all(batch.map(async (f) => {
        try {
          return {
            path: this.toStoredFilePath(f.path),
            content: await fsPromises.readFile(f.path, "utf-8"),
          };
        } catch {
          // Unreadable file: index() records a parse failure and skips it.
          return null;
        }
      }));
      const readable = loadedFiles.filter(
        (f): f is { path: string; content: string } => f !== null,
      );
      filesCount += readable.length;
      const contentByPath = new Map(readable.map((f) => [f.path, f.content]));
      const parsedFiles = parseFiles(readable, this.config.indexing.linesPerChunk);
      for (const parsed of parsedFiles) {
        let chunksToProcess = parsed.chunks;
        if (
          this.config.indexing.fallbackToTextOnMaxChunks &&
          chunksToProcess.length > this.config.indexing.maxChunksPerFile
        ) {
          const content = contentByPath.get(parsed.path);
          if (content !== undefined) {
            chunksToProcess = parseFileAsText(parsed.path, content, this.config.indexing.linesPerChunk);
          }
        }
        chunksToProcess = selectIndexableChunks(
          chunksToProcess,
          this.config.indexing.maxChunksPerFile,
          this.config.indexing.semanticOnly,
        );
        for (const chunk of chunksToProcess) {
          const texts = createEmbeddingTexts(chunk, parsed.path, maxChunkTokens);
          // Count one per source chunk (matches stats.indexedChunks); a chunk may
          // split into multiple embedding texts, which are summed into tokensToEmbed.
          chunksCount += 1;
          for (const text of texts) {
            tokensToEmbed += estimateTokens(text);
          }
        }
      }
    }

    return { filesCount, chunksCount, tokensToEmbed };
  }

  async index(onProgress?: ProgressCallback): Promise<IndexStats> {
    return this.withIndexMutationLease("index", async (recoveredOwners) => {
      return this.indexUnlocked(onProgress, recoveredOwners);
    });
  }

  private getLocalModuleResolutionState(files: readonly { path: string }[]): LocalModuleResolutionState {
    const loadFileText = (configPath: string): string | undefined => {
      try {
        return readFileSync(path.join(this.materializedProjectRoot, ...configPath.split("/")), "utf-8");
      } catch {
        return undefined;
      }
    };
    const pathAliasCache = new TsConfigPathAliasCache(loadFileText);
    const importerPaths = files.flatMap((file) => {
      if (!isPathWithinRoot(file.path, this.materializedProjectRoot)) return [];
      const relativePath = path.relative(this.materializedProjectRoot, file.path).split(path.sep).join("/");
      return isJavaScriptFamilyFilePath(relativePath) ? [relativePath] : [];
    });
    const workspaceManifestPaths = getLocalWorkspacePackageManifestPaths(importerPaths, loadFileText);
    const workspacePackages = getLocalWorkspacePackages(importerPaths, loadFileText);
    const configHash = hashContent(JSON.stringify({
      tsconfig: pathAliasCache.getConfigState(importerPaths),
      packageManifests: workspaceManifestPaths.map((manifestPath) => [
        manifestPath,
        loadFileText(manifestPath) ?? null,
      ]),
    }));

    return { configHash, pathAliasCache, workspacePackages };
  }

  async indexBranchIfMissing(
    branch: string,
    commit: string,
    onProgress?: ProgressCallback,
  ): Promise<BranchIndexResult> {
    if (!isFullGitCommit(commit)) {
      throw new Error(`Branch commit is invalid: ${JSON.stringify(commit)}`);
    }
    const normalizedCommit = commit.toLowerCase();
    if (this.expectedCommitOverride && normalizedCommit !== this.expectedCommitOverride) {
      throw new Error(
        `Prepared branch commit ${normalizedCommit} does not match authoritative commit ${this.expectedCommitOverride}.`,
      );
    }
    if (branch !== this.currentBranch && this.initializationMode !== "none") {
      throw new Error(
        `Prepared Indexer branch mismatch: expected ${JSON.stringify(branch)}, got ${JSON.stringify(this.currentBranch)}.`,
      );
    }

    return this.withIndexMutationLease("index", async (recoveredOwners) => {
      const { database } = await this.ensureInitializedUnlocked(recoveredOwners);
      if (branch !== this.currentBranch) {
        throw new Error(
          `Prepared Indexer branch mismatch: expected ${JSON.stringify(branch)}, got ${JSON.stringify(this.currentBranch)}.`,
        );
      }
      const branchKey = this.getBranchCatalogKey();
      const alreadyIndexed = database.getBranchChunkIds(branchKey).length > 0
        && database.getBranchSymbolIds(branchKey).length > 0;
      const migrationsCurrent = this.areBranchMigrationVersionsCurrent(database);
      if (alreadyIndexed && migrationsCurrent && this.getStoredBranchCommit(database) === normalizedCommit) {
        return { prepared: false };
      }

      const stats = await this.indexUnlocked(onProgress, [], true);
      return { prepared: true, stats };
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
    const materializedCommit = isGitRepo(this.materializedProjectRoot)
      ? await resolveLocalGitCommit(this.materializedProjectRoot, "HEAD")
      : null;
    if (this.expectedCommitOverride && materializedCommit !== this.expectedCommitOverride) {
      throw new Error(
        `Materialized repository HEAD ${materializedCommit ?? "did not resolve"}; expected ${this.expectedCommitOverride}.`,
      );
    }
    const indexedCommit = this.expectedCommitOverride ?? materializedCommit;
    const scopedRoots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const branchCatalogKey = this.getBranchCatalogKey();
    const previousBranchChunkIds = database.getBranchChunkIds(branchCatalogKey);
    const previousBranchChunkIdSet = new Set(previousBranchChunkIds);
    const previousBranchSymbolIds = database.getBranchSymbolIds(branchCatalogKey);
    const previousBranchSymbolIdSet = new Set(previousBranchSymbolIds);
    const restrictExistingChunksToBranch = this.branchNameOverride !== undefined
      || previousBranchChunkIds.length > 0
      || database.getAllBranches().length > 0;
    const forceScopedReembed = scopedRoots !== null && database.getMetadata(this.getProjectForceReembedMetadataKey()) === "true";
    const failedForcedChunkIds = new Set<string>();

    if (!this.indexCompatibility?.compatible) {
      throw new Error(
        `${this.indexCompatibility?.reason} ` +
        `Run index_codebase with force=true to rebuild the index.`,
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

    onProgress?.({
      phase: "scanning",
      filesProcessed: 0,
      totalFiles: 0,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    this.loadFileHashCache();

    const swiftParserMetadataKey = this.getSwiftParserVersionMetadataKey();
    const reparseCachedSwiftFiles = database.getMetadata(swiftParserMetadataKey) !== SWIFT_PARSER_VERSION;
    const metalParserMetadataKey = this.getMetalParserVersionMetadataKey();
    const reparseCachedMetalFiles = database.getMetadata(metalParserMetadataKey) !== METAL_PARSER_VERSION;
    const symbolExtractorMetadataKey = this.getSymbolExtractorVersionMetadataKey();
    const refreshCachedSymbols = database.getMetadata(symbolExtractorMetadataKey) !== SYMBOL_EXTRACTOR_VERSION;
    if (
      reparseCachedSwiftFiles &&
      Array.from(this.fileHashCache.keys()).some((filePath) => path.extname(filePath).toLowerCase() === ".swift")
    ) {
      this.logger.info("Reindexing cached Swift files for parser support");
    }
    if (
      reparseCachedMetalFiles &&
      Array.from(this.fileHashCache.keys()).some((filePath) => path.extname(filePath).toLowerCase() === ".metal")
    ) {
      this.logger.info("Reindexing cached Metal files for parser support");
    }

    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files, skipped } = await collectFiles(
      this.materializedProjectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.getMaterializedKnowledgeBases(),
      { maxDepth: this.config.indexing.maxDepth, maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory },
    );

    stats.totalFiles = files.length;
    stats.skippedFiles = skipped.map((entry) => ({
      ...entry,
      path: this.toCanonicalFilePath(entry.path),
    }));

    this.logger.recordFilesScanned(files.length);
    this.logger.cache("debug", "Scanning files for changes", {
      totalFiles: files.length,
      skippedFiles: skipped.length,
    });

    const localModuleResolutionState = this.getLocalModuleResolutionState(files);
    this.localModuleResolutionConfigHash = localModuleResolutionState.configHash;

    const changedFileDescriptors: ChangedFileDescriptor[] = [];
    const changedFilePathSet = new Set<string>();
    const allFileDescriptors = new Map<string, ChangedFileDescriptor>();
    const unchangedFilePaths = new Set<string>();
    const currentFileHashes = new Map<string, string>();
    const currentStoredFilePaths = new Set(files.map((file) => this.toStoredFilePath(file.path)));
    const needsCallGraphResolutionMigration =
      database.getMetadata(this.getCallGraphResolutionMetadataKey()) !== CALL_GRAPH_RESOLUTION_VERSION;
    const localModuleResolutionConfigChanged =
      database.getMetadata(this.getLocalModuleResolutionConfigMetadataKey())
      !== this.localModuleResolutionConfigHash;
    let javaScriptGraphSourcesChanged = Array.from(this.fileHashCache.keys()).some((filePath) =>
      (!scopedRoots || this.isFileInCurrentScope(filePath, scopedRoots))
      && isJavaScriptFamilyFilePath(filePath)
      && !currentStoredFilePaths.has(filePath)
    );
    const changedGoPackageDirectories = new Set(
      Array.from(this.fileHashCache.keys()).flatMap((filePath) =>
        (!scopedRoots || this.isFileInCurrentScope(filePath, scopedRoots))
          && isGoFilePath(filePath)
          && !currentStoredFilePaths.has(filePath)
          ? [path.posix.dirname(filePath.split(path.sep).join("/"))]
          : []
      ),
    );

    for (const file of files) {
      const storedPath = this.toStoredFilePath(file.path);
      let currentHash: string;
      try {
        currentHash = hashFile(file.path);
      } catch (error) {
        // A file that is unreadable at the OS level (e.g., an LSM denial that
        // returns EPERM despite readable mode bits, or a permissions error)
        // must not abort the whole index. The hash step opens the file; a bare
        // throw here previously tore down the entire run. Skip the file and
        // continue so the remaining files index.
        stats.skippedFiles.push({ path: this.toCanonicalFilePath(file.path), reason: "unreadable" });
        this.logger.warn("Skipped unreadable file during indexing", {
          path: file.path,
          error: getErrorMessage(error),
        });
        continue;
      }
      currentFileHashes.set(storedPath, currentHash);
      const descriptor: ChangedFileDescriptor = {
        storedPath,
        materializedPath: file.path,
        hash: currentHash,
        sourceBytes: file.size,
      };
      allFileDescriptors.set(storedPath, descriptor);

      const cachedHashMatches = this.fileHashCache.get(storedPath) === currentHash;
      if (!cachedHashMatches && isJavaScriptFamilyFilePath(storedPath)) {
        javaScriptGraphSourcesChanged = true;
      }
      if (!cachedHashMatches && isGoFilePath(storedPath)) {
        changedGoPackageDirectories.add(path.posix.dirname(storedPath.split(path.sep).join("/")));
      }
      const needsCallGraphRefresh = cachedHashMatches
        && (
          (
            (needsCallGraphResolutionMigration || localModuleResolutionConfigChanged)
            && (
              isJavaScriptFamilyFilePath(storedPath)
              || database.getChunksByFile(storedPath).some((chunk) =>
                chunk.language === "php" || chunk.language === "c" || chunk.language === "cpp"
              )
            )
          )
          || (needsCallGraphResolutionMigration && isGoFilePath(storedPath))
        );
      const requiresSwiftParserUpgrade =
        reparseCachedSwiftFiles && path.extname(storedPath).toLowerCase() === ".swift";
      const requiresMetalParserUpgrade =
        reparseCachedMetalFiles && path.extname(storedPath).toLowerCase() === ".metal";
      const inMigrationScope =
        forceScopedReembed && scopedRoots !== null && this.isFileInCurrentScope(storedPath, scopedRoots);

      if (
        cachedHashMatches
        && !inMigrationScope
        && !needsCallGraphRefresh
        && !requiresSwiftParserUpgrade
        && !requiresMetalParserUpgrade
        && !refreshCachedSymbols
      ) {
        unchangedFilePaths.add(storedPath);
      } else {
        changedFileDescriptors.push(descriptor);
        changedFilePathSet.add(storedPath);
      }
    }

    if (javaScriptGraphSourcesChanged) {
      for (const [storedPath, descriptor] of allFileDescriptors) {
        if (!isJavaScriptFamilyFilePath(storedPath) || changedFilePathSet.has(storedPath)) continue;
        unchangedFilePaths.delete(storedPath);
        changedFileDescriptors.push(descriptor);
        changedFilePathSet.add(storedPath);
      }
    }

    if (changedGoPackageDirectories.size > 0) {
      for (const [storedPath, descriptor] of allFileDescriptors) {
        const normalizedStoredPath = storedPath.split(path.sep).join("/");
        if (
          !isGoFilePath(normalizedStoredPath)
          || !changedGoPackageDirectories.has(path.posix.dirname(normalizedStoredPath))
          || changedFilePathSet.has(storedPath)
        ) {
          continue;
        }
        unchangedFilePaths.delete(storedPath);
        changedFileDescriptors.push(descriptor);
        changedFilePathSet.add(storedPath);
      }
    }

    for (const storedPath of allFileDescriptors.keys()) {
      if (changedFilePathSet.has(storedPath)) {
        this.logger.recordCacheMiss();
      } else {
        this.logger.recordCacheHit();
      }
    }

    this.logger.cache("info", "File hash cache results", {
      unchanged: unchangedFilePaths.size,
      changed: changedFileDescriptors.length,
    });

    onProgress?.({
      phase: "parsing",
      filesProcessed: unchangedFilePaths.size,
      totalFiles: files.length,
      chunksProcessed: 0,
      totalChunks: 0,
    });

    const existingChunks = new Map<string, string>();
    const existingChunksByFile = new Map<string, Set<string>>();
    const existingMetadataById = new Map<string, ChunkMetadata>();
    for (const { key, metadata } of store.getAllMetadata()) {
      if (scopedRoots && !this.isFileInCurrentScope(metadata.filePath, scopedRoots)) {
        continue;
      }
      if (
        restrictExistingChunksToBranch &&
        this.isFileInProjectRoot(metadata.filePath) &&
        !previousBranchChunkIdSet.has(key)
      ) {
        continue;
      }
      if (forceScopedReembed && scopedRoots && this.isFileInCurrentScope(metadata.filePath, scopedRoots)) {
        continue;
      }
      existingChunks.set(key, metadata.hash);
      existingMetadataById.set(key, metadata);
      const fileChunks = existingChunksByFile.get(metadata.filePath) ?? new Set<string>();
      fileChunks.add(key);
      existingChunksByFile.set(metadata.filePath, fileChunks);
    }

    const currentChunkIds = new Set<string>();
    const allSymbolIds = new Set<string>();
    const failedChunkIds = new Set<string>();
    const retryableChunksWithExistingData = new Set<string>();
    const gitBlameEnabled = this.config.indexing.gitBlame.enabled && isGitRepo(this.materializedProjectRoot);
    let backfilledBlameMetadata = false;

    for (const filePath of unchangedFilePaths) {
      const fileChunks = existingChunksByFile.get(filePath);
      if (fileChunks) {
        for (const chunkId of fileChunks) {
          currentChunkIds.add(chunkId);
        }
      }
    }

    const shouldRetryFailedPath = (filePath: string | null): boolean =>
      filePath !== null
      && !this.isStoredPathExcluded(filePath)
      && currentFileHashes.has(filePath)
      && unchangedFilePaths.has(filePath);
    const failedProcessing = this.prepareFailedBatchProcessing(scopedRoots, shouldRetryFailedPath);
    const maxChunkTokens = getSafeEmbeddingChunkTokenLimit(configuredProviderInfo);
    const providerRateLimits = this.getProviderRateLimits(configuredProviderInfo.provider);
    const queue = new PQueue({
      concurrency: providerRateLimits.concurrency,
      interval: providerRateLimits.intervalMs,
      intervalCap: providerRateLimits.concurrency,
    });
    const rateLimitState: EmbeddingRateLimitState = { backoffMs: 0 };
    const sourceDescriptorsByPath = new Map(
      [...allFileDescriptors.values()].map((descriptor) => [
        descriptor.storedPath.split(path.sep).join("/"),
        descriptor,
      ]),
    );
    const localModuleResolver = new LocalModuleCallResolver({
      filePaths: [...sourceDescriptorsByPath.keys()],
      loadModule: async (filePath) => {
        const descriptor = sourceDescriptorsByPath.get(filePath);
        if (!descriptor) return undefined;
        const content = await fsPromises.readFile(descriptor.materializedPath, "utf-8");
        if (unchangedFilePaths.has(descriptor.storedPath)) {
          const symbols = database.getSymbolsByFile(descriptor.storedPath).filter((symbol) =>
            !restrictExistingChunksToBranch || previousBranchSymbolIdSet.has(symbol.id)
          );
          return { content, symbols };
        }

        const parsed = parseFiles(
          [{ path: descriptor.storedPath, content }],
          this.config.indexing.linesPerChunk,
        )[0];
        return {
          content,
          symbols: parsed ? this.buildCallGraphSymbols(parsed, descriptor.hash) : [],
        };
      },
      pathAliasesForImporter: (filePath) => {
        if (path.isAbsolute(filePath)) {
          const materializedPath = this.toMaterializedFilePath(filePath);
          if (!isPathWithinRoot(materializedPath, this.materializedProjectRoot)) return undefined;
          const relativePath = path.relative(this.materializedProjectRoot, materializedPath).split(path.sep).join("/");
          return localModuleResolutionState.pathAliasCache.getPathAliasesForImporter(relativePath);
        }
        return localModuleResolutionState.pathAliasCache.getPathAliasesForImporter(filePath);
      },
      workspacePackages: localModuleResolutionState.workspacePackages,
    });
    let writeTransactionActive = false;

    try {
      database.beginWriteTransaction();
      writeTransactionActive = true;

      const blameChunkDataBatch: ChunkData[] = [];
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

          const blame = await getChunkGitBlame(
            this.materializedProjectRoot,
            this.toMaterializedFilePath(chunk.filePath),
            chunk.startLine,
            chunk.endLine,
          );
          const blameMetadata = metadataFromBlame(blame);
          if (!blameMetadata.blameSha) {
            continue;
          }

          blameChunkDataBatch.push({
            ...chunk,
            blameSha: blameMetadata.blameSha,
            blameAuthor: blameMetadata.blameAuthor,
            blameAuthorEmail: blameMetadata.blameAuthorEmail,
            blameCommittedAt: blameMetadata.blameCommittedAt,
            blameSummary: blameMetadata.blameSummary,
          });
          const embeddingBuffer = database.getEmbedding(chunk.contentHash);
          if (embeddingBuffer) {
            backfillItems.push({
              id: chunkId,
              vector: Array.from(bufferToFloat32Array(embeddingBuffer)),
              metadata: { ...metadata, ...blameMetadata },
            });
          }
        }

        if (blameChunkDataBatch.length > 0) {
          database.upsertChunksBatch(blameChunkDataBatch);
        }
        if (backfillItems.length > 0) {
          store.addBatch(backfillItems);
          backfilledBlameMetadata = true;
        }
      }

      for (const filePath of unchangedFilePaths) {
        for (const symbol of database.getSymbolsByFile(filePath)) {
          if (!restrictExistingChunksToBranch || previousBranchSymbolIdSet.has(symbol.id)) {
            allSymbolIds.add(symbol.id);
          }
        }
      }

      let processedChangedFiles = 0;
      let lastCheckpointChunks = 0;
      const committedFilePaths = new Set<string>(unchangedFilePaths);
      const resolvedRetryChunkIds = new Set<string>();
      for (const descriptorBatch of iterateOrderedFileBatches(
        changedFileDescriptors,
        (descriptor) => descriptor.sourceBytes,
        this.fileBatchLimits,
      )) {
        const loadedFiles = await Promise.all(descriptorBatch.map(async (descriptor) => ({
          path: descriptor.storedPath,
          content: await fsPromises.readFile(descriptor.materializedPath, "utf-8"),
          hash: descriptor.hash,
        })));
        const loadedByPath = new Map(loadedFiles.map((file) => [file.path, file]));
        const descriptorByPath = new Map(descriptorBatch.map((descriptor) => [descriptor.storedPath, descriptor]));
        const parseStartTime = performance.now();
        const parsedFiles = parseFiles(loadedFiles, this.config.indexing.linesPerChunk);
        const parseMs = performance.now() - parseStartTime;
        this.logger.recordFilesParsed(parsedFiles.length);
        this.logger.recordParseDuration(parseMs);
        this.logger.debug("Parsed changed file batch", {
          parsedCount: parsedFiles.length,
          parseMs: parseMs.toFixed(2),
        });

        const chunkDataBatch: ChunkData[] = [];
        const pendingChunks: PendingChunk[] = [];
        const symbolBatch: SymbolData[] = [];
        const symbolBatchIds = new Set<string>();
        const edgeBatch: CallEdgeData[] = [];

        for (const parsed of parsedFiles) {
          const loadedFile = loadedByPath.get(parsed.path);
          const descriptor = descriptorByPath.get(parsed.path);
          if (!loadedFile || !descriptor) {
            throw new Error(`Parsed file was not present in its source batch: ${parsed.path}`);
          }

          if (parsed.chunks.length === 0) {
            stats.parseFailures.push(path.isAbsolute(parsed.path)
              ? path.relative(this.projectRoot, parsed.path)
              : parsed.path);
          }

          let chunksToProcess = parsed.chunks;
          if (
            this.config.indexing.fallbackToTextOnMaxChunks &&
            chunksToProcess.length > this.config.indexing.maxChunksPerFile
          ) {
            chunksToProcess = parseFileAsText(parsed.path, loadedFile.content, this.config.indexing.linesPerChunk);
          }
          chunksToProcess = selectIndexableChunks(
            chunksToProcess,
            this.config.indexing.maxChunksPerFile,
            this.config.indexing.semanticOnly,
          );

          for (const chunk of chunksToProcess) {
            const id = this.getPreparedChunkId(generateChunkId(parsed.path, chunk));
            const contentHash = generateChunkHash(chunk);
            const existingContentHash = existingChunks.get(id);
            const existingChunk = gitBlameEnabled ? database.getChunk(id) : null;
            const blame = gitBlameEnabled && existingContentHash !== contentHash
              ? await getChunkGitBlame(
                  this.materializedProjectRoot,
                  descriptor.materializedPath,
                  chunk.startLine,
                  chunk.endLine,
                )
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

            const texts = createEmbeddingTexts(chunk, parsed.path, maxChunkTokens).map((text) => ({
              text,
              tokenCount: estimateTokens(text),
            }));
            pendingChunks.push({
              id,
              texts,
              storageText: createPendingChunkStorageText(texts),
              content: chunk.content,
              contentHash,
              metadata: {
                filePath: parsed.path,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
                chunkType: chunk.chunkType,
                name: chunk.name,
                language: chunk.language,
                hash: contentHash,
                ...blameMetadata,
              },
            });
          }

          const fileSymbols = this.buildCallGraphSymbols(parsed, descriptor.hash);
          for (const symbol of fileSymbols) {
            if (!symbolBatchIds.has(symbol.id)) {
              symbolBatch.push(symbol);
              symbolBatchIds.add(symbol.id);
            }
            allSymbolIds.add(symbol.id);
          }
          localModuleResolver.seedModule(parsed.path, {
            content: loadedFile.content,
            symbols: fileSymbols,
          });

          const fileLanguage = parsed.symbols[0]?.language ?? parsed.chunks[0]?.language;
          if (!fileLanguage || !CALL_GRAPH_LANGUAGES.has(fileLanguage)) {
            continue;
          }
          const isCaseInsensitiveLanguage = CASE_INSENSITIVE_LANGUAGES.has(fileLanguage);
          const normalizeSymbolKey = (name: string): string =>
            isCaseInsensitiveLanguage ? name.toLowerCase() : name;
          const symbolsByName = new Map<string, SymbolData[]>();
          for (const symbol of fileSymbols) {
            const key = normalizeSymbolKey(symbol.name);
            const symbols = symbolsByName.get(key) ?? [];
            symbols.push(symbol);
            symbolsByName.set(key, symbols);
          }

          const callSites = extractCalls(loadedFile.content, fileLanguage);
          const classifyGoCall = fileLanguage === "go"
            ? createGoDirectCallClassifier(loadedFile.content, fileSymbols)
            : undefined;
          for (const site of callSites) {
            const enclosingSymbol = findEnclosingSymbol(fileSymbols, site.line, site.column);
            if (!enclosingSymbol) {
              continue;
            }

            const isSupportedGoCall = classifyGoCall?.(site) ?? false;
            let candidates = symbolsByName.get(normalizeSymbolKey(site.calleeName));
            if (fileLanguage === "go") {
              candidates = isSupportedGoCall
                ? candidates?.filter((candidate) => candidate.kind === "function_declaration")
                : undefined;
            } else if (fileLanguage === "php" && candidates) {
              if (site.callType === "Constructor") {
                candidates = candidates.filter((candidate) => PHP_CLASS_SYMBOL_CHUNK_TYPES.has(candidate.kind));
              } else if (site.callType === "Call") {
                candidates = candidates.filter((candidate) => PHP_FUNCTION_SYMBOL_CHUNK_TYPES.has(candidate.kind));
              }
            }
            candidates = candidates?.filter((symbol) =>
              isCompatibleCFamilyCallTarget(fileLanguage, site.callType, symbol.kind)
            );
            let resolvedTarget = candidates?.length === 1 ? candidates[0] : undefined;
            if (
              !resolvedTarget
              && (!candidates || candidates.length === 0)
              && (isJavaScriptFamilyFilePath(parsed.path) || isSupportedGoCall)
            ) {
              resolvedTarget = await localModuleResolver.resolveCallTarget(
                parsed.path,
                loadedFile.content,
                site,
              );
              if (resolvedTarget && !symbolBatchIds.has(resolvedTarget.id)) {
                symbolBatch.push(resolvedTarget);
                symbolBatchIds.add(resolvedTarget.id);
                allSymbolIds.add(resolvedTarget.id);
              }
            }
            edgeBatch.push({
              id: `edge_${hashContent(
                enclosingSymbol.id + ":" + site.calleeName + ":" + site.line + ":" + site.column,
              ).slice(0, 16)}`,
              fromSymbolId: enclosingSymbol.id,
              targetName: site.calleeName,
              toSymbolId: resolvedTarget?.id,
              callType: site.callType,
              confidence: site.confidence,
              line: site.line,
              col: site.column,
              isResolved: resolvedTarget !== undefined,
            });
          }
        }

        if (chunkDataBatch.length > 0) {
          database.upsertChunksBatch(chunkDataBatch);
        }
        if (symbolBatch.length > 0) {
          database.upsertSymbolsBatch(symbolBatch);
          database.addSymbolsToBranchBatch(
            this.getBranchCatalogKey(),
            symbolBatch.map((symbol) => symbol.id),
          );
        }
        if (edgeBatch.length > 0) {
          database.upsertCallEdgesBatch(edgeBatch);
        }

        processedChangedFiles += descriptorBatch.length;
        stats.totalChunks += pendingChunks.length;
        onProgress?.({
          phase: "parsing",
          filesProcessed: unchangedFilePaths.size + processedChangedFiles,
          totalFiles: files.length,
          chunksProcessed: stats.indexedChunks,
          totalChunks: stats.totalChunks,
        });

        if (pendingChunks.length > 0) {
          onProgress?.({
            phase: "embedding",
            filesProcessed: unchangedFilePaths.size + processedChangedFiles,
            totalFiles: files.length,
            chunksProcessed: stats.indexedChunks,
            totalChunks: stats.totalChunks,
          });
          const batchResult = await this.processPendingChunkBatch(pendingChunks, {
            store,
            provider,
            invertedIndex,
            database,
            configuredProviderInfo,
            queue,
            providerRateLimits,
            rateLimitState,
            failedState: failedProcessing.state,
            attemptCounts: new Map<string, number>(),
            forceReembed: forceScopedReembed,
            reuseCachedEmbeddings: true,
            incrementRepeatedFailures: true,
            onSucceeded: (succeededChunks) => {
              database.addChunksToBranchBatch(
                this.getBranchCatalogKey(),
                succeededChunks.map((chunk) => chunk.id),
              );
            },
            onProgress: (batchProgress) => onProgress?.({
              phase: "embedding",
              filesProcessed: unchangedFilePaths.size + processedChangedFiles,
              totalFiles: files.length,
              chunksProcessed: stats.indexedChunks + batchProgress.indexedChunks,
              totalChunks: stats.totalChunks,
            }),
          });
          stats.indexedChunks += batchResult.indexedChunks;
          stats.failedChunks += batchResult.failedChunks;
          stats.tokensUsed += batchResult.tokensUsed;
          for (const chunkId of batchResult.failedChunkIds) {
            failedChunkIds.add(chunkId);
            if (forceScopedReembed) {
              failedForcedChunkIds.add(chunkId);
            }
          }
        }

        for (const descriptor of descriptorBatch) {
          const existingFileChunks = existingChunksByFile.get(descriptor.storedPath);
          if (!existingFileChunks || existingFileChunks.size === 0) {
            committedFilePaths.add(descriptor.storedPath);
          }
        }
        const checkpointInterval = this.getCheckpointIntervalChunks(stats.totalChunks);
        if (stats.totalChunks - lastCheckpointChunks >= checkpointInterval) {
          lastCheckpointChunks = stats.totalChunks;
          this.checkpointIndexRun(
            database,
            store,
            invertedIndex,
            failedProcessing,
            resolvedRetryChunkIds,
            currentFileHashes,
            committedFilePaths,
            scopedRoots,
            configuredProviderInfo,
          );
        }
      }

      const retryableFailedChunks = this.iterateLatestFailedChunks(
        failedProcessing.latestById,
        scopedRoots,
        shouldRetryFailedPath,
        maxChunkTokens,
      );
      for (const retryBatch of iterateOrderedFileBatches(
        retryableFailedChunks,
        ({ chunk }) => Buffer.byteLength(chunk.content, "utf-8"),
        this.fileBatchLimits,
      )) {
        const pendingChunks = retryBatch.map(({ chunk }) => chunk);
        const attemptCounts = new Map(retryBatch.map(({ chunk, attemptCount }) => [chunk.id, attemptCount]));
        for (const chunk of pendingChunks) {
          currentChunkIds.add(chunk.id);
          if (existingChunks.has(chunk.id)) {
            retryableChunksWithExistingData.add(chunk.id);
          }
        }
        // A failed chunk checkpointed before its embedding attempt has a
        // committed SQLite row only when the parsing phase upserted it; a
        // crash before that checkpoint can leave the row missing while the
        // failed-batches record survives. Restore the row so the retry does
        // not leave a branch reference without chunk metadata.
        this.restoreMissingChunkRows(database, pendingChunks);
        stats.totalChunks += pendingChunks.length;
        onProgress?.({
          phase: "embedding",
          filesProcessed: files.length,
          totalFiles: files.length,
          chunksProcessed: stats.indexedChunks,
          totalChunks: stats.totalChunks,
        });
        const batchResult = await this.processPendingChunkBatch(pendingChunks, {
          store,
          provider,
          invertedIndex,
          database,
          configuredProviderInfo,
          queue,
          providerRateLimits,
          rateLimitState,
          failedState: failedProcessing.state,
          attemptCounts,
          forceReembed: forceScopedReembed,
          reuseCachedEmbeddings: true,
          incrementRepeatedFailures: true,
          forceSingleItemBatches: true,
          onSucceeded: (succeededChunks) => {
            database.addChunksToBranchBatch(
              this.getBranchCatalogKey(),
              succeededChunks.map((chunk) => chunk.id),
            );
            for (const chunk of succeededChunks) {
              failedProcessing.latestById.delete(chunk.id);
              resolvedRetryChunkIds.add(chunk.id);
            }
          },
          onProgress: (batchProgress) => onProgress?.({
            phase: "embedding",
            filesProcessed: files.length,
            totalFiles: files.length,
            chunksProcessed: stats.indexedChunks + batchProgress.indexedChunks,
            totalChunks: stats.totalChunks,
          }),
        });
        stats.indexedChunks += batchResult.indexedChunks;
        stats.failedChunks += batchResult.failedChunks;
        stats.tokensUsed += batchResult.tokensUsed;
        for (const chunkId of batchResult.failedChunkIds) {
          failedChunkIds.add(chunkId);
          if (forceScopedReembed) {
            failedForcedChunkIds.add(chunkId);
          }
        }
        if (stats.totalChunks - lastCheckpointChunks >= this.getCheckpointIntervalChunks(stats.totalChunks)) {
          lastCheckpointChunks = stats.totalChunks;
          this.checkpointIndexRun(
            database,
            store,
            invertedIndex,
            failedProcessing,
            resolvedRetryChunkIds,
            currentFileHashes,
            committedFilePaths,
            scopedRoots,
            configuredProviderInfo,
          );
        }
      }

      const removedChunkIds: string[] = [];
      for (const [chunkId] of existingChunks) {
        if (!currentChunkIds.has(chunkId)) {
          removedChunkIds.push(chunkId);
        }
      }
      const removedCount = removedChunkIds.length;
      stats.existingChunks = currentChunkIds.size - stats.totalChunks;
      stats.removedChunks = removedCount;

      this.logger.recordChunksProcessed(currentChunkIds.size);
      this.logger.recordChunksRemoved(removedCount);
      this.logger.info("Chunk analysis complete", {
        pending: stats.totalChunks,
        existing: stats.existingChunks,
        removed: removedCount,
      });

      if (stats.totalChunks === 0 && removedCount === 0) {
        const removedStoredChunks = this.replaceBranchCatalog(
          store,
          invertedIndex,
          database,
          branchCatalogKey,
          previousBranchChunkIds,
          Array.from(currentChunkIds),
          previousBranchSymbolIds,
          Array.from(allSymbolIds),
        );
        const vectorPath = path.join(this.indexPath, "vectors");
        const shouldFingerprintLegacyPair = !store.hasFingerprint() &&
          existsSync(vectorPath) &&
          existsSync(`${vectorPath}.meta.json`);
        if (backfilledBlameMetadata || shouldFingerprintLegacyPair || removedStoredChunks) {
          store.save();
        }
        if (removedStoredChunks) {
          this.saveInvertedIndex(invertedIndex);
        }
        database.setMetadata(swiftParserMetadataKey, SWIFT_PARSER_VERSION);
        database.setMetadata(metalParserMetadataKey, METAL_PARSER_VERSION);
        database.setMetadata(symbolExtractorMetadataKey, SYMBOL_EXTRACTOR_VERSION);
        this.saveBranchCommit(database, indexedCommit);
        this.saveIndexMetadata(configuredProviderInfo);
        this.indexCompatibility = { compatible: true };
        database.commitWriteTransaction();
        writeTransactionActive = false;
        this.finalizeFailedBatchWriteState(failedProcessing.state, resolvedRetryChunkIds);
        if (scopedRoots) {
          this.replaceScopedFileHashCache(currentFileHashes, scopedRoots);
        } else {
          this.fileHashCache = currentFileHashes;
          this.saveFileHashCache();
        }
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

      if (stats.totalChunks === 0) {
        this.replaceBranchCatalog(
          store,
          invertedIndex,
          database,
          branchCatalogKey,
          previousBranchChunkIds,
          Array.from(currentChunkIds),
          previousBranchSymbolIds,
          Array.from(allSymbolIds),
        );
        store.save();
        this.saveInvertedIndex(invertedIndex);
        database.setMetadata(swiftParserMetadataKey, SWIFT_PARSER_VERSION);
        database.setMetadata(metalParserMetadataKey, METAL_PARSER_VERSION);
        database.setMetadata(symbolExtractorMetadataKey, SYMBOL_EXTRACTOR_VERSION);
        this.saveBranchCommit(database, indexedCommit);
        this.saveIndexMetadata(configuredProviderInfo);
        this.indexCompatibility = { compatible: true };
        database.commitWriteTransaction();
        writeTransactionActive = false;
        this.finalizeFailedBatchWriteState(failedProcessing.state, resolvedRetryChunkIds);
        if (scopedRoots) {
          this.replaceScopedFileHashCache(currentFileHashes, scopedRoots);
        } else {
          this.fileHashCache = currentFileHashes;
          this.saveFileHashCache();
        }
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
        phase: "storing",
        filesProcessed: files.length,
        totalFiles: files.length,
        chunksProcessed: stats.indexedChunks,
        totalChunks: stats.totalChunks,
      });

      const branchChunkIds = Array.from(currentChunkIds).filter((chunkId) => {
        const isNewlyFailed = failedChunkIds.has(chunkId) && !retryableChunksWithExistingData.has(chunkId);
        const isForcedFailed = forceScopedReembed && failedForcedChunkIds.has(chunkId);
        return !isNewlyFailed && !isForcedFailed;
      });
      this.replaceBranchCatalog(
        store,
        invertedIndex,
        database,
        branchCatalogKey,
        previousBranchChunkIds,
        branchChunkIds,
        previousBranchSymbolIds,
        Array.from(allSymbolIds),
      );

      store.save();
      this.saveInvertedIndex(invertedIndex);
      database.commitWriteTransaction();
      writeTransactionActive = false;
      this.finalizeFailedBatchWriteState(failedProcessing.state, resolvedRetryChunkIds);
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
      if (forceScopedReembed) {
        database.setMetadata(this.getProjectMigrationFinalizedMetadataKey(), "true");
      }
      database.setMetadata(swiftParserMetadataKey, SWIFT_PARSER_VERSION);
      database.setMetadata(metalParserMetadataKey, METAL_PARSER_VERSION);
      database.setMetadata(symbolExtractorMetadataKey, SYMBOL_EXTRACTOR_VERSION);
      this.saveBranchCommit(database, indexedCommit);
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
        totalChunks: stats.totalChunks,
      });
      return stats;
    } catch (error) {
      failedProcessing.state.writer.cleanup();
      if (writeTransactionActive) {
        try {
          database.rollbackWriteTransaction();
        } catch (rollbackError) {
          this.logger.error("Failed to roll back indexing database transaction", {
            error: getErrorMessage(rollbackError),
          });
        }
      }
      throw error;
    }
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

  private getBranchPrefilterState(
    database: Database,
    branchChunkIds: Set<string> | null,
  ): {
    hasInitializedBranchCatalog: boolean;
    shouldPrefilterByBranch: boolean;
  } {
    const hasInitializedBranchCatalog = branchChunkIds !== null
      && database.getAllBranches().length > 0;
    return {
      hasInitializedBranchCatalog,
      shouldPrefilterByBranch: branchChunkIds !== null
        && (this.config.scope === "global" || hasInitializedBranchCatalog),
    };
  }

  private searchCandidatesWithAllowedIds<T>(
    initialLimit: number,
    totalCount: number,
    allowedChunkIds: Set<string> | null,
    shouldPrefilter: boolean,
    search: (limit: number) => T[],
    getChunkId: (candidate: T) => string,
  ): T[] {
    const normalizedLimit = Math.max(0, Math.floor(initialLimit));
    if (normalizedLimit === 0) return [];
    if (!shouldPrefilter || !allowedChunkIds) {
      return search(normalizedLimit);
    }

    const targetCount = Math.min(normalizedLimit, allowedChunkIds.size);
    if (targetCount === 0 || totalCount === 0) return [];

    let requestedLimit = Math.min(normalizedLimit, totalCount);
    while (true) {
      const results = search(requestedLimit);
      const allowedResults = results.filter((candidate) => allowedChunkIds.has(getChunkId(candidate)));
      if (
        allowedResults.length >= targetCount
        || results.length < requestedLimit
        || requestedLimit >= totalCount
      ) {
        return allowedResults;
      }

      const nextLimit = Math.min(totalCount, Math.max(requestedLimit + 1, requestedLimit * 2));
      if (nextLimit === requestedLimit) return allowedResults;
      requestedLimit = nextLimit;
    }
  }

  private getTemporalChunkIds(
    database: Database,
    options: Pick<SearchFilterOptions, "blameSince" | "blameUntil"> | undefined,
  ): Set<string> | null {
    if (!options?.blameSince && !options?.blameUntil) return null;

    const since = options.blameSince ? parseBlameTimestamp(options.blameSince, false) : undefined;
    const until = options.blameUntil ? parseBlameTimestamp(options.blameUntil, true) : undefined;
    if (since === null || until === null) {
      return new Set();
    }

    return new Set(database.getChunkIdsByBlameDate(since, until));
  }

  private intersectChunkIdSets(
    first: Set<string> | null,
    second: Set<string> | null,
  ): Set<string> | null {
    if (first === null) return second;
    if (second === null) return first;
    const [smaller, larger] = first.size <= second.size ? [first, second] : [second, first];
    return new Set(Array.from(smaller).filter((chunkId) => larger.has(chunkId)));
  }

  private buildCandidateSnapshot(candidate: RankedCandidate): CandidateSnapshot {
    return {
      id: candidate.id,
      filePath: candidate.metadata.filePath,
      startLine: candidate.metadata.startLine,
      endLine: candidate.metadata.endLine,
      score: candidate.score,
      chunkType: candidate.metadata.chunkType,
      name: candidate.metadata.name,
    };
  }

  private buildCandidateSnapshotList(candidates: RankedCandidate[]): CandidateSnapshot[] {
    return candidates.map((candidate) => this.buildCandidateSnapshot(candidate));
  }

  private searchSemanticCandidates(
    store: VectorStore,
    embedding: number[],
    initialLimit: number,
    branchChunkIds: Set<string> | null,
    shouldPrefilterByBranch: boolean,
    temporalChunkIds: Set<string> | null,
  ): RankedCandidate[] {
    const availableCount = temporalChunkIds?.size ?? store.count();
    if (availableCount === 0) return [];
    const allowedIds = temporalChunkIds === null ? undefined : Array.from(temporalChunkIds);
    return this.searchCandidatesWithAllowedIds(
      Math.min(initialLimit, availableCount),
      availableCount,
      branchChunkIds,
      shouldPrefilterByBranch,
      (requestedLimit) => store.search(embedding, requestedLimit, allowedIds),
      (candidate) => candidate.id,
    );
  }

  async search(
    query: string,
    limit?: number,
    options?: SearchOptions
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
    const prioritizeSourcePaths = sourceIntent || options?.prioritizeSourcePaths === true;
    const identifierHints = extractIdentifierHints(query);
    const candidateLimit = maxResults * (prioritizeSourcePaths ? 12 : 4);

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

    const prefilterStartTime = performance.now();
    let branchChunkIds: Set<string> | null = null;
    let branchSymbolIds: Set<string> | null = null;
    if (filterByBranch && (this.config.scope === "global" || this.currentBranch !== "default")) {
      const branchCatalogKeys = this.getBranchCatalogKeys();
      branchChunkIds = new Set(branchCatalogKeys.flatMap((branchKey) => database.getBranchChunkIds(branchKey)));
      branchSymbolIds = new Set(branchCatalogKeys.flatMap((branchKey) => database.getBranchSymbolIds(branchKey)));
    }
    const temporalChunkIds = this.getTemporalChunkIds(database, options);
    const { hasInitializedBranchCatalog, shouldPrefilterByBranch } =
      this.getBranchPrefilterState(database, branchChunkIds);
    const prefilterMs = performance.now() - prefilterStartTime;

    const vectorStartTime = performance.now();
    const semanticCandidates = embedding
      ? this.searchSemanticCandidates(
          store,
          embedding,
          candidateLimit,
          branchChunkIds,
          shouldPrefilterByBranch,
          temporalChunkIds,
        )
      : [];
    const vectorMs = performance.now() - vectorStartTime;

    const keywordStartTime = performance.now();
    const keywordCandidates = await this.keywordSearch(
      query,
      candidateLimit,
      store,
      invertedIndex,
      branchChunkIds,
      shouldPrefilterByBranch,
      temporalChunkIds,
    );
    const keywordMs = performance.now() - keywordStartTime;

    const scopedSemanticCandidates = semanticCandidates.filter((candidate) =>
      matchesHardSearchFilters(candidate, options, this.projectRoot)
    );
    const scopedKeywordCandidates = keywordCandidates.filter((candidate) =>
      matchesHardSearchFilters(candidate, options, this.projectRoot)
    );

    if (this.config.scope !== "global" && branchChunkIds && !hasInitializedBranchCatalog) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
        branch: this.currentBranch,
      });
    }

    const fusionStartTime = performance.now();
    const rankingHybridWeight = embedding === undefined && fusionStrategy === "weighted"
      ? 1
      : effectiveHybridWeight;
    const combined = rankHybridResults(query, scopedSemanticCandidates, scopedKeywordCandidates, {
      fusionStrategy,
      rrfK,
      rerankTopN,
      limit: maxResults,
      hybridWeight: rankingHybridWeight,
      prioritizeSourcePaths,
    });
    const rerankedCombined = await this.rerankCandidatesWithApi(query, combined, {
      definitionIntent: options?.definitionIntent === true,
      hasIdentifierHints: identifierHints.length > 0,
    });
    const fusionMs = performance.now() - fusionStartTime;

    const rescued = promoteIdentifierMatches(
      query,
      rerankedCombined,
      scopedSemanticCandidates,
      scopedKeywordCandidates,
      database,
      branchChunkIds,
      sourceIntent
    );

    const union = unionCandidates(scopedSemanticCandidates, scopedKeywordCandidates);

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
      branchSymbolIds,
      maxResults,
      union,
      sourceIntent,
      options?.definitionIntent === true && (
        (options.directory?.trim().length ?? 0) > 0 ||
        (options.fileType?.trim().length ?? 0) > 0
      ),
    );

    const prePrimaryLane = mergeTieredResults(deterministicIdentifierLane, identifierLane, maxResults * 4);
    // An explicit definition lookup can resolve to a symbol whose declaration
    // spans more lines than any indexable chunk. Keep that exact symbol ahead
    // of prefix and semantic matches so it is not pushed beyond maxResults.
    const primaryLane = options?.definitionIntent === true
      ? mergeTieredResults(symbolLane, prePrimaryLane, maxResults * 4)
      : mergeTieredResults(prePrimaryLane, symbolLane, maxResults * 4);
    const tiered = mergeTieredResults(primaryLane, rescued, maxResults * 4);
    const hasCodeHints = extractCodeTermHints(query).length > 0 || identifierHints.length > 0;

    const baseFiltered = tiered.filter((r) =>
      matchesSearchFilters(r, options, this.config.search.minScore, this.projectRoot)
    );

    let communityRanked = baseFiltered;
    if (this.config.search.communityBoost > 0) {
      try {
        const sameCommunityCandidateIds = resolveSameCommunityCandidateIds(
          query,
          baseFiltered,
          database,
          this.getBranchCatalogKeys(),
        );
        communityRanked = applyCommunityBoost(
          baseFiltered,
          sameCommunityCandidateIds,
          this.config.search.communityBoost,
        );
      } catch (error) {
        this.logger.search("debug", "Community-aware ranking unavailable; using existing ranking", {
          query,
          error: getErrorMessage(error),
        });
      }
    }

    const implementationOnly = communityRanked.filter((r) =>
      isLikelyImplementationPath(r.metadata.filePath) &&
      isImplementationChunkType(r.metadata.chunkType)
    );

    const filtered = (sourceIntent && hasCodeHints && implementationOnly.length > 0
      ? implementationOnly
      : communityRanked
    ).slice(0, maxResults);

    const identifierFallback = (!options?.definitionIntent && filtered.length === 0 && identifierHints.length > 0)
      ? buildSymbolDefinitionLane(query, database, branchChunkIds, branchSymbolIds, maxResults, union, true)
        .filter((r) => matchesSearchFilters(r, options, this.config.search.minScore, this.projectRoot))
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

    if (options?.trace) {
      options.trace({
        semanticCandidates: this.buildCandidateSnapshotList(scopedSemanticCandidates),
        keywordCandidates: this.buildCandidateSnapshotList(scopedKeywordCandidates),
        hybridCandidates: this.buildCandidateSnapshotList(combined),
        postExternalRerankCandidates: this.buildCandidateSnapshotList(rerankedCombined),
        tieredCandidates: this.buildCandidateSnapshotList(tiered),
        finalCandidates: this.buildCandidateSnapshotList(finalResults),
      });
    }

    const metadataOnly = options?.metadataOnly ?? false;

    return Promise.all(
      finalResults.map(async (r) => {
        let content = "";
        let contextStartLine = r.metadata.startLine;
        let contextEndLine = r.metadata.endLine;
        const resolvedFilePath = this.resolveStoredFilePath(r.metadata.filePath);

        if (!metadataOnly && this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              resolvedFilePath,
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
          filePath: resolvedFilePath,
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
    branchChunkIds: Set<string> | null = null,
    shouldPrefilterByBranch = false,
    temporalChunkIds: Set<string> | null = null,
  ): Promise<Array<{ id: string; score: number; metadata: ChunkMetadata }>> {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) return [];

    const allowedChunkIds = this.intersectChunkIdSets(
      shouldPrefilterByBranch ? branchChunkIds : null,
      temporalChunkIds,
    );
    const scoreEntries = this.searchCandidatesWithAllowedIds(
      normalizedLimit,
      invertedIndex.getDocumentCount(),
      allowedChunkIds,
      allowedChunkIds !== null,
      (requestedLimit) => Array.from(invertedIndex.search(query, requestedLimit)),
      ([chunkId]) => chunkId,
    );
    const scores = new Map(scoreEntries);

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
    return results.slice(0, normalizedLimit);
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

  async getIndexFreshness(): Promise<IndexFreshnessResult> {
    const { store, database, readIssues, compatibility } = await this.ensureInitialized();
    const blockingReadIssue = readIssues.some((issue) => issue.blocking);
    if (blockingReadIssue) {
      return { readable: false, current: false, reason: "unreadable" };
    }
    if (store.count() === 0) {
      return { readable: false, current: false, reason: "missing" };
    }
    if (compatibility && !compatibility.compatible) {
      return { readable: true, current: false, reason: "incompatible" };
    }
    if (this.getFailedBatchesCount() > 0) {
      return { readable: true, current: false, reason: "failed-batches" };
    }

    this.fileHashCache.clear();
    this.loadFileHashCache();
    const includePatterns = [...this.config.include, ...this.config.additionalInclude];
    const { files } = await collectFiles(
      this.materializedProjectRoot,
      includePatterns,
      this.config.exclude,
      this.config.indexing.maxFileSize,
      this.getMaterializedKnowledgeBases(),
      {
        maxDepth: this.config.indexing.maxDepth,
        maxFilesPerDirectory: this.config.indexing.maxFilesPerDirectory,
      },
    );
    const localModuleResolutionState = this.getLocalModuleResolutionState(files);
    if (
      database.getMetadata(this.getLocalModuleResolutionConfigMetadataKey())
      !== localModuleResolutionState.configHash
    ) {
      return { readable: true, current: false, reason: "metadata-changed" };
    }
    const currentFileHashes = new Map<string, string>();
    for (const file of files) {
      let hash: string;
      try {
        hash = hashFile(file.path);
      } catch (error) {
        // An unreadable file (OS-level EPERM/EACCES) makes freshness unknowable;
        // treat the index as not-current so the next index_codebase run rebuilds
        // (which skips unreadable files) instead of aborting here.
        this.logger.warn("Skipped unreadable file during freshness check", {
          path: file.path,
          error: getErrorMessage(error),
        });
        return { readable: false, current: false, reason: "unreadable" };
      }
      currentFileHashes.set(this.toStoredFilePath(file.path), hash);
    }

    const scopedRoots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const cachedFileHashes = scopedRoots
      ? new Map(Array.from(this.fileHashCache).filter(([filePath]) => this.isFileInCurrentScope(filePath, scopedRoots)))
      : this.fileHashCache;
    if (cachedFileHashes.size !== currentFileHashes.size) {
      return { readable: true, current: false, reason: "files-changed" };
    }
    for (const [filePath, currentHash] of currentFileHashes) {
      if (cachedFileHashes.get(filePath) !== currentHash) {
        return { readable: true, current: false, reason: "files-changed" };
      }
    }

    if (!this.areBranchMigrationVersionsCurrent(database)) {
      return { readable: true, current: false, reason: "migration-required" };
    }

    if (isGitRepo(this.materializedProjectRoot)) {
      const currentCommit = await resolveLocalGitCommit(this.materializedProjectRoot, "HEAD");
      if (this.getStoredBranchCommit(database) !== currentCommit) {
        return { readable: true, current: false, reason: "branch-changed" };
      }
    }

    return { readable: true, current: true, reason: "current" };
  }

  async forceIndex(onProgress?: ProgressCallback): Promise<IndexStats> {
    return this.withIndexMutationLease("force-index", async (recoveredOwners) => {
      await this.ensureInitializedUnlocked(recoveredOwners);
      const recovery = this.beginClearRecoveryState();
      await this.clearIndexUnlocked(recovery.compatibilityDecision);
      this.finishClearRecoveryState();
      return this.indexUnlocked(onProgress, [], true);
    });
  }

  async clearIndex(): Promise<void> {
    await this.withIndexMutationLease("clear", async (recoveredOwners) => {
      await this.ensureInitializedUnlocked(recoveredOwners);
      const recovery = this.beginClearRecoveryState();
      await this.clearIndexUnlocked(recovery.compatibilityDecision);
    });
  }

  private clearGlobalIndexDataUnlocked(projectRoot = this.projectRoot): void {
    const { store, invertedIndex, database } = this.requireLoadedIndexState();
    const clearedBranchKeys = database.getAllBranches();
    store.clear();
    store.save();
    invertedIndex.clear();
    this.saveInvertedIndex(invertedIndex);

    this.fileHashCache.clear();
    this.saveFileHashCache();

    database.clearAllIndexedData();
    this.deleteBranchCommitMetadata(database, clearedBranchKeys);
    this.clearFailedBatchState();

    database.deleteMetadata("index.version");
    database.deleteMetadata("index.pathStorageVersion");
    database.deleteMetadata("index.embeddingProvider");
    database.deleteMetadata("index.embeddingModel");
    database.deleteMetadata("index.embeddingDimensions");
    database.deleteMetadata("index.embeddingStrategyVersion");
    const projectIdentityHash = this.getProjectIdentityHash(projectRoot);
    database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey(projectIdentityHash));
    database.deleteMetadata(this.getProjectForceReembedMetadataKey(projectIdentityHash));
    database.deleteMetadata(this.getLegacyMigrationMetadataKey(projectIdentityHash));
    database.deleteMetadata("index.createdAt");
    database.deleteMetadata("index.updatedAt");

    this.indexCompatibility = this.validateIndexCompatibility(this.configuredProviderInfo!);
  }

  private clearGlobalIndexUnlocked(
    projectRoot = this.projectRoot,
    roots = this.getScopedRoots(),
    recoveryDecision?: IndexLockClearRecoveryState["compatibilityDecision"],
  ): void {
    const { store, invertedIndex, database } = this.requireLoadedIndexState();
    store.load();
    invertedIndex.load();
    this.loadFileHashCache();
    const compatibility = this.checkCompatibility();
    const compatibilityDecision = recoveryDecision ?? (
      compatibility.compatible
        ? "compatible"
        : compatibility.code === IncompatibilityCode.EMBEDDING_STRATEGY_MISMATCH
          ? "embedding-strategy-mismatch"
          : "incompatible"
    );
    const allMetadata = store.getAllMetadata();
    const hasForeignData =
      allMetadata.some(({ metadata }) => !this.isFileInCurrentScope(metadata.filePath, roots)) ||
      this.hasForeignScopedBranchData(projectRoot, roots) ||
      this.hasForeignScopedFileHashData(roots) ||
      this.hasForeignScopedFailedBatches(roots);

    if (compatibilityDecision !== "compatible" && hasForeignData) {
      if (compatibilityDecision === "embedding-strategy-mismatch") {
        this.clearSharedIndexProjectData(store, invertedIndex, database, roots, projectRoot);
        this.clearScopedFileHashCache(roots);
        this.clearScopedFailedBatches(roots);
        const projectIdentityHash = this.getProjectIdentityHash(projectRoot);
        database.setMetadata(this.getProjectForceReembedMetadataKey(projectIdentityHash), "true");
        database.deleteMetadata(this.getProjectEmbeddingStrategyMetadataKey(projectIdentityHash));
        database.deleteMetadata(this.getProjectMigrationFinalizedMetadataKey(projectIdentityHash));
        if (projectRoot === this.projectRoot) {
          this.indexCompatibility = { compatible: true };
        }
        return;
      }

      throw new Error(
        `Global index compatibility reset is unsafe because the shared index contains files from other projects. ` +
        `The current global index cannot be force-rebuilt for ${projectRoot} without deleting other repositories' indexed data. ` +
        `Use scope="project" for isolated rebuilds, or manually delete the shared global index if you intend to rebuild all projects.`
      );
    }

    if (!hasForeignData) {
      this.clearGlobalIndexDataUnlocked(projectRoot);
      return;
    }

    this.clearSharedIndexProjectData(store, invertedIndex, database, roots, projectRoot);
    this.clearScopedFileHashCache(roots);
    this.clearScopedFailedBatches(roots);
    if (projectRoot === this.projectRoot) {
      this.indexCompatibility = compatibility;
    }
  }

  private async clearIndexUnlocked(
    recoveryDecision?: IndexLockClearRecoveryState["compatibilityDecision"],
  ): Promise<void> {
    const { store, invertedIndex, database } = this.requireLoadedIndexState();

    if (this.config.scope === "global") {
      this.clearGlobalIndexUnlocked(this.projectRoot, this.getScopedRoots(), recoveryDecision);
      return;
    }

    if (!this.isProjectOwnedIndexPath()) {
      throw new Error(
        "Project-scoped force rebuild is unsafe while using an inherited worktree index. " +
        "Create a local project config boundary before clearing the index."
      );
    }

    const clearedBranchKeys = database.getAllBranches();
    store.clear();
    store.save();
    invertedIndex.clear();
    this.saveInvertedIndex(invertedIndex);

    this.fileHashCache.clear();
    await this.removeProjectRuntimeStateArtifacts();

    // cannot reuse stale chunks, symbols, or embeddings from a prior provider.
    database.clearAllIndexedData();
    this.deleteBranchCommitMetadata(database, clearedBranchKeys);

    database.deleteMetadata("index.version");
    database.deleteMetadata("index.pathStorageVersion");
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

    const missingStoredFilePaths: string[] = [];
    const missingChunkKeys: string[] = [];
    const chunkKeysByRemovedFile = new Map<string, string[]>();

    for (const [filePath, chunkKeys] of filePathsToChunkKeys) {
      if (!existsSync(this.toMaterializedFilePath(filePath))) {
        chunkKeysByRemovedFile.set(filePath, chunkKeys);
        for (const key of chunkKeys) {
          missingChunkKeys.push(key);
        }
        missingStoredFilePaths.push(filePath);
      }
    }

    const branchCatalogKeys = this.getBranchCatalogKeys();
    for (const branchKey of branchCatalogKeys) {
      database.deleteBranchChunksForBranch(branchKey, missingChunkKeys);
    }
    const referencedChunkKeys = new Set(database.getReferencedChunkIds(missingChunkKeys));
    const removedChunkKeys = missingChunkKeys.filter((key) => !referencedChunkKeys.has(key));

    if (removedChunkKeys.length > 0) {
      this.rebuildVectorStoreExcludingChunkIds(store, database, removedChunkKeys);
      for (const key of removedChunkKeys) {
        invertedIndex.removeChunk(key);
      }
      database.deleteChunksByIds(removedChunkKeys);
    }

    const missingSymbolIds = Array.from(new Set(
      missingStoredFilePaths.flatMap((filePath) =>
        database.getSymbolsByFile(filePath).map((symbol) => symbol.id)
      )
    ));
    for (const branchKey of branchCatalogKeys) {
      database.deleteBranchSymbolsForBranch(branchKey, missingSymbolIds);
    }
    const referencedSymbolIds = new Set(database.getReferencedSymbolIds(missingSymbolIds));
    const removedSymbolIds = missingSymbolIds.filter((symbolId) => !referencedSymbolIds.has(symbolId));
    database.clearCallEdgeTargetsForSymbols(removedSymbolIds);

    const removedChunkKeySet = new Set(removedChunkKeys);
    const removedStoredFilePaths = missingStoredFilePaths.filter((filePath) =>
      (chunkKeysByRemovedFile.get(filePath) ?? []).some((key) => removedChunkKeySet.has(key))
    );

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
      removedFiles: removedStoredFilePaths.length,
    });

    return {
      removed: removedCount,
      filePaths: removedStoredFilePaths.map((filePath) => this.resolveStoredFilePath(filePath)),
      gcOrphanEmbeddings,
      gcOrphanChunks,
      gcOrphanSymbols,
      gcOrphanCallEdges,
    };
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
    const shouldProcessFailedPath = (filePath: string | null): boolean =>
      filePath === null || !this.isStoredPathExcluded(filePath);
    const failedProcessing = this.prepareFailedBatchProcessing(roots, shouldProcessFailedPath);

    if (failedProcessing.latestById.size === 0) {
      this.finalizeFailedBatchWriteState(failedProcessing.state);
      return { succeeded: 0, failed: 0, remaining: 0 };
    }

    const queue = new PQueue({ concurrency: 1 });
    const rateLimitState: EmbeddingRateLimitState = { backoffMs: 0 };
    let succeeded = 0;
    let failed = 0;

    try {
      const retryableChunks = this.iterateLatestFailedChunks(
        failedProcessing.latestById,
        roots,
        shouldProcessFailedPath,
        maxChunkTokens,
      );
      for (const retryBatch of iterateOrderedFileBatches(
        retryableChunks,
        ({ chunk }) => Buffer.byteLength(chunk.content, "utf-8"),
        this.fileBatchLimits,
      )) {
        const chunks = retryBatch.map(({ chunk }) => chunk);
        const attemptCounts = new Map(retryBatch.map(({ chunk, attemptCount }) => [chunk.id, attemptCount]));
        // Restore chunk rows that a recovery health check may have collected
        // as orphans: a failed chunk checkpointed before its embedding has a
        // committed SQLite row but no branch association until it succeeds.
        this.restoreMissingChunkRows(database, chunks);
        const batchResult = await this.processPendingChunkBatch(chunks, {
          store,
          provider,
          invertedIndex,
          database,
          configuredProviderInfo,
          queue,
          providerRateLimits,
          rateLimitState,
          failedState: failedProcessing.state,
          attemptCounts,
          forceReembed: false,
          reuseCachedEmbeddings: false,
          incrementRepeatedFailures: false,
          forceSingleItemBatches: true,
          onSucceeded: (succeededChunks) => {
            database.addChunksToBranchBatch(
              this.getBranchCatalogKey(),
              succeededChunks.map((chunk) => chunk.id),
            );
          },
        });
        succeeded += batchResult.indexedChunks;
        failed += batchResult.failedChunks;
      }

      this.finalizeFailedBatchWriteState(failedProcessing.state);
    } catch (error) {
      failedProcessing.state.writer.cleanup();
      throw error;
    }

    const remaining = this.getFailedBatchesCount();
    if (succeeded > 0) {
      store.save();
      this.saveInvertedIndex(invertedIndex);
    }

    if (roots && succeeded > 0 && remaining === 0 && this.hasProjectForceReembedPending()) {
      const migrationFinalized =
        database.getMetadata(this.getProjectMigrationFinalizedMetadataKey()) === "true";
      if (migrationFinalized) {
        database.deleteMetadata(this.getProjectForceReembedMetadataKey());
        this.saveIndexMetadata(configuredProviderInfo);
        this.indexCompatibility = { compatible: true };
      }
    }

    return { succeeded, failed, remaining };
  }

  getFailedBatchesCount(): number {
    const roots = this.config.scope === "global" ? this.getScopedRoots() : null;
    const latestById = new Map<string, FailedChunkRecordMetadata>();
    for (const batch of this.loadSerializedFailedBatches()) {
      for (const rawChunk of batch.chunks) {
        const filePath = getPendingChunkFilePath(rawChunk);
        if (roots && (filePath === null || !this.isFileInCurrentScope(filePath, roots))) {
          continue;
        }
        const chunkId = getPendingChunkId(rawChunk);
        if (!chunkId) {
          continue;
        }
        const existing = latestById.get(chunkId);
        if (!existing || batch.attemptCount >= existing.attemptCount) {
          latestById.set(chunkId, {
            attemptCount: batch.attemptCount,
            error: batch.error,
            lastAttempt: batch.lastAttempt,
            chunks: [rawChunk],
          });
        }
      }
    }
    return new Set(Array.from(latestById.values(), getFailedBatchGroupKey)).size;
  }

  getCurrentBranch(): string {
    return this.currentBranch;
  }

  getBaseBranch(): string {
    return this.baseBranch;
  }

  refreshBranchInfo(): void {
    const previousBranch = this.currentBranch;
    if (isGitRepo(this.materializedProjectRoot)) {
      this.currentBranch = this.branchNameOverride ?? getBranchOrDefault(this.materializedProjectRoot);
      this.baseBranch = getBaseBranch(this.materializedProjectRoot);
    } else {
      this.currentBranch = "default";
      this.baseBranch = "default";
    }

    if (this.currentBranch !== previousBranch) {
      this.refreshRuntimeArtifactPaths();
      this.localModuleResolutionConfigHash = null;
      this.fileHashCache.clear();
      this.loadFileHashCache();
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
      blameSince?: string;
      blameUntil?: string;
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
    const excludedStoredFile = options?.excludeFile
      ? this.toStoredFilePath(options.excludeFile)
      : undefined;

    this.logger.search("debug", "Starting find similar", {
      codeLength: code.length,
      limit,
      filterByBranch,
    });

    const embeddingStartTime = performance.now();
    const { embedding, tokensUsed } = await provider.embedDocument(code);
    const embeddingMs = performance.now() - embeddingStartTime;
    this.logger.recordEmbeddingApiCall(tokensUsed);

    const prefilterStartTime = performance.now();
    let branchChunkIds: Set<string> | null = null;
    if (filterByBranch && (this.config.scope === "global" || this.currentBranch !== "default")) {
      branchChunkIds = new Set(
        this.getBranchCatalogKeys().flatMap((branchKey) => database.getBranchChunkIds(branchKey))
      );
    }
    const temporalChunkIds = this.getTemporalChunkIds(database, options);
    const { hasInitializedBranchCatalog, shouldPrefilterByBranch } =
      this.getBranchPrefilterState(database, branchChunkIds);
    const prefilterMs = performance.now() - prefilterStartTime;

    const vectorStartTime = performance.now();
    const semanticCandidates = this.searchSemanticCandidates(
      store,
      embedding,
      limit * 2,
      branchChunkIds,
      shouldPrefilterByBranch,
      temporalChunkIds,
    );
    const vectorMs = performance.now() - vectorStartTime;

    if (this.config.scope !== "global" && branchChunkIds && !hasInitializedBranchCatalog) {
      this.logger.search("warn", "Branch prefilter skipped because branch catalog is empty", {
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

      if (excludedStoredFile) {
        if (r.metadata.filePath === excludedStoredFile) return false;
      }

      return matchesHardSearchFilters(r, options, this.projectRoot);
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
        const resolvedFilePath = this.resolveStoredFilePath(r.metadata.filePath);

        if (this.config.search.includeContext) {
          try {
            const fileContent = await fsPromises.readFile(
              resolvedFilePath,
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
          filePath: resolvedFilePath,
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
          results.push(this.resolveCallEdgeFilePath(edge));
        }
      }
    }

    return results;
  }

  async getCallersForSymbol(
    symbolId: string,
    targetName: string,
    includeUnresolved: boolean,
    callTypeFilter?: string,
  ): Promise<CallEdgeData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const seen = new Set<string>();
    const results: CallEdgeData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      const branchSymbolIds = new Set(database.getBranchSymbolIds(branchKey));
      if (!branchSymbolIds.has(symbolId)) continue;

      for (const edge of database.getCallersWithContext(targetName, branchKey, callTypeFilter)) {
        const matchesResolvedSymbol = edge.toSymbolId === symbolId;
        const safelyMatchesUnresolvedSymbol = includeUnresolved && !edge.toSymbolId;
        if ((!matchesResolvedSymbol && !safelyMatchesUnresolvedSymbol) || seen.has(edge.id)) continue;

        seen.add(edge.id);
        results.push(this.resolveCallEdgeFilePath(edge));
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
          results.push(this.resolveCallEdgeFilePath(edge));
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

    return shortest.map((hop) => this.resolveFilePathRecord(hop));
  }

  async findCallPathBySymbolIds(
    fromSymbolId: string,
    toSymbolId: string,
    maxDepth = 10,
  ): Promise<PathHopData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    let shortest: PathHopData[] = [];

    for (const branchKey of this.getBranchCatalogKeys()) {
      const symbols = database.getSymbolsForBranch(branchKey);
      const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
      if (!symbolsById.has(fromSymbolId) || !symbolsById.has(toSymbolId)) continue;

      const parentBySymbolId = new Map<string, { parentId: string; callType: string }>();
      const visited = new Set([fromSymbolId]);
      const queue: Array<{ symbolId: string; depth: number }> = [{ symbolId: fromSymbolId, depth: 0 }];
      let queueIndex = 0;
      let found = fromSymbolId === toSymbolId;

      while (!found && queueIndex < queue.length) {
        const current = queue[queueIndex++];
        if (current.depth >= maxDepth) continue;

        const currentSymbol = symbolsById.get(current.symbolId);
        if (!currentSymbol) continue;
        for (const edge of database.getCallees(current.symbolId, branchKey)) {
          let nextSymbolId: string | undefined;

          if (edge.toSymbolId && symbolsById.has(edge.toSymbolId)) {
            nextSymbolId = edge.toSymbolId;
          } else if (edge.toSymbolId === undefined) {
            const caseInsensitive = CASE_INSENSITIVE_LANGUAGES.has(currentSymbol.language);
            const matchingTargets = symbols.filter((candidate) => caseInsensitive
              ? candidate.name.toLowerCase() === edge.targetName.toLowerCase()
              : candidate.name === edge.targetName);
            if (matchingTargets.length === 1) {
              nextSymbolId = matchingTargets[0].id;
            }
          }

          if (!nextSymbolId || visited.has(nextSymbolId)) continue;
          visited.add(nextSymbolId);
          parentBySymbolId.set(nextSymbolId, {
            parentId: current.symbolId,
            callType: edge.callType,
          });

          if (nextSymbolId === toSymbolId) {
            found = true;
            break;
          }

          queue.push({ symbolId: nextSymbolId, depth: current.depth + 1 });
        }
      }

      if (!found) continue;

      const path: PathHopData[] = [];
      let currentSymbolId = toSymbolId;
      while (true) {
        const symbol = symbolsById.get(currentSymbolId);
        if (!symbol) break;
        const parent = parentBySymbolId.get(currentSymbolId);
        path.push({
          symbolId: symbol.id,
          symbolName: symbol.name,
          filePath: symbol.filePath,
          line: symbol.startLine,
          callType: parent?.callType ?? "source",
        });
        if (!parent) break;
        currentSymbolId = parent.parentId;
      }
      path.reverse();

      if (path.length > 0 && (shortest.length === 0 || path.length < shortest.length)) {
        shortest = path;
      }
    }

    return shortest.map((hop) => this.resolveFilePathRecord(hop));
  }

  async getCallGraphSymbols(): Promise<SymbolData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const symbols = new Map<string, SymbolData>();

    for (const branchKey of this.getBranchCatalogKeys()) {
      for (const symbol of database.getSymbolsForBranch(branchKey)) {
        symbols.set(symbol.id, this.resolveFilePathRecord(symbol));
      }
    }

    return [...symbols.values()];
  }

  async getSymbolsForBranch(branch?: string): Promise<SymbolData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = this.resolveBranchCatalogKey(branch);
    return database.getSymbolsForBranch(resolvedBranch)
      .map((symbol) => this.resolveFilePathRecord(symbol));
  }

  async getSymbolsForFiles(filePaths: string[], branch?: string): Promise<SymbolData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = this.resolveBranchCatalogKey(branch);
    const storedFilePaths = filePaths.map((filePath) => this.toStoredFilePath(filePath));
    return database.getSymbolsForFiles(storedFilePaths, resolvedBranch)
      .map((symbol) => this.resolveFilePathRecord(symbol));
  }

  async getTransitiveReachability(
    rootSymbolIds: string[],
    direction: "callers" | "callees",
    maxDepth?: number
  ): Promise<ReachabilityData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const branch = this.getBranchCatalogKey();
    return database.getTransitiveReachability(rootSymbolIds, branch, direction, maxDepth)
      .map((entry) => this.resolveFilePathRecord(entry));
  }

  async detectCommunities(branch?: string, symbolIds?: string[]): Promise<CommunityData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = this.resolveBranchCatalogKey(branch);
    return database.detectCommunities(resolvedBranch, symbolIds)
      .map((entry) => this.resolveFilePathRecord(entry));
  }

  async detectCommunityCouplings(branch?: string): Promise<CommunityCouplingData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = this.resolveBranchCatalogKey(branch);
    return database.detectCommunityCouplings(resolvedBranch).map((entry) => ({
      ...entry,
      relationships: (entry.relationships ?? entry.representativeRelationships ?? []).map((relationship) => ({
        ...relationship,
        fromFilePath: this.resolveStoredFilePath(relationship.fromFilePath),
        toFilePath: this.resolveStoredFilePath(relationship.toFilePath),
      })),
    }));
  }

  async computeCentrality(branch?: string): Promise<CentralityData[]> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const resolvedBranch = this.resolveBranchCatalogKey(branch);
    return database.computeCentrality(resolvedBranch)
      .map((entry) => this.resolveFilePathRecord(entry));
  }

  async getPrImpact(opts: {
    pr?: number;
    branch?: string;
    maxDepth?: number;
    hubThreshold?: number;
    checkConflicts?: boolean;
    direction?: "callers" | "callees" | "both";
  }, onPreparationProgress?: ProgressCallback): Promise<PrImpactResult> {
    const initialState = await this.ensureInitialized();
    let database = initialState.database;
    const { readIssues } = initialState;
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
    const expectedCommit = changedFilesResult.headRef;

    if (opts.pr !== undefined && headRefName === undefined) {
      throw new Error(
        `Could not resolve head branch for PR #${opts.pr}. Run index_codebase on the PR branch first.`,
      );
    }
    if (!expectedCommit || !isFullGitCommit(expectedCommit)) {
      throw new Error("Could not resolve an authoritative full commit OID for impact analysis.");
    }

    const resolvedBranch = opts.pr !== undefined
      ? headRefName
      : opts.branch || this.currentBranch;
    const catalogIdentity = changedFilesResult.catalogIdentity;
    const branchKey = this.getBranchCatalogKeyFor(catalogIdentity);

    let branchSymbols = database.getSymbolsForBranch(branchKey);
    let indexPreparation: NonNullable<PrImpactResult["indexPreparation"]> = {
      prepared: false,
      branch: resolvedBranch || "default",
    };
    const requestedRef = opts.pr !== undefined
      ? expectedCommit
      : headRefName ?? resolvedBranch;
    const storedCommit = this.getStoredBranchCommit(database, catalogIdentity);
    const catalogIdentityMatches = storedCommit === expectedCommit;

    const migrationsCurrent = this.areBranchMigrationVersionsCurrent(database, catalogIdentity);

    if (branchSymbols.length === 0 || !catalogIdentityMatches || !migrationsCurrent) {
      if (!resolvedBranch || resolvedBranch === "default") {
        throw new Error("Run index_codebase first to build the call graph and symbol index for this project.");
      }

      onPreparationProgress?.({
        phase: "scanning",
        filesProcessed: 0,
        totalFiles: 0,
        chunksProcessed: 0,
        totalChunks: 0,
      });
      this.resetLoadedIndexState();
      const materialized = await withMaterializedBranch(
        {
          projectRoot: this.projectRoot,
          branch: resolvedBranch,
          ref: requestedRef,
          expectedCommit,
          pr: opts.pr,
          repository: changedFilesResult.baseRepository,
        },
        async (worktreePath, info) => {
          const branchIndexer = new Indexer(this.projectRoot, this.config, this.host, {
            materializedProjectRoot: worktreePath,
            branchName: resolvedBranch,
            catalogIdentity,
            expectedCommit,
            indexPath: this.indexPath,
          });
          try {
            return await branchIndexer.indexBranchIfMissing(
              resolvedBranch,
              info.commit,
              onPreparationProgress,
            );
          } finally {
            await branchIndexer.close();
          }
        },
      );

      indexPreparation = {
        prepared: materialized.value.prepared,
        branch: resolvedBranch,
        commit: materialized.info.commit,
        source: materialized.info.source,
      };

      const refreshedState = await this.ensureInitialized();
      this.requireReadableComponents(refreshedState.readIssues, "database");
      database = refreshedState.database;
      branchSymbols = database.getSymbolsForBranch(branchKey);
      if (branchSymbols.length === 0) {
        throw new Error(
          `Branch ${JSON.stringify(resolvedBranch)} (catalog ${JSON.stringify(catalogIdentity)}) was indexed but produced no call-graph symbols. `
          + `Available branch catalogs: ${database.getAllBranches().join(", ") || "none"}; `
          + `${database.getBranchChunkIds(branchKey).length} chunks, ${database.getBranchSymbolIds(branchKey).length} symbol IDs. `
          + "Ensure the branch contains a supported source language and is included by the index configuration.",
        );
      }
    }

    const toStoredChangedFiles = (filePaths: readonly string[]): string[] =>
      filePaths.map((filePath) => this.toStoredFilePath(path.resolve(this.projectRoot, filePath)));
    const storedChangedFiles = toStoredChangedFiles(changedFiles);
    const directSymbols = database.getSymbolsForFiles(storedChangedFiles, branchKey);
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
        filePath: this.resolveStoredFilePath(c.filePath),
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
            const otherStored = toStoredChangedFiles(otherChanged.files);
            const prBranchKey = this.getBranchCatalogKeyFor(otherChanged.catalogIdentity);
            const otherSymbols = database.getSymbolsForFiles(otherStored, prBranchKey);
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
      indexPreparation,
      changedFiles,
      directSymbols: directSymbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        filePath: this.resolveStoredFilePath(s.filePath),
      })),
      transitiveCallers: transitiveCallers.map((c) => ({
        id: c.symbolId,
        name: c.symbolName,
        filePath: this.resolveStoredFilePath(c.filePath),
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
          const absoluteFilePath = this.resolveStoredFilePath(filePath);
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
            seenSymbols.set(sym.id, this.resolveFilePathRecord(sym));
          }
        }
      }

      // Gather edges from each symbol
      for (const symbolId of seenSymbols.keys()) {
        for (const edge of database.getCallees(symbolId, branchKey)) {
          if (!seenEdges.has(edge.id)) {
            seenEdges.set(edge.id, this.resolveCallEdgeFilePath(edge));
          }
        }
      }
    }

    const symbols = [...seenSymbols.values()].sort((left, right) =>
      left.filePath.localeCompare(right.filePath)
      || left.startLine - right.startLine
      || left.startCol - right.startCol
      || left.id.localeCompare(right.id)
    );
    const edges = [...seenEdges.values()].sort((left, right) =>
      left.fromSymbolId.localeCompare(right.fromSymbolId)
      || left.line - right.line
      || left.col - right.col
      || left.id.localeCompare(right.id)
    );
    return { symbols, edges };
  }

  async getCallGraphCoverage(): Promise<CallGraphCoverage> {
    const { database, readIssues } = await this.ensureInitialized();
    this.requireReadableComponents(readIssues, "database");
    const symbolsById = new Map<string, SymbolData>();
    const edgesById = new Map<string, CallEdgeData>();

    for (const branchKey of this.getBranchCatalogKeys()) {
      const branchSymbols = database.getSymbolsForBranch(branchKey);
      for (const symbol of branchSymbols) {
        symbolsById.set(symbol.id, symbol);
        for (const edge of database.getCallees(symbol.id, branchKey)) {
          edgesById.set(edge.id, edge);
        }
      }
    }

    return summarizeCallGraphCoverage([...symbolsById.values()], [...edgesById.values()]);
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
    this.configuredProviderInfo = null;
    this.indexCompatibility = null;
    this.initializationMode = "none";
    this.readIssues = [];
    this.readerArtifactFingerprint = null;
    this.writerArtifactFingerprint = null;
    this.readerArtifactRetryAfter.clear();
  }
}
