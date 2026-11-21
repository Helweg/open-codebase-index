import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

it.each([
  ["project", "structural"],
  ["project", "hybrid"],
  ["global", "structural"],
  ["global", "hybrid"],
] as const)("keeps Python, Go, PHP and JS call graphs isolated (%s/%s)", async (scope, mode) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "call-graph-isolation-"));
  const project = path.join(root, "checkout");
  const index = path.join(root, "shared-index");
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: project, stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
  });
  const write = (file: string, text: string) => {
    const destination = path.join(project, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${text}\n`);
  };
  const config = parseConfig({
    scope, include: ["src/**/*.ts", "src/**/*.py", "src/**/*.go", "src/**/*.php"],
    embeddingProvider: "custom",
    customProvider: { baseUrl: "http://localhost:11434/v1", model: "branch-isolation", dimensions: 8 },
    indexing: { mode, autoIndex: false, autoGc: false, watchFiles: false, requireProjectMarker: false },
  });
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string | string[] };
    const count = Array.isArray(input) ? input.length : 1;
    return Response.json({ data: Array.from({ length: count }, () => ({ embedding: Array(8).fill(0.125) })) });
  });
  async function refresh(destination: string, healthCheck = false): Promise<void> {
    const indexer = new Indexer(project, config, "opencode", { indexPath: destination });
    try {
      if (healthCheck) await indexer.healthCheck();
      const stats = await indexer.index();
      expect(stats.failedChunks).toBe(0);
    } finally {
      await indexer.close();
    }
  }
  function snapshot(destination: string, branch: string) {
    const database = Database.openReadOnly(path.join(destination, ...(mode === "structural" ? ["structural"] : []), "codebase.db"));
    try {
      const key = database.getAllBranches().find((name) => name === branch || name.endsWith(`:${branch}`));
      if (!key) throw new Error(`Missing ${branch} catalog`);
      const symbols = database.getSymbolsForBranch(key);
      const names = new Map(symbols.map(({ id, filePath, name, kind, startLine, startCol, endLine, endCol, language }) => [id, {
        file: (path.isAbsolute(filePath) ? path.relative(project, filePath) : filePath).split(path.sep).join("/"),
        name, kind, startLine, startCol, endLine, endCol, language,
      }]));
      const sites = symbols.flatMap((symbol) => database.getCallees(symbol.id, key).map((edge) => ({
        caller: names.get(symbol.id), target: edge.toSymbolId ? names.get(edge.toSymbolId) ?? "off-branch" : null,
        name: edge.targetName, callType: edge.callType, confidence: edge.confidence,
        resolved: edge.isResolved, line: edge.line, column: edge.col,
      })));
      const phpCallers = database.getCallersWithContext("PHPHELPER", key, "Call")
        .map((edge) => ({ caller: edge.fromSymbolName, target: names.get(edge.toSymbolId ?? "")?.name }));
      return {
        ids: Object.fromEntries(symbols.map(({ name, id }) => [name, id])),
        sites,
        phpCallers,
        semantic: { declarations: [...names.values()].map((symbol) => JSON.stringify(symbol)).sort(),
          sites: sites.map((site) => JSON.stringify(site)).sort() },
      };
    } finally {
      database.close();
    }
  }
  try {
    fs.mkdirSync(project);
    git("init", "-b", "main");
    git("config", "user.email", "branches@example.invalid");
    git("config", "user.name", "Branch Isolation Test");
    git("config", "commit.gpgsign", "false");
    write("src/py/__init__.py", "# Local package");
    write("src/py/caller.py", "from .worker import work as picked\n\ndef pythonCaller():\n    return picked()");
    write("src/py/worker.py", "def work():\n    return 1");
    write("src/go/caller.go", "package lab\n\nfunc GoCaller() { Selected() }");
    write("src/go/first.go", "package lab\n\nfunc Selected() {}");
    write("src/php/local.php", "<?php\nfunction PHPHelper() {}\nfunction phpCaller() { PhPHelper(); }");
    write("src/ts/caller.ts", "import { target } from './target.js';\nexport function jsCaller() { return target(); }");
    write("src/ts/target.ts", "export function target() { return 1; }");
    git("add", ".");
    git("commit", "-m", "Main targets");

    await refresh(index);
    const main = snapshot(index, "main");
    // Relative Python imports currently resolve only with project-relative paths.
    const pythonCall = (file: string) => expect.objectContaining({
      caller: expect.objectContaining({ name: "pythonCaller" }),
      name: "picked", resolved: scope === "project",
      target: scope === "project" ? expect.objectContaining({ file }) : null,
    });
    expect(main.sites).toContainEqual(pythonCall("src/py/worker.py"));
    expect(main.sites).toContainEqual(expect.objectContaining({ caller: expect.objectContaining({ name: "GoCaller" }),
      name: "Selected", resolved: true, target: expect.objectContaining({ file: "src/go/first.go" }) }));
    expect(main.phpCallers).toEqual([{ caller: "phpCaller", target: "PHPHelper" }]);

    git("switch", "-c", "topic");
    git("rm", "src/py/worker.py", "src/go/first.go");
    write("src/py/worker/__init__.py", "def work():\n    return 2");
    write("src/go/second.go", "package lab\n\nfunc Selected() { println(2) }");
    write("src/ts/target.ts", "export function target() { return 2; }");
    git("add", ".");
    git("commit", "-m", "Topic targets");
    await refresh(index);

    const topic = snapshot(index, "topic");
    for (const name of ["pythonCaller", "GoCaller", "phpCaller", "jsCaller"]) expect(topic.ids[name]).toBe(main.ids[name]);
    expect(topic.sites).toContainEqual(pythonCall("src/py/worker/__init__.py"));
    expect(topic.sites).toContainEqual(expect.objectContaining({ caller: expect.objectContaining({ name: "GoCaller" }),
      name: "Selected", resolved: true, target: expect.objectContaining({ file: "src/go/second.go" }) }));
    expect(snapshot(index, "main")).toEqual(main);
    const cleanTopic = path.join(root, "clean-topic");
    await refresh(cleanTopic);
    expect(topic.semantic).toEqual(snapshot(cleanTopic, "topic").semantic);

    git("switch", "main");
    git("rm", "src/py/worker.py", "src/go/first.go", "src/ts/target.ts");
    await refresh(index, true);
    const deleted = snapshot(index, "main");
    for (const [caller, name] of [["pythonCaller", "picked"], ["GoCaller", "Selected"], ["jsCaller", "target"]]) {
      expect(deleted.sites).toContainEqual(expect.objectContaining({ caller: expect.objectContaining({ name: caller }),
        name, resolved: false, target: null }));
    }
    expect(snapshot(index, "topic")).toEqual(topic);
    const cleanMain = path.join(root, "clean-main");
    await refresh(cleanMain);
    expect(deleted.semantic).toEqual(snapshot(cleanMain, "main").semantic);
  } finally {
    provider.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
