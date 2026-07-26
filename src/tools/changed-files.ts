import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { assertValidGitRefName, resolveLocalGitCommit } from "../git/branch-materialization.js";

const execFileAsync = promisify(execFile);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ChangedFilesResult {
  files: string[];
  baseBranch: string;
  source: "gh" | "git";
  headRefName?: string;
  headRef?: string;
}

export interface GetChangedFilesOptions {
  pr?: number;
  branch?: string;
  projectRoot: string;
  baseBranch?: string;
}

interface GhPrViewResponse {
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  files?: Array<{ path: string }>;
}

export async function getChangedFiles(
  opts: GetChangedFilesOptions,
): Promise<ChangedFilesResult> {
  const { pr, branch, projectRoot, baseBranch = "main" } = opts;

  if (pr !== undefined) {
    return getChangedFilesForPr(pr, projectRoot, baseBranch);
  }

  return getChangedFilesForBranch(branch, projectRoot, baseBranch);
}

async function getChangedFilesForPr(
  pr: number,
  projectRoot: string,
  baseBranch: string,
): Promise<ChangedFilesResult> {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`Pull request number must be a positive integer: ${pr}`);
  }

  const localPullRef = `refs/pull/${pr}/head`;
  const localPullCommit = await resolveLocalGitCommit(projectRoot, localPullRef);
  if (localPullCommit) {
    const result = await getChangedFilesForBranch(localPullRef, projectRoot, baseBranch);
    return {
      ...result,
      headRefName: `pr/${pr}`,
      headRef: localPullCommit,
    };
  }

  let headRefName: string | undefined;
  let headRef: string | undefined;
  let actualBaseBranch = baseBranch;

  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(pr), "--json", "headRefName,headRefOid,baseRefName,files"],
      { cwd: projectRoot, timeout: 30000 },
    );

    const data = JSON.parse(stdout) as GhPrViewResponse;
    headRefName = data.headRefName;
    headRef = data.headRefOid || data.headRefName;
    actualBaseBranch = data.baseRefName || baseBranch;

    if (Array.isArray(data.files)) {
      return {
        files: normalizeFiles(
          data.files.map((f) => f.path),
          projectRoot,
        ),
        baseBranch: actualBaseBranch,
        source: "gh",
        headRefName,
        headRef,
      };
    }
  } catch (error) {
    throw new Error(
      `Failed to retrieve PR #${pr} via gh CLI: ${getErrorMessage(error)}`,
    );
  }

  if (headRefName === undefined) {
    throw new Error(
      `PR #${pr} returned no usable head branch or file information.`,
    );
  }

  const result = await getChangedFilesForBranch(headRef, projectRoot, actualBaseBranch);
  return { ...result, headRefName, headRef };
}

async function getChangedFilesForBranch(
  branch: string | undefined,
  projectRoot: string,
  baseBranch: string,
): Promise<ChangedFilesResult> {
  const targetBranch = branch || (await getCurrentBranch(projectRoot));
  assertValidGitRefName(baseBranch, "Base branch");
  assertValidGitRefName(targetBranch, "Branch name");
  const mergeBase = await getMergeBase(projectRoot, baseBranch, targetBranch);

  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", `${mergeBase}...${targetBranch}`],
    { cwd: projectRoot, timeout: 30000 },
  );

  return {
    files: normalizeFiles(stdout.split("\n"), projectRoot),
    baseBranch,
    source: "git",
    headRefName: targetBranch,
    headRef: targetBranch,
  };
}

async function getCurrentBranch(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: projectRoot, timeout: 30000 },
  );
  return stdout.trim() || "HEAD";
}

async function getMergeBase(
  projectRoot: string,
  baseBranch: string,
  branch: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["merge-base", baseBranch, branch],
    { cwd: projectRoot, timeout: 30000 },
  );
  return stdout.trim();
}

function normalizeFiles(rawFiles: string[], projectRoot: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawFiles) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const absolute = path.resolve(projectRoot, trimmed);
    const relative = path.relative(projectRoot, absolute);
    const cleaned = relative.startsWith("./")
      ? relative.slice(2)
      : relative;

    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }

  return result;
}
