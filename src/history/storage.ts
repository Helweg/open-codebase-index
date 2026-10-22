import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { HostMode } from "../config/host.js";
import { getHostProjectIndexRelativePath } from "../config/paths.js";
import { createLeaseTemporaryPath, withIndexLock, type IndexLockLease } from "../indexer/index-lock.js";
import { HistoryError } from "./config.js";
import type { HistorySnapshot } from "./types.js";
import { assertHistoryProjectPath } from "./paths.js";

export function historyDirectory(projectRoot: string, host: HostMode, repository: string): string {
  const directory = path.join(projectRoot, path.dirname(getHostProjectIndexRelativePath(host)), "history", createHash("sha256").update(repository).digest("hex"));
  assertHistoryProjectPath(projectRoot, directory);
  return directory;
}


export function readSnapshot(directory: string, repository: string): HistorySnapshot | undefined {
  const target = path.join(directory, "snapshot.json");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), target);
  if (!existsSync(target)) return undefined;
  let snapshot: HistorySnapshot;
  try { snapshot = JSON.parse(readFileSync(target, "utf8")) as HistorySnapshot; }
  catch { throw new HistoryError("HISTORY_STORAGE", "cannot read private history snapshot"); }
  if (snapshot.version !== 1 || snapshot.repository !== repository || !Array.isArray(snapshot.entities) || typeof snapshot.lexical !== "string") {
    throw new HistoryError("HISTORY_STORAGE", "invalid history snapshot; refusing to serve it");
  }
  return snapshot;
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
  return withIndexLock(directory, operation, async (lease) => {
    chmodSync(lease.lockPath, 0o700);
    chmodSync(path.join(lease.lockPath, "owner.json"), 0o600);
    return callback(lease);
  });
}

export function writeSnapshot(directory: string, snapshot: HistorySnapshot, lease: IndexLockLease): void {
  const target = path.join(directory, "snapshot.json");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), target);
  const temporary = createLeaseTemporaryPath(target, lease.owner);
  try {
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

