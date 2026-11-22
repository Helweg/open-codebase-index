import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { prepareCallGraphRefresh } from "../src/indexer/call-graph-refresh.js";
import { Indexer } from "../src/indexer/index.js";
import { LocalModuleCallResolver } from "../src/indexer/local-module-resolution.js";
import { parseFiles } from "../src/native/index.js";
import { readIndexerGraph } from "./fixtures/indexer-graph.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ocbi-graph-refresh-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, source: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function config(mode: "structural" | "hybrid", scip = false, scope: "project" | "global" = "project") {
  return parseConfig({
    scope,
    include: ["**/*.ts", "**/*.js", "**/*.py", "**/*.go"],
    embeddingProvider: "custom",
    customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
    indexing: { mode, watchFiles: false, autoIndex: false, requireProjectMarker: false, scipTypeScript: { enabled: scip } },
  });
}

describe("call graph refresh selection", () => {
  const sources = {
    "app.ts": "import { selected } from './outer.js'; export function run() { return selected(); }",
    "outer.ts": "export * from './barrel.js';",
    "barrel.ts": "export { target as selected } from './target.js';",
    "target.ts": "export function target() {}",
    "unrelated.ts": "export function unrelated() {}",
    "legacy/common.js": "function legacy() {} module.exports = legacy;",
    "worker/caller.go": "package worker\nfunc Run() { Target() }",
    "worker/target.go": "package worker\nfunc Target() {}",
    "other/decoy.go": "package other\nfunc Target() {}",
    "pkg/__init__.py": "",
    "pkg/caller.py": "from . import target",
    "other/unrelated.py": "",
  };
  const paths = Object.keys(sources);
  const currentPaths = new Set(paths);
  const available = new Map(paths.map((file) => [file, file]));
  const structural = config("structural");

  async function prepare(previousHashes: ReadonlyMap<string, string>, snapshot: string | null, activeConfig = structural,
    current = currentPaths) {
    return prepareCallGraphRefresh({
      config: activeConfig,
      materializedRoot: root,
      files: [...current].map((file) => ({ path: path.join(root, file) })),
      currentPaths: current,
      previousHashes,
      toMaterializedPath: (file) => path.join(root, file),
      readSnapshot: () => snapshot,
      previousResolutionConfigHash: null,
      storageChanged: false,
      resolutionChanged: false,
      scipChanged: false,
      javaScriptParserChanged: false,
    });
  }

  async function seedProof() {
    write("legacy/package.json", '{"type":"commonjs"}');
    const first = await prepare(new Map(), null);
    const resolver = new LocalModuleCallResolver({
      filePaths: paths, loadModule: async () => undefined,
      pathAliasesForImporter: (file) => first.resolution.pathAliasCache.getPathAliasesForImporter(file),
      workspacePackages: first.resolution.workspacePackages,
    });
    const previousHashes = new Map<string, string>();
    for (const parsed of parseFiles(Object.entries(sources).map(([file, content]) => ({ path: file, content })),
      undefined, undefined, false, true)) {
      previousHashes.set(parsed.path, parsed.hash);
      await first.recordParsedSource(parsed.path, parsed.hash, parsed, resolver);
    }
    const published = first.snapshotPublication();
    if (published.action !== "replace") throw new Error("Fixture must publish complete dependency proof");
    return { previousHashes, snapshot: published.value };
  }

  it("follows transitive re-exports without scheduling unrelated JS/TS sources", async () => {
    const { previousHashes, snapshot } = await seedProof();
    const refresh = await prepare(previousHashes, snapshot);
    refresh.recordSourceChange("barrel.ts");
    expect(await refresh.selectAdditionalFiles(available, new Set(["barrel.ts"]))).toEqual(["app.ts", "outer.ts"]);
  });

  it("selects only callers in the affected Go directory and refreshes Python conservatively", async () => {
    const refresh = await prepare(new Map(), null, config("hybrid"));
    refresh.recordSourceChange("worker/target.go");
    refresh.recordSourceChange("pkg/__init__.py");
    expect(await refresh.selectAdditionalFiles(available, new Set(["worker/target.go", "pkg/__init__.py"])))
      .toEqual(["pkg/caller.py", "other/unrelated.py", "worker/caller.go"]);
  });

  it("invalidates old proof when an unchanged dependent cannot be parsed", async () => {
    const { previousHashes, snapshot } = await seedProof();
    const refresh = await prepare(previousHashes, snapshot);
    await refresh.selectAdditionalFiles(available, new Set(["outer.ts"]));
    refresh.beginParseBatch([{ storedPath: "outer.ts" }]);
    expect(refresh.snapshotPublication()).toEqual({ action: "invalidate" });
    const next = await prepare(previousHashes, null);
    next.recordSourceChange("barrel.ts");
    expect(await next.selectAdditionalFiles(available, new Set(["barrel.ts"]))).toContain("unrelated.ts");
  });

  it("rejects a snapshot missing proof for a previously indexed source", async () => {
    const { previousHashes, snapshot } = await seedProof();
    previousHashes.set("new.ts", "prior-source-hash");
    const current = new Set([...currentPaths, "new.ts"]);
    const refresh = await prepare(previousHashes, snapshot, structural, current);
    expect(await refresh.selectAdditionalFiles(available, new Set())).toContain("unrelated.ts");
  });

  it("refreshes broadly after a nearer manifest changes package format", async () => {
    const { previousHashes, snapshot } = await seedProof();
    write("legacy/package.json", '{"type":"module"}');
    const refresh = await prepare(previousHashes, snapshot);
    expect(await refresh.selectAdditionalFiles(available, new Set())).toContain("unrelated.ts");
  });

  it.each([
    ["hybrid", false, "project"],
    ["structural", true, "project"],
    ["structural", false, "global"],
  ] as const)("does not prune JS/TS in %s mode (SCIP %s, %s scope)", async (mode, scip, scope) => {
    const { previousHashes, snapshot } = await seedProof();
    const refresh = await prepare(previousHashes, snapshot, config(mode, scip, scope));
    refresh.recordSourceChange("barrel.ts");
    expect(await refresh.selectAdditionalFiles(available, new Set(["barrel.ts"])))
      .toEqual(["app.ts", "outer.ts", "target.ts", "unrelated.ts", "legacy/common.js"]);
  });
});

function readEmbeddingInputs(body: RequestInit["body"]): string[] {
  const request: unknown = JSON.parse(String(body));
  if (request && typeof request === "object" && "input" in request) {
    if (typeof request.input === "string") return [request.input];
    if (Array.isArray(request.input) && request.input.every((input: unknown) => typeof input === "string")) {
      return request.input;
    }
  }
  throw new Error("Expected string embedding inputs");
}

it.each(["structural", "hybrid"] as const)("matches a clean graph after JS/TS, Python, and Go dependency edits (%s)", async (mode) => {
  const capturedInputs: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const inputs = readEmbeddingInputs(init?.body);
    for (const input of inputs) capturedInputs.push(input);
    return new Response(JSON.stringify({ data: inputs.map(() => ({ embedding: Array(8).fill(0.125) })) }));
  });
  write("app.ts", "import { selected } from './outer.js'; export function runJs() { return selected(); }");
  write("outer.ts", "export * from './barrel.js';");
  write("barrel.ts", "export { left as selected } from './left.js';");
  write("left.ts", "export function left() { return 1; }");
  write("right.ts", "export function right() { return 2; }");
  write("pkg/__init__.py", "");
  write("pkg/caller.py", "from .formatting import helper\n\ndef run_python():\n    return helper()\n");
  write("pkg/formatting.py", "def helper():\n    return 1\n");
  write("pkg/decoy.py", "def helper():\n    return 3\n");
  write("worker/caller.go", "package worker\nfunc RunGo() { Target() }\n");
  write("worker/target.go", "package worker\nfunc Target() {}\n");
  write("other/decoy.go", "package other\nfunc Target() {}\n");

  const activeConfig = config(mode);
  const indexer = new Indexer(root, activeConfig, "opencode", { indexPath: path.join(root, "incremental-index") });
  let cleanSequence = 0;
  let previousInputs = new Set<string>();
  async function compareWithClean() {
    const clean = new Indexer(root, activeConfig, "opencode", { indexPath: path.join(root, `clean-${cleanSequence++}`) });
    try {
      const incrementalInputs = capturedInputs.splice(0);
      const incremental = await readIndexerGraph(indexer, root);
      await clean.index();
      expect(incremental).toEqual(await readIndexerGraph(clean, root));
      // A clean rebuild supplies the current corpus. Only texts absent from the
      // previous corpus can require new embeddings on these edits.
      const currentInputs = new Set(capturedInputs.splice(0));
      if (mode === "hybrid") {
        expect(incrementalInputs.length).toBeGreaterThan(0);
        expect(new Set(incrementalInputs).size).toBe(incrementalInputs.length);
        for (const input of incrementalInputs) {
          expect(currentInputs.has(input)).toBe(true);
          expect(previousInputs.has(input)).toBe(false);
        }
      } else {
        expect(incrementalInputs).toEqual([]);
        expect(currentInputs.size).toBe(0);
      }
      previousInputs = currentInputs;
      return incremental;
    } finally {
      await clean.close();
    }
  }

  try {
    await indexer.index();
    previousInputs = new Set(capturedInputs.splice(0));
    const initial = await readIndexerGraph(indexer, root);
    expect(initial.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: "runJs", resolved: true, target: expect.objectContaining({ name: "left" }) }),
      expect.objectContaining({ caller: "run_python", name: "helper", resolved: true }),
      expect.objectContaining({ caller: "RunGo", name: "Target", resolved: true }),
    ]));

    write("barrel.ts", "export { right as selected } from './right.js';");
    write("pkg/formatting/__init__.py", "def helper():\n    return 2\n");
    fs.unlinkSync(path.join(root, "worker/target.go"));
    await indexer.index();
    expect((await compareWithClean()).edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: "runJs", resolved: true, target: expect.objectContaining({ file: "right.ts", name: "right" }) }),
      expect.objectContaining({ caller: "run_python", name: "helper", resolved: false, target: null }),
      expect.objectContaining({ caller: "RunGo", name: "Target", resolved: false, target: null }),
    ]));

    fs.unlinkSync(path.join(root, "pkg/formatting.py"));
    write("worker/replacement.go", "package worker\n\nfunc Target() {}\n");
    await indexer.index();
    expect((await compareWithClean()).edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: "run_python", resolved: true, target: expect.objectContaining({ file: "pkg/formatting/__init__.py" }) }),
      expect.objectContaining({ caller: "RunGo", resolved: true, target: expect.objectContaining({ file: "worker/replacement.go" }) }),
    ]));

    // Change existing targets without touching either caller or adding/deleting files.
    write("pkg/formatting/__init__.py", "\n\ndef helper():\n    return 4\n");
    write("worker/replacement.go", "package other\n\nfunc Target() {}\n");
    await indexer.index();
    expect((await compareWithClean()).edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caller: "run_python", name: "helper", resolved: true,
        target: expect.objectContaining({ file: "pkg/formatting/__init__.py", span: [3, 0, 4, 12] }),
      }),
      expect.objectContaining({ caller: "RunGo", name: "Target", resolved: false, target: null }),
    ]));
  } finally {
    await indexer.close();
  }
});
