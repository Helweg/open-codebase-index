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

export async function buildFileSnapshot(
  projectRoot: string,
  config: Pick<CodebaseIndexConfig, "include" | "additionalInclude" | "exclude">,
  configPaths: string[] = [],
): Promise<FileSnapshotMap> {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const ignoreFilter = createIgnoreFilter(normalizedProjectRoot);
  const includePatterns = [...config.include, ...(config.additionalInclude ?? [])];

  const snapshot = new Map<string, FileSnapshotEntry>();

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

    const stat = await readStatIfFile(normalizedPath);
    if (!stat) return;

    snapshot.set(normalizedPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  };

  const walk = async (directoryPath: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (isIgnorableFsError(error)) {
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

        await walk(fullPath);
        continue;
      }

      if (entry.isFile()) {
        await includeFile(fullPath);
      }
    }
  };

  await walk(normalizedProjectRoot);

  await includeExplicitConfigPaths(snapshot, configPaths);
  return snapshot;
}

async function includeExplicitConfigPaths(
  snapshot: Map<string, FileSnapshotEntry>,
  configPaths: string[],
): Promise<void> {
  const explicitConfigPaths = [...new Set(configPaths.map((configPath) => path.resolve(configPath)))]
    .filter((configPath) => !snapshot.has(configPath));

  for (const configPath of explicitConfigPaths) {
    const stat = await readStatIfFile(configPath);
    if (!stat) {
      continue;
    }

    snapshot.set(configPath, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
}

async function readStatIfFile(filePath: string): Promise<Stats | null> {
  try {
    const stat = await fsPromises.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (isIgnorableFsError(error)) {
      return null;
    }

    throw error;
  }
}

function isIgnorableFsError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) {
    return false;
  }

  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
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
