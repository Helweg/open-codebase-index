import type {
  Plugin as V2Plugin,
  Context as V2Context,
  Cleanup as V2Cleanup,
  Registration,
  ToolResult as V2ToolResult,
} from "./opencode-v2-types.js";
import { tool } from "@opencode-ai/plugin";

import { stopBackgroundWorker } from "../utils/background-worker.js";
import {
  loadOpenCodeCommands,
  openCodeToolDefinitions,
  prepareOpenCodeSession,
  resolveOpenCodeProjectRoot,
} from "./opencode-session.js";

function expandCommandTemplate(template: string, input: string): string {
  const expanded = template.replaceAll("$ARGUMENTS", () => input);
  return !template.includes("$ARGUMENTS") && input.trim()
    ? `${expanded}\n\n${input}`.trim()
    : expanded.trim();
}

function withoutMentions<T extends { mention?: unknown }>(references?: readonly T[]): Omit<T, "mention">[] {
  return (references || []).map(({ mention: _mention, ...reference }) => reference);
}

async function disposeRegistrations(regs: readonly Registration[]): Promise<void> {
  if (regs.length === 0) {
    return;
  }
  const results = await Promise.allSettled(regs.map((r) => r.dispose()));
  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[codebase-index] Failed to dispose OpenCode v2 registration:", r.reason);
    }
  }
}

export const v2Definition = {
  id: "codebase-index",
  async setup(ctx: V2Context): Promise<V2Cleanup | void> {
    let configuredProjectRoot: string | undefined;
    let workerConfigured = false;
    const registrations: Registration[] = [];

    try {
      const projectRoot = resolveOpenCodeProjectRoot(ctx.location.directory, ctx.location.project.directory);
      configuredProjectRoot = projectRoot;
      const prepared = await prepareOpenCodeSession(projectRoot, { waitForUnsafeWorkerStop: true });
      const { config, routingHints } = prepared;
      workerConfigured = prepared.workerConfigured;

      const v1Tools = openCodeToolDefinitions();

      const regTools = await ctx.tool.transform((editor) => {
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
                    const { metadata: extraMetadata, ...rest } = update ?? {};
                    const progressPayload: Record<string, unknown> = {
                      ...(typeof extraMetadata === "object" && extraMetadata !== null ? extraMetadata : {}),
                      ...rest,
                    };
                    void Promise.resolve(context.progress(progressPayload)).catch(() => {});
                  }
                },
                ask: () => {
                  throw new Error("ToolContext.ask is not available on OpenCode v2");
                },
              };
              const output = await def.execute(input as never, v1Context as never);
              if (typeof output === "string") return { content: output };
              const content: V2ToolResult["content"] = output.attachments?.length
                ? [
                  { type: "text", text: output.output },
                  ...output.attachments.map((attachment) => ({
                    type: "file" as const,
                    uri: attachment.url,
                    mime: attachment.mime,
                    name: attachment.filename,
                  })),
                ]
                : output.output;
              return {
                content,
                metadata: output.title === undefined
                  ? output.metadata
                  : { ...output.metadata, title: output.title },
              } satisfies V2ToolResult;
            },
          });
        }
      });
      if (regTools && typeof regTools.dispose === "function") {
        registrations.push(regTools);
      }

      const regPrompt = await ctx.session.hook("prompt", async (event) => {
        if (routingHints && event?.prompt?.text) {
          routingHints.observeUserMessage(event.sessionID, [{ type: "text", text: event.prompt.text }]);
        }
      });
      if (regPrompt && typeof regPrompt.dispose === "function") {
        registrations.push(regPrompt);
      }

      const regContext = await ctx.session.hook("context", async (event) => {
        if (!routingHints) return;
        if (config.search.routingHintRole === "system" || config.search.routingHintRole === "developer") {
          const hints = await routingHints.getSystemHints(event.sessionID);
          for (const hint of hints) {
            event.system.push({ type: "text", text: hint });
          }
        }
      });
      if (regContext && typeof regContext.dispose === "function") {
        registrations.push(regContext);
      }

      const regToolHook = await ctx.tool.hook("execute.after", async (event) => {
        if (routingHints && event?.tool && event?.sessionID) {
          routingHints.markToolUsed(event.sessionID, event.tool);
        }
      });
      if (regToolHook && typeof regToolHook.dispose === "function") {
        registrations.push(regToolHook);
      }

      const commands = loadOpenCodeCommands();

      const regCommand = await ctx.command.transform((editor) => {
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
      if (regCommand && typeof regCommand.dispose === "function") {
        registrations.push(regCommand);
      }

      return async () => {
        await disposeRegistrations(registrations);
        await stopBackgroundWorker(projectRoot, "opencode", true).catch((error: unknown) => {
          console.error("[codebase-index] Failed to stop OpenCode background worker on cleanup:", error);
        });
      };
    } catch {
      await disposeRegistrations(registrations);
      if (workerConfigured && configuredProjectRoot) {
        await stopBackgroundWorker(configuredProjectRoot, "opencode", true).catch((error: unknown) => {
          console.error("[codebase-index] Failed to stop OpenCode background worker after failed setup:", error);
        });
      }
      console.error("[codebase-index] Failed to initialize plugin (check config and network). Details omitted to protect sensitive configuration values.");
      return;
    }
  },
} satisfies V2Plugin;

export default v2Definition;
