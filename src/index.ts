import type { Plugin } from "@opencode-ai/plugin";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { loadMergedConfig } from "./config/merger.js";
import { createWatcherWithIndexer } from "./watcher/index.js";
import {
  codebase_search,
  codebase_context,
  codebase_peek,
  index_codebase,
  index_status,
  index_health_check,
  index_metrics,
  index_logs,
  find_similar,
  call_graph,
  call_graph_path,
  implementation_lookup,
  add_knowledge_base,
  list_knowledge_bases,
  remove_knowledge_base,
  index_visualize,
  getIndexerForProject,
  initializeTools,
  pr_impact,
} from "./tools/index.js";
import { loadCommandsFromDirectory } from "./commands/loader.js";
import { RoutingHintController } from "./routing-hints.js";
import { startAutoIndex } from "./utils/auto-index.js";
import { hasProjectMarker } from "./utils/files.js";
import type { CombinedWatcher } from "./watcher/index.js";

const activeWatchers = new Map<string, CombinedWatcher>();

function replaceActiveWatcher(projectRoot: string, nextWatcher: CombinedWatcher | null): void {
  const existing = activeWatchers.get(projectRoot);
  if (existing) {
    existing.stop();
    activeWatchers.delete(projectRoot);
  }
  if (nextWatcher) {
    activeWatchers.set(projectRoot, nextWatcher);
  }
}

function getCommandsDir(): string {
  let currentDir = process.cwd();
  
  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }
  
  return path.join(currentDir, "..", "commands");
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

interface ChatTransformInput {
  sessionID?: string;
}

interface ChatTransformOutput {
  system?: string[];
  developer?: string[];
}

const plugin: Plugin = async ({ directory, worktree }) => {
  try {
    const projectRoot = worktree || directory;
    const rawConfig = loadMergedConfig(projectRoot);
    const config = parseConfig(rawConfig);

    initializeTools(projectRoot, config);

    const getProjectIndexer = () => getIndexerForProject(projectRoot);
    const routingHints = config.search.routingHints
      ? new RoutingHintController(() => getProjectIndexer().getStatus(), 200, config.search.routingGraphHandoffHints)
      : null;

    const isHomeDir = path.resolve(projectRoot) === path.resolve(os.homedir());
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
      replaceActiveWatcher(projectRoot, createWatcherWithIndexer(getProjectIndexer, projectRoot, config, "opencode"));
    } else {
      replaceActiveWatcher(projectRoot, null);
    }

    return {
      tool: {
        codebase_context,
        codebase_search,
        codebase_peek,
        index_codebase,
        index_status,
        index_health_check,
        index_metrics,
        index_logs,
        find_similar,
        call_graph,
        call_graph_path,
        implementation_lookup,
        add_knowledge_base,
        list_knowledge_bases,
        remove_knowledge_base,
        pr_impact,
        index_visualize,
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
