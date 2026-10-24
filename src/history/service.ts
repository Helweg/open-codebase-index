import { rmSync } from "node:fs";
import * as path from "node:path";
import type { RepositoryHistorySource, RepositoryHistoryIdentity } from "./config.js";
import { HistoryError, parseRepositoryIdentity } from "./config.js";
import { allPages, GitHubApiError, record } from "./github.js";
import type { GitHubRecord, HistoryApi } from "./github.js";
import { readSnapshot, withHistoryLock, writeSnapshot } from "./storage.js";
import { openHistoryStage, readHistoryStageWindow, retireHistoryStage } from "./staging.js";
import type { HistoryDocument, HistoryEntity, HistorySnapshot } from "./types.js";
import type { OperationControl } from "../utils/operation-control.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { HISTORY_LEXICAL_VERSION } from "./lexical.js";
import { updateHistoryLexical } from "./lexical-index.js";
import { checkpointHistoryWork } from "./work.js";
import { effectiveHistoryWindow } from "./window.js";
import { HISTORY_HTTP_CACHE_VERSION } from "./responses.js";

function document(item: GitHubRecord, kind: HistoryDocument["documentKind"], url: string): HistoryDocument {
  const createdAt = item.created_at ?? item.submitted_at;
  const updatedAt = item.updated_at ?? null;
  const id = item.id ?? item.node_id;
  if (id === undefined || !Number.isFinite(Date.parse(createdAt)) || updatedAt !== null && !Number.isFinite(Date.parse(updatedAt))) throw new HistoryError("HISTORY_API", "missing discussion identity or timestamp");
  return { id: `${kind}:${id}`, documentKind: kind, documentUrl: url, body: String(item.body ?? ""),
    author: String(item.user?.login ?? "[deleted]"), createdAt, updatedAt,
    timestampProvenance: { createdAt: item.created_at ? "created_at" : "submitted_at", updatedAt: updatedAt === null ? "unavailable" : "updated_at" },
    reviewState: kind === "review" ? item.state : undefined };
}

async function fetchEntity(api: HistoryApi, identity: RepositoryHistoryIdentity, issue: GitHubRecord, canonicalName: string): Promise<HistoryEntity> {
  const number = issue.number;
  if (!Number.isSafeInteger(number) || number < 1 || typeof issue.title !== "string") throw new HistoryError("HISTORY_API", "invalid issue response");
  const base = `repos/${identity.nameWithOwner}`;
  const isPr = Boolean(issue.pull_request);
  const pr = isPr ? record((await api.get(`${base}/pulls/${number}`)).value) : undefined;
  const url = `https://${identity.hostname}/${canonicalName}/${isPr ? "pull" : "issues"}/${number}`;
  const documents = [document(issue, "body", url)];
  for (const item of await allPages(api, `${base}/issues/${number}/comments`)) documents.push(document(item, "comment", `${url}#issuecomment-${item.id}`));
  const timeline = await allPages(api, `${base}/issues/${number}/timeline`);
  const linkedIssues = new Map<string, string>();
  function addLinkedIssue(value: string): void {
    const match = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/((?:issues|pull)\/[1-9]\d*)$/.exec(value);
    if (!match) return;
    let reference: RepositoryHistoryIdentity;
    try { reference = parseRepositoryIdentity(`${match[1]}/${match[2]}`); }
    catch { return; }
    const canonical = reference.hostname === identity.hostname && reference.nameWithOwner === identity.nameWithOwner
      ? `https://${identity.hostname}/${canonicalName}/${match[3]}` : value;
    const key = canonical.toLowerCase();
    if (!linkedIssues.has(key)) linkedIssues.set(key, canonical);
  }
  const commits = new Set<string>();
  for (const event of timeline) {
    const linked = event.source?.issue;
    if (linked?.html_url) addLinkedIssue(linked.html_url);
    const sha = event.commit_id ?? event.sha;
    if (sha && /^[a-f0-9]{40}$/i.test(sha)) commits.add(sha);
  }
  const files: string[] = [];
  let totalChangedFiles = 0;
  let fileReferencesComplete = true;
  if (pr) {
    for (const item of await allPages(api, `${base}/pulls/${number}/reviews`)) {
      // Pending reviews are not submitted historical discussions and lack a canonical review anchor.
      if (item.state === "PENDING") continue;
      documents.push(document(item, "review", `${url}#pullrequestreview-${item.id}`));
    }
    for (const item of await allPages(api, `${base}/pulls/${number}/comments`)) documents.push(document(item, "review_comment", `${url}#discussion_r${item.id}`));
    const changed = await allPages(api, `${base}/pulls/${number}/files`, 3000);
    if (!Number.isSafeInteger(pr.changed_files) || (pr.changed_files ?? -1) < 0) throw new HistoryError("HISTORY_API", "missing changed-file count");
    totalChangedFiles = Number(pr.changed_files);
    fileReferencesComplete = changed.length === totalChangedFiles;
    for (const file of changed) files.push(String(file.filename));
    // Commit provenance is linked references, not an exhaustive git mirror or REST's capped 250-commit list.
    for (const sha of [pr.head?.sha, pr.base?.sha, pr.merged_at ? pr.merge_commit_sha : undefined]) {
      if (sha && /^[a-f0-9]{40}$/i.test(sha)) commits.add(sha);
    }
  }
  for (const doc of documents) {
    for (const match of doc.body.matchAll(/https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9]\d*\b/g)) addLinkedIssue(match[0]);
    for (const match of doc.body.matchAll(/https:\/\/([A-Za-z0-9.-]+)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/([a-f0-9]{40})\b/gi)) {
      if (match[1].toLowerCase() === identity.hostname) commits.add(match[2]);
    }
    for (const match of doc.body.matchAll(/(?:^|\s)#([1-9]\d*)\b/g)) addLinkedIssue(`https://${identity.hostname}/${canonicalName}/issues/${match[1]}`);
  }
  let state: HistoryEntity["state"] = issue.state === "closed" ? "closed" : "open";
  if (pr?.merged_at) state = "merged";
  else if (pr?.draft && issue.state === "open") state = "draft";
  return { number, kind: isPr ? "pull_request" : "issue", state,
    title: issue.title, url, author: String(issue.user?.login ?? "[deleted]"), createdAt: issue.created_at, updatedAt: issue.updated_at ?? issue.created_at,
    mergeCommitSha: pr?.merged_at ? pr.merge_commit_sha ?? undefined : undefined,
    linkedIssues: [...linkedIssues.values()], commits: [...commits], files, fileReferencesComplete, totalChangedFiles, documents };
}

function repositoryIdentity(repo: GitHubRecord): string {
  const id = repo.id ?? repo.node_id;
  if (id === undefined || String(id).length === 0) throw new HistoryError("HISTORY_API", "repository response has no immutable identity");
  return String(id);
}

export async function syncHistory(source: RepositoryHistorySource, directory: string, api: HistoryApi, since?: string, control?: OperationControl): Promise<HistorySnapshot & { syncedEntities: number; removedEntities: number; complete: true }> {
  const identity = parseRepositoryIdentity(source.repository);
  if (identity.canonical !== source.repository) throw new HistoryError("HISTORY_CONFIG", "history source repository must be canonical");
  return withHistoryLock(directory, "index", async (lease) => {
    retireHistoryStage(directory);
    const old = readSnapshot(directory, source.repository);
    const initialSince = effectiveHistoryWindow(source, old ?? readHistoryStageWindow(directory, source.repository), since);
    const configuredInitialSince = source.initialSince ?? null;
    const snapshot: HistorySnapshot = old ?? { version: 2, repository: source.repository, status: "error", initialSince, configuredInitialSince, maxNumber: 0, entities: [], lexical: "", lexicalVersion: HISTORY_LEXICAL_VERSION };
    let committed = false;
    try {
      throwIfOperationAborted(control?.signal);
      const repo = record((await api.get(`repos/${identity.nameWithOwner}`)).value);
      if (String(repo.full_name).toLowerCase() !== identity.nameWithOwner) throw new HistoryError("HISTORY_INACCESSIBLE", "repository renamed/transferred; cached source is blocked until explicitly reconfigured");
      const repositoryId = repositoryIdentity(repo);
      if (old?.repositoryId && old.repositoryId !== repositoryId) throw new HistoryError("HISTORY_INACCESSIBLE", "repository identity changed; old cached evidence was blocked");
      const access = await api.access();
      if (access.hostname !== identity.hostname || access.repositoryId !== repositoryId || access.repositoryName.toLowerCase() !== identity.nameWithOwner) throw new HistoryError("HISTORY_INACCESSIBLE", "fresh host/repository capability identity differs");
      if (old?.principalId && old.principalId !== access.principalId) throw new HistoryError("HISTORY_INACCESSIBLE", "public authentication principal changed; old cached evidence was blocked");
      const stage = openHistoryStage(directory, api, lease, source.repository, repositoryId, access.principalId, initialSince, configuredInitialSince, old);
      const entities = new Map<number, HistoryEntity>();
      let maxNumber = 0;
      // Complete discovery and per-page revalidation reconcile imports/deletions without parent timestamp assumptions.
      for (const kind of ["issues", "pullRequests"] as const) {
        let after: string | null = null;
        const cursors = new Set<string>();
        do {
          await checkpointHistoryWork(control);
          const page = await stage.api.discover(kind, after);
          for (const node of page.nodes) {
            throwIfOperationAborted(control?.signal);
            maxNumber = Math.max(maxNumber, node.number);
            if (initialSince && Date.parse(node.createdAt) < Date.parse(initialSince)) continue;
            try {
              const issue = record((await stage.api.get(`repos/${identity.nameWithOwner}/issues/${node.number}`)).value);
              entities.set(node.number, await fetchEntity(stage.api, identity, issue, String(repo.full_name)));
            } catch (error) {
              if (error instanceof GitHubApiError && error.status === 404) continue;
              throw error;
            }
          }
          if (!page.hasNextPage) break;
          if (!page.endCursor || cursors.has(page.endCursor)) throw new HistoryError("HISTORY_INCOMPLETE", "GitHub discovery cursor made no progress");
          cursors.add(page.endCursor);
          after = page.endCursor;
        } while (after !== null);
      }
      const ordered = [...entities.values()].sort((a, b) => a.number - b.number);
      const lexical = await updateHistoryLexical(old, source.repository, ordered, directory, control);
      const next: HistorySnapshot = { version: 2, repository: source.repository, repositoryId, principalId: access.principalId, status: "ready", initialSince, configuredInitialSince, maxNumber,
        cursor: stage.startedAt, syncGeneration: stage.generation, lastSyncedAt: new Date().toISOString(), entities: ordered, lexical, lexicalVersion: HISTORY_LEXICAL_VERSION, httpCacheVersion: HISTORY_HTTP_CACHE_VERSION, httpCache: stage.cache(ordered) };
      await writeSnapshot(directory, next, lease, control, async () => {
        // Capability proofs are fresh AFTER expensive preparation, never replayed from staging/cache.
        const finalRepo = record((await api.get(`repos/${identity.nameWithOwner}`)).value);
        if (repositoryIdentity(finalRepo) !== repositoryId || String(finalRepo.full_name).toLowerCase() !== identity.nameWithOwner) {
          throw new HistoryError("HISTORY_INACCESSIBLE", "repository identity/access changed while fetching history");
        }
        const finalAccess = await api.access();
        if (finalAccess.hostname !== identity.hostname || finalAccess.repositoryId !== repositoryId || finalAccess.repositoryName.toLowerCase() !== identity.nameWithOwner || finalAccess.principalId !== access.principalId) {
          throw new HistoryError("HISTORY_INACCESSIBLE", "repository capability or public auth principal changed during fetching");
        }
      });
      committed = true;
      try { stage.clear(); }
      catch { throw new HistoryError("HISTORY_STORAGE", "history was committed, but fetch-staging cleanup failed; a later sync will retire that committed stage"); }
      return { ...next, syncedEntities: ordered.length, removedEntities: (old?.entities ?? []).filter((entity) => !entities.has(entity.number)).length, complete: true };
    } catch (error) {
      if (committed) throw error;
      const inaccessible = error instanceof GitHubApiError && !error.rateLimited && [401, 403, 404].includes(error.status)
        || error instanceof HistoryError && error.code === "HISTORY_INACCESSIBLE";
      if (!inaccessible && (control?.signal?.aborted || error instanceof HistoryError && error.code === "HISTORY_CANCELLED")) {
        throw new HistoryError("HISTORY_CANCELLED", "manual history sync was cancelled before commit; published snapshot unchanged and fetch staging retained");
      }
      const failure = error instanceof HistoryError ? error : new HistoryError("HISTORY_SYNC", "history sync failed; previous cursor was not advanced");
      if (inaccessible || failure.code === "HISTORY_INCOMPLETE") rmSync(path.join(directory, "fetch-staging"), { recursive: true, force: true });
      await writeSnapshot(directory, { ...snapshot, status: inaccessible ? "inaccessible" : "error", lastError: failure.message,
        ...(inaccessible ? { repositoryId: undefined, principalId: undefined, entities: [], lexical: "", httpCache: {}, maxNumber: 0, lastSyncedAt: undefined } : {}) }, lease);
      throw failure;
    }
  });
}
