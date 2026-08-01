import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatCostEstimate } from "../../utils/cost.js";
import { formatPrImpact } from "../../tools/format-pr-impact.js";
import { formatCodeCommunities } from "../../tools/format-communities.js";
import {
  addKnowledgeBase,
  findSimilarCode,
  getIndexLogs,
  getIndexMetrics,
  getIndexStatus,
  getPrImpact,
  getCodeCommunities,
  implementationLookup,
  listKnowledgeBases,
  removeKnowledgeBase,
  runIndexCodebase,
  runIndexHealthCheck,
  searchCodebaseWithEffectiveness,
} from "../../tools/operations.js";
import {
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  formatCodebasePeek,
  formatDefinitionLookup,
  formatHealthCheck,
  formatIndexStats,
  formatSearchResults,
  formatStatus,
  MAX_CONTEXT_PACK_TOKEN_BUDGET,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
} from "../../tools/utils.js";
import {
  MAX_CONTEXT_PATH_DEPTH,
  MAX_CONTEXT_RESULT_LIMIT,
  MIN_CONTEXT_PATH_DEPTH,
  MIN_CONTEXT_RESULT_LIMIT,
  resolveCodebaseContext,
} from "../../tools/context.js";
import { registerPiCallGraphTools } from "./call-graph.js";
import { stopAutoIndex } from "../../utils/auto-index.js";
import { TOOL_NAME } from "../../tools/tool-names.js";
import {
  CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD,
  CODE_COMMUNITIES_DEFAULT_LIMIT,
  CODE_COMMUNITIES_MAX_LIMIT,
  CODE_COMMUNITIES_MIN_SIZE,
} from "../../tools/contracts.js";

const HOST = "pi" as const;

const ChunkType = Type.Union([
  Type.Literal("function"),
  Type.Literal("class"),
  Type.Literal("method"),
  Type.Literal("interface"),
  Type.Literal("type"),
  Type.Literal("module"),
  Type.Literal("block"),
]);

function text(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectRoot(ctx: { cwd?: string } | undefined): string {
  return ctx?.cwd ?? process.cwd();
}

export default function codebaseIndexPiExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME.CODEBASE_CONTEXT,
    label: "Codebase Context",
    description: "PREFERRED FIRST TOOL for any repository question. Returns a deduplicated, file-diverse evidence pack within tokenBudget. Check index_status when freshness is unknown, then use this tool for low-token location discovery and dependency flow. Use fromFilePath/toFilePath only when duplicate path endpoints are reported.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language description of what code you're trying to locate" }),
      from: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Source symbol when asking for a dependency path." })),
      to: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Target symbol when asking for a dependency path." })),
      fromFilePath: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional source file path used to disambiguate duplicate source names." })),
      toFilePath: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Optional target file path used to disambiguate duplicate target names." })),
      symbol: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Exact symbol name for an authoritative definition lookup." })),
      limit: Type.Optional(Type.Union([
        Type.Integer({ minimum: MIN_CONTEXT_RESULT_LIMIT, maximum: MAX_CONTEXT_RESULT_LIMIT }),
        Type.Null(),
      ], { default: 10, description: `Maximum results (${MIN_CONTEXT_RESULT_LIMIT}-${MAX_CONTEXT_RESULT_LIMIT})` })),
      maxDepth: Type.Optional(Type.Union([
        Type.Integer({ minimum: MIN_CONTEXT_PATH_DEPTH, maximum: MAX_CONTEXT_PATH_DEPTH }),
        Type.Null(),
      ], { default: 10, description: `Maximum call-graph traversal depth (${MIN_CONTEXT_PATH_DEPTH}-${MAX_CONTEXT_PATH_DEPTH})` })),
      fileType: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Filter by file extension, e.g., ts, py, rs" })),
      directory: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Filter by directory path" })),
      tokenBudget: Type.Optional(Type.Union([
        Type.Integer({ minimum: MIN_CONTEXT_PACK_TOKEN_BUDGET, maximum: MAX_CONTEXT_PACK_TOKEN_BUDGET }),
        Type.Null(),
      ], {
        default: DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
        description: `Maximum response tokens (${MIN_CONTEXT_PACK_TOKEN_BUDGET}-${MAX_CONTEXT_PACK_TOKEN_BUDGET})`,
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await resolveCodebaseContext(projectRoot(ctx), HOST, params);
      return text(result.text, result.details);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODEBASE_SEARCH,
    label: "Codebase Search",
    description: "Use this after codebase_context when you need semantic content, not just locations. Describe behavior, not syntax.",
    parameters: Type.Object({
      query: Type.String({ description: "Natural language description of what code you're looking for" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results (default: 10)" })),
      fileType: Type.Optional(Type.String({ description: "Filter by extension, e.g. ts, py, rs" })),
      directory: Type.Optional(Type.String({ description: "Filter by directory path" })),
      chunkType: Type.Optional(ChunkType),
      contextLines: Type.Optional(Type.Number({ description: "Extra lines around each match" })),
      blameAuthor: Type.Optional(Type.String({ description: "Filter by git blame author name or email" })),
      blameSha: Type.Optional(Type.String({ description: "Filter by git blame commit SHA or prefix" })),
      blameSince: Type.Optional(Type.String({ description: "Filter to chunks last changed on or after this date" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return searchCodebaseWithEffectiveness(projectRoot(ctx), HOST, "search", params.query, {
        ...params,
      }, (results) => {
        const renderedText = results.length === 0
          ? "No matching code found. Try a different query or run index_codebase first."
          : formatSearchResults(results);
        const output = text(renderedText, results);
        return { output, text: output.content[0].text };
      });
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODEBASE_PEEK,
    label: "Codebase Peek",
    description: "LOW-TOKEN location-first retrieval. Prefer codebase_context first, then use this for cheap conceptual lookup.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
      fileType: Type.Optional(Type.String()),
      directory: Type.Optional(Type.String()),
      chunkType: Type.Optional(ChunkType),
      blameAuthor: Type.Optional(Type.String()),
      blameSha: Type.Optional(Type.String()),
      blameSince: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return searchCodebaseWithEffectiveness(projectRoot(ctx), HOST, "peek", params.query, {
        ...params,
        metadataOnly: true,
      }, (results) => {
        const output = text(formatCodebasePeek(results), results);
        return { output, text: output.content[0].text };
      });
    },
  });

  pi.registerTool({
    name: TOOL_NAME.FIND_SIMILAR,
    label: "Find Similar Code",
    description: "Find code similar to a snippet for duplicate detection, pattern discovery, and refactor planning.",
    parameters: Type.Object({
      code: Type.String({ description: "Code snippet to compare" }),
      limit: Type.Optional(Type.Number()),
      fileType: Type.Optional(Type.String()),
      directory: Type.Optional(Type.String()),
      chunkType: Type.Optional(ChunkType),
      excludeFile: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await findSimilarCode(projectRoot(ctx), HOST, params.code, params);
      return text(formatSearchResults(results, "similarity"), results);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.IMPLEMENTATION_LOOKUP,
    label: "Implementation Lookup",
    description: "Find likely symbol definitions or implementations after codebase_context identifies a symbol.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
      fileType: Type.Optional(Type.String()),
      directory: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await implementationLookup(projectRoot(ctx), HOST, params.query, params);
      return text(formatDefinitionLookup(results, params.query), results);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_CODEBASE,
    label: "Index Codebase",
    description: "Build or refresh the semantic codebase index. Run index_status when freshness is unknown.",
    parameters: Type.Object({
      force: Type.Optional(Type.Boolean({ default: false })),
      estimateOnly: Type.Optional(Type.Boolean({ default: false })),
      verbose: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runIndexCodebase(projectRoot(ctx), HOST, params);
      if (result.kind === "estimate") return text(formatCostEstimate(result.estimate), result.estimate);
      if (result.kind === "busy") return text(result.text, { code: "INDEX_BUSY" });
      if (result.kind === "message") return text(result.text);
      return text(formatIndexStats(result.stats, params.verbose ?? false), result.stats);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_STATUS,
    label: "Index Status",
    description: "Check index health and current status.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = await getIndexStatus(projectRoot(ctx), HOST);
      return text(formatStatus(status), status);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_HEALTH_CHECK,
    label: "Index Health Check",
    description: "Garbage collect orphaned embeddings/chunks and report index health status.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await runIndexHealthCheck(projectRoot(ctx), HOST);
      if (result.kind === "busy") return text(result.text, { code: "INDEX_BUSY" });
      return text(formatHealthCheck(result.health), result.health);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_METRICS,
    label: "Index Metrics",
    description: "Return operational metrics and opt-in memory-only privacy-safe effectiveness counters.",
    parameters: Type.Object({
      reset: Type.Optional(Type.Boolean({ description: "Reset in-memory metrics before returning the snapshot" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getIndexMetrics(projectRoot(ctx), HOST, { reset: params.reset });
      return text(result.text, result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_LOGS,
    label: "Index Logs",
    description: "Return recent debug logs when debug logging is enabled.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      category: Type.Optional(Type.Union([
        Type.Literal("search"),
        Type.Literal("embedding"),
        Type.Literal("cache"),
        Type.Literal("gc"),
        Type.Literal("branch"),
        Type.Literal("general"),
      ])),
      level: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warn"), Type.Literal("info"), Type.Literal("debug")])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getIndexLogs(projectRoot(ctx), HOST, params);
      return text(result.text, result);
    },
  });

  registerPiCallGraphTools(pi);

  pi.on("before_agent_start", (event) => ({
    systemPrompt:
      `${event.systemPrompt}\n\n` +
      "Check index_status first when index readiness is unknown. For repository questions, call codebase_context before search/grep/bash/read-style broad reads. " +
      "Use implementation_lookup for known symbols and call_graph/call_graph_path after endpoints are identified for dependency flow. " +
      "Avoid broad tool calls until semantic locations are known.",
  }));

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopAutoIndex(projectRoot(ctx), HOST);
  });

  pi.registerTool({
    name: TOOL_NAME.PR_IMPACT,
    label: "PR Impact",
    description: "Analyze PR or branch impact through changed symbols and call graph neighborhoods.",
    parameters: Type.Object({
      pr: Type.Optional(Type.Number()),
      branch: Type.Optional(Type.String()),
      maxDepth: Type.Optional(Type.Number({ default: 5 })),
      hubThreshold: Type.Optional(Type.Number({ default: 10 })),
      checkConflicts: Type.Optional(Type.Boolean({ default: false })),
      direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees"), Type.Literal("both")])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getPrImpact(projectRoot(ctx), HOST, params);
      return text(formatPrImpact(result), result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODE_COMMUNITIES,
    label: "Code Communities",
    description: "Discover natural module boundaries and hub symbols using graph community detection. Clusters symbols by call-graph connectivity to reveal architecture.",
    parameters: Type.Object({
      branch: Type.Optional(Type.String()),
      minSize: Type.Optional(Type.Integer({ minimum: CODE_COMMUNITIES_MIN_SIZE, default: CODE_COMMUNITIES_MIN_SIZE })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CODE_COMMUNITIES_MAX_LIMIT, default: CODE_COMMUNITIES_DEFAULT_LIMIT })),
      hubThreshold: Type.Optional(Type.Integer({ minimum: 0, default: CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getCodeCommunities(projectRoot(ctx), HOST, params);
      return text(formatCodeCommunities(result), result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.PI_KNOWLEDGE_BASE_LIST,
    label: "List Knowledge Bases",
    description: "List configured knowledge-base paths included in the index.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return text(listKnowledgeBases(projectRoot(ctx), HOST));
    },
  });

  pi.registerTool({
    name: TOOL_NAME.PI_KNOWLEDGE_BASE_ADD,
    label: "Add Knowledge Base",
    description: "Add a knowledge-base path to the codebase index config.",
    parameters: Type.Object({ path: Type.String({ description: "File or directory path to add" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(addKnowledgeBase(projectRoot(ctx), HOST, params.path));
    },
  });

  pi.registerTool({
    name: TOOL_NAME.PI_KNOWLEDGE_BASE_REMOVE,
    label: "Remove Knowledge Base",
    description: "Remove a knowledge-base path from the codebase index config.",
    parameters: Type.Object({ path: Type.String({ description: "File or directory path to remove" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(removeKnowledgeBase(projectRoot(ctx), HOST, params.path));
    },
  });
}
