import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const INDEX_TIMEOUT_MS = 300_000;
const QUERY_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type CompetitiveCondition =
  | "ocbi-hybrid"
  | "ocbi-structural"
  | "codegraph"
  | "codebase-memory"
  | "grepai";

export interface CompetitiveAdapterOptions {
  projectRoot: string;
  toolsRoot: string;
  ocbiCliPath: string;
  configPath: string;
  artifactDir: string;
}

export interface CompetitiveQuery {
  query: string;
  symbol?: string;
  limit: number;
}

export interface CompetitiveQueryResult {
  status: "success" | "unsupported";
  paths: string[];
  raw: unknown;
  durationMs: number;
}

export interface CompetitiveAdapter {
  index(): Promise<void>;
  query(input: CompetitiveQuery): Promise<CompetitiveQueryResult>;
  close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isolatedEnv(options: CompetitiveAdapterOptions, extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  const home = path.join(options.artifactDir, "home");
  for (const directory of [
    options.artifactDir,
    home,
    path.join(home, ".cache"),
    path.join(home, ".config"),
    path.join(home, ".local", "state"),
    path.join(options.artifactDir, "tmp"),
  ]) mkdirSync(directory, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: path.join(options.artifactDir, "tmp"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

let artifactSequence = 0;

function persistRaw(options: CompetitiveAdapterOptions, name: string, raw: unknown): void {
  mkdirSync(options.artifactDir, { recursive: true });
  artifactSequence += 1;
  const suffix = String(artifactSequence).padStart(6, "0");
  writeFileSync(path.join(options.artifactDir, `${name}-${suffix}.json`), JSON.stringify(raw, null, 2), "utf8");
}

async function bounded<T>(label: string, operation: Promise<T>, timeoutMs = QUERY_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runJson(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = QUERY_TIMEOUT_MS,
  artifacts?: { options: CompetitiveAdapterOptions; name: string },
): Promise<unknown> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    });
    try {
      const raw = parseJson(result.stdout, path.basename(executable));
      if (artifacts) persistRaw(artifacts.options, artifacts.name, { command: [executable, ...args], stdout: result.stdout, stderr: result.stderr, raw });
      return raw;
    } catch (error: unknown) {
      if (artifacts) persistRaw(artifacts.options, `${artifacts.name}-malformed`, { command: [executable, ...args], stdout: result.stdout, stderr: result.stderr });
      throw error;
    }
  } catch (error: unknown) {
    if (artifacts && typeof error === "object" && error !== null && !("stdout" in error && typeof error.stdout === "string" && error.stdout === "")) {
      const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      persistRaw(artifacts.options, `${artifacts.name}-failure`, { command: [executable, ...args], stdout: failure.stdout, stderr: failure.stderr, error: failure.message });
    }
    throw error;
  }
}

function validatePath(projectRoot: string, candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error("Result path must be a non-empty string");
  }
  const root = realpathSync(projectRoot);
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Result path is outside project root: ${candidate}`);
  }
  if (!existsSync(absolute)) throw new Error(`Result path does not exist: ${candidate}`);
  const real = realpathSync(absolute);
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Result path resolves outside project root: ${candidate}`);
  }
  return realRelative.replaceAll(path.sep, "/");
}

function uniquePaths(projectRoot: string, candidates: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const candidate of candidates) {
    const filePath = validatePath(projectRoot, candidate);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    validated.push(filePath);
  }
  return validated.slice(0, Math.min(limit, 10));
}

function mcpText(raw: unknown): string {
  const result = record(raw, "MCP result");
  if (result.isError === true) throw new Error("MCP tool returned isError=true");
  if (!Array.isArray(result.content)) throw new Error("MCP result.content must be an array");
  let totalBytes = 0;
  return result.content.map((item) => {
    const entry = record(item, "MCP content entry");
    if (entry.type !== "text" || typeof entry.text !== "string") {
      throw new Error("MCP content entry must be text");
    }
    totalBytes += Buffer.byteLength(entry.text, "utf8");
    if (totalBytes > MAX_OUTPUT_BYTES) throw new Error(`MCP text result exceeded ${MAX_OUTPUT_BYTES} bytes`);
    return entry.text;
  }).join("\n");
}

export function parseOcbiCitationPaths(raw: unknown, projectRoot: string, limit: number): string[] {
  const text = mcpText(raw);
  if (text.trim() === "") throw new Error("OCBI returned an empty response");
  const candidates: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\[\d+\]\s+.+?\s+(?:at|in)\s+(.+?):\d+(?:-\d+)?(?:\s|$)/.exec(line);
    if (match?.[1]) candidates.push(match[1]);
  }
  if (candidates.length === 0 && !/^No (?:matching code|definition found)/.test(text)) {
    throw new Error("OCBI returned non-empty output without numbered citation headers");
  }
  return uniquePaths(projectRoot, candidates, limit);
}

export function parseCodeGraphPaths(raw: unknown, projectRoot: string, limit: number): string[] {
  const candidates: unknown[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) candidates.push(record(record(item, "CodeGraph result").node, "CodeGraph node").filePath);
  } else {
    const output = record(raw, "CodeGraph context");
    if (!Array.isArray(output.nodes)) throw new Error("CodeGraph context.nodes must be an array");
    for (const item of output.nodes) candidates.push(record(item, "CodeGraph node").filePath);
  }
  return uniquePaths(projectRoot, candidates, limit);
}

function cbmStructured(raw: unknown): JsonRecord {
  const envelope = record(raw, "codebase-memory response");
  if (envelope.isError === true) {
    const message = record(envelope.structuredContent, "codebase-memory error").error;
    throw new Error(`codebase-memory error: ${String(message ?? "unknown")}`);
  }
  return record(envelope.structuredContent, "codebase-memory structuredContent");
}

export function parseCodebaseMemoryPaths(raw: unknown, projectRoot: string, limit: number): string[] {
  const output = cbmStructured(raw);
  if (typeof output.total !== "number" || !Number.isInteger(output.total) || output.total < 0) throw new Error("codebase-memory total must be a non-negative integer");
  if (typeof output.count !== "number" || !Number.isInteger(output.count) || output.count < 0) throw new Error("codebase-memory count must be a non-negative integer");
  if (!Array.isArray(output.groups)) throw new Error("codebase-memory groups must be an array");
  return uniquePaths(projectRoot, output.groups.map((group) => record(group, "codebase-memory group").file), limit);
}

export function parseGrepaiPaths(raw: unknown, projectRoot: string, limit: number): string[] {
  if (!Array.isArray(raw)) throw new Error("grepai search output must be an array");
  return uniquePaths(projectRoot, raw.map((item) => record(item, "grepai result").file_path), limit);
}

export function hasGrepaiReadyEvents(log: string): boolean {
  const scan = log.search(/Initial scan complete:/);
  const symbols = log.search(/Symbol index built:/);
  const running = log.search(/\[RUNNING\][^\n]*- steady/);
  return scan >= 0 && symbols > scan && running > symbols;
}

function toolPath(options: CompetitiveAdapterOptions, condition: CompetitiveCondition): string {
  if (condition === "codegraph") {
    return path.join(options.toolsRoot, "npm/node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph");
  }
  if (condition === "codebase-memory") {
    return path.join(options.toolsRoot, "npm/node_modules/codebase-memory-mcp/bin/codebase-memory-mcp");
  }
  return path.join(options.toolsRoot, "grepai/grepai");
}

class OcbiAdapter implements CompetitiveAdapter {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  constructor(private readonly condition: "ocbi-hybrid" | "ocbi-structural", private readonly options: CompetitiveAdapterOptions) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.options.ocbiCliPath, "--project", this.options.projectRoot, "--host", "opencode", "--config", this.options.configPath],
      env: isolatedEnv(this.options),
      cwd: this.options.projectRoot,
      stderr: "pipe",
    });
    this.transport = transport;
    let stderrBytes = 0;
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) void transport.close();
    });
    const client = new Client({ name: "competitive-benchmark", version: "1" });
    try {
      await bounded("OCBI MCP connect", client.connect(transport));
      this.client = client;
      return client;
    } catch (error: unknown) {
      await transport.close();
      this.transport = undefined;
      throw error;
    }
  }

  async index(): Promise<void> {
    const client = await this.connect();
    const raw = await bounded(
      "OCBI index_codebase",
      client.callTool({ name: "index_codebase", arguments: { force: true } }, undefined, { timeout: INDEX_TIMEOUT_MS }),
      INDEX_TIMEOUT_MS,
    );
    persistRaw(this.options, `${this.condition}-index`, raw);
    mcpText(raw);
  }

  async query(input: CompetitiveQuery): Promise<CompetitiveQueryResult> {
    const client = await this.connect();
    const started = performance.now();
    const raw = input.symbol
      ? await bounded("OCBI implementation_lookup", client.callTool({ name: "implementation_lookup", arguments: { query: input.symbol, limit: input.limit } }))
      : await bounded("OCBI codebase_peek", client.callTool({
          name: "codebase_peek",
          arguments: {
            query: input.query,
            limit: input.limit,
          },
        }));
    persistRaw(this.options, `${this.condition}-query`, raw);
    return { status: "success", paths: parseOcbiCitationPaths(raw, this.options.projectRoot, input.limit), raw, durationMs: performance.now() - started };
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    else await this.transport?.close();
    this.client = undefined;
    this.transport = undefined;
  }
}

class CodeGraphAdapter implements CompetitiveAdapter {
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: CompetitiveAdapterOptions) {
    this.executable = toolPath(options, "codegraph");
    this.env = isolatedEnv(options, { CODEGRAPH_NO_DAEMON: "1", CODEGRAPH_TELEMETRY: "0", DO_NOT_TRACK: "1" });
  }

  async index(): Promise<void> {
    const result = await execFileAsync(this.executable, ["init", this.options.projectRoot, "--yes"], { cwd: this.options.projectRoot, env: this.env, timeout: INDEX_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" });
    persistRaw(this.options, "codegraph-index", { stdout: result.stdout, stderr: result.stderr });
  }

  async query(input: CompetitiveQuery): Promise<CompetitiveQueryResult> {
    const started = performance.now();
    const args = input.symbol
      ? ["query", input.symbol, "--path", this.options.projectRoot, "--limit", String(input.limit), "--json"]
      : ["context", "--path", this.options.projectRoot, "--format", "json", "--max-nodes", String(input.limit), "--no-code", input.query];
    const raw = await runJson(this.executable, args, this.options.projectRoot, this.env, QUERY_TIMEOUT_MS, { options: this.options, name: "codegraph-query" });
    return { status: "success", paths: parseCodeGraphPaths(raw, this.options.projectRoot, input.limit), raw, durationMs: performance.now() - started };
  }

  async close(): Promise<void> {}
}

class CodebaseMemoryAdapter implements CompetitiveAdapter {
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;
  private project: string | undefined;

  constructor(private readonly options: CompetitiveAdapterOptions) {
    this.executable = toolPath(options, "codebase-memory");
    this.env = isolatedEnv(options, { CBM_CACHE_DIR: path.join(options.artifactDir, "cbm-cache") });
  }

  async index(): Promise<void> {
    const args = JSON.stringify({ repo_path: this.options.projectRoot, mode: "full", persistence: false });
    const raw = await runJson(
      this.executable,
      ["cli", "--json", "index_repository", args],
      this.options.projectRoot,
      this.env,
      INDEX_TIMEOUT_MS,
      { options: this.options, name: "codebase-memory-index" },
    );
    const project = cbmStructured(raw).project;
    if (typeof project !== "string" || project === "") throw new Error("codebase-memory index response omitted project");
    this.project = project;
  }

  async query(input: CompetitiveQuery): Promise<CompetitiveQueryResult> {
    if (!input.symbol) return { status: "unsupported", paths: [], raw: { reason: "No documented natural-language API selected for this condition" }, durationMs: 0 };
    if (!this.project) throw new Error("codebase-memory adapter must be indexed before query");
    const started = performance.now();
    const args = JSON.stringify({ project: this.project, name_pattern: `^${input.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, limit: input.limit, format: "json" });
    const raw = await runJson(this.executable, ["cli", "--json", "search_graph", args], this.options.projectRoot, this.env, QUERY_TIMEOUT_MS, { options: this.options, name: "codebase-memory-query" });
    return { status: "success", paths: parseCodebaseMemoryPaths(raw, this.options.projectRoot, input.limit), raw, durationMs: performance.now() - started };
  }

  async close(): Promise<void> {}
}

class GrepaiAdapter implements CompetitiveAdapter {
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;
  private watcher: ChildProcess | undefined;
  private watcherLog = "";

  constructor(private readonly options: CompetitiveAdapterOptions) {
    this.executable = toolPath(options, "grepai");
    this.env = isolatedEnv(options);
  }

  async index(): Promise<void> {
    const init = await execFileAsync(this.executable, ["init", "--yes", "--provider", "ollama", "--model", "nomic-embed-text", "--backend", "gob"], { cwd: this.options.projectRoot, env: this.env, timeout: INDEX_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" });
    const configPath = path.join(this.options.projectRoot, ".grepai", "config.yaml");
    if (!existsSync(configPath)) throw new Error("grepai init did not create .grepai/config.yaml");
    persistRaw(this.options, "grepai-index-init", {
      command: [this.executable, "init", "--yes", "--provider", "ollama", "--model", "nomic-embed-text", "--backend", "gob"],
      stdout: init.stdout,
      stderr: init.stderr,
      configYaml: readFileSync(configPath, "utf8"),
    });
    const watcher = spawn(this.executable, ["watch", "--no-ui"], { cwd: this.options.projectRoot, env: this.env, stdio: ["ignore", "pipe", "pipe"] });
    this.watcher = watcher;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("grepai watcher readiness timed out")), INDEX_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        this.watcherLog += chunk.toString();
        if (Buffer.byteLength(this.watcherLog) > MAX_OUTPUT_BYTES) {
          watcher.kill("SIGTERM");
          clearTimeout(timeout);
          reject(new Error("grepai watcher output exceeded cap"));
          return;
        }
        writeFileSync(path.join(this.options.artifactDir, "grepai-watch.log"), this.watcherLog, "utf8");
        if (hasGrepaiReadyEvents(this.watcherLog)) {
          clearTimeout(timeout);
          persistRaw(this.options, "grepai-index", { log: this.watcherLog });
          resolve();
        }
      };
      watcher.stdout?.on("data", onData);
      watcher.stderr?.on("data", onData);
      watcher.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`grepai watcher exited before readiness (${String(code)})`)); });
      watcher.once("error", (error) => { clearTimeout(timeout); reject(error); });
    });
  }

  async query(input: CompetitiveQuery): Promise<CompetitiveQueryResult> {
    const started = performance.now();
    const raw = await runJson(this.executable, ["search", input.symbol ?? input.query, "--limit", String(input.limit), "--json", "--compact"], this.options.projectRoot, this.env, QUERY_TIMEOUT_MS, { options: this.options, name: "grepai-query" });
    return { status: "success", paths: parseGrepaiPaths(raw, this.options.projectRoot, input.limit), raw, durationMs: performance.now() - started };
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = undefined;
    if (!watcher || watcher.exitCode !== null || watcher.signalCode !== null) return;
    watcher.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => watcher.kill("SIGKILL"), 5_000);
      const fail = setTimeout(() => reject(new Error("grepai watcher could not be reaped after SIGKILL")), 10_000);
      watcher.once("exit", () => {
        clearTimeout(force);
        clearTimeout(fail);
        resolve();
      });
    });
  }
}

export function createAdapter(condition: CompetitiveCondition, options: CompetitiveAdapterOptions): CompetitiveAdapter {
  if (condition === "ocbi-hybrid" || condition === "ocbi-structural") return new OcbiAdapter(condition, options);
  if (condition === "codegraph") return new CodeGraphAdapter(options);
  if (condition === "codebase-memory") return new CodebaseMemoryAdapter(options);
  if (condition === "grepai") return new GrepaiAdapter(options);
  throw new Error(`Unsupported competitive condition: ${String(condition)}`);
}
