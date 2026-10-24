import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { HostMode } from "../config/host.js";
import { getHostProjectIndexRelativePath } from "../config/paths.js";
import { createLeaseTemporaryPath, isIndexLockContentionError, recoverLeaseArtifacts, removeLeaseTemporaryPath, withIndexLock } from "../indexer/index-lock.js";
import type { IndexLockLease } from "../indexer/index-lock.js";
import { HistoryError, canonicalRepository } from "./config.js";
import type { HistoryDocument, HistorySnapshot } from "./types.js";
import { assertHistoryProjectPath } from "./paths.js";
import type { OperationControl } from "../utils/operation-control.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { checkpointHistoryWork } from "./work.js";
import { historySnapshotSchema } from "./snapshot-schema.js";

export function historyDirectory(projectRoot: string, host: HostMode, repository: string): string {
  const directory = path.join(projectRoot, path.dirname(getHostProjectIndexRelativePath(host)), "history", createHash("sha256").update(canonicalRepository(repository)).digest("hex"));
  assertHistoryProjectPath(projectRoot, directory);
  return directory;
}

export function readSnapshot(directory: string, repository: string): HistorySnapshot | undefined {
  const target = path.join(directory, "snapshot.json");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), target);
  if (!existsSync(target)) return undefined;
  let parsed: ReturnType<typeof historySnapshotSchema.parse>;
  try { parsed = historySnapshotSchema.parse(JSON.parse(readFileSync(target, "utf8"))); }
  catch { throw new HistoryError("HISTORY_STORAGE", "invalid private history snapshot; refusing to serve it"); }
  if (parsed.repository !== canonicalRepository(repository)) throw new HistoryError("HISTORY_STORAGE", "history snapshot belongs to a different host or repository");
  if (parsed.version === 1) {
    return { ...parsed, version: 2, lexicalVersion: undefined, httpCache: undefined,
      entities: parsed.entities.map((entity) => ({ ...entity, documents: entity.documents.map((doc): HistoryDocument => ({
        ...doc, updatedAt: doc.documentKind === "review" ? null : doc.updatedAt,
        timestampProvenance: { createdAt: "legacy", updatedAt: doc.documentKind === "review" ? "unavailable" : "legacy" },
      })) })) };
  }
  // The version-2 refinement validates required document provenance before this narrowing.
  const snapshot = parsed as HistorySnapshot;
  return snapshot;
}

/** The exclusive lease excludes active writers; only reserved snapshot temporary names qualify. */
function removeOrphanPreparations(directory: string, lease: IndexLockLease): void {
  const projectRoot = path.dirname(path.dirname(path.dirname(directory)));
  for (const entry of readdirSync(directory)) {
    const owner = /^snapshot\.json\.tmp\.([1-9][0-9]*)\.([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.[1-9][0-9]*$/i.exec(entry);
    if (!owner || owner[2] === lease.owner.token) continue;
    const temporary = path.join(directory, entry);
    assertHistoryProjectPath(projectRoot, temporary);
    removeLeaseTemporaryPath(temporary);
  }
}

export async function withHistoryLock<T>(directory: string, operation: "index" | "clear", callback: (lease: IndexLockLease) => Promise<T>): Promise<T> {
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), directory);
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(directory), 0o700);
  const ignorePath = path.join(path.dirname(directory), ".gitignore");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), ignorePath);
  try { writeFileSync(ignorePath, "*\n", { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (readFileSync(ignorePath, "utf8").trim() !== "*") throw new HistoryError("HISTORY_STORAGE", "history root must ignore all cache content");
  chmodSync(ignorePath, 0o600);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  chmodSync(directory, 0o700);
  try {
    return await withIndexLock(directory, operation, async (lease) => {
      chmodSync(lease.lockPath, 0o700);
      chmodSync(path.join(lease.lockPath, "owner.json"), 0o600);
      // Only owners proven dead by the existing lease reclaimer are eligible.
      for (const recovery of lease.recoveries) recoverLeaseArtifacts(directory, recovery.owner, []);
      removeOrphanPreparations(directory, lease);
      return callback(lease);
    });
  } catch (error) {
    if (isIndexLockContentionError(error)) throw new HistoryError("HISTORY_BUSY", "another process holds the history mutation lease");
    throw error;
  }
}

/** Preparation yields for cancellation; only the final rename is the commit decision. */
export async function writeSnapshot(directory: string, snapshot: HistorySnapshot, lease: IndexLockLease, control?: OperationControl, beforeCommit?: () => Promise<void>): Promise<void> {
  const target = path.join(directory, "snapshot.json");
  const projectRoot = path.dirname(path.dirname(path.dirname(directory)));
  assertHistoryProjectPath(projectRoot, target);
  await checkpointHistoryWork(control);
  const serialized = JSON.stringify(snapshot);
  await checkpointHistoryWork(control);
  const temporary = createLeaseTemporaryPath(target, lease.owner);
  let committed = false;
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
    await checkpointHistoryWork(control);
    await beforeCommit?.();
    await checkpointHistoryWork(control);
    assertHistoryProjectPath(projectRoot, target);
    const owner = JSON.parse(readFileSync(path.join(lease.lockPath, "owner.json"), "utf8")) as { token?: string };
    if (owner.token !== lease.owner.token) throw new HistoryError("HISTORY_BUSY", "history mutation lease changed before publication");
    throwIfOperationAborted(control?.signal);
    renameSync(temporary, target);
    committed = true;
  } finally {
    if (!committed) rmSync(temporary, { force: true });
  }
}
