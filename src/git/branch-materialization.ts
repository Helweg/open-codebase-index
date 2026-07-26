import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { promises as fsPromises } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;
const FORBIDDEN_REF_CHARS = new Set(["~", "^", ":", "?", "*", "\\", "[", "]"]);

export type BranchMaterializationSource =
  | "local"
  | "remote-fetch"
  | "pull-ref"
  | "gh";

export interface BranchMaterializationRequest {
  projectRoot: string;
  branch: string;
  ref?: string;
  pr?: number;
  repository?: string;
}

export interface BranchMaterializationInfo {
  branch: string;
  commit: string;
  source: BranchMaterializationSource;
  fetched: boolean;
}

export interface LocalPullRequestRefs {
  headCommit: string;
  baseCommit?: string;
}

interface ResolvedCommit {
  commit: string;
  source: Exclude<BranchMaterializationSource, "gh">;
  fetched: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isValidGitRefName(value: string): boolean {
  if (value === "HEAD" || FULL_COMMIT_RE.test(value)) return true;
  if (!value || value.length > 1024 || value.startsWith("-") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || FORBIDDEN_REF_CHARS.has(character);
    })
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || value.endsWith(".")
  ) {
    return false;
  }

  return value.split("/").every((component) =>
    component.length > 0
    && !component.startsWith(".")
    && !component.endsWith(".")
    && !component.endsWith(".lock")
  );
}

export function assertValidGitRefName(value: string, label = "Git ref"): void {
  if (!isValidGitRefName(value)) {
    throw new Error(`${label} is invalid: ${JSON.stringify(value)}`);
  }
}

async function runGit(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    timeout: 30000,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function tryResolveCommit(projectRoot: string, ref: string): Promise<string | null> {
  try {
    const commit = await runGit(projectRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    return FULL_COMMIT_RE.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export async function resolveLocalGitCommit(projectRoot: string, ref: string): Promise<string | null> {
  assertValidGitRefName(ref);
  return tryResolveCommit(projectRoot, ref);
}

export async function resolveLocalPullRequestRefs(
  projectRoot: string,
  pr: number,
): Promise<LocalPullRequestRefs | null> {
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`Pull request number must be a positive integer: ${pr}`);
  }

  const headRef = `refs/pull/${pr}/head`;
  const mergeRef = `refs/pull/${pr}/merge`;
  const headCommit = await tryResolveCommit(projectRoot, headRef);
  const mergeHeadCommit = await tryResolveCommit(projectRoot, `${mergeRef}^2`);
  const resolvedHeadCommit = headCommit ?? mergeHeadCommit;
  if (!resolvedHeadCommit) return null;

  const baseCommit = mergeHeadCommit === resolvedHeadCommit
    ? await tryResolveCommit(projectRoot, `${mergeRef}^1`)
    : null;
  return {
    headCommit: resolvedHeadCommit,
    baseCommit: baseCommit ?? undefined,
  };
}

function localCandidates(ref: string): string[] {
  if (ref === "HEAD" || FULL_COMMIT_RE.test(ref) || ref.startsWith("refs/")) {
    return [ref];
  }

  return Array.from(new Set([
    `refs/heads/${ref}`,
    `refs/remotes/${ref}`,
    ref,
  ]));
}

async function resolveFirstLocalCommit(projectRoot: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const commit = await tryResolveCommit(projectRoot, ref);
    if (commit) return commit;
  }
  return null;
}

function parseRemoteBranch(ref: string): { remote: string; branch: string } | null {
  const remoteRefMatch = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (remoteRefMatch) {
    return { remote: remoteRefMatch[1], branch: remoteRefMatch[2] };
  }

  if (ref.startsWith("refs/") || ref === "HEAD" || FULL_COMMIT_RE.test(ref)) {
    return null;
  }

  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { remote: ref.slice(0, slash), branch: ref.slice(slash + 1) };
}

async function remoteExists(projectRoot: string, remote: string): Promise<boolean> {
  try {
    await runGit(projectRoot, ["remote", "get-url", "--", remote]);
    return true;
  } catch {
    return false;
  }
}

function normalizeRepository(value: string): string | null {
  const trimmed = value.trim().replace(/\/$/, "").replace(/\.git$/i, "");
  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  const urlValue = scpMatch ? `ssh://${scpMatch[1]}/${scpMatch[2]}` : trimmed;
  try {
    const url = new URL(urlValue);
    const repositoryPath = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!url.hostname || !repositoryPath) return null;
    return `${url.hostname.toLowerCase()}/${repositoryPath.toLowerCase()}`;
  } catch {
    return null;
  }
}

async function getRemoteNames(projectRoot: string): Promise<string[]> {
  const output = await runGit(projectRoot, ["remote"]);
  return output.split("\n").filter(Boolean);
}

async function resolvePullRequestRemote(
  projectRoot: string,
  repository?: string,
): Promise<string> {
  const remotes = await getRemoteNames(projectRoot);
  if (repository) {
    const expectedRepository = normalizeRepository(repository);
    if (!expectedRepository) {
      throw new Error(`PR repository URL is invalid: ${JSON.stringify(repository)}`);
    }

    const matches: string[] = [];
    for (const remote of remotes) {
      const remoteUrl = await runGit(projectRoot, ["remote", "get-url", "--", remote]);
      if (normalizeRepository(remoteUrl) === expectedRepository) {
        matches.push(remote);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`No Git remote matches PR repository ${JSON.stringify(repository)}.`);
    }
    throw new Error(`Multiple Git remotes match PR repository ${JSON.stringify(repository)}: ${matches.join(", ")}.`);
  }

  if (remotes.length === 1) return remotes[0];
  throw new Error(
    remotes.length === 0
      ? "Cannot fetch the PR head because this repository has no Git remotes."
      : "Cannot safely choose a PR remote because multiple Git remotes are configured.",
  );
}

async function fetchCommitThroughTemporaryRef(
  projectRoot: string,
  remote: string,
  sourceRef: string,
  expectedCommit?: string,
): Promise<string> {
  const temporaryRef = `refs/codebase-index/fetch-${process.pid}-${randomBytes(8).toString("hex")}`;
  let commit: string | null = null;
  let fetchError: unknown;
  try {
    await runGit(projectRoot, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      remote,
      `+${sourceRef}:${temporaryRef}`,
    ]);
    commit = await tryResolveCommit(projectRoot, temporaryRef);
    if (!commit) {
      throw new Error(`Fetched ref ${JSON.stringify(sourceRef)} did not resolve to a commit.`);
    }
    if (expectedCommit && commit !== expectedCommit) {
      throw new Error(
        `Fetched ref ${JSON.stringify(sourceRef)} resolved to ${commit}, but authoritative metadata requires ${expectedCommit}.`,
      );
    }
  } catch (error) {
    fetchError = error;
  }

  let cleanupError: unknown;
  if (commit) {
    try {
      await runGit(projectRoot, ["update-ref", "-d", temporaryRef, commit]);
    } catch (error) {
      cleanupError = error;
    }
  } else {
    try {
      const temporaryCommit = await tryResolveCommit(projectRoot, temporaryRef);
      if (temporaryCommit) {
        await runGit(projectRoot, ["update-ref", "-d", temporaryRef, temporaryCommit]);
      }
    } catch (error) {
      cleanupError = error;
    }
  }

  if (fetchError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [fetchError, cleanupError],
      `${getErrorMessage(fetchError)} Temporary ref cleanup also failed: ${getErrorMessage(cleanupError)}`,
    );
  }
  if (fetchError !== undefined) throw fetchError;
  if (cleanupError !== undefined) throw cleanupError;
  return commit!;
}

async function resolveCommit(
  request: BranchMaterializationRequest,
): Promise<ResolvedCommit | null> {
  const requestedRef = request.ref ?? request.branch;
  const candidates = localCandidates(requestedRef);
  if (request.pr !== undefined && !FULL_COMMIT_RE.test(requestedRef)) {
    candidates.unshift(`refs/pull/${request.pr}/head`);
  }

  const localCommit = await resolveFirstLocalCommit(request.projectRoot, candidates);
  if (localCommit) {
    return {
      commit: localCommit,
      source: request.pr !== undefined && await tryResolveCommit(request.projectRoot, `refs/pull/${request.pr}/head`) === localCommit
        ? "pull-ref"
        : "local",
      fetched: false,
    };
  }

  if (request.pr !== undefined) {
    const remote = await resolvePullRequestRemote(request.projectRoot, request.repository);
    const expectedCommit = FULL_COMMIT_RE.test(requestedRef) ? requestedRef : undefined;
    try {
      const commit = await fetchCommitThroughTemporaryRef(
        request.projectRoot,
        remote,
        `refs/pull/${request.pr}/head`,
        expectedCommit,
      );
      return { commit, source: "pull-ref", fetched: true };
    } catch (error) {
      throw new Error(
        `Could not fetch PR #${request.pr} from remote ${JSON.stringify(remote)}: ${getErrorMessage(error)}`,
      );
    }
  }

  const remoteBranch = parseRemoteBranch(requestedRef);
  if (!remoteBranch || !(await remoteExists(request.projectRoot, remoteBranch.remote))) {
    return null;
  }

  let fetchedCommit: string;
  try {
    fetchedCommit = await fetchCommitThroughTemporaryRef(
      request.projectRoot,
      remoteBranch.remote,
      `refs/heads/${remoteBranch.branch}`,
    );
  } catch (error) {
    throw new Error(
      `Could not fetch branch ${JSON.stringify(requestedRef)} from remote ${JSON.stringify(remoteBranch.remote)}: ${getErrorMessage(error)}`,
    );
  }

  return { commit: fetchedCommit, source: "remote-fetch", fetched: true };
}

async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  const errors: unknown[] = [];
  try {
    await runGit(projectRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    errors.push(error);
  }

  try {
    await fsPromises.rm(path.dirname(worktreePath), { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }

  try {
    await runGit(projectRoot, ["worktree", "prune", "--expire", "now"]);
  } catch (error) {
    errors.push(error);
  }

  let stillRegistered = true;
  try {
    const registeredWorktrees = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
    stillRegistered = registeredWorktrees
      .split("\n")
      .some((line) => line === `worktree ${worktreePath}`);
  } catch (error) {
    errors.push(error);
  }

  if (stillRegistered) {
    errors.push(new Error(`Temporary worktree remains registered: ${worktreePath}`));
  }

  if (errors.length > 0 && (stillRegistered || await fsPromises.stat(path.dirname(worktreePath)).then(() => true, () => false))) {
    throw new AggregateError(errors, `Failed to fully clean up temporary worktree ${worktreePath}`);
  }
}

export async function withMaterializedBranch<T>(
  request: BranchMaterializationRequest,
  callback: (worktreePath: string, info: BranchMaterializationInfo) => Promise<T>,
): Promise<{ value: T; info: BranchMaterializationInfo }> {
  assertValidGitRefName(request.branch, "Branch name");
  if (request.ref !== undefined) {
    assertValidGitRefName(request.ref, "Git ref");
  }
  if (request.pr !== undefined && (!Number.isInteger(request.pr) || request.pr <= 0)) {
    throw new Error(`Pull request number must be a positive integer: ${request.pr}`);
  }

  const resolved = await resolveCommit(request);
  if (!resolved) {
    throw new Error(
      `Git ref ${JSON.stringify(request.ref ?? request.branch)} is not available locally. `
      + "For an unfetched branch, pass a remote-qualified name such as origin/feature.",
    );
  }

  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codebase-index-branch-"));
  const worktreePath = path.join(temporaryRoot, "worktree");
  const hooksPath = path.join(temporaryRoot, "hooks");
  await fsPromises.mkdir(hooksPath);
  let worktreeAdded = false;
  const info: BranchMaterializationInfo = {
    branch: request.branch,
    commit: resolved.commit,
    source: resolved.source,
    fetched: resolved.fetched,
  };

  let result: { value: T; info: BranchMaterializationInfo } | undefined;
  let operationError: unknown;
  try {
    await runGit(request.projectRoot, [
      "-c",
      `core.hooksPath=${hooksPath}`,
      "worktree",
      "add",
      "--detach",
      worktreePath,
      resolved.commit,
    ]);
    worktreeAdded = true;

    const value = await callback(worktreePath, info);
    result = { value, info };
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    if (worktreeAdded) {
      await removeWorktree(request.projectRoot, worktreePath);
    } else {
      await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    }
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      `${getErrorMessage(operationError)} Cleanup also failed: ${getErrorMessage(cleanupError)}`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}
