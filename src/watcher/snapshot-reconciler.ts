import type { CodebaseIndexConfig } from "../config/schema.js";
import type { FileChange } from "./file-watcher.js";

import {
  buildFileSnapshot,
  buildFileSnapshotForPath,
  diffFileSnapshots,
  isWithinPath,
  type FileSnapshotMap,
} from "./snapshot.js";

export type SnapshotFilterConfig = Pick<CodebaseIndexConfig, "include" | "additionalInclude" | "exclude">;

export class FileSnapshotReconciler {
  private snapshot: FileSnapshotMap | null = null;
  private reconciliationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly config: SnapshotFilterConfig,
    private readonly configPaths: string[],
  ) {}

  async initialize(): Promise<void> {
    this.snapshot = await buildFileSnapshot(this.projectRoot, this.config, this.configPaths);
  }

  async reconcile(invalidatedPaths: readonly (string | null)[] = []): Promise<FileChange[]> {
    if (this.snapshot === null) {
      throw new Error("FileSnapshotReconciler is not initialized. Call initialize() before reconcile().");
    }

    const reconciliation = this.reconciliationTail.then(async () => {
      const previousSnapshot = this.snapshot;
      if (previousSnapshot === null) {
        throw new Error("FileSnapshotReconciler is not initialized. Call initialize() before reconcile().");
      }

      const scopedPaths = invalidatedPaths.filter((filePath): filePath is string => filePath !== null);
      const nextSnapshot = scopedPaths.length === 0 || scopedPaths.length !== invalidatedPaths.length
        ? await buildFileSnapshot(this.projectRoot, this.config, this.configPaths)
        : await this.reconcilePaths(previousSnapshot, scopedPaths);
      const changes = diffFileSnapshots(previousSnapshot, nextSnapshot);
      this.snapshot = nextSnapshot;
      return changes;
    });
    this.reconciliationTail = reconciliation.then(
      () => undefined,
      () => undefined,
    );
    return reconciliation;
  }

  private async reconcilePaths(
    previousSnapshot: FileSnapshotMap,
    invalidatedPaths: readonly string[],
  ): Promise<FileSnapshotMap> {
    const scopes = this.getScopes(invalidatedPaths);
    const nextSnapshot = new Map(previousSnapshot);

    for (const scope of scopes) {
      for (const previousPath of nextSnapshot.keys()) {
        if (isWithinPath(scope, previousPath)) {
          nextSnapshot.delete(previousPath);
        }
      }

      const scopedSnapshot = await buildFileSnapshotForPath(
        this.projectRoot,
        this.config,
        this.configPaths,
        scope,
      );
      for (const [filePath, entry] of scopedSnapshot) {
        nextSnapshot.set(filePath, entry);
      }
    }

    return nextSnapshot;
  }

  private getScopes(invalidatedPaths: readonly string[]): string[] {
    const uniquePaths = [...new Set(invalidatedPaths)].sort((left, right) => left.length - right.length);
    return uniquePaths.filter((candidate, index) => !uniquePaths.slice(0, index).some(
      (ancestor) => isWithinPath(ancestor, candidate),
    ));
  }
}
