import { promises as fsPromises } from "fs";
import * as os from "os";
import * as path from "path";

import { canonicalizePathForComparison } from "../utils/canonical-path.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";

import type {
  BranchMaterializationInfo,
  BranchMaterializationRequest,
  BranchMaterializationSource,
  LocalPullRequestRefs,
} from "./branch-resolution.js";
import {
  asError,
  assertValidGitRefName,
  getErrorMessage,
  isValidGitRefName,
  isFullGitCommit,
  isValidGitRemoteName,
  resolveGitCommit,
  resolveLocalGitCommit,
  resolveLocalPullRequestRefs,
  resolveCommit,
  runGit,
  runGitRaw,
  tryResolveCommit,
} from "./branch-resolution.js";

export type {
  BranchMaterializationSource,
  BranchMaterializationRequest,
  BranchMaterializationInfo,
  LocalPullRequestRefs,
};

export {
  isFullGitCommit,
  isValidGitRefName,
  assertValidGitRefName,
  isValidGitRemoteName,
  resolveLocalGitCommit,
  resolveLocalPullRequestRefs,
  resolveGitCommit,
};
async function pathExists(targetPath: string): Promise<boolean> {
  return fsPromises.stat(targetPath).then(() => true, () => false);
}

async function isWorktreeRegistered(projectRoot: string, worktreePath: string): Promise<boolean> {
  const output = await runGitRaw(projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  const target = canonicalizePathForComparison(worktreePath);
  const worktreePaths = output
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));

  for (const registeredPath of worktreePaths) {
    if (canonicalizePathForComparison(registeredPath) === target) return true;
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

  const target = canonicalizePathForComparison(worktreePath);
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
    if (canonicalizePathForComparison(path.dirname(resolvedGitdirPath)) !== target) continue;
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
  throwIfOperationAborted(request.signal);
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
  throwIfOperationAborted(request.signal);
  if (!resolved) {
    throw new Error(
      `Git ref ${JSON.stringify(request.ref ?? request.branch)} is not available locally. `
      + "For an unfetched branch, pass a remote-qualified name such as origin/feature.",
    );
  }

  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codebase-index-branch-"));
  const worktreePath = path.join(temporaryRoot, "worktree");
  const hooksPath = path.join(temporaryRoot, "hooks");
  const info: BranchMaterializationInfo = {
    branch: request.branch,
    commit: resolved.commit,
    source: resolved.source,
    fetched: resolved.fetched,
  };

  let result: { value: T; info: BranchMaterializationInfo } | undefined;
  let operationError: unknown;
  try {
    throwIfOperationAborted(request.signal);
    await fsPromises.mkdir(hooksPath);
    throwIfOperationAborted(request.signal);
    await runGit(request.projectRoot, [
      "-c",
      `core.hooksPath=${hooksPath}`,
      "worktree",
      "add",
      "--detach",
      "--",
      worktreePath,
      resolved.commit,
    ], { signal: request.signal });

    const materializedHead = await tryResolveCommit(worktreePath, "HEAD", request.signal);
    if (materializedHead !== resolved.commit) {
      throw new Error(
        `Materialized worktree HEAD ${materializedHead ?? "did not resolve"}; expected ${resolved.commit}.`,
      );
    }

    throwIfOperationAborted(request.signal);
    const value = await callback(worktreePath, info);
    throwIfOperationAborted(request.signal);
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
  throwIfOperationAborted(request.signal);
  return result!;
}
