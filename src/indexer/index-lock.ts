import { randomUUID } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import * as os from "os";
import * as path from "path";

export type IndexMutationOperation =
  | "initialize"
  | "index"
  | "force-index"
  | "clear"
  | "health-check"
  | "retry-failed-batches"
  | "recovery";

export interface IndexLockOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  operation: IndexMutationOperation;
  token: string;
}

export interface IndexLockRecovery {
  owner: IndexLockOwner;
  markerPath: string;
}

export interface IndexLockLease {
  canonicalIndexPath: string;
  lockPath: string;
  owner: IndexLockOwner;
  recoveries: IndexLockRecovery[];
}

type OwnerLiveness = "alive" | "dead" | "unknown";

interface ReclaimOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  token: string;
  expectedOwnerToken: string;
}

const OWNER_FILE_NAME = "owner.json";
const RECLAIM_DIRECTORY_NAME = "reclaiming";
const RECOVERY_MARKER_PREFIX = "indexing.lock.recovery.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_OPERATIONS = new Set<IndexMutationOperation>([
  "initialize",
  "index",
  "force-index",
  "clear",
  "health-check",
  "retry-failed-batches",
  "recovery",
]);

let temporaryCounter = 0;

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function retryTransientFilesystemOperation(operation: () => void): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      operation();
      return;
    } catch (error) {
      lastError = error;
      const code = getErrorCode(error);
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      if (attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, (attempt + 1) * 10);
      }
    }
  }
  throw lastError;
}

function parseOwner(value: unknown): IndexLockOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<IndexLockOwner>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (typeof candidate.hostname !== "string" || candidate.hostname.length === 0) return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt))) return null;
  if (typeof candidate.operation !== "string" || !VALID_OPERATIONS.has(candidate.operation as IndexMutationOperation)) return null;
  if (typeof candidate.token !== "string" || !UUID_PATTERN.test(candidate.token)) return null;
  return candidate as IndexLockOwner;
}

function parseReclaimOwner(value: unknown): ReclaimOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ReclaimOwner>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (typeof candidate.hostname !== "string" || candidate.hostname.length === 0) return null;
  if (typeof candidate.startedAt !== "string" || Number.isNaN(Date.parse(candidate.startedAt))) return null;
  if (typeof candidate.token !== "string" || !UUID_PATTERN.test(candidate.token)) return null;
  if (typeof candidate.expectedOwnerToken !== "string" || !UUID_PATTERN.test(candidate.expectedOwnerToken)) return null;
  return candidate as ReclaimOwner;
}

function readJsonDirectory<T>(directoryPath: string, parser: (value: unknown) => T | null): T | null {
  try {
    return parser(JSON.parse(readFileSync(path.join(directoryPath, OWNER_FILE_NAME), "utf-8")));
  } catch {
    return null;
  }
}

function readDirectoryOwner(lockPath: string): IndexLockOwner | null {
  return readJsonDirectory(lockPath, parseOwner);
}

function readReclaimOwner(markerPath: string): ReclaimOwner | null {
  return readJsonDirectory(markerPath, parseReclaimOwner);
}

function readRecoveryOwner(markerPath: string): IndexLockOwner | null {
  return readDirectoryOwner(markerPath);
}

function readLegacyOwner(lockPath: string): IndexLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      pid?: unknown;
      startedAt?: unknown;
      hostname?: unknown;
      operation?: unknown;
      token?: unknown;
    };
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return null;
    if (typeof parsed.startedAt !== "string" || Number.isNaN(Date.parse(parsed.startedAt))) return null;
    return {
      pid: Number(parsed.pid),
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : os.hostname(),
      startedAt: parsed.startedAt,
      operation: typeof parsed.operation === "string" && VALID_OPERATIONS.has(parsed.operation as IndexMutationOperation)
        ? parsed.operation as IndexMutationOperation
        : "index",
      token: typeof parsed.token === "string" ? parsed.token : "legacy-v0.14.0",
    };
  } catch {
    return null;
  }
}

function getOwnerLiveness(owner: Pick<IndexLockOwner, "pid" | "hostname">): OwnerLiveness {
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

function sameOwner(left: IndexLockOwner, right: IndexLockOwner): boolean {
  return left.pid === right.pid && left.hostname === right.hostname && left.token === right.token;
}

function sameReclaimOwner(left: ReclaimOwner, right: ReclaimOwner): boolean {
  return left.pid === right.pid
    && left.hostname === right.hostname
    && left.token === right.token
    && left.expectedOwnerToken === right.expectedOwnerToken;
}

function publishJsonDirectory(finalPath: string, value: IndexLockOwner | ReclaimOwner): boolean {
  const candidatePath = `${finalPath}.candidate.${process.pid}.${randomUUID()}`;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    writeFileSync(path.join(candidatePath, OWNER_FILE_NAME), JSON.stringify(value), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    if (existsSync(finalPath)) return false;
    try {
      renameSync(candidatePath, finalPath);
      return true;
    } catch (error) {
      if (existsSync(finalPath)) return false;
      if (getErrorCode(error) === "ENOENT") return false;
      throw error;
    }
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  } finally {
    if (existsSync(candidatePath)) rmSync(candidatePath, { recursive: true, force: true });
  }
}

function createOwner(operation: IndexMutationOperation): IndexLockOwner {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    operation,
    token: randomUUID(),
  };
}

function recoveryMarkerPath(indexPath: string, owner: IndexLockOwner): string {
  return path.join(indexPath, `${RECOVERY_MARKER_PREFIX}${owner.token}`);
}

function publishRecoveryMarker(indexPath: string, owner: IndexLockOwner): string {
  const markerPath = recoveryMarkerPath(indexPath, owner);
  if (!publishJsonDirectory(markerPath, owner)) {
    const markerOwner = readRecoveryOwner(markerPath);
    if (!markerOwner || !sameOwner(markerOwner, owner)) {
      throw new IndexLockContentionError(markerPath, markerOwner, "unknown-owner");
    }
  }
  return markerPath;
}

function getPendingRecoveries(indexPath: string): IndexLockRecovery[] {
  const recoveries: IndexLockRecovery[] = [];
  const markerNames = readdirSync(indexPath).filter((name) => {
    if (!name.startsWith(RECOVERY_MARKER_PREFIX)) return false;
    return UUID_PATTERN.test(name.slice(RECOVERY_MARKER_PREFIX.length));
  }).sort();
  for (const markerName of markerNames) {
    const markerPath = path.join(indexPath, markerName);
    const markerToken = markerName.slice(RECOVERY_MARKER_PREFIX.length);
    let markerStats;
    try {
      markerStats = lstatSync(markerPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!markerStats.isDirectory()) {
      throw new IndexLockContentionError(markerPath, null, "unknown-owner");
    }
    const owner = readRecoveryOwner(markerPath);
    if (!owner || owner.token !== markerToken || getOwnerLiveness(owner) !== "dead") {
      throw new IndexLockContentionError(markerPath, owner, "unknown-owner");
    }
    recoveries.push({ owner, markerPath });
  }
  recoveries.sort((left, right) => {
    const byTimestamp = left.owner.startedAt.localeCompare(right.owner.startedAt);
    return byTimestamp !== 0 ? byTimestamp : left.markerPath.localeCompare(right.markerPath);
  });
  return recoveries;
}

function cleanupDeadPublicationCandidates(indexPath: string): void {
  const candidatePattern = /^indexing\.lock(?:\.recovery\.[0-9a-f-]{36})?\.candidate\.(\d+)\.[0-9a-f-]{36}$/i;
  for (const entry of readdirSync(indexPath)) {
    const match = candidatePattern.exec(entry);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (getOwnerLiveness({ pid, hostname: os.hostname() }) !== "dead") continue;
    rmSync(path.join(indexPath, entry), { recursive: true, force: true });
  }
}

function removeDeadReclaimMarker(lockPath: string, expectedOwner: IndexLockOwner): boolean {
  const markerPath = path.join(lockPath, RECLAIM_DIRECTORY_NAME);
  const marker = readReclaimOwner(markerPath);
  if (!marker || marker.expectedOwnerToken !== expectedOwner.token || getOwnerLiveness(marker) !== "dead") {
    return false;
  }

  const currentOwner = readDirectoryOwner(lockPath);
  if (!currentOwner || !sameOwner(currentOwner, expectedOwner) || getOwnerLiveness(currentOwner) !== "dead") {
    return false;
  }

  const claimedMarkerPath = `${markerPath}.stale.${marker.pid}.${marker.token}.${randomUUID()}`;
  try {
    renameSync(markerPath, claimedMarkerPath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  const claimedMarker = readReclaimOwner(claimedMarkerPath);
  const ownerAfterClaim = readDirectoryOwner(lockPath);
  if (!claimedMarker
    || !sameReclaimOwner(claimedMarker, marker)
    || !ownerAfterClaim
    || !sameOwner(ownerAfterClaim, expectedOwner)
    || getOwnerLiveness(ownerAfterClaim) !== "dead") {
    if (!existsSync(markerPath) && existsSync(claimedMarkerPath)) {
      renameSync(claimedMarkerPath, markerPath);
    }
    return false;
  }

  rmSync(claimedMarkerPath, { recursive: true, force: true });
  return true;
}

function reclaimDeadOwner(indexPath: string, lockPath: string, expectedOwner: IndexLockOwner): boolean {
  const reclaimPath = path.join(lockPath, RECLAIM_DIRECTORY_NAME);
  const reclaimOwner: ReclaimOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    token: randomUUID(),
    expectedOwnerToken: expectedOwner.token,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (publishJsonDirectory(reclaimPath, reclaimOwner)) break;
    if (attempt === 0 && removeDeadReclaimMarker(lockPath, expectedOwner)) continue;
    return false;
  }

  try {
    const currentReclaimer = readReclaimOwner(reclaimPath);
    const currentOwner = readDirectoryOwner(lockPath);
    if (!currentReclaimer
      || !sameReclaimOwner(currentReclaimer, reclaimOwner)
      || !currentOwner
      || !sameOwner(currentOwner, expectedOwner)
      || getOwnerLiveness(currentOwner) !== "dead") {
      return false;
    }

    publishRecoveryMarker(indexPath, expectedOwner);

    const ownerBeforeQuarantine = readDirectoryOwner(lockPath);
    const reclaimerBeforeQuarantine = readReclaimOwner(reclaimPath);
    if (!ownerBeforeQuarantine
      || !sameOwner(ownerBeforeQuarantine, expectedOwner)
      || getOwnerLiveness(ownerBeforeQuarantine) !== "dead"
      || !reclaimerBeforeQuarantine
      || !sameReclaimOwner(reclaimerBeforeQuarantine, reclaimOwner)) {
      return false;
    }

    const quarantinePath = `${lockPath}.stale.${expectedOwner.token}.${reclaimOwner.token}`;
    renameSync(lockPath, quarantinePath);
    rmSync(quarantinePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export class IndexLockContentionError extends Error {
  readonly code = "INDEX_BUSY";

  constructor(
    readonly lockPath: string,
    readonly owner: IndexLockOwner | null,
    readonly reason: "active" | "unknown-owner" | "legacy-lock" | "reclaiming",
  ) {
    const ownerDescription = owner
      ? `PID ${owner.pid} on ${owner.hostname}, operation ${owner.operation}, since ${owner.startedAt}`
      : "an unreadable owner";
    super(`Index mutation already in progress: ${ownerDescription}`);
    this.name = "IndexLockContentionError";
  }
}

export function isIndexLockContentionError(error: unknown): error is IndexLockContentionError {
  return error instanceof IndexLockContentionError
    || (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "INDEX_BUSY");
}

export function isTransientIndexLockContention(error: unknown): boolean {
  if (!isIndexLockContentionError(error) || !("reason" in error)) return false;
  return error.reason === "active" || error.reason === "reclaiming";
}

export function acquireIndexLock(indexPath: string, operation: IndexMutationOperation): IndexLockLease {
  mkdirSync(indexPath, { recursive: true });
  const canonicalIndexPath = realpathSync.native(indexPath);
  const lockPath = path.join(canonicalIndexPath, "indexing.lock");
  cleanupDeadPublicationCandidates(canonicalIndexPath);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const owner = createOwner(operation);
    if (publishJsonDirectory(lockPath, owner)) {
      const lease: IndexLockLease = {
        canonicalIndexPath,
        lockPath,
        owner,
        recoveries: [],
      };
      try {
        lease.recoveries = getPendingRecoveries(canonicalIndexPath);
        return lease;
      } catch (error) {
        releaseIndexLock(lease);
        throw error;
      }
    }

    let stats;
    try {
      stats = lstatSync(lockPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") continue;
      throw error;
    }

    if (!stats.isDirectory()) {
      const legacyOwner = readLegacyOwner(lockPath);
      throw new IndexLockContentionError(lockPath, legacyOwner, "legacy-lock");
    }

    const existingOwner = readDirectoryOwner(lockPath);
    if (!existingOwner) {
      throw new IndexLockContentionError(lockPath, null, "unknown-owner");
    }

    const liveness = getOwnerLiveness(existingOwner);
    if (liveness !== "dead") {
      throw new IndexLockContentionError(lockPath, existingOwner, liveness === "alive" ? "active" : "unknown-owner");
    }

    if (!reclaimDeadOwner(canonicalIndexPath, lockPath, existingOwner)) {
      throw new IndexLockContentionError(lockPath, existingOwner, "reclaiming");
    }
  }

  throw new IndexLockContentionError(lockPath, null, "reclaiming");
}

export function releaseIndexLock(lease: IndexLockLease): boolean {
  const currentOwner = readDirectoryOwner(lease.lockPath);
  if (!currentOwner || !sameOwner(currentOwner, lease.owner)) return false;

  const releasePath = `${lease.lockPath}.release.${lease.owner.pid}.${lease.owner.token}`;
  try {
    retryTransientFilesystemOperation(() => renameSync(lease.lockPath, releasePath));
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }

  const claimedOwner = readDirectoryOwner(releasePath);
  if (!claimedOwner || !sameOwner(claimedOwner, lease.owner)) {
    if (!existsSync(lease.lockPath) && existsSync(releasePath)) {
      renameSync(releasePath, lease.lockPath);
    }
    return false;
  }

  try {
    retryTransientFilesystemOperation(() => rmSync(releasePath, { recursive: true, force: true }));
  } catch (error) {
    console.error(`[codebase-index] Lease released but tombstone cleanup failed: ${releasePath}`, error);
  }
  return true;
}

export async function withIndexLock<T>(
  indexPath: string,
  operation: IndexMutationOperation,
  callback: (lease: IndexLockLease) => Promise<T> | T,
  options: { completeRecoveries?: boolean } = {},
): Promise<T> {
  const lease = acquireIndexLock(indexPath, operation);
  let result: T | undefined;
  let callbackError: unknown;
  let callbackFailed = false;
  try {
    result = await callback(lease);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  if (!callbackFailed && options.completeRecoveries !== false) {
    try {
      completeLeaseRecovery(lease);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
  }

  let releaseError: unknown;
  try {
    if (!releaseIndexLock(lease)) {
      releaseError = new Error(`Lost ownership of index mutation lease ${lease.owner.token}`);
    }
  } catch (error) {
    releaseError = error;
  }
  if (releaseError !== undefined) {
    if (callbackFailed) throw new AggregateError([callbackError, releaseError], "Index mutation and lease release both failed");
    throw releaseError;
  }
  if (callbackFailed) throw callbackError;
  return result as T;
}

export function createLeaseTemporaryPath(
  targetPath: string,
  owner: IndexLockOwner,
  kind: "tmp" | "bak" = "tmp",
): string {
  if (kind === "bak") return `${targetPath}.bak.${owner.pid}.${owner.token}`;
  temporaryCounter += 1;
  return `${targetPath}.tmp.${owner.pid}.${owner.token}.${temporaryCounter}`;
}

export function removeLeaseTemporaryPath(temporaryPath: string): void {
  if (existsSync(temporaryPath)) rmSync(temporaryPath, { recursive: true, force: true });
}

export function recoverLeaseArtifacts(
  indexPath: string,
  owner: IndexLockOwner,
  backupTargets: string[],
): void {
  for (const targetPath of backupTargets) {
    const backupPath = createLeaseTemporaryPath(targetPath, owner, "bak");
    if (!existsSync(backupPath)) continue;
    if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
    renameSync(backupPath, targetPath);
  }

  const temporaryOwnerMarker = `.tmp.${owner.pid}.${owner.token}.`;
  for (const entry of readdirSync(indexPath)) {
    if (!entry.includes(temporaryOwnerMarker)) continue;
    rmSync(path.join(indexPath, entry), { recursive: true, force: true });
  }
}

export function completeLeaseRecovery(lease: IndexLockLease): void {
  for (const recovery of lease.recoveries) {
    const markerOwner = readRecoveryOwner(recovery.markerPath);
    if (!markerOwner || !sameOwner(markerOwner, recovery.owner)) {
      throw new Error(`Recovery marker ownership changed: ${recovery.markerPath}`);
    }
  }
  for (const recovery of lease.recoveries) {
    rmSync(recovery.markerPath, { recursive: true, force: true });
  }
}
