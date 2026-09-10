#!/usr/bin/env node

import type { CompetitiveAdapter, CompetitiveCondition } from "./competitive-adapters.js";
import type {
  ModelDriver,
  ModelDriverResult,
  PilotTask,
  SearchAdapter,
  SearchResult,
  EvaluatorResult,
  EvaluatorRuntime,
  PilotEvaluationOptions,
  PilotRuntimeVerification,
  SandboxProbeResult,
} from "./competitive-coding-pilot.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { createAdapter } from "./competitive-adapters.js";
import {
  evaluateCandidate,
  fileSearchResult,
  isForbiddenSourceSegment,
  literalSearchAdapter,
  MAX_GENERATED_TOKENS,
  MAX_RUN_MS,
  OllamaModelDriver,
  PILOT_MANIFEST,
  PilotBroker,
  PilotModelError,
  PilotEvaluatorError,
  proveSandboxDenials,
  REQUEST_TIMEOUT_MS,
  applyTaskMutation,
  verifyPilotRuntime,
} from "./competitive-coding-pilot.js";
import { validateEmbeddingLock, validateInterfaceLock } from "./competitive-benchmark.js";

const exec = promisify(execFile);

export const PILOT_ORDER_SEED = 20_260_910;
export const PILOT_CONDITIONS = ["literal-unindexed", "ocbi-hybrid", "codegraph"] as const;
export type PilotCondition = typeof PILOT_CONDITIONS[number];

interface LockedRepository {
  name: string;
  revision: string;
  archiveSha256: string;
}

export interface PilotRunnerOptions {
  projectRoot: string;
  scratchRoot: string;
  outputRoot: string;
  toolsRoot: string;
  sourceLockPath?: string;
  archivePath?: string;
  ocbiCliPath?: string;
  modelDriver?: ModelDriver;
  evaluatorRuntime?: EvaluatorRuntime;
}

export interface PilotRunnerDependencies {
  createPublicAdapter?: typeof createAdapter;
  evaluate?: (workspace: string, task: PilotTask, options?: PilotEvaluationOptions) => Promise<EvaluatorResult>;
  extractArchive?: (archive: string, destination: string) => Promise<void>;
  validateFrozenInputs?: (options: PilotRunnerOptions) => Promise<void>;
  proveSafety?: (workspace: string, options?: PilotEvaluationOptions) => Promise<SandboxProbeResult>;
  verifyRuntime?: (runtime: EvaluatorRuntime) => Promise<PilotRuntimeVerification>;
  now?: () => number;
}

export interface PilotRunArtifact {
  schemaVersion: 1;
  taskId: string;
  condition: PilotCondition;
  orderIndex: number;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  toolCalls: number;
  model?: ModelDriverResult;
  evaluator?: EvaluatorResult;
  error?: SerializedError;
  setupDiff: WorkspaceDiff;
  diff: WorkspaceDiff;
  patchValidity: PatchValidity;
}

export interface PatchValidity {
  valid: boolean;
  expectedFile: string;
  unexpectedFiles: string[];
  unexpectedSetupFiles: string[];
  reason?: string;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  transcript?: readonly unknown[];
  promptTokens?: number;
  generatedTokens?: number;
  evaluator?: EvaluatorResult;
  related?: SerializedError[];
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface WorkspaceDiff {
  changedFiles: FileChange[];
  error?: SerializedError;
}

interface SourceSnapshot {
  files: Map<string, string>;
}

interface RunSpec {
  task: PilotTask;
  condition: PilotCondition;
  orderIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(value: string, label: string): string {
  if (!value || value === "." || value === ".." || path.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be one safe path segment`);
  }
  return value;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function saveJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function replaceJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selected = Math.floor((state / 4_294_967_296) * (index + 1));
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

export function buildPilotOrder(tasks: readonly PilotTask[] = PILOT_MANIFEST.tasks): RunSpec[] {
  return tasks.flatMap((task, taskIndex) => shuffled(PILOT_CONDITIONS, PILOT_ORDER_SEED + taskIndex)
    .map((condition, conditionIndex) => ({
      task,
      condition,
      orderIndex: taskIndex * PILOT_CONDITIONS.length + conditionIndex,
    })));
}

function serializedError(error: unknown): SerializedError {
  if (error instanceof PilotEvaluatorError) {
    return { name: error.name, message: error.message, stack: error.stack, evaluator: error.result };
  }
  if (error instanceof PilotModelError) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      transcript: error.transcript,
      promptTokens: error.promptTokens,
      generatedTokens: error.generatedTokens,
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };
  return { name: "Error", message: String(error) };
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (isForbiddenSourceSegment(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`source snapshot contains a symlink: ${entry.name}`);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        if ((await fs.stat(absolute)).nlink !== 1) throw new Error(`source snapshot contains a hardlink: ${entry.name}`);
        files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      } else throw new Error(`source snapshot contains a non-regular entry: ${entry.name}`);
    }
  };
  await visit(root);
  return files.sort();
}

async function snapshot(root: string): Promise<SourceSnapshot> {
  const files = new Map<string, string>();
  for (const relative of await sourceFiles(root)) files.set(relative, await fs.readFile(path.join(root, relative), "utf8"));
  return { files };
}

export function diffSnapshots(before: SourceSnapshot, after: SourceSnapshot): WorkspaceDiff {
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  return {
    changedFiles: paths.flatMap((file): FileChange[] => {
      const oldContent = before.files.get(file) ?? null;
      const newContent = after.files.get(file) ?? null;
      return oldContent === newContent ? [] : [{ path: file, before: oldContent, after: newContent }];
    }),
  };
}

async function copyPublicSource(source: string, destination: string): Promise<void> {
  const realSource = await fs.realpath(source);
  await fs.mkdir(destination, { recursive: false });
  await fs.cp(realSource, destination, {
    recursive: true,
    filter: async (entry) => {
      const relative = path.relative(realSource, entry);
      if (relative === "") return true;
      if (relative.split(path.sep).some(isForbiddenSourceSegment)) return false;
      const stat = await fs.lstat(entry);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error("public source contains a linked file");
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("public source contains a non-regular file");
      return true;
    },
  });
}

async function defaultExtractArchive(archive: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: false });
  await exec("tar", ["-xf", archive, "-C", destination], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}

async function loadAxiosLock(sourceLockPath: string): Promise<LockedRepository> {
  const parsed: unknown = JSON.parse(await fs.readFile(sourceLockPath, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.repositories)) throw new Error("source lock repositories are malformed");
  const axios = parsed.repositories.find((value): value is LockedRepository => isRecord(value) && value.name === "axios") as LockedRepository | undefined;
  if (!axios || typeof axios.revision !== "string" || typeof axios.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(axios.archiveSha256)) {
    throw new Error("source lock is missing a valid Axios archive pin");
  }
  if (PILOT_MANIFEST.tasks.some(task => task.repository !== "axios" || task.revision !== axios.revision)) {
    throw new Error("pilot tasks do not match the frozen Axios revision");
  }
  return axios;
}

function adapterCondition(condition: PilotCondition): CompetitiveCondition {
  if (condition === "ocbi-hybrid" || condition === "codegraph") return condition;
  throw new Error(`No public adapter for ${condition}`);
}

function publicSearchAdapter(adapter: CompetitiveAdapter): SearchAdapter {
  return async ({ root, query, limit }): Promise<SearchResult[]> => {
    const result = await adapter.query({ query, limit });
    if (result.status !== "success") throw new Error("public search adapter returned unsupported");
    if (!Array.isArray(result.paths) || result.paths.length > limit) throw new Error("public search adapter exceeded result cap");
    // Derive file-level line ranges only after confinement and link checks.
    // The broker rechecks the frozen allowlist and derives the actual snippet.
    return result.paths.map(filePath => fileSearchResult(root, filePath));
  };
}

async function defaultValidateFrozenInputs(options: PilotRunnerOptions): Promise<void> {
  const interfaceLockPath = path.join(options.projectRoot, "benchmarks/competitive/2026-09-10/tool-interface-lock.json");
  const lock: unknown = JSON.parse(await fs.readFile(interfaceLockPath, "utf8"));
  const benchmarkOptions = {
    projectRoot: options.projectRoot,
    scratchRoot: options.scratchRoot,
    outputRoot: options.outputRoot,
    toolsRoot: options.toolsRoot,
    conditions: ["ocbi-hybrid", "codegraph"] as CompetitiveCondition[],
    repeats: 1,
  };
  await validateInterfaceLock(lock as Parameters<typeof validateInterfaceLock>[0], benchmarkOptions);
  if (options.ocbiCliPath && await sha256(options.ocbiCliPath) !== await sha256(path.join(options.projectRoot, "dist/cli.js"))) {
    throw new Error("injected OCBI CLI does not match the frozen tool hash");
  }
  await validateEmbeddingLock(lock as Parameters<typeof validateEmbeddingLock>[0], ["ocbi-hybrid", "codegraph"]);
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: false });
  await fs.cp(source, destination, { recursive: true });
}

async function runPreflight(options: {
  cleanSource: string;
  outputRoot: string;
  tasks: readonly PilotTask[];
  proveSafety: (workspace: string) => Promise<SandboxProbeResult>;
  evaluate: (workspace: string, task: PilotTask) => Promise<EvaluatorResult>;
}): Promise<void> {
  const preflightPath = path.join(options.outputRoot, "preflight.json");
  const record: {
    schemaVersion: 1;
    status: "running" | "passed" | "failed";
    safety?: SandboxProbeResult;
    tasks: Array<{ taskId: string; reference: EvaluatorResult; mutant?: EvaluatorResult }>;
    error?: SerializedError;
  } = { schemaVersion: 1, status: "running", tasks: [] };
  await replaceJson(preflightPath, record);
  try {
    record.safety = await options.proveSafety(options.cleanSource);
    if (![record.safety.outsideReadDenied, record.safety.outsideWriteDenied, record.safety.networkDenied, record.safety.childProcessDenied].every(value => value === true)) {
      throw new Error("pilot preflight requires all four sandbox denials");
    }
    for (const task of options.tasks) {
      const reference = await options.evaluate(options.cleanSource, task);
      const taskRecord: { taskId: string; reference: EvaluatorResult; mutant?: EvaluatorResult } = { taskId: task.id, reference };
      record.tasks.push(taskRecord);
      await replaceJson(preflightPath, record);
      const mutantRoot = path.join(options.outputRoot, "preflight-mutants", safeSegment(task.id, "task id"));
      await fs.mkdir(path.dirname(mutantRoot), { recursive: true });
      await copyDirectory(options.cleanSource, mutantRoot);
      try {
        applyTaskMutation(mutantRoot, task);
        taskRecord.mutant = await options.evaluate(mutantRoot, task);
        await replaceJson(preflightPath, record);
      } finally {
        await fs.rm(mutantRoot, { recursive: true, force: true });
      }
      const mutant = taskRecord.mutant;
      if (!reference.passed || reference.exitCode !== 0 || reference.error || !mutant || mutant.passed || mutant.exitCode !== 0 || mutant.error) {
        throw new Error(`pilot preflight failed for ${task.id}: reference must pass and mutant must fail`);
      }
      // A mutant crash or malformed output is an evaluator failure, not a valid
      // demonstration of this frozen behavioral regression.
      const outputs: unknown = JSON.parse(mutant.stdout);
      if (!Array.isArray(outputs) || outputs.length !== task.hiddenExpectedOutputs.length) throw new Error("mutant evaluator output is malformed");
    }
    record.status = "passed";
    await replaceJson(preflightPath, record);
  } catch (error: unknown) {
    record.status = "failed";
    record.error = serializedError(error);
    await replaceJson(preflightPath, record);
    throw error;
  }
}

function assertModelBoundary(input: { prompt: string; searchAdapter: SearchAdapter }): void {
  if (typeof input.prompt !== "string" || input.prompt.length === 0 || typeof input.searchAdapter !== "function") {
    throw new Error("model boundary is malformed");
  }
  if (Object.keys(input).some(key => key !== "prompt" && key !== "searchAdapter")) {
    throw new Error("model boundary contains unexpected fields");
  }
}

async function runModel(options: {
  broker: PilotBroker;
  prompt: string;
  searchAdapter: SearchAdapter;
  modelDriver: ModelDriver;
}): Promise<ModelDriverResult> {
  assertModelBoundary({ prompt: options.prompt, searchAdapter: options.searchAdapter });
  const deadlineMs = Date.now() + MAX_RUN_MS;
  const model = await options.modelDriver.run({
    prompt: options.prompt,
    broker: options.broker,
    deadlineMs,
    maxGeneratedTokens: MAX_GENERATED_TOKENS,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (Date.now() > deadlineMs || model.generatedTokens > MAX_GENERATED_TOKENS) {
    throw new PilotModelError(Date.now() > deadlineMs ? "pilot deadline exceeded" : "generated token limit exceeded", model.transcript, model.promptTokens, model.generatedTokens);
  }
  return model;
}

async function materializeRunRoot(options: {
  cleanSource: string;
  outputRoot: string;
  spec: RunSpec;
}): Promise<{ workspace: string; artifactDir: string }> {
  const taskId = safeSegment(options.spec.task.id, "task id");
  const condition = safeSegment(options.spec.condition, "condition");
  const artifactDir = path.join(options.outputRoot, "runs", `${String(options.spec.orderIndex).padStart(2, "0")}-${taskId}-${condition}`);
  const workspace = path.join(artifactDir, "workspace");
  await fs.mkdir(path.dirname(artifactDir), { recursive: true });
  await fs.mkdir(artifactDir, { recursive: false });
  await copyPublicSource(options.cleanSource, workspace);
  return { workspace, artifactDir };
}

async function runOne(options: {
  spec: RunSpec;
  cleanSource: string;
  outputRoot: string;
  toolsRoot: string;
  ocbiCliPath: string;
  modelDriver: ModelDriver;
  createPublicAdapter: typeof createAdapter;
  evaluate: (workspace: string, task: PilotTask) => Promise<EvaluatorResult>;
  now: () => number;
}): Promise<PilotRunArtifact> {
  const { workspace, artifactDir } = await materializeRunRoot(options);
  const started = options.now();
  const startedAt = new Date().toISOString();
  let adapter: CompetitiveAdapter | undefined;
  let beforeSetup: SourceSnapshot | undefined;
  let before: SourceSnapshot | undefined;
  let setupDiff: WorkspaceDiff = { changedFiles: [] };
  let model: ModelDriverResult | undefined;
  let evaluator: EvaluatorResult | undefined;
  let broker: PilotBroker | undefined;
  let toolCalls = 0;
  let error: SerializedError | undefined;

  try {
    applyTaskMutation(workspace, options.spec.task);
    beforeSetup = await snapshot(workspace);
    await saveJson(path.join(artifactDir, "before-setup-source.json"), Object.fromEntries(beforeSetup.files));
    let searchAdapter: SearchAdapter;
    if (options.spec.condition === "literal-unindexed") {
      searchAdapter = literalSearchAdapter;
    } else {
      const configPath = path.join(artifactDir, "ocbi-config.json");
      await saveJson(configPath, {
        embeddingProvider: "ollama",
        embeddingModel: "nomic-embed-text",
        indexing: { mode: "hybrid", autoIndex: false, watchFiles: false, requireProjectMarker: false, maxFileSize: 1_000_000, maxChunksPerFile: 100 },
        reranker: { enabled: false },
      });
      adapter = await options.createPublicAdapter(adapterCondition(options.spec.condition), {
        projectRoot: workspace,
        toolsRoot: options.toolsRoot,
        ocbiCliPath: options.ocbiCliPath,
        configPath,
        artifactDir: path.join(artifactDir, "search-artifacts"),
      });
      await adapter.index();
      searchAdapter = publicSearchAdapter(adapter);
    }

    // Indexer-authored .gitignore changes are setup, not a model patch.
    before = await snapshot(workspace);
    setupDiff = diffSnapshots(beforeSetup, before);
    await saveJson(path.join(artifactDir, "setup-diff.json"), setupDiff);
    await saveJson(path.join(artifactDir, "before-source.json"), Object.fromEntries(before.files));
    const unexpectedSetupFiles = setupDiff.changedFiles.filter(change => change.path !== ".gitignore");
    if (unexpectedSetupFiles.length) {
      throw new Error(`adapter setup changed source files requiring review: ${unexpectedSetupFiles.map(change => change.path).join(", ")}`);
    }

    const modelBoundary = { prompt: options.spec.task.prompt, searchAdapter };
    assertModelBoundary(modelBoundary);
    broker = new PilotBroker(workspace, searchAdapter);
    model = await runModel({ broker, modelDriver: options.modelDriver, ...modelBoundary });
    await saveJson(path.join(artifactDir, "model.json"), model);
    evaluator = await options.evaluate(workspace, options.spec.task);
  } catch (caught: unknown) {
    error = serializedError(caught);
    if (caught instanceof PilotEvaluatorError) evaluator = caught.result;
    try { await saveJson(path.join(artifactDir, "run-error.json"), error); }
    catch (saveError: unknown) {
      const related = serializedError(saveError);
      error = { ...error, message: `${error.message}; error checkpoint failed: ${related.message}`, related: [related] };
    }
  } finally {
    // Count every attempted broker call, including validation and limit failures,
    // even when model execution throws before returning a result.
    toolCalls = broker?.callCount ?? 0;
    if (adapter) {
      try {
        await adapter.close();
      } catch (closeError: unknown) {
        const close = serializedError(closeError);
        error = error
          ? { ...error, name: "AggregateError", message: `${error.message}; adapter close failed: ${close.message}`, related: [...(error.related ?? []), close] }
          : close;
      }
    }
  }

  let diff: WorkspaceDiff = { changedFiles: [] };
  try {
    const after = await snapshot(workspace);
    if (before) diff = diffSnapshots(before, after);
    else if (beforeSetup) setupDiff = diffSnapshots(beforeSetup, after);
  } catch (diffError: unknown) {
    const serialized = serializedError(diffError);
    if (before) diff = { changedFiles: [], error: serialized };
    else setupDiff = { changedFiles: [], error: serialized };
    error = error
      ? { ...error, name: "AggregateError", message: `${error.message}; diff capture failed: ${serialized.message}`, related: [...(error.related ?? []), serialized] }
      : serialized;
  }
  const unexpectedFiles = diff.changedFiles
    .filter(change => change.path !== options.spec.task.mutation.file || change.before === null || change.after === null)
    .map(change => change.path);
  const unexpectedSetupFiles = setupDiff.changedFiles.filter(change => change.path !== ".gitignore").map(change => change.path);
  const validPatch = Boolean(before) && !diff.error && !setupDiff.error && unexpectedSetupFiles.length === 0
    && diff.changedFiles.length === 1 && unexpectedFiles.length === 0;
  const patchValidity: PatchValidity = {
    valid: validPatch,
    expectedFile: options.spec.task.mutation.file,
    unexpectedFiles,
    unexpectedSetupFiles,
    ...(!validPatch ? { reason: "requires a complete diff with exactly the existing task source file changed and no unreviewed setup source changes" } : {}),
  };
  const artifact: PilotRunArtifact = {
    schemaVersion: 1,
    taskId: options.spec.task.id,
    condition: options.spec.condition,
    orderIndex: options.spec.orderIndex,
    status: !error && evaluator?.passed === true && patchValidity.valid ? "passed" : "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: options.now() - started,
    toolCalls,
    ...(model ? { model } : {}),
    ...(evaluator ? { evaluator } : {}),
    ...(error ? { error } : {}),
    setupDiff,
    diff,
    patchValidity,
  };
  await saveJson(path.join(artifactDir, "result.json"), artifact);
  return artifact;
}

export async function runCompetitivePilot(
  options: PilotRunnerOptions,
  dependencies: PilotRunnerDependencies = {},
): Promise<PilotRunArtifact[]> {
  const projectRoot = await fs.realpath(options.projectRoot);
  const scratchRoot = await fs.realpath(options.scratchRoot);
  const toolsRoot = await fs.realpath(options.toolsRoot);
  const requestedScratch = path.resolve(options.scratchRoot);
  const requestedOutput = path.resolve(options.outputRoot);
  if (!within(requestedScratch, requestedOutput)) throw new Error("pilot output must remain under scratch");
  const outputRoot = path.join(scratchRoot, path.relative(requestedScratch, requestedOutput));
  if (within(projectRoot, outputRoot) || within(toolsRoot, outputRoot) || !within(scratchRoot, outputRoot) || outputRoot === scratchRoot) {
    throw new Error("pilot output root must be a fresh path confined under scratch and outside project/tools");
  }
  let parent = scratchRoot;
  for (const segment of path.relative(scratchRoot, path.dirname(outputRoot)).split(path.sep).filter(Boolean)) {
    parent = path.join(parent, segment);
    try { await fs.mkdir(parent); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("pilot output parent must not contain symlinks");
  }
  await fs.mkdir(outputRoot, { recursive: false });

  const sourceLockPath = path.resolve(options.sourceLockPath ?? path.join(projectRoot, "benchmarks/competitive/2026-09-10/source-lock.json"));
  const axios = await loadAxiosLock(sourceLockPath);
  const archive = await fs.realpath(options.archivePath ?? path.join(scratchRoot, "archives", `axios-${axios.revision}.tar`));
  if (!within(scratchRoot, archive)) throw new Error("Axios archive must remain inside the scratch root");
  if (within(outputRoot, archive) || within(archive, outputRoot)) throw new Error("pilot output must not overlap the source archive");
  if (await sha256(archive) !== axios.archiveSha256) throw new Error("Axios source archive hash mismatch");

  await (dependencies.validateFrozenInputs ?? defaultValidateFrozenInputs)({ ...options, projectRoot, scratchRoot, toolsRoot, outputRoot });
  if (!options.evaluatorRuntime) throw new Error("explicit evaluatorRuntime is required before pilot preflight");
  const runtime = await (dependencies.verifyRuntime ?? verifyPilotRuntime)(options.evaluatorRuntime);

  const order = buildPilotOrder();
  const runPlan = {
    schemaVersion: 1,
    descriptiveOnly: true,
    seed: PILOT_ORDER_SEED,
    label: PILOT_MANIFEST.label,
    model: PILOT_MANIFEST.model,
    limits: PILOT_MANIFEST.limits,
    conditions: PILOT_MANIFEST.conditions,
    tasks: PILOT_MANIFEST.tasks.map(({ id, label, repository, revision, prompt }) => ({ id, label, repository, revision, prompt })),
    manifestSha256: createHash("sha256").update(JSON.stringify(PILOT_MANIFEST)).digest("hex"),
    runtime,
    source: { repository: "axios", revision: axios.revision, archive, archiveSha256: axios.archiveSha256 },
    order: order.map(spec => ({ taskId: spec.task.id, condition: spec.condition, orderIndex: spec.orderIndex })),
  };
  await saveJson(path.join(outputRoot, "run-plan.json"), runPlan);

  const extracted = path.join(outputRoot, "extracted-source");
  await (dependencies.extractArchive ?? defaultExtractArchive)(archive, extracted);
  const cleanSource = path.join(outputRoot, "public-source");
  await copyPublicSource(extracted, cleanSource);
  await fs.rm(extracted, { recursive: true, force: true });

  const modelDriver = options.modelDriver ?? new OllamaModelDriver();
  const createPublicAdapter = dependencies.createPublicAdapter ?? createAdapter;
  const privateRoot = path.join(outputRoot, "private-evaluator");
  await fs.mkdir(privateRoot, { mode: 0o700 });
  const evaluationOptions = { privateRoot, runtime: options.evaluatorRuntime };
  const evaluate = (workspace: string, task: PilotTask): Promise<EvaluatorResult> =>
    (dependencies.evaluate ?? evaluateCandidate)(workspace, task, evaluationOptions);
  await runPreflight({
    cleanSource,
    outputRoot,
    tasks: PILOT_MANIFEST.tasks,
    proveSafety: workspace => (dependencies.proveSafety ?? proveSandboxDenials)(workspace, evaluationOptions),
    evaluate,
  });
  const now = dependencies.now ?? Date.now;
  const ocbiCliPath = path.resolve(options.ocbiCliPath ?? path.join(projectRoot, "dist/cli.js"));
  const results: PilotRunArtifact[] = [];

  for (const spec of order) {
    const result = await runOne({
      spec,
      cleanSource,
      outputRoot,
      toolsRoot,
      ocbiCliPath,
      modelDriver,
      createPublicAdapter,
      evaluate,
      now,
    });
    results.push(result);
    await replaceJson(path.join(outputRoot, "progress.json"), {
      schemaVersion: 1,
      completed: results.map(({ taskId, condition, status }) => ({ taskId, condition, status })),
    });
  }

  await saveJson(path.join(outputRoot, "summary.json"), { schemaVersion: 1, results });
  return results;
}
