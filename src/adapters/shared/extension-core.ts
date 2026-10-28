/**
 * Shared pi-contract extension core.
 *
 * `src/adapters/pi/extension.ts` and `src/adapters/omp/extension.ts` reuse this
 * tool/session core with their own schema builders and prompt event shapes.
 * Storage follows the Pi host mode (`.codebase-index/`), which omp reuses.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "../../tools/history-operations.js";

import { parseConfig } from "../../config/schema.js";
import { loadMergedConfig } from "../../config/merger.js";
import { formatCostEstimate, formatDryRunEstimate } from "../../utils/cost.js";
import { formatPrImpact } from "../../tools/format-pr-impact.js";
import { formatCodeCommunities } from "../../tools/format-communities.js";
import { executeArchitectureContext } from "../../tools/execute-common.js";
import {
  addKnowledgeBase,
  findSimilarCode,
  getIndexLogs,
  getIndexMetrics,
  getIndexStatus,
  getPrImpact,
  getIndexerForProject,
  getCodeCommunities,
  implementationLookup,
  isExactSymbolQuery,
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
import { resolveCodebaseEditContext } from "../../tools/edit-context.js";
import { registerCallGraphTools } from "./call-graph.js";
import { configureBackgroundWorker, stopBackgroundWorker, waitForBackgroundWorkerStart } from "../../utils/background-worker.js";
import { isHomeDirectory, startAutoIndexForBackgroundWorker, stopAutoIndexForBackgroundWorker } from "../../utils/auto-index.js";
import { hasProjectMarker } from "../../utils/files.js";
import { createWatcherWithIndexer } from "../../watcher/index.js";
import { TOOL_NAME } from "../../tools/tool-names.js";
import { isOperationInterruption, throwIfOperationAborted } from "../../utils/operation-control.js";
import {
  CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD,
  CODE_COMMUNITIES_DEFAULT_LIMIT,
  CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT,
  CODE_COMMUNITIES_MAX_LIMIT,
  CODE_COMMUNITIES_MAX_COUPLING_LIMIT,
  CODE_COMMUNITIES_MIN_SIZE,
  CODE_COMMUNITIES_MIN_COUPLING,
  DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
} from "../../tools/contracts.js";

const HOST = "pi" as const;

/**
 * Schema builder used for tool parameters. Defaults to this package's TypeBox
 * builder; hosts that ship their own TypeBox-compatible shim inject theirs.
 */
export type ExtensionSchemaBuilder = typeof Type;

export interface CodebaseIndexExtensionOptions {
  schema?: ExtensionSchemaBuilder;
}

/** Host capabilities shared by Pi and omp, excluding their prompt event shape. */
export interface CodebaseIndexExtensionAPI {
  registerTool: ExtensionAPI["registerTool"];
  on(
    event: "session_shutdown",
    handler: (event: unknown, ctx: { cwd: string }) => Promise<void>,
  ): void;
}

export const CODEBASE_INDEX_GUIDANCE =
  "Check index_status first when index readiness is unknown. " +
  "Use codebase_context only when repository orientation is needed (for layout, key symbols, or cross-file dependency intent), " +
  "not mechanically for every task. " +
  "When using codebase_context for orientation, request a compact first pass (for example: tokenBudget: 600, limit: 5) and inspect returned evidence before broad search/grep/bash/read-style reads. " +
  "For change requests with a known or strongly suspected target symbol, optionally use codebase_edit_context as a compact, bounded pre-edit context for source plus direct callers and callees. " +
  "Avoid repeating broad reads when the compact evidence already answers the question. " +
  "Use implementation_lookup directly as the authoritative known-symbol definition tool; no codebase_context prerequisite. " +
  "Use call_graph for callers/callees and call_graph_path after endpoints are identified for dependency flow. " +
  "Use codebase_search for semantic source content or codebase_peek for metadata-only locations when useful; neither requires codebase_context first.";

function text(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function projectRoot(ctx: { cwd?: string } | undefined): string {
  return ctx?.cwd ?? process.cwd();
}

function isValidProject(projectRoot: string, requireProjectMarker: boolean): boolean {
  return !isHomeDirectory(projectRoot) && (!requireProjectMarker || hasProjectMarker(projectRoot));
}

export async function ensureCodebaseIndexSession(projectRoot: string): Promise<void> {
  const config = parseConfig(loadMergedConfig(projectRoot, HOST));
  if (!isValidProject(projectRoot, config.indexing.requireProjectMarker)) {
    await stopBackgroundWorker(projectRoot, HOST).catch((error: unknown) => {
      console.error("[codebase-index] Failed to stop the background worker:", error);
    });
    return;
  }

  // The background worker may become leader immediately. Create the Indexer and
  // its coordinator first so the startup callback cannot be dropped.
  getIndexerForProject(projectRoot, HOST);
  const watcherFactoryForConfig = (refreshedConfig: typeof config) => (
    refreshedConfig.indexing.watchFiles
      ? () => createWatcherWithIndexer(
        () => getIndexerForProject(projectRoot, HOST),
        projectRoot,
        refreshedConfig,
        HOST,
      )
      : null
  );
  configureBackgroundWorker(projectRoot, HOST, config, {
    startAutoIndex: (source, allowDisabledAutoIndex) => {
      startAutoIndexForBackgroundWorker(projectRoot, HOST, source, allowDisabledAutoIndex);
    },
    stopAutoIndex: () => stopAutoIndexForBackgroundWorker(projectRoot, HOST),
    watcherFactory: watcherFactoryForConfig(config),
    watcherFactoryForConfig,
  });
  await waitForBackgroundWorkerStart(projectRoot, HOST);
}

export function registerCodebaseIndexTools(pi: CodebaseIndexExtensionAPI, schema: ExtensionSchemaBuilder): void {
  const ChunkType = schema.Union([
    schema.Literal("function"),
    schema.Literal("class"),
    schema.Literal("method"),
    schema.Literal("interface"),
    schema.Literal("type"),
    schema.Literal("module"),
    schema.Literal("element"),
    schema.Literal("block"),
  ]);


  pi.registerTool({
    name: TOOL_NAME.CODEBASE_CONTEXT,
    label: "Codebase Context",
    description: "Orient yourself in an unfamiliar subsystem: layout, key symbols, or cross-file dependency intent. Returns a deduplicated, file-diverse evidence pack within tokenBudget. Check index_status when readiness is unknown; start compact (tokenBudget: 600, limit: 5) and inspect the evidence before broad reads. For known definitions use implementation_lookup directly; for callers/callees use call_graph. Use fromFilePath/toFilePath only when duplicate path endpoints are reported.",
    parameters: schema.Object({
      query: schema.String({ description: "Natural language description of what code you're trying to locate" }),
      from: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Source symbol when asking for a dependency path." })),
      to: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Target symbol when asking for a dependency path." })),
      fromFilePath: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Optional source file path used to disambiguate duplicate source names." })),
      toFilePath: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Optional target file path used to disambiguate duplicate target names." })),
      symbol: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Exact symbol name for an authoritative definition lookup." })),
      limit: schema.Optional(schema.Union([
        schema.Integer({ minimum: MIN_CONTEXT_RESULT_LIMIT, maximum: MAX_CONTEXT_RESULT_LIMIT }),
        schema.Null(),
      ], { default: 10, description: `Maximum results (${MIN_CONTEXT_RESULT_LIMIT}-${MAX_CONTEXT_RESULT_LIMIT})` })),
      maxDepth: schema.Optional(schema.Union([
        schema.Integer({ minimum: MIN_CONTEXT_PATH_DEPTH, maximum: MAX_CONTEXT_PATH_DEPTH }),
        schema.Null(),
      ], { default: 10, description: `Maximum call-graph traversal depth (${MIN_CONTEXT_PATH_DEPTH}-${MAX_CONTEXT_PATH_DEPTH})` })),
      diagnostic: schema.Optional(schema.Union([schema.Boolean(), schema.Null()], { description: "Collect diagnostic routing and search traces without changing normal output." })),
      fileType: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Retrieval-route filter by file extension; not used for from/to graph paths." })),
      directory: schema.Optional(schema.Union([schema.String(), schema.Null()], { description: "Retrieval-route filter by directory path; not used for from/to graph paths." })),
      allowUnscopedRecovery: schema.Optional(schema.Union([schema.Boolean(), schema.Null()], {
        description: "Allow definition and conceptual retrieval fallbacks to remove supplied fileType/directory filters after a scoped miss. Defaults to false; only true enables recovery.",
      })),
      tokenBudget: schema.Optional(schema.Union([
        schema.Integer({ minimum: MIN_CONTEXT_PACK_TOKEN_BUDGET, maximum: MAX_CONTEXT_PACK_TOKEN_BUDGET }),
        schema.Null(),
      ], {
        default: DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
        description: `Maximum response tokens (${MIN_CONTEXT_PACK_TOKEN_BUDGET}-${MAX_CONTEXT_PACK_TOKEN_BUDGET})`,
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalizedParams = {
        ...params,
        diagnostic: params.diagnostic ?? undefined,
        allowUnscopedRecovery: params.allowUnscopedRecovery ?? undefined,
      };
      const result = await resolveCodebaseContext(projectRoot(ctx), HOST, normalizedParams, { signal });
      return text(result.text, result.details);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODEBASE_EDIT_CONTEXT,
    label: "Codebase Edit Context",
    description: "PRE-EDIT TOOL for a known or suspected symbol. Returns bounded target source and direct graph evidence, with a risk-marked fallback when unresolved.",
    parameters: schema.Object({
      query: schema.String({ description: "The requested change or target behavior" }),
      symbol: schema.Optional(schema.Union([schema.String(), schema.Null()])),
      filePath: schema.Optional(schema.Union([schema.String(), schema.Null()])),
      callerLimit: schema.Optional(schema.Union([
        schema.Integer({ minimum: MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT, maximum: MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT }),
        schema.Null(),
      ], { default: DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT })),
      calleeLimit: schema.Optional(schema.Union([
        schema.Integer({ minimum: MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT, maximum: MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT }),
        schema.Null(),
      ], { default: DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT })),
      tokenBudget: schema.Optional(schema.Union([
        schema.Integer({ minimum: MIN_CONTEXT_PACK_TOKEN_BUDGET, maximum: MAX_CONTEXT_PACK_TOKEN_BUDGET }),
        schema.Null(),
      ], { default: DEFAULT_CONTEXT_PACK_TOKEN_BUDGET })),
      includeApiImpact: schema.Optional(schema.Boolean({
        default: false,
        description: "Include bounded syntactic Express route to exact relative fetch evidence. Matches are not call edges; tests are candidates only.",
      })),
      includeTests: schema.Optional(schema.Boolean({
        default: false,
        description: "Include bounded JS/TS static source-linked test references, not test execution or runtime coverage.",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await resolveCodebaseEditContext(projectRoot(ctx), HOST, params, { signal });
      return text(result.text, result.details);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODEBASE_SEARCH,
    label: "Codebase Search",
    description: "Optional semantic retrieval with source content. Describe behavior, not syntax. Use directly when semantic source matches are needed; codebase_context is not a prerequisite.",
    parameters: schema.Object({
      query: schema.String({ description: "Natural language description of what code you're looking for" }),
      limit: schema.Optional(schema.Number({ description: "Maximum results (default: 10)" })),
      fileType: schema.Optional(schema.String({ description: "Filter by extension, e.g. ts, py, rs" })),
      directory: schema.Optional(schema.String({ description: "Filter by directory path" })),
      chunkType: schema.Optional(ChunkType),
      contextLines: schema.Optional(schema.Number({ description: "Extra lines around each match" })),
      blameAuthor: schema.Optional(schema.String({ description: "Filter by git blame author name or email" })),
      blameSha: schema.Optional(schema.String({ description: "Filter by git blame commit SHA or prefix" })),
      blameSince: schema.Optional(schema.String({ description: "Filter to chunks last changed on or after this date" })),
      blameUntil: schema.Optional(schema.String({ description: "Filter to chunks last changed on or before this date" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return searchCodebaseWithEffectiveness(projectRoot(ctx), HOST, "search", params.query, {
        ...params,
      }, (results) => {
        const renderedText = results.length === 0
          ? "No matching code found. Try a different query or run index_codebase first."
          : formatSearchResults(results);
        const output = text(renderedText, results);
        return { output, text: output.content[0].text };
      }, { signal });
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODEBASE_PEEK,
    label: "Codebase Peek",
    description: "Optional low-token semantic retrieval of metadata-only locations. Use directly for cheap conceptual lookup; codebase_context is not a prerequisite.",
    parameters: schema.Object({
      query: schema.String(),
      limit: schema.Optional(schema.Number()),
      fileType: schema.Optional(schema.String()),
      directory: schema.Optional(schema.String()),
      chunkType: schema.Optional(ChunkType),
      blameAuthor: schema.Optional(schema.String()),
      blameSha: schema.Optional(schema.String()),
      blameSince: schema.Optional(schema.String()),
      blameUntil: schema.Optional(schema.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return searchCodebaseWithEffectiveness(projectRoot(ctx), HOST, "peek", params.query, {
        ...params,
        metadataOnly: true,
      }, (results) => {
        const output = text(formatCodebasePeek(results), results);
        return { output, text: output.content[0].text };
      }, { signal });
    },
  });

  pi.registerTool({
    name: TOOL_NAME.FIND_SIMILAR,
    label: "Find Similar Code",
    description: "Find code similar to a snippet for duplicate detection, pattern discovery, and refactor planning.",
    parameters: schema.Object({
      code: schema.String({ description: "Code snippet to compare" }),
      limit: schema.Optional(schema.Number()),
      fileType: schema.Optional(schema.String()),
      directory: schema.Optional(schema.String()),
      chunkType: schema.Optional(ChunkType),
      excludeFile: schema.Optional(schema.String()),
      blameSince: schema.Optional(schema.String({ description: "Filter to chunks last changed on or after this date" })),
      blameUntil: schema.Optional(schema.String({ description: "Filter to chunks last changed on or before this date" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const results = await findSimilarCode(projectRoot(ctx), HOST, params.code, params, { signal });
      return text(formatSearchResults(results, "similarity"), results);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.IMPLEMENTATION_LOOKUP,
    label: "Implementation Lookup",
    description: "Authoritative definition lookup for a known symbol. Use directly without a codebase_context prerequisite; exact identifiers resolve structurally, while descriptive queries use semantic implementation discovery.",
    parameters: schema.Object({
      query: schema.String(),
      limit: schema.Optional(schema.Number()),
      tokenBudget: schema.Optional(schema.Number({
        minimum: MIN_CONTEXT_PACK_TOKEN_BUDGET,
        maximum: MAX_CONTEXT_PACK_TOKEN_BUDGET,
        description: "Visible text budget in estimated tokens (128–4000; default 1200). Reserves ranked citations for distinct files before source bodies; source details are unchanged.",
      })),
      fileType: schema.Optional(schema.String()),
      directory: schema.Optional(schema.String()),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const results = await implementationLookup(projectRoot(ctx), HOST, params.query, {
        ...params,
        exactSymbol: isExactSymbolQuery(params.query),
      }, { signal });
      return text(formatDefinitionLookup(results, params.query, params.tokenBudget), results);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_CODEBASE,
    label: "Index Codebase",
    description: "Build or refresh the semantic codebase index. Use index_status with checkFreshness=true when source freshness is needed.",
    parameters: schema.Object({
      force: schema.Optional(schema.Boolean({ default: false })),
      estimateOnly: schema.Optional(schema.Boolean({ default: false })),
      dryRun: schema.Optional(schema.Boolean({ default: false })),
      verbose: schema.Optional(schema.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const result = await runIndexCodebase(
          projectRoot(ctx),
          HOST,
          params,
          onUpdate ? (title, metadata) => onUpdate(text(title, metadata)) : undefined,
          { signal },
        );
        if (result.kind === "estimate") return text(formatCostEstimate(result.estimate), result.estimate);
        if (result.kind === "dryrun") return text(formatDryRunEstimate(result.dryrun), result.dryrun);
        if (result.kind === "busy") return text(result.text, { code: "INDEX_BUSY" });
        if (result.kind === "message") return text(result.text);
        return text(formatIndexStats(result.stats, params.verbose ?? false), result.stats);
      } catch (error: unknown) {
        throwIfOperationAborted(signal);
        if (isOperationInterruption(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return text(`index_codebase failed: ${message}`);
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_STATUS,
    label: "Index Status",
    description: "Inspect stored catalog readiness and compatibility. Source freshness is not checked unless checkFreshness=true; that read-only check does not refresh the index.",
    parameters: schema.Object({
      checkFreshness: schema.Optional(schema.Boolean({ default: false, description: "Check selected source against the index at this point in time without indexing" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const status = await getIndexStatus(projectRoot(ctx), HOST, params, { signal });
      return text(formatStatus(status), status);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_HEALTH_CHECK,
    label: "Index Health Check",
    description: "Garbage collect orphaned embeddings/chunks and report index health status.",
    parameters: schema.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const result = await runIndexHealthCheck(projectRoot(ctx), HOST, { signal });
      if (result.kind === "busy") return text(result.text, { code: "INDEX_BUSY" });
      return text(formatHealthCheck(result.health), result.health);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.INDEX_METRICS,
    label: "Index Metrics",
    description: "Return operational metrics and opt-in memory-only privacy-safe effectiveness counters.",
    parameters: schema.Object({
      reset: schema.Optional(schema.Boolean({ description: "Reset in-memory metrics before returning the snapshot" })),
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
    parameters: schema.Object({
      limit: schema.Optional(schema.Number()),
      category: schema.Optional(schema.Union([
        schema.Literal("search"),
        schema.Literal("embedding"),
        schema.Literal("cache"),
        schema.Literal("gc"),
        schema.Literal("branch"),
        schema.Literal("general"),
      ])),
      level: schema.Optional(schema.Union([schema.Literal("error"), schema.Literal("warn"), schema.Literal("info"), schema.Literal("debug")])),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getIndexLogs(projectRoot(ctx), HOST, params);
      return text(result.text, result);
    },
  });

  registerCallGraphTools(pi, schema);

  pi.on("session_shutdown", async (_event, ctx) => {
    const root = projectRoot(ctx);
    await stopBackgroundWorker(root, HOST);
  });

  pi.registerTool({
    name: TOOL_NAME.PR_IMPACT,
    label: "PR Impact",
    description: "Analyze PR, branch, or working-tree impact through current indexed files and call graph neighborhoods. Working-tree mode includes staged, unstaged, and untracked paths without refreshing the index.",
    parameters: schema.Object({
      pr: schema.Optional(schema.Number()),
      branch: schema.Optional(schema.String()),
      workingTree: schema.Optional(schema.Boolean({ default: false })),
      maxDepth: schema.Optional(schema.Number({ default: 5 })),
      hubThreshold: schema.Optional(schema.Number({ default: 10 })),
      checkConflicts: schema.Optional(schema.Boolean({ default: false })),
      direction: schema.Optional(schema.Union([schema.Literal("callers"), schema.Literal("callees"), schema.Literal("both")])),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await getPrImpact(projectRoot(ctx), HOST, params, { signal });
      return text(formatPrImpact(result), result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.ARCHITECTURE_CONTEXT,
    label: "Architecture Context",
    description: "Repository-scale architecture map with source-backed module, boundary, and hub evidence.",
    parameters: schema.Object({
      query: schema.Optional(schema.String()),
      directory: schema.Optional(schema.String()),
      depth: schema.Optional(schema.Integer({ minimum: 1, maximum: 3, default: 2 })),
      includeRecentActivity: schema.Optional(schema.Boolean({ default: false })),
      tokenBudget: schema.Optional(schema.Integer({ minimum: 128, maximum: 4000, default: 1200 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await executeArchitectureContext(projectRoot(ctx), HOST, params, { signal });
      return text(result.text, result.details);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.CODE_COMMUNITIES,
    label: "Code Communities",
    description: "Discover natural module boundaries and hub symbols using graph community detection. Clusters symbols by call-graph connectivity to reveal architecture.",
    parameters: schema.Object({
      branch: schema.Optional(schema.String()),
      minSize: schema.Optional(schema.Integer({ minimum: CODE_COMMUNITIES_MIN_SIZE, default: CODE_COMMUNITIES_MIN_SIZE })),
      limit: schema.Optional(schema.Integer({ minimum: 1, maximum: CODE_COMMUNITIES_MAX_LIMIT, default: CODE_COMMUNITIES_DEFAULT_LIMIT })),
      hubThreshold: schema.Optional(schema.Integer({ minimum: 0, default: CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD })),
      minCoupling: schema.Optional(schema.Integer({ minimum: CODE_COMMUNITIES_MIN_COUPLING, default: CODE_COMMUNITIES_MIN_COUPLING })),
      couplingLimit: schema.Optional(
        schema.Integer({ minimum: 1, maximum: CODE_COMMUNITIES_MAX_COUPLING_LIMIT, default: CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await getCodeCommunities(projectRoot(ctx), HOST, params, { signal });
      return text(formatCodeCommunities(result), result);
    },
  });

  pi.registerTool({
    name: TOOL_NAME.PI_KNOWLEDGE_BASE_LIST,
    label: "List Knowledge Bases",
    description: "List configured knowledge-base paths included in the index.",
    parameters: schema.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return text(listKnowledgeBases(projectRoot(ctx), HOST));
    },
  });

  pi.registerTool({
    name: TOOL_NAME.PI_KNOWLEDGE_BASE_ADD,
    label: "Add Knowledge Base",
    description: "Add a knowledge-base path to the codebase index config.",
    parameters: schema.Object({ path: schema.String({ description: "File or directory path to add" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(addKnowledgeBase(projectRoot(ctx), HOST, params.path));
    },
  });

  pi.registerTool({
    name: TOOL_NAME.PI_KNOWLEDGE_BASE_REMOVE,
    label: "Remove Knowledge Base",
    description: "Remove a knowledge-base path from the codebase index config.",
    parameters: schema.Object({ path: schema.String({ description: "File or directory path to remove" }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(removeKnowledgeBase(projectRoot(ctx), HOST, params.path));
    },
  });
  pi.registerTool({
    name: TOOL_NAME.REPOSITORY_HISTORY_SYNC,
    label: "Sync Repository History",
    description: "Manually sync explicitly enabled GitHub.com or GitHub Enterprise issue/PR history. Read-only, local private lexical storage; no embeddings. Full reconciliation can use many API requests and resumes interrupted private fetch staging.",
    parameters: schema.Object({ repository: schema.Optional(schema.String({ description: "Configured [HOST/]OWNER/REPO; HOST defaults to github.com" })), since: schema.Optional(schema.String({ description: "Initial created-at window (ISO date), otherwise all history" })) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runRepositoryHistorySync(params, projectRoot(ctx), HOST, { signal });
      return text(JSON.stringify(result, null, 2), result);
    },
  });
  pi.registerTool({
    name: TOOL_NAME.REPOSITORY_HISTORY_SEARCH,
    label: "Search Repository History",
    description: "Search LOCAL cached untrusted historical GitHub issue/PR evidence with exact source citations/state/timestamps/commit provenance. Current code is authoritative. No network, embedding or rerank requests; separate from code retrieval.",
    parameters: schema.Object({
      query: schema.String(), repository: schema.Optional(schema.String({ description: "Configured [HOST/]OWNER/REPO; HOST defaults to github.com" })),
      kind: schema.Optional(schema.Union([schema.Literal("issue"), schema.Literal("pull_request")])),
      state: schema.Optional(schema.Union([schema.Literal("open"), schema.Literal("closed"), schema.Literal("merged"), schema.Literal("draft")])),
      author: schema.Optional(schema.String()), limit: schema.Optional(schema.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runRepositoryHistorySearch(params, projectRoot(ctx), HOST, { signal });
      return text(JSON.stringify(result, null, 2), result);
    },
  });
  pi.registerTool({
    name: TOOL_NAME.REPOSITORY_HISTORY_STATUS,
    label: "Repository History Status",
    description: "Show local history enablement, cached freshness, counts and errors without activating a code index/provider. Offline cached permissions are not real-time.",
    parameters: schema.Object({ repository: schema.Optional(schema.String({ description: "Configured [HOST/]OWNER/REPO; HOST defaults to github.com" })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runRepositoryHistoryStatus(params, projectRoot(ctx), HOST);
      return text(JSON.stringify(result, null, 2), result);
    },
  });
  pi.registerTool({
    name: TOOL_NAME.REPOSITORY_HISTORY_CLEAR,
    label: "Clear Repository History",
    description: "Clear ONLY local history plus unfinished private fetch staging, even if the source is disabled. No changes to code indexes, credentials or GitHub.",
    parameters: schema.Object({ repository: schema.Optional(schema.String({ description: "Configured [HOST/]OWNER/REPO; HOST defaults to github.com" })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runRepositoryHistoryClear(params, projectRoot(ctx), HOST);
      return text(JSON.stringify(result, null, 2), result);
    },
  });
}

/**
 * Builds a host extension factory that registers the shared codebase-index
 * tool surface. `options.schema` lets a host supply its own TypeBox-compatible
 * builder; the default is this package's TypeBox builder.
 */
export function createCodebaseIndexExtension(
  options: CodebaseIndexExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const schema = options.schema ?? Type;
  return (pi: ExtensionAPI) => {
    registerCodebaseIndexTools(pi, schema);
    pi.on("before_agent_start", async (event, ctx) => {
      await ensureCodebaseIndexSession(projectRoot(ctx));
      // Additive sections keep later extensions visible instead of freezing a prompt override.
      const sections = event.systemPromptOptions?.sections;
      if (sections) {
        sections.codebase_index_guidance = CODEBASE_INDEX_GUIDANCE;
        return;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${CODEBASE_INDEX_GUIDANCE}` };
    });
  };
}

export default createCodebaseIndexExtension();
