import { rmSync } from "node:fs";
import * as path from "node:path";
import type { RepositoryHistorySource } from "./config.js";
import { HistoryError, historySince } from "./config.js";
import { allPages, GitHubApiError, record } from "./github.js";
import type { GitHubRecord, HistoryApi } from "./github.js";
import { readSnapshot, withHistoryLock, writeSnapshot } from "./storage.js";
import { openHistoryStage } from "./staging.js";
import type { HistoryDocument, HistoryEntity, HistorySnapshot } from "./types.js";
import type { OperationControl } from "../utils/operation-control.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { normalizeHistoryLexicalText } from "./lexical.js";

function document(item: GitHubRecord, kind: HistoryDocument["documentKind"], url: string): HistoryDocument {
  const createdAt = item.created_at ?? item.submitted_at;
  const updatedAt = item.updated_at ?? createdAt;
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new HistoryError("HISTORY_API", "missing discussion timestamp");
  return { id: `${kind}:${item.id}`, documentKind: kind, documentUrl: url, body: String(item.body ?? ""),
    author: String(item.user?.login ?? "[deleted]"), createdAt, updatedAt, reviewState: kind === "review" ? item.state : undefined };
}

async function fetchEntity(api: HistoryApi, repository: string, issue: GitHubRecord, canonicalName: string): Promise<HistoryEntity> {
  const number = issue.number;
  if (!Number.isSafeInteger(number) || number < 1 || typeof issue.title !== "string") throw new HistoryError("HISTORY_API", "invalid issue response");
  const base = `repos/${repository}`;
  const isPr = Boolean(issue.pull_request);
  const pr = isPr ? record(await api.get(`${base}/pulls/${number}`)) : undefined;
  const url = `https://github.com/${canonicalName}/${isPr ? "pull" : "issues"}/${number}`;
  const documents = [document(issue, "body", url)];
  for (const item of await allPages(api, `${base}/issues/${number}/comments`)) documents.push(document(item, "comment", `${url}#issuecomment-${item.id}`));
  const timeline = await allPages(api, `${base}/issues/${number}/timeline`);
  const linkedIssues = new Map<string, string>();
  function addLinkedIssue(value: string): void {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/((?:issues|pull)\/[1-9]\d*)$/.exec(value);
    if (!match) return;
    const canonical = match[1].toLowerCase() === repository
      ? `https://github.com/${canonicalName}/${match[2]}` : value;
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
    for (const match of doc.body.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+\b/g)) addLinkedIssue(match[0]);
    for (const match of doc.body.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/([a-f0-9]{40})\b/gi)) commits.add(match[1]);
    for (const match of doc.body.matchAll(/(?:^|\s)#([1-9]\d*)\b/g)) addLinkedIssue(`https://github.com/${canonicalName}/issues/${match[1]}`);
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
  return withHistoryLock(directory, "index", async (lease) => {
    const old = readSnapshot(directory, source.repository);
    if (old?.lastSyncedAt && since !== undefined) throw new HistoryError("HISTORY_CONFIG", "since only applies to the initial sync; clear before changing the window");
    if (old && since !== undefined && historySince(since) !== old.initialSince) throw new HistoryError("HISTORY_CONFIG", "clear before changing the initial window");
    const initialSince = old ? old.initialSince : historySince(since) ?? source.initialSince;
    const snapshot: HistorySnapshot = old ?? { version: 1, repository: source.repository, status: "error", initialSince, maxNumber: 0, entities: [], lexical: "" };
    try {
      throwIfOperationAborted(control?.signal);
      // Always fresh, bypassing resumable response checkpoints; no known-revoked private cache is served.
      const repo = record(await api.get(`repos/${source.repository}`));
      if (String(repo.full_name).toLowerCase() !== source.repository) throw new HistoryError("HISTORY_INACCESSIBLE", "repository renamed/transferred; cached source is blocked until explicitly reconfigured");
      const repositoryId = repositoryIdentity(repo);
      if (old?.repositoryId && old.repositoryId !== repositoryId) throw new HistoryError("HISTORY_INACCESSIBLE", "repository identity changed; old cached evidence was blocked");
      const access = await api.access();
      if (access.repositoryId !== repositoryId || access.repositoryName.toLowerCase() !== source.repository) throw new HistoryError("HISTORY_INACCESSIBLE", "fresh repository capability identity differs");
      if (old?.principalId && old.principalId !== access.principalId) throw new HistoryError("HISTORY_INACCESSIBLE", "public authentication principal changed; old cached evidence was blocked");
      snapshot.repositoryId = repositoryId;
      snapshot.principalId = access.principalId;
      const stage = openHistoryStage(directory, api, lease, repositoryId, access.principalId, initialSince);
      const entities = new Map<number, HistoryEntity>();
      let maxNumber = 0;
      // Full cursor discovery every successful manual cycle handles imports, deletion, and nonmonotonic createdAt.
      // GitHub pages are not a global remote transaction; a later sweep reconciles concurrent remote changes.
      for (const kind of ["issues", "pullRequests"] as const) {
        let after: string | null = null;
        const cursors = new Set<string>();
        do {
          throwIfOperationAborted(control?.signal);
          await control?.heartbeat?.();
          const page = await stage.api.discover(kind, after);
          for (const node of page.nodes) {
            throwIfOperationAborted(control?.signal);
            maxNumber = Math.max(maxNumber, node.number);
            if (initialSince && Date.parse(node.createdAt) < Date.parse(initialSince)) continue;
            try {
              const issue = record(await stage.api.get(`repos/${source.repository}/issues/${node.number}`));
              entities.set(node.number, await fetchEntity(stage.api, source.repository, issue, String(repo.full_name)));
            } catch (error) {
              if (error instanceof GitHubApiError && error.status === 404) continue; // deleted or individually inaccessible
              throw error;
            }
          }
          if (!page.hasNextPage) break;
          if (!page.endCursor || cursors.has(page.endCursor)) throw new HistoryError("HISTORY_INCOMPLETE", "GitHub discovery cursor made no progress");
          cursors.add(page.endCursor);
          after = page.endCursor;
        } while (after !== null);
      }
      // Every cached entity/discussion is replaced or removed; updatedAt is never used to infer deletion.
      throwIfOperationAborted(control?.signal);
      const finalRepo = record(await api.get(`repos/${source.repository}`));
      if (repositoryIdentity(finalRepo) !== repositoryId || String(finalRepo.full_name).toLowerCase() !== source.repository) {
        throw new HistoryError("HISTORY_INACCESSIBLE", "repository identity/access changed while fetching history");
      }
      const finalAccess = await api.access();
      if (finalAccess.repositoryId !== repositoryId || finalAccess.repositoryName.toLowerCase() !== source.repository || finalAccess.principalId !== access.principalId) {
        throw new HistoryError("HISTORY_INACCESSIBLE", "repository capability or public auth principal changed during fetching");
      }
      // Lazy native loading keeps disabled/status/clear usable without a native code runtime.
      const { InvertedIndex } = await import("../native/inverted-index.js");
      const lexical = new InvertedIndex(directory);
      if (old?.lexical) lexical.deserialize(old.lexical);
      const ordered = [...entities.values()].sort((a, b) => a.number - b.number);
      const previousContent = new Map<string, string>();
      const nextContent = new Map<string, string>();
      for (const [collection, content] of [[old?.entities ?? [], previousContent], [ordered, nextContent]] as const) {
        for (const entity of collection) for (const doc of entity.documents) {
          const references = doc.documentKind === "body" ? `\n${entity.files.join("\n")}\n${entity.commits.join(" ")}` : "";
          content.set(`${entity.number}:${doc.id}`, normalizeHistoryLexicalText(`${source.repository} #${entity.number} ${entity.url}\n${entity.title}\n${doc.body}${references}`));
        }
      }
      for (const id of previousContent.keys()) if (!nextContent.has(id)) lexical.removeChunk(id);
      for (const [id, content] of nextContent) {
        throwIfOperationAborted(control?.signal);
        if (previousContent.get(id) === content && old?.lexical) continue;
        if (previousContent.has(id)) lexical.removeChunk(id);
        lexical.addChunk(id, content);
      }
      const next: HistorySnapshot = { version: 1, repository: source.repository, repositoryId, principalId: access.principalId, status: "ready", initialSince, maxNumber,
        cursor: stage.startedAt, lastSyncedAt: new Date().toISOString(), entities: ordered, lexical: lexical.serialize() };
      throwIfOperationAborted(control?.signal);
      writeSnapshot(directory, next, lease);
      stage.clear();
      return { ...next, syncedEntities: ordered.length, removedEntities: (old?.entities ?? []).filter((entity) => !entities.has(entity.number)).length, complete: true };
    } catch (error) {
      const inaccessible = error instanceof GitHubApiError && !error.rateLimited && [401, 403, 404].includes(error.status)
        || error instanceof HistoryError && error.code === "HISTORY_INACCESSIBLE";
      const failure = error instanceof HistoryError ? error : control?.signal?.aborted
        ? new HistoryError("HISTORY_CANCELLED", "manual history sync was cancelled; fetch staging retained")
        : new HistoryError("HISTORY_SYNC", "history sync failed; previous cursor was not advanced");
      // Incomplete/corrupt remote traversal must be restarted explicitly on the next manual request.
      if (inaccessible || failure.code === "HISTORY_INCOMPLETE") rmSync(path.join(directory, "fetch-staging"), { recursive: true, force: true });
      writeSnapshot(directory, { ...snapshot, status: inaccessible ? "inaccessible" : "error", lastError: failure.message,
        ...(inaccessible ? { repositoryId: undefined, principalId: undefined, entities: [], lexical: "", maxNumber: 0, lastSyncedAt: undefined } : {}) }, lease);
      throw failure;
    }
  });
}
