import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HostMode } from "../src/config/host.js";
import type { PrImpactResult } from "../src/indexer/pr-impact-types.js";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCbiCli } from "../src/adapters/cbi.js";
import { createMcpServer } from "../src/adapters/mcp/server.js";
import { pr_impact } from "../src/adapters/opencode/pr-impact.js";
import codebaseIndexPiExtension from "../src/pi-extension.js";
import codebaseIndexOmpExtension from "../src/omp-extension.js";
import { parseConfig } from "../src/config/schema.js";
import { getPrImpact } from "../src/tools/operations.js";
import { formatPrImpact } from "../src/tools/format-pr-impact.js";
import {
  configCache,
  getIndexerCacheKey,
  getIndexerForProject,
  indexerCache,
  initializeTools,
} from "../src/tools/operation-runtime.js";
import { stopAutoIndex } from "../src/utils/auto-index.js";
import { stopBackgroundWorker } from "../src/utils/background-worker.js";

const config = parseConfig({
  indexing: { mode: "structural", autoIndex: false, watchFiles: false, requireProjectMarker: false },
  include: ["**/*.ts"],
  exclude: ["excluded/**"],
  search: { minScore: 0 },
});
const currentGate = "export function signalGate() { return 'current'; }\nexport function currentOnlyGate() { return signalGate(); }\n";
const untrackedPath = process.platform === "win32" ? "src/new Ω file.ts" : "src/new Ω\nfile.ts";

describe("working-tree impact host and CLI behavior", () => {
  let root: string;
  let activeHost: HostMode;
  let client: Client | undefined;
  let server: McpServer | undefined;

  function git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
    });
  }

  function write(relative: string, source: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }

  async function prepare(host: HostMode = "pi", mcp = false): Promise<void> {
    activeHost = host;
    if (mcp) {
      server = createMcpServer(root, config, host);
      client = new Client({ name: "working-tree-impact-test", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    } else {
      initializeTools(root, config, host);
    }
    await getIndexerForProject(root, host).index();
  }

  function editTree(): void {
    write("src/gate.ts", "export function stagedOnlyGate() { return 'staged'; }\n");
    git("add", "src/gate.ts");
    write("src/gate.ts", currentGate);
    write("src/transport.ts", "import { signalGate } from './gate.js';\nexport function createTransport() { return signalGate() + 'unstaged'; }\n");
    write(untrackedPath, "export function untrackedGate() { return 42; }\n");
  }

  function assertCurrentFiles(result: PrImpactResult): void {
    expect(result.workingTree?.scope).toBe("current_indexed_files");
    expect(result.workingTree?.entries).toEqual([
      { path: "src/gate.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: untrackedPath, indexStatus: "?", worktreeStatus: "?" },
      { path: "src/transport.ts", indexStatus: " ", worktreeStatus: "M" },
    ]);
    expect(result.changedFiles).toEqual(["src/gate.ts", untrackedPath, "src/transport.ts"]);
    expect(result.directSymbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["signalGate", "currentOnlyGate", "createTransport", "untrackedGate"]));
    expect(result.directSymbols.map((symbol) => symbol.name)).not.toContain("stagedOnlyGate");
    expect(result.transitiveCallers.map((symbol) => symbol.name)).toContain("serveRequest");
    expect(result.workingTree?.unassessed).toEqual([]);
    expect(result.workingTree?.omittedFileCount).toBe(0);
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-working-tree-surfaces-")));
    activeHost = "pi";
    git("init", "--initial-branch=main");
    write(".gitignore", ".codebase-index/\n.opencode/\nruntime-config.json\n");
    write("src/gate.ts", "export function signalGate() { return 'base'; }\n");
    write("src/transport.ts", "import { signalGate } from './gate.js';\nexport function createTransport() { return signalGate(); }\n");
    write("src/server.ts", "import { createTransport } from './transport.js';\nexport function serveRequest() { return createTransport(); }\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
    await stopBackgroundWorker(root, activeHost);
    await stopAutoIndex(root, activeHost);
    const key = getIndexerCacheKey(root, activeHost);
    await indexerCache.get(key)?.close();
    indexerCache.delete(key);
    configCache.delete(key);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["ocbi", "cbi"])("%s prints real current-file impact JSON and qualified text", async (binary) => {
    editTree();
    // An explicit config exercises the CLI's actual runtime/config boundary.
    write("runtime-config.json", JSON.stringify(config));
    await prepare();
    // The CLI replaces its runtime for --config; release the fixture's writer first.
    await getIndexerForProject(root, "pi").close();
    indexerCache.delete(getIndexerCacheKey(root, "pi"));
    const output: string[] = [];
    const errors: string[] = [];
    const argv = ["node", binary, "impact", "--working-tree", "--project", root, "--host", "omp"];
    expect(await runCbiCli([...argv, "--json", "--config", path.join(root, "runtime-config.json")], root, {
      printStdout: (text) => output.push(text), printStderr: (text) => errors.push(text),
    })).toBe(0);
    expect(errors).toEqual([]);
    assertCurrentFiles(JSON.parse(output[0]) as PrImpactResult);
    output.length = 0;
    expect(await runCbiCli(argv, root, {
      printStdout: (text) => output.push(text), printStderr: (text) => errors.push(text),
    })).toBe(0);
    expect(output[0]).toContain("current indexed files");
    expect(output[0]).toContain("not changed-line or staged-source analysis");
    expect(output[0]).toContain('[MM] "src/gate.ts"');
    expect(output[0]).toContain(`[??] ${JSON.stringify(untrackedPath)}`);
    expect(output[0]).toContain("serveRequest");
  });

  it("MCP returns native-backed impact details with matching text", async () => {
    editTree();
    await prepare("pi", true);
    const response = await client!.callTool({ name: "pr_impact", arguments: { workingTree: true } });
    expect(response.isError).not.toBe(true);
    assertCurrentFiles(response.structuredContent as unknown as PrImpactResult);
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining('[MM] "src/gate.ts"') }),
    ]));
  });

  it.each(["pi", "omp"] as const)("%s exposes real current graph evidence as details", async (host) => {
    editTree();
    await prepare();
    const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    const api = {
      registerTool(tool) { tools.set(tool.name, tool); },
      on() {},
    } satisfies Pick<ExtensionAPI, "registerTool" | "on">;
    (host === "pi" ? codebaseIndexPiExtension : codebaseIndexOmpExtension)(api);
    const tool = tools.get("pr_impact")!;
    const response = await tool.execute("impact", { workingTree: true }, new AbortController().signal, () => {},
      { cwd: root } as Parameters<typeof tool.execute>[4]);
    assertCurrentFiles(response.details as PrImpactResult);
    expect(response.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("static file-level graph analysis") }),
    ]));
  });

  it("OpenCode inspects the tree without announcing branch preparation", async () => {
    editTree();
    await prepare("opencode");
    const titles: string[] = [];
    const response = await pr_impact.execute({ workingTree: true }, {
      worktree: root,
      metadata: (metadata: { title?: string }) => { if (metadata.title) titles.push(metadata.title); },
    });
    expect(response).toContain('[MM] "src/gate.ts"');
    expect(response).toContain("currentOnlyGate");
    expect(response).toContain("serveRequest");
    expect(titles).toContain("Inspecting current indexed working-tree files");
    expect(titles.join("\n")).not.toMatch(/Preparing|branch index|resolving authoritative branch head/);
  });

  it("shared and CLI stale inspection refuses refresh and leaves the stale state visible", async () => {
    await prepare();
    write("src/gate.ts", currentGate);
    const before = git("status", "--porcelain=v1");
    await expect(getPrImpact(root, "pi", { workingTree: true })).rejects.toThrow("Working-tree impact requires a current index. Run index_codebase, then retry.");
    const errors: string[] = [];
    const output: string[] = [];
    expect(await runCbiCli(["node", "ocbi", "impact", "--working-tree", "--project", root, "--host", "omp"], root, {
      printStdout: (text) => output.push(text), printStderr: (text) => errors.push(text),
    })).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join("\n")).toContain("Working-tree impact requires a current index");
    expect((await getIndexerForProject(root, "pi").getIndexFreshness()).current).toBe(false);
    expect(git("status", "--porcelain=v1")).toBe(before);
  });

  it.each([{ pr: 1 }, { branch: "main" }, { checkConflicts: true }])("rejects conflicting shared arguments before phases or runtime initialization: %j", async (conflict) => {
    const phases: string[] = [];
    await expect(getPrImpact(root, "pi", { workingTree: true, ...conflict }, {
      setPhase: (phase) => { phases.push(phase); },
    })).rejects.toThrow("workingTree cannot be combined with pr, branch, or checkConflicts");
    expect(phases).toEqual([]);
    expect(indexerCache.has(getIndexerCacheKey(root, "pi"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".codebase-index"))).toBe(false);
  });

  it("reports clean trees explicitly and excluded paths as UNKNOWN rather than zero LOW", async () => {
    await prepare();
    const clean = await getPrImpact(root, "pi", { workingTree: true });
    expect(clean.changedFiles).toEqual([]);
    expect(formatPrImpact(clean)).toContain("No working-tree changes.");
    write("excluded/opaque.ts", "export function excludedGate() { return 'unknown'; }\n");
    const result = await getPrImpact(root, "pi", { workingTree: true });
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.workingTree?.unassessed).toContainEqual({ path: "excluded/opaque.ts", reason: "not_indexed" });
    const text = formatPrImpact(result);
    expect(text).toContain("not indexed; source not assessed");
    expect(text).toContain("Graph counts below are partial");
    expect(text).toContain("Risk: UNKNOWN");
    expect(text).not.toContain("Risk: LOW");
  });

  it("renders rename origins and deleted coverage before UNKNOWN risk", async () => {
    git("mv", "src/gate.ts", "src/renamed gate.ts");
    fs.rmSync(path.join(root, "src/transport.ts"));
    await prepare();
    const result = await getPrImpact(root, "pi", { workingTree: true });
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.workingTree?.entries).toContainEqual({ path: "src/renamed gate.ts", previousPath: "src/gate.ts", indexStatus: "R", worktreeStatus: " " });
    expect(result.workingTree?.unassessed).toEqual(expect.arrayContaining([
      { path: "src/gate.ts", reason: "renamed_from" },
      { path: "src/transport.ts", reason: "deleted" },
    ]));
    const text = formatPrImpact(result);
    expect(text).toContain('[R ] "src/renamed gate.ts" (from "src/gate.ts")');
    expect(text.indexOf("historical declarations not assessed")).toBeLessThan(text.indexOf("Risk: UNKNOWN"));
  });

  it("reports capped path coverage before UNKNOWN risk", async () => {
    await prepare();
    for (let index = 0; index < 201; index += 1) {
      write(`excluded/opaque-${String(index).padStart(3, "0")}.ts`, "export const opaque = true;\n");
    }
    const result = await getPrImpact(root, "pi", { workingTree: true });
    expect(result.riskLevel).toBe("UNKNOWN");
    expect(result.workingTree?.omittedFileCount).toBe(1);
    expect(result.workingTree?.entries[0].path).toBe("excluded/opaque-000.ts");
    expect(result.workingTree?.entries.at(-1)?.path).toBe("excluded/opaque-199.ts");
    const text = formatPrImpact(result);
    expect(text).toContain("Omitted paths: 1 (200-path cap; coverage unknown)");
    expect(text.indexOf("200-path cap")).toBeLessThan(text.indexOf("Risk: UNKNOWN"));
    expect(text).not.toContain("Risk: LOW");
  });
});
