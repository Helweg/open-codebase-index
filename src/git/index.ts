import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import * as path from "path";
import { collectBranchRefs, readPackedRefs, resolveCommonGitDir, tryResolveRefCommit } from "./refs.js";

/**
 * Discover the nearest checkout for an implicit project scope. Explicit project
 * paths must bypass this helper. Non-Git directories retain their original scope.
 */
export function resolveDefaultProjectRoot(cwd: string): string {
  let directory: string;
  try {
    directory = realpathSync(cwd);
  } catch {
    return cwd;
  }

  while (true) {
    if (existsSync(path.join(directory, ".git"))) {
      // A broken nested checkout is still a boundary; never select its parent.
      return resolveGitDir(directory) ? directory : cwd;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return cwd;
    directory = parent;
  }
}

export function resolveWorktreeMainRepoRoot(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    return null;
  }

  const commonGitDir = resolveCommonGitDir(gitDir);
  if (commonGitDir === gitDir || path.basename(commonGitDir) !== ".git") {
    return null;
  }

  const mainRepoRoot = path.dirname(commonGitDir);
  if (!existsSync(mainRepoRoot)) {
    return null;
  }

  return path.resolve(mainRepoRoot) === path.resolve(repoRoot) ? null : mainRepoRoot;
}

/**
 * Resolves the actual git directory path.
 * 
 * In a normal repo, `.git` is a directory containing HEAD, refs, etc.
 * In a worktree, `.git` is a file containing `gitdir: /path/to/actual/git/dir`.
 * 
 * @returns The resolved git directory path, or null if not a git repo
 */
export function resolveGitDir(repoRoot: string): string | null {
  const gitPath = path.join(repoRoot, ".git");
  
  if (!existsSync(gitPath)) {
    return null;
  }
  
  try {
    const stat = statSync(gitPath);
    
    if (stat.isDirectory()) {
      return gitPath;
    }
    
    if (stat.isFile()) {
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitdir = match[1];
        // Handle relative paths
        const resolvedPath = path.isAbsolute(gitdir)
          ? gitdir
          : path.resolve(repoRoot, gitdir);
        
        if (existsSync(resolvedPath)) {
          return resolvedPath;
        }
      }
    }
  } catch {
    // Ignore errors (permission issues, etc.)
  }
  
  return null;
}

export function isGitRepo(dir: string): boolean {
  return resolveGitDir(dir) !== null;
}

export function getCurrentBranch(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    return null;
  }
  
  const headPath = path.join(gitDir, "HEAD");
  
  if (!existsSync(headPath)) {
    return null;
  }

  try {
    const headContent = readFileSync(headPath, "utf-8").trim();
    
    const match = headContent.match(/^ref: refs\/heads\/(.+)$/);
    if (match) {
      return match[1];
    }

    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return headContent.slice(0, 7);
    }

    return null;
  } catch {
    return null;
  }
}

export function getCurrentCommit(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    return null;
  }
  const refStoreDir = resolveCommonGitDir(gitDir);

  const headPath = path.join(gitDir, "HEAD");
  if (!existsSync(headPath)) {
    return null;
  }

  try {
    const headContent = readFileSync(headPath, "utf-8").trim();

    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return headContent;
    }

    const refMatch = headContent.match(/^ref:\s*(.+)$/);
    if (!refMatch) {
      return null;
    }

    return tryResolveRefCommit(refStoreDir, refMatch[1]);
  } catch {
    return null;
  }
}

export function getBaseBranch(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  const refStoreDir = gitDir ? resolveCommonGitDir(gitDir) : null;
  const candidates = ["main", "master", "develop", "trunk"];
  
  if (refStoreDir) {
    for (const candidate of candidates) {
      const refPath = path.join(refStoreDir, "refs", "heads", candidate);
      if (existsSync(refPath)) {
        return candidate;
      }

      const packedRefs = readPackedRefs(refStoreDir);
      if (packedRefs.some((line) => line.endsWith(` refs/heads/${candidate}`))) {
        return candidate;
      }
    }
  }

  return getCurrentBranch(repoRoot) ?? "main";
}

export function getAllBranches(repoRoot: string): string[] {
  const branchSet = new Set<string>();
  const gitDir = resolveGitDir(repoRoot);
  const refStoreDir = gitDir ? resolveCommonGitDir(gitDir) : null;
  
  if (!refStoreDir) {
    return [];
  }
  
  const refsPath = path.join(refStoreDir, "refs", "heads");
  
  if (!existsSync(refsPath)) {
    return [];
  }

  const looseBranches: string[] = [];
  collectBranchRefs(looseBranches, refsPath);
  for (const branch of looseBranches) {
    branchSet.add(branch);
  }

  const packedRefs = readPackedRefs(refStoreDir);
  for (const line of packedRefs) {
    const splitIndex = line.indexOf(" ");
    if (splitIndex <= 0) {
      continue;
    }

    const ref = line.slice(splitIndex + 1).trim();
    const prefix = "refs/heads/";
    if (ref.startsWith(prefix)) {
      branchSet.add(ref.slice(prefix.length));
    }
  }

  return Array.from(branchSet).sort();
}

export function getBranchOrDefault(repoRoot: string): string {
  if (!isGitRepo(repoRoot)) {
    return "default";
  }
  
  return getCurrentBranch(repoRoot) ?? "default";
}

export function getHeadPath(repoRoot: string): string {
  const gitDir = resolveGitDir(repoRoot);
  if (gitDir) {
    return path.join(gitDir, "HEAD");
  }
  return path.join(repoRoot, ".git", "HEAD");
}
