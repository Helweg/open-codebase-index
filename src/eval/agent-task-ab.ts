import * as crypto from "node:crypto";

export type AgentTaskVariantId = "no-ocbi" | "ocbi";

export interface AgentTaskRepository {
  id: string;
  url: string;
  revision: string;
}

export interface AgentTaskVerifier {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface AgentTaskDefinition {
  id: string;
  repositoryIds: string[];
  prompt: string;
  verifier: AgentTaskVerifier;
  tags?: string[];
}

export interface AgentTaskDataset {
  version: "1.0.0";
  name: string;
  description?: string;
  preregistration: {
    id: string;
    createdAt: string;
    primaryMetric: "task-success";
    analysis: "paired-exact-sign-test";
  };
  repositories: AgentTaskRepository[];
  tasks: AgentTaskDefinition[];
}

export interface AgentTaskVariant {
  id: AgentTaskVariantId;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentTaskRunControls {
  agent: string;
  model: string;
  maxTokens: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxTranscriptBytes: number;
}

export interface AgentTaskAssignment {
  taskId: string;
  order: readonly [AgentTaskVariantId, AgentTaskVariantId];
}

export interface PreparedAgentTask {
  cwd: string;
  repositoryDirectories: Record<string, string>;
  collectArtifacts?(): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
}

export interface AgentTaskProcessResult {
  exitCode: number;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; toolCalls?: number };
}

export interface AgentTaskExecutionRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxTranscriptBytes: number;
}

export interface AgentTaskExecutionAdapter {
  execute(request: AgentTaskExecutionRequest): Promise<AgentTaskProcessResult>;
}

export interface AgentTaskPreparationAdapter {
  prepare(input: {
    repositories: AgentTaskRepository[];
    task: AgentTaskDefinition;
    variantId: AgentTaskVariantId;
    trialId: string;
  }): Promise<PreparedAgentTask>;
}

export interface AgentTaskTrialResult {
  datasetFingerprint: string;
  taskId: string;
  repositoryIds: string[];
  variantId: AgentTaskVariantId;
  order: number;
  trialId: string;
  controls: AgentTaskRunControls;
  repositoryDirectories: Record<string, string>;
  patches: Record<string, string>;
  agent: AgentTaskProcessResult;
  verifier?: AgentTaskProcessResult;
  success: boolean;
}

export interface AgentTaskComparison {
  exploratory: true;
  taskCount: number;
  successes: Record<AgentTaskVariantId, number>;
  bothSucceeded: number;
  bothFailed: number;
  noOcbiOnly: number;
  ocbiOnly: number;
  discordantPairs: number;
  successRateDifference: number;
  exactTwoSidedSignTestPValue: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown field(s): ${unknown.join(", ")}`);
}

function parseStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return [...value];
}

function parseVerifier(value: unknown, path: string): AgentTaskVerifier {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  rejectUnknownKeys(value, ["command", "args", "timeoutMs"], path);
  const args = parseStringArray(value.args, `${path}.args`);
  const timeoutMs = value.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`${path}.timeoutMs must be a positive integer`);
  }
  return {
    command: requireString(value.command, `${path}.command`),
    ...(args ? { args } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

export function parseAgentTaskDataset(value: unknown, source = "dataset"): AgentTaskDataset {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  rejectUnknownKeys(value, ["version", "name", "description", "preregistration", "repositories", "tasks"], source);
  if (value.version !== "1.0.0") throw new Error(`${source}.version must be 1.0.0`);
  if (!isRecord(value.preregistration)) throw new Error(`${source}.preregistration must be an object`);
  rejectUnknownKeys(value.preregistration, ["id", "createdAt", "primaryMetric", "analysis"], `${source}.preregistration`);
  if (value.preregistration.primaryMetric !== "task-success") throw new Error(`${source}.preregistration.primaryMetric must be task-success`);
  if (value.preregistration.analysis !== "paired-exact-sign-test") throw new Error(`${source}.preregistration.analysis must be paired-exact-sign-test`);
  const createdAt = requireString(value.preregistration.createdAt, `${source}.preregistration.createdAt`);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error(`${source}.preregistration.createdAt must be an ISO date-time`);

  if (!Array.isArray(value.repositories) || value.repositories.length < 2) {
    throw new Error(`${source}.repositories must contain at least two repositories`);
  }
  const repositoryIds = new Set<string>();
  const repositories = value.repositories.map((entry, index): AgentTaskRepository => {
    const path = `${source}.repositories[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    rejectUnknownKeys(entry, ["id", "url", "revision"], path);
    const id = requireString(entry.id, `${path}.id`);
    if (repositoryIds.has(id)) throw new Error(`${path}.id is duplicated: ${id}`);
    repositoryIds.add(id);
    const revision = requireString(entry.revision, `${path}.revision`);
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error(`${path}.revision must be a full 40-character commit hash`);
    return { id, url: requireString(entry.url, `${path}.url`), revision };
  });

  if (!Array.isArray(value.tasks) || value.tasks.length === 0) throw new Error(`${source}.tasks must be a non-empty array`);
  const taskIds = new Set<string>();
  const tasks = value.tasks.map((entry, index): AgentTaskDefinition => {
    const path = `${source}.tasks[${index}]`;
    if (!isRecord(entry)) throw new Error(`${path} must be an object`);
    rejectUnknownKeys(entry, ["id", "repositoryIds", "prompt", "verifier", "tags"], path);
    const id = requireString(entry.id, `${path}.id`);
    if (taskIds.has(id)) throw new Error(`${path}.id is duplicated: ${id}`);
    taskIds.add(id);
    const referenced = parseStringArray(entry.repositoryIds, `${path}.repositoryIds`);
    if (!referenced || referenced.length < 2) throw new Error(`${path}.repositoryIds must contain at least two repositories`);
    if (new Set(referenced).size !== referenced.length) throw new Error(`${path}.repositoryIds must not contain duplicates`);
    for (const repositoryId of referenced) {
      if (!repositoryIds.has(repositoryId)) throw new Error(`${path}.repositoryIds references unknown repository: ${repositoryId}`);
    }
    const tags = parseStringArray(entry.tags, `${path}.tags`);
    return {
      id,
      repositoryIds: referenced,
      prompt: requireString(entry.prompt, `${path}.prompt`),
      verifier: parseVerifier(entry.verifier, `${path}.verifier`),
      ...(tags ? { tags } : {}),
    };
  });

  const description = value.description === undefined ? undefined : requireString(value.description, `${source}.description`);
  return {
    version: "1.0.0",
    name: requireString(value.name, `${source}.name`),
    ...(description ? { description } : {}),
    preregistration: {
      id: requireString(value.preregistration.id, `${source}.preregistration.id`),
      createdAt,
      primaryMetric: "task-success",
      analysis: "paired-exact-sign-test",
    },
    repositories,
    tasks,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function fingerprintAgentTaskDataset(dataset: AgentTaskDataset): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(dataset))).digest("hex");
}

function seededRank(seed: string, taskId: string): string {
  return crypto.createHash("sha256").update(`${seed}\0${taskId}`).digest("hex");
}

export function createBalancedAssignments(dataset: AgentTaskDataset, seed: string): AgentTaskAssignment[] {
  requireString(seed, "seed");
  return [...dataset.tasks]
    .sort((left, right) => seededRank(seed, left.id).localeCompare(seededRank(seed, right.id)))
    .map((task, index) => ({
      taskId: task.id,
      order: index % 2 === 0 ? ["no-ocbi", "ocbi"] : ["ocbi", "no-ocbi"],
    }));
}

function validateControls(controls: AgentTaskRunControls): void {
  requireString(controls.agent, "controls.agent");
  requireString(controls.model, "controls.model");
  for (const key of ["maxTokens", "maxToolCalls", "maxDurationMs", "maxTranscriptBytes"] as const) {
    if (!Number.isInteger(controls[key]) || controls[key] <= 0) throw new Error(`controls.${key} must be a positive integer`);
  }
}

export async function runAgentTaskEvaluation(input: {
  dataset: AgentTaskDataset;
  variants: readonly [AgentTaskVariant, AgentTaskVariant];
  controls: AgentTaskRunControls;
  seed: string;
  preparation: AgentTaskPreparationAdapter;
  execution: AgentTaskExecutionAdapter;
}): Promise<AgentTaskTrialResult[]> {
  validateControls(input.controls);
  const variants = new Map(input.variants.map((variant) => [variant.id, variant]));
  if (variants.size !== 2 || !variants.has("no-ocbi") || !variants.has("ocbi")) {
    throw new Error("variants must contain exactly one no-ocbi and one ocbi definition");
  }
  const fingerprint = fingerprintAgentTaskDataset(input.dataset);
  const repositories = new Map(input.dataset.repositories.map((repository) => [repository.id, repository]));
  const tasks = new Map(input.dataset.tasks.map((task) => [task.id, task]));
  const results: AgentTaskTrialResult[] = [];

  for (const assignment of createBalancedAssignments(input.dataset, input.seed)) {
    const task = tasks.get(assignment.taskId);
    if (!task) throw new Error(`Missing task ${assignment.taskId}`);
    const taskRepositories = task.repositoryIds.map((id) => repositories.get(id)).filter((repo): repo is AgentTaskRepository => repo !== undefined);
    if (taskRepositories.length !== task.repositoryIds.length) throw new Error(`Task ${task.id} has missing repositories`);
    for (const [order, variantId] of assignment.order.entries()) {
      const variant = variants.get(variantId);
      if (!variant) throw new Error(`Missing variant ${variantId}`);
      const trialId = `${task.id}:${variantId}`;
      const prepared = await input.preparation.prepare({ repositories: taskRepositories, task, variantId, trialId });
      try {
        const commonEnv = {
          AGENT_EVAL_DATASET_FINGERPRINT: fingerprint,
          AGENT_EVAL_TASK_ID: task.id,
          AGENT_EVAL_TASK_PROMPT: task.prompt,
          AGENT_EVAL_VARIANT: variantId,
          AGENT_EVAL_AGENT: input.controls.agent,
          AGENT_EVAL_MODEL: input.controls.model,
          AGENT_EVAL_MAX_TOKENS: String(input.controls.maxTokens),
          AGENT_EVAL_MAX_TOOL_CALLS: String(input.controls.maxToolCalls),
          AGENT_EVAL_REPOSITORIES_JSON: JSON.stringify(prepared.repositoryDirectories),
        };
        const agent = await input.execution.execute({
          command: variant.command,
          args: variant.args ?? [],
          cwd: prepared.cwd,
          env: { ...variant.env, ...commonEnv },
          timeoutMs: input.controls.maxDurationMs,
          maxTranscriptBytes: input.controls.maxTranscriptBytes,
        });
        const verifier = agent.exitCode === 0 && !agent.timedOut
          ? await input.execution.execute({
              command: task.verifier.command,
              args: task.verifier.args ?? [],
              cwd: prepared.cwd,
              env: commonEnv,
              timeoutMs: task.verifier.timeoutMs ?? input.controls.maxDurationMs,
              maxTranscriptBytes: input.controls.maxTranscriptBytes,
            })
          : undefined;
        const patches = prepared.collectArtifacts ? await prepared.collectArtifacts() : {};
        results.push({
          datasetFingerprint: fingerprint,
          taskId: task.id,
          repositoryIds: [...task.repositoryIds],
          variantId,
          order,
          trialId,
          controls: { ...input.controls },
          repositoryDirectories: { ...prepared.repositoryDirectories },
          patches,
          agent,
          ...(verifier ? { verifier } : {}),
          success: agent.exitCode === 0 && !agent.timedOut && verifier?.exitCode === 0 && !verifier.timedOut,
        });
      } finally {
        await prepared.cleanup();
      }
    }
  }
  return results;
}

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let index = 1; index <= Math.min(k, n - k); index += 1) value = (value * (n - index + 1)) / index;
  return value;
}

function exactTwoSidedSignTest(leftOnly: number, rightOnly: number): number {
  const count = leftOnly + rightOnly;
  if (count === 0) return 1;
  let tailProbability = 0;
  for (let successes = 0; successes <= Math.min(leftOnly, rightOnly); successes += 1) {
    tailProbability += combinations(count, successes) * 0.5 ** count;
  }
  return Math.min(1, 2 * tailProbability);
}

export function compareAgentTaskTrials(dataset: AgentTaskDataset, trials: AgentTaskTrialResult[]): AgentTaskComparison {
  const fingerprint = fingerprintAgentTaskDataset(dataset);
  const expectedTasks = new Map(dataset.tasks.map((task) => [task.id, task]));
  const pairs = new Map<string, Partial<Record<AgentTaskVariantId, AgentTaskTrialResult>>>();
  for (const trial of trials) {
    if (trial.datasetFingerprint !== fingerprint) throw new Error(`Trial ${trial.trialId} has a mismatched dataset fingerprint`);
    const task = expectedTasks.get(trial.taskId);
    if (!task) throw new Error(`Trial ${trial.trialId} references unknown task ${trial.taskId}`);
    if (JSON.stringify([...trial.repositoryIds].sort()) !== JSON.stringify([...task.repositoryIds].sort())) {
      throw new Error(`Trial ${trial.trialId} has mismatched repository IDs`);
    }
    const derivedSuccess = trial.agent.exitCode === 0
      && !trial.agent.timedOut
      && trial.verifier?.exitCode === 0
      && !trial.verifier.timedOut;
    if (trial.success !== derivedSuccess) throw new Error(`Trial ${trial.trialId} has an inconsistent success flag`);
    const pair = pairs.get(trial.taskId) ?? {};
    if (pair[trial.variantId]) throw new Error(`Duplicate ${trial.variantId} trial for task ${trial.taskId}`);
    pair[trial.variantId] = trial;
    pairs.set(trial.taskId, pair);
  }

  let bothSucceeded = 0;
  let bothFailed = 0;
  let noOcbiOnly = 0;
  let ocbiOnly = 0;
  for (const taskId of expectedTasks.keys()) {
    const pair = pairs.get(taskId);
    const noOcbi = pair?.["no-ocbi"];
    const ocbi = pair?.ocbi;
    if (!noOcbi || !ocbi) throw new Error(`Task ${taskId} must have exactly one no-ocbi trial and one ocbi trial`);
    if (JSON.stringify(noOcbi.controls) !== JSON.stringify(ocbi.controls)) {
      throw new Error(`Task ${taskId} has mismatched run controls`);
    }
    if (noOcbi.success && ocbi.success) bothSucceeded += 1;
    else if (!noOcbi.success && !ocbi.success) bothFailed += 1;
    else if (noOcbi.success) noOcbiOnly += 1;
    else ocbiOnly += 1;
  }
  const taskCount = expectedTasks.size;
  const successes = { "no-ocbi": bothSucceeded + noOcbiOnly, ocbi: bothSucceeded + ocbiOnly };
  return {
    exploratory: true,
    taskCount,
    successes,
    bothSucceeded,
    bothFailed,
    noOcbiOnly,
    ocbiOnly,
    discordantPairs: noOcbiOnly + ocbiOnly,
    successRateDifference: (successes.ocbi - successes["no-ocbi"]) / taskCount,
    exactTwoSidedSignTestPValue: exactTwoSidedSignTest(noOcbiOnly, ocbiOnly),
  };
}
