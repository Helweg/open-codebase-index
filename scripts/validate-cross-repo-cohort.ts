#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { loadFixedDataset } from "./cross-repo-benchmark.js";

const execFileAsync = promisify(execFile);

export interface CrossRepoCohortValidationOptions {
  cohortDir: string;
  workDir?: string;
}

interface CohortManifestRepository {
  name: string;
  url: string;
  revision: string;
  dataset: string;
}

interface CohortManifest {
  repositories: CohortManifestRepository[];
}

interface RepoDefinitionMiss {
  repository: string;
  queryId: string;
  symbol: string;
  filePath: string;
}

interface RepoValidationResult {
  repository: string;
  dataset: string;
  definitionQueriesChecked: number;
  definitionQueriesWithMissingSymbols: number;
  errors: string[];
  missing: RepoDefinitionMiss[];
}

export interface CrossRepoCohortValidationSummary {
  cohortDir: string;
  workspaceDir: string;
  repositoriesChecked: number;
  repositoriesPassed: number;
  repositoriesFailed: number;
  repoResults: RepoValidationResult[];
}

const DEFAULT_COHORT_DIR = path.join(process.cwd(), "benchmarks", "golden", "expanded-cross-repo");

function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home = process.env.HOME;
  if (!home) {
    return input;
  }

  if (input === "~") {
    return home;
  }

  return path.join(home, input.slice(2));
}

function normalizeLocalRepoSource(rawUrl: string, cohortRoot: string): string {
  const value = expandHome(rawUrl);

  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }

  const looksLikeSshRemote = /^[^\s@:/]+@[^\s:/]+:/.test(value);

  if (value.includes("://") || looksLikeSshRemote) {
    return value;
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(cohortRoot, value);
}

function isEmpty(value: unknown): value is null | undefined | "" {
  return value === undefined || value === null || value === "";
}

function parseCohortManifest(manifestPath: string): CohortManifest {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse cohort manifest ${manifestPath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid cohort manifest ${manifestPath}: expected object`);
  }

  const candidate = parsed as {
    repositories?: unknown;
    [key: string]: unknown;
  };
  if (!Array.isArray(candidate.repositories)) {
    throw new Error(`Invalid cohort manifest ${manifestPath}: repositories must be an array`);
  }

  const repositories = candidate.repositories.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid repository entry at index ${index}: expected object`);
    }

    const candidateRepo = entry as {
      name?: unknown;
      url?: unknown;
      revision?: unknown;
      dataset?: unknown;
    };

    if (typeof candidateRepo.name !== "string" || candidateRepo.name.trim().length === 0) {
      throw new Error(`Invalid repository entry at index ${index}: name must be a non-empty string`);
    }
    if (typeof candidateRepo.url !== "string" || candidateRepo.url.trim().length === 0) {
      throw new Error(`Invalid repository entry at index ${index}: url must be a non-empty string`);
    }
    if (typeof candidateRepo.revision !== "string" || candidateRepo.revision.trim().length === 0) {
      throw new Error(`Invalid repository entry at index ${index}: revision must be a non-empty string`);
    }
    if (typeof candidateRepo.dataset !== "string" || candidateRepo.dataset.trim().length === 0) {
      throw new Error(`Invalid repository entry at index ${index}: dataset must be a non-empty string`);
    }

    return {
      name: candidateRepo.name,
      url: candidateRepo.url,
      revision: candidateRepo.revision,
      dataset: candidateRepo.dataset,
    } satisfies CohortManifestRepository;
  });

  return { repositories };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
  });
}

async function cloneRepository(source: string, revision: string, destination: string): Promise<void> {
  if (fs.existsSync(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
  }

  const cloneCommandSets: string[][] = [
    ["clone", "--quiet", "--no-checkout", "--filter=blob:none", "--depth", "1", "--", source, destination],
    ["clone", "--quiet", "--no-checkout", "--depth", "1", "--", source, destination],
    ["clone", "--quiet", "--no-checkout", "--", source, destination],
  ];

  let cloneFailure: unknown = null;
  for (const cloneArgs of cloneCommandSets) {
    try {
      await runGit(process.cwd(), cloneArgs);
      cloneFailure = null;
      break;
    } catch (error: unknown) {
      cloneFailure = error;
      if (fs.existsSync(destination)) {
        fs.rmSync(destination, { recursive: true, force: true });
      }
    }
  }

  if (cloneFailure) {
    throw new Error(`Failed to clone repository ${source}: ${getErrorMessage(cloneFailure)}`);
  }

  try {
    await runGit(destination, ["fetch", "--quiet", "--depth", "1", "origin", revision]);
  } catch (error: unknown) {
    if (!fs.existsSync(path.join(destination, ".git"))) {
      throw new Error(`Failed to fetch ${revision} for ${source}: ${getErrorMessage(error)}`);
    }
  }

  try {
    await runGit(destination, ["checkout", "--quiet", "--detach", revision]);
  } catch (error: unknown) {
    throw new Error(`Failed to checkout ${revision} for ${source}: ${getErrorMessage(error)}`);
  }
}

function safeReadText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function sanitizeRepoDirName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function validateRepo(
  repo: CohortManifestRepository,
  cohortDir: string,
  workspace: string,
  repoIndex: number,
): Promise<RepoValidationResult> {
  const repoDir = path.join(workspace, `${String(repoIndex).padStart(2, "0")}-${sanitizeRepoDirName(repo.name)}`);
  const result: RepoValidationResult = {
    repository: repo.name,
    dataset: repo.dataset,
    definitionQueriesChecked: 0,
    definitionQueriesWithMissingSymbols: 0,
    errors: [],
    missing: [],
  };

  try {
    const source = normalizeLocalRepoSource(repo.url, cohortDir);
    await cloneRepository(source, repo.revision, repoDir);

    const datasetPath = path.join(cohortDir, repo.dataset);
    const dataset = loadFixedDataset(datasetPath, repoDir);
    const definitionQueries = dataset.queries.filter((query) => query.queryType === "definition");

    result.definitionQueriesChecked = definitionQueries.length;
    for (const query of definitionQueries) {
      const symbol = query.expected.symbol;
      const filePath = query.expected.filePath;

      if (isEmpty(symbol) || isEmpty(filePath)) {
        result.errors.push(`Definition query ${query.id} is missing expected symbol or file path`);
        result.definitionQueriesWithMissingSymbols += 1;
        continue;
      }

      const absoluteFilePath = path.resolve(repoDir, filePath);
      const sourceText = safeReadText(absoluteFilePath);

      if (!sourceText.includes(symbol)) {
        result.definitionQueriesWithMissingSymbols += 1;
        result.missing.push({
          repository: repo.name,
          queryId: query.id,
          symbol,
          filePath,
        });
      }
    }
  } catch (error: unknown) {
    result.errors.push(getErrorMessage(error));
  } finally {
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  }

  return result;
}

export async function validateCrossRepoCohortSources(
  options: CrossRepoCohortValidationOptions,
): Promise<CrossRepoCohortValidationSummary> {
  const resolvedCohortDir = path.resolve(options.cohortDir);
  const manifestPath = path.join(resolvedCohortDir, "cohort.json");
  const cohort = parseCohortManifest(manifestPath);

  const baseWorkRoot = options.workDir
    ? path.resolve(options.workDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "cross-repo-source-validate-"));
  if (!fs.existsSync(baseWorkRoot)) {
    fs.mkdirSync(baseWorkRoot, { recursive: true });
  }
  const workspace = fs.mkdtempSync(path.join(baseWorkRoot, `run-${String(Date.now())}-`));

  const repoResults: RepoValidationResult[] = [];
  try {
    for (let index = 0; index < cohort.repositories.length; index += 1) {
      const repo = cohort.repositories[index];
      const result = await validateRepo(repo, resolvedCohortDir, workspace, index + 1);
      repoResults.push(result);
    }
  } finally {
    if (fs.existsSync(workspace)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }

    if (!options.workDir && fs.existsSync(baseWorkRoot)) {
      fs.rmSync(baseWorkRoot, { recursive: true, force: true });
    }
  }

  const failedResults = repoResults.filter(
    (repo) => repo.errors.length > 0 || repo.definitionQueriesWithMissingSymbols > 0,
  );

  return {
    cohortDir: resolvedCohortDir,
    workspaceDir: workspace,
    repositoriesChecked: repoResults.length,
    repositoriesPassed: repoResults.length - failedResults.length,
    repositoriesFailed: failedResults.length,
    repoResults,
  };
}

export function parseCliArgs(argv: string[]): CrossRepoCohortValidationOptions {
  let cohortDir = DEFAULT_COHORT_DIR;
  let workDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cohort-dir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--cohort-dir requires a path");
      }
      cohortDir = path.resolve(expandHome(value));
      i += 1;
      continue;
    }

    if (arg === "--work-dir" || arg === "--cache-dir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--work-dir requires a path");
      }
      workDir = path.resolve(expandHome(value));
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
npx tsx scripts/validate-cross-repo-cohort.ts [--cohort-dir PATH] [--work-dir PATH]

Defaults:
  --cohort-dir: ${DEFAULT_COHORT_DIR}
  --work-dir: a temporary directory created under os.tmpdir()

Aliases:
  --cache-dir can be used as a CI-friendly work directory alias for --work-dir
`);
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { cohortDir, workDir };
}

function printFailureReport(summary: CrossRepoCohortValidationSummary): void {
  console.error("Cross-repo source evidence validation failed");
  console.error(`Cohort: ${summary.cohortDir}`);
  console.error(`Checked repositories: ${summary.repositoriesChecked}`);

  for (const repo of summary.repoResults) {
    if (repo.errors.length === 0 && repo.definitionQueriesWithMissingSymbols === 0) {
      console.log(`  [ok] ${repo.repository}`);
      continue;
    }

    console.error(`  [fail] ${repo.repository}`);
    if (repo.errors.length > 0) {
      for (const error of repo.errors) {
        console.error(`    - ${error}`);
      }
    }

    for (const miss of repo.missing) {
      console.error(
        `    - ${miss.queryId}: expected symbol '${miss.symbol}' in ${miss.filePath}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const summary = await validateCrossRepoCohortSources(options);
  console.log(`Cross-repo source evidence validation complete: ${summary.repositoriesPassed}/${summary.repositoriesChecked} repositories passed.`);
  if (summary.repositoriesFailed > 0) {
    printFailureReport(summary);
    process.exitCode = 1;
    return;
  }

  console.log("All repository definition symbol checks passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    printFailureReport({
      cohortDir: "",
      workspaceDir: "",
      repositoriesChecked: 0,
      repositoriesPassed: 0,
      repositoriesFailed: 1,
      repoResults: [{
        repository: "bootstrap",
        dataset: "",
        definitionQueriesChecked: 0,
        definitionQueriesWithMissingSymbols: 0,
        errors: [getErrorMessage(error)],
        missing: [],
      }],
    });
    process.exitCode = 1;
  });
}
