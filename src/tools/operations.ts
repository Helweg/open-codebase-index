import { existsSync, realpathSync, statSync } from "fs";
import * as path from "path";
import { parseConfig, type ParsedCodebaseIndexConfig } from "../config/schema.js";
import { getHostProjectConfigRelativePath } from "../config/paths.js";
import type { HostMode } from "../config/host.js";
import type { CallEdgeData, PathHopData, SymbolData } from "../native/index.js";
import { Indexer } from "../indexer/index.js";
import { isIndexLockContentionError } from "../indexer/index-lock.js";
import { findKnowledgeBasePathIndex, hasMatchingKnowledgeBasePath, resolveKnowledgeBasePath } from "./knowledge-base-paths.js";
import { calculatePercentage, formatProgressTitle, formatStatus } from "./utils.js";
import type { LogLevel } from "../config/schema.js";
import type { LogEntry } from "../utils/logger.js";
import type { CostEstimate } from "../utils/cost.js";
import { getConfigPath, loadEditableConfig, loadRuntimeConfig, saveConfig } from "./config-state.js";

type IndexerCacheKey = `${HostMode}::${string}`;

type SearchResult = Awaited<ReturnType<Indexer["search"]>>[number];
type IndexStats = Awaited<ReturnType<Indexer["index"]>>;
type StatusResult = Awaited<ReturnType<Indexer["getStatus"]>>;
type HealthCheckResult = Awaited<ReturnType<Indexer["healthCheck"]>>;
type PrImpactResult = Awaited<ReturnType<Indexer["getPrImpact"]>>;
type IndexBusyResult = { kind: "busy"; text: string };

type ProgressCb = (title: string, metadata: Record<string, unknown>) => void | Promise<void>;

const indexerCache = new Map<IndexerCacheKey, Indexer>();
const configCache = new Map<IndexerCacheKey, ParsedCodebaseIndexConfig>();
const defaultProjectRoots = new Map<HostMode, string>();
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
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const withoutDotPrefix = normalized.replace(/^\.\/+/, "");
  return withoutDotPrefix.length > 1 ? withoutDotPrefix.replace(/\/+$/, "") : withoutDotPrefix;
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

function getIndexBusyResult(error: unknown): IndexBusyResult | null {
  if (!isIndexLockContentionError(error)) return null;

  const owner = error.owner;
  const ownerText = owner
    ? `PID ${owner.pid}, operation ${owner.operation}, since ${owner.startedAt}`
    : "unreadable owner";
  if (error.reason === "legacy-lock") {
    return {
      kind: "busy",
      text: `INDEX_BUSY: legacy lock format detected (${ownerText}). Verify the PID and remove this lock manually only if it is stale.`,
    };
  }
  if (error.reason === "unknown-owner") {
    return {
      kind: "busy",
      text: `INDEX_BUSY: unreadable or remote lock owner (${ownerText}). Automatic recovery was refused; manual verification is required.`,
    };
  }
  return { kind: "busy", text: `INDEX_BUSY: another index operation is already in progress (${ownerText}).` };
}

function getProjectRoot(projectRoot: string | undefined, host: HostMode): string {
  if (projectRoot) {
    return projectRoot;
  }

  const root = defaultProjectRoots.get(host);
  if (!root) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }

  return root;
}

function getIndexerCacheKey(projectRoot: string, host: HostMode): IndexerCacheKey {
  return `${host}::${projectRoot}`;
}

function getOrCreateIndexer(projectRoot: string, host: HostMode): Indexer {
  const key = getIndexerCacheKey(projectRoot, host);
  const cached = indexerCache.get(key);
  if (cached) {
    return cached;
  }

  const config = parseConfig(loadRuntimeConfig(projectRoot, host));
  const indexer = new Indexer(projectRoot, config, host);
  indexerCache.set(key, indexer);
  configCache.set(key, config);
  return indexer;
}

export function initializeTools(projectRoot: string, config: ParsedCodebaseIndexConfig, host: HostMode = "opencode"): void {
  defaultProjectRoots.set(host, projectRoot);
  const key = getIndexerCacheKey(projectRoot, host);
  const indexer = new Indexer(projectRoot, config, host);
  indexerCache.set(key, indexer);
  configCache.set(key, config);
}

export function getSharedIndexer(host: HostMode = "opencode"): Indexer {
  return getIndexerForProject(undefined, host);
}

export function getIndexerForProject(projectRoot: string | undefined, host: HostMode = "opencode"): Indexer {
  const root = getProjectRoot(projectRoot, host);
  return getOrCreateIndexer(root, host);
}

export function refreshIndexerForDirectory(
  projectRoot: string,
  host: HostMode = "opencode",
  config: ParsedCodebaseIndexConfig = parseConfig(loadRuntimeConfig(projectRoot, host)),
): void {
  const key = getIndexerCacheKey(projectRoot, host);
  const indexer = new Indexer(projectRoot, config, host);
  indexerCache.set(key, indexer);
  configCache.set(key, config);
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
    blameAuthor?: string;
    blameSha?: string;
    blameSince?: string;
  } = {},
): Promise<SearchResult[]> {
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.search(query, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    chunkType: options.chunkType,
    contextLines: options.contextLines,
    metadataOnly: options.metadataOnly,
    definitionIntent: options.definitionIntent,
    blameAuthor: options.blameAuthor,
    blameSha: options.blameSha,
    blameSince: options.blameSince,
  });
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
  } = {},
): Promise<SearchResult[]> {
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.search(query, options.limit, {
    fileType: options.fileType,
    directory: options.directory,
    definitionIntent: true,
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
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);
  const symbols = await indexer.getCallGraphSymbols();
  const resolution = resolveCallGraphSymbol(symbols, root, params.name, params.filePath, params.symbolId);
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
  | IndexBusyResult
> {
  const root = getProjectRoot(projectRoot, host);
  const indexer = getIndexerForProject(root, host);

  try {
    if (args.estimateOnly) {
      return { kind: "estimate", estimate: await indexer.estimateCost() };
    }

    const runIndex = async (target: Indexer): Promise<IndexStats> => {
      const operation = args.force ? target.forceIndex.bind(target) : target.index.bind(target);
      return operation((progress) => {
        if (onProgress) {
          return onProgress(formatProgressTitle(progress), {
            phase: progress.phase,
            filesProcessed: progress.filesProcessed,
            totalFiles: progress.totalFiles,
            chunksProcessed: progress.chunksProcessed,
            totalChunks: progress.totalChunks,
            percentage: calculatePercentage(progress),
          });
        }
        return Promise.resolve();
      });
    };

    return { kind: "stats", stats: await runIndex(indexer) };
  } catch (error) {
    const busyResult = getIndexBusyResult(error);
    if (!busyResult) throw error;
    return busyResult;
  }
}

export async function getIndexStatus(projectRoot: string | undefined, host: HostMode): Promise<StatusResult> {
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.getStatus();
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

export async function getIndexMetrics(projectRoot: string | undefined, host: HostMode): Promise<{ enabled: boolean; metricsEnabled: boolean; text: string }> {
  const indexer = getIndexerForProject(projectRoot, host);
  const logger = indexer.getLogger();

  if (!logger.isEnabled()) {
    return {
      enabled: false,
      metricsEnabled: false,
      text: "Debug mode is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```",
    };
  }

  if (!logger.isMetricsEnabled()) {
    return {
      enabled: true,
      metricsEnabled: false,
      text: "Metrics collection is disabled. Enable it in your config:\n\n```json\n{\n  \"debug\": {\n    \"enabled\": true,\n    \"metrics\": true\n  }\n}\n```",
    };
  }

  return {
    enabled: true,
    metricsEnabled: true,
    text: logger.formatMetrics(),
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

export { formatStatus };
