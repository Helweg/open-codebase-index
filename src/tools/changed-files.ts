import { execFile } from "child_process";
import { realpathSync } from "fs";
import * as path from "path";
import { promisify } from "util";

import {
  assertValidGitRefName,
  isFullGitCommit,
  resolveGitCommit,
  resolveLocalGitCommit,
  resolveLocalPullRequestRefs,
} from "../git/branch-materialization.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";

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

export interface WorkingTreeChanges {
  headCommit: string | null;
  entries: Array<{
    path: string;
    previousPath?: string;
    indexStatus: string;
    worktreeStatus: string;
  }>;
  omittedFileCount: number;
}

/** Local path changes only; this does not read staged blobs or refresh the index. */
export async function getWorkingTreeChanges(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<WorkingTreeChanges> {
  throwIfOperationAborted(signal);
  const decodePaths = (output: Buffer): string => {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
    } catch (error) {
      throw new Error("Working-tree paths must be valid UTF-8; impact analysis cannot represent these filenames safely.", { cause: error });
    }
  };
  const { stdout: rootBytes } = await execFileAsync("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel",
  ], { cwd: projectRoot, timeout: 30000, maxBuffer: 1024 * 1024, encoding: "buffer", signal });
  throwIfOperationAborted(signal);
  // Remove Git's terminating newline only; directory names may contain whitespace.
  const rootOutput = decodePaths(rootBytes);
  const gitRoot = rootOutput.endsWith("\n") ? rootOutput.slice(0, -1) : rootOutput;
  if (!path.isAbsolute(gitRoot)) throw new Error("Could not resolve the working-tree root.");
  const canonicalProjectRoot = realpathSync.native(projectRoot);
  const { stdout: statusBytes } = await execFileAsync("git", [
    "--no-optional-locks", "-c", "core.fsmonitor=false", "status",
    "--porcelain=v1", "-z", "--untracked-files=all", "--", ".",
  ], { cwd: projectRoot, timeout: 30000, maxBuffer: 1024 * 1024, encoding: "buffer", signal });
  throwIfOperationAborted(signal);
  const records = decodePaths(statusBytes).split("\0");
  if (records.pop() !== "") throw new Error("Malformed working-tree status output.");
  const entries: WorkingTreeChanges["entries"] = [];
  const unmerged: Record<string, true> = { DD: true, AU: true, UD: true, UA: true, DU: true, AA: true, UU: true };
  const validStatus = /^[ MTADRCU?!]{2}$/u;
  const normalized = (filePath: string): string | undefined => {
    if (!filePath || path.isAbsolute(filePath)) throw new Error("Malformed working-tree status path.");
    const repositoryPath = normalizeFiles([filePath], gitRoot)[0];
    const relative = path.relative(canonicalProjectRoot, path.resolve(gitRoot, repositoryPath));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join("/");
  };
  for (let index = 0; index < records.length; index++) {
    throwIfOperationAborted(signal);
    const record = records[index];
    const status = record.slice(0, 2);
    if (record[2] !== " " || !validStatus.test(status)) {
      throw new Error("Malformed working-tree status record.");
    }
    const destination = normalized(record.slice(3));
    let previousPath: string | undefined;
    if (status.includes("R") || status.includes("C")) {
      const previousRecord = records[++index];
      if (previousRecord === undefined) throw new Error("Malformed working-tree rename record.");
      previousPath = normalized(previousRecord);
    }
    if (destination === undefined) {
      if (previousPath !== undefined && status.includes("R")) {
        // Only the deletion belongs to this project; do not expose the sibling destination.
        entries.push({
          path: previousPath,
          indexStatus: status[0] === "R" ? "D" : " ",
          worktreeStatus: status[1] === "R" ? "D" : " ",
        });
      }
      continue;
    }
    if (unmerged[status]) throw new Error("Resolve unmerged files before analyzing working-tree impact.");
    const crossesBoundary = previousPath === undefined && (status.includes("R") || status.includes("C"));
    entries.push({
      path: destination,
      ...(previousPath === undefined ? {} : { previousPath }),
      indexStatus: crossesBoundary && (status[0] === "R" || status[0] === "C") ? "A" : status[0],
      worktreeStatus: crossesBoundary && (status[1] === "R" || status[1] === "C") ? "A" : status[1],
    });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const headCommit = await resolveLocalGitCommit(projectRoot, "HEAD", signal);
  throwIfOperationAborted(signal);
  return { headCommit, entries: entries.slice(0, 200), omittedFileCount: Math.max(0, entries.length - 200) };
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
  signal?: AbortSignal;
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
  const { pr, branch, projectRoot, baseBranch = "main", signal } = opts;
  throwIfOperationAborted(signal);

  if (pr !== undefined) {
    return getChangedFilesForPr(pr, projectRoot, signal);
  }

  return getChangedFilesForBranch(branch, projectRoot, baseBranch, signal);
}

async function getChangedFilesForPr(
  pr: number,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<ChangedFilesResult> {
  throwIfOperationAborted(signal);
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`Pull request number must be a positive integer: ${pr}`);
  }

  let ghError: unknown;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(pr), "--json", GH_PR_VIEW_FIELDS],
      { cwd: projectRoot, timeout: 30000, encoding: "utf8", signal },
    );
    throwIfOperationAborted(signal);

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
    throwIfOperationAborted(signal);
    ghError = error;
  }

  const localRefs = await resolveLocalPullRequestRefs(projectRoot, pr, signal);
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
    files: await getDiffFiles(projectRoot, localRefs.baseCommit, localRefs.headCommit, signal),
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
  signal?: AbortSignal,
): Promise<ChangedFilesResult> {
  throwIfOperationAborted(signal);
  const targetBranch = branch || (await getCurrentBranch(projectRoot, signal));
  assertValidGitRefName(baseBranch, "Base branch");
  assertValidGitRefName(targetBranch, "Branch name");

  const resolvedBase = await resolveGitCommit(projectRoot, baseBranch, signal);
  if (!resolvedBase) {
    throw new Error(`Could not resolve base branch ${JSON.stringify(baseBranch)} to a commit.`);
  }
  const resolvedHead = await resolveGitCommit(projectRoot, targetBranch, signal);
  if (!resolvedHead) {
    throw new Error(`Could not resolve branch ${JSON.stringify(targetBranch)} to a commit.`);
  }
  const mergeBase = await getMergeBase(projectRoot, resolvedBase, resolvedHead, signal);

  return {
    files: await getDiffFiles(projectRoot, mergeBase, resolvedHead, signal),
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
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfOperationAborted(signal);
  if (!isFullGitCommit(baseRef) || !isFullGitCommit(headRef)) {
    throw new Error("Changed-file diff requires fully resolved commit OIDs.");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["diff", "--name-only", "-z", `${baseRef}...${headRef}`, "--"],
    { cwd: projectRoot, timeout: 30000, encoding: "utf8", signal },
  );
  throwIfOperationAborted(signal);
  return normalizeFiles(stdout.split("\0"), projectRoot);
}

async function getCurrentBranch(projectRoot: string, signal?: AbortSignal): Promise<string> {
  throwIfOperationAborted(signal);
  const { stdout } = await execFileAsync(
    "git",
    ["branch", "--show-current"],
    { cwd: projectRoot, timeout: 30000, encoding: "utf8", signal },
  );
  throwIfOperationAborted(signal);
  return stdout.trim() || "HEAD";
}

async function getMergeBase(
  projectRoot: string,
  baseCommit: string,
  headCommit: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfOperationAborted(signal);
  const { stdout } = await execFileAsync(
    "git",
    ["merge-base", "--", baseCommit, headCommit],
    { cwd: projectRoot, timeout: 30000, encoding: "utf8", signal },
  );
  throwIfOperationAborted(signal);
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
