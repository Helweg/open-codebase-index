import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConformanceDriver,
  evaluateBranchFinding,
  evaluateFinding,
  freshnessParticipantRequests,
  graphParticipantRequest,
  normalizeCbmDefinitions,
  normalizeCbmTrace,
  normalizeCodeGraphDefinitions,
  normalizeCodeGraphEdges,
  normalizeGrepai,
  normalizeMcp,
  parseArgs,
  prepareIsolation,
  resolveOcbiCallees,
  runConformance,
  shortestObservedPaths,
  validateManifest,
  type ConformanceDriver,
  type ParticipantRequest,
  type ParticipantResult,
} from "../scripts/competitive-conformance.js";

const roots: string[] = [];
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
async function temp(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "competitive-conformance-")); roots.push(root); return root; }
async function manifest(): Promise<Record<string, unknown>> {
  const source = JSON.parse(await fs.readFile(path.join(projectRoot, "benchmarks/competitive/2026-09-10/conformance.json"), "utf8")) as Record<string, unknown>;
  return structuredClone(source);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

const mcp = (structuredContent: Record<string, unknown>): Record<string, unknown> => ({ content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent, isError: false });
const textMcp = (text: string): Record<string, unknown> => ({ content: [{ type: "text", text }], isError: false });
const direct: ParticipantRequest = { operation: "direct-callees", subject: { path: "alpha.py", symbol: "middle" }, limit: 50 };
const node = (name: string, file = "alpha.py"): Record<string, unknown> => ({ name, file, kind: "function", line: 1 });

describe("calibrated public graph normalization", () => {
  // Shapes transcribed from graph-calibration-rescue/artifacts, not from the frozen scenario answers.
  it("projects actual CodeGraph caller/callee JSON without reversing edges", () => {
    const raw = { symbol: "middle", callees: [{ name: "leaf", filePath: "alpha.py", kind: "function", startLine: 1 }] };
    expect(normalizeCodeGraphEdges(raw, direct, direct.subject!, "/fixture")).toEqual([{ fromPath: "alpha.py", fromSymbol: "middle", toPath: "alpha.py", toSymbol: "leaf", relationship: "call" }]);
    const request: ParticipantRequest = { ...direct, operation: "direct-callers" };
    expect(normalizeCodeGraphEdges({ symbol: "middle", callers: [{ name: "entry", filePath: "alpha.py" }] }, request, request.subject!, "/fixture")[0]).toMatchObject({ fromSymbol: "entry", toSymbol: "middle" });
    expect(normalizeCodeGraphEdges({ symbol: "middle", callers: [] }, request, request.subject!, "/fixture")).toEqual([]);
    expect(() => normalizeCodeGraphEdges({ symbol: "middle" }, request, request.subject!, "/fixture")).toThrow(/Malformed/);
  });

  it("never turns a symbol mention or same-name different file into the requested definition", () => {
    const raw = [{ node: { name: "other", filePath: "a.py", content: "middle()" } }, { node: { name: "middle", filePath: "alpha.py" } }, { node: { name: "middle", filePath: "b.py" } }];
    expect(normalizeCodeGraphDefinitions(raw, { symbol: "middle" }, "/fixture")).toEqual([{ path: "alpha.py", symbol: "middle" }, { path: "b.py", symbol: "middle" }]);
    expect(normalizeCodeGraphDefinitions(raw, direct.subject!, "/fixture")).toEqual([direct.subject]);
    expect(() => normalizeCodeGraphDefinitions([{ node: { name: "middle", filePath: "../outside.py" } }], direct.subject!, "/fixture")).toThrow(/Out-of-scope/);
  });

  it("reads CBM grouped columns and qualified identity without using degree as callers", () => {
    const raw = mcp({ total: 2, count: 2, cols: ["label", "name", "lines", "in", "out"], groups: [
      { qn_prefix: "project.alpha", file: "alpha.py", rows: [["Function", "middle", "4-5", 88, 99]] },
      { qn_prefix: "project", rows: [["Folder", "middle", "", 0, 0]] },
    ], has_more: false });
    expect(normalizeCbmDefinitions(raw, direct.subject!, "/fixture")).toEqual([{ ...direct.subject, qualifiedName: "project.alpha.middle" }]);
    const malformed = mcp({ cols: ["name", "label"], groups: [{ qn_prefix: "project", rows: [["middle", "Function"]] }] });
    expect(() => normalizeCbmDefinitions(malformed, direct.subject!, "/fixture")).toThrow(/source path/);
  });

  it("preserves CBM hop-one qn only and rejects transitive, truncated, or incomplete rows", () => {
    const body = { function: "middle", direction: "outbound", callees_total: 1, callees: { cols: ["name", "hop"], groups: [{ qn_prefix: "project.alpha", rows: [["leaf", 1]] }] } };
    expect(normalizeCbmTrace(mcp(body), "callees")).toEqual([{ symbol: "leaf", qualifiedName: "project.alpha.leaf" }]);
    expect(normalizeCbmTrace(mcp({ callers_total: 0 }), "callers")).toEqual([]);
    expect(() => normalizeCbmTrace(mcp({ ...body, truncated: true }), "callees")).toThrow(/truncated/);
    expect(() => normalizeCbmTrace(mcp({ ...body, callees_total: 2 }), "callees")).toThrow(/count mismatch/);
    expect(() => normalizeCbmTrace(mcp({ ...body, callees: { cols: ["name", "hop"], groups: [{ qn_prefix: "project.alpha", rows: [["leaf", 2]] }] } }), "callees")).toThrow(/hop-one/);
  });

  it("preserves grepai fast-mode self-call errors and public root identity", () => {
    const raw = { query: "middle", mode: "fast", symbol: node("middle"), callees: [{ symbol: node("middle"), call_site: { line: 4, context: "def middle(value):" } }, { symbol: node("leaf"), call_site: { line: 5 } }] };
    const result = normalizeGrepai(raw, direct, "/fixture");
    expect(result.status).toBe("success");
    expect(result.normalized.edges).toHaveLength(2);
    expect(result.normalized.edges![0]).toMatchObject({ fromSymbol: "middle", toSymbol: "middle" });
    expect(normalizeGrepai({ ...raw, symbol: node("middle", "wrong.py") }, direct, "/fixture").status).toBe("manual-adjudication-required");
    expect(() => normalizeGrepai({ ...raw, callees: [{}] }, direct, "/fixture")).toThrow();
  });

  it("derives grepai paths only from directed public edges and explicit node paths", () => {
    const request: ParticipantRequest = { operation: "shortest-path", from: { path: "alpha.py", symbol: "entry" }, to: { path: "alpha.py", symbol: "leaf" }, limit: 50 };
    const raw = { query: "entry", mode: "fast", graph: { root: "entry", depth: 10, nodes: { entry: node("entry"), middle: node("middle"), leaf: node("leaf") }, edges: [{ caller: "entry", callee: "middle", call_type: "direct" }, { caller: "middle", callee: "leaf", call_type: "direct" }] } };
    expect(normalizeGrepai(raw, request, "/fixture").normalized.paths).toEqual([[request.from, { path: "alpha.py", symbol: "middle" }, request.to]]);
    expect(normalizeGrepai({ query: "entry", mode: "fast" }, request, "/fixture").status).toBe("manual-adjudication-required");
    expect(() => normalizeGrepai({ ...raw, graph: { ...raw.graph, nodes: { entry: node("entry") } } }, request, "/fixture")).toThrow(/endpoint/);
  });

  it("does not fill missing grepai source body from the source checkout", () => {
    const result = normalizeGrepai({ query: "middle", mode: "fast", symbol: node("middle") }, { ...direct, operation: "definitions" }, "/fixture");
    expect(result.normalized.definitions).toEqual([direct.subject]);
    expect(result.provenance?.[0].limitation).toMatch(/not all duplicate definitions or indexed body/);
    expect(normalizeGrepai({ query: "middle", mode: "fast" }, { ...direct, operation: "definitions" }, "/fixture").normalized.definitions).toEqual([]);
  });

  it("returns all shortest observed paths, ignores cycles, and never invents a transitive edge", () => {
    const from = { path: "x.py", symbol: "a" }, to = { path: "x.py", symbol: "d" };
    const edges = [["a", "b"], ["b", "a"], ["a", "c"], ["b", "d"], ["c", "d"]].map(([a, b]) => ({ fromPath: "x.py", fromSymbol: a, toPath: "x.py", toSymbol: b, relationship: "call" }));
    expect(shortestObservedPaths(edges, from, to)).toEqual([[from, { path: "x.py", symbol: "b" }, to], [from, { path: "x.py", symbol: "c" }, to]]);
    expect(shortestObservedPaths(edges, from, to, 1)).toEqual([]);
    expect(shortestObservedPaths(edges, to, from)).toEqual([]);
  });

  it("resolves OCBI missing target paths only for explicitly resolved, uniquely defined targets", async () => {
    const raw = textMcp('"middle" at alpha.py:4 calls 1 function(s):\n\n[1] → leaf (Call) at line 5 [resolved]');
    const definition = textMcp('[1] function "leaf" in alpha.py:1-2 (score: 1.00)\n```\ndef leaf(value):\n    return value + 1\n```');
    const symbols: string[] = [];
    const result = await resolveOcbiCallees(raw, { ...direct, subject: { symbol: "middle" } }, async symbol => { symbols.push(symbol); return definition; });
    expect(symbols).toEqual(["leaf"]);
    expect(result.normalized.edges?.[0]).toMatchObject({ fromPath: "alpha.py", toPath: "alpha.py", toSymbol: "leaf" });
    expect(result.provenance?.[0]).toMatchObject({ raw: definition, request: { subject: { symbol: "leaf" } } });
    const ambiguous = textMcp('[1] function "leaf" in alpha.py:1-2\n[2] function "leaf" in beta.py:1-2');
    expect((await resolveOcbiCallees(raw, direct, async () => ambiguous)).status).toBe("manual-adjudication-required");
    const unresolved = textMcp('"middle" at alpha.py:4 calls 1 function(s):\n\n[1] → leaf (Call) at line 5 [unresolved]');
    expect((await resolveOcbiCallees(unresolved, direct, async () => { throw new Error("must not lookup unresolved edge"); })).status).toBe("manual-adjudication-required");
  });

  it("never interprets malformed or error MCP output as a negative graph answer", () => {
    expect(() => normalizeMcp(textMcp("Ambiguous symbol"), { ...direct, operation: "direct-callers" })).toThrow();
    expect(() => normalizeMcp({ ...textMcp("No callers found"), isError: true }, direct)).toThrow(/MCP tool error/);
    expect(() => normalizeMcp(textMcp('"middle" at alpha.py:4 calls 2 function(s):\n[1] → leaf (Call) at line 5 [resolved]'), direct)).toThrow(/incomplete/);
    expect(normalizeMcp(textMcp('[1] function "other" in alpha.py:1-2\n```\nmiddle()\n```'), { ...direct, operation: "definitions" }).definitions).toEqual([]);
  });
});

describe("mandatory subprocess isolation", () => {
  it("creates isolated HOME/XDG/TMPDIR and rejects the real repo or a symlink to it", async () => {
    const artifactDir = await temp(), sourceRoot = path.join(artifactDir, "source"); await fs.mkdir(sourceRoot);
    await prepareIsolation({ sourceRoot, artifactDir, projectRoot });
    expect((await fs.stat(path.join(artifactDir, "home/.local/share"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(artifactDir, "tmp"))).isDirectory()).toBe(true);
    await expect(prepareIsolation({ sourceRoot: projectRoot, artifactDir, projectRoot })).rejects.toThrow(/non-isolated/);
    const link = path.join(artifactDir, "repo-link"); await fs.symlink(projectRoot, link);
    await expect(prepareIsolation({ sourceRoot: link, artifactDir, projectRoot })).rejects.toThrow(/non-isolated/);
  });

  it("invokes only calibrated CodeGraph argv in the fixture and hashes every raw response", async () => {
    const artifactDir = await temp(), sourceRoot = path.join(artifactDir, "source"), toolsRoot = path.join(artifactDir, "tools");
    await fs.mkdir(sourceRoot);
    const binary = path.join(toolsRoot, "npm/node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='query')console.log(JSON.stringify([{node:{name:'middle',filePath:'alpha.py'}}]));else if(args[0]==='callees')console.log(JSON.stringify({symbol:'middle',callees:[{name:'leaf',filePath:'alpha.py'}]}));else process.exit(2);`, { mode: 0o755 });
    const driver = createConformanceDriver("codegraph", { artifactDir, sourceRoot, toolsRoot, projectRoot, configPath: "", timeoutMs: 5000 });
    try { expect((await driver.request(direct)).normalized.edges?.[0]).toMatchObject({ fromSymbol: "middle", toSymbol: "leaf", toPath: "alpha.py" }); }
    finally { await driver.close(); }
    const directory = path.join(artifactDir, "public-commands");
    const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(2);
    for (const name of names) {
      const bytes = await fs.readFile(path.join(directory, name));
      const record = JSON.parse(bytes.toString("utf8")) as { cwd: string; env: Record<string, string>; args: string[]; stdout: string; executableSha256: string };
      expect(record.cwd).toBe(sourceRoot);
      expect(record.env.HOME).toBe(path.join(artifactDir, "home"));
      expect(record.env.CBM_CACHE_DIR).toBe(path.join(artifactDir, "cbm-cache"));
      expect(record.args).toContain(sourceRoot);
      expect(record.stdout).toContain("middle");
      expect(record.executableSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await fs.readFile(path.join(directory, `hashes-${process.pid}.txt`), "utf8")).toContain(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
  });
});

describe("competitive conformance manifest and participant inputs", () => {
  it("accepts the frozen 6 graph and 6 freshness manifest and genuine g6 path", async () => {
    const parsed = validateManifest(await manifest());
    expect(parsed.graphScenarios).toHaveLength(6);
    expect(parsed.freshnessScenarios).toHaveLength(6);
    const g6 = parsed.graphScenarios.find(scenario => scenario.id === "g6-py-transitive-reachability")!;
    expect(graphParticipantRequest(g6)).toEqual({
      operation: "shortest-path",
      from: { path: "payments/service.py", symbol: "checkout_payment" },
      to: { path: "payments/audit.py", symbol: "record_audit" },
      limit: 50,
    });
  });

  it("rejects non-frozen or incorrectly sized manifests", async () => {
    const value = await manifest();
    value.status = "draft";
    expect(() => validateManifest(value)).toThrow(/frozen/);
    const short = await manifest();
    (short.graphScenarios as unknown[]).pop();
    expect(() => validateManifest(short)).toThrow(/exactly 6/);
  });

  it("exposes only explicit symmetric inputs and never oracle fields", async () => {
    const parsed = validateManifest(await manifest());
    for (const scenario of parsed.graphScenarios) {
      const input = graphParticipantRequest(scenario);
      expect(Object.keys(input).sort()).not.toContain("expectedEdges");
      expect(JSON.stringify(input)).not.toContain("expectedPaths");
      expect(JSON.stringify(input)).not.toContain("expectedDefinitions");
      expect(JSON.stringify(input)).not.toContain(scenario.question);
    }
    for (const scenario of parsed.freshnessScenarios) {
      for (const input of freshnessParticipantRequests(scenario)) {
        expect(Object.keys(input).sort()).toEqual(["limit", "operation", "subject"]);
        expect(JSON.stringify(input)).not.toContain("expected");
      }
    }
  });

  it("parses a bounded explicit CLI", () => {
    expect(parseArgs(["--output", "out", "--tools-root", "tools", "--conditions", "ocbi-structural,grepai"]).conditions).toEqual(["ocbi-structural", "grepai"]);
    expect(() => parseArgs(["--output", "out", "--tools-root", "tools", "--conditions", "unknown"])).toThrow(/Unknown/);
    expect(() => parseArgs(["--output", "one", "--output", "two", "--tools-root", "tools"])).toThrow(/Duplicate/);
  });
});

describe("canonical conformance evaluation", () => {
  it("compares exact canonical edge sets independent of object key and result order", async () => {
    const parsed = validateManifest(await manifest());
    const scenario = parsed.graphScenarios.find(value => value.id === "g1-js-direct-callees")!;
    const expected = scenario.expectedEdges as Array<Record<string, unknown>>;
    const actual = [...expected].reverse().map(edge => ({ relationship: edge.relationship, toSymbol: edge.toSymbol, fromSymbol: edge.fromSymbol, toPath: `./${String(edge.toPath)}`, fromPath: String(edge.fromPath).replaceAll("/", "\\") }));
    expect(evaluateFinding(scenario, { status: "success", raw: {}, normalized: { edges: actual } })).toMatchObject({ status: "completed", conforms: true, missing: [], extra: [] });
  });

  it("reports exact missing and extra paths without manufacturing a match", async () => {
    const parsed = validateManifest(await manifest());
    const scenario = parsed.graphScenarios.find(value => value.id === "g6-py-transitive-reachability")!;
    const result = evaluateFinding(scenario, { status: "success", raw: {}, normalized: { paths: [[{ path: "payments/service.py", symbol: "checkout_payment" }, { path: "payments/audit.py", symbol: "record_audit" }]] } });
    expect(result).toMatchObject({ status: "completed", conforms: false });
    expect(result.missing).toHaveLength(1);
    expect(result.extra).toHaveLength(1);
  });

  it("does not score missing collections as negative answers or single trace roots as duplicate enumeration", async () => {
    const parsed = validateManifest(await manifest());
    const negative = parsed.graphScenarios.find(value => value.id === "g4-py-negative-callers")!;
    expect(evaluateFinding(negative, { status: "success", raw: {}, normalized: {} })).toMatchObject({ status: "error", conforms: false });
    const duplicate = parsed.graphScenarios.find(value => value.id === "g5-js-duplicate-ambiguous")!;
    expect(evaluateFinding(duplicate, { status: "success", raw: {}, normalized: { definitions: [{ path: "src/duplicate-a.js", symbol: "normalize" }], definitionEnumeration: "single-root" } })).toMatchObject({ status: "manual-adjudication-required", conforms: null });
  });

  it("evaluates both branch phases and preserves adapter-blocked/manual statuses", async () => {
    const parsed = validateManifest(await manifest());
    const scenario = parsed.freshnessScenarios.find(value => value.id === "f5-js-real-branch-switch")!;
    expect(evaluateBranchFinding(scenario,
      { status: "success", raw: {}, normalized: { definitions: [{ path: "src/discount.js", symbol: "applyDiscount" }] } },
      { status: "success", raw: {}, normalized: { definitions: [] } },
    )).toMatchObject({ status: "completed", conforms: true, onFeature: { conforms: true }, onMainAfterReturn: { conforms: true } });
    expect(evaluateBranchFinding(scenario,
      { status: "adapter-blocked", raw: { reason: "branch adapter" }, normalized: {} },
      { status: "success", raw: {}, normalized: { definitions: [] } },
    )).toMatchObject({ status: "adapter-blocked", conforms: null });
    expect(evaluateFinding(parsed.graphScenarios[0], { status: "manual-adjudication-required", raw: { reason: "unresolved endpoint" }, normalized: {} })).toMatchObject({ status: "manual-adjudication-required", conforms: null });
  });

  it("checks forbidden stale content in individual definition content", async () => {
    const parsed = validateManifest(await manifest());
    const scenario = parsed.freshnessScenarios.find(value => value.id === "f6-py-long-lived-reader-external-writer")!;
    const result = evaluateFinding(scenario, { status: "success", raw: {}, normalized: { definitions: [
      { path: "payments/notify.py", symbol: "notify_failure", content: "def notify_failure(payment): pass" },
      { path: "payments/notify.py", symbol: "notify_customer", content: "return f\"notified:{payment['id']}\"" },
    ] } });
    expect(result).toMatchObject({ status: "completed", conforms: false });
    expect(result.forbiddenContent).toHaveLength(1);
    expect(result.missingContent).toHaveLength(1);
  });

  it("does not invent an expected-empty definition assertion when freshness asks only for edges", async () => {
    const parsed = validateManifest(await manifest());
    const scenario = parsed.freshnessScenarios.find(value => value.id === "f2-py-modify")!;
    const expected = scenario.expected as { edges: Array<Record<string, unknown>> };
    expect(evaluateFinding(scenario, { status: "success", raw: {}, normalized: { definitions: [{ path: "payments/reports.py", symbol: "render_report" }], edges: expected.edges } })).toMatchObject({ status: "completed", conforms: true });
  });
});

describe("competitive conformance runner", () => {
  it("runs isolated serial cells, preserves requests/responses, and reports adapter-blocked per cell", async () => {
    const root = await temp();
    const manifestPath = path.join(root, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(await manifest()));
    const outputRoot = path.join(root, "output");
    const requests: ParticipantRequest[] = [];
    let active = 0;
    let maxActive = 0;
    const factory = (): ConformanceDriver => ({
      supportsPersistentReader: false,
      async index() { active += 1; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 1)); active -= 1; return { indexed: true }; },
      async request(input): Promise<ParticipantResult> { requests.push(input); return { status: input.operation === "definitions" ? "success" : "adapter-blocked", raw: input.operation === "definitions" ? { echoed: input } : { reason: "Graph adapter not calibrated" }, normalized: input.operation === "definitions" ? { definitions: input.subject ? [input.subject] : [] } : {} }; },
      async refresh() { return { refreshed: true }; },
      async close() {},
    });
    await runConformance({ projectRoot, manifestPath, toolsRoot: path.join(root, "tools"), outputRoot, conditions: ["codegraph"], driverFactory: factory });

    expect(maxActive).toBe(1);
    expect(requests).toHaveLength(15); // Includes duplicate-candidate discovery, freshness edges, and both branch phases.
    expect(JSON.stringify(requests)).not.toContain("expectedEdges");
    const graphFinding = JSON.parse(await fs.readFile(path.join(outputRoot, "graph/g1-js-direct-callees/codegraph/finding.json"), "utf8")) as Record<string, unknown>;
    expect(graphFinding).toMatchObject({ status: "adapter-blocked", conforms: null });
    const f6Finding = JSON.parse(await fs.readFile(path.join(outputRoot, "freshness/f6-py-long-lived-reader-external-writer/codegraph/finding.json"), "utf8")) as Record<string, unknown>;
    expect(f6Finding).toMatchObject({ status: "adapter-blocked", reason: "Calibrated persistent-reader adapter unavailable" });
    const transcript = JSON.parse(await fs.readFile(path.join(outputRoot, "graph/g6-py-transitive-reachability/codegraph/transcript.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(transcript.some(row => row.phase === "request" && JSON.stringify(row).includes("checkout_payment") && JSON.stringify(row).includes("record_audit"))).toBe(true);
    expect(await fs.readFile(path.join(outputRoot, "completed.json"), "utf8")).toContain('"cells": 12');
  });

  it("refuses to overwrite an existing evidence root", async () => {
    const root = await temp();
    const manifestPath = path.join(root, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(await manifest()));
    const outputRoot = path.join(root, "existing");
    await fs.mkdir(outputRoot);
    await expect(runConformance({ projectRoot, manifestPath, toolsRoot: root, outputRoot, conditions: ["grepai"], driverFactory: () => { throw new Error("must not construct"); } })).rejects.toThrow();
  });

  it("uses a distinct external writer process without replacing the f6 reader driver", async () => {
    const root = await temp();
    const manifestPath = path.join(root, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(await manifest()));
    const outputRoot = path.join(root, "output");
    let nextDriver = 0;
    const observedDriverIds: number[] = [];
    const refreshedDriverIds: number[] = [];
    await runConformance({
      projectRoot, manifestPath, toolsRoot: root, outputRoot, conditions: ["grepai"],
      externalWriter: async (_condition, context, writes) => {
        const payload = Buffer.from(JSON.stringify({ root: context.sourceRoot, writes })).toString("base64");
        const script = `const fs=require("node:fs");const path=require("node:path");const x=JSON.parse(Buffer.from(process.argv[1],"base64"));for(const [r,c] of Object.entries(x.writes)){const f=path.join(x.root,r);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,String(c));}console.log(JSON.stringify({writerPid:process.pid,indexResponse:{published:true}}));`;
        const { execFile } = await import("node:child_process");
        await prepareIsolation(context);
        const home = path.join(context.artifactDir, "home");
        const response = await new Promise<string>((resolve, reject) => execFile(process.execPath, ["-e", script, payload], {
          cwd: context.sourceRoot, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".state"), XDG_DATA_HOME: path.join(home, ".local/share"), TMPDIR: path.join(context.artifactDir, "tmp") }, timeout: 5000,
        }, (error, stdout) => error ? reject(error) : resolve(stdout)));
        return JSON.parse(response) as Record<string, unknown>;
      },
      driverFactory: () => {
        const id = nextDriver++;
        return {
          supportsPersistentReader: true,
          async index() { return { id }; },
          async refresh() { refreshedDriverIds.push(id); return { id }; },
          async request(input): Promise<ParticipantResult> { observedDriverIds.push(id); return { status: input.operation === "definitions" ? "success" : "adapter-blocked", raw: input.operation === "definitions" ? {} : { reason: "graph adapter blocked" }, normalized: input.operation === "definitions" ? { definitions: [] } : {} }; },
          async close() {},
        };
      },
    });
    const transcript = JSON.parse(await fs.readFile(path.join(outputRoot, "freshness/f6-py-long-lived-reader-external-writer/grepai/transcript.json"), "utf8")) as Array<Record<string, unknown>>;
    const writer = transcript.find(row => row.phase === "external-writer-public-index")!;
    const writerValue = writer.value as Record<string, unknown>;
    expect(writerValue.writerPid).toEqual(expect.any(Number));
    expect(writerValue.writerPid).not.toBe(process.pid);
    expect(writerValue.indexResponse).toEqual({ published: true });
    const f6DriverId = 11;
    expect(observedDriverIds.filter(id => id === f6DriverId)).toHaveLength(2);
    expect(refreshedDriverIds).not.toContain(f6DriverId);
    expect(await fs.readFile(path.join(outputRoot, "freshness/f6-py-long-lived-reader-external-writer/grepai/source/payments/notify.py"), "utf8")).toContain("notify_failure");
  });

  it("preserves duplicate-caller manual status and never converts freshness query or refresh errors to empty success", async () => {
    const root = await temp(), manifestPath = path.join(root, "manifest.json"), outputRoot = path.join(root, "output");
    await fs.writeFile(manifestPath, JSON.stringify(await manifest()));
    await runConformance({ projectRoot, manifestPath, toolsRoot: root, outputRoot, conditions: ["codegraph"], driverFactory: (_condition, context) => ({
      supportsPersistentReader: false,
      async index() { return {}; },
      async refresh() { if (context.artifactDir.includes("f4-py-rename")) throw new Error("refresh failed"); return {}; },
      async close() {},
      async request(input): Promise<ParticipantResult> {
        if (context.artifactDir.includes("f3-js-delete")) throw new Error("query failed");
        if (context.artifactDir.includes("f4-py-rename")) throw new Error("must not query after failed refresh");
        if (input.operation === "direct-callers") return { status: "manual-adjudication-required", raw: { reason: "ambiguous caller interface" }, normalized: {} };
        return { status: "success", raw: {}, normalized: { definitions: input.subject ? [{ ...input.subject, path: "src/duplicate-a.js" }] : [], edges: [] } };
      },
    }) });
    const finding = async (relative: string): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(path.join(outputRoot, relative, "codegraph/finding.json"), "utf8")) as Record<string, unknown>;
    expect(await finding("graph/g5-js-duplicate-ambiguous")).toMatchObject({ status: "manual-adjudication-required", conforms: null });
    expect(await finding("freshness/f3-js-delete")).toMatchObject({ status: "error", conforms: false, error: "query failed" });
    expect(await finding("freshness/f4-py-rename")).toMatchObject({ status: "error", conforms: false, error: "refresh failed" });
  });
});
