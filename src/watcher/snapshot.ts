import type { Dirent, Stats } from "node:fs";
import type { CodebaseIndexConfig } from "../config/schema.js";
import type { FileChange, FileChangeType } from "./file-watcher.js";

import { promises as fsPromises } from "node:fs";
import * as path from "node:path";

import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";

export interface FileSnapshotEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

export type FileSnapshotMap = ReadonlyMap<string, FileSnapshotEntry>;

export type SnapshotFilterConfig = Pick<
  CodebaseIndexConfig,
  "include" | "additionalInclude" | "exclude" | "indexing"
>;

export interface FileSnapshotScan {
  entries: FileSnapshotMap;
  unreadablePrefixes: ReadonlySet<string>;
}

export async function buildFileSnapshot(
  projectRoot: string,
  config: SnapshotFilterConfig,
  configPaths: string[] = [],
): Promise<FileSnapshotScan> {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const ignoreFilter = createIgnoreFilter(normalizedProjectRoot);
  const includePatterns = [...config.include, ...(config.additionalInclude ?? [])];
  const maxDepth = config.indexing?.maxDepth ?? -1;

  const snapshot = new Map<string, FileSnapshotEntry>();
  const unreadablePrefixes = new Set<string>();

  const includeFile = async (filePath: string): Promise<void> => {
    const normalizedPath = path.resolve(filePath);
    if (!shouldIncludeFile(
      normalizedPath,
      normalizedProjectRoot,
      includePatterns,
      config.exclude,
      ignoreFilter,
    )) {
      return;
    }

    const stat = await readStatIfFile(normalizedPath, unreadablePrefixes);
    if (!stat) return;

    snapshot.set(normalizedPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  };

  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingFsError(error)) {
        return;
      }
      if (isPermissionFsError(error)) {
        unreadablePrefixes.add(path.resolve(directoryPath));
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(normalizedProjectRoot, fullPath);

      if (entry.isDirectory()) {
        if (hasFilteredPathSegment(relativePath, path.sep) || isRestrictedDirectory(relativePath, path.sep)) {
          continue;
        }

        if (ignoreFilter.ignores(relativePath)) {
          continue;
        }

        if (maxDepth === -1 || depth < maxDepth) {
          await walk(fullPath, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) {
        await includeFile(fullPath);
      }
    }
  };

  await walk(normalizedProjectRoot, 0);

  await includeExplicitConfigPaths(snapshot, unreadablePrefixes, configPaths);
  return { entries: snapshot, unreadablePrefixes };
}

async function includeExplicitConfigPaths(
  snapshot: Map<string, FileSnapshotEntry>,
  unreadablePrefixes: Set<string>,
  configPaths: string[],
): Promise<void> {
  const explicitConfigPaths = [...new Set(configPaths.map((configPath) => path.resolve(configPath)))]
    .filter((configPath) => !snapshot.has(configPath));

  for (const configPath of explicitConfigPaths) {
    const stat = await readStatIfFile(configPath, unreadablePrefixes);
    if (!stat) {
      continue;
    }

    snapshot.set(configPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
}

async function readStatIfFile(filePath: string, unreadablePrefixes: Set<string>): Promise<Stats | null> {
  try {
    const stat = await fsPromises.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (isMissingFsError(error)) {
      return null;
    }
    if (isPermissionFsError(error)) {
      unreadablePrefixes.add(path.resolve(filePath));
      return null;
    }

    throw error;
  }
}

function isMissingFsError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) {
    return false;
  }

  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function isPermissionFsError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) {
    return false;
  }

  return ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export function completeFileSnapshot(
  previous: FileSnapshotMap | null,
  scan: FileSnapshotScan,
): FileSnapshotMap {
  const completed = new Map(scan.entries);
  if (previous === null) {
    return completed;
  }

  for (const unreadablePrefix of scan.unreadablePrefixes) {
    for (const [entryPath, entry] of previous) {
      if (entryPath === unreadablePrefix || entryPath.startsWith(unreadablePrefix + path.sep)) {
        if (!completed.has(entryPath)) {
          completed.set(entryPath, entry);
        }
      }
    }
  }

  return completed;
}

const diffTypeOrder: Record<FileChangeType, number> = {
  add: 0,
  change: 1,
  unlink: 2,
};

export function diffFileSnapshots(previous: FileSnapshotMap, current: FileSnapshotMap): FileChange[] {
  const changes: FileChange[] = [];

  for (const [path, previousEntry] of previous) {
    const currentEntry = current.get(path);
    if (!currentEntry) {
      changes.push({ type: "unlink", path });
    } else if (currentEntry.size !== previousEntry.size || currentEntry.mtimeMs !== previousEntry.mtimeMs) {
      changes.push({ type: "change", path });
    }
  }

  for (const [path] of current) {
    if (!previous.has(path)) {
      changes.push({ type: "add", path });
    }
  }

  return changes.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return diffTypeOrder[left.type] - diffTypeOrder[right.type];
  });
}
