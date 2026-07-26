import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

import type { HostMode } from "./host.js";
import { resolveWorktreeMainRepoRoot } from "../git/index.js";

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

export function resolveWorktreeFallbackProjectIndexPath(projectRoot: string, host: HostMode): string | null {
  const inheritedHostPath = resolveWorktreeFallbackPath(projectRoot, getProjectIndexRelativePath(host));
  if (inheritedHostPath) {
    return inheritedHostPath;
  }

  if (host !== "opencode") {
    return resolveWorktreeFallbackPath(projectRoot, OPENCODE_PROJECT_INDEX_RELATIVE_PATH);
  }

  return null;
}

export function getHostProjectConfigRelativePath(host: HostMode): string {
  return getProjectConfigRelativePath(host);
}

export function getHostProjectIndexRelativePath(host: HostMode): string {
  return getProjectIndexRelativePath(host);
}

function hasHostProjectConfig(projectRoot: string, host: HostMode): boolean {
  return existsSync(path.join(projectRoot, getProjectConfigRelativePath(host)));
}

function hasHostGlobalConfig(host: HostMode): boolean {
  return existsSync(getGlobalConfigPath(host));
}

export function getGlobalIndexPath(host: HostMode = "opencode"): string {
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

export function getGlobalConfigPath(host: HostMode = "opencode"): string {
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

export function resolveGlobalConfigPath(host: HostMode = "opencode"): string {
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

export function resolveGlobalIndexPath(host: HostMode = "opencode"): string {
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

export function resolveProjectConfigPath(projectRoot: string, host: HostMode = "opencode"): string {
  const hostConfigPath = path.join(projectRoot, getProjectConfigRelativePath(host));
  if (existsSync(hostConfigPath)) {
    return hostConfigPath;
  }

  if (host !== "opencode") {
    const legacyConfigPath = path.join(projectRoot, OPENCODE_PROJECT_CONFIG_RELATIVE_PATH);
    if (existsSync(legacyConfigPath)) {
      return legacyConfigPath;
    }
  }

  const hostFallback = resolveWorktreeFallbackPath(projectRoot, getProjectConfigRelativePath(host));
  if (hostFallback) {
    return hostFallback;
  }

  if (host !== "opencode") {
    const legacyFallback = resolveWorktreeFallbackPath(projectRoot, OPENCODE_PROJECT_CONFIG_RELATIVE_PATH);
    if (legacyFallback) {
      return legacyFallback;
    }
  }

  return hostConfigPath;
}

export function resolveWritableProjectConfigPath(projectRoot: string, host: HostMode = "opencode"): string {
  return path.join(projectRoot, getProjectConfigRelativePath(host));
}

export function resolveProjectIndexPath(
  projectRoot: string,
  scope: "project" | "global",
  host: HostMode = "opencode",
): string {
  if (scope === "global") {
    return resolveGlobalIndexPath(host);
  }

  const localIndexPath = path.join(projectRoot, getProjectIndexRelativePath(host));
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
