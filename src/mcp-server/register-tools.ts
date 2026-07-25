import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatCostEstimate } from "../utils/cost.js";
import {
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  formatCallGraphCallees,
  formatCallGraphCallers,
  formatCallGraphPath,
  formatCodebasePeek,
  formatDefinitionLookup,
  formatHealthCheck,
  formatIndexStats,
  formatSearchResults,
  formatStatus,
  MAX_CONTEXT_PACK_TOKEN_BUDGET,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
} from "../tools/utils.js";
import { resolveCodebaseContext } from "../tools/context.js";
import { formatPrImpact } from "../tools/format-pr-impact.js";
import {
  findSimilarCode,
  getCallGraphData,
  getCallGraphPath,
  getIndexLogs,
  getIndexMetrics,
  getIndexStatus,
  getPrImpact,
  implementationLookup,
  runIndexCodebase,
  runIndexHealthCheck,
  searchCodebase,
} from "../tools/operations.js";
import { CHUNK_TYPE_ENUM, type McpServerRuntime } from "./shared.js";

function allowNullAsUndefined<T extends z.ZodTypeAny>(schema: T): T {
  return z.preprocess((value) => (value === null ? undefined : value), schema) as unknown as T;
}

export function registerMcpTools(server: McpServer, runtime: McpServerRuntime): void {
  server.tool(
    "codebase_context",
    "PREFERRED FIRST TOOL for any question about this repository. Returns a deduplicated, file-diverse evidence pack within tokenBudget. Use before built-in code search, grep, shell search, or broad file reads. Provide from+to for a dependency path, symbol for a definition, or only query for low-token conceptual discovery. Use call_graph directly for callers or callees.",
    {
      query: z.string().describe("The codebase question or behavior to locate. Always provide the user's repository question here."),
      from: allowNullAsUndefined(z.string().optional()).describe("Source symbol. For dependency-path questions, extract the first endpoint and provide it here."),
      to: allowNullAsUndefined(z.string().optional()).describe("Target symbol. For dependency-path questions, extract the second endpoint and provide it here."),
      symbol: allowNullAsUndefined(z.string().optional()).describe("Exact symbol for an authoritative definition lookup. Omit when from and to are supplied."),
      limit: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum number of search or definition results"),
      maxDepth: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum call-graph traversal depth for from/to path lookup"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      tokenBudget: allowNullAsUndefined(
        z.number().int().min(MIN_CONTEXT_PACK_TOKEN_BUDGET).max(MAX_CONTEXT_PACK_TOKEN_BUDGET).optional()
          .default(DEFAULT_CONTEXT_PACK_TOKEN_BUDGET),
      ).describe(`Maximum response tokens for this context pack (${MIN_CONTEXT_PACK_TOKEN_BUDGET}-${MAX_CONTEXT_PACK_TOKEN_BUDGET})`),
    },
    async (args) => {
      const result = await resolveCodebaseContext(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );


  server.tool(
    "codebase_search",
    "FULL-CONTENT semantic retrieval. Use after codebase_peek when you need implementation text, not as the default first step. For exact identifiers or exhaustive matches use grep instead.",
    {
      query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
      limit: allowNullAsUndefined(z.number().optional().default(5)).describe("Maximum number of results to return"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: allowNullAsUndefined(z.enum(CHUNK_TYPE_ENUM).optional()).describe("Filter by code chunk type"),
      contextLines: allowNullAsUndefined(z.number().optional()).describe("Number of extra lines to include before/after each match (default: 0)"),
      blameAuthor: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame author name or email"),
      blameSha: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame commit SHA or prefix"),
      blameSince: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or after this date"),
    },
    async (args) => {
      const results = await searchCodebase(runtime.projectRoot, runtime.host, args.query, {
        limit: args.limit ?? 5,
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        contextLines: args.contextLines,
        blameAuthor: args.blameAuthor,
        blameSha: args.blameSha,
        blameSince: args.blameSince,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching code found. Try a different query or run index_codebase first." }] };
      }

      return { content: [{ type: "text", text: `Found ${results.length} results for "${args.query}":\n\n${formatSearchResults(results, "score")}` }] };
    },
  );

  server.tool(
    "codebase_peek",
    "DIRECT LOW-TOKEN semantic location lookup for unfamiliar-code discovery. Prefer codebase_context when the request may involve definitions or graph navigation; use this specialized tool when you only need conceptual locations.",
    {
      query: z.string().describe("Natural language description of what code you're looking for."),
      limit: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum number of results to return"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: allowNullAsUndefined(z.enum(CHUNK_TYPE_ENUM).optional()).describe("Filter by code chunk type"),
      blameAuthor: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame author name or email"),
      blameSha: allowNullAsUndefined(z.string().optional()).describe("Filter by git blame commit SHA or prefix"),
      blameSince: allowNullAsUndefined(z.string().optional()).describe("Filter to chunks last changed on or after this date"),
    },
    async (args) => {
      const results = await searchCodebase(runtime.projectRoot, runtime.host, args.query, {
        limit: args.limit ?? 10,
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        metadataOnly: true,
        blameAuthor: args.blameAuthor,
        blameSha: args.blameSha,
        blameSince: args.blameSince,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching code found. Try a different query or run index_codebase first." }] };
      }

      return { content: [{ type: "text", text: `Found ${results.length} locations for "${args.query}":\n\n${formatCodebasePeek(results)}\n\nUse Read tool to examine specific files.` }] };
    },
  );

  server.tool(
    "index_codebase",
    "Create or refresh the semantic index. Call index_status first when readiness is unknown, then use this tool only if the index is missing, stale, or incompatible. Incremental by default; force=true rebuilds everything.",
    {
      force: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Force reindex even if already indexed"),
      estimateOnly: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Only show cost estimate without indexing"),
      verbose: allowNullAsUndefined(z.boolean().optional().default(false)).describe("Show detailed info about skipped files and parsing failures"),
    },
    async (args) => {
      const result = await runIndexCodebase(runtime.projectRoot, runtime.host, args);
      if (result.kind === "estimate") {
        return { content: [{ type: "text", text: formatCostEstimate(result.estimate) }] };
      }
      if (result.kind === "busy") {
        return { content: [{ type: "text", text: result.text }], isError: true };
      }
      return { content: [{ type: "text", text: formatIndexStats(result.stats, args.verbose ?? false) }] };
    },
  );

  server.tool(
    "index_status",
    "START HERE once per repository task when index readiness or freshness is unknown. Reports whether semantic retrieval is ready, chunk counts, compatibility, and the embedding provider. If ready, continue with codebase_peek or implementation_lookup; otherwise run index_codebase.",
    {},
    async () => {
      const status = await getIndexStatus(runtime.projectRoot, runtime.host);
      return { content: [{ type: "text", text: formatStatus(status) }] };
    },
  );

  server.tool(
    "index_health_check",
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
    {},
    async () => {
      const result = await runIndexHealthCheck(runtime.projectRoot, runtime.host);
      if (result.kind === "busy") {
        return { content: [{ type: "text" as const, text: result.text }], isError: true };
      }
      return { content: [{ type: "text" as const, text: formatHealthCheck(result.health) }] };
    },
  );

  server.tool(
    "index_metrics",
    "Get metrics and performance statistics for the codebase index. Requires debug.enabled=true and debug.metrics=true in config.",
    {},
    async () => {
      const result = await getIndexMetrics(runtime.projectRoot, runtime.host);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    "index_logs",
    "Get recent debug logs from the codebase indexer. Requires debug.enabled=true in config.",
    {
      limit: allowNullAsUndefined(z.number().optional().default(20)).describe("Maximum number of log entries to return"),
      category: allowNullAsUndefined(
        z.enum(["search", "embedding", "cache", "gc", "branch", "general"]).optional(),
      ).describe("Filter by log category"),
      level: allowNullAsUndefined(
        z.enum(["error", "warn", "info", "debug"]).optional(),
      ).describe("Filter by minimum log level"),
    },
    async (args) => {
      const result = await getIndexLogs(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: result.text }] };
    },
  );

  server.tool(
    "find_similar",
    "Use when you already have a code snippet and need analogous implementations, duplicates, patterns, or refactoring candidates. For a natural-language concept without example code, start with codebase_peek instead.",
    {
      code: z.string().describe("The code snippet to find similar code for"),
      limit: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum number of results to return"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
      chunkType: allowNullAsUndefined(z.enum(CHUNK_TYPE_ENUM).optional()).describe("Filter by code chunk type"),
      excludeFile: allowNullAsUndefined(z.string().optional()).describe("Exclude results from this file path"),
    },
    async (args) => {
      const results = await findSimilarCode(runtime.projectRoot, runtime.host, args.code, {
        limit: args.limit ?? 10,
        fileType: args.fileType,
        directory: args.directory,
        chunkType: args.chunkType,
        excludeFile: args.excludeFile,
      });

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No similar code found. Try a different snippet or run index_codebase first." }] };
      }

      return { content: [{ type: "text", text: `Found ${results.length} similar code blocks:\n\n${formatSearchResults(results)}` }] };
    },
  );

  server.tool(
    "implementation_lookup",
    "FIRST TOOL only for known-symbol definition questions. Returns authoritative source locations and prefers implementations over tests, docs, examples, and fixtures. Do not use for callers, callees, dependency paths, or code flow; use codebase_context with direction or from/to for those questions.",
    {
      query: z.string().describe("Symbol name or natural language description (e.g., 'validateToken', 'where is the payment handler defined')"),
      limit: allowNullAsUndefined(z.number().optional().default(5)).describe("Maximum number of results"),
      fileType: allowNullAsUndefined(z.string().optional()).describe("Filter by file extension (e.g., 'ts', 'py')"),
      directory: allowNullAsUndefined(z.string().optional()).describe("Filter by directory path (e.g., 'src/utils')"),
    },
    async (args) => {
      const results = await implementationLookup(runtime.projectRoot, runtime.host, args.query, {
        limit: args.limit ?? 5,
        fileType: args.fileType,
        directory: args.directory,
      });

      return { content: [{ type: "text", text: formatDefinitionLookup(results, args.query) }] };
    },
  );

  server.tool(
    "call_graph",
    "Use after identifying a symbol to find its direct callers or callees and understand code flow. Use implementation_lookup first if the symbol or definition is still ambiguous."
      + " Supports relationship types: Call, MethodCall, Constructor, Import, Inherits, Implements.",
    {
      name: z.string().describe("Function or method name to query"),
      direction: allowNullAsUndefined(
        z.enum(["callers", "callees"]).default("callers"),
      ).describe("Direction: 'callers' finds who calls this function, 'callees' finds what this function calls"),
      symbolId: allowNullAsUndefined(z.string().optional()).describe("Symbol ID (required for 'callees' direction)"),
      relationshipType: allowNullAsUndefined(
        z.enum(["Call", "MethodCall", "Constructor", "Import", "Inherits", "Implements"]).optional(),
      ).describe("Filter by relationship type. Omit to show all."),
    },
    async (args) => {
      if (args.direction === "callees") {
        if (!args.symbolId) {
          return { content: [{ type: "text", text: "Error: 'symbolId' is required when direction is 'callees'." }] };
        }
        const { callees } = await getCallGraphData(runtime.projectRoot, runtime.host, args);
        return { content: [{ type: "text", text: formatCallGraphCallees(args.symbolId, callees, args.relationshipType) }] };
      }

      const { callers } = await getCallGraphData(runtime.projectRoot, runtime.host, args);
      return { content: [{ type: "text", text: formatCallGraphCallers(args.name, callers, args.relationshipType) }] };
    },
  );

  server.tool(
    "call_graph_path",
    "Use after identifying both endpoint symbols to find the shortest known call path between them. Use codebase_peek or implementation_lookup first when either endpoint is unknown.",
    {
      from: z.string().describe("Source function/method name (starting point)"),
      to: z.string().describe("Target function/method name (destination)"),
      maxDepth: allowNullAsUndefined(z.number().optional().default(10)).describe("Maximum traversal depth (default: 10)"),
    },
    async (args) => {
      const path = await getCallGraphPath(runtime.projectRoot, runtime.host, args.from, args.to, args.maxDepth);
      return { content: [{ type: "text", text: formatCallGraphPath(args.from, args.to, path) }] };
    },
  );
  server.tool(
    "pr_impact",
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
}
