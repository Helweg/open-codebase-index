import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  formatCodebasePeek,
  formatSearchResults,
  MAX_CONTEXT_PACK_TOKEN_BUDGET,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
} from "../../tools/utils.js";
import {
  MAX_CONTEXT_PATH_DEPTH,
  MAX_CONTEXT_RESULT_LIMIT,
  MIN_CONTEXT_PATH_DEPTH,
  MIN_CONTEXT_RESULT_LIMIT,
} from "../../tools/context.js";
import {
  CALL_GRAPH_DIRECTIONS,
  CHUNK_TYPES,
  INDEX_LOG_CATEGORIES,
  INDEX_LOG_LEVELS,
  RELATIONSHIP_TYPES,
  CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD,
  CODE_COMMUNITIES_DEFAULT_LIMIT,
  CODE_COMMUNITIES_MAX_LIMIT,
  CODE_COMMUNITIES_MIN_SIZE,
  CODE_COMMUNITIES_MIN_COUPLING,
  CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT,
  CODE_COMMUNITIES_MAX_COUPLING_LIMIT,
  DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
} from "../../tools/contracts.js";
import {
  executeCallGraph,
  executeCallGraphPath,
  executeCodebaseContext,
  executeCodebaseEditContext,
  executeCodeCommunities,
  executeIndexCodebase,
  executeIndexHealthCheck,
  executeIndexLogs,
  executeIndexMetrics,
  executeIndexStatus,
  executeImplementationLookup,
} from "../../tools/execute-common.js";
import { formatPrImpact } from "../../tools/format-pr-impact.js";
import {
  findSimilarCode,
  getPrImpact,
  searchCodebaseWithEffectiveness,
} from "../../tools/operations.js";
import type { McpServerRuntime } from "./shared.js";
import { TOOL_NAME } from "../../tools/tool-names.js";

function allowNullAsUndefined<T extends z.ZodTypeAny>(schema: T): T {
  return z.preprocess((value) => (value === null ? undefined : value), schema) as unknown as T;
}

export function registerMcpTools(server: McpServer, runtime: McpServerRuntime): void {
  server.tool(
    TOOL_NAME.CODEBASE_CONTEXT,
    "PREFERRED FIRST TOOL for any question about this repository. Returns a deduplicated, file-diverse evidence pack within tokenBudget. Use before built-in code search, grep, shell search, or broad file reads. Provide from+to for a dependency path, with optional fromFilePath/toFilePath when names are ambiguous; provide symbol for a definition; or provide only query for low-token conceptual discovery. Use call_graph directly for callers or callees.",
    {
      query: z.string().describe("The codebase question or behavior to locate. Always provide the user's repository question here."),
      from: allowNullAsUndefined(z.string().optional()).describe("Source symbol. For dependency-path questions, extract the first endpoint and provide it here."),
      to: allowNullAsUndefined(z.string().optional()).describe("Target symbol. For dependency-path questions, extract the second endpoint and provide it here."),
      fromFilePath: allowNullAsUndefined(z.string().optional()).describe("Optional source file path used only to disambiguate duplicate source names."),
      toFilePath: allowNullAsUndefined(z.string().optional()).describe("Optional target file path used only to disambiguate duplicate target names."),
      symbol: allowNullAsUndefined(z.string().optional()).describe("Exact symbol for an authoritative definition lookup. Omit when from and to are supplied."),
      limit: allowNullAsUndefined(
        z.number().int().min(MIN_CONTEXT_RESULT_LIMIT).max(MAX_CONTEXT_RESULT_LIMIT).optional().default(10),
      ).describe(`Maximum number of search or definition results (${MIN_CONTEXT_RESULT_LIMIT}-${MAX_CONTEXT_RESULT_LIMIT})`),
      maxDepth: allowNullAsUndefined(
        z.number().int().min(MIN_CONTEXT_PATH_DEPTH).max(MAX_CONTEXT_PATH_DEPTH).optional().default(10),
      ).describe(`Maximum call-graph traversal depth for from/to path lookup (${MIN_CONTEXT_PATH_DEPTH}-${MAX_CONTEXT_PATH_DEPTH})`),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      tokenBudget: allowNullAsUndefined(
        z.number().int().min(MIN_CONTEXT_PACK_TOKEN_BUDGET).max(MAX_CONTEXT_PACK_TOKEN_BUDGET).optional()
          .default(DEFAULT_CONTEXT_PACK_TOKEN_BUDGET),
      ).describe(`Maximum response tokens for this context pack (${MIN_CONTEXT_PACK_TOKEN_BUDGET}-${MAX_CONTEXT_PACK_TOKEN_BUDGET})`),
      diagnostic: z.boolean().optional().describe("Collect diagnostic routing and search traces without changing normal text output."),
    },
    async (args) => {
      const result = await executeCodebaseContext(runtime.projectRoot, runtime.host, args);
      return {
        content: [{ type: "text", text: result.text }],
        ...(args.diagnostic ? { structuredContent: result.details } : {}),
      };
    },
  );

  server.tool(
    TOOL_NAME.CODEBASE_EDIT_CONTEXT,
    "PRE-EDIT TOOL for a known or suspected symbol. Returns token-bounded target source, direct callers and callees, or a risk-marked conceptual fallback when resolution is unsafe.",
    {
      query: z.string().describe("The requested change or target behavior."),
      symbol: allowNullAsUndefined(z.string().optional()).describe("Authoritative target symbol when known."),
      filePath: allowNullAsUndefined(z.string().optional()).describe("Optional file path used to disambiguate duplicate symbol names."),
      callerLimit: allowNullAsUndefined(z.number().int().min(MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT).max(MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT).optional()
        .default(DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT)),
      calleeLimit: allowNullAsUndefined(z.number().int().min(MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT).max(MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT).optional()
        .default(DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT)),
      tokenBudget: allowNullAsUndefined(z.number().int().min(MIN_CONTEXT_PACK_TOKEN_BUDGET).max(MAX_CONTEXT_PACK_TOKEN_BUDGET).optional()
        .default(DEFAULT_CONTEXT_PACK_TOKEN_BUDGET)),
    },
    async (args) => {
      const result = await executeCodebaseEditContext(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );


  server.tool(
    TOOL_NAME.CODEBASE_SEARCH,
    "FULL-CONTENT semantic retrieval. Use after codebase_peek when you need implementation text, not as the default first step. For exact identifiers or exhaustive matches use grep instead.",
    {
      query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
      limit: allowNullAsUndefined(z.number().optional().default(5)).describe("Maximum number of results to return"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: allowNullAsUndefined(z.enum(CHUNK_TYPES).optional()).describe("Filter by code chunk type"),
      contextLines: allowNullAsUndefined(z.number().optional()).describe("Number of extra lines to include before/after each match (default: 0)"),
      blameAuthor: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame author name or email"),
      blameSha: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame commit SHA or prefix"),
      blameSince: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or after this date"),
      blameUntil: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or before this date"),
    },
    async (args) => {
      return searchCodebaseWithEffectiveness(runtime.projectRoot, runtime.host, "search", args.query, {
        limit: args.limit ?? 5,
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        contextLines: args.contextLines,
        blameAuthor: args.blameAuthor,
        blameSha: args.blameSha,
        blameSince: args.blameSince,
        blameUntil: args.blameUntil,
      }, (results) => {
        const text = results.length === 0
          ? "No matching code found. Try a different query or run index_codebase first."
          : `Found ${results.length} results for "${args.query}":\n\n${formatSearchResults(results, "score")}`;
        return { output: { content: [{ type: "text" as const, text }] }, text };
      });
    },
  );

  server.tool(
    TOOL_NAME.CODEBASE_PEEK,
    "DIRECT LOW-TOKEN semantic location lookup for unfamiliar-code discovery. Prefer codebase_context when the request may involve definitions or graph navigation; use this specialized tool when you only need conceptual locations.",
    {
      query: z.string().describe("Natural language description of what code you're looking for."),
      limit: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum number of results to return"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: allowNullAsUndefined(z.enum(CHUNK_TYPES).optional()).describe("Filter by code chunk type"),
      blameAuthor: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame author name or email"),
      blameSha: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame commit SHA or prefix"),
      blameSince: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or after this date"),
      blameUntil: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or before this date"),
    },
    async (args) => {
      return searchCodebaseWithEffectiveness(runtime.projectRoot, runtime.host, "peek", args.query, {
        limit: args.limit ?? 10,
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        metadataOnly: true,
        blameAuthor: args.blameAuthor,
        blameSha: args.blameSha,
        blameSince: args.blameSince,
        blameUntil: args.blameUntil,
      }, (results) => {
        const text = results.length === 0
          ? "No matching code found. Try a different query or run index_codebase first."
          : `Found ${results.length} locations for "${args.query}":\n\n${formatCodebasePeek(results)}`;
        return { output: { content: [{ type: "text" as const, text }] }, text };
      });
    },
  );

  server.tool(
    TOOL_NAME.INDEX_CODEBASE,
    "Create or refresh the semantic index. Call index_status first when readiness is unknown, then use this tool only if the index is missing, stale, or incompatible. Incremental by default; force=true rebuilds everything.",
    {
      force: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Force reindex even if already indexed"),
      estimateOnly: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Only show cost estimate without indexing"),
      verbose: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Show detailed info about skipped files and parsing failures"),
    },
    async (args) => {
      const result = await executeIndexCodebase(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
    },
  );

  server.tool(
    TOOL_NAME.INDEX_STATUS,
    "START HERE once per repository task when index readiness or freshness is unknown. Reports whether semantic retrieval is ready, chunk counts, compatibility, and the embedding provider. If ready, continue with codebase_peek or implementation_lookup; otherwise run index_codebase.",
    {},
    async () => {
      const result = await executeIndexStatus(runtime.projectRoot, runtime.host);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    TOOL_NAME.INDEX_HEALTH_CHECK,
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
    {},
    async () => {
      const result = await executeIndexHealthCheck(runtime.projectRoot, runtime.host);
      return { content: [{ type: "text" as const, text: result.text }], ...(result.isError ? { isError: true } : {}) };
    },
  );

  server.tool(
    TOOL_NAME.INDEX_METRICS,
    "Get operational metrics plus opt-in privacy-safe repository-tool effectiveness counters. Metrics are memory-only. Set reset=true to clear them before reading. Operational metrics require debug.enabled=true and debug.metrics=true. Privacy-safe aggregates require only effectivenessMetrics.enabled=true.",
    {
      reset: z.boolean().optional().default(false).describe("Reset in-memory operational and effectiveness metrics before returning the snapshot"),
    },
    async (args) => {
      const result = await executeIndexMetrics(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    TOOL_NAME.INDEX_LOGS,
    "Get recent debug logs from the codebase indexer. Requires debug.enabled=true in config.",
    {
      limit: allowNullAsUndefined(z.number().optional().default(20)).describe("Maximum number of log entries to return"),
      category: allowNullAsUndefined(
        z.enum(INDEX_LOG_CATEGORIES).optional(),
      ).describe("Filter by log category"),
      level: allowNullAsUndefined(
        z.enum(INDEX_LOG_LEVELS).optional(),
      ).describe("Filter by minimum log level"),
    },
    async (args) => {
      const result = await executeIndexLogs(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    TOOL_NAME.FIND_SIMILAR,
    "Use when you already have a code snippet and need analogous implementations, duplicates, patterns, or refactoring candidates. For a natural-language concept without example code, start with codebase_peek instead.",
    {
      code: z.string().describe("The code snippet to find similar code for"),
      limit: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum number of results to return"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: allowNullAsUndefined(z.enum(CHUNK_TYPES).optional()).describe("Filter by code chunk type"),
      excludeFile: allowNullAsUndefined(z.string().optional()).describe("Exclude results from this file path"),
      blameSince: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or after this date"),
      blameUntil: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or before this date"),
    },
    async (args) => {
      const results = await findSimilarCode(runtime.projectRoot, runtime.host, args.code, {
        limit: args.limit ?? 10,
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        excludeFile: args.excludeFile,
        blameSince: args.blameSince,
        blameUntil: args.blameUntil,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No similar code found. Try a different snippet or run index_codebase first." }] };
      }

      return { content: [{ type: "text", text: `Found ${results.length} similar code blocks:\n\n${formatSearchResults(results)}` }] };
    },
  );

  server.tool(
    TOOL_NAME.IMPLEMENTATION_LOOKUP,
    "FIRST TOOL only for known-symbol definition questions. Returns authoritative source locations and prefers implementations over tests, docs, examples, and fixtures. Do not use for callers, callees, dependency paths, or code flow; use codebase_context with direction or from/to for those questions.",
    {
      query: z.string().describe("Symbol name or natural language description (e.g., 'validateToken', 'where is the payment handler defined')"),
      limit: allowNullAsUndefined(z.number().optional().default(5)).describe("Maximum number of results"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils')"),
    },
    async (args) => {
      const result = await executeImplementationLookup(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    TOOL_NAME.CALL_GRAPH,
    "Find direct callers or callees by function or method name. Unique names resolve automatically; when duplicate names are reported, retry with filePath."
      + " Supports relationship types: Call, MethodCall, Constructor, Import, Inherits, Implements.",
    {
      name: z.string().describe("Function or method name to query"),
      direction: allowNullAsUndefined(
        z.enum(CALL_GRAPH_DIRECTIONS).default("callers"),
      ).describe("Direction: 'callers' finds who calls this function, 'callees' finds what this function calls"),
      filePath: allowNullAsUndefined(z.string().optional()).describe("Optional file path used to disambiguate duplicate symbol names"),
      symbolId: allowNullAsUndefined(z.string().optional()).describe("Optional backward-compatible symbol ID escape hatch"),
      relationshipType: allowNullAsUndefined(
        z.enum(RELATIONSHIP_TYPES).optional(),
      ).describe("Filter by relationship type. Omit to show all."),
    },
    async (args) => {
      const result = await executeCallGraph(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    TOOL_NAME.CALL_GRAPH_PATH,
    "Find the shortest known call path between two named functions or methods. Unique names resolve automatically; when duplicate endpoints are reported, retry with fromFilePath or toFilePath.",
    {
      from: z.string().describe("Source function/method name (starting point)"),
      to: z.string().describe("Target function/method name (destination)"),
      fromFilePath: allowNullAsUndefined(z.string().optional()).describe("Optional source file path used to disambiguate duplicate source names"),
      toFilePath: allowNullAsUndefined(z.string().optional()).describe("Optional target file path used to disambiguate duplicate target names"),
      maxDepth: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum traversal depth (default: 10)"),
    },
    async (args) => {
      const result = await executeCallGraphPath(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );
  server.tool(
    TOOL_NAME.PR_IMPACT,
    "FIRST TOOL for pull-request or branch blast-radius questions. Analyzes changed files, affected symbols, transitive dependencies, communities, hub nodes, conflicts, and risk before merging.",
    {
      pr: allowNullAsUndefined(z.number().optional()).describe("Pull request number to analyze"),
      branch: allowNullAsUndefined(z.string().optional()).describe("Branch name to analyze (defaults to current branch)"),
      maxDepth: allowNullAsUndefined(z.number().optional().default(5)).describe("Maximum traversal depth for transitive callers (default: 5)"),
      hubThreshold: allowNullAsUndefined(z.number().optional().default(10)).describe("Minimum caller count to flag a symbol as a hub node (default: 10)"),
      checkConflicts: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Check for conflicting open PRs touching the same communities (default: false)"),
      direction: allowNullAsUndefined(
        z.enum(["callers", "callees", "both"]).optional().default("both"),
      ).describe("Call-graph traversal direction: 'callers' for upstream, 'callees' for downstream, 'both' for union (default: both)"),
    },
    async (args) => {
      try {
        const result = await getPrImpact(runtime.projectRoot, runtime.host, {
          pr: args.pr,
          branch: args.branch,
          maxDepth: args.maxDepth,
          hubThreshold: args.hubThreshold,
          checkConflicts: args.checkConflicts,
          direction: args.direction,
        });
        return { content: [{ type: "text", text: formatPrImpact(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error analyzing PR impact: ${message}` }] };
      }
    },
  );

  server.tool(
    TOOL_NAME.CODE_COMMUNITIES,
    "Discover natural module boundaries and hub symbols using graph community detection. " +
    "Clusters symbols by call-graph connectivity, reports community memberships, identifies " +
    "hub nodes with cross-community connections, and summarizes coupling relationships between communities.",
    {
      branch: allowNullAsUndefined(z.string().optional()).describe("Branch name to analyze (defaults to current branch)"),
      minSize: allowNullAsUndefined(z.number().int().min(CODE_COMMUNITIES_MIN_SIZE).optional().default(CODE_COMMUNITIES_MIN_SIZE)).describe("Minimum community size to include (default: 1)"),
      limit: allowNullAsUndefined(z.number().int().min(1).max(CODE_COMMUNITIES_MAX_LIMIT).optional().default(CODE_COMMUNITIES_DEFAULT_LIMIT)).describe("Maximum number of communities and hub nodes to return (default: 20)"),
      hubThreshold: allowNullAsUndefined(z.number().int().min(0).optional().default(CODE_COMMUNITIES_DEFAULT_HUB_THRESHOLD)).describe("Minimum distinct cross-community neighbors to flag a hub node (default: 5)"),
      minCoupling: allowNullAsUndefined(z.number().int().min(CODE_COMMUNITIES_MIN_COUPLING).optional().default(CODE_COMMUNITIES_MIN_COUPLING)).describe("Minimum distinct cross-community connection count to report a coupling (default: 1)"),
      couplingLimit: allowNullAsUndefined(z.number().int().min(1).max(CODE_COMMUNITIES_MAX_COUPLING_LIMIT).optional().default(CODE_COMMUNITIES_DEFAULT_COUPLING_LIMIT)).describe("Maximum number of couplings to return (default: 20)"),
    },
    async (args) => {
      const result = await executeCodeCommunities(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );
}
