import { execFile } from "child_process";
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
}

export interface BranchMaterializationInfo {
  branch: string;
  commit: string;
  source: BranchMaterializationSource;
  fetched: boolean;
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

async function resolveCommit(
  request: BranchMaterializationRequest,
): Promise<ResolvedCommit | null> {
  const requestedRef = request.ref ?? request.branch;
  const candidates = localCandidates(requestedRef);
  if (request.pr !== undefined) {
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

  const remoteBranch = parseRemoteBranch(requestedRef);
  if (!remoteBranch || !(await remoteExists(request.projectRoot, remoteBranch.remote))) {
    return null;
  }

  try {
    await runGit(request.projectRoot, [
      "fetch",
      "--no-tags",
      remoteBranch.remote,
      `refs/heads/${remoteBranch.branch}`,
    ]);
  } catch (error) {
    throw new Error(
      `Could not fetch branch ${JSON.stringify(requestedRef)} from remote ${JSON.stringify(remoteBranch.remote)}: ${getErrorMessage(error)}`,
    );
  }

  const fetchedCommit = await tryResolveCommit(request.projectRoot, "FETCH_HEAD");
  if (!fetchedCommit) {
    throw new Error(`Remote branch ${JSON.stringify(requestedRef)} was fetched but did not resolve to a commit.`);
  }

  return { commit: fetchedCommit, source: "remote-fetch", fetched: true };
}

async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  try {
    await runGit(projectRoot, ["worktree", "remove", "--force", worktreePath]);
  } finally {
    await fsPromises.rm(path.dirname(worktreePath), { recursive: true, force: true });
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
  if (!resolved && request.pr === undefined) {
    throw new Error(
      `Git ref ${JSON.stringify(request.ref ?? request.branch)} is not available locally. `
      + "For an unfetched branch, pass a remote-qualified name such as origin/feature.",
    );
  }

  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codebase-index-branch-"));
  const worktreePath = path.join(temporaryRoot, "worktree");
  let worktreeAdded = false;
  let info: BranchMaterializationInfo;

  try {
    const initialCommit = resolved?.commit ?? "HEAD";
    await runGit(request.projectRoot, ["worktree", "add", "--detach", worktreePath, initialCommit]);
    worktreeAdded = true;

    if (resolved) {
      info = {
        branch: request.branch,
        commit: resolved.commit,
        source: resolved.source,
        fetched: resolved.fetched,
      };
    } else {
      try {
        await execFileAsync(
          "gh",
          ["pr", "checkout", String(request.pr), "--detach", "--force"],
          { cwd: worktreePath, timeout: 60000, encoding: "utf8" },
        );
      } catch (error) {
        throw new Error(
          `Could not materialize PR #${request.pr} with gh. Ensure gh is installed, authenticated, and can access the repository: ${getErrorMessage(error)}`,
        );
      }

      const commit = await tryResolveCommit(worktreePath, "HEAD");
      if (!commit) {
        throw new Error(`gh checked out PR #${request.pr}, but its HEAD did not resolve to a commit.`);
      }
      info = {
        branch: request.branch,
        commit,
        source: "gh",
        fetched: true,
      };
    }

    const value = await callback(worktreePath, info);
    return { value, info };
  } finally {
    if (worktreeAdded) {
      await removeWorktree(request.projectRoot, worktreePath);
    } else {
      await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
