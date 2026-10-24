import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HistoryError, parseRepositoryIdentity } from "./config.js";
import { projectHistoryResponse } from "./responses.js";
import type { HistoryRestResponse } from "./responses.js";

const execFileAsync = promisify(execFile);
export interface GitHubRecord {
  id?: number | string;
  node_id?: string;
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  user?: { login?: string };
  created_at: string;
  updated_at?: string;
  submitted_at?: string;
  pull_request?: unknown;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  changed_files?: number;
  commits?: number;
  draft?: boolean;
  source?: { issue?: { html_url?: string } };
  commit_id?: string;
  sha?: string;
  filename?: string;
  full_name?: string;
  event?: string;
  head?: { sha?: string };
  base?: { sha?: string };
}
interface GraphQLResponse {
  errors?: { type?: string }[];
  data?: { viewer?: { id?: string }; repository?: {
    databaseId?: number;
    nameWithOwner?: string;
    issues?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
    pullRequests?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
  } };
}
export interface HistoryDiscoveryPage {
  nodes: { number: number; createdAt: string }[];
  endCursor: string | null;
  hasNextPage: boolean;
}
export interface HistoryAccess {
  /** Selected authenticated gh transport host; IDs below come from fresh API proof. */
  hostname: string;
  repositoryId: string;
  repositoryName: string;
  principalId: string;
}
export interface HistoryApi {
  get(endpoint: string, etag?: string): Promise<HistoryRestResponse>;
  access(): Promise<HistoryAccess>;
  discover(kind: "issues" | "pullRequests", after: string | null): Promise<HistoryDiscoveryPage>;
}

export class GitHubApiError extends HistoryError {
  constructor(public readonly status: number, public readonly rateLimited: boolean) {
    super(rateLimited ? "HISTORY_RATE_LIMIT" : status === 401 || status === 403 || status === 404
      ? "HISTORY_INACCESSIBLE" : "HISTORY_API", rateLimited
      ? "GitHub rate limit reached; sync was not committed"
      : `GitHub read request failed (HTTP ${status}); sync was not committed`);
  }
}

function graphQLFailure(value: unknown): GitHubApiError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const errors = (value as GraphQLResponse).errors;
  if (!Array.isArray(errors) || !errors.length) return undefined;
  const denied = errors.some((error) => error?.type === "FORBIDDEN" || error?.type === "NOT_FOUND" || error?.type === "UNAUTHORIZED");
  const rateLimited = !denied && errors.some((error) => error?.type === "RATE_LIMITED");
  return new GitHubApiError(denied ? 403 : rateLimited ? 429 : 502, rateLimited);
}

function restResponse(stdout: string): HistoryRestResponse {
  const boundary = /\r?\n\r?\n/.exec(stdout);
  if (!boundary) throw new HistoryError("HISTORY_API", "missing GitHub response headers");
  const headers = stdout.slice(0, boundary.index);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(headers)?.[1]);
  if (status !== 200 && status !== 304) throw new GitHubApiError(status || 502, status === 429);
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1].trim();
  if (etag && !/^[\x21-\x7e]{1,1024}$/.test(etag)) throw new HistoryError("HISTORY_API", "invalid GitHub response validator");
  return { status, etag, value: status === 304 ? undefined : JSON.parse(stdout.slice(boundary.index + boundary[0].length)) as unknown };
}

export function createGitHubApi(repository: string, cwd: string, signal?: AbortSignal): HistoryApi {
  const identity = parseRepositoryIdentity(repository);
  const [owner, name] = identity.nameWithOwner.split("/");
  const request = async (args: string[], headers = false): Promise<unknown> => {
    try {
      const { stdout } = await execFileAsync("gh", ["api", "--hostname", identity.hostname, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", ...args], {
        cwd, shell: false, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8",
        signal,
        env: { ...process.env, GH_HOST: identity.hostname, GH_PROMPT_DISABLED: "1", GH_DEBUG: undefined },
      });
      return headers ? restResponse(stdout) : JSON.parse(stdout) as unknown;
    } catch (error) {
      // Never forward gh stderr/stdout: these may include private data or credentials.
      if (error instanceof HistoryError) throw error;
      const failure = error as { stderr?: string; stdout?: string };
      if (args.includes("graphql") && failure.stdout) {
        let parsed: unknown;
        try { parsed = JSON.parse(failure.stdout); } catch { /* gh may emit no JSON on transport failures. */ }
        const classified = graphQLFailure(parsed);
        if (classified) throw classified;
      }
      const diagnostic = `${failure.stderr ?? ""} ${failure.stdout ?? ""}`;
      const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(failure.stdout ?? "")?.[1] ?? /HTTP (\d{3})/.exec(failure.stderr ?? "")?.[1]);
      const rateLimited = /rate limit|secondary rate|abuse detection/i.test(diagnostic);
      // A received known denial dominates a coincident cancellation; body text alone is not an HTTP status.
      if ([401, 403, 404].includes(status) && !rateLimited) throw new GitHubApiError(status, false);
      if (signal?.aborted) throw new HistoryError("HISTORY_CANCELLED", "manual history sync was cancelled; fetch staging retained");
      // gh exits nonzero for a valid conditional response; hydrate it like the successful GET path.
      if (headers && status === 304 && failure.stdout) return restResponse(failure.stdout);
      if (status) throw new GitHubApiError(status, rateLimited);
      throw new HistoryError("HISTORY_API", "GitHub read request failed; authentication, transport, or invalid response; sync was not committed");
    }
  };
  return {
    async access() {
      // Uncached capability/principal proof, not metadata-only access or replayed staged content.
      const query = "query($owner:String!,$name:String!){viewer{id}repository(owner:$owner,name:$name){databaseId nameWithOwner issues(first:1){nodes{id}}pullRequests(first:1){nodes{id}}}}";
      const response = await request(["--method", "POST", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`]) as GraphQLResponse;
      const classified = graphQLFailure(response);
      if (classified) throw classified;
      const repo = response.data?.repository;
      const principalId = response.data?.viewer?.id;
      if (!repo || !principalId || !Array.isArray(repo.issues?.nodes) || !Array.isArray(repo.pullRequests?.nodes)) throw new GitHubApiError(403, false);
      if (!Number.isSafeInteger(repo.databaseId) || !repo.nameWithOwner) throw new HistoryError("HISTORY_API", "invalid repository capability response");
      return { hostname: identity.hostname, repositoryId: String(repo.databaseId), repositoryName: repo.nameWithOwner, principalId };
    },
    async get(endpoint, etag) {
      const base = `repos/${identity.nameWithOwner}`;
      const [pathname, query, extra] = endpoint.split("?");
      const suffix = pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : "";
      const allowedPath = pathname === base
        || /^\/(?:issues|pulls)\/[1-9]\d*$/.test(suffix)
        || /^\/issues\/[1-9]\d*\/(?:comments|timeline)$/.test(suffix)
        || /^\/pulls\/[1-9]\d*\/(?:reviews|comments|files)$/.test(suffix);
      if (!allowedPath || extra !== undefined || query !== undefined && !/^(?:per_page=[1-9]\d*(?:&page=[1-9]\d*)?|page=[1-9]\d*(?:&per_page=[1-9]\d*)?)$/.test(query)) {
        throw new HistoryError("HISTORY_API", "refusing non-repository API endpoint");
      }
      if (etag && !/^[\x21-\x7e]{1,1024}$/.test(etag)) throw new HistoryError("HISTORY_STORAGE", "invalid cached response validator");
      const response = await request(["--method", "GET", "--include", ...(etag ? ["-H", `If-None-Match: ${etag}`] : []), endpoint], true) as HistoryRestResponse;
      return response.status === 304 ? response : { ...response, value: projectHistoryResponse(endpoint, response.value) };
    },
    async discover(kind, after) {
      // A fixed GraphQL QUERY over repository connections, never a mutation or search (no search1000 cap).
      const query = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){${kind}(first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number createdAt} pageInfo{endCursor hasNextPage}}}}`;
      const args = ["--method", "POST", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
      if (after !== null) args.push("-f", `after=${after}`);
      const response = await request(args) as GraphQLResponse;
      const classified = graphQLFailure(response);
      if (classified) throw classified;
      if (!response.data?.repository) throw new GitHubApiError(404, false);
      const connection = response.data.repository[kind];
      if (!connection || !Array.isArray(connection.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new HistoryError("HISTORY_API", "invalid discovery connection");
      const nodes = connection.nodes.map((node: unknown) => {
        if (!node || typeof node !== "object") throw new HistoryError("HISTORY_API", "invalid discovery node");
        const value = node as { number: number; createdAt: string };
        if (!Number.isSafeInteger(value.number) || value.number < 1 || !Number.isFinite(Date.parse(value.createdAt))) throw new HistoryError("HISTORY_API", "invalid discovery node");
        return { number: value.number, createdAt: value.createdAt };
      });
      return { nodes, endCursor: connection.pageInfo.endCursor ?? null, hasNextPage: connection.pageInfo.hasNextPage };
    },
  };
}

export function record(value: unknown): GitHubRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryError("HISTORY_API", "invalid GitHub object response");
  return value as GitHubRecord;
}

export async function allPages(api: HistoryApi, endpoint: string, maxItems?: number): Promise<GitHubRecord[]> {
  const records = new Map<string, GitHubRecord>();
  for (let page = 1; ; page++) {
    const fetched = await api.get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (fetched.status !== 200) throw new HistoryError("HISTORY_INCOMPLETE", "unresolved conditional pagination response");
    const response = fetched.value;
    if (!Array.isArray(response)) throw new HistoryError("HISTORY_API", "invalid GitHub pagination response");
    let added = 0;
    for (const item of response) {
      const value = record(item);
      const key = String(value.id ?? value.node_id ?? value.sha ?? value.filename ?? value.commit_id
        ?? (value.event === "cross-referenced" && value.source?.issue?.html_url && value.created_at
          ? `cross-referenced:${value.source.issue.html_url}:${value.created_at}` : ""));
      if (!key) throw new HistoryError("HISTORY_API", "paginated item has no stable identity");
      if (!records.has(key)) added++;
      records.set(key, value);
    }
    if (maxItems !== undefined && records.size >= maxItems) return [...records.values()];
    if (response.length < 100) return [...records.values()];
    if (added === 0) throw new HistoryError("HISTORY_INCOMPLETE", "GitHub pagination made no progress");
  }
}
