import { existsSync, realpathSync, statSync } from "fs";
import * as path from "path";
import { loadProjectConfigLayer, materializeLocalProjectConfig } from "../config/merger.js";
import { parseConfig, type ParsedCodebaseIndexConfig } from "../config/schema.js";
import { getHostProjectIndexRelativePath, getHostProjectConfigRelativePath, resolveProjectIndexPath, resolveWorktreeFallbackProjectIndexPath } from "../config/paths.js";
import type { HostMode } from "../config/host.js";
import { Indexer } from "../indexer/index.js";
import { isIndexLockContentionError, withIndexLock } from "../indexer/index-lock.js";
import { findKnowledgeBasePathIndex, hasMatchingKnowledgeBasePath, resolveKnowledgeBasePath } from "./knowledge-base-paths.js";
import { calculatePercentage, formatProgressTitle, formatStatus } from "./utils.js";
import type { LogLevel } from "../config/schema.js";
import type { LogEntry } from "../utils/logger.js";
import type { CostEstimate } from "../utils/cost.js";
import { getConfigPath, loadEditableConfig, loadRuntimeConfig, saveConfig } from "./config-state.js";

type IndexerCacheKey = `${HostMode}::${string}`;

type SearchResult = Awaited<ReturnType<Indexer["search"]>>[number];
type CallGraphEdge = Awaited<ReturnType<Indexer["getCallers"]>>[number];
type IndexStats = Awaited<ReturnType<Indexer["index"]>>;
type StatusResult = Awaited<ReturnType<Indexer["getStatus"]>>;
type HealthCheckResult = Awaited<ReturnType<Indexer["healthCheck"]>>;
type PrImpactResult = Awaited<ReturnType<Indexer["getPrImpact"]>>;
type IndexBusyResult = { kind: "busy"; text: string };

type ProgressCb = (title: string, metadata: Record<string, unknown>) => void | Promise<void>;

const indexerCache = new Map<IndexerCacheKey, Indexer>();
const configCache = new Map<IndexerCacheKey, ParsedCodebaseIndexConfig>();
const defaultProjectRoots = new Map<HostMode, string>();

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

export function shouldForceLocalizeProjectIndex(projectRoot: string | undefined, host: HostMode = "opencode"): boolean {
  const root = getProjectRoot(projectRoot, host);
  const localIndexPath = path.join(root, getHostProjectIndexRelativePath(host));
  if (existsSync(localIndexPath)) {
    return false;
  }
  const inheritedIndexPath = resolveWorktreeFallbackProjectIndexPath(root, host);
  return inheritedIndexPath !== null;
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
    relationshipType?: "Call" | "MethodCall" | "Constructor" | "Import" | "Inherits" | "Implements";
  },
): Promise<{ direction: "callers" | "callees"; callers: CallGraphEdge[]; callees: CallGraphEdge[]; }> {
  const indexer = getIndexerForProject(projectRoot, host);
  if (params.direction === "callees") {
    if (!params.symbolId) {
      return { direction: "callees", callees: [], callers: [] };
    }
    const callees = await indexer.getCallees(params.symbolId, params.relationshipType);
    return { direction: "callees", callees, callers: [] };
  }

  const callers = await indexer.getCallers(params.name, params.relationshipType);
  return { direction: "callers", callers, callees: [] };
}

export async function getCallGraphPath(
  projectRoot: string | undefined,
  host: HostMode,
  from: string,
  to: string,
  maxDepth?: number,
): Promise<Awaited<ReturnType<Indexer["findCallPath"]>>> {
  const indexer = getIndexerForProject(projectRoot, host);
  return indexer.findCallPath(from, to, maxDepth);
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
  const key = getIndexerCacheKey(root, host);
  let indexer = getIndexerForProject(root, host);
  const runtimeConfig = configCache.get(key)!;

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

    let stats: IndexStats;
    if (args.force && shouldForceLocalizeProjectIndex(root, host)) {
      const inheritedIndexPath = resolveProjectIndexPath(root, runtimeConfig.scope, host);
      stats = await withIndexLock(inheritedIndexPath, "force-index", async () => {
        materializeLocalProjectConfig(root, loadProjectConfigLayer(root, host), host);
        refreshIndexerForDirectory(root, host, runtimeConfig);
        indexer = getIndexerForProject(root, host);
        return runIndex(indexer);
      }, { completeRecoveries: false });
    } else {
      stats = await runIndex(indexer);
    }

    return { kind: "stats", stats };
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
