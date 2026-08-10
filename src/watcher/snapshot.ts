import type { Dirent, Stats } from "node:fs";
import type { CodebaseIndexConfig } from "../config/schema.js";
import type { FileChange, FileChangeType } from "./file-watcher.js";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";

export interface FileSnapshotEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

export type FileSnapshotMap = ReadonlyMap<string, FileSnapshotEntry>;
export type SnapshotFilterConfig = Pick<CodebaseIndexConfig, "include" | "additionalInclude" | "exclude"> & {
  indexing?: { maxDepth?: number };
};

export interface FileSnapshotScan {
  readonly entries: FileSnapshotMap;
  readonly unreadablePrefixes: ReadonlySet<string>;
}

export async function buildFileSnapshot(
  projectRoot: string,
  config: SnapshotFilterConfig,
  configPaths: string[] = [],
): Promise<FileSnapshotMap> {
  return (await buildFileSnapshotScan(projectRoot, config, configPaths)).entries;
}

export async function buildFileSnapshotScan(
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
    if (!shouldIncludeFile(normalizedPath, normalizedProjectRoot, includePatterns, config.exclude, ignoreFilter)) return;

    const stat = await readStatIfFile(normalizedPath, unreadablePrefixes);
    if (stat) snapshot.set(normalizedPath, { size: stat.size, mtimeMs: stat.mtimeMs });
  };

  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingFsError(error)) return;
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
        if (hasFilteredPathSegment(relativePath, path.sep) || isRestrictedDirectory(relativePath, path.sep)) continue;
        if (ignoreFilter.ignores(relativePath)) continue;
        if (maxDepth === -1 || depth < maxDepth) await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        await includeFile(fullPath);
      }
    }
  };

  await walk(normalizedProjectRoot, 0);
  await includeExplicitConfigPaths(snapshot, unreadablePrefixes, configPaths);
  return { entries: snapshot, unreadablePrefixes };
}

export async function buildFileSnapshotForPath(
  projectRoot: string,
  config: SnapshotFilterConfig,
  configPaths: string[],
  targetPath: string,
): Promise<FileSnapshotMap> {
  return (await buildFileSnapshotForPathScan(projectRoot, config, configPaths, targetPath)).entries;
}

export async function buildFileSnapshotForPathScan(
  projectRoot: string,
  config: SnapshotFilterConfig,
  configPaths: string[],
  targetPath: string,
): Promise<FileSnapshotScan> {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const normalizedTargetPath = path.resolve(targetPath);
  if (!isWithinPath(normalizedProjectRoot, normalizedTargetPath)) {
    return { entries: new Map(), unreadablePrefixes: new Set() };
  }

  const ignoreFilter = createIgnoreFilter(normalizedProjectRoot);
  const includePatterns = [...config.include, ...(config.additionalInclude ?? [])];
  const maxDepth = config.indexing?.maxDepth ?? -1;
  const explicitConfigPaths = new Set(configPaths.map((configPath) => path.resolve(configPath)));
  const snapshot = new Map<string, FileSnapshotEntry>();
  const unreadablePrefixes = new Set<string>();

  const includeFile = async (filePath: string): Promise<void> => {
    const normalizedPath = path.resolve(filePath);
    if (!explicitConfigPaths.has(normalizedPath) && !shouldIncludeFile(
      normalizedPath, normalizedProjectRoot, includePatterns, config.exclude, ignoreFilter,
    )) return;
    const stat = await readStatIfFile(normalizedPath, unreadablePrefixes);
    if (stat) snapshot.set(normalizedPath, { size: stat.size, mtimeMs: stat.mtimeMs });
  };

  const walk = async (directoryPath: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isMissingFsError(error)) return;
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
        if (hasFilteredPathSegment(relativePath, path.sep) || isRestrictedDirectory(relativePath, path.sep)) continue;
        if (ignoreFilter.ignores(relativePath)) continue;
        if (maxDepth === -1 || depth < maxDepth) await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        await includeFile(fullPath);
      }
    }
  };

  const targetStat = await readStatIfFile(normalizedTargetPath, unreadablePrefixes);
  if (targetStat) await includeFile(normalizedTargetPath);
  else await walk(normalizedTargetPath, 0);
  await includeExplicitConfigPathsInPath(snapshot, unreadablePrefixes, configPaths, normalizedTargetPath);
  return { entries: snapshot, unreadablePrefixes };
}

export function completeFileSnapshot(previous: FileSnapshotMap, scan: FileSnapshotScan): FileSnapshotMap {
  const completed = new Map(scan.entries);
  for (const unreadablePrefix of scan.unreadablePrefixes) {
    for (const [entryPath, entry] of previous) {
      if (isWithinPath(unreadablePrefix, entryPath) && !completed.has(entryPath)) completed.set(entryPath, entry);
    }
  }
  return completed;
}

async function includeExplicitConfigPaths(
  snapshot: Map<string, FileSnapshotEntry>,
  unreadablePrefixes: Set<string>,
  configPaths: string[],
): Promise<void> {
  for (const configPath of [...new Set(configPaths.map((value) => path.resolve(value)))]) {
    if (snapshot.has(configPath)) continue;
    const stat = await readStatIfFile(configPath, unreadablePrefixes);
    if (stat) snapshot.set(configPath, { size: stat.size, mtimeMs: stat.mtimeMs });
  }
}

async function includeExplicitConfigPathsInPath(
  snapshot: Map<string, FileSnapshotEntry>,
  unreadablePrefixes: Set<string>,
  configPaths: string[],
  targetPath: string,
): Promise<void> {
  await includeExplicitConfigPaths(
    snapshot,
    unreadablePrefixes,
    configPaths.filter((configPath) => isWithinPath(targetPath, path.resolve(configPath))),
  );
}

export function isWithinPath(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

async function readStatIfFile(filePath: string, unreadablePrefixes: Set<string>): Promise<Stats | null> {
  try {
    const stat = await fsPromises.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (isMissingFsError(error)) return null;
    if (isPermissionFsError(error)) {
      unreadablePrefixes.add(path.resolve(filePath));
      return null;
    }
    throw error;
  }
}

function isMissingFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function isPermissionFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

const diffTypeOrder: Record<FileChangeType, number> = { add: 0, change: 1, unlink: 2 };

export function diffFileSnapshots(previous: FileSnapshotMap, current: FileSnapshotMap): FileChange[] {
  const changes: FileChange[] = [];
  for (const [filePath, previousEntry] of previous) {
    const currentEntry = current.get(filePath);
    if (!currentEntry) changes.push({ type: "unlink", path: filePath });
    else if (currentEntry.size !== previousEntry.size || currentEntry.mtimeMs !== previousEntry.mtimeMs) {
      changes.push({ type: "change", path: filePath });
    }
  }
  for (const [filePath] of current) {
    if (!previous.has(filePath)) changes.push({ type: "add", path: filePath });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path) || diffTypeOrder[left.type] - diffTypeOrder[right.type]);
}
