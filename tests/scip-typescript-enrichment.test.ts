import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { prepareScipTypeScriptEnrichment } from "../src/indexer/scip-typescript-enrichment.js";
import type { CallEdgeData, SymbolData } from "../src/native/types.js";

function writeDecoder(root: string, payload: unknown): string {
  const decoder = path.join(root, "fake decoder.js");
  fs.writeFileSync(decoder, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
  fs.chmodSync(decoder, 0o755);
  return decoder;
}

function symbols(): SymbolData[] {
  return [
    { id: "source", filePath: "src/main.ts", name: "run", kind: "function_declaration", startLine: 1, startCol: 0, endLine: 3, endCol: 1, language: "typescript" },
    { id: "target", filePath: "src/service.ts", name: "greet", kind: "method_definition", startLine: 1, startCol: 0, endLine: 1, endCol: 55, language: "typescript" },
  ];
}

function edge(resolved = false): CallEdgeData {
  return {
    id: "edge", fromSymbolId: "source", targetName: "greet", toSymbolId: resolved ? "other" : undefined,
    callType: "MethodCall", confidence: "Direct", line: 2, col: 22, isResolved: resolved,
  };
}

function relevantFiles(root: string): Array<{ path: string }> {
  return [
    { path: path.join(root, "src", "main.ts") },
    { path: path.join(root, "src", "service.ts") },
  ];
}

describe("SCIP TypeScript enrichment", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "scip-enrichment-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export function run() {\n  return \"🚀\" + svc.greet();\n}\n");
    fs.writeFileSync(path.join(root, "src", "service.ts"), "export class Service { greet(): string { return 'ok'; } }\n");
    fs.writeFileSync(path.join(root, "index.scip"), "fixture");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("does not invoke a decoder when disabled", async () => {
    const prepared = await prepareScipTypeScriptEnrichment({
      enabled: false, materializedProjectRoot: root, indexFile: "index.scip",
      decoderCommand: path.join(root, "missing"), timeoutMs: 5000, maxOutputBytes: 1024 * 1024,
      requireFreshIndex: false, relevantFiles: [],
    });
    expect(prepared.outcome).toBe("disabled");
  });

  it("resolves an existing unresolved edge using real scip-typescript JSON shape and UTF-16 columns", async () => {
    const payload = {
      metadata: { tool_info: { name: "scip-typescript", version: "0.4.0" }, project_root: pathToFileURL(root).href, text_document_encoding: 1 },
      documents: [
        { relative_path: "src/main.ts", occurrences: [
          { range: [1, 19, 24], TypedRange: null, symbol: "pkg/Service#greet().", TypedEnclosingRange: null },
        ] },
        { relative_path: "src/service.ts", occurrences: [
          { range: [0, 23, 28], TypedRange: null, symbol: "pkg/Service#greet().", symbol_roles: 1, TypedEnclosingRange: null },
        ] },
      ],
    };
    const decoder = writeDecoder(root, payload);
    const prepared = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: decoder,
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    expect(prepared.outcome).toBe("ready");
    const result = prepared.apply([edge()], symbols());
    expect(result.matchedEdges).toBe(1);
    expect(result.edges[0]).toMatchObject({ toSymbolId: "target", isResolved: true });
  });

  it("never replaces an already resolved edge", async () => {
    const payload = {
      metadata: { tool_info: { name: "scip-typescript", version: "0.4.0" }, project_root: pathToFileURL(root).href },
      documents: [
        { relative_path: "src/main.ts", occurrences: [{ range: [1, 19, 24], symbol: "pkg/Service#greet()." }] },
        { relative_path: "src/service.ts", occurrences: [{ range: [0, 23, 28], symbol: "pkg/Service#greet().", symbol_roles: 1 }] },
      ],
    };
    const prepared = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: writeDecoder(root, payload),
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    const result = prepared.apply([edge(true)], symbols());
    expect(result.edges[0].toSymbolId).toBe("other");
    expect(result.disagreements).toBe(1);
  });

  it("rejects stale indexes and symlink escapes", async () => {
    const source = path.join(root, "src", "main.ts");
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(source, future, future);
    const stale = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: "missing",
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: true, relevantFiles: [{ path: source }],
    });
    expect(stale.outcome).toBe("stale");

    const external = fs.mkdtempSync(path.join(os.tmpdir(), "scip-external-"));
    try {
      fs.writeFileSync(path.join(external, "index.scip"), "outside");
      fs.symlinkSync(path.join(external, "index.scip"), path.join(root, "linked.scip"));
      const escaped = await prepareScipTypeScriptEnrichment({
        enabled: true, materializedProjectRoot: root, indexFile: "linked.scip", decoderCommand: "missing",
        timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: [],
      });
      expect(escaped.outcome).toBe("rejected");
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it("fails open for decoder errors and oversized output", async () => {
    const failed = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: path.join(root, "missing"),
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: [],
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.apply([edge()], symbols()).edges[0].isResolved).toBe(false);

    const decoder = path.join(root, "large.js");
    fs.writeFileSync(decoder, "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(2 * 1024 * 1024));\n");
    fs.chmodSync(decoder, 0o755);
    const oversized = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: decoder,
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: [],
    });
    expect(oversized.outcome).toBe("failed");
  });

  it("rejects missing project roots and unsupported typed ranges", async () => {
    const missingRoot = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip",
      decoderCommand: writeDecoder(root, { documents: [] }), timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    expect(missingRoot.outcome).toBe("rejected");

    const typed = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip",
      decoderCommand: writeDecoder(root, {
        metadata: { tool_info: { name: "scip-typescript", version: "0.4.0" }, project_root: pathToFileURL(root).href },
        documents: [
          { relative_path: "src/main.ts", occurrences: [{ range: [1, 19, 24], TypedRange: { start: {} }, symbol: "pkg/Service#greet()." }] },
          { relative_path: "src/service.ts", occurrences: [{ range: [0, 23, 28], symbol: "pkg/Service#greet().", symbol_roles: 1 }] },
        ],
      }), timeoutMs: 5000, maxOutputBytes: 1024 * 1024,
      requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    expect(typed.apply([edge()], symbols()).matchedEdges).toBe(0);
  });

  it("fingerprints SCIP bytes and rejects enclosing-body definition fallbacks", async () => {
    const payload = {
      metadata: { tool_info: { name: "scip-typescript", version: "0.4.0" }, project_root: pathToFileURL(root).href },
      documents: [
        { relative_path: "src/main.ts", occurrences: [{ range: [1, 19, 24], symbol: "pkg/localValue." }] },
        { relative_path: "src/service.ts", occurrences: [{ range: [0, 40, 42], symbol: "pkg/localValue.", symbol_roles: 1 }] },
      ],
    };
    const decoder = writeDecoder(root, payload);
    const first = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: decoder,
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    const originalStat = fs.statSync(path.join(root, "index.scip"));
    fs.writeFileSync(path.join(root, "index.scip"), "changed");
    fs.utimesSync(path.join(root, "index.scip"), originalStat.atime, originalStat.mtime);
    const second = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: decoder,
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.apply([edge()], symbols()).matchedEdges).toBe(0);
  });

  it("uses fixed decoder argv and propagates cancellation", async () => {
    const argvDecoder = path.join(root, "argv decoder.js");
    const expectedIndex = fs.realpathSync(path.join(root, "index.scip"));
    const payload = { metadata: { project_root: pathToFileURL(root).href }, documents: [] };
    fs.writeFileSync(argvDecoder, `#!/usr/bin/env node\nif (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["print", "--json", expectedIndex]))}) process.exit(19);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
    fs.chmodSync(argvDecoder, 0o755);
    const prepared = await prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: argvDecoder,
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false, relevantFiles: relevantFiles(root),
    });
    expect(prepared.outcome).toBe("ready");

    const hangingDecoder = path.join(root, "hanging decoder.js");
    fs.writeFileSync(hangingDecoder, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    fs.chmodSync(hangingDecoder, 0o755);
    const controller = new AbortController();
    const pending = prepareScipTypeScriptEnrichment({
      enabled: true, materializedProjectRoot: root, indexFile: "index.scip", decoderCommand: hangingDecoder,
      timeoutMs: 5000, maxOutputBytes: 1024 * 1024, requireFreshIndex: false,
      relevantFiles: relevantFiles(root), signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("isolates enabled SCIP edges across normal git checkouts without branch overrides", async () => {
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "caller.ts"), "import { Service } from './target.js';\nconst service = new Service();\nexport function caller() { return service.greet(); }\n");
    fs.writeFileSync(path.join(repo, "src", "target.ts"), "export class Service { greet() { return 'a'; } }\n");
    fs.writeFileSync(path.join(repo, "package.json"), "{\"private\":true,\"type\":\"module\"}\n");
    fs.writeFileSync(path.join(repo, "index.scip"), "fixture");
    const decoder = writeDecoder(repo, {
      metadata: { tool_info: { name: "scip-typescript", version: "0.4.0" }, project_root: pathToFileURL(repo).href },
      documents: [
        { relative_path: "src/caller.ts", occurrences: [{ range: [2, 42, 47], symbol: "pkg/Service#greet()." }] },
        { relative_path: "src/target.ts", occurrences: [{ range: [0, 23, 28], symbol: "pkg/Service#greet().", symbol_roles: 1 }] },
      ],
    });
    execFileSync("git", ["init", "-b", "branch-a"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "scip-test@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "SCIP Test"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "branch a"], { cwd: repo });
    execFileSync("git", ["checkout", "-b", "branch-b"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "src", "target.ts"), "export class Service { greet() { return 'b'; } }\n");
    execFileSync("git", ["add", "src/target.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "branch b"], { cwd: repo });
    execFileSync("git", ["checkout", "branch-a"], { cwd: repo });

    const indexPath = path.join(root, "shared-index");
    const config = (enabled: boolean, decoderCommand: string) => parseConfig({
      embeddingProvider: "auto",
      scope: "project",
      include: ["**/*.ts", "package.json"],
      exclude: ["**/node_modules/**", "**/.codebase-index/**"],
      indexing: {
        mode: "structural",
        scipTypeScript: {
          enabled,
          indexFile: "index.scip",
          decoderCommand,
          requireFreshIndex: false,
        },
      },
    });
    const targetState = async (indexer: Indexer): Promise<{ resolved: boolean; targetId?: string }> => {
      const caller = (await indexer.getCallGraphSymbols()).find((symbol) => symbol.name === "caller");
      expect(caller).toBeDefined();
      const call = (await indexer.getCallees(caller!.id)).find((edge) => edge.targetName === "greet");
      expect(call).toBeDefined();
      return { resolved: call!.isResolved, targetId: call!.toSymbolId };
    };

    let indexer = new Indexer(repo, config(false, decoder), "jcode", { indexPath });
    await indexer.index();
    expect((await targetState(indexer)).resolved).toBe(false);
    await indexer.close();

    indexer = new Indexer(repo, config(true, decoder), "jcode", { indexPath });
    await indexer.index();
    const branchA = await targetState(indexer);
    await indexer.close();
    expect(branchA.resolved).toBe(true);

    indexer = new Indexer(repo, config(false, decoder), "jcode", { indexPath });
    await expect(indexer.getIndexFreshness()).resolves.toMatchObject({
      current: false,
      reason: "metadata-changed",
    });
    await indexer.close();

    indexer = new Indexer(repo, config(true, path.join(repo, "missing-decoder")), "jcode", { indexPath });
    await expect(indexer.getIndexFreshness()).resolves.toMatchObject({
      current: false,
      reason: "metadata-changed",
    });
    await indexer.close();

    indexer = new Indexer(repo, config(true, decoder), "jcode", { indexPath });
    await expect(indexer.getIndexFreshness()).resolves.toMatchObject({ current: true });
    await indexer.close();

    execFileSync("git", ["checkout", "branch-b"], { cwd: repo });
    indexer = new Indexer(repo, config(true, path.join(repo, "missing-decoder")), "jcode", { indexPath });
    await indexer.index();
    expect((await targetState(indexer)).resolved).toBe(false);
    await indexer.close();

    indexer = new Indexer(repo, config(false, decoder), "jcode", { indexPath });
    await indexer.index();
    expect((await targetState(indexer)).resolved).toBe(false);
    await indexer.close();

    execFileSync("git", ["checkout", "branch-a"], { cwd: repo });
    indexer = new Indexer(repo, config(true, decoder), "jcode", { indexPath });
    const branchARestart = await targetState(indexer);
    await indexer.close();
    expect(branchARestart).toEqual(branchA);
  });
});
