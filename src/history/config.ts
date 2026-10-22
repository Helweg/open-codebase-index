export interface RepositoryHistorySource {
  repository: string;
  enabled: boolean;
  initialSince?: string;
}

export interface RepositoryHistoryConfig {
  repositories: RepositoryHistorySource[];
}

export class HistoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "HistoryError";
  }
}

export function canonicalRepository(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    || value.split("/")[1] === "." || value.split("/")[1] === ".." || value.endsWith(".git")) {
    throw new HistoryError("HISTORY_CONFIG", "repository must be a GitHub.com owner/repo, not a URL or path");
  }
  return value.toLowerCase();
}

export function historySince(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d(?:T.*Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HistoryError("HISTORY_CONFIG", "initialSince/since must be an ISO date or UTC timestamp");
  }
  return new Date(value).toISOString();
}

export function parseRepositoryHistoryConfig(raw: unknown): RepositoryHistoryConfig {
  if (raw === undefined) return { repositories: [] };
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as RepositoryHistoryConfig).repositories)) {
    throw new HistoryError("HISTORY_CONFIG", "repositoryHistory.repositories must be an array");
  }
  const seen = new Set<string>();
  return { repositories: (raw as RepositoryHistoryConfig).repositories.map((source) => {
    if (!source || typeof source !== "object") throw new HistoryError("HISTORY_CONFIG", "invalid source");
    const repository = canonicalRepository(source.repository);
    if (seen.has(repository)) throw new HistoryError("HISTORY_CONFIG", "duplicate repository");
    seen.add(repository);
    return { repository, enabled: source.enabled === true, initialSince: historySince(source.initialSince) };
  }) };
}
