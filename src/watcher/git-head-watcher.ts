import chokidar, { FSWatcher } from "chokidar";
import * as path from "path";

import { getCurrentBranch, getHeadPath, isGitRepo } from "../git/index.js";

export type BranchChangeHandler = (oldBranch: string | null, newBranch: string) => Promise<void>;

/**
 * Watches .git/HEAD for branch changes.
 * When HEAD changes (branch switch, checkout), triggers callback with old and new branch.
 */
export class GitHeadWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private currentBranch: string | null = null;
  private onBranchChange: BranchChangeHandler | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 100; // Short debounce for git operations

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  start(handler: BranchChangeHandler): void {
    if (this.watcher) {
      return;
    }

    if (!isGitRepo(this.projectRoot)) {
      return; // Not a git repo, nothing to watch
    }

    this.onBranchChange = handler;
    this.currentBranch = getCurrentBranch(this.projectRoot);

    const headPath = getHeadPath(this.projectRoot);

    // Also watch refs/heads for when branches are updated
    const refsPath = path.join(this.projectRoot, ".git", "refs", "heads");

    this.watcher = chokidar.watch([headPath, refsPath], {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    this.watcher.on("change", () => this.handleHeadChange());
    this.watcher.on("add", () => this.handleHeadChange());
  }

  private handleHeadChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.checkBranchChange();
    }, this.debounceMs);
  }

  private async checkBranchChange(): Promise<void> {
    const newBranch = getCurrentBranch(this.projectRoot);

    if (newBranch && newBranch !== this.currentBranch && this.onBranchChange) {
      const oldBranch = this.currentBranch;
      this.currentBranch = newBranch;

      try {
        await this.onBranchChange(oldBranch, newBranch);
      } catch (error) {
        console.error("Error handling branch change:", error);
      }
    } else if (newBranch) {
      this.currentBranch = newBranch;
    }
  }

  getCurrentBranch(): string | null {
    return this.currentBranch;
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.close();
    }

    this.onBranchChange = null;
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }
}
