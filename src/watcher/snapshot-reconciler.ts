import type { FileChange } from "./file-watcher.js";

import {
  buildFileSnapshot,
  completeFileSnapshot,
  diffFileSnapshots,
  type FileSnapshotMap,
  type SnapshotFilterConfig,
} from "./snapshot.js";

export { type SnapshotFilterConfig } from "./snapshot.js";

export class FileSnapshotReconciler {
  private snapshot: FileSnapshotMap | null = null;
  private reconciliationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly config: SnapshotFilterConfig,
    private readonly configPaths: string[],
  ) {}

  async initialize(): Promise<void> {
    this.snapshot = (await buildFileSnapshot(this.projectRoot, this.config, this.configPaths)).entries;
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

      const scan = await buildFileSnapshot(this.projectRoot, this.config, this.configPaths);
      const completedSnapshot = completeFileSnapshot(previousSnapshot, scan);
      const changes = diffFileSnapshots(previousSnapshot, completedSnapshot);
      this.snapshot = completedSnapshot;
      return changes;
    });
    this.reconciliationTail = reconciliation.then(
      () => undefined,
      () => undefined,
    );
    return reconciliation;
  }
}
