import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateScores } from "./competitive-scoring.js";
import type { CompetitiveAggregate, CompetitiveQueryScore } from "./competitive-scoring.js";

export const PRIMARY_CONDITION = "ocbi-hybrid";
export const PRIMARY_RIVALS = ["codegraph", "codebase-memory", "grepai"] as const;
export const REPORT_SEED = 20260910;
export const BOOTSTRAP_SAMPLES = 10_000;
export const EXPECTED_CONDITIONS = [
  "ocbi-hybrid",
  "ocbi-structural",
  "codegraph",
  "codebase-memory",
  "grepai",
] as const;

export type CompetitiveTrack = "explicit-symbol" | "natural-language";

export interface CompetitiveArtifactRow {
  repository: string;
  condition: string;
  queryId: string;
  track: CompetitiveTrack;
  score: CompetitiveQueryScore;
}

export interface CompetitiveExpectedTask {
  repository: string;
  queryId: string;
  track: CompetitiveTrack;
}

export interface CompetitiveRunArtifacts {
  rows: CompetitiveArtifactRow[];
  expectedTasks: CompetitiveExpectedTask[];
  conditions: string[];
}

export interface Interval {
  lower: number;
  upper: number;
}

export interface TrackReport {
  rowCount: number;
  repositoryCount: number;
  supportedQueryCount: number;
  metrics: CompetitiveAggregate;
  queryWeightedHitAt5: number | null;
  equalRepositoryHitAt5: number | null;
}

export interface RepositoryDelta {
  repository: string;
  queryCount: number;
  hitAt5Delta: number;
}

export interface PrimaryPairReport {
  baseline: typeof PRIMARY_CONDITION;
  rival: typeof PRIMARY_RIVALS[number];
  track: "explicit-symbol";
  queryCount: number;
  repositoryCount: number;
  queryWeightedHitAt5Delta: number;
  equalRepositoryHitAt5Delta: number;
  perRepository: RepositoryDelta[];
  leaveOneRepositoryOut: Array<{ omittedRepository: string; queryWeightedHitAt5Delta: number }>;
  bootstrap: {
    samples: number;
    seed: number;
    confidence95: Interval;
    confidence98_333: Interval;
  };
  exploratory: true;
}

export interface CompetitiveReport {
  cohort: "development-only";
  exploratory: true;
  tracks: Record<string, Partial<Record<CompetitiveTrack, TrackReport>>>;
  primaryPairs: PrimaryPairReport[];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullableMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : mean(values);
}

function hitAt5(score: CompetitiveQueryScore): number {
  return score.metrics?.hitAt5 ?? 0;
}

function taskKey(row: CompetitiveArtifactRow): string {
  return `${row.repository}\0${row.queryId}`;
}

function assertUnique(rows: readonly CompetitiveArtifactRow[], label: string): Map<string, CompetitiveArtifactRow> {
  const byTask = new Map<string, CompetitiveArtifactRow>();
  for (const row of rows) {
    const key = taskKey(row);
    if (byTask.has(key)) throw new Error(`Duplicate task pair for ${label}: ${row.repository}/${row.queryId}`);
    byTask.set(key, row);
  }
  return byTask;
}

function pairedRows(
  rows: readonly CompetitiveArtifactRow[],
  rival: typeof PRIMARY_RIVALS[number],
): Array<{ repository: string; queryId: string; delta: number }> {
  const explicit = rows.filter((row) => row.track === "explicit-symbol");
  const baseline = assertUnique(explicit.filter((row) => row.condition === PRIMARY_CONDITION), PRIMARY_CONDITION);
  const comparison = assertUnique(explicit.filter((row) => row.condition === rival), rival);
  const missingFromRival = [...baseline.keys()].filter((key) => !comparison.has(key));
  const missingFromBaseline = [...comparison.keys()].filter((key) => !baseline.has(key));
  if (missingFromRival.length > 0 || missingFromBaseline.length > 0) {
    throw new Error(
      `Missing task pairs for ${PRIMARY_CONDITION} vs ${rival}: `
      + `${missingFromRival.length} missing rival, ${missingFromBaseline.length} missing baseline`,
    );
  }
  if (baseline.size === 0) throw new Error(`No explicit-symbol task pairs for ${PRIMARY_CONDITION} vs ${rival}`);

  return [...baseline.values()].map((left) => {
    const right = comparison.get(taskKey(left));
    if (!right) throw new Error(`Missing rival task pair: ${left.repository}/${left.queryId}`);
    if (left.score.status === "unsupported" || right.score.status === "unsupported") {
      throw new Error(`Unsupported row in frozen explicit-symbol primary track: ${left.repository}/${left.queryId}`);
    }
    return { repository: left.repository, queryId: left.queryId, delta: hitAt5(left.score) - hitAt5(right.score) };
  });
}

function groupByRepository<T extends { repository: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const selected = grouped.get(row.repository) ?? [];
    selected.push(row);
    grouped.set(row.repository, selected);
  }
  return grouped;
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function interval(samples: readonly number[], confidence: number): Interval {
  const sorted = [...samples].sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return { lower: quantile(sorted, tail), upper: quantile(sorted, 1 - tail) };
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function repositoryClusterBootstrap(
  rows: readonly { repository: string; delta: number }[],
  samples = BOOTSTRAP_SAMPLES,
  seed = REPORT_SEED,
): { confidence95: Interval; confidence98_333: Interval } {
  if (!Number.isInteger(samples) || samples <= 0) throw new Error("Bootstrap samples must be a positive integer");
  const grouped = groupByRepository(rows);
  const repositories = [...grouped.keys()].sort();
  if (repositories.length === 0) throw new Error("Cannot bootstrap an empty repository cohort");
  const random = randomGenerator(seed);
  const estimates: number[] = [];

  for (let sample = 0; sample < samples; sample += 1) {
    const selected: number[] = [];
    for (let index = 0; index < repositories.length; index += 1) {
      const repository = repositories[Math.floor(random() * repositories.length)];
      selected.push(...(grouped.get(repository) ?? []).map((row) => row.delta));
    }
    estimates.push(mean(selected));
  }

  return {
    confidence95: interval(estimates, 0.95),
    confidence98_333: interval(estimates, 1 - 0.05 / 3),
  };
}

function buildPair(
  rows: readonly CompetitiveArtifactRow[],
  rival: typeof PRIMARY_RIVALS[number],
  samples: number,
  seed: number,
): PrimaryPairReport {
  const paired = pairedRows(rows, rival);
  const grouped = groupByRepository(paired);
  const perRepository = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repository, selected]) => ({ repository, queryCount: selected.length, hitAt5Delta: mean(selected.map((row) => row.delta)) }));
  const leaveOneRepositoryOut = perRepository.map(({ repository }) => ({
    omittedRepository: repository,
    queryWeightedHitAt5Delta: mean(paired.filter((row) => row.repository !== repository).map((row) => row.delta)),
  }));
  const bootstrap = repositoryClusterBootstrap(paired, samples, seed);

  return {
    baseline: PRIMARY_CONDITION,
    rival,
    track: "explicit-symbol",
    queryCount: paired.length,
    repositoryCount: grouped.size,
    queryWeightedHitAt5Delta: mean(paired.map((row) => row.delta)),
    equalRepositoryHitAt5Delta: mean(perRepository.map((row) => row.hitAt5Delta)),
    perRepository,
    leaveOneRepositoryOut,
    bootstrap: { samples, seed, ...bootstrap },
    exploratory: true,
  };
}

function buildTrack(rows: readonly CompetitiveArtifactRow[]): TrackReport {
  const grouped = groupByRepository(rows);
  const supported = rows.filter((row) => row.score.status !== "unsupported");
  const supportedByRepository = groupByRepository(supported);
  return {
    rowCount: rows.length,
    repositoryCount: grouped.size,
    supportedQueryCount: supported.length,
    metrics: aggregateScores(rows.map((row) => row.score)),
    queryWeightedHitAt5: nullableMean(supported.map((row) => hitAt5(row.score))),
    equalRepositoryHitAt5: nullableMean(
      [...supportedByRepository.values()].map((selected) => mean(selected.map((row) => hitAt5(row.score)))),
    ),
  };
}

function validateManifestCoverage(
  rows: readonly CompetitiveArtifactRow[],
  expectedTasks: readonly CompetitiveExpectedTask[],
  conditions: readonly string[],
): void {
  if (conditions.length === 0 || new Set(conditions).size !== conditions.length) {
    throw new Error("Report conditions must be non-empty and unique");
  }
  const expected = new Map<string, CompetitiveExpectedTask>();
  for (const task of expectedTasks) {
    const key = `${task.repository}\0${task.queryId}`;
    if (expected.has(key)) throw new Error(`Duplicate frozen task: ${task.repository}/${task.queryId}`);
    expected.set(key, task);
  }
  const actual = new Map<string, CompetitiveArtifactRow>();
  for (const row of rows) {
    const key = `${row.condition}\0${taskKey(row)}`;
    if (actual.has(key)) throw new Error(`Duplicate benchmark row: ${row.condition}/${row.repository}/${row.queryId}`);
    actual.set(key, row);
    const task = expected.get(taskKey(row));
    if (!task || task.track !== row.track || !conditions.includes(row.condition)) {
      throw new Error(`Unexpected benchmark row: ${row.condition}/${row.repository}/${row.queryId}`);
    }
  }
  const missing: string[] = [];
  for (const condition of conditions) {
    for (const task of expectedTasks) {
      const key = `${condition}\0${task.repository}\0${task.queryId}`;
      if (!actual.has(key)) missing.push(`${condition}/${task.repository}/${task.queryId}`);
    }
  }
  if (missing.length > 0) throw new Error(`Missing frozen benchmark rows (${missing.length}): ${missing.slice(0, 3).join(", ")}`);
}

export function buildCompetitiveReport(
  rows: readonly CompetitiveArtifactRow[],
  options: {
    expectedTasks: readonly CompetitiveExpectedTask[];
    conditions: readonly string[];
    bootstrapSamples?: number;
    seed?: number;
  },
): CompetitiveReport {
  validateManifestCoverage(rows, options.expectedTasks, options.conditions);
  const tracks: CompetitiveReport["tracks"] = {};
  for (const condition of [...new Set(rows.map((row) => row.condition))].sort()) {
    tracks[condition] = {};
    for (const track of ["explicit-symbol", "natural-language"] as const) {
      const selected = rows.filter((row) => row.condition === condition && row.track === track);
      if (selected.length > 0) tracks[condition][track] = buildTrack(selected);
    }
  }

  const samples = options.bootstrapSamples ?? BOOTSTRAP_SAMPLES;
  const seed = options.seed ?? REPORT_SEED;
  return {
    cohort: "development-only",
    exploratory: true,
    tracks,
    primaryPairs: PRIMARY_RIVALS.map((rival) => buildPair(rows, rival, samples, seed)),
  };
}

async function listDirectories(directory: string): Promise<string[]> {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function loadCompetitiveRows(outputRoot: string): Promise<CompetitiveArtifactRow[]> {
  const rows: CompetitiveArtifactRow[] = [];
  for (const repository of await listDirectories(outputRoot)) {
    if (repository === "active-source") continue;
    const repositoryDirectory = path.join(outputRoot, repository);
    for (const condition of await listDirectories(repositoryDirectory)) {
      const repeatDirectory = path.join(repositoryDirectory, condition, "repeat-1");
      const files = (await fs.readdir(repeatDirectory)).filter((file) => file.endsWith(".json")).sort();
      if (files.length === 0) throw new Error(`Empty primary quality directory: ${repository}/${condition}/repeat-1`);
      for (const file of files) {
        const artifact = JSON.parse(await fs.readFile(path.join(repeatDirectory, file), "utf8")) as {
          queryId?: string;
          condition?: string;
          input?: { symbol?: string };
          repeat?: number;
          score?: CompetitiveQueryScore;
        };
        if (
          artifact.repeat !== 1
          || !artifact.queryId
          || artifact.condition !== condition
          || !artifact.score
          || artifact.score.queryId !== artifact.queryId
        ) {
          throw new Error(`Malformed primary quality artifact: ${repository}/${condition}/${file}`);
        }
        rows.push({
          repository,
          condition,
          queryId: artifact.queryId,
          track: artifact.input?.symbol ? "explicit-symbol" : "natural-language",
          score: artifact.score,
        });
      }
    }
  }
  return rows;
}

export async function loadCompetitiveRun(outputRoot: string): Promise<CompetitiveRunArtifacts> {
  const run = JSON.parse(await fs.readFile(path.join(outputRoot, "run.json"), "utf8")) as {
    options?: { conditions?: string[]; repositories?: string[] };
    sourceLock?: { repositories?: Array<{ name: string }> };
  };
  const conditions = run.options?.conditions;
  const repositories = run.sourceLock?.repositories;
  if (!conditions || !repositories) throw new Error("Malformed run manifest");
  const selectedRepositories = run.options?.repositories ?? repositories.map((repository) => repository.name);
  if (selectedRepositories.length === 0 || new Set(selectedRepositories).size !== selectedRepositories.length) {
    throw new Error("Run manifest has invalid repository selection");
  }
  const expectedTasks: CompetitiveExpectedTask[] = [];
  for (const repositoryName of selectedRepositories) {
    const repository = repositories.find((candidate) => candidate.name === repositoryName);
    if (!repository) throw new Error(`Run selects unknown repository: ${repositoryName}`);
    const input = JSON.parse(await fs.readFile(path.join(outputRoot, repository.name, "inputs.json"), "utf8")) as {
      queryOrder?: string[];
      dataset?: { queries?: Array<{ id?: string; args?: { symbol?: string } }> };
    };
    if (!input.queryOrder || !input.dataset?.queries || input.queryOrder.length !== input.dataset.queries.length) {
      throw new Error(`Malformed frozen inputs for ${repository.name}`);
    }
    const queries = new Map(input.dataset.queries.map((query) => [query.id, query]));
    for (const queryId of input.queryOrder) {
      const query = queries.get(queryId);
      if (!queryId || !query) throw new Error(`Frozen query order mismatch for ${repository.name}`);
      expectedTasks.push({
        repository: repository.name,
        queryId,
        track: query.args?.symbol ? "explicit-symbol" : "natural-language",
      });
    }
  }
  const rows = await loadCompetitiveRows(outputRoot);
  validateManifestCoverage(rows, expectedTasks, conditions);
  return { rows, expectedTasks, conditions };
}

/**
 * Combine the nine split repository runs before reporting:
 * `npx tsx scripts/competitive-report.ts results/*-run`
 */
export async function loadCompetitiveRuns(outputRoots: readonly string[]): Promise<CompetitiveRunArtifacts> {
  if (outputRoots.length === 0) throw new Error("At least one split run directory is required");
  const runs = await Promise.all(outputRoots.map((root) => loadCompetitiveRun(root)));
  const conditions = [...runs[0].conditions];
  if (
    conditions.length !== EXPECTED_CONDITIONS.length
    || EXPECTED_CONDITIONS.some((condition) => !conditions.includes(condition))
    || runs.some((run) => run.conditions.length !== conditions.length || run.conditions.some((condition) => !conditions.includes(condition)))
  ) {
    throw new Error("Split runs do not share the full frozen condition manifest");
  }
  const rows = runs.flatMap((run) => run.rows);
  const expectedTasks = runs.flatMap((run) => run.expectedTasks);
  const repositoryCount = new Set(expectedTasks.map((task) => task.repository)).size;
  const explicitCount = expectedTasks.filter((task) => task.track === "explicit-symbol").length;
  const naturalCount = expectedTasks.filter((task) => task.track === "natural-language").length;
  if (repositoryCount !== 9 || expectedTasks.length !== 100 || explicitCount !== 54 || naturalCount !== 46) {
    throw new Error(`Incomplete frozen cohort: expected 100 tasks across 9 repositories, got ${expectedTasks.length} across ${repositoryCount}`);
  }
  validateManifestCoverage(rows, expectedTasks, conditions);
  return { rows, expectedTasks, conditions };
}

async function main(): Promise<void> {
  const artifacts = await loadCompetitiveRuns(process.argv.slice(2).map((root) => path.resolve(root)));
  process.stdout.write(`${JSON.stringify(buildCompetitiveReport(artifacts.rows, artifacts), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
