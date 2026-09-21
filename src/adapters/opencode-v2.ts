import type { Plugin as V2Plugin, Context as V2Context, Cleanup as V2Cleanup } from "./opencode-v2-types.js";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
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
} from "../tools/index.js";
import { TOOL_NAME } from "../tools/tool-names.js";
import { loadCommandsFromDirectory } from "../commands/loader.js";
import { RoutingHintController } from "../routing-hints.js";
import { configureBackgroundWorker, stopBackgroundWorker, waitForBackgroundWorkerStart } from "../utils/background-worker.js";
import {
  getProjectSafety,
  startAutoIndexForBackgroundWorker,
  stopAutoIndexForBackgroundWorker,
} from "../utils/auto-index.js";
import { isGitRepo } from "../git/index.js";

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

function resolveProjectRoot(directory: string, worktree?: string): string {
  if (worktree && isGitRepo(worktree)) {
    return worktree;
  }

  return directory;
}

function expandCommandTemplate(template: string, input: string): string {
  const expanded = template.replaceAll("$ARGUMENTS", () => input);
  return !template.includes("$ARGUMENTS") && input.trim()
    ? `${expanded}\n\n${input}`.trim()
    : expanded.trim();
}

function withoutMentions<T extends { mention?: unknown }>(references?: readonly T[]): Omit<T, "mention">[] {
  return (references || []).map(({ mention: _mention, ...reference }) => reference);
}

export const v2Definition = {
  id: "codebase-index",
  async setup(ctx: V2Context): Promise<V2Cleanup | void> {
    try {
      const projectRoot = resolveProjectRoot(ctx.location.directory, ctx.location.project.directory);
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
        await stopBackgroundWorker(projectRoot, "opencode").catch((error: unknown) => {
          console.error("[codebase-index] Failed to stop unsafe OpenCode background worker:", error);
        });
      } else {
        const watcherFactoryForConfig = (refreshedConfig: typeof config) => (
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
        await waitForBackgroundWorkerStart(projectRoot, "opencode");
      }

      const v1Tools: Record<string, ToolDefinition> = {
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
      };

      await ctx.tool.transform((editor) => {
        for (const [name, def] of Object.entries(v1Tools)) {
          const inputSchema = tool.schema.object(def.args);
          editor.add({
            name,
            description: def.description,
            input: inputSchema,
            execute: async (input, context) => {
              const v1Context = {
                sessionID: context?.sessionID,
                abort: context?.signal,
                directory: projectRoot,
                worktree: projectRoot,
                metadata: (update: { title?: string; metadata?: Record<string, unknown> }) => {
                  if (context?.progress) {
                    context.progress(update);
                  }
                },
                ask: () => {
                  throw new Error("ToolContext.ask is not available on OpenCode v2");
                },
              };
              const output = await def.execute(input as never, v1Context as never);
              return { content: output };
            },
          });
        }
      });

      await ctx.session.hook("prompt", async (event) => {
        if (routingHints && event?.prompt?.text) {
          routingHints.observeUserMessage(event.sessionID, [{ type: "text", text: event.prompt.text }]);
        }
      });

      await ctx.session.hook("context", async (event) => {
        if (!routingHints) return;
        if (config.search.routingHintRole === "system" || config.search.routingHintRole === "developer") {
          const hints = await routingHints.getSystemHints(event.sessionID);
          for (const hint of hints) {
            event.system.push({ type: "text", text: hint });
          }
        }
      });

      await ctx.tool.hook("execute.after", async (event) => {
        if (routingHints && event?.tool && event?.sessionID) {
          routingHints.markToolUsed(event.sessionID, event.tool);
        }
      });

      const commandsDir = getCommandsDir();
      const commands = loadCommandsFromDirectory(commandsDir);

      await ctx.command.transform((editor) => {
        for (const [name, definition] of commands) {
          editor.add({
            name,
            description: definition.description,
            execute: async (input) => {
              const text = expandCommandTemplate(definition.template, input.prompt.text);
              await ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text,
                files: withoutMentions(input.prompt.files),
                agents: withoutMentions(input.prompt.agents),
                skills: withoutMentions(input.prompt.skills),
                delivery: input.delivery,
              });
            },
          });
        }
      });

      return () => {
        stopBackgroundWorker(projectRoot, "opencode").catch((error: unknown) => {
          console.error("[codebase-index] Failed to stop OpenCode background worker on cleanup:", error);
        });
      };
    } catch {
      console.error("[codebase-index] Failed to initialize plugin (check config and network)");
      return;
    }
  },
} satisfies V2Plugin;

export default v2Definition;
