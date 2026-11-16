// CI-only observer: .github is excluded from the evaluated corpus. Artifacts
// contain query text, repository paths, and indexed source; use only controlled inputs.
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

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
}

const indexerSpecifier = new URL("../../src/indexer/index.ts", import.meta.url).href;
const executedIndexerPath = fileURLToPath(import.meta.resolve(indexerSpecifier));
const pinnedIndexerPath = path.join(projectRoot, "src/indexer/index.ts");
assert.equal(executedIndexerPath, pinnedIndexerPath);
assert.equal(sha256(executedIndexerPath), sha256(pinnedIndexerPath));
const { Indexer } = await import(indexerSpecifier);
const loadedNative = process.report.getReport().sharedObjects
  .filter((file) => path.basename(file).startsWith("codebase-index-native.") && file.endsWith(".node"))
  .map((file) => ({ file, sha256: sha256(file) }));
assert.ok(loadedNative.length > 0, "The executed native module must be identified");
writeJson("runtime.json", {
  schemaVersion: 1,
  checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
  node: process.version,
  versions: process.versions,
  platform: process.platform,
  arch: process.arch,
  cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
  availableParallelism: os.availableParallelism(),
  linuxCpuInfo: process.platform === "linux"
    ? JSON.parse(execFileSync("lscpu", ["--json"], { encoding: "utf8" }))
    : null,
  observer: { file: fileURLToPath(import.meta.url), sha256: sha256(fileURLToPath(import.meta.url)) },
  indexer: { specifier: indexerSpecifier, resolvedPath: executedIndexerPath, sha256: sha256(executedIndexerPath) },
  loadedNative,
});

const indexInputs = new WeakMap();
let indexSequence = 0;
let searchSequence = 0;

async function captureIndexInputs(indexer) {
  if (indexInputs.has(indexer)) return;
  const status = await indexer.getStatus();
  const files = await indexer.getIndexedFilePathsForActiveBranch();
  const id = String(++indexSequence).padStart(3, "0");
  const inputs = files.map((file) => {
    const absolutePath = path.resolve(projectRoot, file);
    return { file: path.relative(projectRoot, absolutePath), sha256: sha256(absolutePath) };
  }).sort((left, right) => left.file.localeCompare(right.file));
  writeJson(`index-${id}-inputs.json`, {
    id,
    indexPath: status.indexPath,
    currentBranch: status.currentBranch,
    files: inputs,
  });
  indexInputs.set(indexer, { id, indexPath: status.indexPath });
}

const originalSearch = Indexer.prototype.search;
Indexer.prototype.search = async function (query, limit, options) {
  const id = String(++searchSequence).padStart(4, "0");
  let trace;
  let results;
  try {
    results = await originalSearch.call(this, query, limit, {
      ...options,
      trace: (value) => {
        trace = value;
        options?.trace?.(value);
      },
    });
  } catch (error) {
    writeJson(`search-${id}.json`, {
      query, requestedLimit: limit ?? null, status: "failed", trace: trace ?? null,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
  await captureIndexInputs(this);
  writeJson(`search-${id}.json`, {
    query,
    requestedLimit: limit ?? null,
    status: "completed",
    indexId: indexInputs.get(this).id,
    trace: trace ?? null,
    results: results.map(({ filePath, startLine, endLine, name, chunkType, score }) => ({
      filePath, startLine, endLine, name, chunkType, score,
    })),
  });
  return results;
};

const originalClose = Indexer.prototype.close;
Indexer.prototype.close = async function (...args) {
  const captured = indexInputs.get(this);
  await originalClose.apply(this, args);
  if (!captured) return;
  indexInputs.delete(this);
  // Copy only after SQLite closes, so its checkpointed database is self-contained.
  const directory = path.join(outputDir, `index-${captured.id}`);
  fs.mkdirSync(directory);
  const files = ["codebase.db", "vectors", "vectors.meta.json", "inverted-index.json"].map((name) => {
    const target = path.join(directory, name);
    fs.copyFileSync(path.join(captured.indexPath, name), target, fs.constants.COPYFILE_EXCL);
    return { file: name, bytes: fs.statSync(target).size, sha256: sha256(target) };
  });
  writeJson(`index-${captured.id}-artifacts.json`, { files });
};
