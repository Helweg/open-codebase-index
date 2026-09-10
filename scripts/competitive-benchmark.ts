#!/usr/bin/env node
/** Development-cohort diagnostics, not a claim of held-out superiority. */
import type { GoldenQuery } from "../src/eval/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createAdapter } from "./competitive-adapters.js";
import { scoreQuery, aggregateScores } from "./competitive-scoring.js";

const exec = promisify(execFile);
export const CONDITIONS = ["ocbi-hybrid", "ocbi-structural", "codegraph", "codebase-memory", "grepai"] as const;
export type Condition = typeof CONDITIONS[number];
interface LockedRepository { name: string; revision: string; dataset: string; archiveSha256: string; datasetSha256: string }
interface SourceLock { ocbiCommit: string; repositories: LockedRepository[] }
interface LockedArtifact { root: "project" | "tools"; path: string; sha256: string }
interface LockedRuntime { nodeVersion: string; nodeSha256: string; platform: string; arch: string }
interface LockedEmbedding { name: string; digest: string }
interface InterfaceLock { status?: string; artifacts?: LockedArtifact[]; runtime?: LockedRuntime; models?: { embedding?: LockedEmbedding }; interfaces?: unknown }
export interface BenchmarkOptions {
  projectRoot: string;
  scratchRoot: string;
  outputRoot: string;
  toolsRoot: string;
  conditions: Condition[];
  repositories?: string[];
  repeats: number;
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor((state / 4294967296) * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function adapterInput(query: GoldenQuery): { query: string; symbol?: string; limit: number } {
  // Never pass expected labels, answer paths or oracle symbols to a participant.
  const symbol = query.args?.symbol;
  return { query: query.query, ...(typeof symbol === "string" && symbol.trim() ? { symbol } : {}), limit: 50 };
}

function parseSelection(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const selected = value.split(",");
  if (selected.some(item => item.length === 0 || item.trim() !== item) || new Set(selected).size !== selected.length) {
    throw new Error(`${label} must be a comma-separated list of unique, non-empty values without surrounding whitespace.`);
  }
  return selected;
}

export function parseBenchmarkArgs(args: readonly string[]): Pick<BenchmarkOptions, "scratchRoot" | "outputRoot" | "conditions" | "repositories" | "repeats"> {
  const allowed = new Set(["--scratch-root", "--output", "--conditions", "--repos", "--repeats"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith("--") || !allowed.has(name)) throw new Error(`Unknown argument: ${name ?? "<missing>"}`);
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    values.set(name, value);
  }
  const scratchRoot = values.get("--scratch-root");
  const outputRoot = values.get("--output");
  if (!scratchRoot || !outputRoot) throw new Error("Usage: competitive-benchmark.ts --scratch-root PATH --output NEW_PATH [--conditions a,b] [--repos a,b] [--repeats 3]");
  const selectedConditions = parseSelection(values.get("--conditions"), "Conditions") ?? [...CONDITIONS];
  if (selectedConditions.some(condition => !CONDITIONS.includes(condition as Condition))) throw new Error("Unknown condition selection.");
  const repeatsText = values.get("--repeats") ?? "3";
  if (!/^[1-3]$/.test(repeatsText)) throw new Error("Repeats must be 1..3.");
  return {
    scratchRoot: path.resolve(scratchRoot), outputRoot: path.resolve(outputRoot),
    conditions: selectedConditions as Condition[], repositories: parseSelection(values.get("--repos"), "Repositories"),
    repeats: Number(repeatsText),
  };
}

export function isSupportedQuery(condition: Condition, query: GoldenQuery): boolean {
  return condition !== "codebase-memory" || Boolean(adapterInput(query).symbol);
}

export function firstSupportedQuery(condition: Condition, queries: readonly GoldenQuery[]): GoldenQuery | undefined {
  return queries.find(query => isSupportedQuery(condition, query));
}

export async function timedQuery<T>(query: () => Promise<T>, now: () => number = performance.now.bind(performance)): Promise<{ result?: T; error?: unknown; durationMs: number }> {
  const start = now();
  try { return { result: await query(), durationMs: now() - start }; }
  catch (error) { return { error, durationMs: now() - start }; }
}

export function summarizeTracks<T>(queries: readonly GoldenQuery[], rows: readonly T[], aggregate: (selected: T[]) => unknown): Record<string, { queryCount: number; metrics: unknown }> {
  if (queries.length !== rows.length) throw new Error("Queries and score rows must have equal lengths.");
  const tracks: Record<string, { queryCount: number; metrics: unknown }> = {};
  for (const [name, explicit] of [["explicit-symbol", true], ["natural-language", false]] as const) {
    const selected = rows.filter((_row, index) => Boolean(adapterInput(queries[index]).symbol) === explicit);
    tracks[name] = { queryCount: selected.length, metrics: aggregate(selected) };
  }
  return tracks;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
async function save(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

function resolveLockedArtifact(lock: LockedArtifact, options: BenchmarkOptions): string {
  if (!lock.path || path.isAbsolute(lock.path) || lock.path.split(/[\\/]/u).includes("..")) throw new Error(`Unsafe frozen artifact path: ${lock.path}`);
  const root = lock.root === "project" ? options.projectRoot : lock.root === "tools" ? options.toolsRoot : undefined;
  if (!root) throw new Error(`Unknown frozen artifact root: ${String(lock.root)}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, lock.path);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Frozen artifact escapes its root: ${lock.path}`);
  return resolved;
}

export async function validateInterfaceLock(lock: InterfaceLock, options: BenchmarkOptions): Promise<void> {
  if (lock.status !== "frozen" || !Array.isArray(lock.artifacts) || lock.artifacts.length === 0 || !lock.runtime) throw new Error("A reviewed frozen tool/interface lock with artifacts and runtime is required before scored runs.");
  if (lock.runtime.nodeVersion !== process.version || lock.runtime.platform !== process.platform || lock.runtime.arch !== process.arch) {
    throw new Error("Frozen runtime identity does not match the current process.");
  }
  if (!/^[a-f0-9]{64}$/.test(lock.runtime.nodeSha256) || await sha256(process.execPath) !== lock.runtime.nodeSha256) {
    throw new Error("Frozen Node executable hash does not match the current process.");
  }
  const seen = new Set<string>();
  for (const artifact of lock.artifacts) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Invalid frozen artifact SHA256: ${artifact.path}`);
    const file = resolveLockedArtifact(artifact, options);
    const realRoot = await fs.realpath(artifact.root === "project" ? options.projectRoot : options.toolsRoot);
    const realFile = await fs.realpath(file);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Frozen artifact escapes its root: ${artifact.path}`);
    if (seen.has(file)) throw new Error(`Duplicate frozen artifact: ${artifact.root}/${artifact.path}`);
    seen.add(file);
    if (await sha256(file) !== artifact.sha256) throw new Error(`Frozen artifact hash mismatch: ${artifact.root}/${artifact.path}`);
  }
}

export async function validateEmbeddingLock(
  lock: InterfaceLock,
  conditions: readonly Condition[],
  fetchTags: (signal: AbortSignal) => Promise<unknown> = async signal => {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal });
    if (!response.ok) throw new Error(`Ollama tags request failed: HTTP ${response.status}`);
    return response.json();
  },
): Promise<void> {
  if (!conditions.some(condition => condition === "ocbi-hybrid" || condition === "grepai")) return;
  const expected = lock.models?.embedding;
  if (!expected?.name || !/^[a-f0-9]{64}$/.test(expected.digest)) throw new Error("A frozen embedding model name and digest are required.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const payload = await fetchTags(controller.signal) as { models?: Array<{ name?: string; digest?: string }> };
    const actual = payload.models?.find(model => model.name === expected.name);
    if (actual?.digest !== expected.digest) throw new Error(`Frozen embedding model mismatch: ${expected.name}`);
  } finally { clearTimeout(timeout); }
}

export async function preserveWorkspace(
  workspace: string,
  destination: string,
  close: (() => Promise<void>) | undefined,
  rename: (source: string, target: string) => Promise<void> = fs.rename,
): Promise<void> {
  let closeError: unknown;
  try { await close?.(); } catch (error) { closeError = error; }
  try { await rename(workspace, destination); }
  catch (error) {
    throw new AggregateError(closeError === undefined ? [error] : [closeError, error], `Failed to preserve benchmark workspace at ${destination}`);
  }
  if (closeError !== undefined) throw closeError;
}
async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile()) bytes += (await fs.stat(file)).size;
  }
  return bytes;
}

async function optionalDirectoryBytes(root: string): Promise<number> {
  try { return await directoryBytes(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function runCompetitiveBenchmark(options: BenchmarkOptions): Promise<void> {
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 3) throw new Error("Repeats must be 1..3.");
  if (options.conditions.length === 0 || new Set(options.conditions).size !== options.conditions.length || options.conditions.some(c => !CONDITIONS.includes(c))) throw new Error("Invalid or duplicate conditions.");
  if (options.repositories && (options.repositories.length === 0 || new Set(options.repositories).size !== options.repositories.length || options.repositories.some(repo => !repo))) throw new Error("Invalid or duplicate repositories.");
  const sourceLockPath = path.join(options.projectRoot, "benchmarks/competitive/2026-09-10/source-lock.json");
  const lock = JSON.parse(await fs.readFile(sourceLockPath, "utf8")) as SourceLock;
  const interfaceLockPath = path.join(options.projectRoot, "benchmarks/competitive/2026-09-10/tool-interface-lock.json");
  const interfaceLock = JSON.parse(await fs.readFile(interfaceLockPath, "utf8")) as InterfaceLock;
  await validateInterfaceLock(interfaceLock, options);
  await validateEmbeddingLock(interfaceLock, options.conditions);
  const repos = lock.repositories.filter(r => !options.repositories || options.repositories.includes(r.name));
  if (!repos.length || (options.repositories && repos.length !== new Set(options.repositories).size)) throw new Error("Unknown/empty repository selection.");
  // Refuse reuse rather than deleting or overwriting any earlier evidence.
  await fs.mkdir(options.outputRoot, { recursive: false });
  const workspace = path.join(options.outputRoot, "active-source");
  await save(path.join(options.outputRoot, "run.json"), {
    startedAt: new Date().toISOString(), kind: "development-only", options, sourceLock: lock,
    interfaceLock, sourceLockSha256: await sha256(sourceLockPath), interfaceLockSha256: await sha256(interfaceLockPath),
    runtime: process.version, platform: process.platform, arch: process.arch,
    primaryQualityRepeat: 1, latencyComparableAcrossInterfaces: false,
  });
  for (const repo of repos) {
    const repoIndex = lock.repositories.indexOf(repo);
    const datasetPath = path.join(options.projectRoot, "benchmarks/golden/expanded-cross-repo", repo.dataset);
    const archive = path.join(options.scratchRoot, "archives", `${repo.name}-${repo.revision}.tar`);
    if (await sha256(datasetPath) !== repo.datasetSha256 || await sha256(archive) !== repo.archiveSha256) throw new Error(`Input hash mismatch: ${repo.name}`);
    const dataset = JSON.parse(await fs.readFile(datasetPath, "utf8")) as { queries: GoldenQuery[] };
    const queries = shuffled(dataset.queries, 20260910 + repoIndex);
    const order = shuffled(options.conditions, 20260910 + repoIndex);
    await save(path.join(options.outputRoot, repo.name, "inputs.json"), { repo, queryOrder: queries.map(q => q.id), toolOrder: order, dataset });
    for (const condition of order) {
      const artifactDir = path.join(options.outputRoot, repo.name, condition);
      await fs.mkdir(artifactDir, { recursive: true });
      await fs.mkdir(workspace);
      // Archives come exclusively from the preregistered git revisions and were hashed above.
      await exec("tar", ["-xf", archive, "-C", workspace], { timeout: 30000 });
      const sourceBytes = await directoryBytes(workspace);
      const configPath = path.join(artifactDir, "ocbi-config.json");
      await save(configPath, {
        embeddingProvider: "ollama", embeddingModel: "nomic-embed-text",
        indexing: { mode: condition === "ocbi-structural" ? "structural" : "hybrid", autoIndex: false, watchFiles: false, requireProjectMarker: false, maxFileSize: 1000000, maxChunksPerFile: 100 },
        reranker: { enabled: false },
      });
      let adapter: Awaited<ReturnType<typeof createAdapter>> | undefined;
      let setupError: string | undefined;
      const start = performance.now();
      try {
        adapter = await createAdapter(condition, { projectRoot: workspace, toolsRoot: options.toolsRoot, ocbiCliPath: path.join(options.projectRoot, "dist/cli.js"), configPath, artifactDir });
        const result = await adapter.index();
        await save(path.join(artifactDir, "index.json"), { elapsedMs: performance.now() - start, result });
      } catch (error) {
        setupError = error instanceof Error ? error.message : String(error);
        await save(path.join(artifactDir, "index.json"), { elapsedMs: performance.now() - start, error: setupError });
      }
      const primary = [];
      try {
        const firstQuery = firstSupportedQuery(condition, queries);
        if (!setupError && adapter && firstQuery) {
          try { await save(path.join(artifactDir, "first-query.json"), { queryId: firstQuery.id, input: adapterInput(firstQuery), result: await adapter.query(adapterInput(firstQuery)) }); }
          catch (error) { await save(path.join(artifactDir, "first-query.json"), { error: String(error) }); }
        }
        for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
          for (const query of queries) {
            let row;
            let raw: unknown;
            let durationMs = 0;
            const unsupported = !isSupportedQuery(condition, query);
            try {
              if (unsupported) row = scoreQuery(query, [], "unsupported");
              else {
                if (setupError || !adapter) throw new Error(setupError ?? "Adapter unavailable");
                const timed = await timedQuery(() => adapter.query(adapterInput(query)));
                durationMs = timed.durationMs;
                if (timed.error !== undefined) throw timed.error;
                const result = timed.result;
                if (!result) throw new Error("Adapter returned no query result");
                raw = result.raw;
                durationMs = result.durationMs;
                row = scoreQuery(query, result.paths, result.status);
              }
            } catch (error) { raw = { error: error instanceof Error ? error.message : String(error) }; row = scoreQuery(query, [], "error"); }
            await save(path.join(artifactDir, `repeat-${repeat}`, `${query.id}.json`), { queryId: query.id, input: adapterInput(query), repeat, condition, durationMs, raw, score: row });
            if (repeat === 1) primary.push(row);
          }
        }
        await save(path.join(artifactDir, "summary.json"), {
          condition, repository: repo.name, setupError, primaryQualityRepeat: 1,
          tracks: summarizeTracks(queries, primary, aggregateScores),
          sourceBytes, workspaceBytesAfter: await directoryBytes(workspace),
          ownedHomeBytes: await optionalDirectoryBytes(path.join(artifactDir, "home")),
          ownedCbmCacheBytes: await optionalDirectoryBytes(path.join(artifactDir, "cbm-cache")),
          resourceNote: "Workspace bytes include original sources. Adapter-owned home and CBM cache bytes are separate. No peak-memory measurement or index-size claim.",
          timingNote: "Quality is reported separately for explicit-symbol and natural-language tracks; fresh-index and interface-specific timings only; no cross-interface speed claim.",
        });
      } finally {
        // Preserve all original sources and index artifacts; never delete an earlier cell.
        await preserveWorkspace(workspace, path.join(artifactDir, "source-and-index"), adapter ? () => adapter.close() : undefined);
      }
      console.log(`JCODE_PROGRESS ${JSON.stringify({ message: `${repo.name}/${condition} recorded`, current: repoIndex * order.length + order.indexOf(condition) + 1, total: repos.length * order.length })}`);
    }
  }
  await save(path.join(options.outputRoot, "completed.json"), { completedAt: new Date().toISOString() });
}

async function main(): Promise<void> {
  const parsed = parseBenchmarkArgs(process.argv.slice(2));
  await runCompetitiveBenchmark({ projectRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ...parsed, toolsRoot: path.join(parsed.scratchRoot, "tools") });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
