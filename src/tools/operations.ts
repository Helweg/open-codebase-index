import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import * as path from "path";
import { parseConfig } from "../config/schema.js";
import { getHostProjectConfigRelativePath } from "../config/paths.js";
import type { HostMode } from "../config/host.js";
import type { CallEdgeData, PathHopData, SymbolData } from "../native/index.js";
import { Indexer } from "../indexer/index.js";
import { summarizeCallGraphCoverage } from "../indexer/call-graph-coverage.js";
import { findKnowledgeBasePathIndex, hasMatchingKnowledgeBasePath, resolveKnowledgeBasePath } from "./knowledge-base-paths.js";
import { buildCodeCommunitiesResult } from "./format-communities.js";
import {
  buildArchitectureContext,
  isArchitecturePathInDirectory,
  selectArchitectureFocusedSymbols,
} from "./architecture-context.js";
import { getRecentGitActivityAbortable } from "./visualize/activity.js";
import { transformForVisualization } from "./visualize/transform.js";
import {
  CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT,
  CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD,
  CODE_COMMUNITIES_DEFAULT_LIMIT,
  CODE_COMMUNITIES_MAX_COUPLING_LIMIT,
  CODE_COMMUNITIES_MAX_LIMIT,
  CODE_COMMUNITIES_MIN_COUPLING,
  CODE_COMMUNITIES_MIN_SIZE,
} from "./contracts.js";
import type { SharedArchitectureContextArgs, SharedCodeCommunitiesArgs } from "./contracts.js";
import { calculatePercentage, formatProgressTitle, formatStatus } from "./utils.js";
import type { LogLevel } from "../config/schema.js";
import type { LogEntry } from "../utils/logger.js";
import type { CostEstimate, DryRunEstimate } from "../utils/cost.js";
import type { AutoIndexStatusSnapshot } from "../utils/auto-index.js";
import type { SearchTrace } from "../indexer/index.js";
import {
  formatEffectivenessMetrics,
  getProcessEffectivenessMetrics,
  resetProcessEffectivenessMetrics,
} from "../utils/effectiveness-metrics.js";
import {
  getAutoIndexStatus,
  runCoordinatedIndex,
} from "../utils/auto-index.js";
import { getConfigPath, loadEditableConfig, loadRuntimeConfig, saveConfig } from "./config-state.js";
import {
  AutoIndexRetrievalUnavailableError,
  ensureAutoIndexReadyForRetrieval,
  configCache,
  getIndexBusyResult,
  getIndexerCacheKey,
  getIndexerForProject,
  indexerCache,
  getProjectRoot,
  getSharedIndexer,
  initializeTools,
  isToolEffectivenessEnabled,
  rawEffectivenessMetricsEnabled,
  recordToolEffectiveness,
  refreshIndexerForDirectory,
  safelyCountReturnedTokens,
  safelyRecordToolEffectiveness,
  type IndexBusyResult,
} from "./operation-runtime.js";
import type { OperationControl } from "../utils/operation-control.js";
import {
  raceWithOperationSignal,
  runOperationPhase,
  throwIfOperationAborted,
} from "../utils/operation-control.js";


type SearchResult = Awaited<ReturnType<Indexer["search"]>>[number];
type IndexStats = Awaited<ReturnType<Indexer["index"]>>;
type StatusResult = Awaited<ReturnType<Indexer["getStatus"]>>;
export type IndexStatusResult = StatusResult & { autoIndex: AutoIndexStatusSnapshot };
type HealthCheckResult = Awaited<ReturnType<Indexer["healthCheck"]>>;
type PrImpactResult = Awaited<ReturnType<Indexer["getPrImpact"]>>;
type IndexMessageResult = { kind: "message"; text: string };

type ProgressCb = (title: string, metadata: Record<string, unknown>) => void | Promise<void>;
const MAX_CALL_GRAPH_CANDIDATES = 5;

export interface CallGraphSymbolCandidate {
  filePath: string;
  startLine: number;
  kind: string;
}

export type CallGraphSymbolResolution =
  | {
    status: "resolved";
    name: string;
    symbolId: string;
    filePath: string;
    startLine: number;
    kind: string;
    matchedBy: "name" | "symbolId";
  }
  | {
    status: "ambiguous" | "not_found";
    name: string;
    filePath?: string;
    candidates: CallGraphSymbolCandidate[];
    totalCandidates: number;
    invalidSymbolId?: boolean;
  };

export interface CallGraphDataResult {
  direction: "callers" | "callees";
  resolution: CallGraphSymbolResolution;
  callers: CallEdgeData[];
  callees: CallEdgeData[];
  relationshipType?: string;
}

export interface CallGraphPathResult {
  from: CallGraphSymbolResolution;
  to: CallGraphSymbolResolution;
  path: PathHopData[];
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeCallGraphPath(value: string): string {
  let normalized = path.posix.normalize(value.trim().replaceAll("\\", "/"));
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function isAbsoluteCallGraphPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function filePathMatches(candidatePath: string, requestedPath: string): boolean {
  const candidate = normalizeCallGraphPath(candidatePath);
  const requested = normalizeCallGraphPath(requestedPath);
  if (isAbsoluteCallGraphPath(requested)) {
    return candidate === requested;
  }
  return candidate === requested || candidate.endsWith(`/${requested}`);
}

function displayCallGraphPath(filePath: string, projectRoot: string): string {
  const normalizedFilePath = normalizeCallGraphPath(filePath);
  const normalizedRoot = normalizeCallGraphPath(projectRoot);
  if (normalizedFilePath === normalizedRoot) return ".";
  if (normalizedFilePath.startsWith(`${normalizedRoot}/`)) {
    return normalizedFilePath.slice(normalizedRoot.length + 1);
  }
  return normalizedFilePath;
}

function symbolNameMatches(symbol: SymbolData, requestedName: string): boolean {
  return symbol.language === "apex" || symbol.language === "php"
    ? symbol.name.toLowerCase() === requestedName.toLowerCase()
    : symbol.name === requestedName;
}

export function isExactSymbolQuery(query: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(query.trim());
}

function exactSymbolMatchesScope(
  symbol: SymbolData,
  projectRoot: string,
  options: { fileType?: string; directory?: string },
): boolean {
  const normalizedPath = normalizeCallGraphPath(symbol.filePath);
  const fileType = trimOrUndefined(options.fileType)?.replace(/^\./, "").toLowerCase();
  if (fileType && !normalizedPath.toLowerCase().endsWith(`.${fileType}`)) {
    return false;
  }

  const directory = trimOrUndefined(options.directory);
  if (!directory) return true;
  const normalizedDirectory = normalizeCallGraphPath(directory);
  const absoluteDirectory = isAbsoluteCallGraphPath(normalizedDirectory)
    ? normalizedDirectory
    : normalizeCallGraphPath(path.join(projectRoot, normalizedDirectory));
  return normalizedPath === absoluteDirectory || normalizedPath.startsWith(`${absoluteDirectory}/`);
}

function exactSymbolSearchResults(
  symbols: SymbolData[],
  projectRoot: string,
  query: string,
  options: { limit?: number; fileType?: string; directory?: string },
  signal?: AbortSignal,
): SearchResult[] {
  const name = query.trim();
  const limit = options.limit ?? 5;
  throwIfOperationAborted(signal);
  const matching = symbols.filter((symbol) => {
    throwIfOperationAborted(signal);
    return symbolNameMatches(symbol, name) && exactSymbolMatchesScope(symbol, projectRoot, options);
  });
  throwIfOperationAborted(signal);
  return matching
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine)
    .slice(0, limit)
    .map((symbol) => {
      throwIfOperationAborted(signal);
      let content = "[File not accessible]";
      try {
        content = readFileSync(symbol.filePath, "utf-8")
          .split("\n")
          .slice(symbol.startLine - 1, symbol.endLine)
          .join("\n");
      } catch {
        // Preserve the normal search contract when a stale indexed file is unavailable.
      }
      return {
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        content,
        score: 1,
        chunkType: symbol.kind,
        name: symbol.name,
      };
    });
}

function toCandidate(symbol: SymbolData, projectRoot: string): CallGraphSymbolCandidate {
  return {
    filePath: displayCallGraphPath(symbol.filePath, projectRoot),
    startLine: symbol.startLine,
    kind: symbol.kind,
  };
}

function resolvedSymbol(symbol: SymbolData, projectRoot: string, matchedBy: "name" | "symbolId"): CallGraphSymbolResolution {
  return {
    status: "resolved",
    name: symbol.name,
    symbolId: symbol.id,
    filePath: displayCallGraphPath(symbol.filePath, projectRoot),
    startLine: symbol.startLine,
    kind: symbol.kind,
    matchedBy,
  };
}

function resolveCallGraphSymbol(
  symbols: SymbolData[],
  projectRoot: string,
  requestedName: string,
  requestedFilePath?: string,
  requestedSymbolId?: string,
  signal?: AbortSignal,
): CallGraphSymbolResolution {
  throwIfOperationAborted(signal);
  const name = requestedName.trim();
  const filePath = trimOrUndefined(requestedFilePath);
  const symbolId = trimOrUndefined(requestedSymbolId);

  if (symbolId) {
    const symbol = symbols.find((candidate) => {
      throwIfOperationAborted(signal);
      return candidate.id === symbolId;
    });
    if (symbol) {
      return resolvedSymbol(symbol, projectRoot, "symbolId");
    }
    return {
      status: "not_found",
      name,
      filePath,
      candidates: [],
      totalCandidates: 0,
      invalidSymbolId: true,
    };
  }

  const nameCandidates = symbols.filter((symbol) => {
    throwIfOperationAborted(signal);
    return symbolNameMatches(symbol, name);
  });
  const matchingCandidates = filePath
    ? nameCandidates.filter((symbol) => {
      throwIfOperationAborted(signal);
      return filePathMatches(symbol.filePath, filePath);
    })
    : nameCandidates;

  if (matchingCandidates.length === 1) {
    return resolvedSymbol(matchingCandidates[0], projectRoot, "name");
  }

  const candidates = (matchingCandidates.length > 0 ? matchingCandidates : nameCandidates)
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine);
  return {
    status: matchingCandidates.length > 1 ? "ambiguous" : "not_found",
    name,
    filePath: filePath ? normalizeCallGraphPath(filePath) : undefined,
    candidates: candidates.slice(0, MAX_CALL_GRAPH_CANDIDATES).map((symbol) => toCandidate(symbol, projectRoot)),
    totalCandidates: candidates.length,
  };
}



export async function searchCodebase(
  projectRoot: string | undefined,
  host: HostMode,
  query: string,
  options: {
    limit?: number;
    fileType?: string;
    directory?: string;
    chunkType?: string;
    contextLines?: number;
    metadataOnly?: boolean;
    definitionIntent?: boolean;
    prioritizeSourcePaths?: boolean;
    blameAuthor?: string;
    blameSha?: string;
    blameSince?: string;
    blameUntil?: string;
    trace?: (trace: SearchTrace) => void;
  } = {},
  control?: OperationControl,
): Promise<SearchResult[]> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "embedding_query");
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.search(query, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    chunkType: options.chunkType,
    contextLines: options.contextLines,
    metadataOnly: options.metadataOnly,
    definitionIntent: options.definitionIntent,
    prioritizeSourcePaths: options.prioritizeSourcePaths,
    blameAuthor: options.blameAuthor,
    blameSha: options.blameSha,
    blameSince: options.blameSince,
    blameUntil: options.blameUntil,
    trace: options.trace,
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  });
}

export async function searchCodebaseWithEffectiveness<T>(
  projectRoot: string | undefined,
  host: HostMode,
  route: "peek" | "search",
  query: string,
  options: Parameters<typeof searchCodebase>[3],
  render: (results: SearchResult[]) => { output: T; text: string },
  control?: OperationControl,
): Promise<T> {
  const metricsEnabled = isToolEffectivenessEnabled(projectRoot, host);
  const startedAt = metricsEnabled ? performance.now() : 0;
  try {
    const results = await searchCodebase(projectRoot, host, query, options, control);
    const rendered = render(results);
    if (metricsEnabled) {
      safelyRecordToolEffectiveness({
        route,
        host,
        outcome: results.length > 0 ? "success" : "no-result",
        resultCount: results.length,
        latencyMs: performance.now() - startedAt,
        returnedTokenEstimate: safelyCountReturnedTokens(rendered.text),
        exactHandoffEmitted: rendered.text.includes("Exact-search handoff:"),
        scopeRelaxation: "none",
      });
    }
    return rendered.output;
  } catch (error) {
    if (metricsEnabled) {
      safelyRecordToolEffectiveness({
        route,
        host,
        outcome: "error",
        resultCount: 0,
        latencyMs: performance.now() - startedAt,
        returnedTokenEstimate: 0,
        exactHandoffEmitted: false,
        scopeRelaxation: "none",
      });
    }
    throw error;
  }
}

export async function findSimilarCode(
  projectRoot: string | undefined,
  host: HostMode,
  code: string,
  options: {
    limit?: number;
    fileType?: string;
    directory?: string;
    chunkType?: string;
    excludeFile?: string;
    blameSince?: string;
    blameUntil?: string;
  } = {},
  control?: OperationControl,
): Promise<Awaited<ReturnType<Indexer["findSimilar"]>>> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "embedding_query");
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.findSimilar(code, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    chunkType: options.chunkType,
    excludeFile: options.excludeFile,
    blameSince: options.blameSince,
    blameUntil: options.blameUntil,
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  });
}

export async function implementationLookup(
  projectRoot: string | undefined,
  host: HostMode,
  query: string,
  options: {
    limit?: number;
    fileType?: string;
    directory?: string;
    exactSymbol?: boolean;
    trace?: (trace: SearchTrace) => void;
  } = {},
  control?: OperationControl,
): Promise<SearchResult[]> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, options.exactSymbol ? "resolving_symbol" : "embedding_query");
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  if (options.exactSymbol) {
    const results = exactSymbolSearchResults(
      await indexer.getCallGraphSymbols({
        signal: control?.signal,
        setPhase: control?.setPhase,
        heartbeat: control?.heartbeat,
      }),
      root,
      query,
      options,
      control?.signal,
    );
    throwIfOperationAborted(control?.signal);
    return results;
  }
  return indexer.search(query, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    definitionIntent: true,
    trace: options.trace,
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  });
}

export async function getCallGraphData(
  projectRoot: string | undefined,
  host: HostMode,
  params: {
    name: string;
    direction?: "callers" | "callees";
    symbolId?: string;
    filePath?: string;
    relationshipType?: "Call" | "MethodCall" | "Constructor" | "Import" | "Inherits" | "Implements";
  },
  control?: OperationControl,
): Promise<CallGraphDataResult> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "resolving_graph");
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  const result = await getCallGraphDataForIndexer(indexer, root, params, control);
  throwIfOperationAborted(control?.signal);
  return result;
}

export async function getCallGraphDataForIndexer(
  indexer: Indexer,
  projectRoot: string,
  params: {
    name: string;
    direction?: "callers" | "callees";
    symbolId?: string;
    filePath?: string;
    relationshipType?: "Call" | "MethodCall" | "Constructor" | "Import" | "Inherits" | "Implements";
  },
  control?: OperationControl,
): Promise<CallGraphDataResult> {
  const operationOptions = {
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  };
  const symbols = await indexer.getCallGraphSymbols(operationOptions);
  const resolution = resolveCallGraphSymbol(
    symbols,
    projectRoot,
    params.name,
    params.filePath,
    params.symbolId,
    control?.signal,
  );
  const direction = params.direction === "callees" ? "callees" : "callers";
  if (resolution.status !== "resolved") {
    return { direction, resolution, callers: [], callees: [], relationshipType: params.relationshipType };
  }

  if (params.direction === "callees") {
    const callees = await indexer.getCallees(
      resolution.symbolId,
      params.relationshipType,
      operationOptions,
    );
    return { direction: "callees", resolution, callees, callers: [], relationshipType: params.relationshipType };
  }

  const includeUnresolved = symbols.filter((symbol) => {
    throwIfOperationAborted(control?.signal);
    return symbolNameMatches(symbol, resolution.name);
  }).length === 1;
  const callers = await indexer.getCallersForSymbol(
    resolution.symbolId,
    resolution.name,
    includeUnresolved,
    params.relationshipType,
    operationOptions,
  );
  return { direction: "callers", resolution, callers, callees: [], relationshipType: params.relationshipType };
}

export async function getCallGraphPath(
  projectRoot: string | undefined,
  host: HostMode,
  from: string,
  to: string,
  maxDepth?: number,
  fromFilePath?: string,
  toFilePath?: string,
  control?: OperationControl,
): Promise<CallGraphPathResult> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "resolving_graph");
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  const operationOptions = {
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  };
  const symbols = await indexer.getCallGraphSymbols(operationOptions);
  const fromResolution = resolveCallGraphSymbol(symbols, root, from, fromFilePath, undefined, control?.signal);
  const toResolution = resolveCallGraphSymbol(symbols, root, to, toFilePath, undefined, control?.signal);
  if (fromResolution.status !== "resolved" || toResolution.status !== "resolved") {
    return { from: fromResolution, to: toResolution, path: [] };
  }

  const path = await indexer.findCallPathBySymbolIds(
    fromResolution.symbolId,
    toResolution.symbolId,
    maxDepth,
    operationOptions,
  );
  throwIfOperationAborted(control?.signal);
  return { from: fromResolution, to: toResolution, path };
}

export async function runIndexCodebase(
  projectRoot: string | undefined,
  host: HostMode,
  args: { force?: boolean; estimateOnly?: boolean; dryRun?: boolean; verbose?: boolean },
  onProgress?: ProgressCb,
  control?: OperationControl,
): Promise<
  | { kind: "estimate"; estimate: CostEstimate }
  | { kind: "dryrun"; dryrun: DryRunEstimate }
  | { kind: "stats"; stats: IndexStats; providerError?: import("../utils/operation-control.js").ProviderRequestError }
  | IndexMessageResult
  | IndexBusyResult
> {
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  await runOperationPhase(control, "preparing_index");
  let providerError: import("../utils/operation-control.js").ProviderRequestError | undefined;
  const onProviderError = (error: import("../utils/operation-control.js").ProviderRequestError): void => {
    providerError ??= error;
  };

  try {
    if (args.estimateOnly) {
      const estimate = await raceWithOperationSignal(
        indexer.estimateCost({
          signal: control?.signal,
          setPhase: control?.setPhase,
          heartbeat: control?.heartbeat,
        }),
        control?.signal,
      );
      return { kind: "estimate", estimate };
    }

    if (args.dryRun) {
      const dryrun = await raceWithOperationSignal(
        indexer.dryRunCost({
          signal: control?.signal,
          setPhase: control?.setPhase,
          heartbeat: control?.heartbeat,
        }),
        control?.signal,
      );
      return { kind: "dryrun", dryrun };
    }

    const coordinated = runCoordinatedIndex(root, host, args.force ?? false, (progress) => {
      const percentage = calculatePercentage(progress);
      void control?.reportProgress?.(percentage, progress.phase);
      if (onProgress) {
        void onProgress(formatProgressTitle(progress), {
          phase: progress.phase,
          filesProcessed: progress.filesProcessed,
          totalFiles: progress.totalFiles,
          chunksProcessed: progress.chunksProcessed,
          totalChunks: progress.totalChunks,
          percentage,
        });
      }
    }, control?.signal, control?.heartbeat, onProviderError, control?.setPhase);
    if (!coordinated) {
      const directProgress = (progress: Parameters<NonNullable<Parameters<Indexer["index"]>[0]>>[0]): void => {
        const percentage = calculatePercentage(progress);
        void control?.reportProgress?.(percentage, progress.phase);
        if (onProgress) {
          void onProgress(formatProgressTitle(progress), {
            phase: progress.phase,
            filesProcessed: progress.filesProcessed,
            totalFiles: progress.totalFiles,
            chunksProcessed: progress.chunksProcessed,
            totalChunks: progress.totalChunks,
            percentage,
          });
        }
      };
      const stats = args.force
        ? await indexer.forceIndex(directProgress, {
          signal: control?.signal,
          setPhase: control?.setPhase,
          heartbeat: control?.heartbeat,
          onProviderError,
        })
        : await indexer.index(directProgress, {
          signal: control?.signal,
          setPhase: control?.setPhase,
          heartbeat: control?.heartbeat,
          onProviderError,
        });
      return { kind: "stats", stats, ...(providerError ? { providerError } : {}) };
    }
    const result = await raceWithOperationSignal(coordinated, control?.signal);
    if (result.outcome === "ready" && result.stats) {
      const coordinatedProviderError = providerError ?? result.providerError;
      return {
        kind: "stats",
        stats: result.stats,
        ...(coordinatedProviderError ? { providerError: coordinatedProviderError } : {}),
      };
    }
    if (result.outcome === "ready" && result.skipped) {
      return { kind: "message", text: "The existing index is healthy and current; no indexing was needed." };
    }
    if (result.outcome === "stopped") {
      return { kind: "message", text: "Indexing was stopped or superseded by another coordinated index request. Check index_status and retry if needed." };
    }
    if (result.error) throw result.error;
    throw new Error("Indexing failed without an error result");
  } catch (error) {
    const busyResult = getIndexBusyResult(error);
    if (!busyResult) throw error;
    return busyResult;
  }
}

export async function getIndexStatus(
  projectRoot: string | undefined,
  host: HostMode,
  control?: OperationControl,
): Promise<IndexStatusResult> {
  await runOperationPhase(control, "reading_status");
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  const status = await indexer.getStatus();
  throwIfOperationAborted(control?.signal);
  return {
    ...status,
    autoIndex: getAutoIndexStatus(root, host),
  };
}

export async function getIndexHealthCheck(
  projectRoot: string | undefined,
  host: HostMode,
  control?: OperationControl,
): Promise<HealthCheckResult> {
  await runOperationPhase(control, "checking_index");
  const indexer = getIndexerForProject(projectRoot, host);
  const result = await indexer.healthCheck({
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  });
  throwIfOperationAborted(control?.signal);
  return result;
}

export async function runIndexHealthCheck(
  projectRoot: string | undefined,
  host: HostMode,
  control?: OperationControl,
): Promise<{ kind: "health"; health: HealthCheckResult } | IndexBusyResult> {
  try {
    return { kind: "health", health: await getIndexHealthCheck(projectRoot, host, control) };
  } catch (error) {
    const busyResult = getIndexBusyResult(error);
    if (!busyResult) throw error;
    return busyResult;
  }
}

export async function getPrImpact(
  projectRoot: string | undefined,
  host: HostMode,
  params: {
    pr?: number;
    branch?: string;
    maxDepth?: number;
    hubThreshold?: number;
    checkConflicts?: boolean;
    direction?: "callers" | "callees" | "both";
  },
  control?: OperationControl,
): Promise<PrImpactResult> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "analyzing_impact");
  const indexer = getIndexerForProject(projectRoot, host);
  const result = await indexer.getPrImpact(
    {
      pr: params.pr,
      branch: params.branch,
      maxDepth: params.maxDepth,
      hubThreshold: params.hubThreshold,
      checkConflicts: params.checkConflicts,
      direction: params.direction,
    },
    (progress) => {
      const percentage = calculatePercentage(progress);
      void control?.reportProgress?.(percentage, progress.phase);
    },
    {
      signal: control?.signal,
      setPhase: control?.setPhase,
      heartbeat: control?.heartbeat,
    },
  );
  throwIfOperationAborted(control?.signal);
  return result;
}

export async function getCodeCommunities(
  projectRoot: string | undefined,
  host: HostMode,
  params: SharedCodeCommunitiesArgs,
  control?: OperationControl,
): Promise<import("./format-communities.js").CodeCommunitiesResult> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "analyzing_communities");
  const indexer = getIndexerForProject(projectRoot, host);
  const operationOptions = {
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  };
  const [communities, centrality, couplings] = await Promise.all([
    indexer.detectCommunities(params.branch, undefined, operationOptions),
    indexer.computeCentrality(params.branch, operationOptions),
    indexer.detectCommunityCouplings(params.branch, operationOptions),
  ]);
  throwIfOperationAborted(control?.signal);
  return buildCodeCommunitiesResult(communities, centrality, couplings, {
    minSize: Math.max(CODE_COMMUNITIES_MIN_SIZE, Math.floor(params.minSize ?? CODE_COMMUNITIES_MIN_SIZE)),
    limit: Math.min(
      CODE_COMMUNITIES_MAX_LIMIT,
      Math.max(1, Math.floor(params.limit ?? CODE_COMMUNITIES_DEFAULT_LIMIT)),
    ),
    hubThreshold: Math.max(
      0,
      Math.floor(params.hubThreshold ?? CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD),
    ),
    minCoupling: Math.max(
      CODE_COMMUNITIES_MIN_COUPLING,
      Math.floor(params.minCoupling ?? CODE_COMMUNITIES_MIN_COUPLING),
    ),
    couplingLimit: Math.min(
      CODE_COMMUNITIES_MAX_COUPLING_LIMIT,
      Math.max(1, Math.floor(params.couplingLimit ?? CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT)),
    ),
  });
}

export async function getIndexMetrics(
  projectRoot: string | undefined,
  host: HostMode,
  args: { reset?: boolean } = {},
): Promise<{ enabled: boolean; metricsEnabled: boolean; effectivenessMetricsEnabled: boolean; text: string }> {
  const root = getProjectRoot(projectRoot, host);
  const key = getIndexerCacheKey(root, host);
  const cachedIndexer = indexerCache.get(key);
  let config = configCache.get(key);
  let rawEffectivenessEnabled = false;

  if (args.reset === true) {
    resetProcessEffectivenessMetrics();
    try {
      cachedIndexer?.getLogger().resetMetrics();
    } catch {
      // Effectiveness reset must succeed independently from operational metrics.
    }
  }

  try {
    const rawConfig = loadRuntimeConfig(root, host);
    rawEffectivenessEnabled = rawEffectivenessMetricsEnabled(rawConfig);
    config ??= parseConfig(rawConfig);
    configCache.set(key, config);
  } catch {
    // An explicitly enabled process collector remains viewable and resettable
    // even when unrelated configuration is invalid.
  }

  const resetNotice = args.reset === true ? "Metrics reset.\n\n" : "";
  const effectivenessMetricsEnabled = config?.effectivenessMetrics.enabled ?? rawEffectivenessEnabled;
  const debugEnabled = config?.debug.enabled === true;
  const operationalMetricsEnabled = debugEnabled && config?.debug.metrics === true;

  if (!operationalMetricsEnabled && !effectivenessMetricsEnabled) {
    return {
      enabled: debugEnabled,
      metricsEnabled: false,
      effectivenessMetricsEnabled: false,
      text: `${resetNotice}Metrics collection is disabled. Enable privacy-safe aggregate telemetry without debug logs:\n\n\`\`\`json\n{\n  "effectivenessMetrics": {\n    "enabled": true\n  }\n}\n\`\`\``,
    };
  }

  const sections: string[] = [];
  if (operationalMetricsEnabled) {
    try {
      const logger = cachedIndexer?.getLogger() ?? getIndexerForProject(root, host).getLogger();
      sections.push(logger.formatMetrics());
    } catch {
      sections.push("Operational metrics are unavailable.");
    }
  }
  if (effectivenessMetricsEnabled) {
    sections.push(formatEffectivenessMetrics(getProcessEffectivenessMetrics()));
  }

  return {
    enabled: debugEnabled,
    metricsEnabled: operationalMetricsEnabled,
    effectivenessMetricsEnabled,
    text: `${resetNotice}${sections.join("\n\n")}`,
  };
}

export async function getIndexLogs(
  projectRoot: string | undefined,
  host: HostMode,
  args: { limit?: number; category?: string; level?: LogLevel },
): Promise<{ kind: "disabled"; text: string } | { kind: "entries"; text: string }> {
  const indexer = getIndexerForProject(projectRoot, host);
  const logger = indexer.getLogger();

  if (!logger.isEnabled()) {
    return {
      kind: "disabled",
      text: "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true\n  }\n}\n```",
    };
  }

  let logs: LogEntry[];
  if (args.category) {
    logs = logger.getLogsByCategory(args.category, args.limit);
  } else if (args.level) {
    logs = logger.getLogsByLevel(args.level, args.limit);
  } else {
    logs = logger.getLogs(args.limit);
  }

  if (logs.length === 0) {
    return {
      kind: "entries",
      text: "No logs recorded yet. Logs are captured during indexing and search operations.",
    };
  }

  const text = logs.map((entry) => {
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${dataStr}`;
  }).join("\n");

  return { kind: "entries", text };
}

export function addKnowledgeBase(
  projectRoot: string | undefined,
  host: HostMode,
  knowledgeBasePath: string,
): string {
  const root = getProjectRoot(projectRoot, host);
  const inputPath = knowledgeBasePath.trim();
  const normalizedPath = path.resolve(
    path.isAbsolute(inputPath)
      ? inputPath
      : resolveKnowledgeBasePath(inputPath, root),
  );

  if (!existsSync(normalizedPath)) {
    return `Error: Directory does not exist: ${normalizedPath}`;
  }

  let realPath: string;
  try {
    realPath = realpathSync(normalizedPath);
  } catch {
    return `Error: Cannot resolve path: ${normalizedPath}`;
  }

  const blockedPrefixes = [
    "/etc",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/var/run",
    "/var/log",
  ];
  const homeDir = process.platform === "win32" ? process.env.USERPROFILE ?? "" : process.env.HOME ?? "";
  const sensitiveDotDirs = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gcloud",
    ".docker",
    ".kube",
  ];

  for (const prefix of blockedPrefixes) {
    if (realPath === prefix || realPath.startsWith(`${prefix}/`)) {
      return `Error: Adding sensitive directory as knowledge base is not allowed: ${normalizedPath}`;
    }
  }

  for (const dotDir of sensitiveDotDirs) {
    const sensitiveDir = path.join(homeDir, dotDir);
    if (sensitiveDir && (realPath === sensitiveDir || realPath.startsWith(`${sensitiveDir}/`))) {
      return `Error: Adding sensitive directory as knowledge base is not allowed: ${normalizedPath}`;
    }
  }

  try {
    const stat = statSync(normalizedPath);
    if (!stat.isDirectory()) {
      return `Error: Path is not a directory: ${normalizedPath}`;
    }
  } catch (error: unknown) {
    return `Error: Cannot access directory: ${normalizedPath} - ${error instanceof Error ? error.message : String(error)}`;
  }

  const config = loadEditableConfig(root, host);
  const knowledgeBases: string[] = Array.isArray(config.knowledgeBases) ? (config.knowledgeBases as string[]) : [];
  const alreadyExists = hasMatchingKnowledgeBasePath(knowledgeBases, normalizedPath, root);

  if (alreadyExists) {
    return `Knowledge base already configured: ${normalizedPath}`;
  }

  knowledgeBases.push(normalizedPath);
  config.knowledgeBases = knowledgeBases;
  saveConfig(root, config, host);
  refreshIndexerForDirectory(root, host);

  let result = `${normalizedPath}\n`;
  result += `Total knowledge bases: ${knowledgeBases.length}\n`;
  result += `Config path: ${getConfigPath(root, host)}\n`;
  result += `\nRun /index to rebuild the index with the new knowledge base.`;
  return result;
}

export function listKnowledgeBases(projectRoot: string | undefined, host: HostMode): string {
  const root = getProjectRoot(projectRoot, host);
  const config = loadRuntimeConfig(root, host);
  const knowledgeBases: string[] = Array.isArray(config.knowledgeBases) ? (config.knowledgeBases as string[]) : [];

  if (knowledgeBases.length === 0) {
    return "No knowledge bases configured. Use add_knowledge_base to add folders.";
  }

  let result = `Knowledge Bases (${knowledgeBases.length}):\n\n`;

  for (let i = 0; i < knowledgeBases.length; i++) {
    const kb = knowledgeBases[i];
    const resolvedPath = resolveKnowledgeBasePath(kb, root);
    const exists = existsSync(resolvedPath);

    result += `[${i + 1}] ${kb}\n`;
    result += `    Resolved: ${resolvedPath}\n`;
    result += `    Status: ${exists ? "Exists" : "NOT FOUND"}\n`;

    if (exists) {
      try {
        const stat = statSync(resolvedPath);
        result += `    Type: ${stat.isDirectory() ? "Directory" : "File"}\n`;
      } catch {
        // ignore
      }
    }

    result += "\n";
  }

  const hasHostConfig = existsSync(path.join(root, getHostProjectConfigRelativePath(host)));
  if (hasHostConfig) {
    result += `
Config sources: 1 file(s).`;
  }

  result += `\nConfig file: ${getConfigPath(root, host)}`;
  return result;
}

export function removeKnowledgeBase(
  projectRoot: string | undefined,
  host: HostMode,
  knowledgeBasePath: string,
): string {
  const root = getProjectRoot(projectRoot, host);
  const config = loadEditableConfig(root, host);
  const knowledgeBases: string[] = Array.isArray(config.knowledgeBases) ? (config.knowledgeBases as string[]) : [];
  const index = findKnowledgeBasePathIndex(knowledgeBases, knowledgeBasePath, root);

  if (index === -1) {
    return `Knowledge base not found: ${knowledgeBasePath}`;
  }

  const removed = knowledgeBases.splice(index, 1)[0];
  config.knowledgeBases = knowledgeBases;
  saveConfig(root, config, host);
  refreshIndexerForDirectory(root, host);

  let result = `Removed: ${removed}\n\n`;
  result += `Remaining knowledge bases: ${knowledgeBases.length}\n`;
  result += `Config saved to: ${getConfigPath(root, host)}\n`;
  result += `\nRun /index to rebuild the index without the removed knowledge base.`;

  return result;
}

export {
  AutoIndexRetrievalUnavailableError,
  getIndexerForProject,
  initializeTools,
  isToolEffectivenessEnabled,
  recordToolEffectiveness,
  refreshIndexerForDirectory,
  getSharedIndexer,
  formatStatus,
};

export async function getArchitectureContext(
  projectRoot: string | undefined,
  host: HostMode,
  params: SharedArchitectureContextArgs,
  control?: OperationControl,
): Promise<import("./architecture-context.js").ArchitectureContextResult> {
  await runOperationPhase(control, "waiting_for_index");
  await ensureAutoIndexReadyForRetrieval(projectRoot, host, control);
  await runOperationPhase(control, "building_architecture");
  const indexer = getIndexerForProject(projectRoot, host);
  const result = await getArchitectureContextForIndexer(
    indexer,
    getProjectRoot(projectRoot, host),
    params,
    control,
  );
  throwIfOperationAborted(control?.signal);
  return result;
}

export async function getArchitectureContextForIndexer(
  indexer: Indexer,
  projectRoot: string,
  params: SharedArchitectureContextArgs,
  control?: OperationControl,
): Promise<import("./architecture-context.js").ArchitectureContextResult> {
  const operationOptions = {
    signal: control?.signal,
    setPhase: control?.setPhase,
    heartbeat: control?.heartbeat,
  };
  const [communities, centrality, couplings, visualization] = await Promise.all([
    indexer.detectCommunities(undefined, undefined, operationOptions),
    indexer.computeCentrality(undefined, operationOptions),
    indexer.detectCommunityCouplings(undefined, operationOptions),
    indexer.getVisualizationData({
      directory: params.directory ?? undefined,
      ...operationOptions,
    }),
  ]);
  throwIfOperationAborted(control?.signal);
  let focusedSymbols: SymbolData[] = [];
  if (params.query?.trim()) {
    const results = await indexer.search(params.query.trim(), 24, {
      metadataOnly: true,
      directory: params.directory ?? undefined,
      prioritizeSourcePaths: true,
      signal: control?.signal,
      setPhase: control?.setPhase,
      heartbeat: control?.heartbeat,
    });
    throwIfOperationAborted(control?.signal);
    focusedSymbols = selectArchitectureFocusedSymbols(
      results,
      visualization.symbols,
      params.depth,
      control?.signal,
    );
  }

  throwIfOperationAborted(control?.signal);
  const queryRequested = Boolean(params.query?.trim());
  const focusIds = new Set(focusedSymbols.map((symbol) => {
    throwIfOperationAborted(control?.signal);
    return symbol.id;
  }));
  const focusedCommunityIds = new Set(
    communities.filter((member) => {
      throwIfOperationAborted(control?.signal);
      return focusIds.has(member.symbolId);
    }).map((member) => member.communityId),
  );
  const communityBySymbolId = new Map(communities.map((member) => [member.symbolId, member.communityId]));
  const scopedSymbols = visualization.symbols.filter((symbol) => {
    throwIfOperationAborted(control?.signal);
    return isArchitecturePathInDirectory(symbol.filePath, params.directory, projectRoot)
      && (!queryRequested
        || focusIds.has(symbol.id)
        || focusedCommunityIds.has(communityBySymbolId.get(symbol.id) ?? -1));
  });
  const scopedSymbolIds = new Set(scopedSymbols.map((symbol) => symbol.id));
  const scopedEdges = visualization.edges.filter((edge) => {
    throwIfOperationAborted(control?.signal);
    return scopedSymbolIds.has(edge.fromSymbolId);
  });
  const recentActivity = params.includeRecentActivity
    ? (await getRecentGitActivityAbortable(
      transformForVisualization(scopedSymbols, visualization.edges, {
        directory: params.directory ?? undefined,
        includeOrphans: true,
      }),
      projectRoot,
      control?.signal,
    )).slice(0, 3).map((change) => ({
      title: change.title,
      date: change.when,
      commit: change.source.replace(/^commit\s+/, ""),
      summary: change.summary,
      filePaths: change.filePaths,
    }))
    : [];

  return buildArchitectureContext(params, communities, centrality, couplings, {
    projectRoot,
    sourceSymbols: visualization.symbols,
    focusedSymbols,
    graphCoverage: summarizeCallGraphCoverage(scopedSymbols, scopedEdges),
    recentActivity,
  });
}
