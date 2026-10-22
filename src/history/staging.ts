import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { createLeaseTemporaryPath } from "../indexer/index-lock.js";
import type { IndexLockLease } from "../indexer/index-lock.js";
import { HistoryError } from "./config.js";
import type { HistoryApi, HistoryDiscoveryPage } from "./github.js";
import type { HistorySyncProgress } from "./types.js";
import { assertHistoryProjectPath } from "./paths.js";

export interface HistoryStage {
  api: HistoryApi;
  startedAt: string;
  clear(): void;
}

export function openHistoryStage(directory: string, api: HistoryApi, lease: IndexLockLease, repositoryId: string, principalId: string, initialSince?: string): HistoryStage {
  const staging = path.join(directory, "fetch-staging");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), staging);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o700);
  const metadata = path.join(staging, "metadata.json");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), metadata);
  const atomicWrite = (target: string, value: unknown) => {
    const temporary = createLeaseTemporaryPath(target, lease.owner);
    try {
      // Historical diffs are intentionally never cached, even in resumable fetch staging.
      writeFileSync(temporary, JSON.stringify(value, (key, item) => key === "patch" || key === "diff_hunk" ? undefined : item), { flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
    } finally { rmSync(temporary, { force: true }); }
  };
  const state = existsSync(metadata) ? JSON.parse(readFileSync(metadata, "utf8")) : { startedAt: new Date().toISOString(), repositoryId, principalId, initialSince };
  if (state.repositoryId !== repositoryId || state.principalId !== principalId) throw new HistoryError("HISTORY_INACCESSIBLE", "unfinished sync belongs to a different repository or public auth principal");
  if (state.initialSince !== initialSince) throw new HistoryError("HISTORY_CONFIG", "initial window differs from unfinished sync; clear history before changing it");
  if (!existsSync(metadata)) atomicWrite(metadata, state);
  const checkpoint = async <T>(key: string, fetch: () => Promise<T>): Promise<T> => {
    const target = path.join(staging, `${createHash("sha256").update(key).digest("hex")}.json`);
    assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), target);
    if (existsSync(target)) return JSON.parse(readFileSync(target, "utf8")).value as T;
    const value = await fetch();
    atomicWrite(target, { fetchedAt: new Date().toISOString(), value });
    return value;
  };
  return {
    startedAt: state.startedAt,
    api: {
      access: () => api.access(), // Capability proofs are always fresh, never checkpointed.
      get: (endpoint) => checkpoint(`GET ${endpoint}`, () => api.get(endpoint)),
      discover: (kind, after) => checkpoint<HistoryDiscoveryPage>(`QUERY ${kind} ${after ?? ""}`, () => api.discover(kind, after)),
    },
    clear: () => rmSync(staging, { recursive: true, force: true }),
  };
}

export function readHistorySyncProgress(directory: string): HistorySyncProgress | undefined {
  const staging = path.join(directory, "fetch-staging");
  const metadata = path.join(staging, "metadata.json");
  assertHistoryProjectPath(path.dirname(path.dirname(path.dirname(directory))), metadata);
  if (!existsSync(metadata)) return undefined;
  try {
    const state = JSON.parse(readFileSync(metadata, "utf8")) as { startedAt: string };
    return { resumable: true, startedAt: state.startedAt, cachedRequests: readdirSync(staging).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length };
  } catch { throw new HistoryError("HISTORY_STORAGE", "unreadable unfinished history sync metadata"); }
}
