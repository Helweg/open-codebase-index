import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import type { HostMode } from "../config/host.js";
import { getHostProjectConfigRelativePath } from "../config/paths.js";
import { canonicalRepository, HistoryError, parseRepositoryHistoryConfig } from "../history/config.js";
import type { RepositoryHistorySource } from "../history/config.js";
import { createGitHubApi } from "../history/github.js";
import { syncHistory } from "../history/service.js";
import { cleanLegacyHistoryStaging, readHistorySyncProgress } from "../history/staging.js";
import { historyDirectory, readSnapshot, withHistoryLock, writeSnapshot } from "../history/storage.js";
import type { HistorySnapshot, RepositoryHistoryStatusResult, RepositoryHistorySyncResult, RepositoryHistorySearchResult, RepositoryHistoryClearResult } from "../history/types.js";
import type { SharedRepositoryHistoryClearArgs, SharedRepositoryHistorySearchArgs, SharedRepositoryHistoryStatusArgs, SharedRepositoryHistorySyncArgs } from "./contracts.js";
import type { OperationControl } from "../utils/operation-control.js";
import { assertHistoryProjectPath } from "../history/paths.js";
import { HISTORY_LEXICAL_VERSION } from "../history/lexical.js";
import { updateHistoryLexical } from "../history/lexical-index.js";
import { searchHistory } from "../history/search.js";
import { historyWindowMismatch } from "../history/window.js";

const EVIDENCE = {
  source: "github_history" as const, localOnly: true as const, authoritative: false as const,
  warning: "Untrusted historical evidence; current code is authoritative. Cached permissions/freshness are not real-time.",
};

function sourceFor(projectRoot: string, host: HostMode, repository?: string): RepositoryHistorySource {
  // Deliberately no merged/global config or main-worktree fallback: opt-in is local to this project.
  const configPath = path.join(projectRoot, getHostProjectConfigRelativePath(host));
  assertHistoryProjectPath(projectRoot, configPath);
  let raw: { repositoryHistory?: unknown } = {};
  try { if (existsSync(configPath)) raw = JSON.parse(readFileSync(configPath, "utf8")) as { repositoryHistory?: unknown }; }
  catch { throw new HistoryError("HISTORY_CONFIG", "cannot read project-local history configuration"); }
  const sources = parseRepositoryHistoryConfig(raw?.repositoryHistory).repositories;
  if (repository) {
    const canonical = canonicalRepository(repository);
    return sources.find((source) => source.repository === canonical) ?? { repository: canonical, enabled: false };
  }
  if (sources.length === 1) return sources[0];
  if (!sources.length) return { repository: "", enabled: false };
  throw new HistoryError("HISTORY_CONFIG", "repository is required when multiple sources are configured");
}

function needsLexicalRebuild(snapshot?: HistorySnapshot): boolean {
  return Boolean(snapshot?.entities.length && (snapshot.lexicalVersion !== HISTORY_LEXICAL_VERSION || !snapshot.lexical));
}

function statusResult(source: RepositoryHistorySource, snapshot?: HistorySnapshot): RepositoryHistoryStatusResult {
  return { ...EVIDENCE, repository: source.repository, enabled: source.enabled,
    status: !source.enabled ? "disabled" as const : snapshot?.status ?? "empty" as const,
    entityCount: snapshot?.entities.length ?? 0,
    documentCount: snapshot?.entities.reduce((count, entity) => count + entity.documents.length, 0) ?? 0,
    incompleteFileReferenceEntities: snapshot?.entities.filter((entity) => !entity.fileReferencesComplete).length ?? 0,
    initialSince: snapshot ? snapshot.initialSince : source.initialSince, configuredInitialSince: source.initialSince,
    initialSinceMismatch: historyWindowMismatch(source, snapshot), lexicalVersion: snapshot?.lexicalVersion,
    lexicalRebuildRequired: needsLexicalRebuild(snapshot), maxNumber: snapshot?.maxNumber,
    cursor: snapshot?.cursor, lastSyncedAt: snapshot?.lastSyncedAt, lastError: snapshot?.lastError };
}

export async function runRepositoryHistoryStatus(args: SharedRepositoryHistoryStatusArgs, projectRoot: string, host: HostMode): Promise<RepositoryHistoryStatusResult> {
  const source = sourceFor(projectRoot, host, args.repository);
  if (!source.enabled) return statusResult(source);
  const directory = historyDirectory(projectRoot, host, source.repository);
  await cleanLegacyHistoryStaging(directory);
  const snapshot = readSnapshot(directory, source.repository);
  return { ...statusResult(source, snapshot), syncProgress: readHistorySyncProgress(directory, snapshot) };
}

export async function runRepositoryHistorySync(args: SharedRepositoryHistorySyncArgs, projectRoot: string, host: HostMode, control?: OperationControl): Promise<RepositoryHistorySyncResult> {
  const source = sourceFor(projectRoot, host, args.repository);
  if (!source.enabled) return { ...statusResult(source), complete: false, syncedEntities: 0, removedEntities: 0 };
  const result = await syncHistory(source, historyDirectory(projectRoot, host, source.repository), createGitHubApi(source.repository, projectRoot, control?.signal), args.since, control);
  return { ...statusResult(source, result), complete: result.complete, syncedEntities: result.syncedEntities, removedEntities: result.removedEntities };
}

export async function runRepositoryHistoryClear(args: SharedRepositoryHistoryClearArgs, projectRoot: string, host: HostMode): Promise<RepositoryHistoryClearResult> {
  const source = sourceFor(projectRoot, host, args.repository);
  if (!source.repository) return { ...statusResult(source), cleared: true };
  const directory = historyDirectory(projectRoot, host, source.repository);
  if (existsSync(directory)) await withHistoryLock(directory, "clear", async () => {
    rmSync(path.join(directory, "snapshot.json"), { force: true });
    rmSync(path.join(directory, "fetch-staging"), { recursive: true, force: true });
  });
  return { ...statusResult(source), cleared: true };
}

export async function runRepositoryHistorySearch(args: SharedRepositoryHistorySearchArgs, projectRoot: string, host: HostMode, control?: OperationControl): Promise<RepositoryHistorySearchResult> {
  const source = sourceFor(projectRoot, host, args.repository);
  if (!source.enabled) return { ...statusResult(source), results: [] };
  if (typeof args.query !== "string" || !args.query.trim()) throw new HistoryError("HISTORY_QUERY", "query must not be empty");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new HistoryError("HISTORY_QUERY", "limit must be an integer between 1 and 100");
  if (args.kind !== undefined && !["issue", "pull_request"].includes(args.kind)) throw new HistoryError("HISTORY_QUERY", "invalid kind");
  if (args.state !== undefined && !["open", "closed", "merged", "draft"].includes(args.state)) throw new HistoryError("HISTORY_QUERY", "invalid state");
  const directory = historyDirectory(projectRoot, host, source.repository);
  await cleanLegacyHistoryStaging(directory);
  let snapshot = readSnapshot(directory, source.repository);
  if (!snapshot || snapshot.status === "inaccessible") return { ...statusResult(source, snapshot), results: [] };
  try {
    if (needsLexicalRebuild(snapshot)) {
      snapshot = await withHistoryLock(directory, "index", async (lease) => {
        const current = readSnapshot(directory, source.repository);
        if (!current || current.status === "inaccessible" || !needsLexicalRebuild(current)) return current;
        const lexical = await updateHistoryLexical(undefined, source.repository, current.entities, directory, control);
        const migrated = { ...current, lexical, lexicalVersion: HISTORY_LEXICAL_VERSION };
        // Local migration never advances remote cursor/freshness or performs network access.
        await writeSnapshot(directory, migrated, lease, control);
        return migrated;
      });
    }
    if (!snapshot?.lexical) return { ...statusResult(source, snapshot), results: [] };
    return { ...statusResult(source, snapshot), results: await searchHistory(snapshot, directory, args, control) };
  } catch (error) {
    if (control?.signal?.aborted) throw new HistoryError("HISTORY_CANCELLED", "local history search/migration was cancelled before completion");
    throw error;
  }
}
