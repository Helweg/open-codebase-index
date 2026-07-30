import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

import type { HostMode } from "./host.js";
import { resolveWorktreeMainRepoRoot } from "../git/index.js";
import { canonicalizePathForComparison } from "../utils/canonical-path.js";

const OPENCODE_PROJECT_CONFIG_RELATIVE_PATH = path.join(".opencode", "codebase-index.json");
const OPENCODE_PROJECT_INDEX_RELATIVE_PATH = path.join(".opencode", "index");
const CODEBASE_INDEX_DIR = ".codebase-index";
const CODEBASE_PROJECT_CONFIG_RELATIVE_PATH = path.join(CODEBASE_INDEX_DIR, "config.json");
const CODEBASE_PROJECT_INDEX_RELATIVE_PATH = path.join(CODEBASE_INDEX_DIR, "index");
const CLAUDE_DIR = ".claude";
const CLAUDE_PROJECT_CONFIG_RELATIVE_PATH = path.join(CLAUDE_DIR, "codebase-index.json");
const CLAUDE_PROJECT_INDEX_RELATIVE_PATH = path.join(CLAUDE_DIR, "index");

function getProjectConfigRelativePath(host: HostMode): string {
  switch (host) {
    case "opencode":
      return OPENCODE_PROJECT_CONFIG_RELATIVE_PATH;
    case "claude":
      return CLAUDE_PROJECT_CONFIG_RELATIVE_PATH;
    default:
      // Codex, Pi, and Jcode share host-neutral project storage.
      return CODEBASE_PROJECT_CONFIG_RELATIVE_PATH;
  }
}

function getProjectIndexRelativePath(host: HostMode): string {
  switch (host) {
    case "opencode":
      return OPENCODE_PROJECT_INDEX_RELATIVE_PATH;
    case "claude":
      return CLAUDE_PROJECT_INDEX_RELATIVE_PATH;
    default:
      // Codex, Pi, and Jcode share host-neutral project storage.
      return CODEBASE_PROJECT_INDEX_RELATIVE_PATH;
  }
}

function resolveWorktreeFallbackPath(projectRoot: string, relativePath: string): string | null {
  const mainRepoRoot = resolveWorktreeMainRepoRoot(projectRoot);
  if (!mainRepoRoot) {
    return null;
  }

  const fallbackPath = path.join(mainRepoRoot, relativePath);
  return existsSync(fallbackPath) ? fallbackPath : null;
}

export function getHostProjectConfigRelativePath(host: HostMode): string {
  return getProjectConfigRelativePath(host);
}

export function getHostProjectIndexRelativePath(host: HostMode): string {
  return getProjectIndexRelativePath(host);
}

export function getProjectConfigCandidatePaths(
  projectRoot: string,
  host: HostMode,
): string[] {
  const candidates = [path.join(projectRoot, getProjectConfigRelativePath(host))];
  if (host !== "opencode") {
    candidates.push(path.join(projectRoot, OPENCODE_PROJECT_CONFIG_RELATIVE_PATH));
  }

  const mainRepoRoot = resolveWorktreeMainRepoRoot(projectRoot);
  if (mainRepoRoot) {
    candidates.push(path.join(mainRepoRoot, getProjectConfigRelativePath(host)));
    if (host !== "opencode") {
      candidates.push(path.join(mainRepoRoot, OPENCODE_PROJECT_CONFIG_RELATIVE_PATH));
    }
  }

  return [...new Set(candidates)];
}

export function isProjectIndexPathOwnedByProject(
  projectRoot: string,
  indexPath: string,
  host: HostMode,
): boolean {
  const projectRoots = [projectRoot];
  const mainRepoRoot = resolveWorktreeMainRepoRoot(projectRoot);
  if (mainRepoRoot) {
    projectRoots.push(mainRepoRoot);
  }

  const ownedIndexPaths = projectRoots.flatMap((root) => {
    const indexPaths = [path.join(root, getProjectIndexRelativePath(host))];
    if (host !== "opencode") {
      indexPaths.push(path.join(root, OPENCODE_PROJECT_INDEX_RELATIVE_PATH));
    }
    return indexPaths;
  });

  const canonicalIndexPath = canonicalizePathForComparison(indexPath);
  return ownedIndexPaths.some(
    (ownedPath) => canonicalizePathForComparison(ownedPath) === canonicalIndexPath,
  );
}

function hasHostProjectConfig(projectRoot: string, host: HostMode): boolean {
  return existsSync(path.join(projectRoot, getProjectConfigRelativePath(host)));
}

function hasHostGlobalConfig(host: HostMode): boolean {
  return existsSync(getGlobalConfigPath(host));
}

export function getGlobalIndexPath(host: HostMode): string {
  switch (host) {
    case "opencode":
      return path.join(os.homedir(), ".opencode", "global-index");
    case "claude":
      return path.join(os.homedir(), ".claude", "global-index");
    default:
      // Codex, Pi, and Jcode share host-neutral global storage.
      return path.join(os.homedir(), ".codebase-index", "global-index");
  }
}

export function getGlobalConfigPath(host: HostMode): string {
  switch (host) {
    case "opencode":
      return path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
    case "claude":
      return path.join(os.homedir(), ".claude", "codebase-index.json");
    default:
      // Codex, Pi, and Jcode share host-neutral global storage.
      return path.join(os.homedir(), ".config", "codebase-index", "config.json");
  }
}

export function resolveGlobalConfigPath(host: HostMode): string {
  const hostConfigPath = getGlobalConfigPath(host);
  if (existsSync(hostConfigPath)) {
    return hostConfigPath;
  }

  if (host !== "opencode") {
    const legacyConfigPath = getGlobalConfigPath("opencode");
    if (existsSync(legacyConfigPath)) {
      return legacyConfigPath;
    }
  }

  return hostConfigPath;
}

export function resolveGlobalIndexPath(host: HostMode): string {
  const hostIndexPath = getGlobalIndexPath(host);
  if (existsSync(hostIndexPath)) {
    return hostIndexPath;
  }

  if (host !== "opencode") {
    if (hasHostGlobalConfig(host)) {
      return hostIndexPath;
    }

    const legacyIndexPath = getGlobalIndexPath("opencode");
    if (existsSync(legacyIndexPath)) {
      return legacyIndexPath;
    }
  }

  return hostIndexPath;
}

export function resolveProjectConfigPath(projectRoot: string, host: HostMode): string {
  const candidates = getProjectConfigCandidatePaths(projectRoot, host);
  return candidates.find((candidate) => existsSync(candidate))
    ?? path.join(projectRoot, getProjectConfigRelativePath(host));
}

export function resolveWritableProjectConfigPath(projectRoot: string, host: HostMode): string {
  return path.join(projectRoot, getProjectConfigRelativePath(host));
}

export function resolveProjectIndexPath(
  projectRoot: string,
  scope: "project" | "global",
  host: HostMode,
): string {
  if (scope === "global") {
    return resolveGlobalIndexPath(host);
  }

  const localIndexPath = path.join(projectRoot, getProjectIndexRelativePath(host));
  const mainRepoRoot = resolveWorktreeMainRepoRoot(projectRoot);
  if (mainRepoRoot) {
    if (hasHostProjectConfig(projectRoot, host)) {
      return localIndexPath;
    }

    if (host !== "opencode") {
      const localLegacyConfigPath = path.join(projectRoot, OPENCODE_PROJECT_CONFIG_RELATIVE_PATH);
      if (existsSync(localLegacyConfigPath)) {
        return path.join(projectRoot, OPENCODE_PROJECT_INDEX_RELATIVE_PATH);
      }

      const mainHostConfigPath = path.join(mainRepoRoot, getProjectConfigRelativePath(host));
      const mainHostIndexPath = path.join(mainRepoRoot, getProjectIndexRelativePath(host));
      const mainLegacyConfigPath = path.join(mainRepoRoot, OPENCODE_PROJECT_CONFIG_RELATIVE_PATH);
      const mainLegacyIndexPath = path.join(mainRepoRoot, OPENCODE_PROJECT_INDEX_RELATIVE_PATH);
      if (
        !existsSync(mainHostConfigPath)
        && !existsSync(mainHostIndexPath)
        && (existsSync(mainLegacyConfigPath) || existsSync(mainLegacyIndexPath))
      ) {
        return mainLegacyIndexPath;
      }
    }

    // Project indexes use root-relative paths and are serialized by the shared
    // index lease, so inherited worktrees can safely reuse the main checkout.
    // A stale worktree-local index is ignored unless a local config opts out.
    return path.join(mainRepoRoot, getProjectIndexRelativePath(host));
  }

  if (existsSync(localIndexPath)) {
    return localIndexPath;
  }

  if (host !== "opencode") {
    const legacyIndexPath = path.join(projectRoot, OPENCODE_PROJECT_INDEX_RELATIVE_PATH);
    if (existsSync(legacyIndexPath) && !hasHostProjectConfig(projectRoot, host)) {
      return legacyIndexPath;
    }
  }

  if (hasHostProjectConfig(projectRoot, host)) {
    return localIndexPath;
  }

  const hostFallback = resolveWorktreeFallbackPath(projectRoot, getProjectIndexRelativePath(host));
  if (hostFallback) {
    return hostFallback;
  }

  if (host !== "opencode") {
    const legacyFallback = resolveWorktreeFallbackPath(projectRoot, OPENCODE_PROJECT_INDEX_RELATIVE_PATH);
    if (legacyFallback) {
      return legacyFallback;
    }
  }

  return localIndexPath;
}
