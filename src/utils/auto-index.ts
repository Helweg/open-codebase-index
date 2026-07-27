import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import type { Indexer, IndexProgress, IndexStats } from "../indexer/index.js";
import { existsSync, realpathSync } from "fs";
import * as os from "os";
import * as path from "path";

import { resolveProjectIndexPath } from "../config/paths.js";
import { isTransientIndexLockContention } from "../indexer/index-lock.js";
import { hasProjectMarker } from "./files.js";

export type AutoIndexCoordinatorState =
  | "idle"
  | "checking"
  | "indexing"
  | "ready"
  | "busy-retrying"
  | "failed"
  | "stopped";

export type AutoIndexSource = "startup" | "retrieval" | "watcher" | "manual";

export interface AutoIndexProgressSnapshot {
  phase: IndexProgress["phase"];
  filesProcessed: number;
  totalFiles: number;
  chunksProcessed: number;
  totalChunks: number;
  percentage: number;
}

export interface AutoIndexStatusSnapshot {
  enabled: boolean;
  state: AutoIndexCoordinatorState;
  source?: AutoIndexSource;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  errorAt?: string;
  lastError?: string;
  retryAttempt?: number;
  maxRetries?: number;
  nextRetryAt?: string;
  progress?: AutoIndexProgressSnapshot;
  blockedReason?: "home-directory" | "project-marker-missing";
}

export interface CoordinatedIndexResult {
  outcome: "ready" | "failed" | "stopped";
  stats?: IndexStats;
  skipped?: boolean;
  error?: unknown;
}

export interface AutoIndexRetrievalResult {
  ready: boolean;
  text?: string;
}

type CoordinatedIndexer = Pick<
  Indexer,
  "forceIndex" | "getStatus" | "index"
> & Partial<Pick<Indexer, "getIndexFreshness">>;

interface AutoIndexRegistration {
  config: ParsedCodebaseIndexConfig;
  getIndexer: () => CoordinatedIndexer;
  safeToRun: boolean;
  blockedReason?: AutoIndexStatusSnapshot["blockedReason"];
}

interface IndexRequest {
  checkFreshness: boolean;
  force: boolean;
  onProgress?: (progress: IndexProgress) => void;
  source: AutoIndexSource;
}

const MAX_RETRY_DELAY_MS = 10_000;
const SHUTDOWN_WAIT_MS = 2_000;
const coordinators = new Map<string, AutoIndexCoordinator>();
const coordinatorKeysByProject = new Map<string, string>();

class AutoIndexCancelledError extends Error {
  constructor() {
    super("Auto-index coordination was cancelled");
    this.name = "AutoIndexCancelledError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (existsSync(resolved)) {
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  }

  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(canonicalizePath(parent), path.basename(resolved));
}

function projectLookupKey(projectRoot: string, host: HostMode): string {
  return `${host}::${canonicalizePath(projectRoot)}`;
}

function coordinatorKey(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): string {
  const canonicalProjectRoot = canonicalizePath(projectRoot);
  const indexPath = resolveProjectIndexPath(projectRoot, config.scope, host);
  return `${canonicalizePath(indexPath)}::${canonicalProjectRoot}`;
}

function getProjectSafety(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
): Pick<AutoIndexRegistration, "blockedReason" | "safeToRun"> {
  if (path.resolve(projectRoot) === path.resolve(os.homedir())) {
    return { safeToRun: false, blockedReason: "home-directory" };
  }
  if (config.indexing.requireProjectMarker && !hasProjectMarker(projectRoot)) {
    return { safeToRun: false, blockedReason: "project-marker-missing" };
  }
  return { safeToRun: true };
}

function calculatePercentage(progress: IndexProgress): number {
  if (progress.phase === "scanning") return 0;
  if (progress.phase === "complete") return 100;
  if (progress.phase === "parsing") {
    return progress.totalFiles === 0
      ? 5
      : Math.round(5 + (progress.filesProcessed / progress.totalFiles) * 15);
  }
  if (progress.phase === "embedding") {
    return progress.totalChunks === 0
      ? 20
      : Math.round(20 + (progress.chunksProcessed / progress.totalChunks) * 70);
  }
  if (progress.phase === "storing") return 95;
  return 0;
}

function safeFailureMessage(error: unknown): string {
  if (isTransientIndexLockContention(error)) {
    return "Another index process remained busy after the configured retries.";
  }
  return "Automatic indexing failed. Check the embedding provider configuration, then run index_codebase.";
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new AutoIndexCancelledError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AutoIndexCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

function requestPriority(request: IndexRequest): number {
  if (request.force) return 4;
  if (request.source === "manual") return 3;
  if (request.source === "watcher") return 2;
  return 1;
}

function mergeRequests(current: IndexRequest | null, next: IndexRequest): IndexRequest {
  if (!current) return next;
  const preferred = requestPriority(next) > requestPriority(current) ? next : current;
  return {
    checkFreshness: current.checkFreshness && next.checkFreshness,
    force: current.force || next.force,
    onProgress: next.onProgress ?? current.onProgress,
    source: preferred.source,
  };
}

class AutoIndexCoordinator {
  private registration: AutoIndexRegistration;
  private status: AutoIndexStatusSnapshot;
  private inFlight: Promise<CoordinatedIndexResult> | null = null;
  private activeRequest: IndexRequest | null = null;
  private pendingRequest: IndexRequest | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(registration: AutoIndexRegistration) {
    this.registration = registration;
    this.status = {
      enabled: registration.config.indexing.autoIndex,
      state: "idle",
      updatedAt: now(),
      blockedReason: registration.blockedReason,
    };
  }

  update(registration: AutoIndexRegistration): void {
    this.registration = registration;
    this.status.enabled = registration.config.indexing.autoIndex;
    this.status.blockedReason = registration.blockedReason;
    this.status.updatedAt = now();
    if (this.stopped) {
      this.stopped = false;
      this.status.state = "idle";
    }
    if (!registration.config.indexing.autoIndex && this.activeRequest?.source !== "manual") {
      this.pendingRequest = null;
      this.abortController?.abort();
      if (!this.inFlight) {
        this.setState("idle", { source: undefined });
      }
    }
  }

  snapshot(): AutoIndexStatusSnapshot {
    return {
      ...this.status,
      progress: this.status.progress ? { ...this.status.progress } : undefined,
    };
  }

  start(source: "startup" | "retrieval"): Promise<CoordinatedIndexResult> | null {
    if (!this.registration.config.indexing.autoIndex || !this.registration.safeToRun) return null;
    if (this.status.state === "failed" || this.status.state === "ready") return this.inFlight;
    return this.request({ checkFreshness: true, force: false, source });
  }

  request(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (this.stopped) {
      return Promise.resolve({ outcome: "stopped" });
    }
    if (this.inFlight) {
      if (request.force && !this.activeRequest?.force) {
        this.pendingRequest = mergeRequests(this.pendingRequest, request);
        this.abortController?.abort();
        const active = this.inFlight;
        return active.then(() => this.inFlight ?? this.startRequest(request));
      }
      if (request.source === "watcher") {
        this.pendingRequest = mergeRequests(this.pendingRequest, request);
      }
      return this.inFlight;
    }
    return this.startRequest(request);
  }

  currentJob(): Promise<CoordinatedIndexResult> | null {
    return this.inFlight;
  }

  getIndexer(): CoordinatedIndexer {
    return this.registration.getIndexer();
  }

  getWaitMs(): number {
    return this.registration.config.indexing.autoIndexWaitMs;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingRequest = null;
    this.abortController?.abort();
    this.setState("stopped", {
      completedAt: now(),
      nextRetryAt: undefined,
      progress: undefined,
      retryAttempt: undefined,
    });
    if (this.inFlight) {
      await withTimeout(this.inFlight, SHUTDOWN_WAIT_MS);
    }
  }

  private startRequest(request: IndexRequest): Promise<CoordinatedIndexResult> {
    this.activeRequest = request;
    const job = this.run(request);
    this.inFlight = job;
    void job.then(() => {
      if (this.inFlight !== job) return;
      this.inFlight = null;
      this.activeRequest = null;
      this.abortController = null;
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      if (pending && !this.stopped) {
        this.startRequest(pending);
      }
    });
    return job;
  }

  private async run(request: IndexRequest): Promise<CoordinatedIndexResult> {
    const controller = new AbortController();
    this.abortController = controller;
    const startedAt = now();
    this.setState("checking", {
      completedAt: undefined,
      errorAt: undefined,
      lastError: undefined,
      nextRetryAt: undefined,
      progress: undefined,
      retryAttempt: undefined,
      source: request.source,
      startedAt,
    });

    const maxRetries = request.source === "manual"
      ? 0
      : this.registration.config.indexing.autoIndexMaxRetries;
    let retryAttempt = 0;
    while (true) {
      try {
        this.throwIfCancelled(controller.signal);
        const indexer = this.registration.getIndexer();
        if (request.checkFreshness && !request.force) {
          if (indexer.getIndexFreshness) {
            const freshness = await indexer.getIndexFreshness();
            this.throwIfCancelled(controller.signal);
            if (freshness.readable && freshness.current) {
              this.setState("ready", {
                completedAt: now(),
                progress: undefined,
                retryAttempt: undefined,
              });
              return { outcome: "ready", skipped: true };
            }
          }
        }

        this.setState("indexing", {
          nextRetryAt: undefined,
          retryAttempt: retryAttempt > 0 ? retryAttempt : undefined,
        });
        const operation = request.force ? indexer.forceIndex.bind(indexer) : indexer.index.bind(indexer);
        const stats = await operation((progress) => {
          this.throwIfCancelled(controller.signal);
          request.onProgress?.(progress);
          this.status.progress = {
            phase: progress.phase,
            filesProcessed: progress.filesProcessed,
            totalFiles: progress.totalFiles,
            chunksProcessed: progress.chunksProcessed,
            totalChunks: progress.totalChunks,
            percentage: calculatePercentage(progress),
          };
          this.status.updatedAt = now();
        });
        this.throwIfCancelled(controller.signal);
        if (request.source === "startup" || request.source === "retrieval") {
          const latestStatus = await this.registration.getIndexer().getStatus();
          if (!latestStatus.indexed) {
            const error = new Error("Indexing completed without producing a readable index");
            this.setState("failed", {
              completedAt: now(),
              errorAt: now(),
              lastError: "Automatic indexing completed but no readable index was produced. Check include and exclude patterns.",
              progress: undefined,
            });
            return { outcome: "failed", error, stats };
          }
        }
        this.setState("ready", {
          completedAt: now(),
          progress: this.status.progress
            ? { ...this.status.progress, phase: "complete", percentage: 100 }
            : undefined,
          retryAttempt: undefined,
        });
        return { outcome: "ready", stats };
      } catch (error) {
        if (error instanceof AutoIndexCancelledError || controller.signal.aborted) {
          if (this.stopped) {
            this.setState("stopped", { completedAt: now(), progress: undefined });
            return { outcome: "stopped" };
          }
          if (!this.registration.config.indexing.autoIndex && request.source !== "manual") {
            this.setState("idle", {
              completedAt: now(),
              progress: undefined,
              source: undefined,
            });
            return { outcome: "stopped" };
          }
          return { outcome: "stopped" };
        }

        if (isTransientIndexLockContention(error) && retryAttempt < maxRetries) {
          retryAttempt += 1;
          const delayMs = Math.min(
            this.registration.config.indexing.autoIndexRetryDelayMs * (2 ** (retryAttempt - 1)),
            MAX_RETRY_DELAY_MS,
          );
          const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
          this.setState("busy-retrying", {
            maxRetries,
            nextRetryAt,
            progress: undefined,
            retryAttempt,
          });
          try {
            await cancellableDelay(delayMs, controller.signal);
          } catch (delayError) {
            if (delayError instanceof AutoIndexCancelledError) {
              if (this.stopped) {
                this.setState("stopped", { completedAt: now(), progress: undefined });
              }
              return { outcome: "stopped" };
            }
            throw delayError;
          }
          this.setState("checking", { nextRetryAt: undefined });
          continue;
        }

        const errorAt = now();
        this.setState("failed", {
          completedAt: errorAt,
          errorAt,
          lastError: safeFailureMessage(error),
          nextRetryAt: undefined,
          progress: undefined,
          retryAttempt: retryAttempt > 0 ? retryAttempt : undefined,
        });
        return { outcome: "failed", error };
      }
    }
  }

  private setState(
    state: AutoIndexCoordinatorState,
    updates: Partial<AutoIndexStatusSnapshot> = {},
  ): void {
    this.status = {
      ...this.status,
      ...updates,
      enabled: this.registration.config.indexing.autoIndex,
      state,
      updatedAt: now(),
      blockedReason: this.registration.blockedReason,
    };
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AutoIndexCancelledError();
  }
}

function getCoordinator(projectRoot: string, host: HostMode): AutoIndexCoordinator | null {
  const key = coordinatorKeysByProject.get(projectLookupKey(projectRoot, host));
  return key ? coordinators.get(key) ?? null : null;
}

export function configureAutoIndex(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig,
  getIndexer: () => CoordinatedIndexer,
): void {
  const safety = getProjectSafety(projectRoot, config);
  const registration: AutoIndexRegistration = {
    config,
    getIndexer,
    ...safety,
  };
  const key = coordinatorKey(projectRoot, config, host);
  let coordinator = coordinators.get(key);
  if (!coordinator) {
    coordinator = new AutoIndexCoordinator(registration);
    coordinators.set(key, coordinator);
  } else {
    coordinator.update(registration);
  }
  coordinatorKeysByProject.set(projectLookupKey(projectRoot, host), key);
}

export function startAutoIndex(
  projectRoot: string,
  host: HostMode = "opencode",
  source: "startup" | "retrieval" = "startup",
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.start(source) ?? null;
}

export function requestBackgroundIndex(
  projectRoot: string,
  host: HostMode = "opencode",
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.request({
    checkFreshness: false,
    force: false,
    source: "watcher",
  }) ?? null;
}

export function runCoordinatedIndex(
  projectRoot: string,
  host: HostMode,
  force: boolean,
  onProgress?: (progress: IndexProgress) => void,
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.request({
    checkFreshness: !force,
    force,
    onProgress,
    source: "manual",
  }) ?? null;
}

export function getAutoIndexStatus(
  projectRoot: string,
  host: HostMode = "opencode",
): AutoIndexStatusSnapshot {
  return getCoordinator(projectRoot, host)?.snapshot() ?? {
    enabled: false,
    state: "idle",
    updatedAt: now(),
  };
}

export async function waitForAutoIndexForRetrieval(
  projectRoot: string,
  host: HostMode = "opencode",
): Promise<AutoIndexRetrievalResult> {
  const coordinator = getCoordinator(projectRoot, host);
  if (!coordinator) return { ready: true };
  const initial = coordinator.snapshot();
  if (!initial.enabled) return { ready: true };
  if (initial.blockedReason === "home-directory") {
    return {
      ready: false,
      text: "Automatic indexing is disabled for the home directory. Open a specific project and retry.",
    };
  }
  if (initial.blockedReason === "project-marker-missing") {
    return {
      ready: false,
      text: "Automatic indexing is waiting for a recognized project marker. Add a project marker or set indexing.requireProjectMarker=false, then retry.",
    };
  }

  try {
    const currentStatus = await coordinator.getIndexer().getStatus();
    if (currentStatus.indexed) return { ready: true };
  } catch {
    // The coordinator reports a sanitized actionable failure below.
  }

  const job = coordinator.start("retrieval") ?? coordinator.currentJob();
  if (job) {
    await withTimeout(job, coordinator.getWaitMs());
  }

  try {
    const currentStatus = await coordinator.getIndexer().getStatus();
    if (currentStatus.indexed) return { ready: true };
  } catch {
    // The coordinator reports a sanitized actionable failure below.
  }

  const status = coordinator.snapshot();
  if (status.state === "failed") {
    return {
      ready: false,
      text: `Automatic indexing failed${status.errorAt ? ` at ${status.errorAt}` : ""}. ${status.lastError ?? "Check index_status, then run index_codebase."}`,
    };
  }
  if (status.state === "stopped") {
    return {
      ready: false,
      text: "Automatic indexing stopped before a readable index was ready. Restart the MCP server or run index_codebase.",
    };
  }
  return {
    ready: false,
    text: `Automatic indexing is ${status.state}. Retry shortly or call index_status for progress. You can also run index_codebase explicitly.`,
  };
}

export async function stopAutoIndex(
  projectRoot: string,
  host: HostMode = "opencode",
): Promise<void> {
  await getCoordinator(projectRoot, host)?.stop();
}

export async function stopAllAutoIndexes(): Promise<void> {
  await Promise.all(Array.from(coordinators.values(), (coordinator) => coordinator.stop()));
}

export async function resetAutoIndexCoordinatorsForTests(): Promise<void> {
  await stopAllAutoIndexes();
  coordinators.clear();
  coordinatorKeysByProject.clear();
}
