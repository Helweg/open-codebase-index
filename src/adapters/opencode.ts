import type { Plugin } from "@opencode-ai/plugin";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "../config/schema.js";
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
  code_communities,
  implementation_lookup,
  add_knowledge_base,
  list_knowledge_bases,
  remove_knowledge_base,
  index_visualize,
  getIndexerForProject,
  initializeTools,
  pr_impact,
} from "../tools/index.js";
import { TOOL_NAME } from "../tools/tool-names.js";
import { loadCommandsFromDirectory } from "../commands/loader.js";
import { RoutingHintController } from "../routing-hints.js";
import { isHomeDirectory, startAutoIndex } from "../utils/auto-index.js";
import { hasProjectMarker } from "../utils/files.js";
import { isGitRepo } from "../git/index.js";
import type { CombinedWatcher } from "../watcher/index.js";

const activeWatchers = new Map<string, CombinedWatcher>();
const watcherReplacementChains = new Map<string, Promise<void>>();

async function replaceActiveWatcher(
  projectRoot: string,
  createNextWatcher: (() => CombinedWatcher) | null,
): Promise<void> {
  const chain = (watcherReplacementChains.get(projectRoot) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const existing = activeWatchers.get(projectRoot);
      if (existing) {
        try {
          await existing.stop();
        } catch (error) {
          console.error("[codebase-index] Failed to stop replaced watcher:", error);
          throw error;
        }
        if (activeWatchers.get(projectRoot) === existing) {
          activeWatchers.delete(projectRoot);
        }
      }
      if (createNextWatcher) {
        activeWatchers.set(projectRoot, createNextWatcher());
      }
    });
  watcherReplacementChains.set(projectRoot, chain);
  try {
    await chain;
  } finally {
    if (watcherReplacementChains.get(projectRoot) === chain) {
      watcherReplacementChains.delete(projectRoot);
    }
  }
}

function getCommandsDir(): string {
  let currentDir = process.cwd();

  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }

  const packageRoot = path.basename(currentDir) === "adapters"
    ? path.join(currentDir, "..", "..")
    : path.join(currentDir, "..");

  return path.join(packageRoot, "commands");
}

function appendRoutingHints(
  output: { system?: string[]; developer?: string[] },
  hints: string[],
  preferredRole: "system" | "developer",
): void {
  const preferredBucket = preferredRole === "developer" ? output.developer : output.system;
  if (Array.isArray(preferredBucket)) {
    preferredBucket.push(...hints);
    return;
  }

  // Compatibility fallback for runtimes that do not expose a developer channel yet.
  if (Array.isArray(output.system)) {
    output.system.push(...hints);
  }
}

function resolveProjectRoot(directory: string, worktree?: string): string {
  if (worktree && isGitRepo(worktree)) {
    return worktree;
  }

  return directory;
}

interface ChatTransformInput {
  sessionID?: string;
}

interface ChatTransformOutput {
  system?: string[];
  developer?: string[];
}

const plugin: Plugin = async ({ directory, worktree }) => {
  try {
    const projectRoot = resolveProjectRoot(directory, worktree);
    const rawConfig = loadMergedConfig(projectRoot, "opencode");
    const config = parseConfig(rawConfig);

    initializeTools(projectRoot, config);

    const getProjectIndexer = () => getIndexerForProject(projectRoot);
    const routingHints = config.search.routingHints
      ? new RoutingHintController(() => getProjectIndexer().getStatus(), 200, config.search.routingGraphHandoffHints)
      : null;

    const isHomeDir = isHomeDirectory(projectRoot);
    const isValidProject = !isHomeDir && (!config.indexing.requireProjectMarker || hasProjectMarker(projectRoot));

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

    if (config.indexing.autoIndex && isValidProject) {
      startAutoIndex(projectRoot, "opencode", "startup");
    }

    if (config.indexing.watchFiles && isValidProject) {
      await replaceActiveWatcher(
        projectRoot,
        () => createWatcherWithIndexer(getProjectIndexer, projectRoot, config, "opencode"),
      );
    } else {
      await replaceActiveWatcher(projectRoot, null);
    }

    return {
      tool: {
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
        [TOOL_NAME.CODE_COMMUNITIES]: code_communities,
        [TOOL_NAME.INDEX_VISUALIZE]: index_visualize,
      },

      async "chat.message"(input, output) {
        routingHints?.observeUserMessage(input.sessionID, output.parts);
      },

      async "experimental.chat.system.transform"(input: ChatTransformInput, output: ChatTransformOutput) {
        if (config.search.routingHintRole !== "system") {
          return;
        }

        const hints = await routingHints?.getSystemHints(input.sessionID) ?? [];
        appendRoutingHints(output, hints, "system");
      },

      async "experimental.chat.developer.transform"(input: ChatTransformInput, output: ChatTransformOutput) {
        if (config.search.routingHintRole !== "developer") {
          return;
        }

        const hints = await routingHints?.getSystemHints(input.sessionID) ?? [];
        appendRoutingHints(output, hints, "developer");
      },

      async "tool.execute.after"(input) {
        routingHints?.markToolUsed(input.sessionID, input.tool);
      },

      async config(cfg) {
        cfg.command = cfg.command ?? {};

        const commandsDir = getCommandsDir();
        const commands = loadCommandsFromDirectory(commandsDir);

        for (const [name, definition] of commands) {
          cfg.command[name] = definition;
        }
      },
    };
  } catch {
    console.error("[codebase-index] Failed to initialize plugin (check config and network)");
    // Return a plugin with no tools to prevent opencode from crashing
    return {
      tool: undefined,
      async config() {},
    };
  }
};

export default plugin;
