import { execFile } from "child_process";
import { realpathSync } from "fs";
import * as path from "path";
import { promisify } from "util";

import {
  assertValidGitRefName,
  isFullGitCommit,
  resolveGitCommit,
  resolveLocalPullRequestRefs,
} from "../git/branch-materialization.js";

const execFileAsync = promisify(execFile);
const GH_PR_VIEW_FIELDS = [
  "number",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "baseRefName",
  "url",
  "files",
].join(",");

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ChangedFilesResult {
  files: string[];
  baseBranch: string;
  source: "gh" | "git";
  catalogIdentity: string;
  headRefName?: string;
  headRef?: string;
  baseRepository?: string;
  baseRepositoryIdentity?: string;
  headRepositoryIdentity?: string;
}

export interface GetChangedFilesOptions {
  pr?: number;
  branch?: string;
  projectRoot: string;
  baseBranch?: string;
}

interface GhRepositoryOwner {
  login?: string;
  name?: string;
}

interface GhRepository {
  name?: string;
  nameWithOwner?: string;
  owner?: GhRepositoryOwner;
}

interface GhPrViewResponse {
  number?: number;
  headRefName?: string;
  headRefOid?: string;
  headRepository?: GhRepository;
  headRepositoryOwner?: GhRepositoryOwner;
  baseRefName?: string;
  url?: string;
  files?: Array<{ path?: string }>;
}

interface RepositoryFromPrUrl {
  url: string;
  identity: string;
  host: string;
}

export function createPullRequestCatalogIdentity(
  baseRepositoryIdentity: string,
  pr: number,
  headRepositoryIdentity: string,
): string {
  if (!baseRepositoryIdentity || !headRepositoryIdentity) {
    throw new Error("Pull request catalog identity requires base and head repository identities.");
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`Pull request number must be a positive integer: ${pr}`);
  }
  return `pull-request:${encodeURIComponent(baseRepositoryIdentity)}:${pr}:${encodeURIComponent(headRepositoryIdentity)}`;
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
      ["pr", "view", String(pr), "--json", GH_PR_VIEW_FIELDS],
      { cwd: projectRoot, timeout: 30000, encoding: "utf8" },
    );

    const data = JSON.parse(stdout) as GhPrViewResponse;
    const baseRepository = getRepositoryFromPrUrl(data.url, pr);
    const headRepositoryIdentity = getHeadRepositoryIdentity(data, baseRepository.host);
    if (data.number !== pr) {
      throw new Error(`gh returned PR #${String(data.number)} while PR #${pr} was requested.`);
    }
    if (!data.headRefName) throw new Error("gh did not return headRefName.");
    if (!data.baseRefName) throw new Error("gh did not return baseRefName.");
    const headRefOid = data.headRefOid;
    if (!headRefOid || !isFullGitCommit(headRefOid)) {
      throw new Error("gh did not return a full authoritative headRefOid.");
    }
    if (!Array.isArray(data.files) || data.files.some((file) => typeof file.path !== "string")) {
      throw new Error("gh returned invalid changed-file metadata.");
    }

    assertValidGitRefName(data.headRefName, "PR head branch");
    assertValidGitRefName(data.baseRefName, "PR base branch");
    const headRef = headRefOid.toLowerCase();
    return {
      files: normalizeFiles(data.files.map((file) => file.path!), projectRoot),
      baseBranch: data.baseRefName,
      source: "gh",
      catalogIdentity: createPullRequestCatalogIdentity(
        baseRepository.identity,
        pr,
        headRepositoryIdentity,
      ),
      headRefName: data.headRefName,
      headRef,
      baseRepository: baseRepository.url,
      baseRepositoryIdentity: baseRepository.identity,
      headRepositoryIdentity,
    };
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

  const localRepositoryIdentity = getLocalRepositoryIdentity(projectRoot);
  const headRepositoryIdentity = `${localRepositoryIdentity}/refs/pull/${pr}/head`;
  return {
    files: await getDiffFiles(projectRoot, localRefs.baseCommit, localRefs.headCommit),
    baseBranch: localRefs.baseCommit,
    source: "git",
    catalogIdentity: createPullRequestCatalogIdentity(
      localRepositoryIdentity,
      pr,
      headRepositoryIdentity,
    ),
    headRefName: `pr/${pr}`,
    headRef: localRefs.headCommit,
    baseRepositoryIdentity: localRepositoryIdentity,
    headRepositoryIdentity,
  };
}

function getRepositoryFromPrUrl(prUrl: string | undefined, expectedPr: number): RepositoryFromPrUrl {
  if (!prUrl) throw new Error("gh did not return the PR URL.");
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    throw new Error(`gh returned an invalid PR URL: ${JSON.stringify(prUrl)}`);
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match || Number(match[3]) !== expectedPr) {
    throw new Error(`gh returned a PR URL that does not identify PR #${expectedPr}: ${JSON.stringify(prUrl)}`);
  }

  const owner = match[1].toLowerCase();
  const repository = match[2].replace(/\.git$/i, "").toLowerCase();
  const host = url.hostname.toLowerCase();
  if (!host || !owner || !repository) {
    throw new Error(`gh returned an invalid PR repository URL: ${JSON.stringify(prUrl)}`);
  }
  return {
    url: `${url.protocol}//${url.host}/${match[1]}/${match[2].replace(/\.git$/i, "")}`,
    identity: `${host}/${owner}/${repository}`,
    host,
  };
}

function getHeadRepositoryIdentity(data: GhPrViewResponse, host: string): string {
  const nameWithOwner = data.headRepository?.nameWithOwner;
  if (nameWithOwner) {
    const match = nameWithOwner.match(/^([^/]+)\/([^/]+)$/);
    if (match) return `${host}/${match[1].toLowerCase()}/${match[2].replace(/\.git$/i, "").toLowerCase()}`;
  }

  const owner = data.headRepositoryOwner?.login
    ?? data.headRepositoryOwner?.name
    ?? data.headRepository?.owner?.login
    ?? data.headRepository?.owner?.name;
  const repository = data.headRepository?.name;
  if (!owner || !repository || owner.includes("/") || repository.includes("/")) {
    throw new Error("gh did not return an authoritative head repository identity.");
  }
  return `${host}/${owner.toLowerCase()}/${repository.replace(/\.git$/i, "").toLowerCase()}`;
}

function getLocalRepositoryIdentity(projectRoot: string): string {
  let canonicalRoot = path.resolve(projectRoot);
  try {
    canonicalRoot = realpathSync.native(canonicalRoot);
  } catch {
    // A missing realpath will be diagnosed by the subsequent Git operation.
  }
  return `local:${canonicalRoot}`;
}

async function getChangedFilesForBranch(
  branch: string | undefined,
  projectRoot: string,
  baseBranch: string,
): Promise<ChangedFilesResult> {
  const targetBranch = branch || (await getCurrentBranch(projectRoot));
  assertValidGitRefName(baseBranch, "Base branch");
  assertValidGitRefName(targetBranch, "Branch name");

  const resolvedBase = await resolveGitCommit(projectRoot, baseBranch);
  if (!resolvedBase) {
    throw new Error(`Could not resolve base branch ${JSON.stringify(baseBranch)} to a commit.`);
  }
  const resolvedHead = await resolveGitCommit(projectRoot, targetBranch);
  if (!resolvedHead) {
    throw new Error(`Could not resolve branch ${JSON.stringify(targetBranch)} to a commit.`);
  }
  const mergeBase = await getMergeBase(projectRoot, resolvedBase, resolvedHead);

  return {
    files: await getDiffFiles(projectRoot, mergeBase, resolvedHead),
    baseBranch,
    source: "git",
    catalogIdentity: targetBranch,
    headRefName: targetBranch,
    headRef: resolvedHead,
  };
}

async function getDiffFiles(
  projectRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string[]> {
  if (!isFullGitCommit(baseRef) || !isFullGitCommit(headRef)) {
    throw new Error("Changed-file diff requires fully resolved commit OIDs.");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "-z", `${baseRef}...${headRef}`, "--"],
    { cwd: projectRoot, timeout: 30000, encoding: "utf8" },
  );
  return normalizeFiles(stdout.split("\0"), projectRoot);
}

async function getCurrentBranch(projectRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: projectRoot, timeout: 30000, encoding: "utf8" },
  );
  return stdout.trim() || "HEAD";
}

async function getMergeBase(
  projectRoot: string,
  baseCommit: string,
  headCommit: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["merge-base", "--", baseCommit, headCommit],
    { cwd: projectRoot, timeout: 30000, encoding: "utf8" },
  );
  const commit = stdout.trim().toLowerCase();
  if (!isFullGitCommit(commit)) {
    throw new Error("git merge-base did not return a full commit OID.");
  }
  return commit;
}

function normalizeFiles(rawFiles: string[], projectRoot: string): string[] {
  const root = path.resolve(projectRoot);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawFiles) {
    if (raw.length === 0) continue;

    const absolute = path.resolve(root, raw);
    const relative = path.relative(root, absolute);
    if (path.isAbsolute(raw) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Changed file escapes the project root: ${JSON.stringify(raw)}`);
    }

    const cleaned = relative.startsWith(`.${path.sep}`)
      ? relative.slice(2)
      : relative;
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      result.push(cleaned);
    }
  }

  return result;
}
