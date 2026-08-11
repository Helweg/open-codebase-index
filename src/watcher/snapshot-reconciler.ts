import type { FileChange } from "./file-watcher.js";

import {
  buildFileSnapshotScan,
  buildFileSnapshotForPathScan,
  completeFileSnapshot,
  diffFileSnapshots,
  isWithinPath,
  type FileSnapshotMap,
  type FileSnapshotScan,
  type SnapshotFilterConfig,
} from "./snapshot.js";

export type { SnapshotFilterConfig } from "./snapshot.js";

export type SnapshotInvalidation = string | null | {
  path: string | null;
  forceChange?: boolean;
};

export class FileSnapshotReconciler {
  private snapshot: FileSnapshotMap | null = null;
  private reconciliationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly config: SnapshotFilterConfig,
    private readonly configPaths: string[],
  ) {}

  async initialize(): Promise<void> {
    this.snapshot = (await buildFileSnapshotScan(this.projectRoot, this.config, this.configPaths)).entries;
  }

  async reconcile(invalidations: readonly SnapshotInvalidation[] = []): Promise<FileChange[]> {
    if (this.snapshot === null) {
      throw new Error("FileSnapshotReconciler is not initialized. Call initialize() before reconcile().");
    }

    const reconciliation = this.reconciliationTail.then(async () => {
      const previousSnapshot = this.snapshot;
      if (previousSnapshot === null) {
        throw new Error("FileSnapshotReconciler is not initialized. Call initialize() before reconcile().");
      }

      const normalizedInvalidations = invalidations.map((invalidation) => typeof invalidation === "string" || invalidation === null
        ? { path: invalidation, forceChange: false }
        : { path: invalidation.path, forceChange: invalidation.forceChange === true });
      const scopedPaths = normalizedInvalidations
        .map((invalidation) => invalidation.path)
        .filter((filePath): filePath is string => filePath !== null);
      const scan = scopedPaths.length === 0 || scopedPaths.length !== normalizedInvalidations.length
        ? await buildFileSnapshotScan(this.projectRoot, this.config, this.configPaths)
        : await this.reconcilePaths(previousSnapshot, scopedPaths);
      const nextSnapshot = completeFileSnapshot(previousSnapshot, scan);
      const forcedChanges = new Set(normalizedInvalidations
        .filter((invalidation): invalidation is { path: string; forceChange: true } => (
          invalidation.path !== null && invalidation.forceChange
        ))
        .map((invalidation) => invalidation.path));
      const changes = diffFileSnapshots(previousSnapshot, nextSnapshot, forcedChanges);
      this.snapshot = nextSnapshot;
      return changes;
    });
    this.reconciliationTail = reconciliation.then(() => undefined, () => undefined);
    return reconciliation;
  }

  private async reconcilePaths(
    previousSnapshot: FileSnapshotMap,
    invalidatedPaths: readonly string[],
  ): Promise<FileSnapshotScan> {
    const scopes = this.getScopes(invalidatedPaths);
    const entries = new Map(previousSnapshot);
    const unreadablePrefixes = new Set<string>();

    for (const scope of scopes) {
      for (const previousPath of entries.keys()) {
        if (isWithinPath(scope, previousPath)) entries.delete(previousPath);
      }

      const scopedScan = await buildFileSnapshotForPathScan(this.projectRoot, this.config, this.configPaths, scope);
      for (const [filePath, entry] of scopedScan.entries) entries.set(filePath, entry);
      for (const unreadablePrefix of scopedScan.unreadablePrefixes) unreadablePrefixes.add(unreadablePrefix);
    }

    return { entries, unreadablePrefixes };
  }

  private getScopes(invalidatedPaths: readonly string[]): string[] {
    const uniquePaths = [...new Set(invalidatedPaths)].sort((left, right) => left.length - right.length);
    return uniquePaths.filter((candidate, index) => !uniquePaths.slice(0, index).some(
      (ancestor) => isWithinPath(ancestor, candidate),
    ));
  }
}
