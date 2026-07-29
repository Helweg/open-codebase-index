import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getCallGraphData, getCallGraphPath } from "./tools/operations.js";
import { formatCallGraphPathResult, formatCallGraphResult } from "./tools/utils.js";
import { TOOL_NAME } from "./tools/tool-names.js";

const HOST = "pi" as const;

const RelationshipType = Type.Union([
  Type.Literal("Call"),
  Type.Literal("MethodCall"),
  Type.Literal("Constructor"),
  Type.Literal("Import"),
  Type.Literal("Inherits"),
  Type.Literal("Implements"),
]);

function text(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectRoot(ctx: { cwd?: string } | undefined): string | undefined {
  return ctx?.cwd ?? process.cwd();
}

export function registerPiCallGraphTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME.CALL_GRAPH,
    label: "Call Graph",
    description: "Find callers or callees by function or method name. Unique names resolve automatically; use filePath when duplicate names are reported.",
    parameters: Type.Object({
      name: Type.String(),
      direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees")])),
      filePath: Type.Optional(Type.String()),
      symbolId: Type.Optional(Type.String()),
      relationshipType: Type.Optional(RelationshipType),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCallGraphData(projectRoot(ctx), HOST, params);
      return text(formatCallGraphResult(result), result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CALL_GRAPH_PATH,
    label: "Call Graph Path",
    description: "Find a call path between two named functions or methods. Use fromFilePath or toFilePath when duplicate endpoints are reported.",
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      fromFilePath: Type.Optional(Type.String()),
      toFilePath: Type.Optional(Type.String()),
      maxDepth: Type.Optional(Type.Number({ default: 10 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCallGraphPath(
        projectRoot(ctx),
        HOST,
        params.from,
        params.to,
        params.maxDepth,
        params.fromFilePath,
        params.toFilePath,
      );
      return text(formatCallGraphPathResult(result), result);
    },
  });
}
