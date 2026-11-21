import type { CodebaseIndexConfig } from "../config/schema.js";
import type { HostMode } from "../config/host.js";
import type { Indexer } from "../indexer/index.js";

import { parseConfig } from "../config/schema.js";
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
  whenReady(): Promise<void>;
  isBusy(): boolean;
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
  const parsedConfig = parseConfig(config);
  configureAutoIndex(projectRoot, host, parsedConfig, getIndexer, {
    synchronizeBackgroundWorker: false,
  });
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
    if (fileWatcher.hasProjectConfigChange(changes)) {
      const explicitConfig = options.configPath ? parseConfig(loadConfigFile(options.configPath)) : undefined;
      const refreshedConfig = refreshIndexerForDirectory(projectRoot, host, explicitConfig);
      if (refreshedConfig) {
        configureAutoIndex(projectRoot, host, refreshedConfig, getIndexer, {
          synchronizeBackgroundWorker: false,
        });
      }
    }
    requestReindex();
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
  const startup = (async () => {
    await gitWatcher?.waitUntilReady();
    await fileWatcher.waitUntilReady();
    // Catch edits between the initial index scan and subscription readiness.
    if (parsedConfig.indexing.autoIndex) requestReindex();
  })();

  return {
    isBusy() {
      return fileWatcher.isBusy() || (gitWatcher?.isBusy() ?? false);
    },
    async whenReady() {
      await startup;
      // Later observers must also wait for any backend replacement in progress.
      await fileWatcher.waitUntilReady();
    },
    async stop() {
      stopped = true;
      await Promise.all([fileWatcher.stop(), gitWatcher?.stop()]);
    },
  };
}
