import type { ToolDefinition } from "@opencode-ai/plugin";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig, type ParsedCodebaseIndexConfig } from "../config/schema.js";
import { loadMergedConfig } from "../config/merger.js";
import { createWatcherWithIndexer } from "../watcher/index.js";
import {
  codebase_search,
  codebase_context,
  codebase_edit_context,
  codebase_peek,
  index_codebase,
  index_status,
  index_health_check,
  index_metrics,
  index_logs,
  find_similar,
  call_graph,
  call_graph_path,
  architecture_context,
  code_communities,
  implementation_lookup,
  add_knowledge_base,
  list_knowledge_bases,
  remove_knowledge_base,
  index_visualize,
  getIndexerForProject,
  initializeTools,
  pr_impact,
  repository_history_sync,
  repository_history_search,
  repository_history_status,
  repository_history_clear,
} from "../tools/index.js";
import { TOOL_NAME } from "../tools/tool-names.js";
import { loadCommandsFromDirectory, type CommandDefinition } from "../commands/loader.js";
import { RoutingHintController } from "../routing-hints.js";
import { configureBackgroundWorker, stopBackgroundWorker, waitForBackgroundWorkerStart } from "../utils/background-worker.js";
import {
  getProjectSafety,
  startAutoIndexForBackgroundWorker,
  stopAutoIndexForBackgroundWorker,
} from "../utils/auto-index.js";
import { isGitRepo } from "../git/index.js";

export function resolveOpenCodeProjectRoot(directory: string, worktree?: string): string {
  if (worktree && isGitRepo(worktree)) {
    return worktree;
  }

  return directory;
}

export function getCommandsDir(): string {
  let currentDir = process.cwd();

  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }

  const packageRoot = path.basename(currentDir) === "adapters"
    ? path.join(currentDir, "..", "..")
    : path.join(currentDir, "..");

  return path.join(packageRoot, "commands");
}

export function loadOpenCodeCommands(): Map<string, CommandDefinition> {
  return loadCommandsFromDirectory(getCommandsDir());
}

export async function prepareOpenCodeSession(
  projectRoot: string,
  options: { waitForUnsafeWorkerStop: boolean },
): Promise<{
  config: ParsedCodebaseIndexConfig;
  routingHints: RoutingHintController | null;
  isValidProject: boolean;
  workerConfigured: boolean;
}> {
  const rawConfig = loadMergedConfig(projectRoot, "opencode");
  const config = parseConfig(rawConfig);

  initializeTools(projectRoot, config);

  const getProjectIndexer = () => getIndexerForProject(projectRoot);
  const routingHints = config.search.routingHints
    ? new RoutingHintController(() => getProjectIndexer().getStatus(), 200, config.search.routingGraphHandoffHints)
    : null;

  const projectSafety = getProjectSafety(projectRoot, config);
  const isHomeDir = projectSafety.blockedReason === "home-directory";
  const isValidProject = projectSafety.safeToRun;

  if (isHomeDir) {
    console.warn(
      `[codebase-index] Refusing to watch or index home directory "${projectRoot}". ` +
      `Open a specific project directory instead.`
    );
  } else if (!isValidProject) {
    console.warn(
      `[codebase-index] Skipping file watching and auto-indexing: no project marker found in "${projectRoot}". ` +
      `Set "indexing.requireProjectMarker": false in config to override.`
    );
  }

  if (!isValidProject) {
    await stopOpenCodeWorker(projectRoot, { waitForCompletion: options.waitForUnsafeWorkerStop });
    return { config, routingHints, isValidProject, workerConfigured: false };
  }

  const watcherFactoryForConfig = (refreshedConfig: ParsedCodebaseIndexConfig) => (
    refreshedConfig.indexing.watchFiles
      ? () => createWatcherWithIndexer(getProjectIndexer, projectRoot, refreshedConfig, "opencode")
      : null
  );
  configureBackgroundWorker(projectRoot, "opencode", config, {
    startAutoIndex: (source, allowDisabledAutoIndex) => {
      startAutoIndexForBackgroundWorker(projectRoot, "opencode", source, allowDisabledAutoIndex);
    },
    stopAutoIndex: () => stopAutoIndexForBackgroundWorker(projectRoot, "opencode"),
    watcherFactory: watcherFactoryForConfig(config),
    watcherFactoryForConfig,
    replaceWatcher: true,
  }, {
    restartAutoIndex: true,
  });
  const workerConfigured = true;
  await waitForBackgroundWorkerStart(projectRoot, "opencode");

  return { config, routingHints, isValidProject, workerConfigured };
}

export async function stopOpenCodeWorker(
  projectRoot: string,
  options: { waitForCompletion: boolean },
): Promise<void> {
  const stopped = options.waitForCompletion
    ? stopBackgroundWorker(projectRoot, "opencode", true)
    : stopBackgroundWorker(projectRoot, "opencode");
  await stopped.catch((error: unknown) => {
    console.error("[codebase-index] Failed to stop unsafe OpenCode background worker:", error);
  });
}

export function openCodeToolDefinitions(): Record<string, ToolDefinition> {
  return {
    [TOOL_NAME.CODEBASE_CONTEXT]: codebase_context,
    [TOOL_NAME.CODEBASE_EDIT_CONTEXT]: codebase_edit_context,
    [TOOL_NAME.CODEBASE_SEARCH]: codebase_search,
    [TOOL_NAME.CODEBASE_PEEK]: codebase_peek,
    [TOOL_NAME.INDEX_CODEBASE]: index_codebase,
    [TOOL_NAME.INDEX_STATUS]: index_status,
    [TOOL_NAME.INDEX_HEALTH_CHECK]: index_health_check,
    [TOOL_NAME.INDEX_METRICS]: index_metrics,
    [TOOL_NAME.INDEX_LOGS]: index_logs,
    [TOOL_NAME.FIND_SIMILAR]: find_similar,
    [TOOL_NAME.CALL_GRAPH]: call_graph,
    [TOOL_NAME.CALL_GRAPH_PATH]: call_graph_path,
    [TOOL_NAME.IMPLEMENTATION_LOOKUP]: implementation_lookup,
    [TOOL_NAME.ADD_KNOWLEDGE_BASE]: add_knowledge_base,
    [TOOL_NAME.LIST_KNOWLEDGE_BASES]: list_knowledge_bases,
    [TOOL_NAME.REMOVE_KNOWLEDGE_BASE]: remove_knowledge_base,
    [TOOL_NAME.PR_IMPACT]: pr_impact,
    [TOOL_NAME.ARCHITECTURE_CONTEXT]: architecture_context,
    [TOOL_NAME.CODE_COMMUNITIES]: code_communities,
    [TOOL_NAME.INDEX_VISUALIZE]: index_visualize,
    [TOOL_NAME.REPOSITORY_HISTORY_SYNC]: repository_history_sync,
    [TOOL_NAME.REPOSITORY_HISTORY_SEARCH]: repository_history_search,
    [TOOL_NAME.REPOSITORY_HISTORY_STATUS]: repository_history_status,
    [TOOL_NAME.REPOSITORY_HISTORY_CLEAR]: repository_history_clear,
  };
}
