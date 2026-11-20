import type * as ConfigModule from "../../src/config/schema.js";
import type * as IndexerModule from "../../src/indexer/index.js";
import type * as BindingModule from "../../src/native/binding.js";
import type * as NativeModule from "../../src/native/index.js";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

export type Mode = "structural" | "hybrid";
export type Scenario = "seed" | "status" | "switch" | "noop" | "edit" | "full" | "database" | "extract" | "compatibility";

type SourceIndexer = IndexerModule.Indexer;

export interface Job {
  root: string;
  project: string;
  index: string;
  mode: Mode;
  scenario: Scenario;
  endpoint: string;
  corpus: string;
}

export interface ExtractionCase {
  name: string;
  language: string;
  source: string;
  positive?: string;
  empty?: boolean;
}

interface ExtractionResult {
  ordered: { name: string; calls: NativeModule.CallSiteData[] }[];
  firstMs: number;
  smallMs: number;
  largeMs: number;
}

interface PublicationProbe {
  replaceBranchCatalog: (...args: unknown[]) => boolean;
}

const workerPath = fileURLToPath(import.meta.url);
const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const filePin = (file: string) => ({ path: realpathSync(file), sha256: sha(readFileSync(file)) });

async function loadArm(root: string) {
  // Only the runner chooses the source worktree; never statically load the executor's Indexer.
  const indexerUrl = pathToFileURL(path.join(root, "src/indexer/index.ts"));
  const importFromArm = (file: string) => import(pathToFileURL(path.join(root, file)).href);
  const { Indexer } = await import(indexerUrl.href) as typeof IndexerModule;
  const { parseConfig } = await importFromArm("src/config/schema.ts") as typeof ConfigModule;
  const api = await importFromArm("src/native/index.ts") as typeof NativeModule;
  const binding = await importFromArm("src/native/binding.ts") as typeof BindingModule;
  const binary = binding.resolveNativeBindingPath(root);
  const loaded = createRequire(indexerUrl).cache[binary];
  assert(loaded?.loaded && loaded.exports === binding.native, `Expected the loaded native addon at ${binary}`);
  assert.equal(realpathSync(loaded.filename), binary, "Native addon must belong to the selected worktree");
  return { Indexer, parseConfig, ...api, binary, indexerSource: fileURLToPath(indexerUrl) };
}

function runExtraction(
  extract: (source: string, language: string) => NativeModule.CallSiteData[],
  cases: ExtractionCase[],
): ExtractionResult {
  const callsFor = (entry: ExtractionCase) => extract(entry.source, entry.language);
  const firstStart = performance.now();
  const first = callsFor(cases[0]!);
  const firstMs = performance.now() - firstStart;
  const ordered = cases.map((entry) => {
    const calls = callsFor(entry);
    if (entry.positive) assert(calls.some((call) => call.calleeName === entry.positive), entry.name);
    if (entry.empty) assert.deepEqual(calls, [], entry.name);
    return { name: entry.name, calls };
  });
  assert.deepEqual(first, ordered[0]!.calls);
  const small = cases.filter(({ source }) => source.length < 8192);
  const large = cases.filter(({ source }) => source.length >= 8192);
  assert(small.length && large.length);
  function measure(batch: ExtractionCase[], rounds: number) {
    let count = 0;
    const start = performance.now();
    for (let round = 0; round < rounds; round++) {
      for (const entry of batch) count += callsFor(entry).length;
    }
    const ms = performance.now() - start;
    assert.equal(count, rounds * ordered.filter(({ name }) => batch.some((entry) => entry.name === name))
      .reduce((sum, { calls }) => sum + calls.length, 0));
    return ms;
  }
  return { ordered, firstMs, smallMs: measure(small, 2), largeMs: measure(large, 2) };
}

async function extractParallel(root: string, cases: ExtractionCase[]): Promise<ExtractionResult[]> {
  return Promise.all(Array.from({ length: 3 }, () => {
    const { promise, resolve, reject } = Promise.withResolvers<ExtractionResult>();
    const worker = new Worker(new URL(import.meta.url), { workerData: { root, cases } });
    let result: ExtractionResult | undefined;
    worker.once("message", (message: ExtractionResult) => { result = message; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code === 0 && result) resolve(result);
      else reject(new Error(`Extraction thread exited ${code} without a result`));
    });
    return promise;
  }));
}

function withoutIndexTimestamps(status: IndexerModule.StatusResult) {
  const compatibility = status.compatibility;
  const stored = compatibility?.storedMetadata;
  if (!compatibility || !stored) return status;
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...stable } = stored;
  return { ...status, compatibility: { ...compatibility, storedMetadata: stable } };
}

async function run(job: Job) {
  const importStart = performance.now();
  const arm = await loadArm(job.root);
  const importMs = performance.now() - importStart;
  const requests: { model: string; inputs: string[] }[] = [];
  // Observe real HTTP requests to the fixture server, never an installed provider.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    assert.equal(job.mode, "hybrid", "Structural mode must not request embeddings");
    assert.equal(String(input), `${job.endpoint}/embeddings`, "Unexpected embedding endpoint");
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    assert.equal(body.model, "index-refresh-fixture");
    assert(Array.isArray(body.input) && body.input.every((item) => typeof item === "string"));
    requests.push({ model: body.model, inputs: body.input.map((item) => sha(item)) });
    return realFetch(input, init);
  };
  const config = arm.parseConfig({
    scope: "project",
    include: ["src/**/*.ts"],
    embeddingProvider: "custom",
    customProvider: {
      baseUrl: job.endpoint, model: "index-refresh-fixture", dimensions: 8,
      maxBatchSize: 64, concurrency: 1, requestIntervalMs: 0,
    },
    indexing: {
      mode: job.mode, autoIndex: false, watchFiles: false, retries: 0,
      autoGc: false, requireProjectMarker: false, maxFilesPerDirectory: 2000,
    },
    search: { minScore: 0 },
  });
  const dbPath = path.join(job.index, ...(job.mode === "structural" ? ["structural"] : []), "codebase.db");
  const git = (...args: string[]): void => { execFileSync("git", args, { cwd: job.project, stdio: "pipe" }); };
  const makeIndexer = () => new arm.Indexer(job.project, config, "opencode", { indexPath: job.index });
  const timings: Record<string, number> = {};
  let peakRssBytes = 0;
  let evidence: unknown;
  const markRss = () => { peakRssBytes = process.resourceUsage().maxRSS * 1024; };

  function catalog() {
    const db = arm.Database.openReadOnly(dbPath);
    try {
      const branches = db.getAllBranches();
      assert.deepEqual(branches, [...branches].sort());
      return {
        stats: db.getStats(),
        branches: branches.map((branch) => ({
          branch,
          chunks: db.getBranchChunkIds(branch).sort(),
          symbols: db.getBranchSymbolIds(branch).sort(),
        })),
      };
    } finally {
      db.close();
    }
  }

  async function observe(indexer: SourceIndexer, branch: string, edited = false) {
    const status = withoutIndexTimestamps(await indexer.getStatus());
    assert(status.indexed && status.branchReadiness?.state === "ready", JSON.stringify(status));
    assert.equal(status.currentBranch, branch);
    assert.equal(status.migrationRequired, false);
    const ranked = await indexer.search("refreshCaller", 8, { definitionIntent: true });
    assert(ranked.some(({ name }) => name === "refreshCaller"), "Expected refreshCaller in ordered search results");
    const symbol = (await indexer.getSymbolsForBranch()).find(({ name }) => name === "refreshCaller");
    assert(symbol, "Expected refreshCaller symbol");
    const callees = await indexer.getCallees(symbol.id);
    const callers = await Promise.all(["refreshBefore", "refreshAfter", "refreshAlways"].map((name) => indexer.getCallers(name)));
    const target = edited ? "refreshAfter" : "refreshBefore";
    assert.equal(callees.length, 2);
    assert(callees.some(({ targetName }) => targetName === target));
    assert(callees.some(({ targetName }) => targetName === "refreshAlways"));
    assert.deepEqual(callers.slice(0, 2).map((edges) => edges.map(({ fromSymbolName }) => fromSymbolName)),
      edited ? [[], ["refreshCaller"]] : [["refreshCaller"], []]);
    assert.equal(callers[2]!.length, 2);
    assert.deepEqual(new Set(callers[2]!.map(({ fromSymbolName }) => fromSymbolName)),
      new Set(["refreshCaller", "refreshOtherCaller"]));
    const nativeSites = arm.extractCalls(readFileSync(path.join(job.project, "src/entry.ts"), "utf8"), "typescript");
    assert(nativeSites.some(({ calleeName }) => calleeName === target));
    return { status, ranked, callers, callees, nativeSites };
  }

  let indexer: SourceIndexer | undefined;
  try {
    if (job.scenario === "extract") {
      const cases = JSON.parse(readFileSync(job.corpus, "utf8")) as ExtractionCase[];
      const serial = runExtraction(arm.extractCalls, cases);
      const parallel = await extractParallel(job.root, cases);
      for (const result of parallel) assert.deepEqual(result.ordered, serial.ordered);
      timings.first = serial.firstMs;
      timings.small = serial.smallMs;
      timings.large = serial.largeMs;
      timings.parallelSmall = Math.max(...parallel.map(({ smallMs }) => smallMs));
      timings.parallelLarge = Math.max(...parallel.map(({ largeMs }) => largeMs));
      markRss();
      evidence = serial.ordered;
    } else if (job.scenario === "database") {
      const db = arm.Database.openReadOnly(dbPath);
      try {
        const reads = db as typeof db & {
          hasChunks?: () => boolean;
          hasChunksOrSymbols?: () => boolean;
          getChunkCount?: () => number;
          getIndexPresence?: () => { hasChunks: boolean; hasSymbols: boolean };
        };
        const operations = {
          hasChunks: () => reads.hasChunks?.() ?? reads.getIndexPresence?.().hasChunks ?? db.getStats().chunkCount > 0,
          hasChunksOrSymbols: () => {
            if (reads.hasChunksOrSymbols) return reads.hasChunksOrSymbols();
            if (reads.getIndexPresence) {
              const { hasChunks, hasSymbols } = reads.getIndexPresence();
              return hasChunks || hasSymbols;
            }
            const { chunkCount, symbolCount } = db.getStats();
            return chunkCount > 0 || symbolCount > 0;
          },
          chunkCount: () => reads.getChunkCount?.() ?? db.getStats().chunkCount,
          branches: () => db.getAllBranches(),
          stats: () => db.getStats(),
        };
        const answers: Record<string, unknown> = {};
        for (const [name, call] of Object.entries(operations)) {
          const expected = call();
          const started = performance.now();
          let answer;
          for (let sample = 0; sample < 200; sample++) answer = call();
          timings[name] = performance.now() - started;
          assert.deepEqual(answer, expected);
          answers[name] = answer;
        }
        markRss();
        evidence = answers;
      } finally {
        db.close();
      }
    } else {
      const started = performance.now();
      indexer = makeIndexer();
      const publication = indexer as unknown as PublicationProbe;
      const original = publication.replaceBranchCatalog;
      assert.equal(typeof original, "function");
      let publications = 0;
      publication.replaceBranchCatalog = function (...args) {
        publications++;
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { timings.publication = (timings.publication ?? 0) + performance.now() - start; }
      };
      let action;
      let branch = "main";
      let before;
      if (job.scenario === "status") {
        action = await indexer.getStatus();
        timings.operation = performance.now() - started;
        action = withoutIndexTimestamps(action);
      } else if (job.scenario === "switch") {
        await indexer.getStatus();
        const switchStart = performance.now();
        git("switch", "--quiet", "other");
        branch = "other";
        const statusStart = performance.now();
        action = await indexer.getStatus();
        timings.branchStatus = performance.now() - statusStart;
        timings.operation = performance.now() - switchStart;
        action = withoutIndexTimestamps(action);
      } else {
        if (job.scenario === "seed") {
          await indexer.index();
          git("switch", "--quiet", "other");
          branch = "other";
        }
        if (job.scenario === "compatibility") {
          before = await observe(indexer, branch);
          await indexer.close();
          indexer = makeIndexer();
          git("apply", path.join(job.project, "..", "edit.patch"));
        }
        const requestOffset = requests.length;
        const operationStart = performance.now();
        const { durationMs: _volatile, ...stats } = await indexer.index();
        timings.operation = performance.now() - operationStart;
        if (job.scenario === "noop") {
          assert.equal(stats.totalChunks, 0, JSON.stringify(stats));
          assert.equal(requests.length, requestOffset, "Unchanged indexing must not embed");
        } else if (job.scenario !== "seed") {
          assert(stats.indexedChunks > 0 && stats.failedChunks === 0, JSON.stringify(stats));
        }
        if (job.scenario !== "compatibility") assert.equal(publications, job.scenario === "seed" ? 2 : 1);
        action = { stats, requests: requests.slice(requestOffset) };
      }
      markRss();
      const edited = job.scenario === "edit" || job.scenario === "compatibility";
      if (job.scenario !== "status" && job.scenario !== "switch") {
        // Observe the persisted compatibility metadata after the writer closes.
        await indexer.close();
        indexer = makeIndexer();
      }
      const observed = await observe(indexer, branch, edited);
      await indexer.close();
      indexer = undefined;
      const memberships = catalog();
      evidence = { action, before, observed, memberships, requests };
    }
  } finally {
    await indexer?.close();
    globalThis.fetch = realFetch;
  }
  return {
    scenario: job.scenario, mode: job.mode, timings, importMs, peakRssBytes, evidence, config,
    provenance: { worker: filePin(workerPath), indexer: filePin(arm.indexerSource), binary: filePin(arm.binary) },
  };
}

if (isMainThread) {
  const job = JSON.parse(process.argv[2]!) as Job;
  const result = await run(job);
  // All handles and extraction threads are closed; don't wait for loader internals.
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
} else {
  const { root, cases } = workerData as { root: string; cases: ExtractionCase[] };
  const { extractCalls } = await loadArm(root);
  parentPort!.postMessage(runExtraction(extractCalls, cases));
}
