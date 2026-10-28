import type { HostMode } from "../src/config/host.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCbiCli } from "../src/adapters/cbi.js";
import { index_status } from "../src/adapters/opencode/tools.js";
import { createMcpServer } from "../src/mcp-server.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, hashContent } from "../src/native/index.js";
import codebaseIndexOmpExtension from "../src/omp-extension.js";
import codebaseIndexPiExtension from "../src/pi-extension.js";
import { executeIndexStatus } from "../src/tools/execute-common.js";
import { getIndexStatus } from "../src/tools/operations.js";
import {
  configCache,
  defaultProjectRoots,
  getIndexerCacheKey,
  getIndexerForProject,
  indexerCache,
  initializeTools,
} from "../src/tools/operation-runtime.js";
import { OperationCancelledError } from "../src/utils/operation-control.js";
import { stopAutoIndex } from "../src/utils/auto-index.js";

const structuralConfig = () => parseConfig({
  indexing: { mode: "structural", autoIndex: false, watchFiles: false, autoGc: false, requireProjectMarker: false },
  include: ["src/**/*.ts"],
  exclude: [],
  search: { minScore: 0 },
});
const canRestrictAccess = process.platform !== "win32" && process.getuid?.() !== 0;

describe("read-only shared status freshness", () => {
  let root: string;
  const readers = new Set<Indexer>();
  const hosts = new Set<HostMode>();
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sourcePath = () => path.join(root, "src", "gate.ts");
  function database(indexer: Indexer): Database {
    // Fixture-only access permits corrupting persisted migration metadata without faking status.
    const internals = indexer as unknown as { database: Database };
    return internals.database;
  }

  function setup(host: HostMode = "pi", config = structuralConfig()): Indexer {
    initializeTools(root, config, host);
    hosts.add(host);
    const indexer = getIndexerForProject(root, host);
    readers.add(indexer);
    return indexer;
  }

  function artifactHashes(indexPath: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of fs.readdirSync(indexPath).sort()) {
      // Runtime diagnostics/logs are not indexed source artifacts; SQLite SHM is transient reader state.
      if (name.endsWith("-shm") || name.includes("log") || name.startsWith("mcp-")) continue;
      const file = path.join(indexPath, name);
      if (fs.statSync(file).isFile()) result[name] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
    return result;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-status-freshness-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "status@example.com");
    git("config", "user.name", "Status Test");
    git("config", "gc.auto", "0");
    git("config", "maintenance.auto", "false");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(sourcePath(), "export function signalGate() {\n  return 'original';\n}\n");
    fs.writeFileSync(path.join(root, "src", "transport.ts"), "import { signalGate } from './gate.js';\nexport function createTransport() { return signalGate(); }\n");
    git("add", "src");
    git("commit", "-q", "-m", "fixture");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const host of hosts) {
      await stopAutoIndex(root, host);
      const key = getIndexerCacheKey(root, host);
      const cached = indexerCache.get(key);
      if (cached) readers.add(cached);
      indexerCache.delete(key);
      configCache.delete(key);
      if (defaultProjectRoots.get(host) === root) defaultProjectRoots.delete(host);
    }
    for (const indexer of readers) await indexer.close();
    readers.clear();
    hosts.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["opencode", "codex", "claude", "pi", "jcode"] as const)("separates catalog readiness from edited source without refreshing %s artifacts", async (host) => {
    const indexer = setup(host);
    await indexer.index();
    const freshnessCheck = vi.spyOn(indexer, "getIndexFreshness");
    const before = await getIndexStatus(root, host);
    const hashes = artifactHashes(before.indexPath);
    expect(before).toMatchObject({ indexed: true, mode: "structural", provider: "none", freshness: null });
    expect(freshnessCheck).not.toHaveBeenCalled();
    const checked = await executeIndexStatus(root, host, { checkFreshness: true });
    expect(checked.details).toMatchObject({ freshness: { readable: true, current: true, reason: "current" } });
    expect(freshnessCheck).toHaveBeenCalledTimes(1);

    fs.writeFileSync(sourcePath(), "export function signalGate() {\n  return 'changed-source';\n}\n");
    const plain = await executeIndexStatus(root, host, { checkFreshness: false });
    expect(plain.details).toMatchObject({ indexed: true, freshness: null });
    expect(plain.text).toContain("Source freshness: not checked");
    expect(freshnessCheck).toHaveBeenCalledTimes(1);
    const stale = await executeIndexStatus(root, host, { checkFreshness: true });
    expect(stale.details).toMatchObject({ indexed: true, freshness: { readable: true, current: false, reason: "files-changed" } });
    expect(stale.text).toContain("Source freshness: not current (reason: files-changed)");
    expect(artifactHashes(before.indexPath)).toEqual(hashes);

    await indexer.index();
    expect((await getIndexStatus(root, host, { checkFreshness: true })).freshness?.reason).toBe("current");
    expect((await indexer.search("signalGate", 5, { definitionIntent: true }))[0]?.content).toContain("changed-source");
  });

  it("reports a missing catalog without treating not-checked as current", async () => {
    setup();
    expect(await getIndexStatus(root, "pi")).toMatchObject({ indexed: false, freshness: null });
    expect(await getIndexStatus(root, "pi", { checkFreshness: true })).toMatchObject({
      indexed: false, freshness: { readable: false, current: false, reason: "missing" },
    });
  });

  it("keeps stopped coordination separate from current bytes and detects module configuration changes", async () => {
    const indexer = setup();
    await indexer.index();
    await stopAutoIndex(root, "pi");
    expect(await getIndexStatus(root, "pi", { checkFreshness: true })).toMatchObject({
      indexed: true, autoIndex: { state: "stopped" }, freshness: { readable: true, current: true, reason: "current" },
    });
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@fixture/*": ["src/*"] } },
    }));
    expect(await getIndexStatus(root, "pi", { checkFreshness: true })).toMatchObject({
      autoIndex: { state: "stopped" }, freshness: { readable: true, current: false, reason: "metadata-changed" },
    });
  });

  it("retains migration and failed-batch facts without repairing or retrying them", async () => {
    const indexer = setup();
    await indexer.index();
    const initial = await getIndexStatus(root, "pi");
    const marker = `index.callGraphResolutionVersion.${hashContent("main").slice(0, 24)}`;
    const storedVersion = database(indexer).getMetadata(marker)!;
    database(indexer).deleteMetadata(marker);
    const migration = await getIndexStatus(root, "pi", { checkFreshness: true });
    expect(migration).toMatchObject({ indexed: true, migrationRequired: true, freshness: { readable: true, current: false, reason: "migration-required" } });
    expect(database(indexer).getMetadata(marker)).toBeNull();
    const writer = new Database(path.join(initial.indexPath, "codebase.db"));
    try { writer.setMetadata(marker, storedVersion); }
    finally { writer.close(); }

    // Fixture-only access targets the branch-scoped retry artifact without changing production visibility.
    const internals = indexer as unknown as { failedBatchesPath: string };
    const failedPath = internals.failedBatchesPath;
    const failedBytes = JSON.stringify([{ chunks: [{ id: "pending-gate", metadata: { filePath: sourcePath() } }], error: "fixture provider failure", attemptCount: 1, lastAttempt: "2026-01-01T00:00:00.000Z" }]);
    fs.writeFileSync(failedPath, failedBytes);
    expect(await getIndexStatus(root, "pi", { checkFreshness: true })).toMatchObject({
      indexed: true, failedBatchesCount: 1, freshness: { readable: true, current: false, reason: "failed-batches" },
    });
    expect(fs.readFileSync(failedPath, "utf8")).toBe(failedBytes);
  });

  it("checks commit identity and never substitutes another branch's source", async () => {
    const indexer = setup();
    await indexer.index();
    git("commit", "-q", "--allow-empty", "-m", "new head");
    expect((await getIndexStatus(root, "pi", { checkFreshness: true })).freshness?.reason).toBe("branch-changed");
    git("checkout", "-q", "-b", "unindexed-feature");
    const missing = await getIndexStatus(root, "pi", { checkFreshness: true });
    expect(missing).toMatchObject({ indexed: false, currentBranch: "unindexed-feature", branchReadiness: { state: "missing" }, freshness: { current: false, reason: "missing" } });
    expect(await indexer.search("signalGate", 5, { definitionIntent: true })).toEqual([]);
  });

  it.runIf(canRestrictAccess)("reports unreadable source without calling it current or rebuilding", async () => {
    const indexer = setup();
    await indexer.index();
    fs.chmodSync(sourcePath(), 0o000);
    try {
      const result = await executeIndexStatus(root, "pi", { checkFreshness: true });
      expect(result.details).toMatchObject({ freshness: { readable: false, current: false, reason: "unreadable" } });
      expect(result.text).toContain("Resolve source/index access and readability before running index_codebase");
    } finally {
      fs.chmodSync(sourcePath(), 0o600);
    }
  });

  it("reports incompatible hybrid metadata without requesting embeddings during inspection", async () => {
    const base = structuralConfig();
    const config = parseConfig({
      ...base,
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "status-model-original", dimensions: 8 },
      indexing: { ...base.indexing, mode: "hybrid" },
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({
        data: input.map(() => ({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] })),
        usage: { total_tokens: input.length },
      }));
    });
    const writer = setup("pi", config);
    await writer.index();
    await writer.close();
    readers.delete(writer);
    const changedConfig = parseConfig({ ...config, customProvider: { ...config.customProvider, model: "status-model-changed" } });
    setup("pi", changedConfig);
    fetch.mockClear();
    const status = await getIndexStatus(root, "pi", { checkFreshness: true });
    expect(status).toMatchObject({
      indexed: true, mode: "hybrid", compatibility: { compatible: false },
      freshness: { readable: true, current: false, reason: "incompatible" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps OpenCode text-valued while honoring the explicit freshness option", async () => {
    const indexer = setup("opencode");
    await indexer.index();
    // Only the context fields read by the real status adapter are needed for this host invocation.
    const context = { worktree: root, abort: new AbortController().signal } as Parameters<typeof index_status.execute>[1];
    const plain = await index_status.execute({ checkFreshness: false }, context);
    expect(typeof plain).toBe("string");
    expect(plain).toContain("Source freshness: not checked");
    fs.appendFileSync(sourcePath(), "\nexport const openCodeChange = true;\n");
    const checked = await index_status.execute({ checkFreshness: true }, context);
    expect(checked).toContain("Source freshness: not current (reason: files-changed)");
  });

  it("interrupts a checked status during scanning and propagates unexpected check failures", async () => {
    const indexer = setup();
    await indexer.index();
    const abort = new AbortController();
    await expect(executeIndexStatus(root, "pi", { checkFreshness: true }, {
      signal: abort.signal,
      setPhase: (phase) => { if (phase === "scanning") abort.abort(new OperationCancelledError()); },
    })).rejects.toBeInstanceOf(OperationCancelledError);
    await expect(executeIndexStatus(root, "pi", { checkFreshness: true }, {
      setPhase: (phase) => { if (phase === "scanning") throw new Error("check failed unexpectedly"); },
    })).rejects.toThrow("check failed unexpectedly");
  });

  it.each(["ocbi", "cbi"])("prints only shared status JSON and returns success for stale/missing catalogs via %s", async (binary) => {
    const indexer = setup();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const run = (...flags: string[]) => runCbiCli(["node", binary, "status", "--project", root, "--host", "omp", ...flags], root, {
      printStdout: (value) => stdout.push(value), printStderr: (value) => stderr.push(value),
    });
    expect(await run("--check-freshness", "--json")).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ indexed: false, freshness: { reason: "missing" } });
    await indexer.index();
    fs.appendFileSync(sourcePath(), "\nexport const newerSource = true;\n");
    expect(await run("--check-freshness", "--json")).toBe(0);
    const stale = JSON.parse(stdout.pop()!);
    expect(stale).toMatchObject({ indexed: true, freshness: { current: false, reason: "files-changed" } });
    expect(stale).not.toHaveProperty("text");
    expect(stale).not.toHaveProperty("details");
    expect(await run("--json")).toBe(0);
    expect(JSON.parse(stdout.pop()!).freshness).toBeNull();
    expect(stderr).toEqual([]);
    const invalidConfig = path.join(root, "invalid-config.json");
    fs.writeFileSync(invalidConfig, "{");
    expect(await run("--check-freshness", "--json", "--config", invalidConfig)).toBe(1);
    expect(stdout).toEqual([]);
  });

  it.each(["pi", "omp"] as const)("exposes real checked status and default not-checked details through %s", async (host) => {
    const indexer = setup();
    await indexer.index();
    type Tool = { name: string; execute: (id: string, args: Record<string, unknown>, signal: AbortSignal, update: undefined, ctx: { cwd: string }) => Promise<{ content: Array<{ text: string }>; details?: unknown }> };
    const tools = new Map<string, Tool>();
    const api = {
      registerTool(tool) { tools.set(tool.name, tool as unknown as Tool); },
      on() {},
    } satisfies Pick<ExtensionAPI, "registerTool" | "on">;
    (host === "omp" ? codebaseIndexOmpExtension : codebaseIndexPiExtension)(api);
    const status = tools.get("index_status")!;
    expect((await status.execute("plain", {}, new AbortController().signal, undefined, { cwd: root })).details).toMatchObject({ indexed: true, freshness: null });
    fs.appendFileSync(sourcePath(), "\nexport const staleMarker = true;\n");
    const checked = await status.execute("checked", { checkFreshness: true }, new AbortController().signal, undefined, { cwd: root });
    expect(checked.details).toMatchObject({ indexed: true, freshness: { current: false, reason: "files-changed" } });
    expect(checked.content[0].text).toContain("reason: files-changed");
  });

  it("retains status facts alongside MCP runtime diagnostics through the public protocol", async () => {
    const server = createMcpServer(root, structuralConfig(), "pi");
    hosts.add("pi");
    const indexer = getIndexerForProject(root, "pi");
    readers.add(indexer);
    await indexer.index();
    const client = new Client({ name: "status-freshness-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const plain = await client.callTool({ name: "index_status", arguments: {} });
      expect(plain.structuredContent).toMatchObject({ indexed: true, freshness: null, mcpDiagnostics: { schemaVersion: 1, activeOperations: [] } });
      fs.appendFileSync(sourcePath(), "\nexport const mcpChange = true;\n");
      const checked = await client.callTool({ name: "index_status", arguments: { checkFreshness: true } });
      expect(checked.isError).not.toBe(true);
      expect(checked.structuredContent).toMatchObject({ indexed: true, freshness: { readable: true, current: false, reason: "files-changed" }, mcpDiagnostics: { schemaVersion: 1, activeOperations: [] } });
      expect(checked.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("reason: files-changed") })]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
