import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  assertValidGitRefName,
  resolveLocalPullRequestRefs,
} from "../git/branch-materialization.js";

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
  baseRepository?: string;
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
  url?: string;
  files?: Array<{ path: string }>;
}

export async function getChangedFiles(
  opts: GetChangedFilesOptions,
): Promise<ChangedFilesResult> {
  const { pr, branch, projectRoot, baseBranch = "main" } = opts;

  if (pr !== undefined) {
    return getChangedFilesForPr(pr, projectRoot);
  }

  return getChangedFilesForBranch(branch, projectRoot, baseBranch);
}

async function getChangedFilesForPr(
  pr: number,
  projectRoot: string,
): Promise<ChangedFilesResult> {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`Pull request number must be a positive integer: ${pr}`);
  }

  let ghError: unknown;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(pr), "--json", "headRefName,headRefOid,baseRefName,url,files"],
      { cwd: projectRoot, timeout: 30000 },
    );

    const data = JSON.parse(stdout) as GhPrViewResponse;
    const headRefName = data.headRefName;
    const headRef = data.headRefOid || data.headRefName;
    if (headRefName && headRef && data.baseRefName && Array.isArray(data.files)) {
      return {
        files: normalizeFiles(
          data.files.map((f) => f.path),
          projectRoot,
        ),
        baseBranch: data.baseRefName,
        source: "gh",
        headRefName,
        headRef,
        baseRepository: getRepositoryUrlFromPrUrl(data.url),
      };
    }
  } catch (error) {
    ghError = error;
  }

  const localRefs = await resolveLocalPullRequestRefs(projectRoot, pr);
  if (!localRefs?.baseCommit) {
    const ghFailure = ghError === undefined
      ? "gh returned incomplete PR head/base metadata"
      : getErrorMessage(ghError);
    throw new Error(
      `Failed to retrieve an authoritative base for PR #${pr}: ${ghFailure}. `
      + `The safe local fallback requires refs/pull/${pr}/merge with parents matching refs/pull/${pr}/head.`,
    );
  }

  const files = await getDiffFiles(projectRoot, localRefs.baseCommit, localRefs.headCommit);
  return {
    files,
    baseBranch: localRefs.baseCommit,
    source: "git",
    headRefName: `pr/${pr}`,
    headRef: localRefs.headCommit,
  };
}

function getRepositoryUrlFromPrUrl(prUrl: string | undefined): string | undefined {
  if (!prUrl) return undefined;
  try {
    const url = new URL(prUrl);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/);
    return match ? `${url.origin}/${match[1]}/${match[2]}` : undefined;
  } catch {
    return undefined;
  }
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

  return {
    files: await getDiffFiles(projectRoot, mergeBase, targetBranch),
    baseBranch,
    source: "git",
    headRefName: targetBranch,
    headRef: targetBranch,
  };
}

async function getDiffFiles(
  projectRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "-z", `${baseRef}...${headRef}`],
    { cwd: projectRoot, timeout: 30000 },
  );
  return normalizeFiles(stdout.split("\0"), projectRoot);
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
    if (raw.length === 0) continue;

    const absolute = path.resolve(projectRoot, raw);
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
