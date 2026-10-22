import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { createHistoryMcpServer } from "../src/adapters/mcp/history-server.js";
import { registerCodebaseIndexTools } from "../src/adapters/shared/extension-core.js";
import { repository_history_sync, repository_history_search, repository_history_status, repository_history_clear } from "../src/adapters/opencode/history-tools.js";
import { historyDirectory, readSnapshot } from "../src/history/storage.js";
import type { RepositoryHistorySearchResult, RepositoryHistoryStatusResult } from "../src/history/types.js";
import { createGitHubApi } from "../src/history/github.js";
import { syncHistory } from "../src/history/service.js";
import { runRepositoryHistorySearch } from "../src/tools/history-operations.js";

const execute = promisify(execFile);
const roots: string[] = [];
const repository = "example/repository";
const date = "2026-10-22T00:00:00Z";
const sha = "a".repeat(40);
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocbi-new-history-surface-"));
  roots.push(root);
  const config = { embeddingProvider: "custom", customProvider: {}, indexing: { autoIndex: false }, repositoryHistory: { repositories: [{ repository, enabled: true }] } };
  for (const [directory, filename] of [[".codebase-index", "config.json"], [".opencode", "codebase-index.json"]]) {
    mkdirSync(path.join(root, directory));
    writeFileSync(path.join(root, directory, filename), JSON.stringify(config));
  }
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  copyFileSync(path.resolve("tests/fixtures/github-history-gh.mjs"), path.join(bin, "gh"));
  chmodSync(path.join(bin, "gh"), 0o700);
  const statePath = path.join(root, "state.json");
  const requests = path.join(root, "requests.txt");
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("HISTORY_FIXTURE_STATE", statePath);
  vi.stubEnv("HISTORY_FIXTURE_REQUESTS", requests);
  const entity = { id: 1, number: 1, title: "Grounded design rationale", body: "local rationale needle", state: "closed", created_at: date, updated_at: date, user: { login: "author" }, pull_request: {} as object | undefined, merged_at: date, merge_commit_sha: sha,
    comments: [{ id: 20, body: "obsoletecommentneedle", created_at: date, updated_at: date, user: { login: "reviewer" } }],
    reviews: [{ id: 30, body: "reviewneedle", submitted_at: date, state: "APPROVED", user: { login: "reviewer" } }],
    reviewComments: [{ id: 40, body: "inlineneedle", created_at: date, updated_at: date, user: { login: "reviewer" } }],
    files: [{ filename: "src/feature.ts", patch: "MUST NEVER STORE THIS DIFF" }], commits: [{ sha }], timeline: [],
  };
  const state = { repository, repositoryId: 42, principalId: "viewer-1", metadataOnly: false, failAccessAt: 0, entities: [entity], revoked: false, fail: "", graphqlExit: 0, graphqlErrors: undefined as { type: string }[] | undefined };
  const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  save();
  return { root, state, save, requests };
}
function resultText(result: { content?: unknown }) {
  const content = result.content as { type: string; text?: string }[];
  return content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("history public surfaces", () => {
  it("executes actual built CLI sync/search/status/clear and resumes API failure without advancing published history", async () => {
    const fixture = setup();
    const cli = async (binary: "cbi" | "cli", ...args: string[]) => JSON.parse((await execute(process.execPath, [path.resolve(`dist/${binary}.js`), "history", ...args, "--project", fixture.root, "--host", "codex"], { env: process.env })).stdout);
    const sync = await cli("cbi", "sync");
    expect(sync).toMatchObject({ complete: true, entityCount: 1, documentCount: 4 });
    const initial = await cli("cli", "search", "reviewneedle");
    expect(initial.results[0]).toMatchObject({ documentUrl: "https://github.com/example/repository/pull/1#pullrequestreview-30", state: "merged", mergeCommitSha: sha, files: ["src/feature.ts"] });
    fixture.state.fail = "/reviews?";
    fixture.state.entities[0].body = "editedneedle";
    fixture.save();
    await expect(cli("cbi", "sync")).rejects.toMatchObject({ code: 1 });
    const status = await cli("cli", "status");
    expect(status).toMatchObject({ status: "error", cursor: sync.cursor });
    fixture.state.fail = "";
    fixture.state.entities[0].comments = [];
    fixture.state.entities[0].reviews = [];
    fixture.state.entities[0].reviewComments = [];
    fixture.save();
    await cli("cli", "sync"); // resumes a real fetch checkpoint; a later sweep reconciles changes during the interrupted cycle
    await cli("cbi", "sync");
    expect((await cli("cbi", "search", "obsoletecommentneedle")).results).toEqual([]);
    expect((await cli("cli", "search", "reviewneedle")).results).toEqual([]);
    expect((await cli("cli", "search", "editedneedle")).results[0].documentUrl).toBe("https://github.com/example/repository/pull/1");
    fixture.state.revoked = true; fixture.save();
    await expect(cli("cli", "sync")).rejects.toMatchObject({ code: 1 });
    expect((await cli("cbi", "search", "editedneedle")).results).toEqual([]);
    expect((await cli("cli", "clear")).cleared).toBe(true);
    expect((await cli("cbi", "status")).status).toBe("empty");
  }, 30_000);

  it("runs real MCP SDK tools with structured errors and rejects HTTP200 partial GraphQL data", async () => {
    const fixture = setup();
    const server = createHistoryMcpServer(fixture.root, "codex");
    const client = new Client({ name: "history-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await client.connect(left);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["repository_history_sync", "repository_history_search", "repository_history_status", "repository_history_clear"]);
      const call = (name: string, args = {}) => client.callTool({ name: `repository_history_${name}`, arguments: args });
      expect(JSON.parse(resultText(await call("sync"))).complete).toBe(true);
      const search = JSON.parse(resultText(await call("search", { query: "inlineneedle" }))) as RepositoryHistorySearchResult;
      expect(search.results[0].documentUrl).toBe("https://github.com/example/repository/pull/1#discussion_r40");
      const cursor = search.cursor;
      fixture.state.graphqlErrors = [{ type: "RATE_LIMITED" }]; fixture.save();
      const failed = await call("sync");
      expect(failed.isError).toBe(true); expect(resultText(failed)).toContain("HISTORY_RATE_LIMIT");
      const after = JSON.parse(resultText(await call("status"))) as RepositoryHistoryStatusResult;
      expect(after.cursor).toBe(cursor); expect(after.status).toBe("error");
      fixture.state.graphqlErrors = [{ type: "FORBIDDEN" }]; fixture.save();
      expect((await call("sync")).isError).toBe(true);
      expect(JSON.parse(resultText(await call("search", { query: "inlineneedle" }))).results).toEqual([]);
      expect(JSON.parse(resultText(await call("clear"))).cleared).toBe(true);
    } finally { await client.close(); await server.close(); }
  }, 30_000);

  it.each(["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"])("purges private evidence on rejected gh GraphQL %s stdout, even with a mixed quota error", async (denial) => {
    const fixture = setup();
    fixture.state.entities.push({ ...fixture.state.entities[0], id: 2, number: 2, pull_request: undefined });
    fixture.save();
    const directory = historyDirectory(fixture.root, "codex", repository);
    const api = createGitHubApi(repository, fixture.root);
    const source = { repository, enabled: true };
    const first = await syncHistory(source, directory, api);
    fixture.state.fail = "graphql:pullRequests"; fixture.save();
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    expect(statSync(path.join(directory, "fetch-staging")).isDirectory()).toBe(true);
    fixture.state.fail = "";
    fixture.state.graphqlErrors = [{ type: "RATE_LIMITED" }, { type: denial }];
    fixture.state.graphqlExit = 1;
    fixture.save();
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    const after = readSnapshot(directory, repository)!;
    expect(after.cursor).toBe(first.cursor);
    expect(after.entities).toEqual([]);
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
    expect((await runRepositoryHistorySearch({ query: "needle" }, fixture.root, "codex")).results).toEqual([]);
  }, 30_000);

  it("does not replay fully staged private bodies when the same repo/principal now has metadata-only credentials", async () => {
    const fixture = setup();
    const directory = historyDirectory(fixture.root, "codex", repository);
    const api = createGitHubApi(repository, fixture.root);
    const source = { repository, enabled: true };
    const before = await syncHistory(source, directory, api);
    fixture.state.failAccessAt = 4; fixture.save();
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_RATE_LIMIT");
    expect(statSync(path.join(directory, "fetch-staging")).isDirectory()).toBe(true);
    fixture.state.failAccessAt = 0;
    fixture.state.metadataOnly = true;
    fixture.save();
    await expect(syncHistory(source, directory, api)).rejects.toThrow("HISTORY_INACCESSIBLE");
    expect(readSnapshot(directory, repository)!.cursor).toBe(before.cursor);
    expect(readSnapshot(directory, repository)!.entities).toEqual([]);
    expect((await runRepositoryHistorySearch({ query: "needle" }, fixture.root, "codex")).results).toEqual([]);
    expect(() => statSync(path.join(directory, "fetch-staging"))).toThrow();
  }, 30_000);

  it("executes OpenCode tool definitions and the shared Pi/OMP extension against the same real API transport", async () => {
    const fixture = setup();
    const context = { worktree: fixture.root } as Parameters<typeof repository_history_status.execute>[1];
    expect(JSON.parse(await repository_history_sync.execute({}, context)).complete).toBe(true);
    expect(JSON.parse(await repository_history_search.execute({ query: "reviewneedle" }, context)).results[0].documentUrl).toContain("#pullrequestreview-30");
    expect(JSON.parse(await repository_history_status.execute({}, context)).entityCount).toBe(1);
    await repository_history_clear.execute({}, context);
    type Registered = { name: string; execute: (id: string, args: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: { cwd: string }) => Promise<{ content: unknown }> };
    const tools: Registered[] = [];
    registerCodebaseIndexTools({ registerTool: (tool) => { tools.push(tool as unknown as Registered); }, on: () => undefined }, Type);
    const call = async (name: string, args = {}) => JSON.parse(resultText(await tools.find((tool) => tool.name === `repository_history_${name}`)!.execute("test", args, undefined, undefined, { cwd: fixture.root })));
    expect((await call("sync")).complete).toBe(true);
    expect((await call("search", { query: "obsoletecommentneedle" })).results[0].documentUrl).toContain("#issuecomment-20");
    const snapshot = readSnapshot(historyDirectory(fixture.root, "pi", repository), repository)!;
    expect(JSON.stringify(snapshot)).not.toContain("MUST NEVER STORE THIS DIFF");
    expect((await call("clear")).cleared).toBe(true);
    expect(readFileSync(fixture.requests, "utf8")).toContain("graphql:pullRequests");
  }, 30_000);
});
