import type { CodebaseIndexConfig } from "../config/schema.js";
import { parseConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import { resolveProjectConfigPath, resolveWritableProjectConfigPath } from "../config/paths.js";
import { loadConfigFile } from "../config/merger.js";
import type { Indexer } from "../indexer/index.js";
import { isTransientIndexLockContention } from "../indexer/index-lock.js";
import { isGitRepo } from "../git/index.js";
import { refreshIndexerForDirectory } from "../tools/operations.js";
import { FileWatcher } from "./file-watcher.js";
import { GitHeadWatcher } from "./git-head-watcher.js";

export { FileWatcher } from "./file-watcher.js";
export type { ChangeHandler, FileChange, FileChangeType } from "./file-watcher.js";
export { GitHeadWatcher } from "./git-head-watcher.js";
export type { BranchChangeHandler } from "./git-head-watcher.js";

export interface CombinedWatcher {
  fileWatcher: FileWatcher;
  gitWatcher: GitHeadWatcher | null;
  whenReady(): Promise<void>;
  stop(): Promise<void>;
}

export interface WatcherOptions {
  configPath?: string;
}

class BackgroundReindexer {
  private running = false;
  private pending = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = 50;

  constructor(private readonly runIndex: () => Promise<void>) {}

  request(): void {
    if (this.stopped) {
      return;
    }

    this.pending = true;
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.pending = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private drain(): void {
    if (this.stopped || this.running || this.retryTimer || !this.pending) {
      return;
    }

    this.pending = false;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    let retryAfterContention = false;
    try {
      await this.runIndex();
      this.retryDelayMs = 50;
    } catch (error) {
      if (isTransientIndexLockContention(error)) {
        this.pending = true;
        retryAfterContention = true;
      } else {
        console.error("[codebase-index] Background reindex failed:", error);
      }
    } finally {
      this.running = false;
      if (retryAfterContention && !this.stopped) {
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 500);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.drain();
        }, delay);
      } else {
        this.drain();
      }
    }
  }
}

export function createWatcherWithIndexer(
  getIndexer: () => Indexer,
  projectRoot: string,
  config: CodebaseIndexConfig,
  host: HostMode = "opencode",
  options: WatcherOptions = {},
): CombinedWatcher {
  const fileWatcher = new FileWatcher(projectRoot, config, host, options);
  const backgroundReindexer = new BackgroundReindexer(async () => {
    await getIndexer().index();
  });

  fileWatcher.start(async (changes) => {
    const hasAddOrChange = changes.some(
      (c) => c.type === "add" || c.type === "change"
    );
    const hasDelete = changes.some((c) => c.type === "unlink");

    if (hasAddOrChange || hasDelete) {
      const configPaths = getConfigPaths(projectRoot, host, options);
      if (changes.some((change) => configPaths.includes(pathNormalize(change.path)))) {
        const parsedConfig = options.configPath ? parseConfig(loadConfigFile(options.configPath)) : undefined;
        refreshIndexerForDirectory(projectRoot, host, parsedConfig);
      }
      backgroundReindexer.request();
    }
  });

  let gitWatcher: GitHeadWatcher | null = null;
  
  if (isGitRepo(projectRoot)) {
    gitWatcher = new GitHeadWatcher(projectRoot);
    gitWatcher.start(async (oldBranch, newBranch) => {
      console.log(`Branch changed: ${oldBranch ?? "(none)"} -> ${newBranch}`);
      backgroundReindexer.request();
    });
  }

  return {
    fileWatcher,
    gitWatcher,
    whenReady() {
      return fileWatcher.waitUntilReady();
    },
    async stop() {
      backgroundReindexer.stop();
      await Promise.all([fileWatcher.stop(), gitWatcher?.stop()]);
    },
  };
}

function pathNormalize(value: string): string {
  return value.split("\\").join("/");
}

function getConfigPaths(projectRoot: string, host: HostMode, options: WatcherOptions): string[] {
  if (options.configPath) {
    return [pathNormalize(options.configPath)];
  }

  return [
    resolveProjectConfigPath(projectRoot, host),
    resolveWritableProjectConfigPath(projectRoot, host),
  ].map((configPath) => pathNormalize(configPath));
}
