import type { HostMode } from "../config/host.js";
import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { AutoIndexStopResult } from "./auto-index.js";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveProjectIndexPath } from "../config/paths.js";

const OWNER_FILE_NAME = "owner.json";
const HEARTBEAT_FILE_PREFIX = "heartbeat.";
const RECLAIM_DIRECTORY_NAME = "reclaim";
const REFRESH_REQUEST_FILE_NAME = "refresh-request.json";
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_LEASE_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OwnerLiveness = "alive" | "dead" | "unknown";

export interface BackgroundWorkerWatcher {
  whenReady?: () => Promise<void>;
  stop(): Promise<void>;
}

export interface BackgroundWorkerHooks {
  startAutoIndex: (source: "startup" | "retrieval", allowDisabledAutoIndex?: boolean) => void;
  stopAutoIndex: () => Promise<AutoIndexStopResult>;
  watcherFactory?: (() => BackgroundWorkerWatcher) | null;
  watcherFactoryForConfig?: (
    config: ParsedCodebaseIndexConfig,
  ) => (() => BackgroundWorkerWatcher) | null;
  replaceWatcher?: boolean;
}

interface BackgroundWorkerConfigureOptions {
  stopPreviousAutoIndex?: boolean;
  restartAutoIndex?: boolean;
}

export class BackgroundWorkerStopError extends Error {
  constructor(
    readonly watcherError: unknown | undefined,
    readonly autoIndexError: unknown | undefined,
  ) {
    super("Failed to stop background worker");
    this.name = "BackgroundWorkerStopError";
  }
}

export interface BackgroundWorkerLeaseOwner {
  version: 1;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  projectRoot: string;
  indexPath: string;
  token: string;
}

interface BackgroundWorkerLeaseHeartbeat {
  version: 1;
  token: string;
  heartbeatAt: string;
}

interface BackgroundWorkerRefreshRequest {
  allowDisabledAutoIndex: boolean;
  requestedAt: string;
  version: 1;
}

interface BackgroundWorkerReclaimOwner {
  version: 1;
  pid: number;
  hostname: string;
  startedAt: string;
  token: string;
  expectedOwnerToken: string | null;
}

interface BackgroundWorkerLease {
  leasePath: string;
  owner: BackgroundWorkerLeaseOwner;
}

export interface BackgroundWorkerLeaseHandle {
  readonly leasePath: string;
  readonly owner: Readonly<BackgroundWorkerLeaseOwner>;
  release(): boolean;
}

interface BackgroundWorkerIdentity {
  canonicalIndexPath: string;
  canonicalProjectRoot: string;
  key: string;
}

const workers = new Map<string, BackgroundWorkerController>();
const workerKeysByProject = new Map<string, string>();
const workerReplacementBarriers = new Map<string, Promise<void>>();

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
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

export function getBackgroundWorkerProjectKey(projectRoot: string, host: HostMode): string {
  return projectLookupKey(projectRoot, host);
}

function resolveIdentity(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): BackgroundWorkerIdentity {
  const canonicalProjectRoot = canonicalizePath(projectRoot);
  const canonicalIndexPath = canonicalizePath(resolveProjectIndexPath(projectRoot, config.scope, host));
  return {
    canonicalIndexPath,
    canonicalProjectRoot,
    key: `${canonicalIndexPath}::${canonicalProjectRoot}`,
  };
}

function controllerKey(identity: BackgroundWorkerIdentity, host: HostMode): string {
  return `${identity.key}::${host}`;
}

function leaseDirectoryName(identity: BackgroundWorkerIdentity): string {
  const hash = createHash("sha256").update(identity.key).digest("hex").slice(0, 32);
  return `background-worker.${hash}.lease`;
}

function leasePathFor(identity: BackgroundWorkerIdentity): string {
  return path.join(identity.canonicalIndexPath, leaseDirectoryName(identity));
}

function parseOwner(value: unknown): BackgroundWorkerLeaseOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BackgroundWorkerLeaseOwner>;
  if (candidate.version !== 1) return null;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (typeof candidate.hostname !== "string" || candidate.hostname.length === 0) return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt))) return null;
  if (typeof candidate.heartbeatAt !== "string" || Number.isNaN(Date.parse(candidate.heartbeatAt))) return null;
  if (typeof candidate.projectRoot !== "string" || candidate.projectRoot.length === 0) return null;
  if (typeof candidate.indexPath !== "string" || candidate.indexPath.length === 0) return null;
  if (typeof candidate.token !== "string" || !UUID_PATTERN.test(candidate.token)) return null;
  return candidate as BackgroundWorkerLeaseOwner;
}

function parseHeartbeat(value: unknown, expectedToken: string): BackgroundWorkerLeaseHeartbeat | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BackgroundWorkerLeaseHeartbeat>;
  if (candidate.version !== 1 || candidate.token !== expectedToken) return null;
  if (typeof candidate.heartbeatAt !== "string" || Number.isNaN(Date.parse(candidate.heartbeatAt))) return null;
  return candidate as BackgroundWorkerLeaseHeartbeat;
}

function parseReclaimOwner(value: unknown): BackgroundWorkerReclaimOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<BackgroundWorkerReclaimOwner>;
  if (candidate.version !== 1) return null;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (typeof candidate.hostname !== "string" || candidate.hostname.length === 0) return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt))) return null;
  if (typeof candidate.token !== "string" || !UUID_PATTERN.test(candidate.token)) return null;
  if (candidate.expectedOwnerToken !== null && (
    typeof candidate.expectedOwnerToken !== "string" || !UUID_PATTERN.test(candidate.expectedOwnerToken)
  )) return null;
  return candidate as BackgroundWorkerReclaimOwner;
}

function heartbeatPath(leasePath: string, token: string): string {
  return path.join(leasePath, `${HEARTBEAT_FILE_PREFIX}${token}.json`);
}

function reclaimPath(leasePath: string): string {
  return path.join(leasePath, RECLAIM_DIRECTORY_NAME);
}

function refreshRequestPath(leasePath: string): string {
  return path.join(leasePath, REFRESH_REQUEST_FILE_NAME);
}

function readLeaseOwner(leasePath: string): BackgroundWorkerLeaseOwner | null {
  try {
    return parseOwner(JSON.parse(readFileSync(path.join(leasePath, OWNER_FILE_NAME), "utf-8")));
  } catch {
    return null;
  }
}

function readOwner(leasePath: string): BackgroundWorkerLeaseOwner | null {
  const owner = readLeaseOwner(leasePath);
  if (!owner) return null;
  try {
    const heartbeat = parseHeartbeat(
      JSON.parse(readFileSync(heartbeatPath(leasePath, owner.token), "utf-8")),
      owner.token,
    );
    return heartbeat ? { ...owner, heartbeatAt: heartbeat.heartbeatAt } : owner;
  } catch {
    return owner;
  }
}

function readReclaimOwner(leasePath: string): BackgroundWorkerReclaimOwner | null {
  try {
    return parseReclaimOwner(JSON.parse(readFileSync(path.join(reclaimPath(leasePath), OWNER_FILE_NAME), "utf-8")));
  } catch {
    return null;
  }
}

function ownerLiveness(owner: Pick<BackgroundWorkerLeaseOwner, "hostname" | "pid">): OwnerLiveness {
  if (owner.hostname !== os.hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function isHeartbeatExpired(owner: Pick<BackgroundWorkerLeaseOwner, "heartbeatAt">): boolean {
  return Date.now() - Date.parse(owner.heartbeatAt) >= STALE_LEASE_MS;
}

function sameOwner(left: BackgroundWorkerLeaseOwner, right: BackgroundWorkerLeaseOwner): boolean {
  return left.pid === right.pid
    && left.hostname === right.hostname
    && left.token === right.token;
}

function writeHeartbeat(leasePath: string, owner: BackgroundWorkerLeaseOwner): boolean {
  const targetPath = heartbeatPath(leasePath, owner.token);
  const temporaryPath = `${targetPath}.tmp.${process.pid}.${owner.token}.${randomUUID()}`;
  const heartbeat: BackgroundWorkerLeaseHeartbeat = {
    version: 1,
    token: owner.token,
    heartbeatAt: owner.heartbeatAt,
  };
  try {
    writeFileSync(temporaryPath, JSON.stringify(heartbeat), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, targetPath);
    const currentOwner = readLeaseOwner(leasePath);
    return currentOwner !== null && sameOwner(currentOwner, owner);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function requestRefreshFromLeader(leasePath: string, allowDisabledAutoIndex: boolean): void {
  const requestPath = refreshRequestPath(leasePath);
  const temporaryPath = `${requestPath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    const request: BackgroundWorkerRefreshRequest = {
      allowDisabledAutoIndex,
      requestedAt: new Date().toISOString(),
      version: 1,
    };
    writeFileSync(temporaryPath, JSON.stringify(request), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, requestPath);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.error("[codebase-index] Failed to request background index refresh from the project worker:", error);
    }
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

function consumeRefreshRequest(leasePath: string): BackgroundWorkerRefreshRequest | null {
  const requestPath = refreshRequestPath(leasePath);
  const claimedPath = `${requestPath}.handling.${process.pid}.${randomUUID()}`;
  try {
    renameSync(requestPath, claimedPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(readFileSync(claimedPath, "utf-8")) as Partial<BackgroundWorkerRefreshRequest>;
    return {
      allowDisabledAutoIndex: value.version === 1 && value.allowDisabledAutoIndex === true,
      requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : new Date().toISOString(),
      version: 1,
    };
  } catch {
    // Older refresh files had no payload beyond their presence.
    return { allowDisabledAutoIndex: false, requestedAt: new Date().toISOString(), version: 1 };
  } finally {
    rmSync(claimedPath, { force: true });
  }
}

function publishLease(leasePath: string, owner: BackgroundWorkerLeaseOwner): boolean {
  const candidatePath = `${leasePath}.candidate.${process.pid}.${owner.token}`;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  try {
    writeFileSync(path.join(candidatePath, OWNER_FILE_NAME), JSON.stringify(owner), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    if (existsSync(leasePath)) return false;
    try {
      renameSync(candidatePath, leasePath);
      return true;
    } catch (error) {
      if (existsSync(leasePath) || getErrorCode(error) === "ENOENT") return false;
      throw error;
    }
  } finally {
    if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true });
  }
}

function sameReclaimOwner(left: BackgroundWorkerReclaimOwner, right: BackgroundWorkerReclaimOwner): boolean {
  return left.pid === right.pid
    && left.hostname === right.hostname
    && left.token === right.token
    && left.expectedOwnerToken === right.expectedOwnerToken;
}

function reclaimerLiveness(owner: BackgroundWorkerReclaimOwner): OwnerLiveness {
  return ownerLiveness(owner);
}

function isReclaimMarkerExpired(leasePath: string, owner: BackgroundWorkerReclaimOwner | null): boolean {
  const startedAt = owner ? Date.parse(owner.startedAt) : (() => {
    try {
      return lstatSync(reclaimPath(leasePath)).mtimeMs;
    } catch {
      return Date.now();
    }
  })();
  return Date.now() - startedAt >= STALE_LEASE_MS;
}

function hasActiveReclaimMarker(leasePath: string, owner: BackgroundWorkerLeaseOwner): boolean {
  const marker = readReclaimOwner(leasePath);
  return marker !== null
    && marker.expectedOwnerToken === owner.token
    && (marker.hostname !== os.hostname() || ownerLiveness(owner) !== "alive");
}

function publishReclaimMarker(
  leasePath: string,
  expectedOwner: BackgroundWorkerLeaseOwner | null,
): BackgroundWorkerReclaimOwner | null {
  const markerPath = reclaimPath(leasePath);
  const owner: BackgroundWorkerReclaimOwner = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    token: randomUUID(),
    expectedOwnerToken: expectedOwner?.token ?? null,
  };
  try {
    mkdirSync(markerPath, { mode: 0o700 });
  } catch (error) {
    if (getErrorCode(error) === "EEXIST" || getErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    writeFileSync(path.join(markerPath, OWNER_FILE_NAME), JSON.stringify(owner), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    return owner;
  } catch (error) {
    rmSync(markerPath, { recursive: true, force: true });
    throw error;
  }
}

function removeExpiredReclaimMarker(
  leasePath: string,
  expectedOwner: BackgroundWorkerLeaseOwner | null,
): boolean {
  const marker = readReclaimOwner(leasePath);
  const markerPath = reclaimPath(leasePath);
  if (!existsSync(markerPath)) return false;
  if (marker && marker.expectedOwnerToken !== (expectedOwner?.token ?? null)) return false;
  if (marker && (reclaimerLiveness(marker) === "alive" || !isReclaimMarkerExpired(leasePath, marker))) return false;
  if (!marker && !isReclaimMarkerExpired(leasePath, null)) return false;
  const staleMarkerPath = `${markerPath}.stale.${marker?.pid ?? process.pid}.${marker?.token ?? randomUUID()}.${randomUUID()}`;
  try {
    renameSync(markerPath, staleMarkerPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    let claimedMarker: BackgroundWorkerReclaimOwner | null = null;
    try {
      claimedMarker = parseReclaimOwner(
        JSON.parse(readFileSync(path.join(staleMarkerPath, OWNER_FILE_NAME), "utf-8")),
      );
    } catch {
      claimedMarker = null;
    }
    const markerMatches = marker
      ? claimedMarker !== null && sameReclaimOwner(claimedMarker, marker)
      : claimedMarker === null;
    if (!markerMatches || !canReclaimLease(leasePath, expectedOwner)) {
      if (!existsSync(markerPath) && existsSync(staleMarkerPath)) renameSync(staleMarkerPath, markerPath);
      return false;
    }
    rmSync(staleMarkerPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function canReclaimLease(leasePath: string, expectedOwner: BackgroundWorkerLeaseOwner | null): boolean {
  if (!existsSync(leasePath)) return false;
  if (!expectedOwner) return false;
  const currentOwner = readOwner(leasePath);
  if (!currentOwner || !sameOwner(currentOwner, expectedOwner)) return false;
  if (currentOwner.hostname === os.hostname()) {
    // Never evict a local PID unless the kernel confirms it is dead. A late
    // heartbeat or an ambiguous liveness check is insufficient evidence.
    return ownerLiveness(currentOwner) === "dead";
  }
  return isHeartbeatExpired(currentOwner);
}

function reclaimLease(leasePath: string, expectedOwner: BackgroundWorkerLeaseOwner | null): boolean {
  let marker: BackgroundWorkerReclaimOwner | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    marker = publishReclaimMarker(leasePath, expectedOwner);
    if (marker) break;
    if (attempt === 0 && removeExpiredReclaimMarker(leasePath, expectedOwner)) continue;
    return false;
  }
  if (!marker) return false;

  const markerPath = reclaimPath(leasePath);
  try {
    const currentMarker = readReclaimOwner(leasePath);
    if (!currentMarker || !sameReclaimOwner(currentMarker, marker) || !canReclaimLease(leasePath, expectedOwner)) {
      return false;
    }
    const stalePath = `${leasePath}.stale.${process.pid}.${marker.token}`;
    renameSync(leasePath, stalePath);
    const quarantinedOwner = readOwner(stalePath);
    const quarantinedMarker = readReclaimOwner(stalePath);
    if (!quarantinedMarker
      || !sameReclaimOwner(quarantinedMarker, marker)
      || (expectedOwner !== null && (!quarantinedOwner || !sameOwner(quarantinedOwner, expectedOwner)))) {
      if (!existsSync(leasePath) && existsSync(stalePath)) renameSync(stalePath, leasePath);
      return false;
    }
    rmSync(stalePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  } finally {
    const currentMarker = readReclaimOwner(leasePath);
    if (currentMarker && sameReclaimOwner(currentMarker, marker)) {
      rmSync(markerPath, { recursive: true, force: true });
    }
  }
}

function acquireLease(identity: BackgroundWorkerIdentity): BackgroundWorkerLease | null {
  mkdirSync(identity.canonicalIndexPath, { recursive: true, mode: 0o700 });
  const canonicalIndexPath = realpathSync.native(identity.canonicalIndexPath);
  const leasePath = path.join(canonicalIndexPath, leaseDirectoryName({ ...identity, canonicalIndexPath }));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const timestamp = new Date().toISOString();
    const owner: BackgroundWorkerLeaseOwner = {
      version: 1,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: timestamp,
      heartbeatAt: timestamp,
      projectRoot: identity.canonicalProjectRoot,
      indexPath: canonicalIndexPath,
      token: randomUUID(),
    };
    if (publishLease(leasePath, owner)) {
      return { leasePath, owner };
    }

    const existingOwner = readOwner(leasePath);
    if (existingOwner) {
      if (canReclaimLease(leasePath, existingOwner) && reclaimLease(leasePath, existingOwner)) continue;
      return null;
    }

    return null;
  }

  return null;
}

function releaseLease(lease: BackgroundWorkerLease): boolean {
  const currentOwner = readOwner(lease.leasePath);
  if (!currentOwner || !sameOwner(currentOwner, lease.owner)) return false;
  const releasePath = `${lease.leasePath}.release.${lease.owner.pid}.${lease.owner.token}`;
  try {
    renameSync(lease.leasePath, releasePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  const claimedOwner = readOwner(releasePath);
  if (!claimedOwner || !sameOwner(claimedOwner, lease.owner)) {
    if (!existsSync(lease.leasePath) && existsSync(releasePath)) {
      renameSync(releasePath, lease.leasePath);
    }
    return false;
  }

  rmSync(releasePath, { recursive: true, force: true });
  return true;
}

class BackgroundWorkerController {
  private config: ParsedCodebaseIndexConfig;
  private hooks: BackgroundWorkerHooks;
  private readonly identity: BackgroundWorkerIdentity;
  private lease: BackgroundWorkerLease | null = null;
  private watcher: BackgroundWorkerWatcher | null = null;
  private leaderReady: Promise<void> = Promise.resolve();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private teardownRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private transition: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | null = null;
  private stopped = false;
  private stopping = false;
  private losingLeadership = false;
  private restartAfterStop = false;
  private leaderWorkStopped = false;
  private startingLeaderWork = false;
  private stopAutoIndexOnTeardown = true;
  private autoIndexStarted = false;
  private reportedError: string | null = null;

  constructor(
    readonly projectRoot: string,
    readonly host: HostMode,
    config: ParsedCodebaseIndexConfig,
    hooks: BackgroundWorkerHooks,
    identity: BackgroundWorkerIdentity,
  ) {
    this.config = config;
    this.hooks = hooks;
    this.identity = identity;
  }

  update(
    config: ParsedCodebaseIndexConfig,
    hooks: BackgroundWorkerHooks,
    options: BackgroundWorkerConfigureOptions,
  ): void {
    const autoIndexWasEnabled = this.config.indexing.autoIndex;
    const shouldReplaceWatcher = this.watcher !== null && hooks.watcherFactory !== undefined && (
      hooks.watcherFactory === null || hooks.replaceWatcher === true
    );
    this.config = config;
    this.hooks = {
      ...this.hooks,
      ...hooks,
      watcherFactory: hooks.watcherFactory === undefined
        ? this.hooks.watcherFactory
        : hooks.watcherFactory,
      watcherFactoryForConfig: hooks.watcherFactoryForConfig === undefined
        ? this.hooks.watcherFactoryForConfig
        : hooks.watcherFactoryForConfig,
    };
    if ((autoIndexWasEnabled && !config.indexing.autoIndex)
      || (options.restartAutoIndex === true && config.indexing.autoIndex && !this.startingLeaderWork)) {
      this.autoIndexStarted = false;
    }
    if (!this.canRun()) {
      void this.stop().catch((error: unknown) => {
        console.error("[codebase-index] Failed to stop background worker after disabling automatic work:", error);
      });
      return;
    }
    if (shouldReplaceWatcher) {
      void this.enqueue(async () => {
        const watcher = this.watcher;
        if (watcher) {
          await watcher.stop();
          if (this.watcher === watcher) this.watcher = null;
        }
        if (this.lease && !this.stopped) this.startLeaderWork();
      }).catch((error: unknown) => {
        console.error("[codebase-index] Failed to replace background file watcher:", error);
      });
    }
    this.start();
  }

  startAfter(activation: Promise<void>): void {
    this.transition = activation.catch(() => undefined);
    this.start();
  }

  start(): void {
    if (!this.canRun() || this.losingLeadership) return;
    if (this.stopping) {
      this.restartAfterStop = true;
      return;
    }
    this.stopped = false;
    void this.enqueue(async () => {
      if (this.stopped || this.stopping || this.losingLeadership || !this.canRun()) return;
      if (!this.lease) {
        try {
          this.lease = acquireLease(this.identity);
          this.reportedError = null;
        } catch (error) {
          this.reportAcquireError(error);
          this.scheduleRetry();
          return;
        }
      }
      if (!this.lease) {
        this.scheduleRetry();
        return;
      }
      this.startHeartbeat();
      this.startLeaderWork();
    });
  }

  waitForStart(): Promise<void> {
    return this.transition.catch(() => undefined).then(() => this.leaderReady);
  }

  requestRefresh(allowDisabledAutoIndex = false): void {
    this.start();
    if (!this.isLeader()) {
      requestRefreshFromLeader(leasePathFor(this.identity), allowDisabledAutoIndex);
      return;
    }
    void this.enqueue(async () => {
      if (this.stopped || !this.lease) return;
      this.hooks.startAutoIndex("retrieval", allowDisabledAutoIndex);
    });
  }

  isLeader(): boolean {
    return this.lease !== null && !this.stopping && !this.losingLeadership;
  }

  isStopping(): boolean {
    return this.stopping;
  }

  getHooksForConfig(config: ParsedCodebaseIndexConfig): BackgroundWorkerHooks {
    const watcherFactoryForConfig = this.hooks.watcherFactoryForConfig;
    if (!watcherFactoryForConfig) return this.hooks;
    return {
      ...this.hooks,
      watcherFactory: watcherFactoryForConfig(config),
      replaceWatcher: true,
    };
  }

  attachWatcher(
    watcherFactory: (() => BackgroundWorkerWatcher) | null,
    watcherFactoryForConfig?: (
      config: ParsedCodebaseIndexConfig,
    ) => (() => BackgroundWorkerWatcher) | null,
  ): void {
    if (this.hooks.watcherFactory !== undefined) return;
    this.hooks = {
      ...this.hooks,
      watcherFactory,
      watcherFactoryForConfig: watcherFactoryForConfig ?? this.hooks.watcherFactoryForConfig,
    };
    this.start();
  }

  async stop(stopAutoIndex = true): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopping = true;
    this.stopAutoIndexOnTeardown &&= stopAutoIndex;
    this.clearRetryTimer();
    const attempt = this.enqueue(async () => {
      try {
        const lease = this.lease;
        if (this.leaderWorkStopped) {
          if (lease) {
            this.releaseStoppedLease(lease);
          } else {
            this.finishStoppedLease();
          }
          return;
        }

        const hadLeaderWork = lease !== null || this.watcher !== null || this.autoIndexStarted;
        const stopped = await this.stopLeaderWork(hadLeaderWork && this.stopAutoIndexOnTeardown);
        if (!lease) {
          this.finishStoppedLease();
          return;
        }
        if (!stopped.completed) {
          this.releaseLeaseWhenAutoIndexStops(lease, stopped.completion);
          return;
        }
        this.leaderWorkStopped = true;
        this.releaseStoppedLease(lease);
      } catch (error) {
        this.scheduleTeardownRetry();
        throw error;
      }
    });
    const completion = attempt.finally(() => {
      if (this.stopPromise === completion) this.stopPromise = null;
    });
    this.stopPromise = completion;
    return completion;
  }

  private canRun(): boolean {
    return this.config.indexing.autoIndex || this.hooks.watcherFactory != null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transition.catch(() => undefined).then(operation);
    this.transition = next;
    return next;
  }

  private startLeaderWork(): void {
    if (this.stopped || this.stopping || this.losingLeadership) return;
    this.startingLeaderWork = true;
    try {
      if (this.config.indexing.autoIndex && !this.autoIndexStarted) {
        this.autoIndexStarted = true;
        this.hooks.startAutoIndex("startup");
      }
      if (!this.watcher && this.hooks.watcherFactory) {
        try {
          const watcher = this.hooks.watcherFactory();
          this.watcher = watcher;
          this.leaderReady = watcher.whenReady?.().catch((error: unknown) => {
            console.error("[codebase-index] Failed while waiting for background file watcher startup:", error);
          }) ?? Promise.resolve();
        } catch (error) {
          console.error("[codebase-index] Failed to start background file watcher:", error);
          this.leaderReady = Promise.resolve();
        }
      }
    } finally {
      this.startingLeaderWork = false;
    }
  }

  private async stopLeaderWork(stopAutoIndex: boolean): Promise<AutoIndexStopResult> {
    const watcher = this.watcher;
    let watcherError: unknown;
    if (watcher) {
      try {
        await watcher.stop();
        if (this.watcher === watcher) this.watcher = null;
      } catch (error) {
        watcherError = error;
      }
    }
    let autoIndexError: unknown;
    let autoIndexStop: AutoIndexStopResult = {
      completed: true,
      completion: Promise.resolve(),
    };
    if (stopAutoIndex) {
      try {
        autoIndexStop = await this.hooks.stopAutoIndex();
        this.autoIndexStarted = false;
      } catch (error) {
        autoIndexError = error;
      }
    }
    if (watcherError !== undefined || autoIndexError !== undefined) {
      throw new BackgroundWorkerStopError(watcherError, autoIndexError);
    }
    return autoIndexStop;
  }

  private releaseLeaseWhenAutoIndexStops(
    lease: BackgroundWorkerLease,
    completion: Promise<void>,
  ): void {
    void completion.then(
      () => {
        void this.enqueue(async () => {
          if (this.lease !== lease || !this.stopping) return;
          this.leaderWorkStopped = true;
          this.releaseStoppedLease(lease);
        }).catch((error: unknown) => {
          console.error("[codebase-index] Failed to release background worker lease after automatic indexing stopped:", error);
          this.scheduleTeardownRetry();
        });
      },
      (error: unknown) => {
        console.error("[codebase-index] Failed while waiting for automatic indexing to stop:", error);
        this.scheduleTeardownRetry();
      },
    );
  }

  private releaseStoppedLease(lease: BackgroundWorkerLease): void {
    if (this.lease !== lease) {
      this.finishStoppedLease();
      return;
    }
    releaseLease(lease);
    this.lease = null;
    this.finishStoppedLease();
  }

  private finishStoppedLease(): void {
    this.leaderWorkStopped = false;
    this.stopAutoIndexOnTeardown = true;
    this.stopping = false;
    this.clearTimers();
    this.restartAfterTeardown();
    if (!this.stopped || this.stopping) return;

    const projectKey = projectLookupKey(this.projectRoot, this.host);
    const key = controllerKey(this.identity, this.host);
    if (workers.get(key) === this) workers.delete(key);
    if (workerKeysByProject.get(projectKey) === key) workerKeysByProject.delete(projectKey);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const heartbeat = (): void => {
      void this.heartbeat();
    };
    this.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeat(): Promise<void> {
    const lease = this.lease;
    if (!lease || this.losingLeadership || (this.stopped && !this.stopping)) return;
    if (hasActiveReclaimMarker(lease.leasePath, lease.owner)) {
      await this.loseLeadership();
      return;
    }
    const currentOwner = readOwner(lease.leasePath);
    if (!currentOwner || !sameOwner(currentOwner, lease.owner)) {
      await this.loseLeadership();
      return;
    }
    try {
      const nextOwner = { ...lease.owner, heartbeatAt: new Date().toISOString() };
      if (!writeHeartbeat(lease.leasePath, nextOwner)) {
        await this.loseLeadership();
        return;
      }
      lease.owner = nextOwner;
      const refreshRequest = !this.stopping ? consumeRefreshRequest(lease.leasePath) : null;
      if (refreshRequest) {
        this.hooks.startAutoIndex("retrieval", refreshRequest.allowDisabledAutoIndex);
      }
    } catch (error) {
      const ownerAfterError = readOwner(lease.leasePath);
      if (hasActiveReclaimMarker(lease.leasePath, lease.owner)
        || !ownerAfterError
        || !sameOwner(ownerAfterError, lease.owner)) {
        await this.loseLeadership();
        return;
      }
      console.error("[codebase-index] Failed to renew background worker lease:", error);
    }
  }

  private async loseLeadership(): Promise<void> {
    if (this.losingLeadership) return;
    this.losingLeadership = true;
    this.clearHeartbeat();
    await this.enqueue(async () => this.stopAfterLeadershipLoss());
  }

  private async stopAfterLeadershipLoss(): Promise<void> {
    const lease = this.lease;
    if (!lease) {
      this.losingLeadership = false;
      return;
    }
    try {
      const stopped = await this.stopLeaderWork(true);
      this.lease = null;
      this.losingLeadership = false;
      if (stopped.completed) {
        this.scheduleRetry();
      } else {
        void stopped.completion.then(() => this.scheduleRetry());
      }
    } catch (error) {
      console.error("[codebase-index] Failed to stop background work after losing its lease:", error);
      this.scheduleLostLeadershipTeardownRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || !this.canRun() || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  private scheduleTeardownRetry(): void {
    if (!this.stopping || this.teardownRetryTimer) return;
    this.teardownRetryTimer = setTimeout(() => {
      this.teardownRetryTimer = null;
      void this.stop(this.stopAutoIndexOnTeardown).catch((error: unknown) => {
        console.error("[codebase-index] Failed to retry background worker teardown:", error);
      });
    }, RETRY_DELAY_MS);
    this.teardownRetryTimer.unref?.();
  }

  private restartAfterTeardown(): void {
    if (!this.restartAfterStop || !this.canRun() || this.losingLeadership) return;
    this.restartAfterStop = false;
    this.stopped = false;
    this.start();
  }

  private scheduleLostLeadershipTeardownRetry(): void {
    if (this.stopped || !this.losingLeadership || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(async () => this.stopAfterLeadershipLoss());
    }, RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    this.clearRetryTimer();
    if (this.teardownRetryTimer) {
      clearTimeout(this.teardownRetryTimer);
      this.teardownRetryTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private reportAcquireError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.reportedError === message) return;
    this.reportedError = message;
    console.error("[codebase-index] Failed to acquire background worker lease:", error);
  }
}

export function configureBackgroundWorker(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig,
  hooks: BackgroundWorkerHooks,
  options: BackgroundWorkerConfigureOptions = {},
): void {
  const projectKey = projectLookupKey(projectRoot, host);
  const identity = resolveIdentity(projectRoot, config, host);
  const key = controllerKey(identity, host);
  const previousKey = workerKeysByProject.get(projectKey);
  if (previousKey && previousKey !== key) {
    const previous = workers.get(previousKey);
    const previousBarrier = workerReplacementBarriers.get(projectKey) ?? Promise.resolve();
    const stopPrevious = previous?.stop(options.stopPreviousAutoIndex ?? true) ?? Promise.resolve();
    const activation = Promise.all([previousBarrier, stopPrevious]).then(() => undefined);
    workerReplacementBarriers.set(projectKey, activation);
    workers.delete(previousKey);

    const worker = new BackgroundWorkerController(projectRoot, host, config, hooks, identity);
    worker.startAfter(activation);
    workers.set(key, worker);
    workerKeysByProject.set(projectKey, key);
    return;
  }

  let worker = workers.get(key);
  if (!worker) {
    worker = new BackgroundWorkerController(projectRoot, host, config, hooks, identity);
    workers.set(key, worker);
  } else {
    worker.update(config, hooks, options);
  }
  workerKeysByProject.set(projectKey, key);
  worker.start();
}

export function attachBackgroundWorkerWatcher(
  projectRoot: string,
  host: HostMode,
  watcherFactory: (() => BackgroundWorkerWatcher) | null,
  watcherFactoryForConfig?: (
    config: ParsedCodebaseIndexConfig,
  ) => (() => BackgroundWorkerWatcher) | null,
): void {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  workers.get(key ?? "")?.attachWatcher(watcherFactory, watcherFactoryForConfig);
}

export function updateBackgroundWorkerConfig(
  projectRoot: string,
  host: HostMode,
  config: ParsedCodebaseIndexConfig,
): void {
  const projectKey = projectLookupKey(projectRoot, host);
  const key = workerKeysByProject.get(projectKey);
  const worker = key ? workers.get(key) : undefined;
  if (!worker) return;
  configureBackgroundWorker(projectRoot, host, config, worker.getHooksForConfig(config), {
    stopPreviousAutoIndex: false,
    restartAutoIndex: true,
  });
}

export function requestBackgroundWorker(projectRoot: string, host: HostMode): void {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  workers.get(key ?? "")?.start();
}

export function waitForBackgroundWorkerStart(projectRoot: string, host: HostMode): Promise<void> {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  return workers.get(key ?? "")?.waitForStart() ?? Promise.resolve();
}

export function requestBackgroundWorkerRefresh(
  projectRoot: string,
  host: HostMode,
  allowDisabledAutoIndex = false,
): void {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  workers.get(key ?? "")?.requestRefresh(allowDisabledAutoIndex);
}

export function isBackgroundWorkerManaged(projectRoot: string, host: HostMode): boolean {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  return key !== undefined && workers.has(key);
}

export function isBackgroundWorkerLeader(projectRoot: string, host: HostMode): boolean {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  return key !== undefined && workers.get(key)?.isLeader() === true;
}

export function isBackgroundWorkerStopping(projectRoot: string, host: HostMode): boolean {
  const key = workerKeysByProject.get(projectLookupKey(projectRoot, host));
  return key !== undefined && workers.get(key)?.isStopping() === true;
}

export async function stopBackgroundWorker(projectRoot: string, host: HostMode): Promise<void> {
  const projectKey = projectLookupKey(projectRoot, host);
  const key = workerKeysByProject.get(projectKey);
  const worker = key ? workers.get(key) : undefined;
  if (!worker) return;
  await worker.stop();
}

export async function resetBackgroundWorkersForTests(): Promise<void> {
  await Promise.all(Array.from(workers.values(), (worker) => worker.stop()));
  await Promise.all(workerReplacementBarriers.values());
  workers.clear();
  workerKeysByProject.clear();
  workerReplacementBarriers.clear();
}

export function getBackgroundWorkerLeasePath(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): string {
  return leasePathFor(resolveIdentity(projectRoot, config, host));
}

export function tryAcquireBackgroundWorkerLease(
  projectRoot: string,
  config: ParsedCodebaseIndexConfig,
  host: HostMode,
): BackgroundWorkerLeaseHandle | null {
  const lease = acquireLease(resolveIdentity(projectRoot, config, host));
  if (!lease) return null;
  return {
    leasePath: lease.leasePath,
    owner: lease.owner,
    release: () => releaseLease(lease),
  };
}
