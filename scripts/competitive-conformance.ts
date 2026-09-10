#!/usr/bin/env node
/** Bounded synthetic graph/freshness conformance runner. Never use for broad superiority claims. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const INDEX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const CONDITIONS = ["ocbi-hybrid", "ocbi-structural", "codegraph", "codebase-memory", "grepai"] as const;
export type Condition = typeof CONDITIONS[number];

type Json = Record<string, unknown>;
interface SymbolInput { path?: string; symbol: string }
interface Repository { id: string; files: Record<string, string> }
interface GraphScenario { id: string; repository: string; question: string; assertionType: string; subject?: SymbolInput; from?: SymbolInput; to?: SymbolInput; [key: string]: unknown }
interface FreshnessScenario { id: string; repository: string; transition: string; mutation: Json; queryInputs: { symbol?: string; symbols?: string[]; path?: string }; [key: string]: unknown }
export interface ConformanceManifest { schemaVersion: number; status: string; repositories: Repository[]; graphScenarios: GraphScenario[]; freshnessScenarios: FreshnessScenario[]; [key: string]: unknown }
export interface ParticipantRequest { operation: "direct-callers" | "direct-callees" | "shortest-path" | "definitions"; subject?: SymbolInput; from?: SymbolInput; to?: SymbolInput; symbols?: string[]; limit: number }
export type ResultStatus = "success" | "adapter-blocked" | "manual-adjudication-required";
export interface ParticipantResult { status: ResultStatus; raw: unknown; normalized: { definitions?: Array<SymbolInput & { content?: string; directCallers?: Json[] }>; definitionEnumeration?: "single-root"; edges?: Json[]; paths?: SymbolInput[][]; content?: string }; provenance?: Json[] }
export interface ConformanceDriver {
  index(): Promise<unknown>;
  request(input: ParticipantRequest): Promise<ParticipantResult>;
  refresh(): Promise<unknown>;
  close(): Promise<void>;
  supportsPersistentReader: boolean;
}
export interface RunOptions {
  projectRoot: string;
  manifestPath: string;
  toolsRoot: string;
  outputRoot: string;
  conditions: Condition[];
  timeoutMs?: number;
  driverFactory?: (condition: Condition, context: DriverContext) => Promise<ConformanceDriver> | ConformanceDriver;
  externalWriter?: (condition: Condition, context: DriverContext, writes: Json) => Promise<Json>;
}
export interface DriverContext { sourceRoot: string; artifactDir: string; toolsRoot: string; projectRoot: string; configPath: string; timeoutMs: number }

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Json;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function save(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function timed<T>(operation: () => Promise<T>, timeoutMs: number): Promise<{ value?: T; error?: string; durationMs: number }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs); })]);
    return { value, durationMs: performance.now() - started };
  } catch (error) { return { error: errorText(error), durationMs: performance.now() - started }; }
  finally { if (timer) clearTimeout(timer); }
}

export function validateManifest(value: unknown): ConformanceManifest {
  const manifest = object(value, "manifest") as unknown as ConformanceManifest;
  if (manifest.schemaVersion !== 1 || manifest.status !== "frozen-before-scored-runs") throw new Error("A schemaVersion 1 frozen conformance manifest is required");
  if (!Array.isArray(manifest.repositories) || !Array.isArray(manifest.graphScenarios) || !Array.isArray(manifest.freshnessScenarios)) throw new Error("Manifest scenario arrays are required");
  if (manifest.graphScenarios.length !== 6 || manifest.freshnessScenarios.length !== 6) throw new Error("Manifest must contain exactly 6 graph and 6 freshness scenarios");
  const repoIds = new Set(manifest.repositories.map(repo => repo.id));
  const ids = [...manifest.graphScenarios, ...manifest.freshnessScenarios].map(scenario => scenario.id);
  if (new Set(ids).size !== 12 || ids.some(id => !id)) throw new Error("Scenario IDs must be twelve unique non-empty values");
  if ([...manifest.graphScenarios, ...manifest.freshnessScenarios].some(scenario => !repoIds.has(scenario.repository))) throw new Error("Every scenario must reference a declared repository");
  for (const scenario of manifest.graphScenarios) {
    if (scenario.assertionType.includes("path") || scenario.assertionType.includes("reachability")) {
      if (!scenario.from?.symbol || !scenario.to?.symbol) throw new Error(`${scenario.id} requires explicit from/to inputs`);
    } else if (!scenario.subject?.symbol) throw new Error(`${scenario.id} requires an explicit subject input`);
  }
  for (const scenario of manifest.freshnessScenarios) if (!scenario.queryInputs || (!scenario.queryInputs.symbol && !scenario.queryInputs.symbols?.length)) throw new Error(`${scenario.id} requires queryInputs`);
  return manifest;
}

/** Constructs the complete participant-visible request. Oracle/expected fields are deliberately unreachable here. */
export function graphParticipantRequest(scenario: GraphScenario): ParticipantRequest {
  if (scenario.assertionType.includes("path") || scenario.assertionType.includes("reachability")) return { operation: "shortest-path", from: scenario.from, to: scenario.to, limit: 50 };
  if (scenario.assertionType.includes("callers")) return { operation: "direct-callers", subject: scenario.subject, limit: 50 };
  if (scenario.assertionType.includes("callees")) return { operation: "direct-callees", subject: scenario.subject, limit: 50 };
  return { operation: "definitions", subject: scenario.subject, limit: 50 };
}
export function freshnessParticipantRequests(scenario: FreshnessScenario): ParticipantRequest[] {
  const symbols = scenario.queryInputs.symbols ?? (scenario.queryInputs.symbol ? [scenario.queryInputs.symbol] : []);
  return symbols.flatMap(symbol => {
    const subject = { ...(scenario.queryInputs.path ? { path: scenario.queryInputs.path } : {}), symbol };
    const requests: ParticipantRequest[] = [{ operation: "definitions", subject, limit: 50 }];
    if (scenario.id === "f1-js-add" || scenario.id === "f2-py-modify") requests.push({ operation: "direct-callees", subject, limit: 50 });
    return requests;
  });
}

async function materialize(repo: Repository, root: string): Promise<void> {
  await fs.mkdir(root, { recursive: false });
  for (const [relative, content] of Object.entries(repo.files)) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) throw new Error(`Unsafe fixture path: ${relative}`);
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
}
async function git(root: string, args: string[]): Promise<void> {
  const context: DriverContext = { sourceRoot: root, artifactDir: path.dirname(root), projectRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), configPath: "", toolsRoot: "", timeoutMs: 30_000 };
  await prepareIsolation(context);
  const result = await exec("git", args, { cwd: root, env: isolatedEnv(context), timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES });
  await evidence(context, { command: "git", args, cwd: root, env: isolatedEnv(context), ...result });
}
async function initializeBranchFixture(root: string, scenario: FreshnessScenario): Promise<void> {
  if (scenario.transition !== "real-git-branch-switch") return;
  const mutation = object(scenario.mutation, "branch mutation");
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Conformance Runner"]); await git(root, ["config", "user.email", "conformance@example.invalid"]);
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "initial"]);
  const branch = String(mutation.branch); await git(root, ["checkout", "-b", branch]);
  for (const [relative, content] of Object.entries(object(mutation.writeAndCommit, "writeAndCommit"))) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, String(content)); }
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "feature"]); await git(root, ["checkout", "main"]);
}
async function mutate(root: string, scenario: FreshnessScenario): Promise<Json> {
  const mutation = scenario.mutation;
  if (mutation.externalWriterWrite) return {};
  const writes = mutation.write;
  if (writes) for (const [relative, content] of Object.entries(object(writes, "mutation writes"))) { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, String(content)); }
  if (Array.isArray(mutation.delete)) for (const relative of mutation.delete) await fs.rm(path.join(root, String(relative)));
  if (Array.isArray(mutation.rename)) for (const item of mutation.rename) { const entry = object(item, "rename"); await fs.rename(path.join(root, String(entry.from)), path.join(root, String(entry.to))); }
  if (scenario.transition === "real-git-branch-switch") await git(root, ["checkout", String(mutation.switchTo)]);
  return {};
}

function canonicalPath(value: unknown): string { return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, ""); }
function definitionKey(value: unknown): string { const item = object(value, "definition"); return `${canonicalPath(item.path)}\0${String(item.symbol ?? "")}`; }
function definitionWithCallersKey(value: unknown): string {
  const item = object(value, "definition");
  const callers = Array.isArray(item.directCallers) ? item.directCallers.map(edgeKey).sort().join("\u0002") : "";
  return `${definitionKey(value)}\0${callers}`;
}
function edgeKey(value: unknown): string { const item = object(value, "edge"); return [canonicalPath(item.fromPath), item.fromSymbol, canonicalPath(item.toPath), item.toSymbol, item.relationship].map(String).join("\0"); }
function pathKey(value: unknown): string { if (!Array.isArray(value)) throw new Error("path must be an array"); return value.map(definitionKey).join("\u0001"); }
function exactSet(expected: unknown[], actual: unknown[], key: (value: unknown) => string): Json {
  const wanted = new Map(expected.map(value => [key(value), value])); const observed = new Map(actual.map(value => [key(value), value]));
  const missing = [...wanted].filter(([entry]) => !observed.has(entry)).map(([, value]) => value);
  const extra = [...observed].filter(([entry]) => !wanted.has(entry)).map(([, value]) => value);
  return { conforms: missing.length === 0 && extra.length === 0, missing, extra, expected, actual };
}
export function evaluateFinding(scenario: GraphScenario | FreshnessScenario, result: ParticipantResult): Json {
  const expected = "expected" in scenario ? scenario.expected : scenario;
  if (result.status !== "success") return { status: result.status, conforms: null, reason: object(result.raw, "non-success result").reason ?? "automated normalization unavailable", rawPreserved: true };
  if (scenario.id.startsWith("g")) {
    if (scenario.assertionType === "duplicate-definition-disambiguation" && result.normalized.definitionEnumeration === "single-root") return { status: "manual-adjudication-required", conforms: null, reason: "The calibrated trace interface returns one root, not an exhaustive duplicate-definition enumeration", rawPreserved: true };
    const oracle = object(expected, "graph scenario");
    const expectedEdges = Array.isArray(oracle.expectedEdges) ? oracle.expectedEdges : undefined;
    const expectedPaths = Array.isArray(oracle.expectedPaths) ? oracle.expectedPaths : undefined;
    const expectedDefinitions = Array.isArray(oracle.expectedDefinitions) ? oracle.expectedDefinitions : undefined;
    if ((expectedEdges && !Array.isArray(result.normalized.edges)) || (expectedPaths && !Array.isArray(result.normalized.paths)) || (expectedDefinitions && !Array.isArray(result.normalized.definitions))) return { status: "error", conforms: false, error: "Successful adapter response omitted its required normalized collection" };
    const comparison = expectedEdges ? exactSet(expectedEdges, result.normalized.edges ?? [], edgeKey)
      : expectedPaths ? exactSet(expectedPaths, result.normalized.paths ?? [], pathKey)
      : exactSet(expectedDefinitions ?? [], result.normalized.definitions ?? [], scenario.assertionType === "duplicate-definition-disambiguation" ? definitionWithCallersKey : definitionKey);
    return { status: "completed", ...comparison };
  }
  const oracle = object(expected, "freshness expected");
  const expectedDefinitions = Array.isArray(oracle.definitions) ? oracle.definitions : [];
  const definitions = Array.isArray(oracle.definitions) ? exactSet(expectedDefinitions, result.normalized.definitions ?? [], definitionKey) : { conforms: true, missing: [], extra: [] };
  const edges = Array.isArray(oracle.edges) ? exactSet(oracle.edges, result.normalized.edges ?? [], edgeKey) : { conforms: true, missing: [], extra: [] };
  const actualDefinitions = result.normalized.definitions ?? [];
  const missingContent = expectedDefinitions.filter(value => { const expectedDefinition = object(value, "definition"); if (typeof expectedDefinition.contentIncludes !== "string") return false; return !actualDefinitions.some(actual => definitionKey(actual) === definitionKey(value) && (actual.content ?? result.normalized.content ?? "").includes(expectedDefinition.contentIncludes as string)); });
  const forbiddenDefinitions = Array.isArray(oracle.forbiddenStaleDefinitions) ? oracle.forbiddenStaleDefinitions : [];
  const staleDefinitions = forbiddenDefinitions.filter(value => actualDefinitions.some(actual => definitionKey(actual) === definitionKey(value)));
  const searchableContent = [result.normalized.content ?? "", ...actualDefinitions.map(value => value.content ?? "")].join("\n");
  const forbiddenContent = Array.isArray(oracle.forbiddenStaleContent) ? oracle.forbiddenStaleContent.filter(value => searchableContent.includes(String(value))) : [];
  const conforms = definitions.conforms === true && edges.conforms === true && missingContent.length === 0 && staleDefinitions.length === 0 && forbiddenContent.length === 0;
  return { status: "completed", conforms, definitions, edges, missingContent, staleDefinitions, forbiddenContent, expected: oracle, actual: result.normalized };
}
function expectedPhaseScenario(scenario: FreshnessScenario, phase: "onFeature" | "onMainAfterReturn"): FreshnessScenario {
  const expected = object(object(scenario.expected, "branch expected")[phase], phase);
  return { ...scenario, expected };
}
export function evaluateBranchFinding(scenario: FreshnessScenario, feature: ParticipantResult, main: ParticipantResult): Json {
  const onFeature = evaluateFinding(expectedPhaseScenario(scenario, "onFeature"), feature);
  const onMainAfterReturn = evaluateFinding(expectedPhaseScenario(scenario, "onMainAfterReturn"), main);
  const status = feature.status !== "success" ? feature.status : main.status !== "success" ? main.status : "completed";
  return { status, conforms: status === "completed" ? onFeature.conforms === true && onMainAfterReturn.conforms === true : null, onFeature, onMainAfterReturn };
}

function isolatedEnv(context: DriverContext): Record<string, string> {
  const home = path.join(context.artifactDir, "home");
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CACHE_HOME: path.join(home, ".cache"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".state"), XDG_DATA_HOME: path.join(home, ".local/share"), TMPDIR: path.join(context.artifactDir, "tmp"), CBM_CACHE_DIR: path.join(context.artifactDir, "cbm-cache"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}
function inside(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
/** This guard runs before EVERY product process, including help and persistent stdio startup. */
export async function prepareIsolation(context: Pick<DriverContext, "sourceRoot" | "artifactDir" | "projectRoot">): Promise<void> {
  const [source, artifacts, project] = await Promise.all([fs.realpath(context.sourceRoot), fs.realpath(context.artifactDir), fs.realpath(context.projectRoot)]);
  if (inside(project, source) || inside(source, project) || inside(project, artifacts) || inside(artifacts, project) || source === artifacts || !inside(artifacts, source)) throw new Error("Refusing non-isolated conformance cwd/artifacts");
  const home = path.join(artifacts, "home");
  for (const directory of [home, path.join(home, ".cache"), path.join(home, ".config"), path.join(home, ".state"), path.join(home, ".local"), path.join(home, ".local/share"), path.join(artifacts, "tmp"), path.join(artifacts, "cbm-cache")]) {
    await fs.mkdir(directory, { recursive: true });
    if (!inside(artifacts, await fs.realpath(directory))) throw new Error("Refusing symlinked isolation directory");
  }
}
let evidenceSequence = 0;
const commandCancellation = new WeakMap<DriverContext, AbortController>();
const activeCommands = new WeakMap<DriverContext, Set<ChildProcess>>();
function cancellation(context: DriverContext): AbortController {
  let controller = commandCancellation.get(context);
  if (!controller) { controller = new AbortController(); commandCancellation.set(context, controller); }
  return controller;
}
async function evidence(context: DriverContext, record: Json): Promise<void> {
  const filename = `${process.pid}-${++evidenceSequence}.json`;
  const bytes = `${JSON.stringify({ recordedAt: new Date().toISOString(), ...record }, null, 2)}\n`;
  const directory = path.join(context.artifactDir, "public-commands");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), bytes, { flag: "wx" });
  await fs.appendFile(path.join(directory, `hashes-${process.pid}.txt`), `${createHash("sha256").update(bytes).digest("hex")}  ${filename}\n`);
}
async function publicCommand(context: DriverContext, command: string, args: string[], timeoutMs = context.timeoutMs): Promise<{ stdout: string; stderr: string }> {
  cancellation(context).signal.throwIfAborted();
  await prepareIsolation(context);
  const record = { command, args, cwd: context.sourceRoot, env: isolatedEnv(context), executableSha256: createHash("sha256").update(await fs.readFile(command)).digest("hex") };
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(command, args, { cwd: context.sourceRoot, env: isolatedEnv(context), timeout: timeoutMs, signal: cancellation(context).signal, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
      });
      let active = activeCommands.get(context);
      if (!active) { active = new Set(); activeCommands.set(context, active); }
      active.add(child); child.once("close", () => active?.delete(child));
    });
    await evidence(context, { ...record, ...result }); return result;
  } catch (error) {
    const details = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
    await evidence(context, { ...record, error: errorText(error), stdout: details.stdout, stderr: details.stderr, code: details.code }); throw error;
  }
}
async function closeCommands(context: DriverContext): Promise<void> {
  cancellation(context).abort();
  for (const child of activeCommands.get(context) ?? []) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
function mcpText(raw: unknown): string { const result = object(raw, "MCP result"); return Array.isArray(result.content) ? result.content.map(item => String(object(item, "MCP content").text ?? "")).join("\n") : ""; }
function mcpJson(raw: unknown): Json {
  const result = object(raw, "MCP response");
  if (result.isError === true) throw new Error(`Public MCP tool error: ${mcpText(raw)}`);
  return object(result.structuredContent ?? JSON.parse(mcpText(raw)), "MCP JSON response");
}
class UnresolvedEndpointError extends Error {}
function relativeFile(value: unknown, sourceRoot: string): string {
  if (typeof value !== "string" || !value || value.startsWith("<")) throw new UnresolvedEndpointError("Missing canonical source path");
  const file = canonicalPath(path.isAbsolute(value) ? path.relative(sourceRoot, value) : value);
  if (file === ".." || file.startsWith("../") || path.isAbsolute(file)) throw new Error(`Out-of-scope source path: ${value}`);
  return file;
}
function symbolNode(value: unknown, sourceRoot: string): SymbolInput {
  const item = object(value, "symbol node");
  if (typeof item.name !== "string" || !item.name) throw new Error("Missing symbol name");
  return { path: relativeFile(item.filePath ?? item.file, sourceRoot), symbol: item.name };
}
function edge(from: SymbolInput, to: SymbolInput): Json { return { fromPath: from.path, fromSymbol: from.symbol, toPath: to.path, toSymbol: to.symbol, relationship: "call" }; }
function manual(reason: string, raw: unknown, normalized: ParticipantResult["normalized"] = {}): ParticipantResult { return { status: "manual-adjudication-required", raw: { reason, response: raw }, normalized }; }
function success(raw: unknown, normalized: ParticipantResult["normalized"], provenance: Json[] = []): ParticipantResult { return { status: "success", raw, normalized, provenance }; }
function matches(candidate: SymbolInput, subject: SymbolInput): boolean { return candidate.symbol === subject.symbol && (!subject.path || canonicalPath(candidate.path) === canonicalPath(subject.path)); }

export function normalizeMcp(raw: unknown, input: ParticipantRequest): ParticipantResult["normalized"] {
  if (object(raw, "MCP response").isError === true) throw new Error(`Public MCP tool error: ${mcpText(raw)}`);
  const text = mcpText(raw);
  if (input.operation === "shortest-path") {
    const hops = [...text.matchAll(/(?:\[start\]|--[^\n]+-->)\s+([^\s(]+)(?:\s+\(([^:()]+):\d+\))?/g)]
      .map(match => ({ ...(match[2] ? { path: match[2] } : {}), symbol: match[1] }));
    if (!hops.length && !text.startsWith("No path found between")) throw new Error("Unrecognized or unresolved OCBI path response");
    if (hops.some(hop => !hop.path)) throw new UnresolvedEndpointError("OCBI path lacks canonical endpoint path");
    return { paths: hops.length ? [hops] : [], content: text };
  }
  const header = /"([^"]+)" at (.+?):\d+ (?:is called by|calls) (\d+) function\(s\):/.exec(text);
  const emptyHeader = /^No (?:callers|callees) found for "([^"]+)" at (.+?):\d+/.exec(text);
  const resolvedSubject = header ? { path: header[2], symbol: header[1] } : input.subject;
  if (header && input.subject && !matches(resolvedSubject!, input.subject)) throw new Error("OCBI graph resolved a different subject");
  if (emptyHeader && input.subject && !matches({ path: emptyHeader[2], symbol: emptyHeader[1] }, input.subject)) throw new Error("OCBI empty graph resolved a different subject");
  if ((input.operation === "direct-callers" || input.operation === "direct-callees") && !header && !emptyHeader) throw new Error("Unrecognized or unresolved OCBI graph completeness header");
  if (input.operation === "direct-callers") {
    const edges = [...text.matchAll(/^\[\d+\]\s+← from\s+(\S+)\s+in\s+(.+?)\s+\((Call|MethodCall|Constructor)\)/gm)].map(match => ({
      fromPath: match[2], fromSymbol: match[1], toPath: resolvedSubject?.path, toSymbol: resolvedSubject?.symbol, relationship: "call",
    }));
    if (!edges.length && !text.startsWith("No callers found for")) throw new Error("Unrecognized or unresolved OCBI callers response");
    if (header && Number(header[3]) !== edges.length) throw new Error("OCBI caller rows incomplete or contain non-call relationships");
    if (edges.some(item => !item.toPath || item.fromPath.startsWith("<"))) throw new UnresolvedEndpointError("OCBI caller lacks canonical endpoint path");
    return { edges, content: text };
  }
  if (input.operation === "direct-callees") {
    const edges = [...text.matchAll(/^\[\d+\]\s+→\s+(\S+)\s+\((Call|MethodCall|Constructor)\)[^\n]*$/gm)].map(match => ({
      fromPath: resolvedSubject?.path, fromSymbol: resolvedSubject?.symbol, toSymbol: match[1], relationship: "call", explicitlyResolved: match[0].endsWith("[resolved]"),
    }));
    if (!edges.length && !text.startsWith("No callees found for")) throw new Error("Unrecognized or unresolved OCBI callees response");
    if (header && Number(header[3]) !== edges.length) throw new Error("OCBI callee rows incomplete or contain non-call relationships");
    return { edges, content: text };
  }
  const symbol = input.subject?.symbol ?? "";
  const blocks = text.split(/(?=^\[\d+\])/m);
  const definitions = blocks.flatMap(block => {
    const match = /^\[\d+\]\s+\S+\s+"([^"]+)"\s+in\s+(.+?):\d+(?:-\d+)?/m.exec(block);
    return match && match[1] === symbol && (!input.subject?.path || canonicalPath(match[2]) === canonicalPath(input.subject.path)) ? [{ path: match[2], symbol: match[1], content: block }] : [];
  });
  if (!/^\[\d+\]/m.test(text) && !/No (?:matching code|definition|results|implementations) found/i.test(text)) throw new Error("Unrecognized OCBI definition response");
  return { definitions, content: text };
}

export async function resolveOcbiCallees(raw: unknown, input: ParticipantRequest, lookup: (symbol: string) => Promise<unknown>): Promise<ParticipantResult> {
  const normalized = normalizeMcp(raw, input), provenance: Json[] = [];
  for (const target of normalized.edges ?? []) {
    if (target.explicitlyResolved !== true) return manual("Public OCBI edge is unresolved; no target-path inference permitted", { primary: raw, provenance }, normalized);
    const request: ParticipantRequest = { operation: "definitions", subject: { symbol: String(target.toSymbol) }, limit: 50 };
    const followup = await lookup(request.subject!.symbol);
    const definitions = normalizeMcp(followup, request).definitions ?? [];
    provenance.push({ reason: "Exact definition lookup for explicitly resolved graph target only", request, raw: followup });
    if (definitions.length !== 1 || [...mcpText(followup).matchAll(/^\[\d+\]/gm)].length >= 50) return manual("Resolved target does not have exactly one exact definition candidate within an untruncated response", { primary: raw, provenance }, normalized);
    target.toPath = definitions[0].path;
  }
  return success(raw, normalized, provenance);
}

/** One persistent public stdio connection. Raw envelopes, requests, startup and stderr remain auditable. */
class PublicMcp {
  private client?: Client; private transport?: StdioClientTransport; private stderr = "";
  constructor(private readonly context: DriverContext, private readonly command: string, private readonly args: string[]) {}
  async call(name: string, args: Json): Promise<unknown> {
    cancellation(this.context).signal.throwIfAborted();
    await prepareIsolation(this.context);
    if (!this.client) {
      const transport = new StdioClientTransport({ command: this.command, args: this.args, cwd: this.context.sourceRoot, env: isolatedEnv(this.context), stderr: "pipe" });
      transport.stderr?.on("data", chunk => { this.stderr += String(chunk); });
      const client = new Client({ name: "competitive-conformance", version: "1" });
      this.transport = transport; this.client = client;
      await evidence(this.context, { phase: "mcp-start", command: this.command, args: this.args, cwd: this.context.sourceRoot, env: isolatedEnv(this.context), executableSha256: createHash("sha256").update(await fs.readFile(this.command)).digest("hex") });
      if (this.command === process.execPath && this.args[0]) await evidence(this.context, { phase: "mcp-entrypoint", path: this.args[0], sha256: createHash("sha256").update(await fs.readFile(this.args[0])).digest("hex") });
      cancellation(this.context).signal.throwIfAborted();
      await client.connect(transport);
      await evidence(this.context, { phase: "mcp-list-tools", response: await client.listTools() });
    }
    try {
      const raw = await this.client.callTool({ name, arguments: args }, undefined, { timeout: name === "index_repository" || name === "index_codebase" ? INDEX_TIMEOUT_MS : this.context.timeoutMs });
      await evidence(this.context, { request: { name, arguments: args }, raw });
      if (object(raw, "MCP response").isError === true) throw new Error(`Public MCP tool error: ${mcpText(raw)}`);
      return raw;
    } catch (error) { await evidence(this.context, { request: { name, arguments: args }, error: errorText(error) }); throw error; }
  }
  async close(): Promise<void> {
    try { await this.client?.close(); await this.transport?.close(); }
    finally { await evidence(this.context, { phase: "mcp-close", stderr: this.stderr }); this.client = undefined; this.transport = undefined; }
  }
}

class OcbiDriver implements ConformanceDriver {
  supportsPersistentReader = true; private readonly mcp: PublicMcp;
  constructor(context: DriverContext) {
    this.mcp = new PublicMcp(context, process.execPath, [path.join(context.projectRoot, "dist/cli.js"), "--project", context.sourceRoot, "--host", "opencode", "--config", context.configPath]);
  }
  async index(): Promise<unknown> { return this.mcp.call("index_codebase", { force: true }); }
  async refresh(): Promise<unknown> { return this.mcp.call("index_codebase", { force: false }); }
  async request(input: ParticipantRequest): Promise<ParticipantResult> {
    let name: string; let args: Json;
    if (input.operation === "shortest-path") { name = "call_graph_path"; args = { from: input.from?.symbol, fromFilePath: input.from?.path, to: input.to?.symbol, toFilePath: input.to?.path, maxDepth: 10 }; }
    else if (input.operation === "direct-callers" || input.operation === "direct-callees") { name = "call_graph"; args = { name: input.subject?.symbol, filePath: input.subject?.path, direction: input.operation === "direct-callers" ? "callers" : "callees" }; }
    else { name = "implementation_lookup"; args = { query: input.subject?.symbol, limit: input.limit }; }
    const raw = await this.mcp.call(name, args);
    if (input.operation === "direct-callees") return resolveOcbiCallees(raw, input, symbol => this.mcp.call("implementation_lookup", { query: symbol, limit: 50 }));
    const normalized = normalizeMcp(raw, input);
    if (input.operation === "definitions" && [...mcpText(raw).matchAll(/^\[\d+\]/gm)].length >= input.limit) return manual("OCBI lookup reached fixed cap", raw, normalized);
    return success(raw, normalized);
  }
  async close(): Promise<void> { await this.mcp.close(); }
}

/** Exact named-node projection only. Mentioning a symbol in a body is not a definition. */
export function normalizeCodeGraphDefinitions(raw: unknown, subject: SymbolInput, sourceRoot: string): SymbolInput[] {
  if (!Array.isArray(raw)) throw new Error("CodeGraph query must return an array");
  return raw.map(row => symbolNode(object(row, "query hit").node, sourceRoot)).filter(candidate => matches(candidate, subject));
}
export function normalizeCodeGraphEdges(raw: unknown, input: ParticipantRequest, resolvedSubject: SymbolInput, sourceRoot: string): Json[] {
  const result = object(raw, "CodeGraph graph"); const field = input.operation === "direct-callers" ? "callers" : "callees";
  if (result.symbol !== resolvedSubject.symbol || !Array.isArray(result[field])) throw new Error("Malformed CodeGraph graph response");
  return (result[field] as unknown[]).map(row => { const other = symbolNode(row, sourceRoot); return field === "callers" ? edge(other, resolvedSubject) : edge(resolvedSubject, other); });
}

interface CbmNode extends SymbolInput { qualifiedName: string }
export function normalizeCbmDefinitions(raw: unknown, subject: SymbolInput, sourceRoot: string): CbmNode[] {
  const result = mcpJson(raw);
  if (!Array.isArray(result.groups) || !Array.isArray(result.cols)) throw new Error("Malformed CBM grouped definition response");
  const nameIndex = result.cols.indexOf("name"), labelIndex = result.cols.indexOf("label");
  if (nameIndex < 0 || labelIndex < 0) throw new Error("CBM definition columns missing");
  const nodes: CbmNode[] = [];
  for (const entry of result.groups) {
    const group = object(entry, "CBM group");
    if (!Array.isArray(group.rows) || typeof group.qn_prefix !== "string") throw new Error("Malformed CBM group");
    for (const row of group.rows) {
      if (!Array.isArray(row)) throw new Error("Malformed CBM row");
      // This conformance track asks for callable definitions, not folders or textual mentions.
      const label = String(row[labelIndex]);
      if (["Folder", "File", "Module", "Class", "Interface", "Struct", "Enum", "Variable", "Route", "Channel"].includes(label)) continue;
      if (!["Function", "Method"].includes(label)) throw new Error(`Uncalibrated CBM node label: ${label}`);
      if (typeof row[nameIndex] !== "string") throw new Error("Malformed CBM name");
      const node = { symbol: row[nameIndex] as string, path: relativeFile(group.file, sourceRoot), qualifiedName: `${group.qn_prefix}.${String(row[nameIndex])}` };
      if (matches(node, subject)) nodes.push(node);
    }
  }
  return nodes;
}
export function normalizeCbmTrace(raw: unknown, direction: "callers" | "callees"): Array<{ symbol: string; qualifiedName: string }> {
  const result = mcpJson(raw), total = result[`${direction}_total`];
  if (result.truncated === true) throw new Error("CBM direct graph response truncated at fixed cap");
  if (total === 0 && result[direction] === undefined) return [];
  const table = object(result[direction], "CBM trace table");
  if (!Array.isArray(table.cols) || !Array.isArray(table.groups)) throw new Error("Malformed CBM trace table");
  const nameIndex = table.cols.indexOf("name"), hopIndex = table.cols.indexOf("hop");
  if (nameIndex < 0 || hopIndex < 0) throw new Error("CBM trace columns missing");
  const nodes = table.groups.flatMap(entry => {
    const group = object(entry, "CBM trace group");
    if (typeof group.qn_prefix !== "string" || !Array.isArray(group.rows)) throw new Error("Malformed CBM trace group");
    return group.rows.map(row => {
      if (!Array.isArray(row) || typeof row[nameIndex] !== "string" || row[hopIndex] !== 1) throw new Error("CBM direct trace must contain only hop-one rows");
      return { symbol: row[nameIndex] as string, qualifiedName: `${group.qn_prefix}.${String(row[nameIndex])}` };
    });
  });
  if (total !== nodes.length) throw new Error("CBM trace count mismatch");
  return nodes;
}

/** Bounded BFS over ONLY observed public edges. No source parsing or inferred/transitive edges. */
export function shortestObservedPaths(edges: Json[], from: SymbolInput, to: SymbolInput, maxDepth = 10): SymbolInput[][] {
  const queue: SymbolInput[][] = [[from]], found: SymbolInput[][] = []; let distance = Infinity;
  while (queue.length) {
    const current = queue.shift()!; const last = current[current.length - 1];
    if (current.length - 1 > distance) break;
    if (matches(last, to)) { found.push(current); distance = current.length - 1; continue; }
    if (current.length - 1 >= maxDepth) continue;
    for (const item of edges) {
      if (definitionKey({ path: item.fromPath, symbol: item.fromSymbol }) !== definitionKey(last)) continue;
      const next = { path: String(item.toPath), symbol: String(item.toSymbol) };
      if (!current.some(node => definitionKey(node) === definitionKey(next))) queue.push([...current, next]);
      if (queue.length + found.length > 2500) throw new Error("Observed path traversal exceeded bounded path budget");
    }
  }
  return [...new Map(found.map(value => [pathKey(value), value])).values()];
}
async function traversePublicCallees(driver: ConformanceDriver, input: ParticipantRequest): Promise<ParticipantResult> {
  if (!input.from?.path || !input.to?.path) return manual("Path traversal requires explicit endpoint paths", input);
  const pending = [{ node: input.from, depth: 0 }], visited = new Set<string>(), edges: Json[] = [], provenance: Json[] = [];
  while (pending.length) {
    const { node, depth } = pending.shift()!; const key = definitionKey(node);
    if (visited.has(key) || depth >= 10 || matches(node, input.to)) continue;
    if (visited.size >= input.limit) return manual("Public adjacency traversal reached fixed 50-node budget", provenance, { edges });
    visited.add(key);
    const request: ParticipantRequest = { operation: "direct-callees", subject: node, limit: input.limit };
    const result = await driver.request(request); provenance.push({ request, result });
    if (result.status !== "success") return manual("Public adjacency cannot be normalized without guessing", provenance, { edges });
    for (const item of result.normalized.edges ?? []) {
      edges.push(item); pending.push({ node: { path: String(item.toPath), symbol: String(item.toSymbol) }, depth: depth + 1 });
    }
  }
  return success(provenance, { paths: shortestObservedPaths(edges, input.from, input.to) }, [{ method: "bounded BFS on public direct-callee responses", maxDepth: 10, maxNodes: input.limit }]);
}

class CodeGraphDriver implements ConformanceDriver {
  supportsPersistentReader = false;
  constructor(private readonly context: DriverContext) {}
  private async run(args: string[], timeoutMs = this.context.timeoutMs): Promise<{ stdout: string; stderr: string }> { return publicCommand(this.context, path.join(this.context.toolsRoot, "npm/node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph"), args, timeoutMs); }
  async index(): Promise<unknown> { return this.run(["init", this.context.sourceRoot, "--yes"], INDEX_TIMEOUT_MS); }
  async refresh(): Promise<unknown> { return this.run(["index", this.context.sourceRoot], INDEX_TIMEOUT_MS); }
  async request(input: ParticipantRequest): Promise<ParticipantResult> {
    if (input.operation === "shortest-path") return traversePublicCallees(this, input);
    const subject = input.subject!;
    const query = await this.run(["query", subject.symbol, "--path", this.context.sourceRoot, "--limit", String(input.limit), "--json"]);
    const raw: unknown = JSON.parse(query.stdout);
    const all = normalizeCodeGraphDefinitions(raw, { symbol: subject.symbol }, this.context.sourceRoot);
    const definitions = all.filter(candidate => matches(candidate, subject));
    if (Array.isArray(raw) && raw.length >= input.limit) return manual("CodeGraph query reached fixed cap; completeness unavailable", query);
    const provenance: Json[] = [{ command: "query", raw: query }];
    if (input.operation === "definitions") {
      const withContent = [];
      for (const candidate of definitions) {
        const source = await this.run(["node", candidate.symbol, "--file", candidate.path!, "--path", this.context.sourceRoot]);
        provenance.push({ command: "node", subject: candidate, raw: source });
        const location = /\*\*Location:\*\* (.+?):\d+/.exec(source.stdout);
        if (!source.stdout.startsWith(`**${candidate.symbol}** (`) || !location || relativeFile(location[1], this.context.sourceRoot) !== candidate.path) return manual("CodeGraph node did not preserve exact indexed identity", provenance);
        const block = /```[^\n]*\n([\s\S]*?)\n```/.exec(source.stdout);
        if (!block) return manual("CodeGraph node did not return a calibrated source block", provenance);
        withContent.push({ ...candidate, content: block[1].replace(/^\d+\t/gm, "") });
      }
      return success(query, { definitions: withContent }, provenance);
    }
    if (!definitions.length) return success(query, { edges: [] }, provenance);
    if (definitions.length !== 1) return manual("CodeGraph subject remains ambiguous", query);
    if (all.length !== 1) return manual("CodeGraph callers/callees CLI lacks file disambiguation; node trail on duplicate names needs separate calibration", query);
    const result = await this.run([input.operation === "direct-callers" ? "callers" : "callees", subject.symbol, "--path", this.context.sourceRoot, "--limit", String(input.limit), "--json"]);
    const edges = normalizeCodeGraphEdges(JSON.parse(result.stdout), input, definitions[0], this.context.sourceRoot);
    if (edges.length >= input.limit) return manual("CodeGraph adjacency reached fixed cap", result, { edges });
    return success(result, { edges }, provenance);
  }
  async close(): Promise<void> {}
}

class CbmDriver implements ConformanceDriver {
  supportsPersistentReader = true; private readonly mcp: PublicMcp; private project?: string;
  constructor(private readonly context: DriverContext) { this.mcp = new PublicMcp(context, path.join(context.toolsRoot, "npm/node_modules/codebase-memory-mcp/bin/codebase-memory-mcp"), []); }
  async index(): Promise<unknown> {
    const raw = await this.mcp.call("index_repository", { repo_path: this.context.sourceRoot, mode: "full", persistence: false });
    const project = mcpJson(raw).project; if (typeof project !== "string" || !project) throw new Error("CBM index response lacks project"); this.project = project; return raw;
  }
  async refresh(): Promise<unknown> { return this.index(); }
  private async search(subject: SymbolInput, limit: number, qualifiedName?: string): Promise<{ raw: unknown; nodes: CbmNode[] }> {
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const raw = await this.mcp.call("search_graph", { project: this.project, name_pattern: `^${escape(subject.symbol)}$`, ...(qualifiedName ? { qn_pattern: `^${escape(qualifiedName)}$` } : {}), limit, format: "json" });
    if (mcpJson(raw).has_more === true) throw new Error("CBM definition response truncated at fixed cap");
    return { raw, nodes: normalizeCbmDefinitions(raw, subject, this.context.sourceRoot) };
  }
  async request(input: ParticipantRequest): Promise<ParticipantResult> {
    if (!this.project) throw new Error("CBM project unavailable");
    if (input.operation === "shortest-path") return traversePublicCallees(this, input);
    const subject = input.subject!, searched = await this.search(subject, input.limit);
    const provenance: Json[] = [{ operation: "search_graph", raw: searched.raw }];
    if (input.operation === "definitions") {
      const definitions = [];
      for (const node of searched.nodes) {
        const raw = await this.mcp.call("get_code_snippet", { project: this.project, qualified_name: node.qualifiedName }); provenance.push({ operation: "get_code_snippet", qualifiedName: node.qualifiedName, raw });
        const snippet = mcpJson(raw);
        if (snippet.qualified_name !== node.qualifiedName || relativeFile(snippet.file_path, this.context.sourceRoot) !== node.path || typeof snippet.source !== "string") return manual("CBM snippet did not preserve exact indexed identity", provenance);
        definitions.push({ path: node.path, symbol: node.symbol, content: snippet.source });
      }
      return success(searched.raw, { definitions }, provenance);
    }
    if (!searched.nodes.length) return success(searched.raw, { edges: [] }, provenance);
    if (searched.nodes.length !== 1) return manual("CBM subject remains ambiguous", searched.raw);
    const node = searched.nodes[0], direction = input.operation === "direct-callers" ? "callers" : "callees";
    const raw = await this.mcp.call("trace_path", { project: this.project, function_name: node.qualifiedName, direction: direction === "callers" ? "inbound" : "outbound", depth: 1, limit: input.limit, format: "json", include_tests: true });
    const edges: Json[] = [];
    for (const target of normalizeCbmTrace(raw, direction)) {
      const resolved = await this.search({ symbol: target.symbol }, input.limit, target.qualifiedName);
      provenance.push({ operation: "search_graph", qualifiedName: target.qualifiedName, raw: resolved.raw });
      if (resolved.nodes.length !== 1 || resolved.nodes[0].qualifiedName !== target.qualifiedName) return manual("CBM trace endpoint has no unique exact qualified-name path", { primary: raw, provenance });
      edges.push(direction === "callers" ? edge(resolved.nodes[0], node) : edge(node, resolved.nodes[0]));
    }
    return success(raw, { edges }, provenance);
  }
  async close(): Promise<void> { await this.mcp.close(); }
}

export function normalizeGrepai(raw: unknown, input: ParticipantRequest, sourceRoot: string): ParticipantResult {
  const result = object(raw, "grepai trace");
  const subject = input.subject ?? input.from!;
  if (result.query !== subject.symbol || result.mode !== "fast") throw new Error("Unrecognized grepai trace envelope");
  if (input.operation === "shortest-path") {
    if (!result.graph) return manual("grepai graph absence envelope has not been calibrated as complete path absence", raw);
    const graph = object(result.graph, "grepai graph"), nodes = object(graph.nodes, "grepai graph nodes");
    if (graph.root !== subject.symbol || graph.depth !== 10 || graph.truncated === true || result.truncated === true) return manual("grepai graph does not cover requested root/depth without truncation", raw);
    if (!nodes[subject.symbol] || !matches(symbolNode(nodes[subject.symbol], sourceRoot), subject)) return manual("grepai graph root does not resolve the requested endpoint path", raw);
    if (!Array.isArray(graph.edges)) throw new Error("Malformed grepai graph edges");
    const edges = graph.edges.map(value => {
      const item = object(value, "grepai edge");
      if (typeof item.caller !== "string" || typeof item.callee !== "string" || !nodes[item.caller] || !nodes[item.callee]) throw new UnresolvedEndpointError("grepai edge lacks returned node endpoint");
      return edge(symbolNode(nodes[item.caller], sourceRoot), symbolNode(nodes[item.callee], sourceRoot));
    });
    return success(raw, { paths: shortestObservedPaths(edges, input.from!, input.to!) });
  }
  if (!result.symbol) return success(raw, input.operation === "definitions" ? { definitions: [] } : { edges: [] });
  const root = symbolNode(result.symbol, sourceRoot);
  if (!matches(root, subject)) return manual("grepai trace selected a different subject definition; file-disambiguation interface not calibrated", raw);
  if (input.operation === "definitions") return success(raw, { definitions: [root], definitionEnumeration: "single-root" }, [{ limitation: "Public trace exposes one root definition and signature, not all duplicate definitions or indexed body content" }]);
  const direction = input.operation === "direct-callers" ? "callers" : "callees";
  // Go's omitempty may omit an empty neighbor slice on an otherwise valid trace envelope.
  if (result[direction] !== undefined && !Array.isArray(result[direction])) throw new Error("Malformed grepai neighbors");
  const edges = ((result[direction] ?? []) as unknown[]).map(value => {
    const other = symbolNode(object(value, "grepai neighbor").symbol, sourceRoot);
    return direction === "callers" ? edge(other, root) : edge(root, other);
  });
  return success(raw, { edges }); // Preserve reported self-calls, including regex extraction errors.
}

class GrepaiDriver implements ConformanceDriver {
  supportsPersistentReader = false; private watcher?: ChildProcess; private logs = "";
  constructor(private readonly context: DriverContext) {}
  private executable(): string { return path.join(this.context.toolsRoot, "grepai/grepai"); }
  async index(): Promise<unknown> {
    const initialized = await publicCommand(this.context, this.executable(), ["init", "--yes", "--provider", "ollama", "--model", "nomic-embed-text", "--backend", "gob"], INDEX_TIMEOUT_MS);
    return { initialized, watcher: await this.startWatcher() };
  }
  private async startWatcher(): Promise<unknown> {
    await prepareIsolation(this.context); this.logs = "";
    await evidence(this.context, { command: this.executable(), args: ["watch", "--no-ui"], cwd: this.context.sourceRoot, env: isolatedEnv(this.context) });
    cancellation(this.context).signal.throwIfAborted();
    const watcher = spawn(this.executable(), ["watch", "--no-ui"], { cwd: this.context.sourceRoot, env: isolatedEnv(this.context), stdio: ["ignore", "pipe", "pipe"] }); this.watcher = watcher;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("grepai initial symbol scan timed out")); }, INDEX_TIMEOUT_MS);
      const cleanup = (): void => { clearTimeout(timer); watcher.off("error", failed); watcher.off("exit", exited); };
      const failed = (error: Error): void => { cleanup(); reject(error); };
      const exited = (): void => { cleanup(); reject(new Error("grepai watcher exited before readiness")); };
      const data = (chunk: Buffer): void => { this.logs += String(chunk); if (this.logs.includes("Symbol index built:") && this.logs.includes("Watching for changes...")) { cleanup(); resolve(); } };
      watcher.stdout?.on("data", data); watcher.stderr?.on("data", data); watcher.once("error", failed); watcher.once("exit", exited);
    });
    await evidence(this.context, { phase: "grepai-ready", logs: this.logs }); return { ready: true, readiness: "public initial scan plus symbol index built and watching log" };
  }
  // A foreground restart is a documented initial disk scan, not an answer-dependent sleep/poll.
  async refresh(): Promise<unknown> { await this.stopWatcher(); return { refreshPolicy: "foreground watcher restart and initial scan", result: await this.startWatcher() }; }
  async request(input: ParticipantRequest): Promise<ParticipantResult> {
    const symbol = (input.subject ?? input.from)!.symbol;
    const mode = input.operation === "shortest-path" ? "graph" : input.operation === "direct-callees" ? "callees" : "callers";
    const raw = await publicCommand(this.context, this.executable(), ["trace", mode, symbol, ...(mode === "graph" ? ["--depth", "10"] : []), "--json"]);
    return normalizeGrepai(JSON.parse(raw.stdout), input, this.context.sourceRoot);
  }
  private async stopWatcher(): Promise<void> {
    const watcher = this.watcher; if (!watcher) return;
    if (watcher.exitCode === null && watcher.signalCode === null) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { watcher.kill("SIGKILL"); reject(new Error("grepai watcher did not stop within 5s")); }, 5000);
      watcher.once("close", () => { clearTimeout(timer); resolve(); }); watcher.kill("SIGTERM");
    });
    await evidence(this.context, { phase: "grepai-stopped", logs: this.logs }); this.watcher = undefined;
  }
  async close(): Promise<void> { await this.stopWatcher(); }
}
export function createConformanceDriver(condition: Condition, context: DriverContext): ConformanceDriver {
  const driver = condition === "ocbi-hybrid" || condition === "ocbi-structural" ? new OcbiDriver(context)
    : condition === "codegraph" ? new CodeGraphDriver(context)
      : condition === "codebase-memory" ? new CbmDriver(context) : new GrepaiDriver(context);
  return {
    supportsPersistentReader: driver.supportsPersistentReader,
    index: () => driver.index(), refresh: () => driver.refresh(), close: () => driver.close(),
    async request(input) {
      try { return await driver.request(input); }
      catch (error) {
        if (error instanceof UnresolvedEndpointError) return manual(error.message, { rawResponseDirectory: path.join(context.artifactDir, "public-commands") });
        throw error;
      }
    },
  };
}

interface ExternalWriterPayload { condition: Condition; context: DriverContext; writes: Json }
async function runExternalWriterPayload(payload: ExternalWriterPayload): Promise<Json> {
  for (const [relative, content] of Object.entries(payload.writes)) {
    const file = path.join(payload.context.sourceRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, String(content), "utf8");
  }
  const driver = createConformanceDriver(payload.condition, payload.context);
  try { return { writerPid: process.pid, indexResponse: await driver.index() }; }
  finally { await driver.close(); }
}
async function defaultExternalWriter(condition: Condition, context: DriverContext, writes: Json): Promise<Json> {
  const payload = Buffer.from(JSON.stringify({ condition, context, writes } satisfies ExternalWriterPayload)).toString("base64");
  // Resolve the loader from this package, never from the isolated fixture's node_modules.
  const loader = fileURLToPath(import.meta.resolve("tsx"));
  const result = await publicCommand(context, process.execPath, ["--import", loader, fileURLToPath(import.meta.url), "--external-writer", payload], INDEX_TIMEOUT_MS);
  const line = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (!line) throw new Error("External writer returned no JSON response");
  return object(JSON.parse(line), "external writer response");
}

async function queryFreshness(driver: ConformanceDriver, scenario: FreshnessScenario, timeoutMs: number, transcript: Json[], phase: string): Promise<ParticipantResult> {
  const values: ParticipantResult[] = [];
  for (const request of freshnessParticipantRequests(scenario)) {
    const result = await timed(() => driver.request(request), timeoutMs);
    transcript.push({ phase, request, ...result });
    if (result.error) throw new Error(result.error);
    if (result.value?.status === "success" && !Array.isArray(request.operation === "definitions" ? result.value.normalized.definitions : result.value.normalized.edges)) throw new Error("Successful freshness adapter omitted its required normalized collection");
    if (result.value) values.push(result.value);
  }
  const nonSuccess = values.find(value => value.status !== "success");
  if (nonSuccess) return nonSuccess;
  return {
    status: "success",
    raw: values.map(value => value.raw),
    normalized: {
      definitions: values.flatMap(value => value.normalized.definitions ?? []),
      edges: values.flatMap(value => value.normalized.edges ?? []),
      paths: values.flatMap(value => value.normalized.paths ?? []),
      content: values.map(value => value.normalized.content ?? "").join("\n"),
    },
    provenance: values.flatMap(value => value.provenance ?? []),
  };
}

async function sourceSnapshot(root: string, files: string[]): Promise<Json[]> {
  return Promise.all([...new Set(files)].sort().map(async file => {
    const relative = relativeFile(file, root);
    try { const bytes = await fs.readFile(path.join(root, relative)); return { path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: relative, missing: true }; throw error; }
  }));
}

async function runCell(options: RunOptions, manifest: ConformanceManifest, condition: Condition, scenario: GraphScenario | FreshnessScenario, kind: "graph" | "freshness"): Promise<void> {
  const repo = manifest.repositories.find(candidate => candidate.id === scenario.repository); if (!repo) throw new Error(`Unknown repository: ${scenario.repository}`);
  const artifactDir = path.join(options.outputRoot, kind, scenario.id, condition); const sourceRoot = path.join(artifactDir, "source");
  await fs.mkdir(path.dirname(artifactDir), { recursive: true });
  await fs.mkdir(artifactDir, { recursive: false }); await materialize(repo, sourceRoot);
  if (kind === "freshness") await initializeBranchFixture(sourceRoot, scenario as FreshnessScenario);
  const mutation = kind === "freshness" ? (scenario as FreshnessScenario).mutation : {};
  const sourceFiles = [...Object.keys(repo.files), ...[mutation.write, mutation.writeAndCommit, mutation.externalWriterWrite].flatMap(value => value ? Object.keys(object(value, "source writes")) : []), ...(Array.isArray(mutation.rename) ? mutation.rename.flatMap(value => { const rename = object(value, "rename"); return [String(rename.from), String(rename.to)]; }) : [])];
  await save(path.join(artifactDir, "source-before.json"), await sourceSnapshot(sourceRoot, sourceFiles));
  const configPath = path.join(artifactDir, "ocbi-config.json"); await save(configPath, { embeddingProvider: "ollama", embeddingModel: "nomic-embed-text", indexing: { mode: condition === "ocbi-structural" ? "structural" : "hybrid", autoIndex: false, watchFiles: false, requireProjectMarker: false }, reranker: { enabled: false } });
  const context = { sourceRoot, artifactDir, toolsRoot: options.toolsRoot, projectRoot: options.projectRoot, configPath, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  const driver = await (options.driverFactory ?? createConformanceDriver)(condition, context); const transcript: Json[] = [];
  try {
    const indexed = await timed(() => driver.index(), INDEX_TIMEOUT_MS); transcript.push({ phase: "index", ...indexed });
    if (indexed.error) throw new Error(indexed.error);
    if (kind === "graph") {
      const request = graphParticipantRequest(scenario as GraphScenario); const result = await timed(() => driver.request(request), context.timeoutMs); transcript.push({ phase: "request", request, ...result });
      let value = result.value;
      if (value?.status === "success" && (scenario as GraphScenario).assertionType === "duplicate-definition-disambiguation") {
        const definitions = [];
        for (const candidate of value.normalized.definitions ?? []) {
          const callerRequest: ParticipantRequest = { operation: "direct-callers", subject: { path: candidate.path, symbol: candidate.symbol }, limit: 50 };
          const callers = await timed(() => driver.request(callerRequest), context.timeoutMs);
          transcript.push({ phase: "candidate-callers", request: callerRequest, ...callers });
          if (callers.error) throw new Error(callers.error);
          if (!callers.value) throw new Error("Missing candidate caller response");
          if (callers.value.status !== "success") { value = callers.value; break; }
          if (!Array.isArray(callers.value.normalized.edges)) throw new Error("Successful caller adapter omitted normalized edges");
          definitions.push({ ...candidate, directCallers: callers.value.normalized.edges ?? [] });
        }
        if (value.status === "success") value = { ...value, normalized: { ...value.normalized, definitions } };
      }
      await save(path.join(artifactDir, "finding.json"), value ? evaluateFinding(scenario, value) : { status: result.error?.includes("timed out") ? "timeout" : "error", conforms: false, error: result.error });
    } else {
      const fresh = scenario as FreshnessScenario;
      if (fresh.transition === "long-lived-reader-external-writer" && !driver.supportsPersistentReader) { await save(path.join(artifactDir, "finding.json"), { status: "adapter-blocked", conforms: null, reason: "Calibrated persistent-reader adapter unavailable" }); return; }
      let refreshed: { value?: unknown; error?: string; durationMs: number };
      if (fresh.transition === "long-lived-reader-external-writer") {
        const writes = object(fresh.mutation.externalWriterWrite, "external writer writes");
        const written = await timed(() => (options.externalWriter ?? defaultExternalWriter)(condition, context, writes), INDEX_TIMEOUT_MS);
        transcript.push({ phase: "external-writer-public-index", ...written });
        if (written.error) throw new Error(written.error);
        refreshed = { value: { readerReindexSkipped: true }, durationMs: 0 };
      } else {
        const mutationEvidence = await mutate(sourceRoot, fresh); transcript.push({ phase: "mutation", transition: fresh.transition, mutation: fresh.mutation, sourceState: await sourceSnapshot(sourceRoot, sourceFiles), ...mutationEvidence });
        refreshed = await timed(() => driver.refresh(), INDEX_TIMEOUT_MS); transcript.push({ phase: "refresh", ...refreshed });
      }
      if (refreshed.error) throw new Error(refreshed.error);
      const featureOrCurrent = await queryFreshness(driver, fresh, context.timeoutMs, transcript, "post-refresh-request");
      if (fresh.transition === "real-git-branch-switch") {
        await git(sourceRoot, ["checkout", "main"]); transcript.push({ phase: "return-main" });
        const mainRefresh = await timed(() => driver.refresh(), INDEX_TIMEOUT_MS); transcript.push({ phase: "return-main-refresh", ...mainRefresh });
        if (mainRefresh.error) throw new Error(mainRefresh.error);
        const main = await queryFreshness(driver, fresh, context.timeoutMs, transcript, "return-main-request");
        await save(path.join(artifactDir, "finding.json"), evaluateBranchFinding(fresh, featureOrCurrent, main));
      } else await save(path.join(artifactDir, "finding.json"), evaluateFinding(fresh, featureOrCurrent));
    }
  } catch (error) { await save(path.join(artifactDir, "finding.json"), { status: errorText(error).includes("timed out") ? "timeout" : "error", conforms: false, error: errorText(error) }); }
  finally {
    await closeCommands(context);
    try { await driver.close(); } catch (error) { transcript.push({ phase: "close", error: errorText(error) }); }
    await save(path.join(artifactDir, "source-after.json"), await sourceSnapshot(sourceRoot, sourceFiles));
    await save(path.join(artifactDir, "transcript.json"), transcript);
  }
}

export async function runConformance(options: RunOptions): Promise<void> {
  if (!options.conditions.length || new Set(options.conditions).size !== options.conditions.length || options.conditions.some(value => !CONDITIONS.includes(value))) throw new Error("Invalid conditions");
  const manifestBytes = await fs.readFile(options.manifestPath); const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
  await fs.mkdir(options.outputRoot, { recursive: false });
  await save(path.join(options.outputRoot, "run.json"), { startedAt: new Date().toISOString(), manifestPath: path.resolve(options.manifestPath), manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), runnerSha256: createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex"), conditions: options.conditions, purpose: "per-cell synthetic conformance only; no superiority claim", adapterBounds: { adjacencyLimit: 50, pathDepth: 10, pathVisitedNodes: 50, grepaiMode: "fast (public default)", grepaiRefresh: "foreground watcher restart with observed initial-scan readiness", codegraphRefresh: "public index", cbmRefresh: "public index_repository", snippetProvenance: "CodeGraph node and CBM get_code_snippet are public source-read interfaces, not proof of an indexed-body snapshot" } });
  for (const scenario of manifest.graphScenarios) for (const condition of options.conditions) await runCell(options, manifest, condition, scenario, "graph");
  for (const scenario of manifest.freshnessScenarios) for (const condition of options.conditions) await runCell(options, manifest, condition, scenario, "freshness");
  await save(path.join(options.outputRoot, "completed.json"), { completedAt: new Date().toISOString(), cells: 12 * options.conditions.length });
}

export function parseArgs(args: readonly string[]): { outputRoot: string; toolsRoot: string; conditions: Condition[] } {
  const values = new Map<string, string>(); for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!key || !["--output", "--tools-root", "--conditions"].includes(key) || !value) throw new Error("Usage: competitive-conformance.ts --output NEW_PATH --tools-root PATH [--conditions a,b]"); if (values.has(key)) throw new Error(`Duplicate argument: ${key}`); values.set(key, value); }
  if (!values.get("--output") || !values.get("--tools-root")) throw new Error("Usage: competitive-conformance.ts --output NEW_PATH --tools-root PATH [--conditions a,b]");
  const conditions = (values.get("--conditions")?.split(",") ?? [...CONDITIONS]) as Condition[]; if (!conditions.length || conditions.some(value => !CONDITIONS.includes(value))) throw new Error("Unknown condition");
  return { outputRoot: path.resolve(values.get("--output")!), toolsRoot: path.resolve(values.get("--tools-root")!), conditions };
}
async function main(): Promise<void> { const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); const parsed = parseArgs(process.argv.slice(2)); await runConformance({ projectRoot, manifestPath: path.join(projectRoot, "benchmarks/competitive/2026-09-10/conformance.json"), ...parsed }); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const writerIndex = process.argv.indexOf("--external-writer");
  const operation = writerIndex >= 0
    ? runExternalWriterPayload(JSON.parse(Buffer.from(process.argv[writerIndex + 1] ?? "", "base64").toString("utf8")) as ExternalWriterPayload).then(value => console.log(JSON.stringify(value)))
    : main();
  void operation.catch(error => { console.error(error); process.exitCode = 1; });
}
