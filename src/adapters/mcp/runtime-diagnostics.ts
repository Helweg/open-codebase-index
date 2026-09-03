import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
const DISK_HEARTBEAT_INTERVAL_MS = 5_000;
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const STARTUP_TOKEN = randomUUID().replaceAll("-", "");
const HOSTNAME_HASH = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
const RECORD_FILE_PATTERN = /^([a-f0-9]{16})-(\d+)-([a-f0-9]{32})\.json$/;
const TEMPORARY_FILE_PATTERN = /^\.[a-f0-9]{16}-\d+-[a-f0-9]{32}\.json\.[a-f0-9-]+\.tmp$/;
const SAFE_DIAGNOSTIC_LABEL = /^[a-z0-9_:.]{1,64}$/;

type McpInterruptionCause = "ordered_shutdown" | "process_exit";

export type McpOperationStatus = "active" | "suspected_stall";

export interface McpActiveOperationDiagnostic {
  operation: string;
  phase: string;
  startedAt: string;
  lastActivityAt: string;
  status: McpOperationStatus;
}

export interface McpInterruptedOperationDiagnostic {
  operation: string;
  phase: string;
  startedAt: string;
  lastActivityAt: string;
  cause: McpInterruptionCause;
  nextAction: string;
}

export interface McpDiagnosticsSnapshot {
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  activeOperations: McpActiveOperationDiagnostic[];
  latestInterruptedOperation?: McpInterruptedOperationDiagnostic;
}

interface PersistedActiveOperation {
  id: string;
  sessionId: string;
  operation: string;
  phase: string;
  startedAt: string;
  lastActivityAt: string;
}

interface PersistedRuntimeState {
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  hostnameHash: string;
  pid: number;
  startupToken: string;
  updatedAt: string;
  activeOperations: PersistedActiveOperation[];
  latestInterruptedOperation?: McpInterruptedOperationDiagnostic;
}

export interface McpTrackedOperation {
  id: string;
  setPhase: (phase: string) => Promise<void>;
  heartbeat: () => Promise<void>;
  complete: () => Promise<void>;
}

function createUntrackedOperation(): McpTrackedOperation {
  return {
    id: randomUUID(),
    setPhase: async () => undefined,
    heartbeat: async () => undefined,
    complete: async () => undefined,
  };
}

function bestEffortTrackedOperation(operation: McpTrackedOperation): McpTrackedOperation {
  const ignorePersistenceFailure = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch {
      // Persistent diagnostics are optional and must not alter MCP tool behavior.
      return;
    }
  };
  return {
    id: operation.id,
    setPhase: (phase) => ignorePersistenceFailure(() => operation.setPhase(phase)),
    heartbeat: () => ignorePersistenceFailure(() => operation.heartbeat()),
    complete: () => ignorePersistenceFailure(() => operation.complete()),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSafeDiagnosticLabel(value: unknown): value is string {
  return typeof value === "string" && SAFE_DIAGNOSTIC_LABEL.test(value);
}

function isPersistedActiveOperation(value: unknown): value is PersistedActiveOperation {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.sessionId === "string"
    && isSafeDiagnosticLabel(value.operation)
    && isSafeDiagnosticLabel(value.phase)
    && isValidTimestamp(value.startedAt)
    && isValidTimestamp(value.lastActivityAt);
}

function parseInterruptedOperation(value: unknown): McpInterruptedOperationDiagnostic | null {
  if (!isRecord(value)) return null;
  if (!isSafeDiagnosticLabel(value.operation)
    || !isSafeDiagnosticLabel(value.phase)
    || !isValidTimestamp(value.startedAt)
    || !isValidTimestamp(value.lastActivityAt)
    || (value.cause !== "ordered_shutdown" && value.cause !== "process_exit")) {
    return null;
  }
  return {
    operation: value.operation,
    phase: value.phase,
    startedAt: value.startedAt,
    lastActivityAt: value.lastActivityAt,
    cause: value.cause,
    nextAction: interruptionNextAction(value.cause),
  };
}

function parseRuntimeState(value: unknown): PersistedRuntimeState | null {
  if (!isRecord(value)
    || value.schemaVersion !== DIAGNOSTICS_SCHEMA_VERSION
    || typeof value.hostnameHash !== "string"
    || !/^[a-f0-9]{16}$/.test(value.hostnameHash)
    || typeof value.pid !== "number"
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.startupToken !== "string"
    || !/^[a-f0-9]{32}$/.test(value.startupToken)
    || !isValidTimestamp(value.updatedAt)
    || !Array.isArray(value.activeOperations)
    || !value.activeOperations.every(isPersistedActiveOperation)) {
    return null;
  }
  const latest = value.latestInterruptedOperation === undefined
    ? undefined
    : parseInterruptedOperation(value.latestInterruptedOperation);
  if (value.latestInterruptedOperation !== undefined && !latest) return null;
  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    hostnameHash: value.hostnameHash,
    pid: value.pid,
    startupToken: value.startupToken,
    updatedAt: value.updatedAt,
    activeOperations: value.activeOperations,
    ...(latest ? { latestInterruptedOperation: latest } : {}),
  };
}

function latestInterrupted(
  current: McpInterruptedOperationDiagnostic | undefined,
  candidate: McpInterruptedOperationDiagnostic | undefined,
): McpInterruptedOperationDiagnostic | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate.lastActivityAt) >= Date.parse(current.lastActivityAt) ? candidate : current;
}

function isProcessConfirmedAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return Boolean(isRecord(error) && error.code !== "ESRCH");
  }
}

function interruptedFromActive(
  operation: PersistedActiveOperation,
  cause: McpInterruptionCause,
): McpInterruptedOperationDiagnostic {
  return {
    operation: operation.operation,
    phase: operation.phase,
    startedAt: operation.startedAt,
    lastActivityAt: operation.lastActivityAt,
    cause,
    nextAction: interruptionNextAction(cause),
  };
}

function interruptionNextAction(cause: McpInterruptionCause): string {
  return cause === "ordered_shutdown"
    ? "Retry the operation from a connected MCP client."
    : "Start a new MCP client session, inspect index_status, and retry the operation if the index is available.";
}

class ProcessRuntimeStore {
  readonly runtimeDirectory: string;
  readonly filePath: string;
  private readonly state: PersistedRuntimeState;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastDiskHeartbeatAt = 0;
  private persistenceRevision = 0;
  private persistedRevision = 0;

  constructor(indexRoot: string) {
    this.runtimeDirectory = path.join(indexRoot, "mcp-runtime");
    this.filePath = path.join(
      this.runtimeDirectory,
      `${HOSTNAME_HASH}-${process.pid}-${STARTUP_TOKEN}.json`,
    );
    this.state = {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      hostnameHash: HOSTNAME_HASH,
      pid: process.pid,
      startupToken: STARTUP_TOKEN,
      updatedAt: new Date().toISOString(),
      activeOperations: [],
    };
  }

  async begin(sessionId: string, operation: string): Promise<McpTrackedOperation> {
    const now = new Date().toISOString();
    const tracked: PersistedActiveOperation = {
      id: randomUUID(),
      sessionId,
      operation,
      phase: "starting",
      startedAt: now,
      lastActivityAt: now,
    };
    this.state.activeOperations.push(tracked);
    try {
      await this.persist();
    } catch (error: unknown) {
      this.state.activeOperations = this.state.activeOperations.filter((entry) => entry.id !== tracked.id);
      throw error;
    }

    let completed = false;
    return {
      id: tracked.id,
      setPhase: async (phase: string): Promise<void> => {
        if (completed) return;
        const active = this.state.activeOperations.find((entry) => entry.id === tracked.id);
        if (!active) return;
        active.phase = phase;
        active.lastActivityAt = new Date().toISOString();
        await this.persist();
      },
      heartbeat: async (): Promise<void> => {
        if (completed) return;
        const active = this.state.activeOperations.find((entry) => entry.id === tracked.id);
        if (!active) return;
        active.lastActivityAt = new Date().toISOString();
        const nowMs = Date.now();
        if (nowMs - this.lastDiskHeartbeatAt >= DISK_HEARTBEAT_INTERVAL_MS) {
          this.lastDiskHeartbeatAt = nowMs;
          await this.persist();
        }
      },
      complete: async (): Promise<void> => {
        if (completed) return;
        completed = true;
        this.state.activeOperations = this.state.activeOperations.filter((entry) => entry.id !== tracked.id);
        await this.persist();
      },
    };
  }

  async markSessionInterrupted(sessionId: string): Promise<void> {
    const interrupted = this.state.activeOperations.filter((entry) => entry.sessionId === sessionId);
    const previousLatest = this.state.latestInterruptedOperation;
    for (const operation of interrupted) {
      this.state.latestInterruptedOperation = latestInterrupted(
        this.state.latestInterruptedOperation,
        interruptedFromActive(operation, "ordered_shutdown"),
      );
    }
    if (interrupted.length === 0) {
      if (this.hasPendingPersistence()) await this.persist();
      return;
    }
    this.state.activeOperations = this.state.activeOperations.filter((entry) => entry.sessionId !== sessionId);
    try {
      await this.persist();
    } catch (error: unknown) {
      this.state.activeOperations.push(...interrupted);
      this.state.latestInterruptedOperation = previousLatest;
      throw error;
    }
  }

  async snapshot(excludedOperationId: string | undefined, stallTimeoutMs: number): Promise<McpDiagnosticsSnapshot> {
    await this.writeQueue;
    if (this.hasPendingPersistence()) await this.persist();
    await this.ensureRuntimeDirectory();

    const activeOperations: McpActiveOperationDiagnostic[] = [];
    let interrupted = this.state.latestInterruptedOperation;
    const now = Date.now();
    const addActive = (operation: PersistedActiveOperation, persistedByOtherProcess = false): void => {
      if (operation.id === excludedOperationId) return;
      const lastActivity = Date.parse(operation.lastActivityAt);
      const inactivityThreshold = stallTimeoutMs + (persistedByOtherProcess ? DISK_HEARTBEAT_INTERVAL_MS : 0);
      activeOperations.push({
        operation: operation.operation,
        phase: operation.phase,
        startedAt: operation.startedAt,
        lastActivityAt: operation.lastActivityAt,
        status: stallTimeoutMs > 0 && Number.isFinite(lastActivity) && now - lastActivity >= inactivityThreshold
          ? "suspected_stall"
          : "active",
      });
    };

    for (const operation of this.state.activeOperations) addActive(operation);

    const entries = await fs.readdir(this.runtimeDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const recordPath = path.join(this.runtimeDirectory, entry.name);
      const recordMatch = RECORD_FILE_PATTERN.exec(entry.name);
      if (!recordMatch) {
        if (TEMPORARY_FILE_PATTERN.test(entry.name)) {
          try {
            const temporaryStat = await fs.stat(recordPath);
            if (now - temporaryStat.mtimeMs > RECORD_RETENTION_MS) {
              await fs.rm(recordPath, { force: true });
            }
          } catch {
            continue;
          }
        }
        continue;
      }
      if (recordPath === this.filePath) continue;

      try {
        const recordStat = await fs.stat(recordPath);
        if (now - recordStat.mtimeMs > RECORD_RETENTION_MS) {
          await fs.rm(recordPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      let state: PersistedRuntimeState | null = null;
      try {
        state = parseRuntimeState(JSON.parse(await fs.readFile(recordPath, "utf8")));
      } catch {
        continue;
      }
      if (!state) continue;
      if (state.hostnameHash !== recordMatch[1]
        || state.pid !== Number(recordMatch[2])
        || state.startupToken !== recordMatch[3]) {
        continue;
      }

      const updatedAt = Date.parse(state.updatedAt);
      if (Number.isFinite(updatedAt) && now - updatedAt > RECORD_RETENTION_MS) {
        await fs.rm(recordPath, { force: true });
        continue;
      }

      interrupted = latestInterrupted(interrupted, state.latestInterruptedOperation);
      const localProcess = state.hostnameHash === HOSTNAME_HASH;
      const confirmedDead = localProcess && !isProcessConfirmedAlive(state.pid);
      if (confirmedDead) {
        for (const operation of state.activeOperations) {
          interrupted = latestInterrupted(interrupted, interruptedFromActive(operation, "process_exit"));
        }
        continue;
      }
      for (const operation of state.activeOperations) addActive(operation, true);
    }

    activeOperations.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      activeOperations,
      ...(interrupted ? { latestInterruptedOperation: interrupted } : {}),
    };
  }

  private persist(): Promise<void> {
    const revision = ++this.persistenceRevision;
    const write = this.writeQueue.then(async () => {
      this.state.updatedAt = new Date().toISOString();
      await this.ensureRuntimeDirectory();
      if (this.state.activeOperations.length === 0 && !this.state.latestInterruptedOperation) {
        await fs.rm(this.filePath, { force: true });
        this.persistedRevision = revision;
        return;
      }

      const temporaryPath = path.join(
        this.runtimeDirectory,
        `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
      );
      try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(this.state)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
      this.persistedRevision = revision;
    });
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private hasPendingPersistence(): boolean {
    return this.persistedRevision < this.persistenceRevision;
  }

  private async ensureRuntimeDirectory(): Promise<void> {
    await fs.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.runtimeDirectory, 0o700);
  }
}

const processStores = new Map<string, ProcessRuntimeStore>();

function getProcessStore(indexRoot: string): ProcessRuntimeStore {
  const normalizedRoot = path.resolve(indexRoot);
  let store = processStores.get(normalizedRoot);
  if (!store) {
    store = new ProcessRuntimeStore(normalizedRoot);
    processStores.set(normalizedRoot, store);
  }
  return store;
}

export class McpRuntimeDiagnostics {
  private readonly sessionId = randomUUID();
  private readonly resolveIndexRoot: () => string;
  private readonly stores = new Set<ProcessRuntimeStore>();
  private orderedShutdownPromise: Promise<void> | null = null;

  constructor(indexRoot: string | (() => string)) {
    this.resolveIndexRoot = typeof indexRoot === "function"
      ? indexRoot
      : () => indexRoot;
  }

  async begin(operation: string): Promise<McpTrackedOperation> {
    try {
      const tracked = await this.getCurrentStore().begin(this.sessionId, operation);
      return bestEffortTrackedOperation(tracked);
    } catch {
      return createUntrackedOperation();
    }
  }

  async snapshot(excludedOperationId: string | undefined, stallTimeoutMs: number): Promise<McpDiagnosticsSnapshot> {
    try {
      return await this.getCurrentStore().snapshot(excludedOperationId, stallTimeoutMs);
    } catch {
      return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        activeOperations: [],
      };
    }
  }

  async markOrderedShutdown(): Promise<void> {
    if (this.orderedShutdownPromise) return this.orderedShutdownPromise;
    const attempt = Promise.allSettled(Array.from(
      this.stores,
      (store) => store.markSessionInterrupted(this.sessionId),
    )).then((results) => {
      if (results.some((result) => result.status === "rejected")
        && this.orderedShutdownPromise === attempt) {
        this.orderedShutdownPromise = null;
      }
    });
    this.orderedShutdownPromise = attempt;
    await attempt;
  }

  private getCurrentStore(): ProcessRuntimeStore {
    const store = getProcessStore(this.resolveIndexRoot());
    this.stores.add(store);
    return store;
  }
}
