import { existsSync, realpathSync, statSync } from "fs";
import * as path from "path";
import { parseConfig } from "../config/schema.js";
import { getHostProjectConfigRelativePath } from "../config/paths.js";
import type { HostMode } from "../config/host.js";
import type { CallEdgeData, PathHopData, SymbolData } from "../native/index.js";
import { Indexer } from "../indexer/index.js";
import { findKnowledgeBasePathIndex, hasMatchingKnowledgeBasePath, resolveKnowledgeBasePath } from "./knowledge-base-paths.js";
import { buildCodeCommunitiesResult } from "./format-communities.js";
import {
  CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT,
  CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD,
  CODE_COMMUNITIES_DEFAULT_LIMIT,
  CODE_COMMUNITIES_MAX_COUPLING_LIMIT,
  CODE_COMMUNITIES_MAX_LIMIT,
  CODE_COMMUNITIES_MIN_COUPLING,
  CODE_COMMUNITIES_MIN_SIZE,
} from "./contracts.js";
import type { SharedCodeCommunitiesArgs } from "./contracts.js";
import { calculatePercentage, formatProgressTitle, formatStatus } from "./utils.js";
import type { LogLevel } from "../config/schema.js";
import type { LogEntry } from "../utils/logger.js";
import type { CostEstimate } from "../utils/cost.js";
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
): CallGraphSymbolResolution {
  const name = requestedName.trim();
  const filePath = trimOrUndefined(requestedFilePath);
  const symbolId = trimOrUndefined(requestedSymbolId);

  if (symbolId) {
    const symbol = symbols.find((candidate) => candidate.id === symbolId);
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

  const nameCandidates = symbols.filter((symbol) => symbolNameMatches(symbol, name));
  const matchingCandidates = filePath
    ? nameCandidates.filter((symbol) => filePathMatches(symbol.filePath, filePath))
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
    trace?: (trace: SearchTrace) => void;
  } = {},
): Promise<SearchResult[]> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
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
    trace: options.trace,
  });
}

export async function searchCodebaseWithEffectiveness<T>(
  projectRoot: string | undefined,
  host: HostMode,
  route: "peek" | "search",
  query: string,
  options: Parameters<typeof searchCodebase>[3],
  render: (results: SearchResult[]) => { output: T; text: string },
): Promise<T> {
  const metricsEnabled = isToolEffectivenessEnabled(projectRoot, host);
  const startedAt = metricsEnabled ? performance.now() : 0;
  try {
    const results = await searchCodebase(projectRoot, host, query, options);
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
  } = {},
): Promise<Awaited<ReturnType<Indexer["findSimilar"]>>> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.findSimilar(code, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    chunkType: options.chunkType,
    excludeFile: options.excludeFile,
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
    trace?: (trace: SearchTrace) => void;
  } = {},
): Promise<SearchResult[]> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.search(query, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    definitionIntent: true,
    trace: options.trace,
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
): Promise<CallGraphDataResult> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  return getCallGraphDataForIndexer(indexer, root, params);
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
): Promise<CallGraphDataResult> {
  const symbols = await indexer.getCallGraphSymbols();
  const resolution = resolveCallGraphSymbol(symbols, projectRoot, params.name, params.filePath, params.symbolId);
  const direction = params.direction === "callees" ? "callees" : "callers";
  if (resolution.status !== "resolved") {
    return { direction, resolution, callers: [], callees: [], relationshipType: params.relationshipType };
  }

  if (params.direction === "callees") {
    const callees = await indexer.getCallees(resolution.symbolId, params.relationshipType);
    return { direction: "callees", resolution, callees, callers: [], relationshipType: params.relationshipType };
  }

  const includeUnresolved = symbols.filter((symbol) => symbolNameMatches(symbol, resolution.name)).length === 1;
  const callers = await indexer.getCallersForSymbol(
    resolution.symbolId,
    resolution.name,
    includeUnresolved,
    params.relationshipType,
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
): Promise<CallGraphPathResult> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  const symbols = await indexer.getCallGraphSymbols();
  const fromResolution = resolveCallGraphSymbol(symbols, root, from, fromFilePath);
  const toResolution = resolveCallGraphSymbol(symbols, root, to, toFilePath);
  if (fromResolution.status !== "resolved" || toResolution.status !== "resolved") {
    return { from: fromResolution, to: toResolution, path: [] };
  }

  const path = await indexer.findCallPathBySymbolIds(
    fromResolution.symbolId,
    toResolution.symbolId,
    maxDepth,
  );
  return { from: fromResolution, to: toResolution, path };
}

export async function runIndexCodebase(
  projectRoot: string | undefined,
  host: HostMode,
  args: { force?: boolean; estimateOnly?: boolean; verbose?: boolean },
  onProgress?: ProgressCb,
): Promise<
  | { kind: "estimate"; estimate: CostEstimate }
  | { kind: "stats"; stats: IndexStats }
  | IndexMessageResult
  | IndexBusyResult
> {
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);

  try {
    if (args.estimateOnly) {
      return { kind: "estimate", estimate: await indexer.estimateCost() };
    }

    const coordinated = runCoordinatedIndex(root, host, args.force ?? false, (progress) => {
      if (onProgress) {
        void onProgress(formatProgressTitle(progress), {
          phase: progress.phase,
          filesProcessed: progress.filesProcessed,
          totalFiles: progress.totalFiles,
          chunksProcessed: progress.chunksProcessed,
          totalChunks: progress.totalChunks,
          percentage: calculatePercentage(progress),
        });
      }
    });
    if (!coordinated) {
      const operation = args.force ? indexer.forceIndex.bind(indexer) : indexer.index.bind(indexer);
      return { kind: "stats", stats: await operation() };
    }
    const result = await coordinated;
    if (result.outcome === "ready" && result.stats) {
      return { kind: "stats", stats: result.stats };
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

export async function getIndexStatus(projectRoot: string | undefined, host: HostMode): Promise<IndexStatusResult> {
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  return {
    ...await indexer.getStatus(),
    autoIndex: getAutoIndexStatus(root, host),
  };
}

export async function getIndexHealthCheck(projectRoot: string | undefined, host: HostMode): Promise<HealthCheckResult> {
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.healthCheck();
}

export async function runIndexHealthCheck(
  projectRoot: string | undefined,
  host: HostMode,
): Promise<{ kind: "health"; health: HealthCheckResult } | IndexBusyResult> {
  try {
    return { kind: "health", health: await getIndexHealthCheck(projectRoot, host) };
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
): Promise<PrImpactResult> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.getPrImpact({
    pr: params.pr,
    branch: params.branch,
    maxDepth: params.maxDepth,
    hubThreshold: params.hubThreshold,
    checkConflicts: params.checkConflicts,
    direction: params.direction,
  });
}

export async function getCodeCommunities(
  projectRoot: string | undefined,
  host: HostMode,
  params: SharedCodeCommunitiesArgs,
): Promise<import("./format-communities.js").CodeCommunitiesResult> {
  await ensureAutoIndexReadyForRetrieval(projectRoot, host);
  const indexer = getIndexerForProject(projectRoot, host);
  const [communities, centrality, couplings] = await Promise.all([
    indexer.detectCommunities(params.branch),
    indexer.computeCentrality(params.branch),
    indexer.detectCommunityCouplings(params.branch),
  ]);
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
