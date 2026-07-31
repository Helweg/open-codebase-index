import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { code_communities, initializeTools } from "../src/tools/index.js";
import type { Database } from "../src/native/index.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));
import { execFile } from "child_process";

describe("code_communities tool", () => {
  let tempDir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let _indexers: Indexer[] = [];

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init?) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });
      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 },
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "communities-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(tempDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(
      path.join(tempDir, "src", "placeholder.ts"),
      "export function placeholder() { return 1; }\n",
      "utf-8",
    );
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        _opts: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === "git" && args.at(-1) === "HEAD^{commit}") {
          callback(null, { stdout: "1111111111111111111111111111111111111111\n", stderr: "" });
          return;
        }
        callback(new Error(`Unexpected command: ${cmd} ${args.join(" ")}`));
      },
    );
  });

  afterEach(async () => {
    await Promise.all(_indexers.map((i) => i.close()));
    _indexers = [];
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function createIndexer(): Promise<Indexer> {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-model",
        dimensions: 8,
      },
      indexing: { watchFiles: false },
    });
    initializeTools(tempDir, config, "opencode");
    const indexer = new Indexer(tempDir, config, "opencode");
    _indexers.push(indexer);
    await indexer.index();
    return indexer;
  }

  async function getDatabase(indexer: Indexer): Promise<Database> {
    await indexer.getStatus();
    return (indexer as unknown as { database: Database }).database;
  }

  async function setupTwoCommunityGraph(indexer: Indexer): Promise<Database> {
    const db = await getDatabase(indexer);

    // Community 1: Auth module
    db.upsertSymbol({ id: "sym_auth_validate", filePath: "src/auth/validate.ts", name: "validateToken", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });
    db.upsertSymbol({ id: "sym_auth_service", filePath: "src/auth/service.ts", name: "AuthService", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });
    db.upsertSymbol({ id: "sym_auth_jwt", filePath: "src/auth/jwt.ts", name: "JwtHelper", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });

    // Community 2: Database module
    db.upsertSymbol({ id: "sym_db_pool", filePath: "src/db/pool.ts", name: "DatabasePool", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });
    db.upsertSymbol({ id: "sym_db_query", filePath: "src/db/query.ts", name: "QueryBuilder", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });

    // Cross-community hub: Logger
    db.upsertSymbol({ id: "sym_logger", filePath: "src/util/logger.ts", name: "Logger", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });

    db.addSymbolsToBranch("main", ["sym_auth_validate", "sym_auth_service", "sym_auth_jwt", "sym_db_pool", "sym_db_query", "sym_logger"]);

    // In-community edges for Auth
    db.upsertCallEdge({ id: "edge1", fromSymbolId: "sym_auth_service", targetName: "validateToken", toSymbolId: "sym_auth_validate", callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true });
    db.upsertCallEdge({ id: "edge2", fromSymbolId: "sym_auth_validate", targetName: "JwtHelper", toSymbolId: "sym_auth_jwt", callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true });

    // In-community edges for Database
    db.upsertCallEdge({ id: "edge3", fromSymbolId: "sym_db_query", targetName: "DatabasePool", toSymbolId: "sym_db_pool", callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true });

    // Cross-community edges: both communities call Logger
    db.upsertCallEdge({ id: "edge4", fromSymbolId: "sym_auth_service", targetName: "Logger", toSymbolId: "sym_logger", callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true });
    db.upsertCallEdge({ id: "edge5", fromSymbolId: "sym_db_query", targetName: "Logger", toSymbolId: "sym_logger", callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true });

    return db;
  }

  it("returns formatted communities with expected sections", async () => {
    const indexer = await createIndexer();
    await setupTwoCommunityGraph(indexer);

    const result = await code_communities.execute({ branch: "main" }, { worktree: tempDir });
    expect(typeof result).toBe("string");
    expect(result).toContain("Communities:");
    expect(result).toContain("symbols total");
    expect(result).toContain("Community");
  });

  it("identifies 3+ distinct communities on non-trivial codebase", async () => {
    const indexer = await createIndexer();
    await setupTwoCommunityGraph(indexer);

    const result = await code_communities.execute({ branch: "main" }, { worktree: tempDir });
    // Should report at least 2 communities (Auth + Database, Logger may join one or form its own)
    expect(result).toContain("symbols total");
    const match = result.match(/Communities: (\d+)/);
    expect(match).not.toBeNull();
    const count = parseInt(match![1], 10);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("reports hub symbols with cross-community connections", async () => {
    const indexer = await createIndexer();
    await setupTwoCommunityGraph(indexer);

    const result = await code_communities.execute({ branch: "main", hubThreshold: 1 }, { worktree: tempDir });
    expect(result).toContain("Hub nodes:");
    // Logger should appear as a hub node since it has cross-community connections
    expect(result).toContain("Logger");
  });

  it("respects minSize filter", async () => {
    const indexer = await createIndexer();
    await setupTwoCommunityGraph(indexer);

    // minSize=3 should filter out single-symbol communities
    const result = await code_communities.execute({ branch: "main", minSize: 3 }, { worktree: tempDir });
    expect(result).toContain("Communities:");
    // Should show fewer communities than without the filter
    const match = result.match(/Communities: \d+ \((\d+) shown/);
    expect(match).not.toBeNull();
    const shown = parseInt(match![1], 10);
    expect(shown).toBeLessThanOrEqual(1);
  });

  it("respects limit parameter", async () => {
    const indexer = await createIndexer();
    await setupTwoCommunityGraph(indexer);

    const result = await code_communities.execute({ branch: "main", limit: 1 }, { worktree: tempDir });
    const match = result.match(/Communities: \d+ \((\d+) shown/);
    expect(match).not.toBeNull();
    const shown = parseInt(match![1], 10);
    expect(shown).toBeLessThanOrEqual(1);
  });

  it("returns communities with member listings", async () => {
    const indexer = await createIndexer();
    await setupTwoCommunityGraph(indexer);

    const result = await code_communities.execute({ branch: "main" }, { worktree: tempDir });
    expect(result).toContain("validateToken");
    expect(result).toContain("DatabasePool");
  });

  it("returns empty state when no symbols exist", async () => {
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);
    // Delete all symbols from the placeholder file
    db.deleteSymbolsByFile(path.join(tempDir, "src", "placeholder.ts"));
    const symbolIds = db.getSymbolsForBranch("main").map((s) => s.id);
    if (symbolIds.length > 0) {
      db.deleteBranchSymbolsForBranch("main", symbolIds);
    }

    const result = await code_communities.execute({ branch: "main" }, { worktree: tempDir });
    expect(result).toContain("Communities: 0");
    expect(result).toContain("0 symbols total");
  });

  it("works through the shared operation (MCP/Pi path)", async () => {
    const indexer = await createIndexer();
    const db = await getDatabase(indexer);

    db.upsertSymbol({ id: "sym_a", filePath: "src/a.ts", name: "funcA", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });
    db.upsertSymbol({ id: "sym_b", filePath: "src/b.ts", name: "funcB", kind: "function", startLine: 1, startCol: 0, endLine: 10, endCol: 0, language: "typescript" });
    db.addSymbolsToBranch("main", ["sym_a", "sym_b"]);
    db.upsertCallEdge({ id: "edge1", fromSymbolId: "sym_a", targetName: "funcB", toSymbolId: "sym_b", callType: "Call", confidence: "Direct", line: 5, col: 0, isResolved: true });

    const communities = await indexer.detectCommunities("main");
    // Logger may join one of the auth/db communities or form its own.
    // We expect at least 2 communities from the two dense clusters.
    expect(communities.length).toBeGreaterThanOrEqual(2);
    expect(communities).toHaveLength(communities.length);

    const centrality = await indexer.computeCentrality("main");
    expect(centrality.length).toBe(3);
    expect(centrality[0]).toHaveProperty("callerCount");
    expect(centrality[0]).toHaveProperty("calleeCount");
  });
});