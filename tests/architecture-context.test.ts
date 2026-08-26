import type { SymbolData } from "../src/native/index.js";

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildArchitectureContext,
  selectArchitectureFocusedSymbols,
} from "../src/tools/architecture-context.js";
import { getRecentGitActivity } from "../src/tools/visualize/activity.js";
import { transformForVisualization } from "../src/tools/visualize/transform.js";
import { estimateTokens } from "../src/utils/cost.js";

function symbol(id: string, name: string, filePath: string, startLine = 2): SymbolData {
  return {
    id,
    name,
    filePath,
    kind: "function",
    startLine,
    startCol: 0,
    endLine: startLine + 2,
    endCol: 0,
    language: "typescript",
  };
}

describe("architecture_context", () => {
  let tempDir: string;
  let apiPath: string;
  let storePath: string;
  let fixturePath: string;
  let symbols: SymbolData[];
  let communities: Array<{
    symbolId: string;
    symbolName: string;
    filePath: string;
    communityId: number;
    communityLabel: string;
    crossCommunityConnections: number;
  }>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "architecture-context-"));
    mkdirSync(path.join(tempDir, "src"), { recursive: true });
    mkdirSync(path.join(tempDir, "tests"), { recursive: true });
    apiPath = path.join(tempDir, "src", "api.ts");
    storePath = path.join(tempDir, "src", "store.ts");
    fixturePath = path.join(tempDir, "tests", "fixture.ts");
    writeFileSync(apiPath, "// Validates API tokens before requests enter the application.\nexport function Api(token: string) { return token.length > 0; }\n");
    writeFileSync(storePath, "// Persists validated records in the local store.\nexport function Store() { return new Map(); }\n");
    writeFileSync(fixturePath, "// Supplies isolated test data.\nexport function Fixture() { return {}; }\n");
    symbols = [
      symbol("a", "Api", apiPath),
      symbol("b", "Store", storePath),
      symbol("c", "Fixture", fixturePath),
    ];
    communities = [
      { symbolId: "a", symbolName: "Api", filePath: apiPath, communityId: 1, communityLabel: "API", crossCommunityConnections: 1 },
      { symbolId: "b", symbolName: "Store", filePath: storePath, communityId: 2, communityLabel: "Storage", crossCommunityConnections: 1 },
      { symbolId: "c", symbolName: "Fixture", filePath: fixturePath, communityId: 3, communityLabel: "Tests", crossCommunityConnections: 0 },
    ];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function build(input: Parameters<typeof buildArchitectureContext>[0] = {}) {
    return buildArchitectureContext(
      input,
      communities,
      [
        { symbolId: "a", symbolName: "Api", filePath: apiPath, callerCount: 2, calleeCount: 1, totalConnections: 3 },
        { symbolId: "b", symbolName: "Store", filePath: storePath, callerCount: 1, calleeCount: 2, totalConnections: 3 },
      ],
      [{
        communityA: 1,
        communityB: 2,
        count: 2,
        relationships: [{
          fromSymbolId: "a",
          fromSymbolName: "Api",
          fromFilePath: apiPath,
          toSymbolId: "b",
          toSymbolName: "Store",
          toFilePath: storePath,
        }],
      }],
      {
        projectRoot: tempDir,
        sourceSymbols: symbols,
        graphCoverage: { totalEdges: 2, resolvedEdges: 1 },
      },
    );
  }

  it("is deterministic and derives responsibility evidence from cited source", () => {
    const first = build();
    const second = build();

    expect(first).toEqual(second);
    expect(first.text).toContain("Source-backed responsibility: Validates API tokens before requests enter the application.");
    expect(first.text).toContain("Api at src/api.ts:2");
    expect(first.text).toContain("Api (src/api.ts) -> Store (src/store.ts)");
    expect(first.text).toContain("implementation_lookup");
    expect(first.modules.every((module) => module.evidence.length > 0)).toBe(true);
    expect(first.modules.every((module) => module.evidence.some((evidence) => evidence.excerpt))).toBe(true);
  });

  it("keeps relative directory scope strict against absolute indexed paths", () => {
    const result = build({ directory: "src" });

    expect(result.modules.map((module) => module.label)).toEqual(["API", "Storage"]);
    expect(result.text).not.toContain("Fixture");
    expect(result.boundaries).toHaveLength(1);
    expect(result.boundaries[0]?.connections).toBe(1);
  });

  it("uses query evidence to exclude unrelated modules and does not substitute a global map on a miss", () => {
    const focused = buildArchitectureContext(
      { query: "token validation" },
      communities,
      [],
      [],
      { projectRoot: tempDir, sourceSymbols: symbols, focusedSymbols: [symbols[0]] },
    );
    expect(focused.modules.map((module) => module.label)).toEqual(["API"]);
    expect(focused.text).not.toContain("Store");
    expect(focused.text).not.toContain("Fixture");

    const missed = buildArchitectureContext(
      { query: "nonexistent subsystem" },
      communities,
      [],
      [],
      { projectRoot: tempDir, sourceSymbols: symbols, focusedSymbols: [] },
    );
    expect(missed.modules).toEqual([]);
    expect(missed.coverage.note).toContain("No global architecture is substituted");
  });

  it("falls back to source-directory modules without inventing relationships when graph data is sparse", () => {
    const result = buildArchitectureContext(
      {},
      [],
      [],
      [],
      { projectRoot: tempDir, sourceSymbols: symbols, graphCoverage: { totalEdges: 0, resolvedEdges: 0 } },
    );

    expect(result.modules.length).toBeGreaterThan(0);
    expect(result.modules.every((module) => module.source === "directory")).toBe(true);
    expect(result.coverage.sourceFallback).toBe(true);
    expect(result.coverage.graphSparse).toBe(true);
    expect(result.boundaries).toEqual([]);
    expect(result.text).toContain("no relationship is inferred");
  });

  it("enforces the requested response token budget while preserving whole cited claims", () => {
    writeFileSync(apiPath, `// ${"long responsibility evidence ".repeat(80)}\nexport function Api() { return true; }\n`);
    const result = build({ tokenBudget: 256, depth: 3, includeRecentActivity: true });

    expect(result.tokenBudget).toBe(256);
    expect(result.tokenEstimate).toBe(estimateTokens(result.text));
    expect(result.tokenEstimate).toBeLessThanOrEqual(256);
    expect(result.text).toContain("Recommended next steps:");
  });

  it("keeps minimum token budgets bounded for adversarially long focus inputs", () => {
    const result = buildArchitectureContext(
      {
        query: "architecture focus ".repeat(100),
        directory: `src/${"nested/".repeat(100)}`,
        tokenBudget: 128,
        includeRecentActivity: true,
      },
      [],
      [],
      [],
    );

    expect(result.tokenEstimate).toBeLessThanOrEqual(128);
    expect(result.text).toContain("…");
    expect(result.text).toContain("No global architecture is substituted");
  });

  it("renders optional recent activity with commit, date, summary, and files", () => {
    const result = buildArchitectureContext(
      { includeRecentActivity: true },
      communities,
      [],
      [],
      {
        projectRoot: tempDir,
        sourceSymbols: symbols,
        recentActivity: [{
          title: "API moved recently",
          date: "2026-08-25",
          commit: "abc1234",
          summary: "12 changed lines across 1 indexed file.",
          filePaths: [apiPath],
        }],
      },
    );

    expect(result.text).toContain("[commit abc1234, 2026-08-25]");
    expect(result.text).toContain("Files: src/api.ts");
    expect(result.recentActivity[0]?.commit).toBe("abc1234");
  });

  it("selects exact or overlapping symbols from high-ranked query evidence", () => {
    const nested = symbol("nested", "nestedHelper", apiPath, 3);
    const selected = selectArchitectureFocusedSymbols([
      { filePath: apiPath, startLine: 2, endLine: 2, score: 0.9, name: "Api" },
      { filePath: storePath, startLine: 2, endLine: 3, score: 0.8 },
      { filePath: fixturePath, startLine: 2, endLine: 3, score: 0.1 },
    ], [...symbols, nested], 2);

    expect(selected.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("reads actual Git activity and returns no graph-derived substitute", () => {
    execFileSync("git", ["init", "-q", tempDir]);
    execFileSync("git", ["-C", tempDir, "config", "user.email", "architecture@example.com"]);
    execFileSync("git", ["-C", tempDir, "config", "user.name", "Architecture Test"]);
    execFileSync("git", ["-C", tempDir, "add", "src/api.ts"]);
    execFileSync("git", ["-C", tempDir, "commit", "-q", "-m", "feat: update API validation"]);

    const data = transformForVisualization([symbols[0]], [], { includeOrphans: true });
    const activity = getRecentGitActivity(data, tempDir);

    expect(activity).toHaveLength(1);
    expect(activity[0]?.source).toMatch(/^commit [0-9a-f]+$/);
    expect(activity[0]?.summary).toContain("Latest: feat: update API validation");
    expect(getRecentGitActivity(data, path.join(tempDir, "missing"))).toEqual([]);
  });
});
