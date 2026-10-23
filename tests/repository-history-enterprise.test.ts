import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalRepository, parseRepositoryHistoryConfig, parseRepositoryIdentity } from "../src/history/config.js";
import { createGitHubApi } from "../src/history/github.js";
import { syncHistory } from "../src/history/service.js";
import { historyDirectory, readSnapshot, withHistoryLock } from "../src/history/storage.js";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "../src/tools/history-operations.js";

const execute = promisify(execFile);
const roots: string[] = [];
const name = "example/repository";
const enterprise = "git.corp.example";
const otherHost = "git.other.example";
const selected = `${enterprise}/${name}`;
const date = "2026-10-22T00:00:00Z";
const canary = "PRIVATE_STDERR_CREDENTIAL_CANARY";
const patch = "PRIVATE_DIFF_MUST_NOT_BE_CACHED";
function hostState(needle: string) {
  return {
    repository: name, repositoryId: 42, principalId: "viewer-1", fail: "", revoked: false,
    metadataOnly: false, hold: "", stderrCanary: canary,
    entities: [{
      id: 1, number: 1, title: "History design", body: `${needle} #12`, state: "closed",
      created_at: date, updated_at: date, user: { login: "author" }, pull_request: {}, merged_at: date,
      merge_commit_sha: "a".repeat(40),
      comments: [{ id: 20, body: `${needle}comment`, created_at: date, updated_at: date, user: { login: "reviewer" } }],
      reviews: [{ id: 30, body: `${needle}review`, submitted_at: date, state: "APPROVED", user: { login: "reviewer" } }],
      reviewComments: [{ id: 40, body: `${needle}inline`, created_at: date, updated_at: date, user: { login: "reviewer" } }],
      files: [{ filename: "src/feature.ts", patch }], commits: [],
      timeline: [{ event: "cross-referenced", created_at: date, source: { issue: { html_url: `https://${enterprise}/${name}/issues/13` } } }],
    }],
  };
}
function setup(repositories = [selected]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocbi-history-enterprise-"));
  roots.push(root);
  mkdirSync(path.join(root, ".codebase-index"));
  const config = (initialSince?: string) => writeFileSync(path.join(root, ".codebase-index/config.json"), JSON.stringify({
    embeddingProvider: "custom", customProvider: {}, indexing: { autoIndex: false },
    repositoryHistory: { repositories: repositories.map((repository) => ({ repository, enabled: true, initialSince })) },
  }));
  config();
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  copyFileSync(path.resolve("tests/fixtures/github-history-gh.mjs"), path.join(bin, "gh"));
  chmodSync(path.join(bin, "gh"), 0o700);
  const state = { hosts: {
    "github.com": hostState("publicneedle"),
    [enterprise]: hostState("enterpriseneedle"),
    [otherHost]: hostState("otherhostneedle"),
  } };
  const statePath = path.join(root, "state.json");
  const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  save();
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("GH_HOST", "ambient.unselected.example");
  vi.stubEnv("GH_DEBUG", "api");
  vi.stubEnv("HISTORY_FIXTURE_STATE", statePath);
  vi.stubEnv("HISTORY_FIXTURE_REQUESTS", path.join(root, "requests.txt"));
  vi.stubEnv("HISTORY_FIXTURE_RESPONSES", path.join(root, "responses.jsonl"));
  vi.stubEnv("HISTORY_FIXTURE_ROUTING", path.join(root, "routing.jsonl"));
  vi.stubEnv("HISTORY_FIXTURE_HOLD_READY", path.join(root, "hold-ready"));
  const directory = (repository = selected) => historyDirectory(root, "codex", repository);
  const requests = () => existsSync(path.join(root, "requests.txt")) ? readFileSync(path.join(root, "requests.txt"), "utf8").trim().split("\n") : [];
  const routes = () => readFileSync(path.join(root, "routing.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { hostname: string; ghHost: string; endpoint: string });
  const responses = () => readFileSync(path.join(root, "responses.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { hostname: string; endpoint: string; status: number; conditional: string | null });
  const sync = (repository = selected) => runRepositoryHistorySync({ repository }, root, "codex");
  const search = (query: string, repository = selected) => runRepositoryHistorySearch({ query, repository }, root, "codex");
  return { root, state, save, config, directory, requests, routes, responses, sync, search };
}
function downgradeStage(directory: string) {
  // Projected checkpoint bodies come from an actual interrupted fetch; only the historical metadata envelope changes.
  const file = path.join(directory, "fetch-staging/metadata.json");
  const metadata = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete metadata.repository;
  metadata.version = 2;
  writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 });
}
function text(result: { content?: unknown }) {
  return (result.content as { type: string; text?: string }[]).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Enterprise repository selectors and transport", () => {
  it("canonicalizes explicit github.com aliases and rejects ambiguous or credentialled selectors before transport", async () => {
    const fixture = setup();
    expect(parseRepositoryIdentity("GIT.CORP.EXAMPLE/Example/Repository")).toEqual({ hostname: enterprise, nameWithOwner: name, canonical: selected });
    expect(parseRepositoryIdentity("GitHub.Com/Example/Repository")).toEqual({ hostname: "github.com", nameWithOwner: name, canonical: name });
    expect(canonicalRepository("Example/Repository")).toBe(name);
    expect(() => parseRepositoryHistoryConfig({ repositories: [{ repository: name }, { repository: `github.com/${name}` }] })).toThrow("duplicate repository");
    for (const invalid of [
      `https://${selected}`, `http://${selected}`, `user:secret@${selected}`, `${enterprise}:443/${name}`,
      `user@${selected}`, `${enterprise}/${name}/extra`, `${enterprise}/../repository`, `${enterprise}/example/..`,
      `${enterprise}/example/.`, ` ${selected}`, `${selected} `, `${enterprise}/${name}.git`,
      `-bad.example/${name}`, `bad..example/${name}`, `bad_.example/${name}`, `127.0.0.1:80/${name}`,
      `127.0.0.1/${name}`, `[::1]/${name}`,
      `${enterprise}/${name}?token=secret`, `${enterprise}/${name}#fragment`, `${enterprise}/example/%2e%2e`,
    ]) {
      expect(() => parseRepositoryIdentity(invalid), invalid).toThrow("HISTORY_CONFIG");
      expect(() => createGitHubApi(invalid, fixture.root), invalid).toThrow("HISTORY_CONFIG");
      await expect(runRepositoryHistoryStatus({ repository: invalid }, fixture.root, "codex")).rejects.toThrow("HISTORY_CONFIG");
    }
    expect(fixture.requests()).toEqual([]);
  });

  it("uses selected --hostname/GH_HOST, hostless allowlisted REST, fixed repository discovery, and safe conditional requests", async () => {
    const fixture = setup();
    const api = createGitHubApi("GIT.CORP.EXAMPLE/Example/Repository", fixture.root);
    expect(await api.access()).toMatchObject({ hostname: enterprise, repositoryId: "42", repositoryName: name, principalId: "viewer-1" });
    const first = await api.get(`repos/${name}/issues/1`);
    expect(first.status).toBe(200);
    expect(first.etag).toBeTruthy();
    expect(await api.get(`repos/${name}/issues/1`, first.etag)).toMatchObject({ status: 304 });
    expect((await api.discover("pullRequests", null)).nodes).toEqual([{ number: 1, createdAt: date }]);
    const count = fixture.requests().length;
    for (const endpoint of [
      `https://${enterprise}/api/v3/repos/${name}/issues/1`, `repos/${otherHost}/${name}/issues/1`,
      "repos/other/repository/issues/1", `repos/${name}/../other`, `repos/${name}/pulls/1/commits`,
      `repos/${name}/issues/1?token=secret`, `repos/${name}/issues/1?page=1&redirect=https://evil.example`,
      `repos/${name}/issues/1?page=1&page=2`, `repos/${name}/issues/1?per_page=100&per_page=10`,
    ]) await expect(api.get(endpoint)).rejects.toThrow("HISTORY_API");
    for (const etag of ["\r\nAuthorization: secret", "\u0000secret", "x".repeat(1025)]) {
      await expect(api.get(`repos/${name}/issues/1`, etag)).rejects.toThrow("HISTORY_STORAGE");
    }
    expect(fixture.requests()).toHaveLength(count);
    expect(fixture.routes().every((route) => route.hostname === enterprise && route.ghHost === enterprise)).toBe(true);
    expect(fixture.routes().map((route) => route.endpoint)).toEqual(["graphql", `repos/${name}/issues/1`, `repos/${name}/issues/1`, "graphql"]);
    const trace = readFileSync(path.join(fixture.root, "routing.jsonl"), "utf8");
    expect(trace).not.toContain("Authorization"); expect(trace).not.toContain("secret"); expect(trace).not.toContain("query=");
  }, 30_000);

  it("indexes real Enterprise discussions with selected-host citations, bare references, and unchanged validated explicit cross-host refs", async () => {
    const fixture = setup();
    fixture.state.hosts[enterprise].entities[0].body += ` https://${otherHost}/Other/Repo/issues/15 https://github.com/External/Repo/pull/16 https://user:secret@${enterprise}/${name}/issues/17 https://${enterprise}:443/${name}/issues/18`;
    fixture.save();
    expect(await fixture.sync()).toMatchObject({ complete: true, repository: selected, entityCount: 1, documentCount: 4 });
    for (const [query, anchor] of [["enterpriseneedle", ""], ["enterpriseneedlecomment", "#issuecomment-20"], ["enterpriseneedlereview", "#pullrequestreview-30"], ["enterpriseneedleinline", "#discussion_r40"]]) {
      const result = await fixture.search(query);
      expect(result.results[0]).toMatchObject({ repository: selected, documentUrl: `https://${enterprise}/${name}/pull/1${anchor}` });
      expect(result).toMatchObject({ localOnly: true, authoritative: false });
    }
    for (const query of ["#1", `${selected}#1`]) {
      expect((await fixture.search(query)).results[0].documentUrl).toBe(`https://${enterprise}/${name}/pull/1`);
    }
    expect((await fixture.search(`https://${enterprise}/${name}/pull/1#pullrequestreview-30`)).results[0].documentUrl)
      .toBe(`https://${enterprise}/${name}/pull/1#pullrequestreview-30`);
    const snapshot = readSnapshot(fixture.directory(), selected)!;
    expect(snapshot.entities[0].linkedIssues).toEqual(expect.arrayContaining([
      `https://${enterprise}/${name}/issues/12`, `https://${enterprise}/${name}/issues/13`,
      `https://${otherHost}/Other/Repo/issues/15`, "https://github.com/External/Repo/pull/16",
    ]));
    expect(snapshot.entities[0].linkedIssues).toHaveLength(4);
    expect(JSON.stringify(snapshot)).not.toContain(patch);
    expect(fixture.routes().every((route) => route.hostname === enterprise)).toBe(true);
    expect(fixture.requests().some((request) => /issues\/(12|13|15|16|17|18)(?:$|\/)/.test(request))).toBe(false);
    expect(statSync(fixture.directory()).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(fixture.directory(), "snapshot.json")).mode & 0o777).toBe(0o600);
    const count = fixture.requests().length;
    expect(await runRepositoryHistoryStatus({ repository: selected }, fixture.root, "codex")).toMatchObject({ status: "ready", entityCount: 1 });
    await fixture.search("enterpriseneedle");
    expect(fixture.requests()).toHaveLength(count); // Search/status are local-only.
  }, 30_000);
});

describe("Enterprise cache identity and privacy", () => {
  it("isolates identical numeric IDs across hosts, conditional validators, interrupted stages, denial cleanup, and selected clear", async () => {
    const other = `${otherHost}/${name}`;
    const fixture = setup([selected, other]);
    await fixture.sync();
    const secondStart = fixture.responses().length;
    await fixture.sync(other);
    expect(fixture.directory()).not.toBe(fixture.directory(other));
    expect(fixture.responses().slice(secondStart).filter((response) => response.endpoint.includes("/issues/1")).every((response) => response.hostname === otherHost && response.conditional === null)).toBe(true);
    for (const repository of [selected, other]) await fixture.sync(repository);
    for (const hostname of [enterprise, otherHost]) expect(fixture.responses().some((response) => response.hostname === hostname && response.status === 304)).toBe(true);
    expect((await fixture.search("otherhostneedle")).results).toEqual([]);
    expect((await fixture.search("enterpriseneedle", other)).results).toEqual([]);
    for (const hostname of [enterprise, otherHost]) fixture.state.hosts[hostname].fail = "/reviews?";
    fixture.save();
    for (const repository of [selected, other]) await expect(fixture.sync(repository)).rejects.toThrow("HISTORY_RATE_LIMIT");
    const survivorSnapshot = readFileSync(path.join(fixture.directory(other), "snapshot.json"), "utf8");
    const survivorStage = readFileSync(path.join(fixture.directory(other), "fetch-staging/metadata.json"), "utf8");
    expect(JSON.parse(readFileSync(path.join(fixture.directory(), "fetch-staging/metadata.json"), "utf8"))).toMatchObject({ version: 3, repository: selected });
    fixture.state.hosts[enterprise].revoked = true; fixture.save();
    let failure: unknown;
    try { await fixture.sync(); } catch (error) { failure = error; }
    expect(String(failure)).toContain("HISTORY_INACCESSIBLE");
    expect(String(failure)).not.toContain(canary); expect(String(failure)).not.toContain("enterpriseneedle");
    expect((await fixture.search("enterpriseneedle")).results).toEqual([]);
    const denied = readFileSync(path.join(fixture.directory(), "snapshot.json"), "utf8");
    expect(denied).not.toContain("enterpriseneedle");
    expect(readSnapshot(fixture.directory(), selected)!.httpCache).toEqual({});
    expect(existsSync(path.join(fixture.directory(), "fetch-staging"))).toBe(false);
    expect(readFileSync(path.join(fixture.directory(other), "snapshot.json"), "utf8")).toBe(survivorSnapshot);
    expect(readFileSync(path.join(fixture.directory(other), "fetch-staging/metadata.json"), "utf8")).toBe(survivorStage);
    expect((await fixture.search("otherhostneedle", other)).results).toHaveLength(1);
    await runRepositoryHistoryClear({ repository: selected }, fixture.root, "codex");
    expect((await runRepositoryHistoryStatus({ repository: selected }, fixture.root, "codex")).status).toBe("empty");
    expect(readFileSync(path.join(fixture.directory(other), "snapshot.json"), "utf8")).toBe(survivorSnapshot);
    await runRepositoryHistoryClear({ repository: other }, fixture.root, "codex");
    expect(existsSync(path.join(fixture.directory(other), "fetch-staging"))).toBe(false);
  }, 30_000);

  it("resumes valid hostless projected v2 github.com staging with visible progress and fresh before/after proofs", async () => {
    const fixture = setup([name]);
    const upstream = fixture.state.hosts["github.com"];
    upstream.fail = "/reviews?"; fixture.save();
    await expect(fixture.sync(name)).rejects.toThrow("HISTORY_RATE_LIMIT");
    downgradeStage(fixture.directory(name));
    const metadataPath = path.join(fixture.directory(name), "fetch-staging/metadata.json");
    const legacy = readFileSync(metadataPath, "utf8");
    const status = await runRepositoryHistoryStatus({ repository: `github.com/${name}` }, fixture.root, "codex");
    expect(status.syncProgress).toMatchObject({ resumable: true });
    expect(status.syncProgress!.cachedRequests).toBeGreaterThan(0);
    expect(readFileSync(metadataPath, "utf8")).toBe(legacy); // Inspection must not upgrade/delete outside the writer lease.
    await withHistoryLock(fixture.directory(name), "index", async () => {
      await expect(fixture.sync(name)).rejects.toThrow("HISTORY_BUSY");
      expect(readFileSync(metadataPath, "utf8")).toBe(legacy);
    });
    const start = fixture.requests().length;
    upstream.fail = ""; fixture.save();
    expect(await fixture.sync(`github.com/${name}`)).toMatchObject({ complete: true, repository: name });
    const resumed = fixture.requests().slice(start);
    expect(resumed.filter((request) => request === `github.com repos/${name}`)).toHaveLength(2);
    expect(resumed.filter((request) => request === "github.com graphql:access")).toHaveLength(2);
    expect(resumed).not.toContain(`github.com repos/${name}/issues/1`);
    expect(resumed).toContain(`github.com repos/${name}/pulls/1/reviews?per_page=100&page=1`);
    expect((await fixture.search("publicneedle", name)).results[0].documentUrl).toBe(`https://github.com/${name}/pull/1`);
    expect(existsSync(path.dirname(metadataPath))).toBe(false);
  }, 30_000);

  it.each(["principal", "repository", "permissions", "window"] as const)("does not replay a legacy v2.com checkpoint after fresh %s proof changes", async (change) => {
    const fixture = setup([name]);
    const upstream = fixture.state.hosts["github.com"];
    await fixture.sync(name);
    upstream.fail = "/reviews?"; fixture.save();
    await expect(fixture.sync(name)).rejects.toThrow("HISTORY_RATE_LIMIT");
    downgradeStage(fixture.directory(name));
    if (change === "principal") upstream.principalId = "viewer-2";
    if (change === "repository") upstream.repositoryId = 99;
    if (change === "permissions") upstream.metadataOnly = true;
    if (change === "window") fixture.config("2026-10-23T00:00:00.000Z");
    upstream.fail = ""; fixture.save();
    const start = fixture.requests().length;
    await expect(fixture.sync(name)).rejects.toThrow(change === "window" ? "HISTORY_CONFIG" : "HISTORY_INACCESSIBLE");
    expect(fixture.requests().slice(start).some((request) => request.includes("/reviews?"))).toBe(false);
    if (change !== "window") {
      expect((await fixture.search("publicneedle", name)).results).toEqual([]);
      expect(existsSync(path.join(fixture.directory(name), "fetch-staging"))).toBe(false);
    } else expect(existsSync(path.join(fixture.directory(name), "fetch-staging"))).toBe(true);
  }, 30_000);

  it("rejects a copied hostless v2 stage on Enterprise despite identical repository and principal IDs", async () => {
    const fixture = setup([name, selected]);
    fixture.state.hosts["github.com"].fail = "/reviews?"; fixture.save();
    await expect(fixture.sync(name)).rejects.toThrow("HISTORY_RATE_LIMIT");
    downgradeStage(fixture.directory(name));
    await fixture.sync();
    const published = readSnapshot(fixture.directory(), selected)!;
    cpSync(path.join(fixture.directory(name), "fetch-staging"), path.join(fixture.directory(), "fetch-staging"), { recursive: true });
    await expect(fixture.sync()).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect(readSnapshot(fixture.directory(), selected)!.cursor).toBe(published.cursor);
    expect((await fixture.search("publicneedle")).results).toEqual([]);
    expect((await fixture.search("enterpriseneedle")).results).toEqual([]);
    expect(existsSync(path.join(fixture.directory(), "fetch-staging"))).toBe(false);
    expect(existsSync(path.join(fixture.directory(name), "fetch-staging"))).toBe(true);
    expect(await fixture.sync()).toMatchObject({ complete: true });
    expect((await fixture.search("enterpriseneedle")).results).toHaveLength(1);
  }, 30_000);
});

describe("Enterprise user-facing surfaces", () => {
  it("executes built CLI sync/search/status/clear without exposing gh stderr or touching another host", async () => {
    const fixture = setup([selected, `${otherHost}/${name}`]);
    const cli = async (command: string, ...args: string[]) => execute(process.execPath, [path.resolve("dist/cli.js"), "history", command, ...args, "--repository", selected, "--project", fixture.root, "--host", "codex"], { env: process.env });
    const synced = await cli("sync");
    expect(JSON.parse(synced.stdout)).toMatchObject({ complete: true, repository: selected });
    expect(synced.stderr).not.toContain(canary); expect(synced.stderr).not.toContain("enterpriseneedle");
    const found = await cli("search", "enterpriseneedleinline");
    expect(JSON.parse(found.stdout).results[0].documentUrl).toBe(`https://${enterprise}/${name}/pull/1#discussion_r40`);
    expect(JSON.parse((await cli("status")).stdout)).toMatchObject({ status: "ready", entityCount: 1 });
    fixture.state.hosts[enterprise].revoked = true; fixture.save();
    let failed: unknown;
    try { await cli("sync"); } catch (error) { failed = error; }
    expect(failed).toMatchObject({ code: 1 });
    const output = failed as { stdout: string; stderr: string };
    expect(output.stdout + output.stderr).toContain("HISTORY_INACCESSIBLE");
    expect(output.stdout + output.stderr).not.toContain(canary);
    expect(output.stdout + output.stderr).not.toContain("enterpriseneedle");
    expect(JSON.parse((await cli("search", "enterpriseneedle")).stdout).results).toEqual([]);
    expect(JSON.parse((await cli("clear")).stdout).cleared).toBe(true);
    expect(JSON.parse((await cli("status")).stdout).status).toBe("empty");
    expect(fixture.routes().every((route) => route.hostname === enterprise && route.ghHost === enterprise)).toBe(true);
  }, 30_000);

  it("runs built MCP stdio sync/search/status/clear against selected Enterprise transport and local native lexical evidence", async () => {
    const fixture = setup();
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist/cli.js"), "--history-only", "--project", fixture.root, "--host", "codex"],
      cwd: fixture.root, env, stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: "enterprise-history-test", version: "1" });
    const protocolErrors: Error[] = [];
    client.onerror = (error) => { protocolErrors.push(error); };
    const call = (operation: string, args = {}) => client.callTool({ name: `repository_history_${operation}`, arguments: { repository: selected, ...args } });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "repository_history_clear", "repository_history_search", "repository_history_status", "repository_history_sync",
      ]);
      const synced = await call("sync");
      expect(synced.isError).not.toBe(true);
      expect(JSON.parse(text(synced))).toMatchObject({ complete: true, repository: selected });
      const searched = await call("search", { query: "enterpriseneedlereview" });
      expect(searched.isError).not.toBe(true);
      expect(JSON.parse(text(searched)).results[0].documentUrl).toBe(`https://${enterprise}/${name}/pull/1#pullrequestreview-30`);
      const status = await call("status");
      expect(status.isError).not.toBe(true);
      expect(JSON.parse(text(status))).toMatchObject({ status: "ready", entityCount: 1 });
      fixture.state.hosts[enterprise].revoked = true; fixture.save();
      const denial = await call("sync");
      expect(denial.isError).toBe(true); expect(text(denial)).toContain("HISTORY_INACCESSIBLE");
      expect(text(denial)).not.toContain(canary); expect(text(denial)).not.toContain("enterpriseneedle");
      expect(JSON.parse(text(await call("search", { query: "enterpriseneedle" }))).results).toEqual([]);
      const cleared = await call("clear");
      expect(cleared.isError).not.toBe(true);
      expect(JSON.parse(text(cleared)).cleared).toBe(true);
    } finally {
      await client.close();
      expect(stderr).not.toContain(canary);
      expect(protocolErrors).toEqual([]);
    }
  }, 30_000);

  it("cancels real Enterprise gh transport without publishing private bodies and retains the interrupted initial window", async () => {
    const fixture = setup();
    const upstream = fixture.state.hosts[enterprise];
    upstream.hold = `repos/${name}/pulls/1/reviews?per_page=100&page=1`; fixture.save();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    const ready = new Promise<boolean>((resolve) => {
      watcher = watch(fixture.root, (_event, filename) => {
        if (filename === "hold-ready") { controller.abort(); resolve(true); }
      });
      timer = setTimeout(() => { controller.abort(); resolve(false); }, 20_000);
    });
    try {
      const syncing = syncHistory({ repository: selected, enabled: true }, fixture.directory(), createGitHubApi(selected, fixture.root, controller.signal), "2026-10-21", { signal: controller.signal });
      const outcome = syncing.catch((error: unknown) => error);
      expect(await ready).toBe(true);
      expect(String(await outcome)).toContain("HISTORY_CANCELLED");
    } finally { clearTimeout(timer); watcher?.close(); }
    expect(existsSync(path.join(fixture.directory(), "snapshot.json"))).toBe(false);
    expect((await runRepositoryHistoryStatus({ repository: selected }, fixture.root, "codex")).syncProgress).toMatchObject({ resumable: true });
    const count = fixture.requests().length;
    fixture.config("2026-10-23T00:00:00.000Z");
    await expect(fixture.sync()).rejects.toThrow("HISTORY_CONFIG");
    expect(fixture.requests()).toHaveLength(count);
    fixture.config(); upstream.hold = ""; fixture.save();
    expect(await fixture.sync()).toMatchObject({ complete: true, initialSince: "2026-10-21T00:00:00.000Z" });
    expect((await fixture.search("enterpriseneedle")).results).toHaveLength(1);
    expect(fixture.routes().every((route) => route.hostname === enterprise)).toBe(true);
  }, 30_000);
});

describe("transport-host capability binding and GitHub.com snapshot compatibility", () => {
  it.each(["before", "after"] as const)("rejects a mismatched transport hostname in the %s-fetch capability response despite matching numeric IDs", async (phase) => {
    const fixture = setup();
    await fixture.sync();
    const api = createGitHubApi(selected, fixture.root);
    let proofs = 0;
    const boundApi = {
      ...api,
      async access() {
        const proof = await api.access();
        proofs++;
        return { ...proof, hostname: proofs === (phase === "before" ? 1 : 2) ? otherHost : proof.hostname };
      },
    };
    await expect(syncHistory({ repository: selected, enabled: true }, fixture.directory(), boundApi)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect((await fixture.search("enterpriseneedle")).results).toEqual([]);
    expect(readSnapshot(fixture.directory(), selected)!.httpCache).toEqual({});
    expect(existsSync(path.join(fixture.directory(), "fetch-staging"))).toBe(false);
    expect(fixture.routes().every((route) => route.hostname === enterprise)).toBe(true);
  }, 30_000);

  it.each([1, 2])("reads a version %i GitHub.com snapshot through the explicit-host alias without network or identity drift", async (version) => {
    const fixture = setup([name]);
    await fixture.sync(name);
    const file = path.join(fixture.directory(name), "snapshot.json");
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    snapshot.version = version;
    writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
    const count = fixture.requests().length;
    const alias = "GITHUB.COM/Example/Repository";
    expect(await runRepositoryHistoryStatus({ repository: alias }, fixture.root, "codex")).toMatchObject({ status: "ready", repository: name });
    expect((await fixture.search("publicneedle", alias)).results[0]).toMatchObject({ repository: name, documentUrl: `https://github.com/${name}/pull/1` });
    expect(fixture.requests()).toHaveLength(count);
    expect(await fixture.sync(alias)).toMatchObject({ complete: true, repository: name });
    expect(readSnapshot(fixture.directory(name), name)!.repository).toBe(name);
  }, 30_000);
});

describe("copied Enterprise cache boundaries", () => {
  it("refuses a snapshot copied from a different host with identical numeric identities", async () => {
    const other = `${otherHost}/${name}`;
    const fixture = setup([selected, other]);
    await fixture.sync();
    await fixture.sync(other);
    const original = readFileSync(path.join(fixture.directory(), "snapshot.json"), "utf8");
    copyFileSync(path.join(fixture.directory(other), "snapshot.json"), path.join(fixture.directory(), "snapshot.json"));
    const requests = fixture.requests().length;
    await expect(fixture.search("otherhostneedle")).rejects.toThrow("HISTORY_STORAGE");
    await expect(runRepositoryHistoryStatus({ repository: selected }, fixture.root, "codex")).rejects.toThrow("HISTORY_STORAGE");
    expect(fixture.requests()).toHaveLength(requests);
    await runRepositoryHistoryClear({ repository: selected }, fixture.root, "codex");
    expect((await fixture.search("otherhostneedle", other)).results).toHaveLength(1);
    await fixture.sync();
    expect(readSnapshot(fixture.directory(), selected)!.repository).toBe(JSON.parse(original).repository);
    expect((await fixture.search("enterpriseneedle")).results).toHaveLength(1);
  }, 30_000);

  it("does not adopt another Enterprise host's v3 checkpoint even when repository/principal IDs coincide", async () => {
    const other = `${otherHost}/${name}`;
    const fixture = setup([selected, other]);
    await fixture.sync();
    fixture.state.hosts[otherHost].fail = "/reviews?"; fixture.save();
    await expect(fixture.sync(other)).rejects.toThrow("HISTORY_RATE_LIMIT");
    cpSync(path.join(fixture.directory(other), "fetch-staging"), path.join(fixture.directory(), "fetch-staging"), { recursive: true });
    await expect(fixture.sync()).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect((await fixture.search("otherhostneedle")).results).toEqual([]);
    expect(existsSync(path.join(fixture.directory(), "fetch-staging"))).toBe(false);
    expect(existsSync(path.join(fixture.directory(other), "fetch-staging"))).toBe(true);
    fixture.state.hosts[otherHost].fail = ""; fixture.save();
    expect(await fixture.sync(other)).toMatchObject({ complete: true });
    expect((await fixture.search("otherhostneedle", other)).results).toHaveLength(1);
  }, 30_000);
});
