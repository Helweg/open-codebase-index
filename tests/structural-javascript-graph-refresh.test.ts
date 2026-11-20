import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database, hashContent, hashFile } from "../src/native/index.js";

const config = parseConfig({
  scope: "project",
  include: ["**/*.ts", "**/*.tsx", "**/*.js"],
  indexing: {
    mode: "structural", scipTypeScript: { enabled: false }, watchFiles: false,
    autoIndex: false, autoGc: false, requireProjectMarker: false,
  },
});

function legacyGraphMetadata(branch: string): string[] {
  const suffix = hashContent(branch).slice(0, 24);
  return [`index.javaScriptGraphDependencies.${suffix}`, `index.javaScriptGraphOwnership.${suffix}`];
}

function catalogPath(indexRoot: string): string {
  return path.join(indexRoot, "structural", "codebase.db");
}

function persistedGraph(indexRoot: string, branch: string) {
  const database = Database.openReadOnly(catalogPath(indexRoot));
  try {
    const symbols = database.getSymbolsForBranch(branch);
    const location = (symbol: (typeof symbols)[number]) => ({
      file: symbol.filePath, name: symbol.name, kind: symbol.kind, language: symbol.language,
      span: [symbol.startLine, symbol.startCol, symbol.endLine, symbol.endCol],
    });
    const declarations = new Map(symbols.map((symbol) => [symbol.id, location(symbol)]));
    const sites = symbols.flatMap((symbol) => database.getCallees(symbol.id, branch).map((edge) => ({
      caller: declarations.get(symbol.id),
      name: edge.targetName,
      target: edge.toSymbolId ? declarations.get(edge.toSymbolId) ?? "off-branch" : null,
      type: edge.callType, confidence: edge.confidence, resolved: edge.isResolved,
      line: edge.line, col: edge.col,
    })));
    return {
      declarations: [...declarations.values()].map((symbol) => JSON.stringify(symbol)).sort(),
      sites: sites.map((site) => JSON.stringify(site)).sort().map((site) => JSON.parse(site) as (typeof sites)[number]),
    };
  } finally {
    database.close();
  }
}

describe("project structural JS/TS graph refresh", () => {
  let temp: string;
  let project: string;
  let indexRoot: string;
  let cleanSequence: number;

  function put(file: string, text: string): void {
    const destination = path.join(project, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${text}\n`);
  }

  function git(...args: string[]): string {
    return execFileSync("git", args, {
      cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
    }).trim();
  }

  async function refresh(root = indexRoot) {
    const indexer = new Indexer(project, config, "jcode", { indexPath: root });
    try {
      return await indexer.index();
    } finally {
      await indexer.close();
    }
  }

  async function migrationRequired() {
    const reader = new Indexer(project, config, "jcode", { indexPath: indexRoot });
    try {
      return (await reader.getStatus()).migrationRequired;
    } finally {
      await reader.close();
    }
  }

  async function cleanGraph(branch: string) {
    const fresh = path.join(temp, `clean-${cleanSequence++}`);
    expect(git("branch", "--show-current")).toBe(branch);
    await refresh(fresh);
    return persistedGraph(fresh, branch);
  }

  function barrel(target: "left" | "right" | "third"): void {
    put("barrel.ts", `export { ${target} as selected } from './${target}.js';`);
  }

  function callFrom(branch: string, caller: string, name: string) {
    const matches = persistedGraph(indexRoot, branch).sites.filter((site) =>
      site.caller?.name === caller && site.name === name && site.type === "Call"
    );
    expect(matches).toHaveLength(1);
    return matches[0];
  }

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-structural-js-graph-"));
    project = path.join(temp, "project");
    indexRoot = path.join(temp, "index");
    cleanSequence = 0;
    fs.mkdirSync(project);
    git("init", "-b", "main");
    git("config", "user.email", "structural@example.com");
    git("config", "user.name", "Structural Test");
    git("config", "commit.gpgsign", "false");
    put("app.js", "import { selected } from './outer.js';\nexport function run() { return selected() + absent(); }");
    put("outer.ts", "export * from './barrel.js';");
    put("left.ts", "export function left() { return 1; }");
    put("right.ts", "export function right() { return 2; }");
    put("third.ts", "export function third() { return 3; }");
    barrel("left");
    git("add", ".");
    git("commit", "-m", "main");
  });

  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  async function seedBothBranches(): Promise<void> {
    await refresh();
    git("switch", "-c", "other");
    barrel("right");
    git("add", "barrel.ts");
    git("commit", "-m", "Other barrel target");
    await refresh();
    git("switch", "main");
  }

  it("persists different targets for identical callers and refreshes only the active branch's graph", async () => {
    await seedBothBranches();
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: true, target: { file: "left.ts" } });
    expect(callFrom("other", "run", "selected")).toMatchObject({ resolved: true, target: { file: "right.ts" } });
    const otherBefore = persistedGraph(indexRoot, "other");
    barrel("third");
    await refresh();
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: true, target: { file: "third.ts" } });
    expect(callFrom("main", "run", "absent")).toMatchObject({ resolved: false, target: null });
    expect(persistedGraph(indexRoot, "main")).toEqual(await cleanGraph("main"));
    expect(persistedGraph(indexRoot, "other")).toEqual(otherBefore);
    git("restore", "barrel.ts");
    git("switch", "other");
    expect(persistedGraph(indexRoot, "other")).toEqual(await cleanGraph("other"));
  });

  it("upgrades a legacy shared caller on ordinary refresh, without rebuilding or overwriting the other branch", async () => {
    await seedBothBranches();
    // Represent the previous on-disk ownership: both branch memberships reference one
    // source-derived caller ID and its edge points to the last-indexed branch.
    const db = new Database(catalogPath(indexRoot));
    try {
      const branches = ["main", "other"];
      const callers = branches.map((branch) => db.getSymbolsForFiles(["app.js"], branch).find(({ name }) => name === "run")!);
      const other = callers[1];
      const legacyId = `sym_${hashContent(`app.js:${other.name}:${other.kind}:${other.startLine}:${other.startCol}:${hashFile(path.join(project, "app.js"))}`).slice(0, 16)}`;
      db.upsertSymbol({ ...other, id: legacyId });
      db.upsertCallEdgesBatch(db.getCallees(other.id, "other").map((edge) => ({
        ...edge,
        id: `edge_${hashContent(`${legacyId}:${edge.targetName}:${edge.line}:${edge.col}`).slice(0, 16)}`,
        fromSymbolId: legacyId,
      })));
      for (const [i, branch] of branches.entries()) {
        db.deleteBranchSymbolsForBranch(branch, [callers[i].id]);
        db.addSymbolsToBranch(branch, [legacyId]);
        for (const key of legacyGraphMetadata(branch)) db.deleteMetadata(key);
      }
      db.gcOrphanSymbols();
      db.gcOrphanCallEdges();
    } finally {
      db.close();
    }
    expect(callFrom("main", "run", "selected")).toMatchObject({ target: "off-branch" });
    expect(await migrationRequired()).toBe(true);
    const otherBefore = persistedGraph(indexRoot, "other");
    await refresh();
    expect(await migrationRequired()).toBe(false);
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: true, target: { file: "left.ts" } });
    expect(persistedGraph(indexRoot, "main")).toEqual(await cleanGraph("main"));
    expect(persistedGraph(indexRoot, "other")).toEqual(otherBefore);
    git("switch", "other");
    expect(await migrationRequired()).toBe(true);
    await refresh();
    expect(await migrationRequired()).toBe(false);
    expect(persistedGraph(indexRoot, "other")).toEqual(await cleanGraph("other"));
  });

  it("re-resolves a deleted module through its barrel and observes a newly created alternative", async () => {
    await refresh();
    fs.unlinkSync(path.join(project, "left.ts"));
    await refresh();
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: false, target: null });
    expect(persistedGraph(indexRoot, "main")).toEqual(await cleanGraph("main"));
    put("left.tsx", "export function left() { return 4; }");
    await refresh();
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: true, target: { file: "left.tsx" } });
    expect(persistedGraph(indexRoot, "main")).toEqual(await cleanGraph("main"));
  });

  it("drops stale resolution during an invalid parse and recovers after the barrel is repaired", async () => {
    await refresh();
    put("barrel.ts", "export { selected as");
    await refresh();
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: false, target: null });
    expect(persistedGraph(indexRoot, "main")).toEqual(await cleanGraph("main"));
    barrel("right");
    await refresh();
    expect(callFrom("main", "run", "selected")).toMatchObject({ resolved: true, target: { file: "right.ts" } });
    expect(persistedGraph(indexRoot, "main")).toEqual(await cleanGraph("main"));
  });
});
