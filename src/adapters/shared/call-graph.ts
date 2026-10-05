import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getCallGraphData, getCallGraphPath } from "../../tools/operations.js";
import { formatCallGraphPathResult, formatCallGraphResult } from "../../tools/utils.js";
import { TOOL_NAME } from "../../tools/tool-names.js";

const HOST = "pi" as const;

function text(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectRoot(ctx: { cwd?: string } | undefined): string | undefined {
  return ctx?.cwd ?? process.cwd();
}

/**
 * Registers the call-graph tools with the host's schema builder, so a host that
 * injects its own builder gets one schema
 * source across every registered tool.
 */
export function registerCallGraphTools(pi: Pick<ExtensionAPI, "registerTool">, schema: typeof Type = Type): void {
  const RelationshipType = schema.Union([
    schema.Literal("Call"),
    schema.Literal("MethodCall"),
    schema.Literal("Constructor"),
    schema.Literal("Import"),
    schema.Literal("Inherits"),
    schema.Literal("Implements"),
  ]);

  pi.registerTool({
    name: TOOL_NAME.CALL_GRAPH,
    label: "Call Graph",
    description: "Find callers or callees by function or method name. Unique names resolve automatically; use filePath when duplicate names are reported.",
    parameters: schema.Object({
      name: schema.String(),
      direction: schema.Optional(schema.Union([schema.Literal("callers"), schema.Literal("callees")])),
      filePath: schema.Optional(schema.String()),
      symbolId: schema.Optional(schema.String()),
      relationshipType: schema.Optional(RelationshipType),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await getCallGraphData(projectRoot(ctx), HOST, params, { signal });
      return text(formatCallGraphResult(result), result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CALL_GRAPH_PATH,
    label: "Call Graph Path",
    description: "Find a call path between two named functions or methods. Use fromFilePath or toFilePath when duplicate endpoints are reported.",
    parameters: schema.Object({
      from: schema.String(),
      to: schema.String(),
      fromFilePath: schema.Optional(schema.String()),
      toFilePath: schema.Optional(schema.String()),
      maxDepth: schema.Optional(schema.Number({ default: 10 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await getCallGraphPath(
        projectRoot(ctx),
        HOST,
        params.from,
        params.to,
        params.maxDepth,
        params.fromFilePath,
        params.toFilePath,
        { signal },
      );
      return text(formatCallGraphPathResult(result), result);
    },
  });
}
