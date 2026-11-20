import type { ExtractionCase, Job, Mode, Scenario } from "./fixtures/index-refresh-worker.js";

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const UPSTREAM = "f3abf4d0a3e0413c9d4b515af1d2e33e3cf911b3";
const FORK = "54688c9fd7f0c67426b8c0c352608a3366951cd0";
const MODES = ["structural", "hybrid"] as const;
const SCENARIOS = ["status", "switch", "noop", "edit", "full", "database"] as const;
const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = fs.realpathSync(path.join(BENCH_DIR, "fixtures/index-refresh-worker.ts"));
const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const driverPath = fs.realpathSync(fileURLToPath(import.meta.url));
const driverSha256 = sha(fs.readFileSync(driverPath));
const workerSha256 = sha(fs.readFileSync(WORKER));

interface Pin { path: string; sha256: string }
interface WorkerResult {
  scenario: Scenario;
  mode: Mode;
  timings: Record<string, number>;
  importMs: number;
  peakRssBytes: number;
  evidence: unknown;
  config: unknown;
  provenance: { worker: Pin; indexer: Pin; binary: Pin };
}
interface Sample extends Omit<WorkerResult, "evidence"> {
  evidenceDigest: string;
  parity: boolean;
  differences: string[];
}
interface Membership {
  branch: string;
  chunks: string[];
  symbols: string[];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : Number(a > b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function differences(expected: unknown, observed: unknown, key = "$"): string[] {
  if (JSON.stringify(expected) === JSON.stringify(observed)) return [];
  if (!expected || !observed || typeof expected !== "object" || typeof observed !== "object" ||
      Array.isArray(expected) || Array.isArray(observed)) return [key];
  const before = expected as Record<string, unknown>;
  const after = observed as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .flatMap((child) => differences(before[child], after[child], `${key}.${child}`));
}

function fixture(project: string, corpusPath: string, git: (args: string[]) => string) {
  const source = path.join(project, "src");
  fs.mkdirSync(source, { recursive: true });
  const files: [string, string][] = [["entry.ts", [
    "export function refreshBefore(value: number) { return (value + 13) * 7; }",
    "export function refreshAfter(value: number) { return (value + 29) * 5; }",
    "export function refreshAlways(value: number) { return value * 11; }",
    "export function refreshCaller() { return refreshBefore(22) + refreshAlways(9); }",
    "export function refreshOtherCaller() { return refreshAlways(42); }",
    "",
  ].join("\n")]];
  for (let file = 0; file < 256; file++) {
    const suffix = String(file).padStart(3, "0");
    files.push([`file${suffix}.ts`, Array.from({ length: 6 }, (_, pair) => {
      const id = `${suffix}_${pair}`;
      return [
        `export function target${id}(seed: number) { return (seed + ${file + 1}) * ${pair + 2}; }`,
        `export function caller${id}(seed: number) { return target${id}(seed + ${pair}); }`,
      ].join("\n");
    }).join("\n\n") + "\n"]);
  }
  for (const [file, content] of files) fs.writeFileSync(path.join(source, file), content);
  git(["init", "--quiet", "-b", "main"]);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "Index refresh fixture"]);
  git(["switch", "--quiet", "-c", "other"]);
  const otherSource = "export function otherOnly(seed: number) { return seed * 5249 + 31; }\n";
  fs.writeFileSync(path.join(source, "other.ts"), otherSource);
  git(["add", "."]);
  git(["commit", "--quiet", "-m", "An independent catalog"]);
  git(["switch", "--quiet", "main"]);
  const editedEntry = files[0]![1].replace("return refreshBefore(22)", "return refreshAfter(22)");
  fs.writeFileSync(path.join(source, "entry.ts"), editedEntry);
  fs.writeFileSync(path.join(project, "..", "edit.patch"), git(["diff", "--", "src/entry.ts"]));
  git(["restore", "--", "src/entry.ts"]);

  const callFixtures = path.join(BENCH_DIR, "../tests/fixtures/call-graph");
  const cpp = fs.readFileSync(path.join(callFixtures, "cpp-calls.cpp"), "utf8");
  const ts = fs.readFileSync(path.join(callFixtures, "simple-calls.ts"), "utf8");
  const specimens = [
    ["typescript", ["ts", "TSX"], "function test() { fixtureTarget(); }", "fixtureTarget"],
    ["javascript", ["js", "JSX"], "function test() { fixtureTarget(); }", "fixtureTarget"],
    ["python", ["py"], "def test():\n    fixtureTarget()", "fixtureTarget"],
    ["rust", ["rs"], "fn test() { fixtureTarget(); }", "fixtureTarget"],
    ["swift", [], "func test() { fixtureTarget() }", "fixtureTarget"],
    ["go", [], "package fixture\nfunc test() { fixtureTarget() }", "fixtureTarget"],
    ["kotlin", ["kt", "kts"], "fun test() { fixtureTarget() }", "fixtureTarget"],
    ["cpp", ["c++"], "void test() { fixtureTarget(); }", "fixtureTarget"],
    ["metal", [], "void test() { fixtureMetalTarget(); }", "fixtureMetalTarget"],
    ["php", [], "<?php function test() { fixtureTarget(); }", "fixturetarget"],
    ["zig", [], "fn test() void { fixtureTarget(); }", "fixtureTarget"],
    ["gdscript", ["gd"], "func test():\n    fixtureTarget()", "fixtureTarget"],
    ["matlab", ["m"], "function test\nfixtureTarget(42);\nend\n", "fixtureTarget"],
    ["apex", [], "class Test { void test() { fixtureTarget(); } }", "fixturetarget"],
    ["bash", ["sh", "zsh"], "testCall() { fixtureTarget; }", "fixtureTarget"],
    ["c", [], "void test() { fixtureTarget(); }", "fixtureTarget"],
  ] as const;
  const corpus: ExtractionCase[] = specimens.flatMap(([name, aliases, specimen, positive]) => [
    ...[name, ...aliases].map((language) => ({ name: language, source: specimen, language, positive })),
    { name: `${name}-empty`, source: "", language: name, empty: true },
    { name: `${name}-malformed`, source: `} ! ${specimen}( { ]`, language: name },
  ]);
  corpus.push(
    { name: "unsupported", language: "text", source: "fixtureTarget()", empty: true },
    { name: "typescript-fixture", language: "typescript", source: ts, positive: "directCall" },
    { name: "cpp-fixture", language: "cpp", source: cpp, positive: "helper" },
    { name: "metal-after-cpp", language: "metal", source: "void replay() { metalTarget(); }", positive: "metalTarget" },
    { name: "cpp-after-metal", language: "cpp", source: cpp, positive: "helper" },
  );
  for (const language of ["typescript", "javascript", "cpp", "metal"]) {
    const large = Array.from({ length: 350 }, (_, i) => `void test${i}() { fixtureTarget(${i}); }`);
    if (language === "typescript" || language === "javascript") {
      for (let i = 0; i < large.length; i++) large[i] = `function test${i}() { fixtureTarget(${i}); }`;
    }
    corpus.push({ name: `${language}-large`, language, source: large.join("\n"), positive: "fixtureTarget" });
  }
  const corpusBytes = JSON.stringify(corpus);
  fs.writeFileSync(corpusPath, corpusBytes);
  return { source: sha(JSON.stringify({ files, otherSource, editedEntry })), corpus: sha(corpusBytes), fileCount: files.length };
}

function median(values: number[]): number {
  assert(values.length % 2 === 1);
  return [...values].sort((a, b) => a - b)[(values.length - 1) / 2]!;
}

function paired(baseline: number[], comparison: number[]) {
  const changes = baseline.map((value, i) => 100 * (comparison[i]! - value) / value);
  return {
    baselineMedian: median(baseline), comparisonMedian: median(comparison),
    pairedMedianPercent: median(changes), improvedPairs: changes.filter((change) => change < 0).length,
    medianAbsolutePairPercent: median(changes.map(Math.abs)),
    regressedPairsOver5Percent: changes.filter((change) => change > 5).length,
  };
}

const { values } = parseArgs({ options: {
  upstream: { type: "string" }, fork: { type: "string" }, candidate: { type: "string" }, output: { type: "string" },
  self: { type: "boolean" }, smoke: { type: "boolean" }, phase: { type: "string" },
} });
assert(values.upstream && values.fork && values.candidate && values.output,
  "Usage: index-refresh.ts --upstream <path> --fork <path> --candidate <path> --output <report.json> [--self] [--smoke]");
assert(!values.phase || ["reads", "queries", "writes"].includes(values.phase),
  "--phase must be reads, queries, or writes");
assert(!values.self || !values.phase, "The self comparison must cover all scenarios");
const output = path.resolve(values.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
assert(!fs.existsSync(output), `Report already exists: ${output}`);
const work = fs.mkdtempSync(path.join(path.dirname(output), "index-refresh-"));
const home = path.join(work, "home");
fs.mkdirSync(home);
const project = path.join(work, "project");
const index = path.join(work, "index");
const corpus = path.join(work, "calls.json");
const env = {
  PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "Index Refresh",
  GIT_AUTHOR_EMAIL: "benchmark@example.invalid", GIT_COMMITTER_NAME: "Index Refresh",
  GIT_COMMITTER_EMAIL: "benchmark@example.invalid", GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z", LC_ALL: "C", TZ: "UTC",
};
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8" });

function sourcePin(root: string, base: string) {
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  assert.equal(untracked, "", `Commit or stage untracked inputs in ${root}:\n${untracked}`);
  return {
    revision: git(root, ["rev-parse", "HEAD"]).trim(),
    diffSha256: sha(git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, "--"])),
  };
}

const arms = ([
  ["upstream", values.upstream, UPSTREAM], ["candidate", values.candidate, UPSTREAM], ["fork", values.fork, FORK],
] as const).filter(([name]) => name !== "fork" || !values.self).map(([name, checkout, expected]) => {
  const root = fs.realpathSync(checkout);
  const { revision, diffSha256 } = sourcePin(root, expected);
  const allowCandidateChanges = name === "candidate" && !values.self;
  if (allowCandidateChanges) {
    assert.equal(git(root, ["merge-base", expected, revision]).trim(), expected,
      `Candidate must descend from pinned upstream ${expected}`);
  } else {
    assert.equal(revision, expected, `${name} Git revision`);
  }
  // Hash changes from the pin, including optimizations already committed to the candidate.
  if (!allowCandidateChanges) assert.equal(diffSha256, sha(""), `${name} must be clean`);
  return {
    name, root, base: expected, revision, diffSha256,
    packageLockSha256: sha(fs.readFileSync(path.join(root, "package-lock.json"))),
    cargoLockSha256: sha(fs.readFileSync(path.join(root, "native/Cargo.lock"))),
  };
});
assert.equal(new Set(arms.map(({ root }) => root)).size, arms.length, "Each arm must have its own checkout");
const fixtureEvidence = fixture(project, corpus, (args) => git(project, args));
const serverFile = path.join(arms[0]!.root, "scripts/eval-mock-embeddings-server.mjs");
const mockServer = { path: serverFile, sha256: sha(fs.readFileSync(serverFile)), dimensions: 8 };
const server = spawn(process.execPath, [serverFile], {
  env: { ...env, EVAL_EMBED_PORT: "0", EVAL_EMBED_DIMS: "8" }, stdio: ["ignore", "pipe", "inherit"],
});
const ready = Promise.withResolvers<string>();
server.once("error", ready.reject);
server.once("exit", (code) => ready.reject(new Error(`Mock embedding server exited ${code}`)));
const lines = createInterface({ input: server.stdout });
lines.on("line", (line) => {
  const match = line.match(/^\[eval-mock-embeddings\] listening on (http:\/\/127\.0\.0\.1:\d+\/v1)\/embeddings$/);
  if (match) ready.resolve(match[1]!);
});
const readyTimeout = setTimeout(() => ready.reject(new Error("Mock embedding server did not start")), 10_000);
type Arm = typeof arms[number];

try {
  const endpoint = await ready.promise.finally(() => clearTimeout(readyTimeout));
  const health = await fetch(`${new URL(endpoint).origin}/health`);
  assert(health.ok && (await health.json() as { ok: boolean }).ok);
  const bins = new Map<string, Pin>();
  const configs = new Map<string, unknown>();
  const seedCatalogs = new Map<string, Membership[]>();
  const seedEvidence: Record<string, unknown> = {};
  const oracles: Record<string, unknown> = {};
  const warmups: Record<string, Sample> = {};
  const samples: Record<string, Record<string, Sample[]>> = {};
  const counterexamples: Record<string, unknown> = {};
  const trials = values.smoke ? 1 : 9;

  function run(arm: Arm, mode: Mode, scenario: Scenario, snapshot = arm.name): WorkerResult {
    git(project, ["restore", "--worktree", "--", "."]);
    git(project, ["switch", "--quiet", "main"]);
    fs.rmSync(index, { recursive: true, force: true });
    if (scenario !== "seed" && scenario !== "full" && scenario !== "extract") {
      fs.cpSync(path.join(work, `${snapshot}-${mode}`), index, { recursive: true, verbatimSymlinks: true });
    }
    if (scenario === "edit") git(project, ["apply", path.join(work, "edit.patch")]);
    const job: Job = { root: arm.root, project, index, mode, scenario, endpoint, corpus };
    const child = spawnSync(process.execPath, ["--import", "tsx", WORKER, JSON.stringify(job)], {
      cwd: path.dirname(BENCH_DIR), env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000,
    });
    if (child.error || child.status !== 0) {
      throw new Error(`${arm.name}/${mode}/${scenario}: ${child.error ?? child.status}\n${child.stderr || child.stdout}`);
    }
    const line = child.stdout.trim().split("\n").findLast((text) => text.startsWith("{"));
    assert(line, `${arm.name}/${mode}/${scenario}: no worker receipt`);
    const result = JSON.parse(line) as WorkerResult;
    assert.equal(result.mode, mode);
    assert.equal(result.scenario, scenario);
    assert(result.peakRssBytes > 0 && Object.values(result.timings).every((ms) => Number.isFinite(ms) && ms > 0));
    assert.deepEqual(result.provenance.worker, { path: WORKER, sha256: workerSha256 });
    assert.equal(result.provenance.indexer.path, path.join(arm.root, "src/indexer/index.ts"));
    assert.equal(result.provenance.indexer.sha256, sha(fs.readFileSync(result.provenance.indexer.path)));
    const binary = result.provenance.binary;
    assert.equal(path.dirname(binary.path), path.join(arm.root, "native"));
    if (!bins.has(arm.name)) assert.equal(binary.sha256, sha(fs.readFileSync(binary.path)));
    else assert.deepEqual(binary, bins.get(arm.name));
    bins.set(arm.name, binary);
    configs.set(`${arm.name}/${mode}`, result.config);
    return result;
  }

  function memberships(result: WorkerResult): Membership[] {
    const evidence = result.evidence as { memberships: { branches: Membership[] } };
    assert(Array.isArray(evidence.memberships?.branches), "Missing catalog membership receipt");
    return evidence.memberships.branches;
  }

  function seed(arm: Arm, mode: Mode): void {
    const key = `${arm.name}/${mode}`;
    const result = run(arm, mode, "seed");
    const catalogs = memberships(result);
    for (const branch of ["main", "other"]) assert(catalogs.some((catalog) =>
      catalog.branch === branch && catalog.chunks.length > 0 && catalog.symbols.length > 0));
    seedCatalogs.set(key, catalogs);
    seedEvidence[key] = { ...result, evidence: canonical(result.evidence) };
    fs.cpSync(index, path.join(work, `${arm.name}-${mode}`), { recursive: true, verbatimSymlinks: true });
    const baseline = seedEvidence[`upstream/${mode}`] as WorkerResult;
    if (arm.name === "candidate") {
      assert.deepEqual(differences(baseline.evidence, canonical(result.evidence)), [], `Initial ${mode} oracle`);
    }
  }

  for (const mode of MODES) seed(arms[0]!, mode);
  const compatibility: Record<string, unknown> = {};
  for (const mode of MODES) {
    const result = run(arms[1]!, mode, "compatibility", "upstream");
    assert.deepEqual(memberships(result).find(({ branch }) => branch === "other"),
      seedCatalogs.get(`upstream/${mode}`)?.find(({ branch }) => branch === "other"));
    compatibility[mode] = { ...result, evidence: canonical(result.evidence) };
  }
  for (const mode of MODES) for (const arm of arms.slice(1)) seed(arm, mode);

  const jobs: { mode: Mode; scenario: Scenario }[] = MODES.flatMap((mode) => SCENARIOS
    .filter((scenario) => scenario !== "database" || !values.phase || values.phase === "reads")
    .map((scenario) => ({ mode, scenario })));
  if (!values.phase || values.phase === "queries") jobs.push({ mode: "structural", scenario: "extract" });
  for (const { mode, scenario } of jobs) {
    const key = `${mode}/${scenario}`;
    process.stderr.write(`Measuring ${key}\n`);
    const perArm: Record<string, Sample[]> = {};
    samples[key] = perArm;
    for (const arm of arms) perArm[arm.name] = [];
    for (let trial = -1; trial < trials; trial++) {
      // Warm up once, then rotate the order for each paired observation.
      const order = trial < 0 ? arms : [...arms.slice(trial % arms.length), ...arms.slice(0, trial % arms.length)];
      for (const arm of order) {
        const { evidence, ...result } = run(arm, mode, scenario);
        const sorted = canonical(evidence);
        if (trial === -1 && arm.name === "upstream") oracles[key] = sorted;
        const mismatch = differences(oracles[key], sorted);
        const seed = seedCatalogs.get(`${arm.name}/${mode}`);
        if (scenario !== "full" && scenario !== "extract" &&
            differences(seedCatalogs.get(`upstream/${mode}`), seed).length > 0) {
          mismatch.push("$.initialMemberships");
        }
        if (scenario === "noop" || scenario === "edit") {
          const actual = memberships({ ...result, evidence });
          if (differences(actual.find(({ branch }) => branch === "other"), seed?.find(({ branch }) => branch === "other")).length > 0) {
            mismatch.push("$.inactiveBranchChanged");
          }
          if (scenario === "noop" && differences(actual, seed).length > 0) mismatch.push("$.noOpMembershipChanged");
        }
        if (arm.name !== "fork") assert.deepEqual(mismatch, [], `${key}/${arm.name}/trial ${trial}`);
        else if (mismatch.length > 0) counterexamples[key] ??= sorted;
        const record = { ...result, evidenceDigest: sha(JSON.stringify(sorted)), parity: mismatch.length === 0, differences: mismatch };
        if (trial < 0) warmups[`${key}/${arm.name}`] = record;
        else perArm[arm.name]!.push(record);
      }
    }
  }

  for (const mode of MODES) {
    const proof = compatibility[mode] as WorkerResult;
    const evidence = proof.evidence as { before: unknown; observed: unknown; action: unknown; memberships: unknown };
    const status = oracles[`${mode}/status`] as { observed: unknown };
    const edit = oracles[`${mode}/edit`] as typeof evidence;
    assert.deepEqual(evidence.before, status.observed, `${mode} upstream-catalog read parity`);
    for (const field of ["observed", "action", "memberships"] as const) {
      assert.deepEqual(evidence[field], edit[field], `${mode} upstream-catalog normal refresh parity: ${field}`);
    }
  }

  const comparisons: Record<string, unknown> = {};
  for (const [key, perArm] of Object.entries(samples)) {
    const compare = (baseline: string) => {
      const before = perArm[baseline]!;
      const after = perArm.candidate!;
      if (!before.every(({ parity }) => parity) || !after.every(({ parity }) => parity) ||
          !warmups[`${key}/${baseline}`]!.parity) return { comparable: false };
      const metrics = Object.keys(before[0]!.timings);
      assert.deepEqual(Object.keys(after[0]!.timings), metrics);
      return {
        comparable: true,
        timings: Object.fromEntries(metrics.map((metric) => [metric,
          paired(before.map(({ timings }) => timings[metric]!), after.map(({ timings }) => timings[metric]!))])),
        rss: paired(before.map(({ peakRssBytes }) => peakRssBytes), after.map(({ peakRssBytes }) => peakRssBytes)),
      };
    };
    comparisons[key] = { upstream: compare("upstream"), ...(values.self ? {} : { fork: compare("fork") }) };
  }

  const report = {
    smoke: !!values.smoke, selfComparison: !!values.self, trials, fixture: fixtureEvidence,
    phase: values.phase ?? "all",
    fixtureProjectPath: project, worker: { path: WORKER, sha256: workerSha256 },
    driver: { path: driverPath, sha256: driverSha256 },
    mockServer,
    measurementHost: {
      node: process.version, nodePath: process.execPath, npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
      rust: execFileSync("rustc", ["-vV"], { encoding: "utf8" }).trim(),
      cargo: execFileSync("cargo", ["--version"], { encoding: "utf8" }).trim(),
      os: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
      rustflagsInMeasurementEnvironment: process.env.RUSTFLAGS ?? "",
    },
    // The native files were built before this run. Their hashes identify the
    // measured artifacts; host environment values are not build attestations.
    nativeBuild: "prebuilt; use npm ci && npm run build per checkout with matching toolchain and flags",
    arms, binaries: Object.fromEntries(bins), configs: Object.fromEntries(configs), seedEvidence,
    compatibility, oracles, warmups, samples, comparisons, counterexamples,
  };
  assert.equal(sha(fs.readFileSync(driverPath)), driverSha256, "Driver changed during measurement");
  assert.equal(sha(fs.readFileSync(WORKER)), workerSha256, "Worker changed during measurement");
  assert.equal(sha(fs.readFileSync(serverFile)), mockServer.sha256, "Mock server changed during measurement");
  for (const { name, root, base, revision, diffSha256 } of arms) {
    assert.deepEqual(sourcePin(root, base), { revision, diffSha256 }, `${name} source changed during measurement`);
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(output);
} finally {
  lines.close();
  server.kill();
  // Keep the isolated fixture and snapshots with the evidence for follow-up compatibility checks.
}
