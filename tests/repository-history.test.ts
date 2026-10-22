import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
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
  async get(endpoint: string): Promise<unknown> {
    this.calls.push(endpoint);
    this.mutate?.(endpoint);
    if (this.revoked) throw new GitHubApiError(404, false);
    if (this.fail && endpoint.includes(this.fail)) throw new GitHubApiError(429, true);
    if (endpoint === `repos/${repository}`) return { id: this.repositoryId, full_name: this.repositoryName };
    if (endpoint.includes("/issues?")) return [...this.issues.values()].sort((a, b) => b.number - a.number).slice(0, 1);
    const number = Number(/\/(?:issues|pulls)\/(\d+)/.exec(endpoint)?.[1]);
    const collection = /\/(comments|timeline|reviews|files|commits)\?/.exec(endpoint)?.[1];
    if (collection) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      const items = collection === "comments" ? endpoint.includes("/pulls/") ? this.reviewComments : this.comments
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
    const results = await runRepositoryHistorySearch({ query: "rationale", state: "merged" }, root, "codex");
    expect(results.results.map((item) => item.documentUrl)).toEqual(expect.arrayContaining([
      "https://github.com/example/repository/pull/1", "https://github.com/example/repository/pull/1#issuecomment-121",
      "https://github.com/example/repository/pull/1#pullrequestreview-600", "https://github.com/example/repository/pull/1#discussion_r700",
    ]));
    expect(results.results[0]).toMatchObject({ state: "merged", mergeCommitSha: sha, files: ["src/feature.ts"], linkedIssues: ["https://github.com/example/repository/issues/12"], commits: [sha] });
    expect(results.authoritative).toBe(false);
    const second = await syncHistory(source, directory, api);
    expect(second.entities).toEqual(first.entities);
    expect((await runRepositoryHistorySearch({ query: "rationale", state: "merged" }, root, "codex")).results).toEqual(results.results);
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
