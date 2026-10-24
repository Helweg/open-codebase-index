import { isIP } from "node:net";

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

export interface RepositoryHistoryIdentity {
  hostname: string;
  nameWithOwner: string;
  canonical: string;
}

export function parseRepositoryIdentity(value: unknown): RepositoryHistoryIdentity {
  const invalid = () => new HistoryError("HISTORY_CONFIG", "repository must be [HOST/]OWNER/REPO with a DNS hostname, not a URL, port, or path");
  if (typeof value !== "string" || value.trim() !== value) throw invalid();
  const parts = value.split("/");
  if (parts.length !== 2 && parts.length !== 3) throw invalid();
  const hostname = parts.length === 3 ? parts.shift()!.toLowerCase() : "github.com";
  if (hostname.length > 253 || isIP(hostname) !== 0 || !hostname.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
  const nameWithOwner = parts.join("/").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/.test(nameWithOwner)
    || parts[1] === "." || parts[1] === ".." || nameWithOwner.endsWith(".git")) throw invalid();
  return { hostname, nameWithOwner, canonical: hostname === "github.com" ? nameWithOwner : `${hostname}/${nameWithOwner}` };
}

export function canonicalRepository(value: unknown): string {
  return parseRepositoryIdentity(value).canonical;
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
