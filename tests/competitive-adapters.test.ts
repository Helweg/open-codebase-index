import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAdapter,
  hasGrepaiReadyEvents,
  parseCodebaseMemoryPaths,
  parseCodeGraphPaths,
  parseGrepaiPaths,
  parseOcbiCitationPaths,
} from "../scripts/competitive-adapters.js";

const tempDirs: string[] = [];

function fixture(): { root: string; source: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "competitive-adapter-"));
  tempDirs.push(root);
  const source = path.join(root, "project");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "target.ts"), "export function target() {}\n", "utf8");
  return { root, source };
}

function options(root: string, source: string) {
  return {
    projectRoot: source,
    toolsRoot: path.join(root, "tools"),
    ocbiCliPath: path.join(root, "ocbi"),
    configPath: path.join(root, "config.json"),
    artifactDir: path.join(root, "artifacts"),
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("competitive adapter output parsing", () => {
  it("recognizes actual ordered grepai readiness events with intervening progress", () => {
    const log = `Initial scan complete: 2 files indexed, 3 chunks created\nBuilding symbol index...\nSymbol index built: 4 symbols extracted\n[RUNNING] /scratch/project - steady\nWatching for changes...`;
    expect(hasGrepaiReadyEvents(log)).toBe(true);
    expect(hasGrepaiReadyEvents(log.replace("Symbol index built", "Symbol index pending"))).toBe(false);
    expect(hasGrepaiReadyEvents(log.split("\n").reverse().join("\n"))).toBe(false);
  });

  it("accepts strict numbered OCBI citation headers but not body references", () => {
    const { source } = fixture();
    const raw = {
      content: [{
        type: "text",
        text: "[1] function \"target\" at src/target.ts:1-1 (score: 1.00)\nbody mentions src/missing.ts:99\n[2] function at src/target.ts:1-1",
      }],
    };
    expect(parseOcbiCitationPaths(raw, source, 50)).toEqual(["src/target.ts"]);
  });

  it("rejects aggregate OCBI MCP text beyond the 16 MiB cap", () => {
    const { source } = fixture();
    const raw = { content: [
      { type: "text", text: "x".repeat(8 * 1024 * 1024) },
      { type: "text", text: "y".repeat(8 * 1024 * 1024 + 1) },
    ] };
    expect(() => parseOcbiCitationPaths(raw, source, 50)).toThrow(/exceeded 16777216 bytes/);
  });

  it("parses actual CodeGraph query and context JSON shapes", () => {
    const { source } = fixture();
    expect(parseCodeGraphPaths([{ node: { filePath: "src/target.ts" }, score: 4 }], source, 50)).toEqual(["src/target.ts"]);
    expect(parseCodeGraphPaths({ nodes: [{ filePath: "src/target.ts" }] }, source, 50)).toEqual(["src/target.ts"]);
  });

  it("parses current codebase-memory grouped structuredContent shape", () => {
    const { source } = fixture();
    const raw = {
      content: [{ type: "text", text: "ignored" }],
      structuredContent: {
        total: 1,
        count: 1,
        cols: ["name", "label", "lines", "in", "out"],
        groups: [{ qn_prefix: "fixture", file: "src/target.ts", rows: [["target", "Function", "1-1", 0, 0]] }],
        has_more: false,
      },
      isError: false,
    };
    expect(parseCodebaseMemoryPaths(raw, source, 50)).toEqual(["src/target.ts"]);
  });

  it("omits explicitly typed Folder and Channel groups before validating file candidates", () => {
    const { source } = fixture();
    const raw = {
      structuredContent: {
        total: 3,
        count: 3,
        cols: ["name", "label", "lines", "in", "out"],
        groups: [
          { file: "src/target.ts", rows: [["target", "Function", "1-1", 0, 0]] },
          { file: "examples/error", rows: [["examples/error", "Folder", "", 0, 0]] },
          { file: "", rows: [["errors", "Channel", "", 0, 0]] },
        ],
      },
      isError: false,
    };

    expect(parseCodebaseMemoryPaths(raw, source, 50)).toEqual(["src/target.ts"]);
  });

  it("validates every non-container CBM candidate as a regular file without guessing labels", () => {
    const { source } = fixture();
    const response = (groups: unknown[]) => ({
      structuredContent: { total: groups.length, count: groups.length, cols: ["name", "label", "lines", "in", "out"], groups },
      isError: false,
    });

    expect(() => parseCodebaseMemoryPaths(response([
      { file: "src/target.ts", rows: [["target", "Function", "1-1", 0, 0]] },
      { file: "../outside.ts", rows: [["outside", "Function", "1-1", 0, 0]] },
    ]), source, 50)).toThrow(/outside project root/);
    expect(parseCodebaseMemoryPaths(response([
      { file: "src/target.ts", rows: [["target", "MysteryNode", "1-1", 0, 0]] },
    ]), source, 50)).toEqual(["src/target.ts"]);
    expect(parseCodebaseMemoryPaths(response([
      { file: "src/target.ts", rows: [["target", "Function", "1-1", 0, 0], ["src", "Folder", "", 0, 0]] },
    ]), source, 50)).toEqual(["src/target.ts"]);
    expect(() => parseCodebaseMemoryPaths(response([
      { file: "src", rows: [["src", "MysteryNode", "", 0, 0]] },
    ]), source, 50)).toThrow(/not a regular file/);
  });

  it("derives the CBM label position from cols and rejects malformed column contracts", () => {
    const { source } = fixture();
    const raw = (cols: string[], rows: unknown[][]) => ({
      structuredContent: { total: 1, count: 1, cols, groups: [{ file: "src/target.ts", rows }] },
      isError: false,
    });
    expect(parseCodebaseMemoryPaths(raw(["label", "name"], [["Function", "target"]]), source, 50))
      .toEqual(["src/target.ts"]);
    expect(() => parseCodebaseMemoryPaths(raw(["name"], [["target"]]), source, 50)).toThrow(/exactly one label/);
    expect(() => parseCodebaseMemoryPaths(raw(["label", "label"], [["Function", "Function"]]), source, 50)).toThrow(/exactly one label/);
    expect(() => parseCodebaseMemoryPaths(raw(["name", "label"], [["target"]]), source, 50)).toThrow(/must match cols/);
    expect(() => parseCodebaseMemoryPaths(raw(["name", "label"], [["target", ""]]), source, 50)).toThrow(/string label/);
  });

  it("validates invalid CBM files even after ten preceding candidates", () => {
    const { source } = fixture();
    const groups = Array.from({ length: 10 }, () => ({
      file: "src/target.ts",
      rows: [["target", "Function", "1-1", 0, 0]],
    }));
    groups.push({ file: "../outside.ts", rows: [["outside", "Function", "1-1", 0, 0]] });
    expect(() => parseCodebaseMemoryPaths({
      structuredContent: {
        total: groups.length,
        count: groups.length,
        cols: ["name", "label", "lines", "in", "out"],
        groups,
      },
      isError: false,
    }, source, 50)).toThrow(/outside project root/);
  });

  it("parses grepai JSON arrays and deduplicates to file-level top ten", () => {
    const { source } = fixture();
    expect(parseGrepaiPaths([
      { file_path: "src/target.ts", start_line: 1, end_line: 1, score: 1, content: "x" },
      { file_path: "src/target.ts", start_line: 2, end_line: 2, score: 0.9, content: "y" },
    ], source, 50)).toEqual(["src/target.ts"]);
  });

  it("fails explicitly for malformed shapes instead of returning empty", () => {
    const { source } = fixture();
    expect(() => parseCodeGraphPaths({}, source, 50)).toThrow(/nodes/);
    expect(() => parseCodebaseMemoryPaths({ structuredContent: {}, isError: false }, source, 50)).toThrow(/total/);
    expect(() => parseGrepaiPaths({}, source, 50)).toThrow(/array/);
    expect(() => parseOcbiCitationPaths({ content: "bad" }, source, 50)).toThrow(/content/);
    expect(() => parseOcbiCitationPaths({ content: [{ type: "text", text: "" }] }, source, 50)).toThrow(/empty response/);
  });

  it("rejects missing, traversing, absolute, and symlink-escaping result paths", () => {
    const { root, source } = fixture();
    const outside = path.join(root, "outside.ts");
    fs.writeFileSync(outside, "outside", "utf8");
    fs.symlinkSync(outside, path.join(source, "src", "escape.ts"));
    for (const candidate of ["src/missing.ts", "../outside.ts", outside, "src/escape.ts"]) {
      expect(() => parseGrepaiPaths([{ file_path: candidate }], source, 50)).toThrow();
    }
  });

  it("validates malformed candidates even after the top-ten scoring cutoff", () => {
    const { source } = fixture();
    const results = Array.from({ length: 10 }, () => ({ file_path: "src/target.ts" }));
    results.push({ file_path: "../outside.ts" });
    expect(() => parseGrepaiPaths(results, source, 50)).toThrow(/outside project root/);
  });
});

describe("competitive adapter process contracts", () => {
  it("uses the documented CodeGraph argv, scrubbed environment, and never accepts oracle fields", async () => {
    const { root, source } = fixture();
    const opts = options(root, source);
    const executable = path.join(opts.toolsRoot, "npm/node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph");
    const capture = path.join(root, "capture.json");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, `#!/bin/sh\nnode -e 'const fs=require("fs"); const a=process.argv.slice(1); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:a,env:process.env})); console.log(JSON.stringify([{node:{filePath:"src/target.ts"},score:1}]))' "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(opts.configPath, "{}", "utf8");
    fs.mkdirSync(opts.artifactDir, { recursive: true });

    const adapter = createAdapter("codegraph", opts);
    const result = await adapter.query({ query: "ignored prose", symbol: "target", limit: 50 });
    await adapter.close();

    expect(result.paths).toEqual(["src/target.ts"]);
    const captured = JSON.parse(fs.readFileSync(capture, "utf8")) as { args: string[]; env: Record<string, string> };
    expect(captured.args).toEqual(["query", "target", "--path", source, "--limit", "50", "--json"]);
    expect(captured.env.CODEGRAPH_NO_DAEMON).toBe("1");
    expect(captured.env.CODEGRAPH_TELEMETRY).toBe("0");
    expect(captured.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("marks text-only codebase-memory queries unsupported without spawning a process", async () => {
    const { root, source } = fixture();
    const adapter = createAdapter("codebase-memory", options(root, source));
    const result = await adapter.query({ query: "authentication flow", limit: 50 });
    expect(result).toMatchObject({ status: "unsupported", paths: [], durationMs: 0 });
  });

  it("does not expose expected/oracle fields in the public query contract", () => {
    type AdapterQuery = Parameters<ReturnType<typeof createAdapter>["query"]>[0];
    const query: AdapterQuery = { query: "target", symbol: "target", limit: 50 };
    expect(Object.keys(query).sort()).toEqual(["limit", "query", "symbol"]);
  });
});
