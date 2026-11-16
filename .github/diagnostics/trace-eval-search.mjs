// Manual CI diagnostic only. Serialize the explicit metadata allowlist below;
// never serialize source text, whole result objects, config, environment, or indexes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fs.realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const configuredOutput = process.env.OCBI_EVAL_SEARCH_TRACE_DIR;
if (!configuredOutput || !path.isAbsolute(configuredOutput)) {
  throw new Error("OCBI_EVAL_SEARCH_TRACE_DIR must be an absolute artifact directory");
}
fs.mkdirSync(configuredOutput, { recursive: true });
const outputDir = fs.realpathSync(configuredOutput);
const relativeOutput = path.relative(projectRoot, outputDir);
if (relativeOutput === "" || (!relativeOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeOutput))) {
  throw new Error("Evaluation traces must be outside the indexed project");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
}

const trackedFiles = new Set(execFileSync("git", ["ls-files", "-z"], {
  cwd: projectRoot, encoding: "utf8",
}).split("\0").filter(Boolean));

function publicPath(file) {
  const absolute = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute);
  if (!trackedFiles.has(relative) || !trackedFiles.has(path.relative(projectRoot, fs.realpathSync(absolute)))) {
    throw new Error("Refusing to publish metadata for an untracked or external file");
  }
  return relative;
}

function candidateMetadata(row) {
  assert.equal(typeof row.filePath, "string");
  assert.equal(typeof row.chunkType, "string");
  assert.ok(row.name === undefined || typeof row.name === "string");
  assert.ok(Number.isInteger(row.startLine) && row.startLine > 0);
  assert.ok(Number.isInteger(row.endLine) && row.endLine >= row.startLine);
  assert.ok(Number.isFinite(row.score));
  if (row.id !== undefined && !/^chunk_[0-9a-f]{16}$/u.test(row.id)) {
    throw new Error("Unexpected candidate identifier in diagnostic metadata");
  }
  return {
    ...(row.id === undefined ? {} : { id: row.id }),
    filePath: publicPath(row.filePath),
    startLine: row.startLine,
    endLine: row.endLine,
    ...(row.name === undefined ? {} : { name: row.name }),
    chunkType: row.chunkType,
    score: row.score,
  };
}

const datasetPath = path.join(projectRoot, "benchmarks/golden/pre-edit-context.json");
const datasetBytes = fs.readFileSync(datasetPath);
const target = JSON.parse(datasetBytes).queries.find((row) => row.id === "edit-context-unresolved-fallback");
assert.ok(target, "The diagnostic query must exist in the checked-in public dataset");
const indexerSpecifier = new URL("../../src/indexer/index.ts", import.meta.url).href;
const executedIndexerPath = fileURLToPath(import.meta.resolve(indexerSpecifier));
assert.equal(executedIndexerPath, path.join(projectRoot, "src/indexer/index.ts"));
const { Indexer } = await import(indexerSpecifier);
const native = process.report.getReport().sharedObjects
  .filter((file) => path.basename(file).startsWith("codebase-index-native.") && file.endsWith(".node"))
  .map((file) => ({ file: path.basename(file), sha256: digest(fs.readFileSync(file)) }));
assert.ok(native.length > 0, "The loaded native module must be identified");
let cpuFlags = null;
if (process.platform === "linux") {
  const cpuInfo = JSON.parse(execFileSync("lscpu", ["--json"], { encoding: "utf8" }));
  cpuFlags = cpuInfo.lscpu.find((entry) => entry.field === "Flags:")?.data ?? null;
}
writeJson("runtime.json", {
  schemaVersion: 1,
  checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
  observerSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
  indexerSha256: digest(fs.readFileSync(executedIndexerPath)),
  datasetSha256: digest(datasetBytes),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
  availableParallelism: os.availableParallelism(),
  cpuFlags,
  native,
});

const stages = ["semanticCandidates", "keywordCandidates", "hybridCandidates",
  "postExternalRerankCandidates", "tieredCandidates", "finalCandidates"];
const originalSearch = Indexer.prototype.search;
let captured = false;
Indexer.prototype.search = async function (query, limit, options) {
  if (query !== target.query || captured) return originalSearch.call(this, query, limit, options);
  captured = true;
  let trace;
  const results = await originalSearch.call(this, query, limit, {
    ...options,
    trace: (value) => {
      trace = value;
      options?.trace?.(value);
    },
  });
  assert.ok(trace, "The requested search did not emit candidate traces");
  const files = await this.getIndexedFilePathsForActiveBranch();
  const inputs = files.map((file) => {
    const relative = publicPath(file);
    return { filePath: relative, sha256: digest(fs.readFileSync(path.join(projectRoot, relative))) };
  }).sort((left, right) => left.filePath.localeCompare(right.filePath));
  writeJson("inputs.json", { files: inputs, sha256: digest(JSON.stringify(inputs)) });
  writeJson("search.json", {
    schemaVersion: 1,
    queryId: target.id,
    querySha256: digest(query),
    requestedLimit: limit ?? null,
    stages: Object.fromEntries(stages.map((stage) => [stage, trace[stage].map(candidateMetadata)])),
    results: results.map(candidateMetadata),
  });
  return results;
};
