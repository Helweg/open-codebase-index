import type { CodebaseIndexConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import type { Indexer } from "../indexer/index.js";

import { parseConfig } from "../config/schema.js";
import { resolveProjectConfigPath, resolveWritableProjectConfigPath } from "../config/paths.js";
import { loadConfigFile } from "../config/merger.js";
import { isGitRepo } from "../git/index.js";
import { refreshIndexerForDirectory } from "../tools/operations.js";
import { configureAutoIndex, requestBackgroundIndex } from "../utils/auto-index.js";
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

export function createWatcherWithIndexer(
  getIndexer: () => Indexer,
  projectRoot: string,
  config: CodebaseIndexConfig,
  host: HostMode,
  options: WatcherOptions = {},
): CombinedWatcher {
  const fileWatcher = new FileWatcher(projectRoot, config, host, options);
  configureAutoIndex(projectRoot, host, parseConfig(config), getIndexer);
  let stopped = false;
  const requestReindex = () => {
    if (stopped) return;
    void requestBackgroundIndex(projectRoot, host)?.then((result) => {
      if (result.outcome === "failed") {
        console.error("[codebase-index] Background reindex failed. Check index_status for details.");
      }
    });
  };

  fileWatcher.start(async (changes) => {
    const hasAddOrChange = changes.some(
      (c) => c.type === "add" || c.type === "change"
    );
    const hasDelete = changes.some((c) => c.type === "unlink");

    if (hasAddOrChange || hasDelete) {
      const configPaths = getConfigPaths(projectRoot, host, options);
      if (changes.some((change) => configPaths.includes(pathNormalize(change.path)))) {
        const parsedConfig = options.configPath ? parseConfig(loadConfigFile(options.configPath)) : undefined;
        const refreshedConfig = refreshIndexerForDirectory(projectRoot, host, parsedConfig);
        if (refreshedConfig) {
          configureAutoIndex(projectRoot, host, refreshedConfig, getIndexer);
        }
      }
      requestReindex();
    }
  });

  let gitWatcher: GitHeadWatcher | null = null;
  
  if (isGitRepo(projectRoot)) {
    gitWatcher = new GitHeadWatcher(projectRoot);
    gitWatcher.start(async (oldBranch, newBranch) => {
      const indexer = getIndexer();
      indexer.refreshBranchInfo();
      indexer.getLogger().branch("info", "Branch changed", {
        oldBranch,
        newBranch,
      });
      requestReindex();
    });
  }

  return {
    fileWatcher,
    gitWatcher,
    whenReady() {
      return fileWatcher.waitUntilReady();
    },
    async stop() {
      stopped = true;
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
