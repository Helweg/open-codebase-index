#!/usr/bin/env node

import { execFile } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { promisify } from "util";
import { fileURLToPath } from "url";

import { createIsolatedSourceCopy, parseCodeGraphOutput, type CodeGraphResult } from "./codegraph-baseline.js";
import { buildPerQueryResult, computeEvalMetrics } from "../src/eval/metrics.js";
import { runEvaluation } from "../src/eval/runner.js";
import { parseGoldenDataset } from "../src/eval/schema.js";
import { isDocumentationPath, isFixturePath, isTestPath } from "../src/indexer/intent-aware-ranking.js";
import type {
  EvalMetrics,
  EvalRunOptions,
  GoldenDataset,
  GoldenQuery,
  GoldenQueryType,
  PerQueryEvalResult,
} from "../src/eval/types.js";
import { parseFiles, type CodeChunk, type FileInput, type ParsedFile } from "../src/native/index.js";

const execFileAsync = promisify(execFile);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cs",
  ".rb",
  ".sh",
  ".bash",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
]);

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "tmp",
  "temp",
]);

const CODEGRAPH_UNSUPPORTED_DEFINITION_PATHS = [".github/workflows/"];

const CODEGRAPH_SOURCE_EXCLUDED_PATHS = [isTestPath, isFixturePath, isDocumentationPath];

export const MAX_FILE_SIZE_BYTES = 1_000_000;
const MAX_PARSE_FILES = 2500;
const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph@1.5.0";
const MAX_CHUNKS_PER_FILE = 100;

export interface CliOptions {
  repos: string[];
  outputRoot: string;
  reindex: boolean;
  repeats: number;
  maxParseFiles: number;
  persistDatasets: boolean;
  skipRipgrep: boolean;
  skipSg: boolean;
  codegraph: boolean;
}

interface FileCollectionResult {
  files: string[];
  truncated: boolean;
  maxParseFiles: number;
}

interface SymbolCandidate {
  filePath: string;
  symbol: string;
  chunkType: "function" | "class";
  content: string;
}

type CanonicalChunkType = "function" | "class" | undefined;

export interface CodeGraphRepeatSummary {
  repeat: number;
  status: "completed" | "disqualified" | "no-scope";
  artifactPath: string;
  scopedQueryCount: number;
  totalQueryCount: number;
  queryIds: string[];
  pluginMetrics?: EvalMetrics;
  codeGraphMetrics?: EvalMetrics;
  error?: string;
}

export interface ControlledEvalConfigArtifact {
  indexing: {
    maxFileSize: number;
    maxChunksPerFile: number;
  };
}

export interface RepoBenchmarkResult {
  repoName: string;
  repoPath: string;
  datasetPath: string;
  datasetQueryCount: number;
  fileSampling: {
    parsedFileCount: number;
    truncated: boolean;
    maxParseFiles: number;
    fileSizeLimitBytes: number;
  };
  plugin: {
    outputDir: string;
    summaryPath: string;
    perQueryPath: string;
    metrics: EvalMetrics;
    repeatSummaries: Array<{
      repeat: number;
      outputDir: string;
      summaryPath: string;
      perQueryPath: string;
      metrics: EvalMetrics;
      reindexApplied: boolean;
    }>;
  };
  ripgrep?: {
    metrics: EvalMetrics;
    perQueryCount: number;
    repeatMetrics: EvalMetrics[];
  };
  sg?: {
    metrics: EvalMetrics;
    perQueryCount: number;
    repeatMetrics: EvalMetrics[];
    queryTypeScope: GoldenQueryType[];
    scopedQueryCount: number;
    totalQueryCount: number;
  };
  codegraph?: {
    scopedQueryCount: number;
    totalQueryCount: number;
    successfulRepeatCount: number;
    disqualifiedRepeatCount: number;
    repeatSummaries: CodeGraphRepeatSummary[];
    metrics?: {
      plugin: EvalMetrics;
      codegraph: EvalMetrics;
    };
  };
  error?: string;
}

interface CodeGraphCommandResult {
  stdout: string;
}

export type CodeGraphExecutor = (
  executable: string,
  args: string[]
) => Promise<CodeGraphCommandResult>;

interface CodeGraphQueryArtifact {
  id: string;
  symbol: string;
  command: string[];
  latencyMs?: number;
  results?: CodeGraphResult[];
  perQuery?: PerQueryEvalResult;
  error?: string;
}

interface CodeGraphRepeatArtifact {
  repeat: number;
  status: CodeGraphRepeatSummary["status"];
  isolatedRepoPath?: string;
  scope: {
    totalQueryCount: number;
    scopedQueryCount: number;
    queryIds: string[];
  };
  init: {
    command: string[];
    error?: string;
  };
  pluginPerQuery: PerQueryEvalResult[];
  queries: CodeGraphQueryArtifact[];
  comparison?: {
    pluginMetrics: EvalMetrics;
    codeGraphMetrics: EvalMetrics;
  };
  error?: string;
}

interface RipgrepJsonPath {
  text?: string;
}

interface RipgrepJsonData {
  path?: RipgrepJsonPath;
}

interface RipgrepJsonEvent {
  type?: string;
  data?: RipgrepJsonData;
}

function printUsage(): void {
  console.log(`Usage:
npx tsx scripts/cross-repo-benchmark.ts [--repos /path/a,/path/b] [--output benchmarks/results/cross-repo] [--reindex|--no-reindex] [--repeats N] [--max-parse-files N] [--persist-datasets] [--skip-ripgrep] [--skip-sg] [--codegraph]

Defaults:
  repos: none (required via --repos or BENCHMARK_REPOS)
  output: benchmarks/results/cross-repo
  reindex: false
  repeats: 1
  max-parse-files: 2500
  persist-datasets: false
  codegraph: false
`);
}

function expandHome(input: string): string {
  const home = process.env.HOME;
  if (!home) {
    return input;
  }
  if (input === "~") return home;
  if (input.startsWith("~/")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function normalizePathForMatch(input: string): string {
  return input.replace(/\\/g, "/");
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function controlledEvalConfigPath(runDir: string, repoName: string): string {
  return path.join(runDir, "eval-configs", `${repoName}-benchmark.json`);
}

export function writeControlledEvalConfig(configPath: string): string {
  const content = {
    indexing: {
      maxFileSize: MAX_FILE_SIZE_BYTES,
      maxChunksPerFile: MAX_CHUNKS_PER_FILE,
    },
  } satisfies ControlledEvalConfigArtifact;

  ensureDir(path.dirname(configPath));
  writeFileSync(configPath, JSON.stringify(content, null, 2), "utf-8");
  return configPath;
}

export function buildPluginEvalRunOptions(
  params: {
    projectRoot: string;
    datasetPath: string;
    outputRoot: string;
    reindexApplied: boolean;
    configPath: string;
  }
): EvalRunOptions {
  return {
    projectRoot: params.projectRoot,
    datasetPath: params.datasetPath,
    outputRoot: params.outputRoot,
    ciMode: false,
    reindex: params.reindexApplied,
    configPath: params.configPath,
  };
}

function timestampForDir(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function toRepoName(repoPath: string): string {
  return path.basename(repoPath.replace(/[\\/]+$/, ""));
}

export function parseCliArgs(argv: string[]): CliOptions {
  let repos: string[] = [];
  let outputRoot = path.resolve(process.cwd(), "benchmarks/results/cross-repo");
  let reindex = false;
  let repeats = 1;
  let maxParseFiles = MAX_PARSE_FILES;
  let persistDatasets = false;
  let skipRipgrep = false;
  let skipSg = false;
  let codegraph = false;

  const envRepos = process.env.BENCHMARK_REPOS;
  if (envRepos && envRepos.trim().length > 0) {
    repos = envRepos
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => path.resolve(expandHome(item)));
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--repos") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--repos requires a comma-separated value");
      }
      repos = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .map((item) => path.resolve(expandHome(item)));
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--output requires a path");
      }
      outputRoot = path.resolve(expandHome(value));
      i += 1;
      continue;
    }

    if (arg === "--reindex") {
      reindex = true;
      continue;
    }

    if (arg === "--no-reindex") {
      reindex = false;
      continue;
    }

    if (arg === "--skip-ripgrep") {
      skipRipgrep = true;
      continue;
    }

    if (arg === "--repeats") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--repeats requires an integer value");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--repeats must be an integer >= 1");
      }
      repeats = parsed;
      i += 1;
      continue;
    }

    if (arg === "--max-parse-files") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-parse-files requires an integer value");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--max-parse-files must be an integer >= 1");
      }
      maxParseFiles = parsed;
      i += 1;
      continue;
    }

    if (arg === "--persist-datasets") {
      persistDatasets = true;
      continue;
    }

    if (arg === "--skip-sg") {
      skipSg = true;
      continue;
    }

    if (arg === "--codegraph") {
      codegraph = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (repos.length === 0) {
    throw new Error("No repositories configured. Pass --repos /path/a,/path/b or set BENCHMARK_REPOS");
  }

  return {
    repos,
    outputRoot,
    reindex,
    repeats,
    maxParseFiles,
    persistDatasets,
    skipRipgrep,
    skipSg,
    codegraph,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function medianMetrics(metricsList: EvalMetrics[]): EvalMetrics {
  if (metricsList.length === 0) {
    return averageMetrics([]);
  }

  return {
    hitAt1: median(metricsList.map((item) => item.hitAt1)),
    hitAt3: median(metricsList.map((item) => item.hitAt3)),
    hitAt5: median(metricsList.map((item) => item.hitAt5)),
    hitAt10: median(metricsList.map((item) => item.hitAt10)),
    mrrAt10: median(metricsList.map((item) => item.mrrAt10)),
    ndcgAt10: median(metricsList.map((item) => item.ndcgAt10)),
    latencyMs: {
      p50: median(metricsList.map((item) => item.latencyMs.p50)),
      p95: median(metricsList.map((item) => item.latencyMs.p95)),
      p99: median(metricsList.map((item) => item.latencyMs.p99)),
    },
    tokenEstimate: {
      queryTokens: Math.round(median(metricsList.map((item) => item.tokenEstimate.queryTokens))),
      embeddingTokensUsed: Math.round(
        median(metricsList.map((item) => item.tokenEstimate.embeddingTokensUsed))
      ),
    },
    embedding: {
      callCount: Math.round(median(metricsList.map((item) => item.embedding.callCount))),
      estimatedCostUsd: median(metricsList.map((item) => item.embedding.estimatedCostUsd)),
      costPer1MTokensUsd: median(metricsList.map((item) => item.embedding.costPer1MTokensUsd)),
    },
    failureBuckets: {
      "wrong-file": Math.round(median(metricsList.map((item) => item.failureBuckets["wrong-file"]))),
      "wrong-symbol": Math.round(
        median(metricsList.map((item) => item.failureBuckets["wrong-symbol"]))
      ),
      "docs-tests-outranking-source": Math.round(
        median(metricsList.map((item) => item.failureBuckets["docs-tests-outranking-source"]))
      ),
      "no-relevant-hit-top-k": Math.round(
        median(metricsList.map((item) => item.failureBuckets["no-relevant-hit-top-k"]))
      ),
    },
  };
}

function collectSourceFiles(repoPath: string, maxParseFiles: number): FileCollectionResult {
  const files: string[] = [];
  const stack: string[] = [repoPath];
  let truncated = false;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (entry.name.endsWith(".min.js") || entry.name.endsWith(".min.css")) continue;

      const stat = readFileSync(absolutePath, { encoding: "utf-8", flag: "r" });
      if (Buffer.byteLength(stat, "utf-8") > MAX_FILE_SIZE_BYTES) continue;

      files.push(absolutePath);
      if (files.length >= maxParseFiles) {
        truncated = true;
        return { files, truncated, maxParseFiles };
      }
    }
  }

  return { files, truncated, maxParseFiles };
}

function extractNamedExports(content: string): Set<string> {
  const names = new Set<string>();

  const directRegexes = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /export\s+(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /export\s+(?:const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
  ];

  for (const regex of directRegexes) {
    for (const match of content.matchAll(regex)) {
      const candidate = match[1];
      if (candidate) names.add(candidate);
    }
  }

  for (const blockMatch of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    const inside = blockMatch[1];
    const entries = inside.split(",").map((part) => part.trim());
    for (const entry of entries) {
      if (!entry) continue;
      const asParts = entry.split(/\s+as\s+/i).map((part) => part.trim());
      const exported = asParts.length === 2 ? asParts[1] : asParts[0];
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported)) {
        names.add(exported);
      }
    }
  }

  return names;
}

function getCanonicalChunkType(chunkType: string): CanonicalChunkType {
  const lowered = chunkType.toLowerCase();
  if (
    lowered.includes("function") ||
    lowered === "method" ||
    lowered.includes("arrow") ||
    lowered.includes("callable")
  ) {
    return "function";
  }

  if (lowered.includes("class")) {
    return "class";
  }

  return undefined;
}

function isCodeGraphUnsupportedDefinitionPath(filePath: string): boolean {
  const normalizedPath = normalizePathForMatch(filePath).toLowerCase();
  return CODEGRAPH_UNSUPPORTED_DEFINITION_PATHS.some((unsupportedPrefix) =>
    normalizedPath === unsupportedPrefix.slice(0, -1)
    || normalizedPath.startsWith(unsupportedPrefix)
  );
}

function isCodeGraphSourceExcludedDefinitionPath(filePath: string): boolean {
  const normalizedPath = normalizePathForMatch(filePath).toLowerCase();
  return CODEGRAPH_SOURCE_EXCLUDED_PATHS.some((predicate) => predicate(normalizedPath));
}

function isFunctionOrClass(chunk: CodeChunk): chunk is CodeChunk & { name: string } {
  if (!chunk.name) return false;
  return getCanonicalChunkType(chunk.chunkType) !== undefined;
}

function buildSymbolCandidates(parsedFiles: ParsedFile[], repoPath: string): SymbolCandidate[] {
  const candidates: SymbolCandidate[] = [];
  const fallbackCandidates: SymbolCandidate[] = [];

  for (const parsedFile of parsedFiles) {
    const relativePath = normalizePathForMatch(path.relative(repoPath, parsedFile.path));
    const exportedNames = new Set<string>();

    for (const chunk of parsedFile.chunks) {
      if (chunk.chunkType === "export") {
        const names = extractNamedExports(chunk.content);
        for (const name of names) exportedNames.add(name);
      }
    }

    for (const chunk of parsedFile.chunks) {
      if (!isFunctionOrClass(chunk)) continue;

      const canonicalType = getCanonicalChunkType(chunk.chunkType);
      if (!canonicalType) continue;

      const candidate: SymbolCandidate = {
        filePath: relativePath,
        symbol: chunk.name,
        chunkType: canonicalType,
        content: chunk.content,
      };

      const looksExported =
        exportedNames.has(chunk.name) ||
        /(^|\n)\s*export\s+/m.test(chunk.content) ||
        /module\.exports|exports\./.test(chunk.content);

      if (looksExported) {
        candidates.push(candidate);
      } else {
        fallbackCandidates.push(candidate);
      }
    }
  }

  const unique = new Map<string, SymbolCandidate>();
  const merged = [...candidates, ...fallbackCandidates];

  for (const candidate of merged) {
    const key = `${candidate.filePath}::${candidate.symbol}`;
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }

  return Array.from(unique.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function extractConcept(content: string): string {
  const lowered = content.toLowerCase();
  const concepts = [
    "routing",
    "middleware",
    "request handling",
    "response formatting",
    "error handling",
    "configuration",
    "state management",
    "theme composition",
    "validation",
    "caching",
    "logging",
    "serialization",
    "parsing",
    "build orchestration",
    "runtime compatibility",
  ];

  for (const concept of concepts) {
    const term = concept.split(" ")[0];
    if (lowered.includes(term)) return concept;
  }

  return "core behavior";
}

function extractIdentifiers(content: string): string[] {
  const stopwords = new Set([
    "const",
    "function",
    "class",
    "return",
    "export",
    "import",
    "from",
    "true",
    "false",
    "null",
    "undefined",
    "while",
    "for",
    "await",
    "async",
    "this",
    "that",
    "with",
    "query",
    "where",
    "handle",
    "does",
  ]);

  const counts = new Map<string, number>();
  for (const match of content.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g)) {
    const token = match[0];
    const lowered = token.toLowerCase();
    if (stopwords.has(lowered)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 8);
}

function pickDistinctFiles(candidates: SymbolCandidate[], limit: number): SymbolCandidate[] {
  const picked: SymbolCandidate[] = [];
  const seenFiles = new Set<string>();

  for (const candidate of candidates) {
    if (seenFiles.has(candidate.filePath)) continue;
    picked.push(candidate);
    seenFiles.add(candidate.filePath);
    if (picked.length >= limit) break;
  }

  if (picked.length < limit) {
    for (const candidate of candidates) {
      if (picked.length >= limit) break;
      if (picked.some((item) => item.filePath === candidate.filePath && item.symbol === candidate.symbol)) {
        continue;
      }
      picked.push(candidate);
    }
  }

  return picked;
}

export function buildGoldenDataset(repoName: string, repoPath: string, parsedFiles: ParsedFile[]): GoldenDataset {
  const candidates = buildSymbolCandidates(parsedFiles, repoPath);
  if (candidates.length === 0) {
    throw new Error(`No function/class candidates discovered in ${repoName}`);
  }

  const definitionCandidates = candidates.filter((candidate) =>
    !isCodeGraphUnsupportedDefinitionPath(candidate.filePath) &&
    !isCodeGraphSourceExcludedDefinitionPath(candidate.filePath)
  );
  if (definitionCandidates.length === 0) {
    throw new Error(`No definition candidates outside unsupported CodeGraph source paths in ${repoName}`);
  }

  const implementation = pickDistinctFiles(candidates.slice(3).length > 0 ? candidates.slice(3) : candidates, 3);
  const similarities = pickDistinctFiles(candidates.slice(6).length > 0 ? candidates.slice(6) : candidates, 2);
  const keywordHeavy = pickDistinctFiles(candidates.slice(8).length > 0 ? candidates.slice(8) : candidates, 2);
  const definitions = pickDistinctFiles(definitionCandidates, 3);

  const queries: GoldenQuery[] = [];
  let counter = 1;

  const addQuery = (
    queryType: GoldenQueryType,
    query: string,
    expected: GoldenQuery["expected"],
    options: Pick<GoldenQuery, "retrievalMode" | "args"> = {}
  ): void => {
    queries.push({
      id: `${repoName}-${queryType}-${String(counter).padStart(2, "0")}`,
      query,
      queryType,
      ...options,
      expected,
    });
    counter += 1;
  };

  for (const candidate of definitions) {
    addQuery("definition", `where is ${candidate.symbol} defined`, {
      filePath: candidate.filePath,
      symbol: candidate.symbol,
      expectedRoute: "definition",
    }, {
      retrievalMode: "context",
      args: { symbol: candidate.symbol },
    });
  }

  for (const candidate of implementation) {
    const moduleName = path.basename(candidate.filePath, path.extname(candidate.filePath));
    const concept = extractConcept(candidate.content);
    addQuery("implementation-intent", `how does ${moduleName} handle ${concept}`, {
      acceptableFiles: [candidate.filePath],
    });
  }

  for (const candidate of similarities) {
    const concept = extractConcept(candidate.content);
    addQuery("similarity", `${concept} ${candidate.chunkType} pattern with ${candidate.symbol}`, {
      acceptableFiles: [candidate.filePath],
    });
  }

  for (const candidate of keywordHeavy) {
    const identifiers = extractIdentifiers(candidate.content);
    const terms = [candidate.symbol, ...identifiers].slice(0, 4);
    addQuery("keyword-heavy", terms.join(" "), {
      acceptableFiles: [candidate.filePath],
    });
  }

  const boundedQueries = queries.slice(0, 12);
  if (boundedQueries.length < 8) {
    throw new Error(`Generated only ${boundedQueries.length} queries for ${repoName}; need at least 8`);
  }

  return {
    version: "1.0.0",
    name: `cross-repo-${repoName}`,
    description: `Auto-generated cross-repo benchmark dataset for ${repoName}`,
    queries: boundedQueries,
  };
}

function collectParsedFiles(
  repoPath: string,
  maxParseFiles: number
): { parsedFiles: ParsedFile[]; collection: FileCollectionResult } {
  const collection = collectSourceFiles(repoPath, maxParseFiles);
  const filePaths = collection.files;
  if (filePaths.length === 0) {
    throw new Error(`No source files found for parsing in ${repoPath}`);
  }

  const inputs: FileInput[] = filePaths.map((filePath) => ({
    path: filePath,
    content: readFileSync(filePath, "utf-8"),
  }));

  return { parsedFiles: parseFiles(inputs), collection };
}

function writeDataset(datasetPath: string, dataset: GoldenDataset): void {
  ensureDir(path.dirname(datasetPath));
  parseGoldenDataset(dataset, datasetPath);
  writeFileSync(datasetPath, JSON.stringify(dataset, null, 2), "utf-8");
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRipgrepPattern(query: GoldenQuery): string {
  const terms = new Set<string>();

  if (query.expected.symbol) {
    terms.add(query.expected.symbol);
  }

  for (const part of query.query.split(/\s+/)) {
    const token = part.trim().replace(/[^A-Za-z0-9_$]/g, "");
    if (token.length >= 3) terms.add(token);
    if (terms.size >= 6) break;
  }

  if (terms.size === 0) {
    terms.add(query.query.slice(0, 32));
  }

  return Array.from(terms)
    .slice(0, 6)
    .map((term) => escapeRegexLiteral(term))
    .join("|");
}

function parseRipgrepEvents(stdout: string, repoPath: string): string[] {
  const found = new Set<string>();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = parsed as RipgrepJsonEvent;
    if (event.type !== "match") continue;

    const textPath = event.data?.path?.text;
    if (!textPath) continue;
    const relative = normalizePathForMatch(path.relative(repoPath, textPath));
    if (relative && !relative.startsWith("..")) {
      found.add(relative);
    }
    if (found.size >= 10) {
      break;
    }
  }

  return Array.from(found);
}

function parseSgEvents(stdout: string, repoPath: string): string[] {
  const found = new Set<string>();
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) continue;
    const maybeFile = (parsed as { file?: unknown }).file;
    if (typeof maybeFile !== "string") continue;

    const relative = normalizePathForMatch(path.relative(repoPath, maybeFile));
    if (relative && !relative.startsWith("..")) {
      found.add(relative);
    }
    if (found.size >= 10) {
      break;
    }
  }

  return Array.from(found);
}

async function runRipgrepBaseline(
  repoPath: string,
  dataset: GoldenDataset
): Promise<{ metrics: EvalMetrics; perQuery: PerQueryEvalResult[] }> {
  const perQuery = await Promise.all(
    dataset.queries.map(async (query) => {
    const pattern = buildRipgrepPattern(query);
    const start = performance.now();

    let stdout = "";
    try {
      const result = await execFileAsync("rg", ["--json", "--max-count", "10", "-e", pattern, repoPath], {
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (error: unknown) {
      const maybe = error as { stdout?: string; code?: number };
      if (typeof maybe.stdout === "string") {
        stdout = maybe.stdout;
      }
      if (maybe.code !== 1 && maybe.code !== 0) {
        throw error;
      }
    }

    const elapsed = performance.now() - start;
    const files = parseRipgrepEvents(stdout, repoPath);
    const results = files.map((filePath, index) => ({
      filePath,
      startLine: 0,
      endLine: 0,
      score: 1 / (index + 1),
      chunkType: "other",
      name: undefined,
    }));

      return buildPerQueryResult(query, results, elapsed, 10);
    })
  );

  const metrics = computeEvalMetrics(dataset.queries, perQuery, 0, 0, 0);
  return { metrics, perQuery };
}

async function runSgBaseline(
  repoPath: string,
  dataset: GoldenDataset
): Promise<{
  metrics: EvalMetrics;
  perQuery: PerQueryEvalResult[];
  scopedQueryCount: number;
  totalQueryCount: number;
  queryTypeScope: GoldenQueryType[];
}> {
  const queryTypeScope: GoldenQueryType[] = ["definition", "keyword-heavy"];
  const supportedLanguages = new Map<string, string>([
    [".ts", "typescript"],
    [".tsx", "tsx"],
    [".js", "javascript"],
    [".jsx", "jsx"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
    [".py", "python"],
    [".rs", "rust"],
    [".go", "go"],
    [".java", "java"],
    [".cs", "csharp"],
    [".rb", "ruby"],
    [".sh", "bash"],
    [".bash", "bash"],
    [".c", "c"],
    [".cpp", "cpp"],
    [".h", "c"],
    [".hpp", "cpp"],
    [".json", "json"],
    [".toml", "toml"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
  ]);

  const extractPattern = (query: GoldenQuery): string | undefined => {
    if (query.expected.symbol && /^[A-Za-z_$][A-Za-z0-9_$]{1,}$/.test(query.expected.symbol)) {
      return query.expected.symbol;
    }
    for (const part of query.query.split(/\s+/)) {
      const token = part.trim().replace(/[^A-Za-z0-9_$]/g, "");
      if (/^[A-Za-z_$][A-Za-z0-9_$]{2,}$/.test(token)) {
        return token;
      }
    }
    return undefined;
  };

  const inferLanguage = (query: GoldenQuery): string | undefined => {
    const candidatePath = query.expected.filePath ?? query.expected.acceptableFiles?.[0];
    if (!candidatePath) return undefined;
    const ext = path.extname(candidatePath).toLowerCase();
    return supportedLanguages.get(ext);
  };

  const scopedQueries = dataset.queries.filter((query) => queryTypeScope.includes(query.queryType));

  const perQuery = await Promise.all(
    scopedQueries.map(async (query) => {

      const pattern = extractPattern(query);
      const lang = inferLanguage(query);
      if (!pattern || !lang) {
        return buildPerQueryResult(query, [], 0, 10);
      }

      const start = performance.now();

      let stdout = "";
      try {
        const result = await execFileAsync(
          "sg",
          ["run", "--pattern", pattern, "--lang", lang, "--json=stream", repoPath],
          {
            maxBuffer: 10 * 1024 * 1024,
          }
        );
        stdout = result.stdout;
      } catch (error: unknown) {
        const maybe = error as { stdout?: string; code?: number };
        if (typeof maybe.stdout === "string") {
          stdout = maybe.stdout;
        }
        if (maybe.code !== 1 && maybe.code !== 0) {
          throw error;
        }
      }

      const elapsed = performance.now() - start;
      const files = parseSgEvents(stdout, repoPath);
      const results = files.map((filePath, index) => ({
        filePath,
        startLine: 0,
        endLine: 0,
        score: 1 / (index + 1),
        chunkType: "other",
        name: undefined,
      }));

      return buildPerQueryResult(query, results, elapsed, 10);
    })
  );

  const metrics = computeEvalMetrics(scopedQueries, perQuery, 0, 0, 0);
  return {
    metrics,
    perQuery,
    scopedQueryCount: scopedQueries.length,
    totalQueryCount: dataset.queries.length,
    queryTypeScope,
  };
}

export interface RunCodeGraphRepeatOptions {
  repoPath: string;
  dataset: GoldenDataset;
  pluginPerQuery: PerQueryEvalResult[];
  repeat: number;
  artifactPath: string;
  executor?: CodeGraphExecutor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultCodeGraphExecutor: CodeGraphExecutor = async (executable, args) => {
  const result = await execFileAsync(executable, args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout: result.stdout };
};

export async function runCodeGraphRepeat({
  repoPath,
  dataset,
  pluginPerQuery,
  repeat,
  artifactPath,
  executor = defaultCodeGraphExecutor,
}: RunCodeGraphRepeatOptions): Promise<CodeGraphRepeatSummary> {
  const scopedQueries = dataset.queries.filter(
    (query) => typeof query.expected.symbol === "string" && query.expected.symbol.length > 0
  );
  const queryIds = scopedQueries.map((query) => query.id);
  let scopedPluginPerQuery: PerQueryEvalResult[] = [];
  const artifact: CodeGraphRepeatArtifact = {
    repeat,
    status: "disqualified",
    scope: {
      totalQueryCount: dataset.queries.length,
      scopedQueryCount: scopedQueries.length,
      queryIds,
    },
    init: { command: [] },
    pluginPerQuery: [],
    queries: [],
  };
  let isolated: ReturnType<typeof createIsolatedSourceCopy> | undefined;

  try {
    isolated = createIsolatedSourceCopy(repoPath);
    artifact.isolatedRepoPath = isolated.isolatedRepoPath;
    artifact.init.command = ["npx", "--yes", CODEGRAPH_PACKAGE, "init", isolated.isolatedRepoPath];

    try {
      await executor("npx", artifact.init.command.slice(1));
    } catch (error: unknown) {
      artifact.init.error = errorMessage(error);
      throw new Error(`CodeGraph init invocation failed: ${artifact.init.error}`);
    }

    const pluginById = new Map(pluginPerQuery.map((result) => [result.id, result]));
    scopedPluginPerQuery = scopedQueries.map((query) => {
      const result = pluginById.get(query.id);
      if (!result) {
        throw new Error(`Plugin per-query result missing for CodeGraph-scoped query '${query.id}'`);
      }
      return result;
    });
    artifact.pluginPerQuery = scopedPluginPerQuery;

    if (scopedQueries.length === 0) {
      artifact.status = "no-scope";
    } else {
      const codeGraphPerQuery: PerQueryEvalResult[] = [];
      for (const query of scopedQueries) {
        const symbol = query.expected.symbol;
        if (!symbol) continue;
        const command = [
          "npx",
          "--yes",
          CODEGRAPH_PACKAGE,
          "query",
          symbol,
          "--path",
          isolated.isolatedRepoPath,
          "--limit",
          "10",
          "--json",
        ];
        const queryArtifact: CodeGraphQueryArtifact = { id: query.id, symbol, command };
        artifact.queries.push(queryArtifact);
        const start = performance.now();

        try {
          const output = await executor("npx", command.slice(1));
          queryArtifact.latencyMs = performance.now() - start;
          queryArtifact.results = parseCodeGraphOutput(output.stdout, isolated.isolatedRepoPath);
          queryArtifact.perQuery = buildPerQueryResult(
            query,
            queryArtifact.results.map((result) => ({
              filePath: result.node.filePath,
              startLine: result.node.startLine,
              endLine: result.node.endLine,
              score: result.score,
              chunkType: result.node.kind,
              name: result.node.name,
            })),
            queryArtifact.latencyMs,
            10
          );
          codeGraphPerQuery.push(queryArtifact.perQuery);
        } catch (error: unknown) {
          queryArtifact.error = errorMessage(error);
          throw new Error(`CodeGraph query failed for '${query.id}': ${queryArtifact.error}`);
        }
      }

      const pluginMetrics = computeEvalMetrics(scopedQueries, scopedPluginPerQuery, 0, 0, 0);
      const codeGraphMetrics = computeEvalMetrics(scopedQueries, codeGraphPerQuery, 0, 0, 0);
      artifact.status = "completed";
      artifact.comparison = { pluginMetrics, codeGraphMetrics };
    }
  } catch (error: unknown) {
    artifact.status = "disqualified";
    artifact.error = errorMessage(error);
  } finally {
    isolated?.cleanup();
  }

  ensureDir(path.dirname(artifactPath));
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf-8");

  return {
    repeat,
    status: artifact.status,
    artifactPath,
    scopedQueryCount: scopedQueries.length,
    totalQueryCount: dataset.queries.length,
    queryIds,
    pluginMetrics: artifact.comparison?.pluginMetrics,
    codeGraphMetrics: artifact.comparison?.codeGraphMetrics,
    error: artifact.error,
  };
}

function averageMetrics(metricsList: EvalMetrics[]): EvalMetrics {
  if (metricsList.length === 0) {
    return {
      hitAt1: 0,
      hitAt3: 0,
      hitAt5: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      latencyMs: { p50: 0, p95: 0, p99: 0 },
      tokenEstimate: { queryTokens: 0, embeddingTokensUsed: 0 },
      embedding: { callCount: 0, estimatedCostUsd: 0, costPer1MTokensUsd: 0 },
      failureBuckets: {
        "wrong-file": 0,
        "wrong-symbol": 0,
        "docs-tests-outranking-source": 0,
        "no-relevant-hit-top-k": 0,
      },
    };
  }

  const divisor = metricsList.length;
  const sum = metricsList.reduce(
    (acc, item) => {
      acc.hitAt1 += item.hitAt1;
      acc.hitAt3 += item.hitAt3;
      acc.hitAt5 += item.hitAt5;
      acc.hitAt10 += item.hitAt10;
      acc.mrrAt10 += item.mrrAt10;
      acc.ndcgAt10 += item.ndcgAt10;
      acc.latencyP50 += item.latencyMs.p50;
      acc.latencyP95 += item.latencyMs.p95;
      acc.latencyP99 += item.latencyMs.p99;
      acc.queryTokens += item.tokenEstimate.queryTokens;
      acc.embeddingTokensUsed += item.tokenEstimate.embeddingTokensUsed;
      acc.embeddingCallCount += item.embedding.callCount;
      acc.embeddingCost += item.embedding.estimatedCostUsd;
      acc.failureWrongFile += item.failureBuckets["wrong-file"];
      acc.failureWrongSymbol += item.failureBuckets["wrong-symbol"];
      acc.failureDocsTests += item.failureBuckets["docs-tests-outranking-source"];
      acc.failureNoRelevant += item.failureBuckets["no-relevant-hit-top-k"];
      return acc;
    },
    {
      hitAt1: 0,
      hitAt3: 0,
      hitAt5: 0,
      hitAt10: 0,
      mrrAt10: 0,
      ndcgAt10: 0,
      latencyP50: 0,
      latencyP95: 0,
      latencyP99: 0,
      queryTokens: 0,
      embeddingTokensUsed: 0,
      embeddingCallCount: 0,
      embeddingCost: 0,
      failureWrongFile: 0,
      failureWrongSymbol: 0,
      failureDocsTests: 0,
      failureNoRelevant: 0,
    }
  );

  return {
    hitAt1: sum.hitAt1 / divisor,
    hitAt3: sum.hitAt3 / divisor,
    hitAt5: sum.hitAt5 / divisor,
    hitAt10: sum.hitAt10 / divisor,
    mrrAt10: sum.mrrAt10 / divisor,
    ndcgAt10: sum.ndcgAt10 / divisor,
    latencyMs: {
      p50: sum.latencyP50 / divisor,
      p95: sum.latencyP95 / divisor,
      p99: sum.latencyP99 / divisor,
    },
    tokenEstimate: {
      queryTokens: Math.round(sum.queryTokens / divisor),
      embeddingTokensUsed: Math.round(sum.embeddingTokensUsed / divisor),
    },
    embedding: {
      callCount: Math.round(sum.embeddingCallCount / divisor),
      estimatedCostUsd: sum.embeddingCost / divisor,
      costPer1MTokensUsd: 0,
    },
    failureBuckets: {
      "wrong-file": Math.round(sum.failureWrongFile / divisor),
      "wrong-symbol": Math.round(sum.failureWrongSymbol / divisor),
      "docs-tests-outranking-source": Math.round(sum.failureDocsTests / divisor),
      "no-relevant-hit-top-k": Math.round(sum.failureNoRelevant / divisor),
    },
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function num(value: number): string {
  return value.toFixed(4);
}

function ms(value: number): string {
  return value.toFixed(2);
}

function appendCodeGraphMetricTable(
  lines: string[],
  pluginMetrics: EvalMetrics,
  codeGraphMetrics: EvalMetrics,
  includeLatency = true
): void {
  lines.push("| Metric | Plugin | CodeGraph |");
  lines.push("|---|---:|---:|");
  lines.push(`| Hit@1 | ${pct(pluginMetrics.hitAt1)} | ${pct(codeGraphMetrics.hitAt1)} |`);
  lines.push(`| Hit@3 | ${pct(pluginMetrics.hitAt3)} | ${pct(codeGraphMetrics.hitAt3)} |`);
  lines.push(`| Hit@5 | ${pct(pluginMetrics.hitAt5)} | ${pct(codeGraphMetrics.hitAt5)} |`);
  lines.push(`| Hit@10 | ${pct(pluginMetrics.hitAt10)} | ${pct(codeGraphMetrics.hitAt10)} |`);
  lines.push(`| MRR@10 | ${num(pluginMetrics.mrrAt10)} | ${num(codeGraphMetrics.mrrAt10)} |`);
  lines.push(`| nDCG@10 | ${num(pluginMetrics.ndcgAt10)} | ${num(codeGraphMetrics.ndcgAt10)} |`);
  if (includeLatency) {
    lines.push(`| Latency p50 (ms) | ${ms(pluginMetrics.latencyMs.p50)} | ${ms(codeGraphMetrics.latencyMs.p50)} |`);
    lines.push(`| Latency p95 (ms) | ${ms(pluginMetrics.latencyMs.p95)} | ${ms(codeGraphMetrics.latencyMs.p95)} |`);
    lines.push(`| Latency p99 (ms) | ${ms(pluginMetrics.latencyMs.p99)} | ${ms(codeGraphMetrics.latencyMs.p99)} |`);
  }
  lines.push("");
}

export function buildReportMarkdown(
  runAt: string,
  options: CliOptions,
  runDir: string,
  repoResults: RepoBenchmarkResult[]
): string {
  const lines: string[] = [];
  lines.push("# Cross-Repo Benchmark Report");
  lines.push("");
  lines.push(`- Generated at: ${runAt}`);
  lines.push(`- Output directory: ${runDir}`);
  lines.push(`- Reindex: ${options.reindex}`);
  lines.push(
    `- Reindex application in repeats: ${options.reindex ? "applied on repeat #1 only" : "disabled"}`
  );
  lines.push(`- Repeats: ${options.repeats} (median aggregation)`);
  lines.push(`- File sampling cap: ${options.maxParseFiles}`);
  lines.push(`- Persist generated datasets to benchmarks/golden/cross-repo: ${options.persistDatasets}`);
  lines.push(`- Ripgrep baseline: ${options.skipRipgrep ? "skipped" : "enabled"}`);
  lines.push(
    `- ast-grep baseline: ${
      options.skipSg ? "skipped" : "enabled (query types: definition, keyword-heavy)"
    }`
  );
  lines.push(`- CodeGraph fair comparator: ${options.codegraph ? "enabled" : "disabled"}`);
  lines.push("");

  const aggregateSgHeaderLabel = (() => {
    const scopedCounts = repoResults
      .map((result) => result.sg)
      .filter((result): result is NonNullable<RepoBenchmarkResult["sg"]> => result !== undefined)
      .map((result) => `${result.scopedQueryCount}/${result.totalQueryCount}`);

    if (scopedCounts.length === 0) {
      return "ast-grep";
    }

    const uniqueScopedCounts = [...new Set(scopedCounts)];
    if (uniqueScopedCounts.length === 1) {
      return `ast-grep (${uniqueScopedCounts[0]} queries)`;
    }

    return "ast-grep (scoped queries)";
  })();

  for (const result of repoResults) {
    lines.push(`## ${result.repoName}`);
    lines.push("");
    lines.push(`- Repo: ${result.repoPath}`);
    lines.push(`- Dataset: ${result.datasetPath} (${result.datasetQueryCount} queries)`);
    lines.push(
      `- File sampling: parsed ${result.fileSampling.parsedFileCount} files (cap=${result.fileSampling.maxParseFiles}, truncated=${result.fileSampling.truncated}, fileSizeLimit=${result.fileSampling.fileSizeLimitBytes} bytes)`
    );
    if (result.error) {
      lines.push(`- Error: ${result.error}`);
      lines.push("");
      continue;
    }

    if (result.sg) {
      lines.push(
        `- ast-grep scope: ${result.sg.queryTypeScope.join(", ")} (${result.sg.scopedQueryCount}/${result.sg.totalQueryCount} queries scored)`
      );
    }

    const repoSgHeaderLabel = result.sg
      ? `ast-grep (${result.sg.scopedQueryCount}/${result.sg.totalQueryCount} queries)`
      : "ast-grep";

    lines.push(`| Metric | Plugin | Ripgrep | ${repoSgHeaderLabel} |`);
    lines.push("|---|---:|---:|---:|");

    const rgMetrics = result.ripgrep?.metrics;
    const sgMetrics = result.sg?.metrics;
    lines.push(`| Hit@1 | ${pct(result.plugin.metrics.hitAt1)} | ${rgMetrics ? pct(rgMetrics.hitAt1) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt1) : "N/A"} |`);
    lines.push(`| Hit@3 | ${pct(result.plugin.metrics.hitAt3)} | ${rgMetrics ? pct(rgMetrics.hitAt3) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt3) : "N/A"} |`);
    lines.push(`| Hit@5 | ${pct(result.plugin.metrics.hitAt5)} | ${rgMetrics ? pct(rgMetrics.hitAt5) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt5) : "N/A"} |`);
    lines.push(`| Hit@10 | ${pct(result.plugin.metrics.hitAt10)} | ${rgMetrics ? pct(rgMetrics.hitAt10) : "N/A"} | ${sgMetrics ? pct(sgMetrics.hitAt10) : "N/A"} |`);
    lines.push(`| MRR@10 | ${num(result.plugin.metrics.mrrAt10)} | ${rgMetrics ? num(rgMetrics.mrrAt10) : "N/A"} | ${sgMetrics ? num(sgMetrics.mrrAt10) : "N/A"} |`);
    lines.push(`| nDCG@10 | ${num(result.plugin.metrics.ndcgAt10)} | ${rgMetrics ? num(rgMetrics.ndcgAt10) : "N/A"} | ${sgMetrics ? num(sgMetrics.ndcgAt10) : "N/A"} |`);
    lines.push(`| Latency p50 (ms) | ${ms(result.plugin.metrics.latencyMs.p50)} | ${rgMetrics ? ms(rgMetrics.latencyMs.p50) : "N/A"} | ${sgMetrics ? ms(sgMetrics.latencyMs.p50) : "N/A"} |`);
    lines.push(`| Latency p95 (ms) | ${ms(result.plugin.metrics.latencyMs.p95)} | ${rgMetrics ? ms(rgMetrics.latencyMs.p95) : "N/A"} | ${sgMetrics ? ms(sgMetrics.latencyMs.p95) : "N/A"} |`);
    lines.push(`| Latency p99 (ms) | ${ms(result.plugin.metrics.latencyMs.p99)} | ${rgMetrics ? ms(rgMetrics.latencyMs.p99) : "N/A"} | ${sgMetrics ? ms(sgMetrics.latencyMs.p99) : "N/A"} |`);
    lines.push("");
  }

  const successful = repoResults.filter((item) => !item.error);
  const pluginAggregate = averageMetrics(successful.map((item) => item.plugin.metrics));
  const ripgrepSuccessful = successful.filter((item) => item.ripgrep).map((item) => item.ripgrep?.metrics).filter((item): item is EvalMetrics => item !== undefined);
  const ripgrepAggregate = ripgrepSuccessful.length > 0 ? averageMetrics(ripgrepSuccessful) : undefined;
  const sgSuccessful = successful.filter((item) => item.sg).map((item) => item.sg?.metrics).filter((item): item is EvalMetrics => item !== undefined);
  const sgAggregate = sgSuccessful.length > 0 ? averageMetrics(sgSuccessful) : undefined;

  lines.push("## Aggregate (Median per repo, then average across repos)");
  lines.push("");
  lines.push(`| Metric | Plugin | Ripgrep | ${aggregateSgHeaderLabel} |`);
  lines.push("|---|---:|---:|---:|");
  lines.push(`| Hit@1 | ${pct(pluginAggregate.hitAt1)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt1) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt1) : "N/A"} |`);
  lines.push(`| Hit@3 | ${pct(pluginAggregate.hitAt3)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt3) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt3) : "N/A"} |`);
  lines.push(`| Hit@5 | ${pct(pluginAggregate.hitAt5)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt5) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt5) : "N/A"} |`);
  lines.push(`| Hit@10 | ${pct(pluginAggregate.hitAt10)} | ${ripgrepAggregate ? pct(ripgrepAggregate.hitAt10) : "N/A"} | ${sgAggregate ? pct(sgAggregate.hitAt10) : "N/A"} |`);
  lines.push(`| MRR@10 | ${num(pluginAggregate.mrrAt10)} | ${ripgrepAggregate ? num(ripgrepAggregate.mrrAt10) : "N/A"} | ${sgAggregate ? num(sgAggregate.mrrAt10) : "N/A"} |`);
  lines.push(`| nDCG@10 | ${num(pluginAggregate.ndcgAt10)} | ${ripgrepAggregate ? num(ripgrepAggregate.ndcgAt10) : "N/A"} | ${sgAggregate ? num(sgAggregate.ndcgAt10) : "N/A"} |`);
  lines.push(`| Latency p50 (ms) | ${ms(pluginAggregate.latencyMs.p50)} | ${ripgrepAggregate ? ms(ripgrepAggregate.latencyMs.p50) : "N/A"} | ${sgAggregate ? ms(sgAggregate.latencyMs.p50) : "N/A"} |`);
  lines.push(`| Latency p95 (ms) | ${ms(pluginAggregate.latencyMs.p95)} | ${ripgrepAggregate ? ms(ripgrepAggregate.latencyMs.p95) : "N/A"} | ${sgAggregate ? ms(sgAggregate.latencyMs.p95) : "N/A"} |`);
  lines.push(`| Latency p99 (ms) | ${ms(pluginAggregate.latencyMs.p99)} | ${ripgrepAggregate ? ms(ripgrepAggregate.latencyMs.p99) : "N/A"} | ${sgAggregate ? ms(sgAggregate.latencyMs.p99) : "N/A"} |`);
  lines.push("");

  if (options.codegraph) {
    lines.push("## Fair CodeGraph Comparator");
    lines.push("");
    lines.push("Plugin metrics are recomputed per repeat from exactly the same query IDs with `expected.symbol` that CodeGraph receives.");
    lines.push("Latency is omitted in this comparator because each `codegraph query` timing includes one-shot CLI process startup.");
    lines.push("");

    for (const result of successful) {
      lines.push(`### ${result.repoName}`);
      lines.push("");
      const comparison = result.codegraph;
      if (!comparison) {
        lines.push("No comparison result: CodeGraph was not run for this repository.");
        lines.push("");
        continue;
      }

      lines.push(`- Scope: ${comparison.scopedQueryCount}/${comparison.totalQueryCount} queries`);
      lines.push(`- Valid repeats: ${comparison.successfulRepeatCount}/${comparison.repeatSummaries.length}`);
      for (const repeat of comparison.repeatSummaries) {
        if (repeat.status !== "completed") {
          lines.push(`- Repeat ${repeat.repeat}: No comparison result (${repeat.error ?? "no expected.symbol queries"}); artifact: ${repeat.artifactPath}`);
        }
      }

      if (comparison.metrics) {
        lines.push("");
        appendCodeGraphMetricTable(lines, comparison.metrics.plugin, comparison.metrics.codegraph, false);
      } else {
        lines.push("");
        lines.push("No comparison result: no CodeGraph repeat completed successfully.");
        lines.push("");
      }
    }

    const comparable = successful
      .map((result) => result.codegraph?.metrics)
      .filter((metrics): metrics is NonNullable<NonNullable<RepoBenchmarkResult["codegraph"]>["metrics"]> => metrics !== undefined);
    lines.push("### Aggregate fair comparison");
    lines.push("");
    if (comparable.length > 0) {
      appendCodeGraphMetricTable(
        lines,
        averageMetrics(comparable.map((metrics) => metrics.plugin)),
        averageMetrics(comparable.map((metrics) => metrics.codegraph)),
        false
      );
    } else {
      lines.push("No comparison result: no repository had a successful CodeGraph repeat.");
      lines.push("");
    }
  }

  const failed = repoResults.filter((item) => item.error);
  if (failed.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of failed) {
      lines.push(`- ${failure.repoName}: ${failure.error}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function runForRepo(
  repoPath: string,
  options: CliOptions,
  runDir: string,
  datasetRoot: string,
  persistentDatasetRoot: string
): Promise<RepoBenchmarkResult> {
  const repoName = toRepoName(repoPath);
  const datasetPath = path.join(datasetRoot, `${repoName}.json`);
  const persistentDatasetPath = path.join(persistentDatasetRoot, `${repoName}.json`);

  try {
    const { parsedFiles, collection } = collectParsedFiles(repoPath, options.maxParseFiles);
    const dataset = buildGoldenDataset(repoName, repoPath, parsedFiles);
    writeDataset(datasetPath, dataset);
    if (options.persistDatasets) {
      writeDataset(persistentDatasetPath, dataset);
    }

    const pluginOutputRoot = path.join(runDir, "plugin", repoName);
    const pluginRuns: EvalMetrics[] = [];
    const ripgrepRuns: EvalMetrics[] = [];
    const sgRuns: EvalMetrics[] = [];
    const codeGraphRepeats: CodeGraphRepeatSummary[] = [];
    const pluginRepeatSummaries: Array<{
      repeat: number;
      outputDir: string;
      summaryPath: string;
      perQueryPath: string;
      metrics: EvalMetrics;
      reindexApplied: boolean;
    }> = [];
    const controlledEvalConfigArtifactPath = writeControlledEvalConfig(
      controlledEvalConfigPath(runDir, repoName)
    );
    let lastPluginResult: Awaited<ReturnType<typeof runEvaluation>> | null = null;
    let lastRipgrepQueryCount = 0;
    let lastSgQueryCount = 0;
    let lastSgScopedQueryCount = 0;
    let lastSgTotalQueryCount = dataset.queries.length;
    let lastSgQueryTypeScope: GoldenQueryType[] = ["definition", "keyword-heavy"];

    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      const reindexApplied = options.reindex && repeat === 0;
      const runOptions: EvalRunOptions = buildPluginEvalRunOptions({
        projectRoot: repoPath,
        datasetPath,
        outputRoot: pluginOutputRoot,
        reindexApplied,
        configPath: controlledEvalConfigArtifactPath,
      });

      const pluginResult = await runEvaluation(runOptions);
      lastPluginResult = pluginResult;
      pluginRuns.push(pluginResult.summary.metrics);
      pluginRepeatSummaries.push({
        repeat: repeat + 1,
        outputDir: pluginResult.outputDir,
        summaryPath: path.join(pluginResult.outputDir, "summary.json"),
        perQueryPath: path.join(pluginResult.outputDir, "per-query.json"),
        metrics: pluginResult.summary.metrics,
        reindexApplied,
      });

      if (options.codegraph) {
        codeGraphRepeats.push(await runCodeGraphRepeat({
          repoPath,
          dataset,
          pluginPerQuery: pluginResult.perQuery,
          repeat: repeat + 1,
          artifactPath: path.join(runDir, "codegraph", repoName, `repeat-${repeat + 1}.json`),
        }));
      }

      if (!options.skipRipgrep) {
        const ripgrepResult = await runRipgrepBaseline(repoPath, dataset);
        ripgrepRuns.push(ripgrepResult.metrics);
        lastRipgrepQueryCount = ripgrepResult.perQuery.length;
      }

      if (!options.skipSg) {
        const sgResult = await runSgBaseline(repoPath, dataset);
        sgRuns.push(sgResult.metrics);
        lastSgQueryCount = sgResult.perQuery.length;
        lastSgScopedQueryCount = sgResult.scopedQueryCount;
        lastSgTotalQueryCount = sgResult.totalQueryCount;
        lastSgQueryTypeScope = sgResult.queryTypeScope;
      }
    }

    if (!lastPluginResult) {
      throw new Error("No plugin results collected");
    }

    const result: RepoBenchmarkResult = {
      repoName,
      repoPath,
      datasetPath,
      datasetQueryCount: dataset.queries.length,
      fileSampling: {
        parsedFileCount: collection.files.length,
        truncated: collection.truncated,
        maxParseFiles: collection.maxParseFiles,
        fileSizeLimitBytes: MAX_FILE_SIZE_BYTES,
      },
      plugin: {
        outputDir: lastPluginResult.outputDir,
        summaryPath: path.join(lastPluginResult.outputDir, "summary.json"),
        perQueryPath: path.join(lastPluginResult.outputDir, "per-query.json"),
        metrics: medianMetrics(pluginRuns),
        repeatSummaries: pluginRepeatSummaries,
      },
    };

    if (!options.skipRipgrep && ripgrepRuns.length > 0) {
      result.ripgrep = {
        metrics: medianMetrics(ripgrepRuns),
        perQueryCount: lastRipgrepQueryCount,
        repeatMetrics: ripgrepRuns,
      };
    }

    if (!options.skipSg && sgRuns.length > 0) {
      result.sg = {
        metrics: medianMetrics(sgRuns),
        perQueryCount: lastSgQueryCount,
        repeatMetrics: sgRuns,
        queryTypeScope: lastSgQueryTypeScope,
        scopedQueryCount: lastSgScopedQueryCount,
        totalQueryCount: lastSgTotalQueryCount,
      };
    }

    if (options.codegraph) {
      const successfulComparisons = codeGraphRepeats.filter(
        (repeat): repeat is CodeGraphRepeatSummary & {
          pluginMetrics: EvalMetrics;
          codeGraphMetrics: EvalMetrics;
        } => repeat.status === "completed"
          && repeat.pluginMetrics !== undefined
          && repeat.codeGraphMetrics !== undefined
      );
      result.codegraph = {
        scopedQueryCount: codeGraphRepeats[0]?.scopedQueryCount ?? 0,
        totalQueryCount: dataset.queries.length,
        successfulRepeatCount: successfulComparisons.length,
        disqualifiedRepeatCount: codeGraphRepeats.filter((repeat) => repeat.status === "disqualified").length,
        repeatSummaries: codeGraphRepeats,
        ...(successfulComparisons.length > 0 ? {
          metrics: {
            plugin: medianMetrics(successfulComparisons.map((repeat) => repeat.pluginMetrics)),
            codegraph: medianMetrics(successfulComparisons.map((repeat) => repeat.codeGraphMetrics)),
          },
        } : {}),
      };
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repoName,
      repoPath,
      datasetPath,
      datasetQueryCount: 0,
      fileSampling: {
        parsedFileCount: 0,
        truncated: false,
        maxParseFiles: options.maxParseFiles,
        fileSizeLimitBytes: MAX_FILE_SIZE_BYTES,
      },
      plugin: {
        outputDir: "",
        summaryPath: "",
        perQueryPath: "",
        metrics: averageMetrics([]),
        repeatSummaries: [],
      },
      error: message,
    };
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const resolvedRepos = options.repos.map((repo) => path.resolve(expandHome(repo)));

  if (resolvedRepos.length === 0) {
    throw new Error("No repositories configured");
  }

  for (const repoPath of resolvedRepos) {
    if (!existsSync(repoPath)) {
      throw new Error(`Repository path does not exist: ${repoPath}`);
    }
  }

  const runTimestamp = timestampForDir();
  const runDir = path.join(options.outputRoot, runTimestamp);
  const datasetRoot = path.join(runDir, "datasets");
  const persistentDatasetRoot = path.join(process.cwd(), "benchmarks", "golden", "cross-repo");

  ensureDir(runDir);
  ensureDir(path.join(runDir, "repos"));
  ensureDir(datasetRoot);
  if (options.persistDatasets) {
    ensureDir(persistentDatasetRoot);
  }

  console.log(`Cross-repo benchmark run: ${runTimestamp}`);
  console.log(`Output: ${runDir}`);

  const results: RepoBenchmarkResult[] = [];

  for (const repoPath of resolvedRepos) {
    const repoName = toRepoName(repoPath);
    console.log(`\n[${repoName}] generating dataset + running evaluations...`);
    const repoResult = await runForRepo(
      repoPath,
      options,
      runDir,
      datasetRoot,
      persistentDatasetRoot
    );
    results.push(repoResult);

    const perRepoArtifactPath = path.join(runDir, "repos", `${repoName}.json`);
    writeFileSync(perRepoArtifactPath, JSON.stringify(repoResult, null, 2), "utf-8");

    if (repoResult.error) {
      console.log(`[${repoName}] failed (see ${perRepoArtifactPath} for details)`);
    } else {
      const rgHitAt5 = repoResult.ripgrep ? `, rg=${pct(repoResult.ripgrep.metrics.hitAt5)}` : "";
      const sgHitAt5 = repoResult.sg ? `, sg=${pct(repoResult.sg.metrics.hitAt5)}` : "";
      console.log(
        `[${repoName}] done: Hit@5 plugin=${pct(repoResult.plugin.metrics.hitAt5)}${rgHitAt5}${sgHitAt5}`
      );
    }
  }

  const reportMarkdown = buildReportMarkdown(new Date().toISOString(), options, runDir, results);
  const reportJson = {
    generatedAt: new Date().toISOString(),
    options: {
      repos: resolvedRepos,
      outputRoot: options.outputRoot,
      reindex: options.reindex,
      repeats: options.repeats,
      maxParseFiles: options.maxParseFiles,
      persistDatasets: options.persistDatasets,
      skipRipgrep: options.skipRipgrep,
      skipSg: options.skipSg,
      codegraph: options.codegraph,
    },
    runDir,
    repos: results,
    aggregate: {
      plugin: averageMetrics(results.filter((item) => !item.error).map((item) => item.plugin.metrics)),
      ripgrep: options.skipRipgrep
        ? undefined
        : averageMetrics(
            results
              .filter((item) => !item.error && item.ripgrep)
              .map((item) => item.ripgrep?.metrics)
              .filter((item): item is EvalMetrics => item !== undefined)
          ),
      sg: options.skipSg
        ? undefined
        : averageMetrics(
            results
              .filter((item) => !item.error && item.sg)
              .map((item) => item.sg?.metrics)
              .filter((item): item is EvalMetrics => item !== undefined)
          ),
    },
    codegraphComparison: options.codegraph ? (() => {
      const comparable = results
        .filter((item) => !item.error)
        .map((item) => item.codegraph?.metrics)
        .filter((metrics): metrics is NonNullable<NonNullable<RepoBenchmarkResult["codegraph"]>["metrics"]> => metrics !== undefined);
      return {
        comparedRepoCount: comparable.length,
        plugin: comparable.length > 0
          ? averageMetrics(comparable.map((metrics) => metrics.plugin))
          : undefined,
        codegraph: comparable.length > 0
          ? averageMetrics(comparable.map((metrics) => metrics.codegraph))
          : undefined,
      };
    })() : undefined,
  };

  const reportMdPath = path.join(runDir, "report.md");
  const reportJsonPath = path.join(runDir, "report.json");

  writeFileSync(reportMdPath, reportMarkdown, "utf-8");
  writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2), "utf-8");

  console.log(`\nReport written:`);
  console.log(`- ${reportMdPath}`);
  console.log(`- ${reportJsonPath}`);

  const failedCount = results.filter((item) => item.error).length;
  if (failedCount > 0) {
    console.log(`\nCompleted with ${failedCount} repo failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("\nCompleted successfully.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
