import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { executeCallGraph, executeCallGraphPath } from "./tools/operations.js";

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
    name: "call_graph",
    label: "Call Graph",
    description: "Find callers or callees by symbol name. Use file or directory only when exact-name definitions are ambiguous.",
    parameters: Type.Object({
      name: Type.String(),
      direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees"), Type.Null()])),
      file: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      directory: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      relationshipType: Type.Optional(Type.Union([RelationshipType, Type.Null()])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await executeCallGraph(projectRoot(ctx), HOST, params);
      return text(result.text, result.details);
    },
  });

  pi.registerTool({
    name: "call_graph_path",
    label: "Call Graph Path",
    description: "Find a call path by endpoint names. Use fromFile/fromDirectory or toFile/toDirectory to select ambiguous same-name definitions.",
    parameters: Type.Object({
      from: Type.String(),
      to: Type.String(),
      fromFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      fromDirectory: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      toFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      toDirectory: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      maxDepth: Type.Optional(Type.Union([Type.Number({ default: 10 }), Type.Null()])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await executeCallGraphPath(projectRoot(ctx), HOST, params);
      return text(result.text, result.details);
    },
  });
}
