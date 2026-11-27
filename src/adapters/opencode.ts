import type { Plugin } from "@opencode-ai/plugin";

import {
  loadOpenCodeCommands,
  openCodeToolDefinitions,
  prepareOpenCodeSession,
  resolveOpenCodeProjectRoot,
} from "./opencode-session.js";

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
    const projectRoot = resolveOpenCodeProjectRoot(directory, worktree);
    const { config, routingHints } = await prepareOpenCodeSession(projectRoot, { waitForUnsafeWorkerStop: false });

    return {
      tool: openCodeToolDefinitions(),

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

        const commands = loadOpenCodeCommands();

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
