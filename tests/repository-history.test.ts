import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { HistoryRestResponse } from "../src/history/responses.js";
import { syncHistory } from "../src/history/service.js";
import { GitHubApiError, type HistoryApi, type HistoryDiscoveryPage } from "../src/history/github.js";
import { historyDirectory, readSnapshot, withHistoryLock } from "../src/history/storage.js";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "../src/tools/history-operations.js";

const roots: string[] = [];
const repository = "example/repository";
const timestamp = "2026-10-20T00:00:00Z";
const sha = "a".repeat(40);
function project(enabled = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocbi-new-history-test-"));
  roots.push(root);
  mkdirSync(path.join(root, ".codebase-index"));
  writeFileSync(path.join(root, ".codebase-index/config.json"), JSON.stringify({ embeddingProvider: "custom", customProvider: {}, repositoryHistory: { repositories: [{ repository, enabled }] } }));
  return { root, directory: historyDirectory(root, "codex", repository) };
}
interface FixtureIssue {
  id: number; number: number; title: string; body: string; state: string; user: { login: string };
  created_at: string; updated_at: string; pull_request?: object;
}
function issue(number: number, body = "original design rationale"): FixtureIssue {
  return { id: number, number, title: `Title ${number}`, body, state: "open", user: { login: "author" }, created_at: timestamp, updated_at: timestamp };
}
class FixtureApi implements HistoryApi {
  issues = new Map<number, FixtureIssue>([[1, issue(1)]]);
  comments: Record<string, unknown>[] = [];
  commentsByIssue = new Map<number, Record<string, unknown>[]>();
  reviews: Record<string, unknown>[] = [];
  reviewComments: Record<string, unknown>[] = [];
  files = [{ filename: "src/feature.ts" }];
  changedFiles = 1;
  commitCount = 1;
  headSha?: string;
  baseSha?: string;
  timeline: Record<string, unknown>[] = [{ event: "cross-referenced", created_at: timestamp, source: { issue: { html_url: "https://github.com/example/repository/issues/12" } } }];
  calls: string[] = [];
  fail?: string;
  revoked = false;
  repositoryId = 42;
  repositoryName = repository;
  mutate?: (endpoint: string) => void;
  pageSize = 100;
  principalId = "viewer-1";
  metadataOnly = false;
  accessCalls = 0;
  failAccessAt = 0;
  noEtags = false;
  responses: { endpoint: string; status: number; conditional?: string }[] = [];
  async access() {
    this.calls.push("access");
    this.accessCalls++;
    if (this.metadataOnly || this.revoked) throw new GitHubApiError(403, false);
    if (this.accessCalls === this.failAccessAt) throw new GitHubApiError(429, true);
    return { repositoryId: String(this.repositoryId), repositoryName: this.repositoryName, principalId: this.principalId };
  }
  async discover(kind: "issues" | "pullRequests", after: string | null): Promise<HistoryDiscoveryPage> {
    this.calls.push(`discover ${kind} ${after}`);
    if (this.revoked) throw new GitHubApiError(404, false);
    const values = [...this.issues.values()].filter((value) => Boolean(value.pull_request) === (kind === "pullRequests"));
    values.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
    const offset = Number(after ?? 0);
    const nodes = values.slice(offset, offset + this.pageSize).map((value) => ({ number: value.number, createdAt: value.created_at }));
    return { nodes, endCursor: String(offset + nodes.length), hasNextPage: offset + nodes.length < values.length };
  }
  async get(endpoint: string, conditional?: string): Promise<HistoryRestResponse> {
    this.calls.push(endpoint);
    this.mutate?.(endpoint);
    if (this.revoked) throw new GitHubApiError(404, false);
    if (this.fail && endpoint.includes(this.fail)) throw new GitHubApiError(429, true);
    const value = this.response(endpoint);
    const etag = this.noEtags ? undefined : `"${createHash("sha256").update(JSON.stringify(value)).digest("hex")}"`;
    const status = etag && etag === conditional ? 304 : 200;
    this.responses.push({ endpoint, status, conditional });
    return { status, etag, value: status === 304 ? undefined : value };
  }
  private response(endpoint: string): unknown {
    if (endpoint === `repos/${repository}`) return { id: this.repositoryId, full_name: this.repositoryName };
    if (endpoint.includes("/issues?")) return [...this.issues.values()].sort((a, b) => b.number - a.number).slice(0, 1);
    const number = Number(/\/(?:issues|pulls)\/(\d+)/.exec(endpoint)?.[1]);
    const collection = /\/(comments|timeline|reviews|files|commits)\?/.exec(endpoint)?.[1];
    if (collection) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      const items = collection === "comments" ? endpoint.includes("/pulls/") ? this.reviewComments : this.commentsByIssue.get(number) ?? this.comments
        : collection === "reviews" ? this.reviews : collection === "files" ? this.files
          : collection === "commits" ? [{ sha }] : this.timeline;
      return structuredClone(items.slice((page - 1) * 100, page * 100));
    }
    if (endpoint.includes("/pulls/")) return { ...this.issues.get(number), merged_at: timestamp, merge_commit_sha: sha, changed_files: this.changedFiles, commits: this.commitCount, head: { sha: this.headSha }, base: { sha: this.baseSha } };
    if (!this.issues.has(number)) throw new GitHubApiError(404, false);
    return structuredClone(this.issues.get(number));
  }
}
function comment(id: number, body: string) { return { id, body, user: { login: "reviewer" }, created_at: timestamp, updated_at: timestamp }; }
const source = { repository, enabled: true };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("local GitHub history", () => {
  it("paginates comments, indexes reviews and provenance with exact independent citations, and is idempotent", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1), pull_request: {} });
    api.comments = Array.from({ length: 102 }, (_, index) => comment(index + 20, index === 101 ? "paginated rationale" : "discussion"));
    api.reviews = [comment(600, "review rationale")];
    api.reviewComments = [comment(700, "inline rationale")];
    const first = await syncHistory(source, directory, api);
    expect(first.complete).toBe(true);
    expect(api.calls).toContain(`repos/${repository}/issues/1/comments?per_page=100&page=2`);
    const results = await runRepositoryHistorySearch({ query: "review", state: "merged" }, root, "codex");
    expect(results.results[0].documentUrl).toBe("https://github.com/example/repository/pull/1#pullrequestreview-600");
    for (const [query, documentUrl] of [
      ["original", "https://github.com/example/repository/pull/1"],
      ["paginated", "https://github.com/example/repository/pull/1#issuecomment-121"],
      ["inline", "https://github.com/example/repository/pull/1#discussion_r700"],
    ]) expect((await runRepositoryHistorySearch({ query, state: "merged" }, root, "codex")).results[0].documentUrl).toBe(documentUrl);
    expect(results.results[0]).toMatchObject({ state: "merged", mergeCommitSha: sha, files: ["src/feature.ts"], linkedIssues: ["https://github.com/example/repository/issues/12"], commits: [sha] });
    expect(results.authoritative).toBe(false);
    const second = await syncHistory(source, directory, api);
    expect(second.entities).toEqual(first.entities);
    expect((await runRepositoryHistorySearch({ query: "review", state: "merged" }, root, "codex")).results).toEqual(results.results);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(directory, "snapshot.json")).mode & 0o777).toBe(0o600);
  });

  it("reconciles edited and deleted discussions without updatedAt changes, and deleted entities", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1), pull_request: {} });
    api.comments = [comment(10, "retiredneedle"), comment(11, "unchanged")];
    await syncHistory(source, directory, api);
    api.comments = [comment(11, "replacementneedle")];
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "retiredneedle" }, root, "codex")).results).toEqual([]);
    expect((await runRepositoryHistorySearch({ query: "replacementneedle" }, root, "codex")).results[0].documentUrl).toContain("#issuecomment-11");
    api.issues.delete(1);
    expect((await syncHistory(source, directory, api)).removedEntities).toBe(1);
    expect((await runRepositoryHistoryStatus({}, root, "codex")).entityCount).toBe(0);
  });

  it("never commits a partial cursor and retains explicit stale-cache errors on rate limits", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    const before = await syncHistory(source, directory, api);
    api.issues.set(2, issue(2, "newneedle"));
    api.fail = "/issues/1/comments";
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    const failed = readSnapshot(directory, repository)!;
    expect(failed.cursor).toBe(before.cursor);
    expect(failed.maxNumber).toBe(before.maxNumber);
    expect(failed.entities).toEqual(before.entities);
    expect((await runRepositoryHistoryStatus({}, root, "codex")).status).toBe("error");
    api.fail = undefined;
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "newneedle" }, root, "codex")).results[0].number).toBe(2);
  });

  it("fails closed on detected access loss, and recovers the complete cache after access returns", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    await syncHistory(source, directory, api);
    api.revoked = true;
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect(readFileSync(path.join(directory, "snapshot.json"), "utf8")).not.toContain("original design rationale");
    api.revoked = false;
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toHaveLength(1);
  });

  it("disabled sync/search neither initializes storage nor leaks existing content, but clear remains usable", async () => {
    const { root, directory } = project(false);
    expect((await runRepositoryHistorySync({}, root, "codex")).status).toBe("disabled");
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect(() => statSync(directory)).toThrow();
    await syncHistory(source, directory, new FixtureApi());
    const failed = new FixtureApi();
    failed.fail = "/timeline?";
    await expect(syncHistory(source, directory, failed)).rejects.toThrow("HISTORY_RATE_LIMIT");
    expect(statSync(path.join(directory, "fetch-staging")).isDirectory()).toBe(true);
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect((await runRepositoryHistoryClear({}, root, "codex")).cleared).toBe(true);
    expect(readSnapshot(directory, repository)).toBeUndefined();
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
  });

  it("keeps project/source/host storage and filters isolated", async () => {
    const { root, directory } = project();
    const other = project();
    const api = new FixtureApi();
    api.comments = [comment(10, "reviewerneedle rationale")];
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "rationale", author: "reviewer", kind: "issue" }, root, "codex")).results).toHaveLength(1);
    expect((await runRepositoryHistorySearch({ query: "rationale", state: "closed" }, root, "codex")).results).toEqual([]);
    expect((await runRepositoryHistorySearch({ query: "rationale" }, other.root, "codex")).results).toEqual([]);
    expect((await runRepositoryHistorySearch({ query: "rationale", repository: "other/repo" }, root, "codex")).status).toBe("disabled");
    expect((await runRepositoryHistoryStatus({}, root, "opencode")).status).toBe("disabled");
    expect(historyDirectory(root, "opencode", repository)).not.toBe(directory);
  });

  it("rejects concurrent mutations without damaging the published snapshot", async () => {
    const { root, directory } = project();
    await syncHistory(source, directory, new FixtureApi());
    await withHistoryLock(directory, "index", async () => {
      await expect(runRepositoryHistoryClear({}, root, "codex")).rejects.toThrow();
      expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toHaveLength(1);
    });
    await runRepositoryHistoryClear({}, root, "codex");
    expect((await runRepositoryHistoryStatus({}, root, "codex")).status).toBe("empty");
  });

  it("resumes quota-interrupted pages and catches same-second/new-number updates in the next complete sweep", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    const first = await syncHistory(source, directory, api);
    api.comments = Array.from({ length: 101 }, (_, index) => comment(index + 10, "before"));
    api.fail = "comments?per_page=100&page=2";
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    expect(readSnapshot(directory, repository)!.cursor).toBe(first.cursor);
    const pageOneRequests = api.calls.filter((endpoint) => endpoint.includes("comments?per_page=100&page=1")).length;
    api.fail = undefined;
    await syncHistory(source, directory, api);
    expect(api.calls.filter((endpoint) => endpoint.includes("comments?per_page=100&page=1"))).toHaveLength(pageOneRequests);
    api.issues.set(1, issue(1, "same-second edit"));
    api.issues.set(2, issue(2, "created while syncing"));
    const final = await syncHistory(source, directory, api);
    expect(final.entities.map((entity) => entity.number)).toEqual([1, 2]);
    expect(final.entities[0].documents[0].body).toBe("same-second edit");
    expect(final.entities[0].documents).toHaveLength(102);
  });

  it("uses an explicit initial created-at window without silently narrowing later syncs", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    api.issues.set(2, { ...issue(2), created_at: "2026-10-22T00:00:00Z" });
    const result = await syncHistory(source, directory, api, "2026-10-21");
    expect(result.entities.map((entity) => entity.number)).toEqual([2]);
    expect(result.initialSince).toBe("2026-10-21T00:00:00.000Z");
    await expect(syncHistory(source, directory, api, "2026-10-01")).rejects.toThrow("clear before changing");
  });

  it("filters every cursor page rather than assuming createdAt follows issue number", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    api.pageSize = 1;
    api.issues.set(1, { ...issue(1), created_at: "2026-10-22T00:00:00Z" });
    api.issues.set(200, { ...issue(200), created_at: "2020-01-01T00:00:00Z" });
    api.issues.set(12, { ...issue(12), created_at: "2026-10-23T00:00:00Z" });
    const result = await syncHistory(source, directory, api, "2026-10-21");
    expect(result.entities.map((entity) => entity.number)).toEqual([1, 12]);
    expect(api.calls).toContain("discover issues 2");
    expect(result.maxNumber).toBe(200);
  });

  it("binds resumed and published private evidence to immutable repository identity", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    const old = await syncHistory(source, directory, api);
    api.fail = "/timeline?";
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    api.repositoryId = 999;
    api.fail = undefined;
    api.issues.set(1, issue(1, "replacementrepositoryneedle"));
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect(readSnapshot(directory, repository)!.cursor).toBe(old.cursor);
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect((await runRepositoryHistorySearch({ query: "replacementrepositoryneedle" }, root, "codex")).results).toHaveLength(1);
  });

  it("rejects identity changes during fetching before any staged content can be published", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    let probes = 0;
    api.mutate = (endpoint) => { if (endpoint === `repos/${repository}` && ++probes === 2) api.repositoryId = 999; };
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect(readSnapshot(directory, repository)!.cursor).toBeUndefined();
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
  });

  it("never publishes after host cancellation and preserves resumable progress", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    const before = await syncHistory(source, directory, api);
    const controller = new AbortController();
    api.mutate = (endpoint) => { if (endpoint.includes("/comments?")) controller.abort(); };
    await expect(syncHistory(source, directory, api, undefined, { signal: controller.signal })).rejects.toThrow("HISTORY_CANCELLED");
    expect(readSnapshot(directory, repository)!.cursor).toBe(before.cursor);
    expect(readSnapshot(directory, repository)!.entities).toEqual(before.entities);
    expect(statSync(path.join(directory, "fetch-staging")).isDirectory()).toBe(true);
    api.mutate = undefined;
    expect((await syncHistory(source, directory, api)).complete).toBe(true);
  });

  it.each([null, "repeated"])("rejects a missing or repeated discovery cursor (%s) without claiming completion", async (cursor) => {
    const { directory } = project();
    const api = new FixtureApi();
    api.discover = async () => ({ nodes: [{ number: 1, createdAt: timestamp }], hasNextPage: true, endCursor: cursor });
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INCOMPLETE");
    expect(readSnapshot(directory, repository)!.cursor).toBeUndefined();
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
  });

  it("keeps published snapshots and private fetch staging out of ordinary Git adds", async () => {
    const { root, directory } = project();
    execFileSync("git", ["init", "--quiet", root]);
    const api = new FixtureApi();
    await syncHistory(source, directory, api);
    api.fail = "/timeline?";
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    const staging = path.join(directory, "fetch-staging");
    const checkpoint = path.join(staging, readdirSync(staging).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!);
    const snapshot = path.join(directory, "snapshot.json");
    const ignored = execFileSync("git", ["check-ignore", "--no-index", snapshot, checkpoint], { cwd: root, encoding: "utf8" }).trim().split("\n");
    expect(ignored).toEqual([snapshot, checkpoint]);
  });

  it("rejects symlinked host/config ancestors instead of inheriting opt-in or escaping project storage", async () => {
    const { root } = project();
    const other = project();
    rmSync(path.join(root, ".codebase-index"), { recursive: true });
    symlinkSync(path.join(other.root, ".codebase-index"), path.join(root, ".codebase-index"), "dir");
    await expect(runRepositoryHistorySync({}, root, "codex")).rejects.toThrow("symlinks");
    await expect(runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).rejects.toThrow("symlinks");
    await expect(runRepositoryHistoryStatus({}, root, "codex")).rejects.toThrow("symlinks");
    expect(() => historyDirectory(root, "codex", repository)).toThrow("symlinks");
    expect(() => statSync(path.dirname(other.directory))).toThrow();
  });

  it("indexes large-PR discussions while explicitly labeling capped file references and linked-only commit provenance", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1), pull_request: {} });
    api.files = Array.from({ length: 3000 }, (_, index) => ({ filename: `src/file-${index}.ts` }));
    api.changedFiles = 4000;
    api.commitCount = 500;
    api.headSha = "b".repeat(40);
    api.baseSha = "c".repeat(40);
    expect((await syncHistory(source, directory, api)).complete).toBe(true);
    const result = await runRepositoryHistorySearch({ query: "rationale" }, root, "codex");
    expect(result.incompleteFileReferenceEntities).toBe(1);
    expect(result.results[0]).toMatchObject({ fileReferencesComplete: false, totalChangedFiles: 4000, commitReferenceScope: "linked" });
    expect(result.results[0].files).toHaveLength(3000);
    expect(result.results[0].commits).toEqual([api.headSha, api.baseSha, sha]);
    expect(api.calls.some((endpoint) => endpoint.includes("/commits?"))).toBe(false);
    expect(api.calls.some((endpoint) => endpoint.endsWith("/files?per_page=100&page=31"))).toBe(false);
  });

  it("freshly proves issue/PR capabilities before replaying a fully staged sync under narrowed credentials", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    const before = await syncHistory(source, directory, api);
    api.failAccessAt = api.accessCalls + 2;
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    expect(statSync(path.join(directory, "fetch-staging")).isDirectory()).toBe(true);
    const calls = api.calls.length;
    api.metadataOnly = true;
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect(api.calls.slice(calls)).toEqual([`repos/${repository}`, "access"]);
    expect(readSnapshot(directory, repository)!.cursor).toBe(before.cursor);
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
  });

  it("binds staged/published evidence to the public authenticated principal, never a stored token", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    await syncHistory(source, directory, api);
    api.principalId = "viewer-2";
    api.issues.set(1, issue(1, "newprincipalneedle"));
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results).toEqual([]);
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "newprincipalneedle" }, root, "codex")).results).toHaveLength(1);
    expect(readSnapshot(directory, repository)!.principalId).toBe("viewer-2");
  });

  it("retains committed timeline SHAs and cross-reference events that legitimately have no event ID", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    api.timeline.push({ event: "committed", sha });
    const result = await syncHistory(source, directory, api);
    expect(result.entities[0].linkedIssues).toEqual(["https://github.com/example/repository/issues/12"]);
    expect(result.entities[0].commits).toEqual([sha]);
  });

  it("finds a cited entity by issue/PR number without a numeric self-reference in its text", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.clear();
    api.issues.set(42, { ...issue(42), title: "Design discussion", body: "A rationale without a numeric self-reference." });
    api.issues.set(43, { ...issue(43), title: "Other discussion", body: "Unrelated content." });
    await syncHistory(source, directory, api);
    const result = await runRepositoryHistorySearch({ query: "#42" }, root, "codex");
    expect(result.results.map((hit) => hit.number)).toEqual([42]);
    expect(result.results[0].documentUrl).toBe("https://github.com/example/repository/issues/42");
  });

  it("normalizes own-repository reference casing to canonical URLs without duplicate links", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    api.repositoryName = "Example/Repository";
    api.issues.set(1, issue(1, "See #12 and https://github.com/EXAMPLE/REPOSITORY/issues/12"));
    const result = await syncHistory(source, directory, api);
    expect(result.entities[0].url).toBe("https://github.com/Example/Repository/issues/1");
    expect(result.entities[0].linkedIssues).toEqual(["https://github.com/Example/Repository/issues/12"]);
  });
});

describe("history repair behavior", () => {
  it("revalidates later pages when the first page is unchanged and reconciles tail edits/deletions", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.comments = Array.from({ length: 102 }, (_, index) => comment(1000 + index, index === 100 ? "deletedtailneedle" : "unchanged discussion"));
    await syncHistory(source, directory, api);
    api.comments.splice(100, 1);
    api.comments[100] = comment(1101, "lateeditedneedle");
    api.responses = [];
    await syncHistory(source, directory, api);
    expect(api.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: `repos/${repository}/issues/1/comments?per_page=100&page=1`, status: 304 }),
      expect.objectContaining({ endpoint: `repos/${repository}/issues/1/comments?per_page=100&page=2`, status: 200 }),
    ]));
    expect((await runRepositoryHistorySearch({ query: "deletedtailneedle" }, root, "codex")).results).toEqual([]);
    expect((await runRepositoryHistorySearch({ query: "lateeditedneedle" }, root, "codex")).results[0].documentUrl).toBe(`https://github.com/${repository}/issues/1#issuecomment-1101`);
  });

  it("follows a growing tail beyond a formerly terminal page after a first-page304", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.comments = Array.from({ length: 100 }, (_, index) => comment(index + 10, "stable first page"));
    await syncHistory(source, directory, api);
    api.comments.push(...Array.from({ length: 101 }, (_, index) => comment(index + 2000, index === 100 ? "tailgrowthneedle" : "new tail discussion")));
    api.responses = [];
    await syncHistory(source, directory, api);
    expect(api.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: `repos/${repository}/issues/1/comments?per_page=100&page=1`, status: 304 }),
      expect.objectContaining({ endpoint: `repos/${repository}/issues/1/comments?per_page=100&page=2`, status: 200 }),
      expect.objectContaining({ endpoint: `repos/${repository}/issues/1/comments?per_page=100&page=3`, status: 200 }),
    ]));
    expect((await runRepositoryHistorySearch({ query: "tailgrowthneedle" }, root, "codex")).results[0].documentUrl).toContain("#issuecomment-2100");
    api.comments.splice(150);
    await syncHistory(source, directory, api);
    expect((await runRepositoryHistorySearch({ query: "tailgrowthneedle" }, root, "codex")).results).toEqual([]);
    expect(readSnapshot(directory, repository)!.httpCache).not.toHaveProperty(`repos/${repository}/issues/1/comments?per_page=100&page=3`);
  });

  it("drops a validator when a fresh200 omits ETag rather than reusing a stale condition", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    await syncHistory(source, directory, api);
    api.noEtags = true;
    await syncHistory(source, directory, api);
    expect(Object.values(readSnapshot(directory, repository)!.httpCache!).every((entry) => entry.etag === undefined)).toBe(true);
    api.responses = [];
    const result = await syncHistory(source, directory, api);
    expect(result.entities[0].documents[0].body).toBe("original design rationale");
    expect(api.responses.every((response) => response.conditional === undefined)).toBe(true);
  });

  it("hydrates conditional bodies from the published snapshot and refetches dangling representations", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.comments = [comment(55, "cachedbodyneedle")];
    await syncHistory(source, directory, api);
    const file = path.join(directory, "snapshot.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    const endpoint = `repos/${repository}/issues/1/comments?per_page=100&page=1`;
    expect(JSON.stringify(snapshot.httpCache)).not.toContain("cachedbodyneedle");
    snapshot.httpCache[endpoint].value[0].body.historyDocument = "999:comment:55";
    writeFileSync(file, JSON.stringify(snapshot));
    api.responses = [];
    await syncHistory(source, directory, api);
    expect(api.responses).toContainEqual({ endpoint, status: 200, conditional: undefined });
    expect((await runRepositoryHistorySearch({ query: "cachedbodyneedle" }, root, "codex")).results[0].documentUrl).toContain("#issuecomment-55");
    const before = readSnapshot(directory, repository)!.cursor;
    const get = api.get.bind(api);
    api.get = async (url, conditional) => url === endpoint ? { status: 304, etag: "\"unbound\"" } : get(url, conditional);
    const invalid = JSON.parse(readFileSync(file, "utf8"));
    delete invalid.httpCache[endpoint];
    writeFileSync(file, JSON.stringify(invalid));
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INCOMPLETE");
    expect(readSnapshot(directory, repository)!.cursor).toBe(before);
  });

  it("preserves pending review page membership without persisting bodies or dangling body references", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1), pull_request: {}, state: "closed" });
    api.reviews = Array.from({ length: 100 }, (_, id) => ({ id: id + 1000, state: "PENDING", body: "unsubmittedprivatecanary" }));
    api.reviews.push({ id: 600, state: "APPROVED", body: "submittedonlyneedle", submitted_at: timestamp, user: { login: "reviewer" } });
    await syncHistory(source, directory, api);
    expect(readFileSync(path.join(directory, "snapshot.json"), "utf8")).not.toContain("unsubmittedprivatecanary");
    api.responses = [];
    await syncHistory(source, directory, api);
    expect(api.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpoint: `repos/${repository}/pulls/1/reviews?per_page=100&page=1`, status: 304 }),
      expect.objectContaining({ endpoint: `repos/${repository}/pulls/1/reviews?per_page=100&page=2`, status: 304 }),
    ]));
    const result = (await runRepositoryHistorySearch({ query: "submittedonlyneedle" }, root, "codex")).results[0];
    expect(result).toMatchObject({ documentUrl: `https://github.com/${repository}/pull/1#pullrequestreview-600`, updatedAt: null, timestampProvenance: { createdAt: "submitted_at", updatedAt: "unavailable" } });
  });

  it("projects foreign timeline bodies out of unfinished checkpoints before any publication", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1), pull_request: {} });
    api.timeline = [{ event: "cross-referenced", created_at: timestamp, source: { issue: { html_url: "https://github.com/unconfigured/private/issues/99", title: "foreign title canary", body: "foreignbodymustnotpersist" } } }];
    api.fail = "/reviews?";
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    const staging = path.join(directory, "fetch-staging");
    const persisted = readdirSync(staging).map((name) => readFileSync(path.join(staging, name), "utf8")).join("\n");
    expect(persisted).toContain("https://github.com/unconfigured/private/issues/99");
    expect(persisted).not.toContain("foreignbodymustnotpersist");
    expect(persisted).not.toContain("foreign title canary");
    api.fail = undefined;
    const result = await syncHistory(source, directory, api);
    expect(result.entities[0].linkedIssues).toEqual(["https://github.com/unconfigured/private/issues/99"]);
  });

  it.each(["status", "search"] as const)("retires old raw staging under lease on enabled %s without deleting published history", async (operation) => {
    const { root, directory } = project();
    const api = new FixtureApi();
    const before = await syncHistory(source, directory, api);
    const staging = path.join(directory, "fetch-staging");
    mkdirSync(staging);
    writeFileSync(path.join(staging, "metadata.json"), JSON.stringify({ startedAt: timestamp, repositoryId: "42", principalId: "viewer-1" }));
    writeFileSync(path.join(staging, "raw.json"), "foreignlegacybody");
    if (operation === "status") expect((await runRepositoryHistoryStatus({}, root, "codex")).status).toBe("ready");
    else expect((await runRepositoryHistorySearch({ query: "rationale" }, root, "codex")).results[0].url).toBe(`https://github.com/${repository}/issues/1`);
    expect(() => statSync(staging)).toThrow();
    expect(readSnapshot(directory, repository)!.cursor).toBe(before.cursor);
  });

  it("does not retire an active writer's old stage while its history lease is held", async () => {
    const { root, directory } = project();
    await syncHistory(source, directory, new FixtureApi());
    const staging = path.join(directory, "fetch-staging");
    await withHistoryLock(directory, "index", async () => {
      mkdirSync(staging);
      writeFileSync(path.join(staging, "metadata.json"), "{}");
      writeFileSync(path.join(staging, "raw.json"), "still-owned");
      await expect(runRepositoryHistoryStatus({}, root, "codex")).rejects.toThrow("HISTORY_BUSY");
      expect(readFileSync(path.join(staging, "raw.json"), "utf8")).toBe("still-owned");
    });
    await runRepositoryHistoryStatus({}, root, "codex");
    expect(() => statSync(staging)).toThrow();
  });

  it("purges projected validator representations and unfinished bodies on detected access loss and clear", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, issue(1, "privatecachecanary"));
    await syncHistory(source, directory, api);
    expect(Object.keys(readSnapshot(directory, repository)!.httpCache!).length).toBeGreaterThan(0);
    api.fail = "/timeline?";
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    api.revoked = true;
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect(readSnapshot(directory, repository)!.httpCache).toEqual({});
    expect(readFileSync(path.join(directory, "snapshot.json"), "utf8")).not.toContain("privatecachecanary");
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
    await runRepositoryHistoryClear({ repository }, root, "codex");
    expect(() => statSync(path.join(directory, "snapshot.json"))).toThrow();
  });

  it.each([undefined, "2026-10-01T00:00:00.000Z"])("keeps the configured baseline distinct from an initial CLI override (%s)", async (initialSince) => {
    const { directory } = project();
    const configured = { ...source, initialSince };
    const api = new FixtureApi();
    api.issues.set(2, { ...issue(2), created_at: "2026-10-22T00:00:00Z" });
    const first = await syncHistory(configured, directory, api, "2026-10-21");
    expect(first.entities.map((entity) => entity.number)).toEqual([2]);
    expect((await syncHistory(configured, directory, api)).entities.map((entity) => entity.number)).toEqual([2]);
    const calls = api.calls.length;
    const published = readFileSync(path.join(directory, "snapshot.json"), "utf8");
    await expect(syncHistory({ ...configured, initialSince: "2026-10-25T00:00:00.000Z" }, directory, api)).rejects.toThrow("clear history before changing");
    expect(api.calls).toHaveLength(calls);
    expect(readFileSync(path.join(directory, "snapshot.json"), "utf8")).toBe(published);
    if (initialSince) await expect(syncHistory(source, directory, api)).rejects.toThrow("clear history before changing");
  });

  it("recovers an initial CLI bound from projected staging after cancellation without publishing a conflicting error snapshot", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    api.issues.set(2, { ...issue(2), created_at: "2026-10-22T00:00:00Z" });
    const controller = new AbortController();
    api.mutate = (endpoint) => { if (endpoint.includes("/timeline?")) controller.abort(); };
    await expect(syncHistory(source, directory, api, "2026-10-21", { signal: controller.signal })).rejects.toThrow("HISTORY_CANCELLED");
    expect(() => statSync(path.join(directory, "snapshot.json"))).toThrow();
    const calls = api.calls.length;
    await expect(syncHistory({ ...source, initialSince: "2026-10-25T00:00:00.000Z" }, directory, api)).rejects.toThrow("clear history before changing");
    expect(api.calls).toHaveLength(calls);
    expect(() => statSync(path.join(directory, "snapshot.json"))).toThrow();
    api.mutate = undefined;
    const resumed = await syncHistory(source, directory, api);
    expect(resumed.initialSince).toBe("2026-10-21T00:00:00.000Z");
    expect(resumed.entities.map((entity) => entity.number)).toEqual([2]);
  });

  it("retires an already-committed leftover stage instead of replaying it as a new refresh", async () => {
    const { directory } = project();
    const api = new FixtureApi();
    const staging = path.join(directory, "fetch-staging");
    let probes = 0;
    let saved: [string, string][] = [];
    api.mutate = (endpoint) => {
      if (endpoint === `repos/${repository}` && ++probes === 2) saved = readdirSync(staging).map((name) => [name, readFileSync(path.join(staging, name), "utf8")]);
    };
    const before = await syncHistory(source, directory, api);
    mkdirSync(staging);
    for (const [name, content] of saved) writeFileSync(path.join(staging, name), content);
    api.mutate = undefined;
    api.issues.set(1, issue(1, "freshaftercommittedcleanupneedle"));
    const after = await syncHistory(source, directory, api);
    expect(after.syncGeneration).not.toBe(before.syncGeneration);
    expect(after.entities[0].documents[0].body).toBe("freshaftercommittedcleanupneedle");
    expect(() => statSync(staging)).toThrow();
  });

  it("returns honest unknown review edit time while refreshing edited review content", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1), pull_request: {} });
    api.reviews = [{ id: 600, state: "COMMENTED", submitted_at: timestamp, body: "original review", user: { login: "reviewer" } }];
    await syncHistory(source, directory, api);
    api.reviews[0].body = "editedreviewneedle";
    await syncHistory(source, directory, api);
    const hit = (await runRepositoryHistorySearch({ query: "editedreviewneedle" }, root, "codex")).results[0];
    expect(hit).toMatchObject({ updatedAt: null, createdAt: timestamp, timestampProvenance: { createdAt: "submitted_at", updatedAt: "unavailable" } });
    expect((await runRepositoryHistorySearch({ query: "editedreviewneedle" }, root, "codex")).results).toEqual([hit]);
  });

  it("migrates legacy cached lexical content locally before the first short-token query, preserving cursor and timestamp provenance", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.set(1, { ...issue(1, "CI verifies S3 objects before cache reuse"), title: "CI cache regression with S3", pull_request: {} });
    api.reviews = [{ id: 600, state: "COMMENTED", submitted_at: timestamp, body: "reviewmigrationneedle", user: { login: "reviewer" } }];
    const current = await syncHistory(source, directory, api);
    const { InvertedIndex } = await import("../src/native/inverted-index.js");
    const legacy = new InvertedIndex(directory);
    for (const entity of current.entities) for (const doc of entity.documents) legacy.addChunk(`${entity.number}:${doc.id}`, `${entity.title}\n${doc.body}`);
    writeFileSync(path.join(directory, "snapshot.json"), JSON.stringify({ ...current, version: 1, lexical: legacy.serialize(), lexicalVersion: undefined, configuredInitialSince: undefined, httpCache: undefined, httpCacheVersion: undefined,
      entities: current.entities.map((entity) => ({ ...entity, documents: entity.documents.map(({ timestampProvenance: _provenance, ...doc }) => ({ ...doc, updatedAt: doc.updatedAt ?? doc.createdAt })) })) }));
    expect((await runRepositoryHistoryStatus({}, root, "codex")).lexicalRebuildRequired).toBe(true);
    const bin = path.join(root, "no-network");
    mkdirSync(bin);
    const sentinel = path.join(root, "unexpected-network");
    writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "called"); process.exit(99);\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      for (const query of ["CI", "S3"]) expect((await runRepositoryHistorySearch({ query }, root, "codex")).results[0].url).toBe(`https://github.com/${repository}/pull/1`);
      const review = (await runRepositoryHistorySearch({ query: "reviewmigrationneedle" }, root, "codex")).results[0];
      expect(review).toMatchObject({ updatedAt: null, timestampProvenance: { createdAt: "legacy", updatedAt: "unavailable" } });
      expect(() => statSync(sentinel)).toThrow();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const migrated = readSnapshot(directory, repository)!;
    expect(migrated.cursor).toBe(current.cursor);
    expect(migrated.lastSyncedAt).toBe(current.lastSyncedAt);
    expect((await runRepositoryHistoryStatus({}, root, "codex")).lexicalRebuildRequired).toBe(false);
  });

  it("diversifies entities, prioritizes exact identity/primary descriptions, and excerpts a late whole-token rationale", async () => {
    const { root, directory } = project();
    const api = new FixtureApi();
    api.issues.clear();
    const context = [
      "Deployment context: operators retain the existing command surface and can roll back configuration independently of the binary. This avoids coupling a diagnostic setting to the release train.",
      "Compatibility: integrations may still run older clients during rollout. The server accepts their read-only requests and reports local cache freshness separately from live remote authorization.",
      "Ownership: each service has an on-call engineer and a documented escalation path. Scheduled releases should not require a second person to watch a terminal continuously.",
      "Testing: isolated fixtures cover interrupted requests, source permissions, file-reference limits, and project boundaries. The suite does not contact the network or rewrite expected historical data.",
      "Operations: background jobs are not introduced. A user starts each synchronization explicitly and can inspect unfinished progress before choosing whether to continue or clear local data.",
      "Storage: source records and provenance remain private to the current project. Atomic publication protects readers from partial local snapshots while remote pagination remains a fetch window.",
      "Rollout: package identities use the same implementation. Documentation should call out any incompatibility explicitly rather than asking operators to infer changed behavior from release notes.",
    ].join("\n\n");
    api.issues.set(42, { ...issue(42, `${context}\n\nDecision: the deadline is twenty seconds because upstream hangs otherwise retain a slot forever. We intentionally avoid an exponential retry chain.`), title: "Explain the retry timeout", user: { login: "architect" }, pull_request: {}, state: "closed" });
    api.commentsByIssue.set(42, Array.from({ length: 12 }, (_, index) => ({ ...comment(4200 + index, index % 2 ? "LGTM." : "Thanks!"), user: { login: "participant" } })));
    api.issues.set(35, { ...issue(35, "Update the command reference after the policy ships."), title: "Retry timeout follow-up" });
    api.issues.set(73, { ...issue(73, "Rollout complete. Install this release and monitor failures."), title: "Retry timeout release checklist" });
    api.issues.set(88, { ...issue(88, "Help examples repeat #42: search '#42'; search '#42' --state merged; search '#42' --limit 1; search '#42' --author reviewer. These are examples, not the source discussion."), title: "Document the #42 example" });
    api.issues.set(66, { ...issue(66, "CI verifies S3 objects before cache reuse."), title: "CI cache regression with S3" });
    await syncHistory(source, directory, api);
    for (const query of ["CI", "S3"]) expect((await runRepositoryHistorySearch({ query }, root, "codex")).results[0].number).toBe(66);
    const broad = (await runRepositoryHistorySearch({ query: "retry timeout" }, root, "codex")).results;
    expect(broad.map((hit) => hit.number)).toEqual(expect.arrayContaining([42, 35, 73]));
    expect(broad.find((hit) => hit.number === 42)!.documentKind).toBe("body");
    expect(broad.every((hit) => hit.documentKind === "body")).toBe(true);
    const exact = (await runRepositoryHistorySearch({ query: "#42" }, root, "codex")).results[0];
    expect(exact).toMatchObject({ number: 42, documentKind: "body", url: `https://github.com/${repository}/pull/42` });
    const excerpt = (await runRepositoryHistorySearch({ query: "the deadline", author: "architect" }, root, "codex")).results[0];
    expect(excerpt.excerpt).toContain("upstream hangs");
    expect(excerpt.excerpt).toContain("twenty seconds");
    expect(excerpt.excerpt).not.toContain("Deployment context:");
    expect((await runRepositoryHistorySearch({ query: "retry timeout", state: "open" }, root, "codex")).results.map((hit) => hit.number)).not.toContain(42);
    expect((await runRepositoryHistorySearch({ query: "retry timeout", author: "architect" }, root, "codex")).results.map((hit) => hit.number)).toEqual([42]);
  });
});

it("preserves exact permalink fragments across canonical host/repository case and keeps direct descriptions at their prefix", async () => {
  const { root, directory } = project();
  const api = new FixtureApi();
  api.issues.clear();
  api.issues.set(42, { ...issue(42, "Primary description: decision context and operator guidance. ".repeat(30) + "Footer reference #42"), title: "Identifier lookup" });
  api.comments = [comment(55, "Permalink source begins with the actual reviewer explanation.")];
  await syncHistory(source, directory, api);
  for (const query of ["#42", "HTTPS://GITHUB.COM/EXAMPLE/REPOSITORY/issues/42"]) {
    const result = (await runRepositoryHistorySearch({ query }, root, "codex")).results[0];
    expect(result.documentKind).toBe("body");
    expect(result.excerpt.startsWith("Primary description:")).toBe(true);
    expect(result.excerpt).not.toContain("Footer reference");
  }
  const permalink = (await runRepositoryHistorySearch({ query: "HTTPS://GITHUB.COM/EXAMPLE/REPOSITORY/issues/42#issuecomment-55" }, root, "codex")).results[0];
  expect(permalink.documentUrl).toBe(`https://github.com/${repository}/issues/42#issuecomment-55`);
  expect(permalink.excerpt).toBe("Permalink source begins with the actual reviewer explanation.");
});

it("clears orphan preparations from a released lease without touching active writers or unrelated files", async () => {
  const { root, directory } = project(false);
  const { createLeaseTemporaryPath } = await import("../src/indexer/index-lock.js");
  let orphan = "";
  await withHistoryLock(directory, "index", async (lease) => {
    orphan = createLeaseTemporaryPath(path.join(directory, "snapshot.json"), lease.owner);
    writeFileSync(orphan, "orphanprivatecanary", { mode: 0o600 });
    writeFileSync(path.join(directory, "user-note.txt"), "unrelated");
    await expect(runRepositoryHistoryClear({ repository }, root, "codex")).rejects.toThrow("HISTORY_BUSY");
    expect(readFileSync(orphan, "utf8")).toBe("orphanprivatecanary");
  });
  expect((await runRepositoryHistoryClear({ repository }, root, "codex")).cleared).toBe(true);
  expect(() => statSync(orphan)).toThrow();
  expect(readFileSync(path.join(directory, "user-note.txt"), "utf8")).toBe("unrelated");
});

it("aligns an excerpt to include complete matching tokens when their span fits the source window", async () => {
  const { root, directory } = project();
  const api = new FixtureApi();
  const body = " ".repeat(100) + "alpha" + " ".repeat(694) + "deadline with source context";
  api.issues.set(1, issue(1, body));
  await syncHistory(source, directory, api);
  const hit = (await runRepositoryHistorySearch({ query: "alpha deadline" }, root, "codex")).results[0];
  expect(hit.excerpt).toContain("alpha");
  expect(hit.excerpt).toContain("deadline");
  expect(body.includes(hit.excerpt)).toBe(true);
  expect(hit.excerpt.length).toBeLessThanOrEqual(800);
});

it("reports ambiguous legacy bound provenance before networking and can adopt an explicitly matching configured bound", async () => {
  const { root, directory } = project();
  const api = new FixtureApi();
  api.issues.set(2, { ...issue(2), created_at: "2026-10-22T00:00:00Z" });
  const initial = await syncHistory(source, directory, api, "2026-10-21");
  const file = path.join(directory, "snapshot.json");
  const migratedLegacy = JSON.parse(readFileSync(file, "utf8"));
  delete migratedLegacy.configuredInitialSince;
  writeFileSync(file, JSON.stringify(migratedLegacy));
  const before = readFileSync(file, "utf8");
  const calls = api.calls.length;
  expect((await runRepositoryHistoryStatus({}, root, "codex")).initialSinceMismatch).toBe(true);
  await expect(syncHistory(source, directory, api)).rejects.toThrow("legacy bound provenance is unknown");
  expect(api.calls).toHaveLength(calls);
  expect(readFileSync(file, "utf8")).toBe(before);
  const resolved = await syncHistory({ ...source, initialSince: initial.initialSince }, directory, api);
  expect(resolved.configuredInitialSince).toBe(initial.initialSince);
  expect(resolved.entities.map((entity) => entity.number)).toEqual([2]);
});
