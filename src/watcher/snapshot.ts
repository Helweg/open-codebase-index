import type { FileChange, FileChangeType } from "./file-watcher.js";

export interface FileSnapshotEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

export type FileSnapshotMap = ReadonlyMap<string, FileSnapshotEntry>;

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
