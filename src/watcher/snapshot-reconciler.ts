import type { CodebaseIndexConfig } from "../config/schema.js";
import type { FileChange } from "./file-watcher.js";

import { buildFileSnapshot, diffFileSnapshots, type FileSnapshotMap } from "./snapshot.js";

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

  async reconcile(): Promise<FileChange[]> {
    if (this.snapshot === null) {
      throw new Error("FileSnapshotReconciler is not initialized. Call initialize() before reconcile().");
    }

    const reconciliation = this.reconciliationTail.then(async () => {
      const previousSnapshot = this.snapshot;
      if (previousSnapshot === null) {
        throw new Error("FileSnapshotReconciler is not initialized. Call initialize() before reconcile().");
      }

      const nextSnapshot = await buildFileSnapshot(this.projectRoot, this.config, this.configPaths);
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
}
