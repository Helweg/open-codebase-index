import { execFile } from "child_process";
import { randomBytes } from "crypto";
import { promises as fsPromises } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;
const SAFE_REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
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
  expectedCommit?: string;
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function contextualizeError(prefix: string, error: unknown): Error {
  if (error instanceof AggregateError) {
    return new AggregateError(
      Array.from(error.errors, asError),
      `${prefix}: ${error.message}`,
    );
  }
  return new Error(`${prefix}: ${getErrorMessage(error)}`);
}

export function isFullGitCommit(value: string): boolean {
  return FULL_COMMIT_RE.test(value);
}

export function isValidGitRefName(value: string): boolean {
  if (value === "HEAD" || isFullGitCommit(value)) return true;
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

export function isValidGitRemoteName(value: string): boolean {
  return SAFE_REMOTE_NAME_RE.test(value);
}

function assertValidGitRemoteName(value: string): void {
  if (!isValidGitRemoteName(value)) {
    throw new Error(`Git remote name is unsafe: ${JSON.stringify(value)}`);
  }
}

async function runGitRaw(
  projectRoot: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    timeout: options.timeout ?? 30000,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
  return stdout;
}

async function runGit(
  projectRoot: string,
  args: string[],
  options: { timeout?: number } = {},
): Promise<string> {
  return (await runGitRaw(projectRoot, args, options)).trim();
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
    return isFullGitCommit(commit) ? commit.toLowerCase() : null;
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
  if (ref === "HEAD" || isFullGitCommit(ref) || ref.startsWith("refs/")) {
    return [ref];
  }
  return [`refs/heads/${ref}`];
}

async function resolveFirstLocalCommit(projectRoot: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const commit = await tryResolveCommit(projectRoot, ref);
    if (commit) return commit;
  }
  return null;
}

function parseRemoteBranch(ref: string): { remote: string; branch: string; explicit: boolean } | null {
  const remoteRefMatch = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (remoteRefMatch) {
    return { remote: remoteRefMatch[1], branch: remoteRefMatch[2], explicit: true };
  }

  if (ref.startsWith("refs/") || ref === "HEAD" || isFullGitCommit(ref)) {
    return null;
  }

  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { remote: ref.slice(0, slash), branch: ref.slice(slash + 1), explicit: false };
}

async function getRemoteNames(projectRoot: string): Promise<string[]> {
  const output = await runGitRaw(projectRoot, ["remote"]);
  return output.split("\n").filter(Boolean);
}

async function getConfiguredRemote(projectRoot: string, remote: string): Promise<string | null> {
  assertValidGitRemoteName(remote);
  const remotes = await getRemoteNames(projectRoot);
  return remotes.includes(remote) ? remote : null;
}

function normalizeRepository(value: string): string | null {
  if (!value || value.startsWith("-") || /[\0\r\n]/.test(value)) return null;
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

async function resolvePullRequestRepository(
  projectRoot: string,
  repository?: string,
): Promise<string> {
  const remotes = (await getRemoteNames(projectRoot)).filter(isValidGitRemoteName);
  if (repository) {
    const expectedRepository = normalizeRepository(repository);
    if (!expectedRepository) {
      throw new Error(`PR repository URL is invalid: ${JSON.stringify(repository)}`);
    }

    for (const remote of remotes) {
      const remoteUrl = await runGit(projectRoot, ["remote", "get-url", "--", remote]);
      if (normalizeRepository(remoteUrl) === expectedRepository) {
        return remote;
      }
    }

    return repository;
  }

  if (remotes.length === 1) return remotes[0];
  throw new Error(
    remotes.length === 0
      ? "Cannot fetch the PR head because this repository has no safe Git remotes."
      : "Cannot safely choose a PR remote because multiple Git remotes are configured.",
  );
}

async function deleteTemporaryRef(
  projectRoot: string,
  temporaryRef: string,
  expectedCommit: string,
): Promise<void> {
  await runGit(projectRoot, ["update-ref", "-d", temporaryRef, expectedCommit]);
  const remaining = await tryResolveCommit(projectRoot, temporaryRef);
  if (remaining) {
    throw new Error(`Temporary Git ref ${temporaryRef} remains at ${remaining}.`);
  }
}

async function fetchCommitThroughTemporaryRef(
  projectRoot: string,
  repository: string,
  sourceRef: string,
  expectedCommit?: string,
): Promise<string> {
  assertValidGitRefName(sourceRef, "Fetch source ref");
  if (isValidGitRemoteName(repository)) {
    const configuredRemote = await getConfiguredRemote(projectRoot, repository);
    if (!configuredRemote) {
      throw new Error(`Git remote is not configured: ${JSON.stringify(repository)}`);
    }
  } else if (!normalizeRepository(repository)) {
    throw new Error(`Git fetch repository is invalid: ${JSON.stringify(repository)}`);
  }

  const temporaryRef = `refs/codebase-index/fetch-${process.pid}-${randomBytes(12).toString("hex")}`;
  assertValidGitRefName(temporaryRef, "Temporary Git ref");
  let commit: string | null = null;
  let fetchError: unknown;

  try {
    await runGit(projectRoot, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      repository,
      `+${sourceRef}:${temporaryRef}`,
    ]);
    commit = await tryResolveCommit(projectRoot, temporaryRef);
    if (!commit) {
      throw new Error(`Fetched ref ${JSON.stringify(sourceRef)} did not resolve to a commit.`);
    }
    if (expectedCommit && commit !== expectedCommit.toLowerCase()) {
      throw new Error(
        `Fetched ref ${JSON.stringify(sourceRef)} resolved to ${commit}, but authoritative metadata requires ${expectedCommit}.`,
      );
    }
  } catch (error) {
    fetchError = error;
  }

  let cleanupError: unknown;
  try {
    const temporaryCommit = commit ?? await tryResolveCommit(projectRoot, temporaryRef);
    if (temporaryCommit) {
      await deleteTemporaryRef(projectRoot, temporaryRef, temporaryCommit);
    }
  } catch (error) {
    cleanupError = error;
  }

  if (fetchError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [asError(fetchError), asError(cleanupError)],
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
  const authoritativeCommit = request.expectedCommit?.toLowerCase();

  if (request.pr !== undefined) {
    const expectedCommit = authoritativeCommit
      ?? (isFullGitCommit(requestedRef) ? requestedRef.toLowerCase() : undefined);
    const localPullCommit = await tryResolveCommit(request.projectRoot, `refs/pull/${request.pr}/head`);
    if (localPullCommit && (!expectedCommit || localPullCommit === expectedCommit)) {
      return { commit: localPullCommit, source: "pull-ref", fetched: false };
    }

    if (expectedCommit && await tryResolveCommit(request.projectRoot, expectedCommit)) {
      return { commit: expectedCommit, source: "local", fetched: false };
    }

    const repository = await resolvePullRequestRepository(request.projectRoot, request.repository);
    try {
      const commit = await fetchCommitThroughTemporaryRef(
        request.projectRoot,
        repository,
        `refs/pull/${request.pr}/head`,
        expectedCommit,
      );
      return { commit, source: "pull-ref", fetched: true };
    } catch (error) {
      throw contextualizeError(
        `Could not fetch PR #${request.pr} from ${JSON.stringify(repository)}`,
        error,
      );
    }
  }

  const remoteBranch = parseRemoteBranch(requestedRef);
  if (remoteBranch) {
    if (!isValidGitRemoteName(remoteBranch.remote)) {
      throw new Error(`Git remote name is unsafe: ${JSON.stringify(remoteBranch.remote)}`);
    }
    const remote = await getConfiguredRemote(request.projectRoot, remoteBranch.remote);
    if (remote) {
      try {
        const commit = await fetchCommitThroughTemporaryRef(
          request.projectRoot,
          remote,
          `refs/heads/${remoteBranch.branch}`,
          authoritativeCommit,
        );
        return { commit, source: "remote-fetch", fetched: true };
      } catch (error) {
        throw contextualizeError(
          `Could not fetch branch ${JSON.stringify(requestedRef)} from remote ${JSON.stringify(remote)}`,
          error,
        );
      }
    }
    if (remoteBranch.explicit) {
      throw new Error(`Git remote is not configured: ${JSON.stringify(remoteBranch.remote)}`);
    }
  }

  const localCommit = await resolveFirstLocalCommit(request.projectRoot, localCandidates(requestedRef));
  if (!localCommit) return null;
  if (authoritativeCommit && localCommit !== authoritativeCommit) {
    throw new Error(
      `Git ref ${JSON.stringify(requestedRef)} resolved to ${localCommit}, but authoritative metadata requires ${authoritativeCommit}.`,
    );
  }
  return { commit: localCommit, source: "local", fetched: false };
}

export async function resolveGitCommit(projectRoot: string, ref: string): Promise<string | null> {
  assertValidGitRefName(ref);
  const resolved = await resolveCommit({ projectRoot, branch: ref, ref });
  return resolved?.commit ?? null;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fsPromises.stat(targetPath).then(() => true, () => false);
}

async function canonicalizePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const missingParts: string[] = [];
  let candidate = resolved;

  while (true) {
    try {
      return path.join(await fsPromises.realpath(candidate), ...missingParts);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      missingParts.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function isWorktreeRegistered(projectRoot: string, worktreePath: string): Promise<boolean> {
  const output = await runGitRaw(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  const target = await canonicalizePath(worktreePath);
  const worktreePaths = output
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));

  for (const registeredPath of worktreePaths) {
    if (await canonicalizePath(registeredPath) === target) return true;
  }
  return false;
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function pruneExactMissingWorktreeRegistration(
  projectRoot: string,
  worktreePath: string,
): Promise<boolean> {
  if (await pathExists(worktreePath)) return false;

  const commonDir = await runGit(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const registrationsRoot = path.join(commonDir, "worktrees");
  let entries;
  try {
    entries = await fsPromises.readdir(registrationsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const target = await canonicalizePath(worktreePath);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const registrationPath = path.join(registrationsRoot, entry.name);
    if (!isPathWithinRoot(registrationPath, registrationsRoot)) continue;

    let gitdirPath: string;
    try {
      gitdirPath = (await fsPromises.readFile(path.join(registrationPath, "gitdir"), "utf8")).trim();
    } catch {
      continue;
    }

    const resolvedGitdirPath = path.isAbsolute(gitdirPath)
      ? gitdirPath
      : path.resolve(registrationPath, gitdirPath);
    if (await canonicalizePath(path.dirname(resolvedGitdirPath)) !== target) continue;
    await fsPromises.rm(registrationPath, { recursive: true, force: true });
    return true;
  }

  return false;
}

async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  const errors: Error[] = [];
  try {
    await runGit(projectRoot, ["worktree", "remove", "--force", "--", worktreePath]);
  } catch (error) {
    errors.push(asError(error));
  }

  let registered: boolean;
  try {
    registered = await isWorktreeRegistered(projectRoot, worktreePath);
  } catch (error) {
    errors.push(asError(error));
    throw new AggregateError(errors, `Could not verify temporary worktree deregistration; preserved ${path.dirname(worktreePath)}`);
  }

  if (registered) {
    try {
      await runGit(projectRoot, ["worktree", "unlock", "--", worktreePath]);
    } catch {
      // An unlocked or missing worktree does not need an unlock step.
    }
    try {
      await runGit(projectRoot, ["worktree", "remove", "--force", "--force", "--", worktreePath]);
    } catch (error) {
      errors.push(asError(error));
    }

    try {
      registered = await isWorktreeRegistered(projectRoot, worktreePath);
    } catch (error) {
      errors.push(asError(error));
      throw new AggregateError(errors, `Could not verify temporary worktree deregistration; preserved ${path.dirname(worktreePath)}`);
    }
  }

  if (registered && !(await pathExists(worktreePath))) {
    try {
      await pruneExactMissingWorktreeRegistration(projectRoot, worktreePath);
      registered = await isWorktreeRegistered(projectRoot, worktreePath);
    } catch (error) {
      errors.push(asError(error));
    }
  }

  if (registered) {
    errors.push(new Error(`Temporary worktree remains registered: ${worktreePath}`));
    throw new AggregateError(errors, `Failed to deregister temporary worktree; preserved ${path.dirname(worktreePath)}`);
  }

  try {
    await fsPromises.rm(path.dirname(worktreePath), { recursive: true, force: true });
  } catch (error) {
    errors.push(asError(error));
    throw new AggregateError(errors, `Deregistered the temporary worktree but could not remove ${path.dirname(worktreePath)}`);
  }
}

async function cleanupTemporaryWorktree(
  projectRoot: string,
  worktreePath: string,
  temporaryRoot: string,
): Promise<void> {
  let registered: boolean;
  try {
    registered = await isWorktreeRegistered(projectRoot, worktreePath);
  } catch (error) {
    throw new AggregateError(
      [asError(error)],
      `Could not verify temporary worktree registration; preserved ${temporaryRoot}`,
    );
  }

  if (registered) {
    await removeWorktree(projectRoot, worktreePath);
    return;
  }

  await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
}

export async function withMaterializedBranch<T>(
  request: BranchMaterializationRequest,
  callback: (worktreePath: string, info: BranchMaterializationInfo) => Promise<T>,
): Promise<{ value: T; info: BranchMaterializationInfo }> {
  assertValidGitRefName(request.branch, "Branch name");
  if (request.ref !== undefined) {
    assertValidGitRefName(request.ref, "Git ref");
  }
  if (request.expectedCommit !== undefined && !isFullGitCommit(request.expectedCommit)) {
    throw new Error(`Expected Git commit is invalid: ${JSON.stringify(request.expectedCommit)}`);
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
      "--",
      worktreePath,
      resolved.commit,
    ]);

    const materializedHead = await tryResolveCommit(worktreePath, "HEAD");
    if (materializedHead !== resolved.commit) {
      throw new Error(
        `Materialized worktree HEAD ${materializedHead ?? "did not resolve"}; expected ${resolved.commit}.`,
      );
    }

    const value = await callback(worktreePath, info);
    result = { value, info };
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await cleanupTemporaryWorktree(request.projectRoot, worktreePath, temporaryRoot);
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [asError(operationError), asError(cleanupError)],
      `${getErrorMessage(operationError)} Cleanup also failed: ${getErrorMessage(cleanupError)}`,
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}
