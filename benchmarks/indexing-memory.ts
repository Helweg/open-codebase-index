import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type BenchmarkMode = "unbounded" | "bounded";

interface WorkerResult {
  mode: BenchmarkMode;
  digest: string;
  requestDigest: string;
  files: number;
  chunks: number;
  sourceBytes: number;
  peakRssBytes: number;
  durationMs: number;
}

const benchmarkDir = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(benchmarkDir, "fixtures", "indexing-memory-worker.ts");
const fixturePath = path.join(benchmarkDir, "fixtures", "indexing-memory.json");

function run(mode: BenchmarkMode): WorkerResult {
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", workerPath, mode, fixturePath],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(`${mode} benchmark failed (${child.status}):\n${child.stderr || child.stdout}`);
  }
  const line = child.stdout.trim().split("\n").findLast((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error(`${mode} benchmark emitted no result:\n${child.stdout}`);
  }
  return JSON.parse(line) as WorkerResult;
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

const unbounded = run("unbounded");
const bounded = run("bounded");
if (unbounded.digest !== bounded.digest) {
  throw new Error(`Deterministic output mismatch: ${unbounded.digest} != ${bounded.digest}`);
}
const reduction = ((unbounded.peakRssBytes - bounded.peakRssBytes) / unbounded.peakRssBytes) * 100;
console.log(
  `Indexing memory fixture: ${bounded.files} files, ${bounded.chunks} chunks, ${mib(bounded.sourceBytes)} MiB source`,
);
console.log(`Stable output digest: ${bounded.digest}`);
console.log(`Request digests: unbounded ${unbounded.requestDigest}, bounded ${bounded.requestDigest}`);
console.log("| Mode | Peak RSS | Duration |");
console.log("|---|---:|---:|");
for (const result of [unbounded, bounded]) {
  console.log(`| ${result.mode} | ${mib(result.peakRssBytes)} MiB | ${result.durationMs.toFixed(0)} ms |`);
}
console.log(`Peak RSS reduction: ${reduction.toFixed(1)}%`);
