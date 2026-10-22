import { existsSync, readFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import type { HostMode } from "../config/host.js";
import { getHostProjectConfigRelativePath } from "../config/paths.js";
import { canonicalRepository, HistoryError, parseRepositoryHistoryConfig } from "../history/config.js";
import type { RepositoryHistorySource } from "../history/config.js";
import { createGitHubApi } from "../history/github.js";
import { syncHistory } from "../history/service.js";
import { readHistorySyncProgress } from "../history/staging.js";
import { historyDirectory, readSnapshot, withHistoryLock } from "../history/storage.js";
import type { HistorySnapshot, RepositoryHistoryStatusResult, RepositoryHistorySyncResult, RepositoryHistorySearchResult, RepositoryHistorySearchHit, RepositoryHistoryClearResult } from "../history/types.js";
import type { SharedRepositoryHistoryClearArgs, SharedRepositoryHistorySearchArgs, SharedRepositoryHistoryStatusArgs, SharedRepositoryHistorySyncArgs } from "./contracts.js";
import type { OperationControl } from "../utils/operation-control.js";
import { assertHistoryProjectPath } from "../history/paths.js";
import { normalizeHistoryLexicalText } from "../history/lexical.js";

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

function statusResult(source: RepositoryHistorySource, snapshot?: HistorySnapshot): RepositoryHistoryStatusResult {
  return { ...EVIDENCE, repository: source.repository, enabled: source.enabled,
    status: !source.enabled ? "disabled" as const : snapshot?.status ?? "empty" as const,
    entityCount: snapshot?.entities.length ?? 0,
    documentCount: snapshot?.entities.reduce((count, entity) => count + entity.documents.length, 0) ?? 0,
    incompleteFileReferenceEntities: snapshot?.entities.filter((entity) => !entity.fileReferencesComplete).length ?? 0,
    initialSince: snapshot ? snapshot.initialSince : source.initialSince, maxNumber: snapshot?.maxNumber,
    cursor: snapshot?.cursor, lastSyncedAt: snapshot?.lastSyncedAt, lastError: snapshot?.lastError };
}

export async function runRepositoryHistoryStatus(args: SharedRepositoryHistoryStatusArgs, projectRoot: string, host: HostMode): Promise<RepositoryHistoryStatusResult> {
  const source = sourceFor(projectRoot, host, args.repository);
  if (!source.enabled) return statusResult(source);
  const directory = historyDirectory(projectRoot, host, source.repository);
  return { ...statusResult(source, readSnapshot(directory, source.repository)), syncProgress: readHistorySyncProgress(directory) };
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

export async function runRepositoryHistorySearch(args: SharedRepositoryHistorySearchArgs, projectRoot: string, host: HostMode): Promise<RepositoryHistorySearchResult> {
  const source = sourceFor(projectRoot, host, args.repository);
  if (!source.enabled) return { ...statusResult(source), results: [] };
  if (typeof args.query !== "string" || !args.query.trim()) throw new HistoryError("HISTORY_QUERY", "query must not be empty");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new HistoryError("HISTORY_QUERY", "limit must be an integer between 1 and 100");
  if (args.kind !== undefined && !["issue", "pull_request"].includes(args.kind)) throw new HistoryError("HISTORY_QUERY", "invalid kind");
  if (args.state !== undefined && !["open", "closed", "merged", "draft"].includes(args.state)) throw new HistoryError("HISTORY_QUERY", "invalid state");
  const directory = historyDirectory(projectRoot, host, source.repository);
  const snapshot = readSnapshot(directory, source.repository);
  if (!snapshot || snapshot.status === "inaccessible" || !snapshot.lexical) return { ...statusResult(source, snapshot), results: [] };
  // Lazy native loading is required: status, clear, and disabled requests must work without a code/native runtime.
  const { InvertedIndex } = await import("../native/inverted-index.js");
  const lexical = new InvertedIndex(directory);
  lexical.deserialize(snapshot.lexical);
  const scores = lexical.search(normalizeHistoryLexicalText(args.query), snapshot.entities.reduce((count, entity) => count + entity.documents.length, 0));
  const results: RepositoryHistorySearchHit[] = [];
  const words = args.query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const entity of snapshot.entities) {
    if (args.kind && entity.kind !== args.kind || args.state && entity.state !== args.state) continue;
    for (const doc of entity.documents) {
      if (args.author && doc.author.toLowerCase() !== args.author.toLowerCase()) continue;
      const score = scores.get(`${entity.number}:${doc.id}`);
      if (score === undefined) continue;
      const text = `${entity.title}\n${doc.body}`;
      const lower = text.toLowerCase();
      const offsets = words.map((word) => lower.indexOf(word)).filter((offset) => offset >= 0);
      const start = Math.max(0, (offsets.length ? Math.min(...offsets) : 0) - 100);
      results.push({ repository: source.repository, number: entity.number, kind: entity.kind, state: entity.state,
        title: entity.title, url: entity.url, documentUrl: doc.documentUrl, documentKind: doc.documentKind,
        author: doc.author, createdAt: doc.createdAt, updatedAt: doc.updatedAt, reviewState: doc.reviewState, excerpt: text.slice(start, start + 800), score,
        mergeCommitSha: entity.mergeCommitSha, linkedIssues: entity.linkedIssues, commits: entity.commits, files: entity.files,
        fileReferencesComplete: entity.fileReferencesComplete, totalChangedFiles: entity.totalChangedFiles, commitReferenceScope: "linked" });
    }
  }
  results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.documentUrl.localeCompare(b.documentUrl));
  return { ...statusResult(source, snapshot), results: results.slice(0, args.limit ?? 10) };
}
