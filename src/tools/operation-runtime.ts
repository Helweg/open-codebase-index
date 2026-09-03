import type { HostMode } from "../config/host.js";
import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { OperationControl } from "../utils/operation-control.js";
import { parseConfig } from "../config/schema.js";
import { configureAutoIndex, waitForAutoIndexForRetrieval } from "../utils/auto-index.js";
import { isBackgroundWorkerManaged } from "../utils/background-worker.js";
import { Indexer } from "../indexer/index.js";
import { isIndexLockContentionError } from "../indexer/index-lock.js";
import {
  recordProcessEffectiveness,
  type EffectivenessMetricEvent,
} from "../utils/effectiveness-metrics.js";
import { countContextTokens } from "./utils.js";
import { loadRuntimeConfig } from "./config-state.js";
import { raceWithOperationSignal, throwIfOperationAborted } from "../utils/operation-control.js";

export type IndexerCacheKey = `${HostMode}::${string}`;

export const indexerCache = new Map<IndexerCacheKey, Indexer>();
export const configCache = new Map<IndexerCacheKey, ParsedCodebaseIndexConfig>();
export const defaultProjectRoots = new Map<HostMode, string>();

export type IndexBusyResult = { kind: "busy"; text: string };

interface InitializeToolsOptions {
  preserveManagedWorker?: boolean;
}

export function getIndexBusyResult(error: unknown): IndexBusyResult | null {
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

export function getProjectRoot(projectRoot: string | undefined, host: HostMode): string {
  if (projectRoot) {
    return projectRoot;
  }

  const root = defaultProjectRoots.get(host);
  if (!root) {
    throw new Error("Codebase index tools not initialized. Plugin may not be loaded correctly.");
  }

  return root;
}

export function getIndexerCacheKey(projectRoot: string, host: HostMode): IndexerCacheKey {
  return `${host}::${projectRoot}`;
}

export function rawEffectivenessMetricsEnabled(rawConfig: unknown): boolean {
  if (!rawConfig || typeof rawConfig !== "object") return false;
  const value = (rawConfig as Record<string, unknown>).effectivenessMetrics;
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).enabled === true);
}

export function isToolEffectivenessEnabled(
  projectRoot: string | undefined,
  host: HostMode,
): boolean {
  try {
    const root = getProjectRoot(projectRoot, host);
    const cached = configCache.get(getIndexerCacheKey(root, host));
    if (cached) return cached.effectivenessMetrics.enabled;
    return rawEffectivenessMetricsEnabled(loadRuntimeConfig(root, host));
  } catch {
    // Metrics are best-effort and must never alter repository tool behavior.
    return false;
  }
}

export function safelyRecordToolEffectiveness(event: EffectivenessMetricEvent): void {
  try {
    recordProcessEffectiveness(event);
  } catch {
    // Metrics are best-effort and must never alter repository tool behavior.
  }
}

export function safelyCountReturnedTokens(text: string): number {
  try {
    return countContextTokens(text);
  } catch {
    return 0;
  }
}

export function getOrCreateIndexer(projectRoot: string, host: HostMode): Indexer {
  const key = getIndexerCacheKey(projectRoot, host);
  const cached = indexerCache.get(key);
  if (cached) {
    return cached;
  }

  let config = configCache.get(key);
  if (!config) {
    config = parseConfig(loadRuntimeConfig(projectRoot, host));
    configCache.set(key, config);
  }
  const indexer = new Indexer(projectRoot, config, host);
  indexerCache.set(key, indexer);
  configureAutoIndex(projectRoot, host, config, () => getOrCreateIndexer(projectRoot, host), {
    preserveManagedWorker: true,
    synchronizeBackgroundWorker: false,
  });
  return indexer;
}

export function getRuntimeConfigForProject(projectRoot: string, host: HostMode): ParsedCodebaseIndexConfig {
  const key = getIndexerCacheKey(projectRoot, host);
  let config = configCache.get(key);
  if (!config) {
    config = parseConfig(loadRuntimeConfig(projectRoot, host));
    configCache.set(key, config);
  }
  return config;
}

export function initializeTools(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
  options: InitializeToolsOptions = {},
): void {
  defaultProjectRoots.set(host, projectRoot);
  const key = getIndexerCacheKey(projectRoot, host);
  if (options.preserveManagedWorker === true && isBackgroundWorkerManaged(projectRoot, host) && indexerCache.has(key)) {
    // A later in-process server must not replace state owned by the worker.
    return;
  }
  configCache.set(key, config);
  indexerCache.set(key, new Indexer(projectRoot, config, host));
  configureAutoIndex(projectRoot, host, config, () => getOrCreateIndexer(projectRoot, host), {
    preserveManagedWorker: options.preserveManagedWorker,
    synchronizeBackgroundWorker: false,
  });
}

export function getSharedIndexer(host: HostMode): Indexer {
  return getIndexerForProject(undefined, host);
}

export function getIndexerForProject(projectRoot: string | undefined, host: HostMode): Indexer {
  const root = getProjectRoot(projectRoot, host);
  return getOrCreateIndexer(root, host);
}

export function recordToolEffectiveness(
  projectRoot: string | undefined,
  host: HostMode,
  event: EffectivenessMetricEvent,
): void {
  if (!isToolEffectivenessEnabled(projectRoot, host)) return;
  safelyRecordToolEffectiveness(event);
}

export function refreshIndexerForDirectory(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig = parseConfig(loadRuntimeConfig(projectRoot, host)),
): ParsedCodebaseIndexConfig {
  const key = getIndexerCacheKey(projectRoot, host);
  configCache.set(key, config);
  indexerCache.set(key, new Indexer(projectRoot, config, host));
  configureAutoIndex(projectRoot, host, config, () => getOrCreateIndexer(projectRoot, host), {
    synchronizeBackgroundWorker: true,
  });
  return config;
}

export class AutoIndexRetrievalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoIndexRetrievalUnavailableError";
  }
}

export async function ensureAutoIndexReadyForRetrieval(
  projectRoot: string | undefined,
  host: HostMode,
  control?: OperationControl,
): Promise<void> {
  throwIfOperationAborted(control?.signal);
  const root = getProjectRoot(projectRoot, host);
  getIndexerForProject(root, host);
  const result = await raceWithOperationSignal(
    waitForAutoIndexForRetrieval(root, host, control),
    control?.signal,
  );
  if (!result.ready) {
    throw new AutoIndexRetrievalUnavailableError(
      result.text ?? "Automatic indexing has not produced a readable index yet. Call index_status and retry.",
    );
  }
}
