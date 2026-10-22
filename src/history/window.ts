import { HistoryError, historySince } from "./config.js";
import type { RepositoryHistorySource } from "./config.js";
import type { HistorySnapshot } from "./types.js";
export type HistoryWindowState = Pick<HistorySnapshot, "initialSince" | "configuredInitialSince" | "lastSyncedAt">;

export function historyWindowMismatch(source: RepositoryHistorySource, snapshot?: HistoryWindowState): boolean {
  if (!snapshot) return false;
  const configured = source.initialSince ?? null;
  // A legacy bounded cache with absent config cannot reveal CLI-vs-removed-config provenance.
  return snapshot.configuredInitialSince === undefined
    ? configured !== (snapshot.initialSince ?? null)
    : configured !== snapshot.configuredInitialSince;
}

export function effectiveHistoryWindow(source: RepositoryHistorySource, snapshot?: HistoryWindowState, since?: string): string | undefined {
  if (historyWindowMismatch(source, snapshot)) throw new HistoryError("HISTORY_CONFIG", "configured initialSince differs from the cached configuration (or legacy bound provenance is unknown); clear history before changing the initial window");
  if (snapshot?.lastSyncedAt && since !== undefined) throw new HistoryError("HISTORY_CONFIG", "since only applies to the initial sync; clear before changing the window");
  if (snapshot && since !== undefined && historySince(since) !== snapshot.initialSince) throw new HistoryError("HISTORY_CONFIG", "clear before changing the unfinished initial window");
  return snapshot ? snapshot.initialSince : historySince(since) ?? source.initialSince;
}
