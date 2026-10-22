export type HistoryKind = "issue" | "pull_request";
export type HistoryState = "open" | "closed" | "merged" | "draft";
export interface HistoryTimestampProvenance {
  createdAt: "created_at" | "submitted_at" | "legacy";
  updatedAt: "updated_at" | "unavailable" | "legacy";
}
export interface HistoryDocument {
  id: string;
  documentKind: "body" | "comment" | "review" | "review_comment";
  documentUrl: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string | null;
  timestampProvenance: HistoryTimestampProvenance;
  reviewState?: string;
}
export interface HistoryEntity {
  number: number;
  kind: HistoryKind;
  state: HistoryState;
  title: string;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  mergeCommitSha?: string;
  linkedIssues: string[];
  commits: string[];
  files: string[];
  fileReferencesComplete: boolean;
  totalChangedFiles: number;
  documents: HistoryDocument[];
}
export interface HistoryCachedResponse {
  etag?: string;
  fetchedAt: string;
  value: unknown;
}
export interface HistorySnapshot {
  version: 2;
  repository: string;
  repositoryId?: string;
  principalId?: string;
  status: "ready" | "inaccessible" | "error";
  initialSince?: string;
  /** Absent only for legacy snapshots whose original configuration is unknown. */
  configuredInitialSince?: string | null;
  maxNumber: number;
  cursor?: string;
  syncGeneration?: string;
  lastSyncedAt?: string;
  lastError?: string;
  entities: HistoryEntity[];
  lexical: string;
  lexicalVersion?: number;
  httpCacheVersion?: number;
  /** Projected endpoint/page representations, bound to this snapshot's identity and window. */
  httpCache?: Record<string, HistoryCachedResponse>;
}

export interface HistorySyncProgress {
  resumable: true;
  startedAt: string;
  cachedRequests: number;
}

export interface RepositoryHistoryStatusResult {
  source: "github_history";
  localOnly: true;
  authoritative: false;
  warning: string;
  repository: string;
  enabled: boolean;
  status: "disabled" | "empty" | "ready" | "inaccessible" | "error";
  entityCount: number;
  documentCount: number;
  incompleteFileReferenceEntities: number;
  initialSince?: string;
  configuredInitialSince?: string;
  initialSinceMismatch: boolean;
  lexicalVersion?: number;
  lexicalRebuildRequired: boolean;
  maxNumber?: number;
  cursor?: string;
  lastSyncedAt?: string;
  lastError?: string;
  syncProgress?: HistorySyncProgress;
}

export interface RepositoryHistorySyncResult extends RepositoryHistoryStatusResult {
  complete: boolean;
  syncedEntities: number;
  removedEntities: number;
}

export interface RepositoryHistorySearchHit {
  repository: string;
  number: number;
  kind: HistoryKind;
  state: HistoryState;
  title: string;
  url: string;
  documentUrl: string;
  documentKind: HistoryDocument["documentKind"];
  author: string;
  createdAt: string;
  updatedAt: string | null;
  timestampProvenance: HistoryTimestampProvenance;
  excerpt: string;
  reviewState?: string;
  score: number;
  mergeCommitSha?: string;
  linkedIssues: string[];
  commits: string[];
  files: string[];
  fileReferencesComplete: boolean;
  totalChangedFiles: number;
  commitReferenceScope: "linked";
}

export interface RepositoryHistorySearchResult extends RepositoryHistoryStatusResult {
  results: RepositoryHistorySearchHit[];
}

export interface RepositoryHistoryClearResult extends RepositoryHistoryStatusResult {
  cleared: true;
}
