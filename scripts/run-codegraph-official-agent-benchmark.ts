#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";

import { fileURLToPath } from "node:url";

export interface BenchmarkSourceManifest {
  name: string;
  methodologyRepository: string;
  methodologyCommit: string;
  codegraphPackage: string;
  defaultRuns: number;
  defaultTurns: number;
  model: string;
  effort: EffortLevel;
}

export interface BenchmarkRepositoryManifest {
  id: string;
  url: string;
  commit: string;
  questions: string[];
}

export interface BenchmarkManifest {
  version: number;
  source: BenchmarkSourceManifest;
  repositories: BenchmarkRepositoryManifest[];
}

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ParsedCliOptions {
  manifestPath: string;
  outputRoot: string;
  runs: number;
  turns: number;
  maxBudgetUsd: number;
  mode: "dry-run" | "prepare" | "execute";
  selectedRepo?: string;
  selectedArm?: (typeof ARMS)[number];
  selectedRun?: number;
  selectedRunRoot?: string;
}

export interface PreparedRepository {
  id: string;
  path: string;
  commit: string;
}

export interface PreparedState {
  manifestPath: string;
  source: BenchmarkSourceManifest;
  repositories: PreparedRepository[];
  preparedAt: string;
}

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerSpec>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>;

const DEFAULT_MANIFEST_PATH = path.join(process.cwd(), "benchmarks", "codegraph-official-agent.json");
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), "benchmarks", "results", "codegraph-official-agent");
const PREPARED_MANIFEST_FILE = "prepared.json";
const PREPARED_REPOS_DIR = "prepared";
const RUNS_DIR = "runs";
const DEFAULT_MAX_BUDGET_USD = 4;
const ARMS = ["baseline", "codegraph", "open-codebase-index"] as const;
const EXCLUDED_DIR_ENTRIES = new Set([
  ".git",
  ".codegraph",
  ".codebase-index",
  ".opencode",
  ".claude",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEffort(value: unknown): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high" || value === "max";
}

function isSha40(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{40}$/.test(value);
}

function isGitHubHttpsUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)
  );
}

function isNpmPackage(value: unknown): value is string {
  return typeof value === "string" && /^@?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[^\s]+$/.test(value);
}

function isKnownArm(value: unknown): value is (typeof ARMS)[number] {
  return typeof value === "string" && (ARMS as readonly string[]).includes(value);
}

function expandHome(input: string): string {
  const home = process.env.HOME;
  if (!home) return input;
  if (input === "~") return home;
  if (input.startsWith("~/")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function assertFiniteInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected ${label} to be a positive integer, got ${String(value)}`);
  }
  return value;
}

function assertPathSafeId(value: unknown): string {
  if (!isNonEmptyString(value)) {
    throw new Error("Repository id must be a non-empty string");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid repository id '${value}': must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/`);
  }

  return value;
}

export async function runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(" ")}\n${stderr}`));
    });
    child.stdin.end();
  });
}

function parseSource(source: unknown): BenchmarkSourceManifest {
  if (!isRecord(source)) {
    throw new Error("Manifest source must be an object");
  }

  const keys = Object.keys(source);
  const allowed = new Set([
    "name",
    "methodologyRepository",
    "methodologyCommit",
    "codegraphPackage",
    "defaultRuns",
    "defaultTurns",
    "model",
    "effort",
  ]);

  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new Error(`Manifest source contains unexpected field '${key}'`);
    }
  }

  if (!isNonEmptyString(source.name)) {
    throw new Error("Manifest source.name must be a non-empty string");
  }

  if (!isGitHubHttpsUrl(source.methodologyRepository)) {
    throw new Error("Manifest source.methodologyRepository must be a canonical github URL");
  }

  const methodologyCommit = String(source.methodologyCommit ?? "").trim().toLowerCase();
  if (!isSha40(methodologyCommit)) {
    throw new Error("Manifest source.methodologyCommit must be a full 40-character SHA");
  }

  if (!isNpmPackage(source.codegraphPackage)) {
    throw new Error("Manifest source.codegraphPackage must be a pinned package reference");
  }

  const defaultRuns = assertFiniteInteger(source.defaultRuns, "source.defaultRuns");
  const defaultTurns = assertFiniteInteger(source.defaultTurns, "source.defaultTurns");

  if (!isNonEmptyString(source.model)) {
    throw new Error("Manifest source.model must be a non-empty string");
  }

  if (!isEffort(source.effort)) {
    throw new Error("Manifest source.effort must be 'low', 'medium', 'high', or 'max'");
  }

  return {
    name: source.name,
    methodologyRepository: source.methodologyRepository,
    methodologyCommit,
    codegraphPackage: source.codegraphPackage,
    defaultRuns,
    defaultTurns,
    model: source.model,
    effort: source.effort,
  };
}

function parseRepository(
  repo: unknown,
  index: number,
  defaultTurns: number,
): BenchmarkRepositoryManifest {
  if (!isRecord(repo)) {
    throw new Error(`Manifest repository at index ${index} must be an object`);
  }

  const keys = Object.keys(repo);
  const allowed = new Set(["id", "url", "commit", "questions"]);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new Error(`Manifest repository '${index}' contains unexpected field '${key}'`);
    }
  }

  const id = assertPathSafeId(repo.id);

  if (!isGitHubHttpsUrl(repo.url)) {
    throw new Error(`Manifest repository '${id}' url must be a canonical github URL`);
  }

  const commit = String(repo.commit ?? "").trim().toLowerCase();
  if (!isSha40(commit)) {
    throw new Error(`Manifest repository '${id}' commit must be a full 40-character SHA`);
  }

  if (!Array.isArray(repo.questions)) {
    throw new Error(`Manifest repository '${id}' questions must be an array`);
  }

  if (repo.questions.length < defaultTurns) {
    throw new Error(`Manifest repository '${id}' has fewer questions (${repo.questions.length}) than defaultTurns (${defaultTurns})`);
  }

  const questions: string[] = [];
  for (let q = 0; q < repo.questions.length; q += 1) {
    const question = repo.questions[q];
    if (!isNonEmptyString(question)) {
      throw new Error(`Manifest repository '${id}' question ${q} must be a non-empty string`);
    }
    questions.push(question.trim());
  }

  return { id, url: repo.url, commit, questions };
}

export function parseManifest(manifestPath: string): BenchmarkManifest {
  const resolvedPath = path.resolve(expandHome(manifestPath));
  const raw = readFileSync(resolvedPath, "utf-8");

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Manifest file ${resolvedPath} is invalid JSON: ${message}`);
  }

  if (!isRecord(data)) {
    throw new Error(`Manifest file ${resolvedPath} must contain a JSON object`);
  }

  const keys = Object.keys(data);
  const allowedTopLevel = new Set(["version", "source", "repositories"]);
  for (const key of keys) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(`Manifest contains unexpected top-level field '${key}'`);
    }
  }

  if (data.version !== 1) {
    throw new Error(`Manifest version must be 1, got ${String(data.version)}`);
  }

  const source = parseSource(data.source);

  if (!Array.isArray(data.repositories) || data.repositories.length === 0) {
    throw new Error("Manifest repositories must be a non-empty array");
  }

  const repositories = data.repositories.map((repo, index) => parseRepository(repo, index, source.defaultTurns));
  const ids = new Set<string>();
  for (const repo of repositories) {
    if (ids.has(repo.id)) {
      throw new Error(`Manifest repository id '${repo.id}' is duplicated`);
    }
    ids.add(repo.id);
  }

  return {
    version: 1,
    source,
    repositories,
  };
}

export function parseCliArgs(argv: string[]): ParsedCliOptions {
  let manifestPath = DEFAULT_MANIFEST_PATH;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  let runs = 0;
  let turns = 0;
  let maxBudgetUsd = DEFAULT_MAX_BUDGET_USD;
  let mode: ParsedCliOptions["mode"] = "dry-run";
  let selectedRepo: string | undefined;
  let selectedArm: (typeof ARMS)[number] | undefined;
  let selectedRun = 0;
  let selectedRunRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      throw new Error("HELP_REQUESTED");
    }

    if (arg === "--manifest") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--manifest requires a path value");
      }
      manifestPath = expandHome(value);
      i += 1;
      continue;
    }

    if (arg === "--run-root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--run-root requires a path value");
      }
      selectedRunRoot = expandHome(value);
      i += 1;
      continue;
    }

    if (arg === "--repo") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--repo requires a repository id");
      }
      selectedRepo = value;
      i += 1;
      continue;
    }

    if (arg === "--run") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--run requires a positive integer");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--run must be a positive integer");
      }
      selectedRun = parsed;
      i += 1;
      continue;
    }

    if (arg === "--arm") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--arm requires one of baseline, codegraph, or open-codebase-index");
      }
      if (!isKnownArm(value)) {
        throw new Error("--arm must be baseline, codegraph, or open-codebase-index");
      }
      selectedArm = value;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--output requires a path value");
      }
      outputRoot = expandHome(value);
      i += 1;
      continue;
    }

    if (arg === "--runs") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--runs requires a number");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--runs must be a positive integer");
      }
      runs = parsed;
      i += 1;
      continue;
    }

    if (arg === "--turns") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--turns requires a number");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--turns must be a positive integer");
      }
      turns = parsed;
      i += 1;
      continue;
    }

    if (arg === "--max-budget") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-budget requires a number");
      }
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--max-budget must be a positive number");
      }
      maxBudgetUsd = parsed;
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }

    if (arg === "--prepare") {
      if (mode === "execute") {
        throw new Error("Cannot combine --prepare and --execute");
      }
      mode = "prepare";
      continue;
    }

    if (arg === "--execute") {
      if (mode === "prepare") {
        throw new Error("Cannot combine --prepare and --execute");
      }
      mode = "execute";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (manifestPath.trim().length === 0) {
    throw new Error("Manifest path is required");
  }

  const hasSelection =
    selectedRepo !== undefined ||
    selectedArm !== undefined ||
    selectedRun !== 0 ||
    selectedRunRoot !== undefined;

  const hasIncompleteSelection =
    selectedRepo === undefined ||
    selectedArm === undefined ||
    selectedRun === 0 ||
    selectedRunRoot === undefined;

  if (hasSelection && hasIncompleteSelection) {
    throw new Error("Selection requires --run-root, --repo, --run, and --arm");
  }

  if (hasSelection && mode !== "execute") {
    throw new Error("Single-session selection requires --execute");
  }

  const resolvedManifestPath = path.resolve(expandHome(manifestPath));
  const resolvedOutputRoot = path.resolve(expandHome(outputRoot));
  const resolvedSelectedRunRoot = selectedRunRoot ? path.resolve(expandHome(selectedRunRoot)) : undefined;

  return {
    manifestPath: resolvedManifestPath,
    outputRoot: resolvedOutputRoot,
    runs,
    turns,
    maxBudgetUsd,
    mode,
    selectedRepo,
    selectedArm,
    selectedRun: hasSelection ? selectedRun : undefined,
    selectedRunRoot: resolvedSelectedRunRoot,
  };
}

export function planSummary(manifest: BenchmarkManifest, runs: number, turns: number, maxBudgetUsd: number): string {
  const resolvedRuns = runs || manifest.source.defaultRuns;
  const resolvedTurns = turns || manifest.source.defaultTurns;
  const repos = manifest.repositories.length;
  const armSessions = repos * resolvedRuns * ARMS.length;
  const agentInvocations = armSessions * resolvedTurns;
  const maxTotalBudgetUsd = agentInvocations * maxBudgetUsd;

  const armLabels = [
    "baseline",
    `codegraph (${manifest.source.codegraphPackage})`,
    "open-codebase-index (dist/cli.js --host claude)",
  ];

  return [
    `Three-arm plan: ${armLabels.join(" | ")}`,
    `Repos: ${repos}`,
    `Runs per repo: ${resolvedRuns}`,
    `Turns per run: ${resolvedTurns}`,
    `Total arm sessions: ${armSessions}`,
    `Total Claude invocations: ${agentInvocations}`,
    `Max budget ceiling: $${maxBudgetUsd.toFixed(2)} per invocation, $${maxTotalBudgetUsd.toFixed(2)} total`,
  ].join("\n");
}

function shouldExcludeFromCopy(entry: string, repoRoot: string): boolean {
  const relative = path.relative(repoRoot, entry);
  if (relative === "" || relative.startsWith("..")) {
    return false;
  }

  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  return segments.some((segment, index) => {
    const lowered = segment.toLowerCase();
    if (EXCLUDED_DIR_ENTRIES.has(lowered)) return true;
    return index === 0 && lowered === "benchmarks";
  });
}

function copyIsolatedRepo(sourcePath: string, destinationPath: string): void {
  rmSync(destinationPath, { recursive: true, force: true });
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    force: true,
    filter: (source) => !shouldExcludeFromCopy(source, sourcePath),
  });
}

function getPreparedStatePath(outputRoot: string): string {
  return path.join(outputRoot, PREPARED_MANIFEST_FILE);
}

function getPreparedRepoRoot(outputRoot: string, repoId: string): string {
  return path.join(outputRoot, PREPARED_REPOS_DIR, repoId);
}

function getRunRoot(outputRoot: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(outputRoot, RUNS_DIR, timestamp);
}

function readPreparedState(outputRoot: string): PreparedState {
  const marker = getPreparedStatePath(outputRoot);
  if (!existsSync(marker)) {
    throw new Error(`No prepared repos found. Run with --prepare first.`);
  }

  const raw = readFileSync(marker, "utf-8");
  try {
    return JSON.parse(raw) as PreparedState;
  } catch {
    throw new Error(`Prepared state at ${marker} is invalid JSON`);
  }
}

export async function ensurePreparedWorkspace(
  manifest: BenchmarkManifest,
  outputRoot: string,
  commandRunner: CommandRunner = runCommand,
): Promise<PreparedState> {
  const state = readPreparedState(outputRoot);

  if (state.source.codegraphPackage !== manifest.source.codegraphPackage) {
    throw new Error("Prepared state does not match current manifest's CodeGraph package");
  }

  if (state.repositories.length !== manifest.repositories.length) {
    throw new Error("Prepared repo count does not match manifest");
  }

  for (const repo of manifest.repositories) {
    const preparedRepo = state.repositories.find((item) => item.id === repo.id);
    if (!preparedRepo) {
      throw new Error(`Prepared workspace missing for repository '${repo.id}'`);
    }

    if (preparedRepo.commit !== repo.commit) {
      throw new Error(`Prepared repository '${repo.id}' commit mismatch: ${preparedRepo.commit} != ${repo.commit}`);
    }

    const output = await commandRunner("git", ["-C", preparedRepo.path, "rev-parse", "HEAD"]);
    const head = output.stdout.trim().toLowerCase();
    if (head !== repo.commit) {
      throw new Error(`Prepared repository '${repo.id}' currently at ${head}; expected ${repo.commit}`);
    }

    if (!existsSync(preparedRepo.path)) {
      throw new Error(`Prepared repository path missing for '${repo.id}': ${preparedRepo.path}`);
    }
  }

  return state;
}

export async function prepareRepositories(
  manifest: BenchmarkManifest,
  outputRoot: string,
  manifestPath?: string,
  commandRunner: CommandRunner = runCommand,
): Promise<void> {
  mkdirSync(outputRoot, { recursive: true });
  const preparedRepoEntries: PreparedRepository[] = [];
  const preparedDir = path.join(outputRoot, PREPARED_REPOS_DIR);
  mkdirSync(preparedDir, { recursive: true });

  for (const repository of manifest.repositories) {
    const destination = getPreparedRepoRoot(outputRoot, repository.id);

    if (existsSync(destination)) {
      const existsHead = await commandRunner("git", ["-C", destination, "rev-parse", "HEAD"]).then((result) =>
        result.stdout.trim().toLowerCase(),
      );
      if (existsHead !== repository.commit) {
        throw new Error(`Existing directory ${destination} for '${repository.id}' is at ${existsHead} (expected ${repository.commit})`);
      }

      await commandRunner("git", ["-C", destination, "checkout", "--detach", repository.commit]);
      preparedRepoEntries.push({ id: repository.id, path: destination, commit: repository.commit });
      continue;
    }

    await commandRunner("git", ["clone", "--filter=blob:none", "--depth", "1", repository.url, destination]);
    await commandRunner("git", ["-C", destination, "fetch", "--depth", "1", "origin", repository.commit]);
    await commandRunner("git", ["-C", destination, "checkout", "--detach", repository.commit]);
    const head = await commandRunner("git", ["-C", destination, "rev-parse", "HEAD"]).then((result) =>
      result.stdout.trim().toLowerCase(),
    );

    if (head !== repository.commit) {
      throw new Error(`Prepared repository '${repository.id}' checkout failed (expected ${repository.commit}, got ${head})`);
    }

    preparedRepoEntries.push({ id: repository.id, path: destination, commit: repository.commit });
  }

  const state: PreparedState = {
    manifestPath: manifestPath
      ? path.resolve(expandHome(manifestPath))
      : path.resolve(process.cwd(), "benchmarks", "codegraph-official-agent.json"),
    source: manifest.source,
    repositories: preparedRepoEntries,
    preparedAt: new Date().toISOString(),
  };

  const markerPath = getPreparedStatePath(outputRoot);
  writeFileSync(markerPath, JSON.stringify(state, null, 2), "utf-8");
}

function buildBaselineConfig(): McpConfig {
  return { mcpServers: {} };
}

function buildCodeGraphConfig(manifest: BenchmarkManifest, repoPath: string): McpConfig {
  return {
    mcpServers: {
      codegraph: {
        command: "npx",
        args: ["--yes", manifest.source.codegraphPackage, "serve", "--mcp", "--path", repoPath],
      },
    },
  };
}

function buildOpenCodebaseIndexConfig(repoPath: string): McpConfig {
  const cliPath = path.resolve(process.cwd(), "dist", "cli.js");
  return {
    mcpServers: {
      "open-codebase-index": {
        command: "node",
        args: [cliPath, "--host", "claude", "--project", repoPath],
      },
    },
  };
}

function configFileForArm(manifest: BenchmarkManifest, arm: (typeof ARMS)[number], repoPath: string): McpConfig {
  if (arm === "baseline") return buildBaselineConfig();
  if (arm === "codegraph") return buildCodeGraphConfig(manifest, repoPath);
  return buildOpenCodebaseIndexConfig(repoPath);
}

async function indexWorkspaceForArm(
  manifest: BenchmarkManifest,
  arm: (typeof ARMS)[number],
  workspacePath: string,
  commandRunner: CommandRunner,
): Promise<void> {
  if (arm === "baseline") return;

  if (arm === "codegraph") {
    await commandRunner("npx", ["--yes", manifest.source.codegraphPackage, "init", workspacePath]);
    return;
  }

  const cliPath = path.resolve(process.cwd(), "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(`Local MCP CLI is missing: ${cliPath}. Run npm run build:ts before --execute.`);
  }
  await commandRunner("node", [cliPath, "index", "--host", "claude", "--project", workspacePath, "--force"]);
}

function writeConfig(configPath: string, config: McpConfig): void {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

function sessionIdFromStreamJson(output: string): string | undefined {
  for (const line of output.split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event) && isNonEmptyString(event.session_id)) {
        return event.session_id;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveArmSessionProgress(armRunRoot: string, turns: number): {
  startTurn: number;
  sessionId: string | undefined;
  completed: boolean;
} {
  let startTurn = 0;
  let sessionId: string | undefined;

  for (let turn = 0; turn < turns; turn += 1) {
    const artifactPath = path.join(armRunRoot, `turn-${turn + 1}.jsonl`);
    if (!existsSync(artifactPath)) {
      return { startTurn, sessionId, completed: false };
    }

    const raw = readFileSync(artifactPath, "utf-8").trim();
    if (raw.length === 0) {
      return { startTurn, sessionId, completed: false };
    }

    const found = sessionIdFromStreamJson(raw);
    if (found) {
      sessionId = found;
    }
    startTurn = turn + 1;
  }

  return {
    startTurn,
    sessionId,
    completed: startTurn >= turns,
  };
}

async function runClaudeSession(
  prompt: string,
  configPath: string,
  workspacePath: string,
  model: string,
  effort: EffortLevel,
  maxBudgetUsd: number,
  sessionId: string | undefined,
  commandRunner: CommandRunner,
): Promise<string> {
  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--strict-mcp-config",
    "--mcp-config",
    configPath,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const result = await commandRunner("claude", args, { cwd: workspacePath });
  return result.stdout;
}

function sanitizeQuestions(repository: BenchmarkRepositoryManifest, turns: number): string[] {
  return repository.questions.slice(0, turns);
}

export async function executeBenchmark(
  manifest: BenchmarkManifest,
  outputRoot: string,
  runs: number,
  turns: number,
  maxBudgetUsd: number,
  commandRunner: CommandRunner = runCommand,
  selectedSession?: {
    runRoot: string;
    repositoryId: string;
    run: number;
    arm: (typeof ARMS)[number];
  },
): Promise<void> {
  if (maxBudgetUsd <= 0) {
    throw new Error("Max budget must be greater than 0");
  }

  const runRoot = selectedSession ? selectedSession.runRoot : getRunRoot(outputRoot);
  if (selectedSession && !existsSync(runRoot)) {
    throw new Error(`Selected run root does not exist: ${runRoot}`);
  }

  const state = await ensurePreparedWorkspace(manifest, outputRoot, commandRunner);

  const preparedById = new Map(state.repositories.map((entry) => [entry.id, entry] as const));
  const resolvedRuns = runs || manifest.source.defaultRuns;
  const resolvedTurns = turns || manifest.source.defaultTurns;
  const selectedRepo = selectedSession ? preparedById.get(selectedSession.repositoryId) : undefined;
  if (selectedSession) {
    if (!selectedRepo) {
      throw new Error(`Repository '${selectedSession.repositoryId}' is not in the manifest`);
    }

    const selectedArmValid = ARMS.includes(selectedSession.arm);
    if (!selectedArmValid) {
      throw new Error(`Invalid arm '${selectedSession.arm}'`);
    }
  }

  const selectedArm = selectedSession?.arm;
  const selectedRun = selectedSession?.run;
  const selectedRunNumber = selectedSession?.run ?? 0;

  const repositoriesToRun = selectedSession ? [selectedRepo as PreparedRepository] : manifest.repositories.map((repo) => {
    const preparedRepo = preparedById.get(repo.id);
    if (!preparedRepo) {
      throw new Error(`Missing prepared repository '${repo.id}'`);
    }
    return preparedRepo;
  });
  const runList = selectedSession ? [selectedRun] : Array.from({ length: resolvedRuns }, (_, i) => i + 1);

  for (const preparedRepo of repositoriesToRun) {
    const repository = manifest.repositories.find((repo) => repo.id === preparedRepo.id);
    if (!repository) {
      throw new Error(`Prepared repository '${preparedRepo.id}' is not in manifest`);
    }

    const questionSet = sanitizeQuestions(repository, resolvedTurns);
    if (questionSet.length < resolvedTurns) {
      throw new Error(`Repository '${repository.id}' has only ${questionSet.length} questions, expected ${resolvedTurns}`);
    }

    const repositoryRunList = selectedSession
      ? runList.filter((run) => run === selectedRunNumber)
      : runList;

    for (const run of repositoryRunList) {
      const armList = selectedSession ? [selectedArm as (typeof ARMS)[number]] : ARMS;
      for (const arm of armList) {
        const armRunRoot = path.join(runRoot, repository.id, arm, `run-${run}`);

        const progress = selectedSession
          ? resolveArmSessionProgress(armRunRoot, resolvedTurns)
          : { startTurn: 0, sessionId: undefined, completed: false };

        if (selectedSession && progress.completed) {
          continue;
        }

        const workspaceRoot = path.join(armRunRoot, "workspace");
        copyIsolatedRepo(preparedRepo.path, workspaceRoot);
        await indexWorkspaceForArm(manifest, arm, workspaceRoot, commandRunner);

        const config = configFileForArm(manifest, arm, workspaceRoot);
        const configPath = path.join(armRunRoot, `mcp-config-${arm}.json`);
        writeConfig(configPath, config);
        let sessionId: string | undefined = progress.sessionId;

        for (let turn = progress.startTurn; turn < resolvedTurns; turn += 1) {
          const question = questionSet[turn];
          if (!question) {
            throw new Error(`Missing question ${turn} for repository '${repository.id}'`);
          }

          const artifactPath = path.join(armRunRoot, `turn-${turn + 1}.jsonl`);
          const raw = await runClaudeSession(
            question,
            configPath,
            workspaceRoot,
            manifest.source.model,
            manifest.source.effort,
            maxBudgetUsd,
            sessionId,
            commandRunner,
          );
          writeFileSync(artifactPath, `${raw}\n`, { encoding: "utf-8" });
          sessionId = sessionIdFromStreamJson(raw);
          if (turn < resolvedTurns - 1 && !sessionId) {
            throw new Error(`Claude did not return a session_id for ${repository.id}/${arm}/run-${run}/turn-${turn + 1}`);
          }
        }
      }
    }
  }

  if (!selectedSession) {
    const planPath = path.join(runRoot, "plan.txt");
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(planPath, [
      planSummary(manifest, resolvedRuns, resolvedTurns, maxBudgetUsd),
      `Execution output root: ${runRoot}`,
    ].join("\n"), "utf-8");
  }
}

function printUsage(): void {
  console.log(
    "Usage: npx tsx scripts/run-codegraph-official-agent-benchmark.ts [--manifest path] [--output path] [--runs N] [--turns N] [--max-budget N] [--dry-run|--prepare|--execute]",
  );
  console.log("Or run one session in an existing run root:");
  console.log(
    "  --execute --run-root <path> --repo <id> --run <N> --arm <baseline|codegraph|open-codebase-index>",
  );
  console.log("Defaults:");
  console.log(`- manifest: ${DEFAULT_MANIFEST_PATH}`);
  console.log(`- output: ${DEFAULT_OUTPUT_ROOT}`);
  console.log(`- dry-run: true`);
  console.log(`- runs: manifest.source.defaultRuns`);
  console.log(`- turns: manifest.source.defaultTurns`);
  console.log(`- max budget: $${DEFAULT_MAX_BUDGET_USD}`);
}

async function main(): Promise<void> {
  let options: ParsedCliOptions;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "HELP_REQUESTED") {
      printUsage();
      return;
    }
    throw error;
  }

  const manifest = parseManifest(options.manifestPath);
  const runs = options.runs || manifest.source.defaultRuns;
  const turns = options.turns || manifest.source.defaultTurns;

  console.log(planSummary(manifest, runs, turns, options.maxBudgetUsd));
  console.log(`Output directory: ${options.outputRoot}`);

  if (options.mode === "dry-run") {
    console.log("Mode: dry-run (no clone, no indexing, no model calls)");
    return;
  }

  if (options.mode === "prepare") {
    await prepareRepositories(manifest, options.outputRoot, options.manifestPath, runCommand);
    console.log(`Prepared ${manifest.repositories.length} repos under ${options.outputRoot}`);
    return;
  }

  if (options.mode === "execute") {
    const selectedSession = options.selectedRepo
      ? {
          runRoot: options.selectedRunRoot ?? "",
          repositoryId: options.selectedRepo,
          run: options.selectedRun ?? 0,
          arm: options.selectedArm as (typeof ARMS)[number],
        }
      : undefined;

    await executeBenchmark(manifest, options.outputRoot, runs, turns, options.maxBudgetUsd, runCommand, selectedSession);
    if (selectedSession) {
      console.log(`Execution artifacts written under ${selectedSession.runRoot}`);
    } else {
      console.log(`Execution artifacts written under ${options.outputRoot}/${RUNS_DIR}`);
    }
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
