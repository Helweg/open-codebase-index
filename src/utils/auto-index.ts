import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import type { Indexer, IndexProgress, IndexStats } from "../indexer/index.js";
import type { OperationControl } from "./operation-control.js";
import type { BackgroundIndexingPolicy } from "./power-source.js";
import { existsSync, realpathSync } from "fs";
import * as os from "os";
import * as path from "path";

import { resolveProjectIndexPath } from "../config/paths.js";
import { isTransientIndexLockContention } from "../indexer/index-lock.js";
import {
  isBackgroundWorkerLeader,
  isBackgroundWorkerManaged,
  requestBackgroundWorker,
  requestBackgroundWorkerRefresh,
  stopBackgroundWorker,
  updateBackgroundWorkerConfig,
} from "./background-worker.js";
import { hasProjectMarker } from "./files.js";
import { createBackgroundIndexingPolicy } from "./power-source.js";
import {
  raceWithOperationSignal,
  throwIfOperationAborted,
} from "./operation-control.js";

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

export interface AutoIndexStopResult {
  completed: boolean;
  completion: Promise<void>;
}

type CoordinatedIndexer = Pick<
  Indexer,
  "forceIndex" | "getStatus" | "index"
> & Partial<Pick<Indexer, "getIndexFreshness">>;

interface AutoIndexRegistration {
  backgroundIndexingPolicy: BackgroundIndexingPolicy | null;
  config: ParsedCodebaseIndexConfig;
  getIndexer: () => CoordinatedIndexer;
  projectRoot: string;
  safeToRun: boolean;
  blockedReason?: AutoIndexStatusSnapshot["blockedReason"];
}

interface IndexRequest {
  allowDisabledAutoIndex?: boolean;
  checkFreshness: boolean;
  force: boolean;
  hasIndependentOwner?: boolean;
  manualConsumerIds?: Set<symbol>;
  onProgress?: (progress: IndexProgress) => void;
  source: AutoIndexSource;
}

type RetrievalActivityControl = Pick<
  OperationControl,
  "heartbeat" | "reportProgress" | "setPhase"
>;

interface RetrievalActivitySubscriber {
  control: RetrievalActivityControl;
  queue: Promise<void>;
  lastPhase?: string;
}

const MAX_RETRY_DELAY_MS = 10_000;
const SHUTDOWN_WAIT_MS = 2_000;
const coordinators = new Map<string, AutoIndexCoordinator>();
const coordinatorKeysByProject = new Map<string, string>();
const coordinatorReplacementBarriers = new Map<string, Promise<void>>();

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

export function isHomeDirectory(projectRoot: string): boolean {
  return canonicalizePath(projectRoot) === canonicalizePath(os.homedir());
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

export function getProjectSafety(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
): Pick<AutoIndexRegistration, "blockedReason" | "safeToRun"> {
  if (isHomeDirectory(projectRoot)) {
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

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    void promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

function requestPriority(request: IndexRequest): number {
  if (request.force) return 4;
  if (request.source === "manual") return 3;
  if (request.source === "watcher") return 2;
  return 1;
}

function requestHasIndependentOwner(request: IndexRequest): boolean {
  return request.hasIndependentOwner ?? request.source !== "manual";
}

function mergeRequests(current: IndexRequest | null, next: IndexRequest): IndexRequest {
  if (!current) return next;
  const preferred = requestPriority(next) > requestPriority(current) ? next : current;
  const manualConsumerIds = new Set([
    ...(current.manualConsumerIds ?? []),
    ...(next.manualConsumerIds ?? []),
  ]);
  return {
    allowDisabledAutoIndex: current.allowDisabledAutoIndex || next.allowDisabledAutoIndex,
    checkFreshness: current.checkFreshness && next.checkFreshness,
    force: current.force || next.force,
    hasIndependentOwner: requestHasIndependentOwner(current) || requestHasIndependentOwner(next),
    ...(manualConsumerIds.size > 0 ? { manualConsumerIds } : {}),
    onProgress: next.onProgress ?? current.onProgress,
    source: preferred.source,
  };
}

class AutoIndexCoordinator {
  private registration: AutoIndexRegistration;
  private status: AutoIndexStatusSnapshot;
  private activation: Promise<void> | null = null;
  private inFlight: Promise<CoordinatedIndexResult> | null = null;
  private activeRequest: IndexRequest | null = null;
  private batteryCheck: Promise<CoordinatedIndexResult> | null = null;
  private batteryIndexJob: Promise<CoordinatedIndexResult> | null = null;
  private batteryDeferredRequest: IndexRequest | null = null;
  private batteryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveBatteryRetry: (() => void) | null = null;
  private pendingRequest: IndexRequest | null = null;
  private pendingFollowUp: Promise<CoordinatedIndexResult> | null = null;
  private abortController: AbortController | null = null;
  private readonly manualConsumerIds = new Set<symbol>();
  private readonly activeManualConsumerIds = new Set<symbol>();
  private activeHasIndependentOwner = false;
  private readonly manualProgressListeners = new Map<symbol, (progress: IndexProgress) => void>();
  private readonly manualPhaseListeners = new Map<symbol, NonNullable<
    NonNullable<Parameters<Indexer["index"]>[1]>["setPhase"]
  >>();
  private readonly manualHeartbeatListeners = new Map<symbol, () => void | Promise<void>>();
  private readonly manualProviderErrorListeners = new Map<symbol, NonNullable<Parameters<Indexer["index"]>[1]>["onProviderError"]>();
  private readonly retrievalActivitySubscribers = new Map<symbol, RetrievalActivitySubscriber>();
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
    const pauseOnBatteryChanged = registration.config.indexing.pauseBackgroundIndexingOnBattery
      !== this.registration.config.indexing.pauseBackgroundIndexingOnBattery;
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
    if (pauseOnBatteryChanged) {
      this.cancelBatteryRetry();
    }
  }

  activateAfter(activation: Promise<void>): void {
    const pendingActivation = activation.then(() => {
      if (this.activation === pendingActivation) {
        this.activation = null;
      }
    });
    this.activation = pendingActivation;
  }

  snapshot(): AutoIndexStatusSnapshot {
    this.refreshSafety();
    return {
      ...this.status,
      progress: this.status.progress ? { ...this.status.progress } : undefined,
    };
  }

  subscribeRetrievalActivity(control: RetrievalActivityControl | undefined): () => void {
    if (!control?.heartbeat && !control?.reportProgress && !control?.setPhase) {
      return () => undefined;
    }
    const id = Symbol("retrieval-activity-subscriber");
    this.retrievalActivitySubscribers.set(id, {
      control,
      queue: Promise.resolve(),
    });
    return () => {
      this.retrievalActivitySubscribers.delete(id);
    };
  }

  start(
    source: "startup" | "retrieval",
    allowDisabledAutoIndex = false,
  ): Promise<CoordinatedIndexResult> | null {
    this.refreshSafety();
    if ((!this.registration.config.indexing.autoIndex && !allowDisabledAutoIndex) || !this.registration.safeToRun) return null;
    if (this.status.state === "failed") return this.inFlight;
    return this.request({ allowDisabledAutoIndex, checkFreshness: true, force: false, source });
  }

  request(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (this.stopped) {
      return Promise.resolve({ outcome: "stopped" });
    }
    return this.activation
      ? this.activation.then(() => this.enqueueBatteryAwareRequest(request))
      : this.enqueueBatteryAwareRequest(request);
  }

  requestManual(
    force: boolean,
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    heartbeat?: () => void | Promise<void>,
    onProviderError?: NonNullable<Parameters<Indexer["index"]>[1]>["onProviderError"],
    setPhase?: NonNullable<Parameters<Indexer["index"]>[1]>["setPhase"],
  ): Promise<CoordinatedIndexResult> {
    const attach = async (): Promise<CoordinatedIndexResult> => {
      throwIfOperationAborted(signal);
      const consumerId = Symbol("manual-index-consumer");
      this.manualConsumerIds.add(consumerId);
      if (onProgress) this.manualProgressListeners.set(consumerId, onProgress);
      if (setPhase) this.manualPhaseListeners.set(consumerId, setPhase);
      if (heartbeat) this.manualHeartbeatListeners.set(consumerId, heartbeat);
      if (onProviderError) this.manualProviderErrorListeners.set(consumerId, onProviderError);
      const request: IndexRequest = {
        checkFreshness: !force,
        force,
        hasIndependentOwner: false,
        manualConsumerIds: new Set([consumerId]),
        source: "manual",
      };
      let detached = false;
      const detach = (): void => {
        if (detached) return;
        detached = true;
        this.manualConsumerIds.delete(consumerId);
        this.manualProgressListeners.delete(consumerId);
        this.manualPhaseListeners.delete(consumerId);
        this.manualHeartbeatListeners.delete(consumerId);
        this.manualProviderErrorListeners.delete(consumerId);
        const wasActive = this.activeManualConsumerIds.delete(consumerId);
        if (wasActive && this.activeManualConsumerIds.size === 0 && !this.activeHasIndependentOwner) {
          this.abortController?.abort();
        }
        if (this.pendingRequest?.manualConsumerIds?.delete(consumerId) === true
          && this.pendingRequest.manualConsumerIds.size === 0) {
          if (requestHasIndependentOwner(this.pendingRequest)) {
            this.pendingRequest = {
              ...this.pendingRequest,
              force: false,
              manualConsumerIds: undefined,
              onProgress: undefined,
              source: "watcher",
            };
          } else {
            this.pendingRequest = null;
          }
        }
      };
      signal?.addEventListener("abort", detach, { once: true });
      const job = this.enqueueBatteryAwareRequest(request);

      try {
        return await raceWithOperationSignal(job, signal);
      } finally {
        signal?.removeEventListener("abort", detach);
        detach();
      }
    };

    const activation = this.activation;
    return activation
      ? raceWithOperationSignal(activation, signal).then(attach)
      : attach();
  }

  private enqueueBatteryAwareRequest(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (!this.shouldDeferForBattery(request)) {
      return this.enqueueRequest(request);
    }

    if (this.batteryCheck && this.batteryIndexJob !== null && this.batteryIndexJob === this.inFlight) {
      return this.enqueueRequest(request);
    }

    this.batteryDeferredRequest = mergeRequests(this.batteryDeferredRequest, request);
    if (this.batteryCheck) {
      return this.batteryCheck;
    }

    const batteryCheck = this.waitForACPower();
    this.batteryCheck = batteryCheck;
    void batteryCheck.then(
      () => this.finishBatteryCheck(batteryCheck),
      () => this.finishBatteryCheck(batteryCheck),
    );
    return batteryCheck;
  }

  private enqueueRequest(request: IndexRequest): Promise<CoordinatedIndexResult> {
    if (this.stopped || !this.canRun(request)) {
      return Promise.resolve({ outcome: "stopped" });
    }
    if (this.inFlight) {
      if (request.force && !this.activeRequest?.force) {
        this.pendingRequest = mergeRequests(this.pendingRequest, request);
        const active = this.inFlight;
        return active.then(() => {
          if (this.stopped) return { outcome: "stopped" };
          const hasLiveManualConsumer = Array.from(request.manualConsumerIds ?? [])
            .some((consumerId) => this.manualConsumerIds.has(consumerId));
          if (!requestHasIndependentOwner(request) && !hasLiveManualConsumer) {
            return { outcome: "stopped" };
          }
          return this.pendingFollowUp ?? this.inFlight ?? { outcome: "stopped" };
        });
      }
      if (request.source === "watcher") {
        this.pendingRequest = mergeRequests(this.pendingRequest, request);
        const active = this.inFlight;
        return active.then(() => {
          if (this.stopped) return { outcome: "stopped" };
          return this.pendingFollowUp ?? { outcome: "stopped" };
        });
      }
      if (requestHasIndependentOwner(request)) {
        this.activeHasIndependentOwner = true;
      }
      for (const consumerId of request.manualConsumerIds ?? []) {
        if (this.manualConsumerIds.has(consumerId)) {
          this.activeManualConsumerIds.add(consumerId);
        }
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

  async stop(waitForCompletion = false): Promise<AutoIndexStopResult> {
    this.stopped = true;
    this.batteryDeferredRequest = null;
    this.cancelBatteryRetry();
    this.pendingRequest = null;
    this.abortController?.abort();
    this.setState("stopped", {
      completedAt: now(),
      nextRetryAt: undefined,
      progress: undefined,
      retryAttempt: undefined,
    });
    const inFlight = this.inFlight;
    const completion = inFlight
      ? inFlight.then(() => undefined, () => undefined)
      : Promise.resolve();
    if (!inFlight) {
      return { completed: true, completion };
    }
    if (waitForCompletion) {
      await completion;
      return { completed: true, completion };
    }
    return { completed: await settlesWithin(completion, SHUTDOWN_WAIT_MS), completion };
  }

  private startRequest(request: IndexRequest): Promise<CoordinatedIndexResult> {
    const hasLiveManualConsumer = Array.from(request.manualConsumerIds ?? [])
      .some((consumerId) => this.manualConsumerIds.has(consumerId));
    if (this.stopped
      || !this.canRun(request)
      || (!requestHasIndependentOwner(request) && !hasLiveManualConsumer)) {
      return Promise.resolve({ outcome: "stopped" });
    }
    this.activeRequest = request;
    this.activeManualConsumerIds.clear();
    for (const consumerId of request.manualConsumerIds ?? []) {
      if (this.manualConsumerIds.has(consumerId)) {
        this.activeManualConsumerIds.add(consumerId);
      }
    }
    this.activeHasIndependentOwner = requestHasIndependentOwner(request);
    const job = this.run(request);
    this.inFlight = job;
    void job.then(() => {
      if (this.inFlight !== job) return;
      this.inFlight = null;
      this.activeRequest = null;
      this.abortController = null;
      this.activeManualConsumerIds.clear();
      this.activeHasIndependentOwner = false;
      if (this.batteryIndexJob === job) {
        this.batteryIndexJob = null;
        this.batteryCheck = null;
      }
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      const hasLiveManualConsumer = Array.from(pending?.manualConsumerIds ?? [])
        .some((consumerId) => this.manualConsumerIds.has(consumerId));
      if (pending && !this.stopped && (requestHasIndependentOwner(pending) || hasLiveManualConsumer)) {
        const followUp = this.request(pending);
        this.pendingFollowUp = followUp;
        void followUp.then(() => {
          if (this.pendingFollowUp === followUp) {
            this.pendingFollowUp = null;
          }
        });
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
          for (const consumerId of this.activeManualConsumerIds) {
            this.manualProgressListeners.get(consumerId)?.(progress);
          }
          this.status.progress = {
            phase: progress.phase,
            filesProcessed: progress.filesProcessed,
            totalFiles: progress.totalFiles,
            chunksProcessed: progress.chunksProcessed,
            totalChunks: progress.totalChunks,
            percentage: calculatePercentage(progress),
          };
          this.status.updatedAt = now();
          this.notifyRetrievalProgress(progress);
        }, {
          signal: controller.signal,
          setPhase: async (phase) => {
            this.notifyRetrievalPhase(phase);
            await Promise.all(Array.from(this.activeManualConsumerIds, async (consumerId) => {
              await this.manualPhaseListeners.get(consumerId)?.(phase);
            }));
          },
          heartbeat: async () => {
            this.notifyRetrievalHeartbeat();
            await Promise.all(Array.from(this.activeManualConsumerIds, async (consumerId) => {
              await this.manualHeartbeatListeners.get(consumerId)?.();
            }));
          },
          onProviderError: (error) => {
            for (const consumerId of this.activeManualConsumerIds) {
              this.manualProviderErrorListeners.get(consumerId)?.(error);
            }
          },
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
          if (request.source === "manual") {
            this.setState("stopped", { completedAt: now(), progress: undefined });
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
    if (this.stopped && state !== "stopped") return;
    this.status = {
      ...this.status,
      ...updates,
      enabled: this.registration.config.indexing.autoIndex,
      state,
      updatedAt: now(),
      blockedReason: this.registration.blockedReason,
    };
  }

  private enqueueRetrievalActivity(
    id: symbol,
    subscriber: RetrievalActivitySubscriber,
    task: (subscriber: RetrievalActivitySubscriber) => Promise<void>,
  ): void {
    subscriber.queue = subscriber.queue.then(async () => {
      if (this.retrievalActivitySubscribers.get(id) !== subscriber) return;
      await task(subscriber);
    }).catch(() => {
      this.retrievalActivitySubscribers.delete(id);
    });
  }

  private notifyRetrievalPhase(phase: string): void {
    for (const [id, subscriber] of this.retrievalActivitySubscribers) {
      this.enqueueRetrievalActivity(id, subscriber, async (active) => {
        if (active.lastPhase === phase) return;
        active.lastPhase = phase;
        await active.control.setPhase?.(phase);
      });
    }
  }

  private notifyRetrievalHeartbeat(): void {
    for (const [id, subscriber] of this.retrievalActivitySubscribers) {
      this.enqueueRetrievalActivity(id, subscriber, async (active) => {
        await active.control.heartbeat?.();
      });
    }
  }

  private notifyRetrievalProgress(progress: IndexProgress): void {
    for (const [id, subscriber] of this.retrievalActivitySubscribers) {
      this.enqueueRetrievalActivity(id, subscriber, async (active) => {
        if (active.control.reportProgress) {
          active.lastPhase = progress.phase;
          await active.control.reportProgress(calculatePercentage(progress), progress.phase);
          return;
        }
        if (active.lastPhase !== progress.phase) {
          active.lastPhase = progress.phase;
          await active.control.setPhase?.(progress.phase);
        }
        await active.control.heartbeat?.();
      });
    }
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AutoIndexCancelledError();
  }

  private refreshSafety(): void {
    const previousBlockedReason = this.registration.blockedReason;
    const safety = getProjectSafety(this.registration.projectRoot, this.registration.config);
    this.registration.safeToRun = safety.safeToRun;
    this.registration.blockedReason = safety.blockedReason;
    this.status.blockedReason = safety.blockedReason;
    if (previousBlockedReason !== safety.blockedReason) {
      this.status.updatedAt = now();
    }
  }

  private canRun(request: IndexRequest): boolean {
    this.refreshSafety();
    if (request.source === "manual" || request.source === "watcher") {
      return true;
    }

    return this.registration.safeToRun && (
      this.registration.config.indexing.autoIndex || request.allowDisabledAutoIndex === true
    );
  }

  private shouldDeferForBattery(request: IndexRequest): boolean {
    return this.registration.backgroundIndexingPolicy !== null
      && (request.source === "startup" || request.source === "watcher");
  }

  private async waitForACPower(): Promise<CoordinatedIndexResult> {
    while (!this.stopped) {
      const policy = this.registration.backgroundIndexingPolicy;
      if (!policy || !await this.isBatteryPauseActive(policy)) {
        const request = this.batteryDeferredRequest;
        this.batteryDeferredRequest = null;
        if (!request) return { outcome: "stopped" };
        const job = this.enqueueRequest(request);
        if (this.inFlight === job) {
          this.batteryIndexJob = job;
        }
        return job;
      }
      await this.waitForBatteryRetry(policy.recheckDelayMs);
    }
    return { outcome: "stopped" };
  }

  private async isBatteryPauseActive(policy: BackgroundIndexingPolicy): Promise<boolean> {
    try {
      return await policy.isPaused();
    } catch (error) {
      console.error(
        `[codebase-index] Failed to apply the background indexing power policy; background indexing will continue: ${safeFailureMessage(error)}`,
      );
      return false;
    }
  }

  private waitForBatteryRetry(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.batteryRetryTimer === timer) {
          this.batteryRetryTimer = null;
          this.resolveBatteryRetry = null;
        }
        resolve();
      }, delayMs);
      timer.unref?.();
      this.batteryRetryTimer = timer;
      this.resolveBatteryRetry = resolve;
    });
  }

  private cancelBatteryRetry(): void {
    if (this.batteryRetryTimer) {
      clearTimeout(this.batteryRetryTimer);
      this.batteryRetryTimer = null;
    }
    const resolve = this.resolveBatteryRetry;
    this.resolveBatteryRetry = null;
    resolve?.();
  }

  private finishBatteryCheck(batteryCheck: Promise<CoordinatedIndexResult>): void {
    if (this.batteryCheck !== batteryCheck) return;
    this.batteryCheck = null;
    const deferredRequest = this.batteryDeferredRequest;
    this.batteryDeferredRequest = null;
    if (deferredRequest && !this.stopped) {
      void this.request(deferredRequest);
    }
  }
}

function getCoordinator(projectRoot: string, host: HostMode): AutoIndexCoordinator | null {
  const key = coordinatorKeysByProject.get(projectLookupKey(projectRoot, host));
  return key ? coordinators.get(key) ?? null : null;
}

interface ConfigureAutoIndexOptions {
  preserveManagedWorker?: boolean;
  synchronizeBackgroundWorker?: boolean;
}

function synchronizeBackgroundWorker(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig,
  safeToRun: boolean,
): void {
  if (safeToRun) {
    updateBackgroundWorkerConfig(projectRoot, host, config);
    return;
  }

  void stopBackgroundWorker(projectRoot, host).catch((error: unknown) => {
    console.error("[codebase-index] Failed to stop background worker after project safety changed:", error);
  });
}

export function configureAutoIndex(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig,
  getIndexer: () => CoordinatedIndexer,
  options: ConfigureAutoIndexOptions = {},
): void {
  const projectKey = projectLookupKey(projectRoot, host);
  const safety = getProjectSafety(projectRoot, config);
  const synchronizeWorker = options.synchronizeBackgroundWorker ?? true;
  if (options.preserveManagedWorker === true && isBackgroundWorkerManaged(projectRoot, host)) {
    // Initialization callers must not replace state owned by an existing worker.
    return;
  }
  const registration: AutoIndexRegistration = {
    backgroundIndexingPolicy: createBackgroundIndexingPolicy(
      config.indexing.pauseBackgroundIndexingOnBattery,
    ),
    config,
    getIndexer,
    projectRoot,
    ...safety,
  };
  const key = coordinatorKey(projectRoot, config, host);
  const previousKey = coordinatorKeysByProject.get(projectKey);
  if (previousKey && previousKey !== key) {
    const previousCoordinator = coordinators.get(previousKey);
    const previousBarrier = coordinatorReplacementBarriers.get(projectKey) ?? Promise.resolve();
    const stopPrevious = previousCoordinator?.stop(true) ?? Promise.resolve();
    const activation = Promise.all([previousBarrier, stopPrevious]).then(() => undefined);
    coordinatorReplacementBarriers.set(projectKey, activation);

    if (synchronizeWorker) {
      // The existing worker's stop hook resolves the coordinator by project key.
      // Synchronize it before publishing the replacement so teardown cannot
      // stop the new coordinator instead of the one being drained.
      synchronizeBackgroundWorker(projectRoot, host, config, safety.safeToRun);
    }
    coordinators.delete(previousKey);

    const coordinator = new AutoIndexCoordinator(registration);
    coordinator.activateAfter(activation);
    coordinators.set(key, coordinator);
    coordinatorKeysByProject.set(projectKey, key);
    return;
  }

  let coordinator = coordinators.get(key);
  if (!coordinator) {
    coordinator = new AutoIndexCoordinator(registration);
    coordinators.set(key, coordinator);
  } else {
    coordinator.update(registration);
  }
  coordinatorKeysByProject.set(projectKey, key);
  if (synchronizeWorker) {
    synchronizeBackgroundWorker(projectRoot, host, config, safety.safeToRun);
  }
}

export function startAutoIndex(
  projectRoot: string,
  host: HostMode,
  source: "startup" | "retrieval" = "startup",
): Promise<CoordinatedIndexResult> | null {
  if (isBackgroundWorkerManaged(projectRoot, host)) {
    if (source === "retrieval") {
      requestBackgroundWorkerRefresh(projectRoot, host);
    } else {
      requestBackgroundWorker(projectRoot, host);
    }
    return isBackgroundWorkerLeader(projectRoot, host)
      ? getCoordinator(projectRoot, host)?.currentJob() ?? null
      : null;
  }
  return startAutoIndexForBackgroundWorker(projectRoot, host, source);
}

export function startAutoIndexForBackgroundWorker(
  projectRoot: string,
  host: HostMode,
  source: "startup" | "retrieval" = "startup",
  allowDisabledAutoIndex = false,
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.start(source, allowDisabledAutoIndex) ?? null;
}

export function requestBackgroundIndex(
  projectRoot: string,
  host: HostMode,
): Promise<CoordinatedIndexResult> | null {
  if (isBackgroundWorkerManaged(projectRoot, host) && !isBackgroundWorkerLeader(projectRoot, host)) {
    return null;
  }
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
  signal?: AbortSignal,
  heartbeat?: () => void | Promise<void>,
  onProviderError?: NonNullable<Parameters<Indexer["index"]>[1]>["onProviderError"],
  setPhase?: NonNullable<Parameters<Indexer["index"]>[1]>["setPhase"],
): Promise<CoordinatedIndexResult> | null {
  return getCoordinator(projectRoot, host)?.requestManual(
    force,
    onProgress,
    signal,
    heartbeat,
    onProviderError,
    setPhase,
  ) ?? null;
}

export function getAutoIndexStatus(
  projectRoot: string,
  host: HostMode,
): AutoIndexStatusSnapshot {
  return getCoordinator(projectRoot, host)?.snapshot() ?? {
    enabled: false,
    state: "idle",
    updatedAt: now(),
  };
}

async function waitForAutoIndexForRetrievalFromCoordinator(
  projectRoot: string,
  host: HostMode,
  coordinator: AutoIndexCoordinator | null,
): Promise<AutoIndexRetrievalResult> {
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
    const readiness = await getSearchReadiness(coordinator);
    if (readiness.searchable) {
      return { ready: true };
    }
    if (readiness.blocked) return unavailableSnapshotResult(readiness.reason);
  } catch {
    // The coordinator reports a sanitized actionable failure below.
  }

  const job = startRetrievalRefresh(projectRoot, host, coordinator);
  if (job) {
    await withTimeout(job, coordinator.getWaitMs());
  } else if (isBackgroundWorkerManaged(projectRoot, host)) {
    await waitForPublishedSnapshot(coordinator, coordinator.getWaitMs());
  }

  try {
    const readiness = await getSearchReadiness(coordinator);
    if (readiness.searchable) return { ready: true };
    if (readiness.blocked) return unavailableSnapshotResult(readiness.reason);
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

export function waitForAutoIndexForRetrieval(
  projectRoot: string,
  host: HostMode,
  control?: Pick<OperationControl, "heartbeat" | "reportProgress" | "setPhase" | "signal">,
): Promise<AutoIndexRetrievalResult> {
  const coordinator = getCoordinator(projectRoot, host);
  const detach = coordinator?.subscribeRetrievalActivity(control) ?? (() => undefined);
  return raceWithOperationSignal(
    waitForAutoIndexForRetrievalFromCoordinator(projectRoot, host, coordinator),
    control?.signal,
  ).finally(detach);
}

export async function stopAutoIndex(
  projectRoot: string,
  host: HostMode,
  waitForCompletion = false,
): Promise<void> {
  await stopAutoIndexForBackgroundWorker(projectRoot, host, waitForCompletion);
}

export async function stopAutoIndexForBackgroundWorker(
  projectRoot: string,
  host: HostMode,
  waitForCompletion = false,
): Promise<AutoIndexStopResult> {
  const coordinator = getCoordinator(projectRoot, host);
  if (!coordinator) {
    return { completed: true, completion: Promise.resolve() };
  }
  return coordinator.stop(waitForCompletion);
}

export async function stopAllAutoIndexes(): Promise<void> {
  await Promise.all(Array.from(coordinators.values(), (coordinator) => coordinator.stop()));
}

export async function resetAutoIndexCoordinatorsForTests(): Promise<void> {
  await stopAllAutoIndexes();
  await Promise.all(coordinatorReplacementBarriers.values());
  coordinators.clear();
  coordinatorKeysByProject.clear();
  coordinatorReplacementBarriers.clear();
}

interface SearchReadiness {
  blocked: boolean;
  reason?: string;
  searchable: boolean;
}

async function getSearchReadiness(coordinator: AutoIndexCoordinator): Promise<SearchReadiness> {
  const indexer = coordinator.getIndexer();
  if (indexer.getIndexFreshness) {
    const freshness = await indexer.getIndexFreshness();
    const searchable = freshness.readable && freshness.current && freshness.reason === "current";
    return {
      blocked: freshness.reason === "unreadable"
        || freshness.reason === "incompatible"
        || freshness.reason === "failed-batches"
        || freshness.reason === "migration-required",
      reason: freshness.reason,
      searchable,
    };
  }
  const indexed = (await indexer.getStatus()).indexed;
  return { blocked: false, searchable: indexed };
}

function unavailableSnapshotResult(reason: string | undefined): AutoIndexRetrievalResult {
  const detail = reason === "incompatible"
    ? "The existing index is incompatible with the configured embedding provider."
    : reason === "migration-required"
      ? "The existing index requires a storage migration."
      : reason === "failed-batches"
        ? "The existing index has failed embedding batches."
        : "The existing index is unreadable.";
  return {
    ready: false,
    text: `${detail} Run index_codebase before retrying retrieval.`,
  };
}

function startRetrievalRefresh(
  projectRoot: string,
  host: HostMode,
  coordinator: AutoIndexCoordinator,
): Promise<CoordinatedIndexResult> | null {
  if (isBackgroundWorkerManaged(projectRoot, host)) {
    requestBackgroundWorkerRefresh(projectRoot, host, true);
    return isBackgroundWorkerLeader(projectRoot, host)
      ? coordinator.currentJob()
      : null;
  }
  return coordinator.start("retrieval") ?? coordinator.currentJob();
}

async function waitForPublishedSnapshot(
  coordinator: AutoIndexCoordinator,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await getSearchReadiness(coordinator)).searchable) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
}
