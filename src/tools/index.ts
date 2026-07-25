import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type { HostMode } from "../config/host.js";
import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { Indexer } from "../indexer/index.js";
import { formatCostEstimate } from "../utils/cost.js";
import {
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  formatCodebasePeek,
  formatCallGraphCallees,
  formatCallGraphCallers,
  formatCallGraphPath,
  formatDefinitionLookup,
  formatHealthCheck,
  formatIndexStats,
  formatSearchResults,
  formatStatus,
  MAX_CONTEXT_PACK_TOKEN_BUDGET,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
} from "./utils.js";
import {
  addKnowledgeBase,
  findSimilarCode,
  getCallGraphData,
  getCallGraphPath,
  getIndexLogs,
  getIndexMetrics,
  getIndexerForProject as getOperationIndexerForProject,
  getIndexStatus,
  getSharedIndexer as getOperationSharedIndexer,
  implementationLookup,
  initializeTools as initializeToolOperations,
  listKnowledgeBases,
  removeKnowledgeBase,
  runIndexCodebase,
  runIndexHealthCheck,
  searchCodebase,
} from "./operations.js";
import { pr_impact } from "./pr-impact.js";
import {
  MAX_CONTEXT_PATH_DEPTH,
  MAX_CONTEXT_RESULT_LIMIT,
  MIN_CONTEXT_PATH_DEPTH,
  MIN_CONTEXT_RESULT_LIMIT,
  resolveCodebaseContext,
} from "./context.js";
import { writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { attachRecentActivity } from "./visualize/activity.js";
import { generateVisualizationHtml, transformForVisualization } from "./visualize/index.js";

const z = tool.schema;
const DEFAULT_HOST: HostMode = "opencode";
const CHUNK_TYPE_VALUES = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "struct",
  "impl",
  "trait",
  "module",
  "other",
] as const;
const RELATIONSHIP_TYPE_VALUES = ["Call", "MethodCall", "Constructor", "Import", "Inherits", "Implements"] as const;

export function initializeTools(projectRoot: string, config: ParsedCodebaseIndexConfig): void {
  initializeToolOperations(projectRoot, config, DEFAULT_HOST);
}

export function getSharedIndexer(): Indexer {
  return getOperationSharedIndexer(DEFAULT_HOST);
}

export function getIndexerForProject(directory: string): Indexer {
  return getOperationIndexerForProject(directory, DEFAULT_HOST);
}

export const codebase_context: ToolDefinition = tool({
  description:
    "PREFERRED FIRST TOOL for repository questions. Returns a deduplicated, file-diverse evidence pack within tokenBudget. Provide from and to for dependency paths, symbol for definitions, or only query for conceptual discovery.",
  args: {
    query: z.string().describe("The repository question or behavior to locate"),
    from: z.string().nullable().optional().describe("Source symbol for a dependency path"),
    to: z.string().nullable().optional().describe("Target symbol for a dependency path"),
    symbol: z.string().nullable().optional().describe("Exact symbol for authoritative definition lookup"),
    limit: z.number().int().min(MIN_CONTEXT_RESULT_LIMIT).max(MAX_CONTEXT_RESULT_LIMIT).nullable().optional().default(10)
      .describe(`Maximum number of results (${MIN_CONTEXT_RESULT_LIMIT}-${MAX_CONTEXT_RESULT_LIMIT})`),
    maxDepth: z.number().int().min(MIN_CONTEXT_PATH_DEPTH).max(MAX_CONTEXT_PATH_DEPTH).nullable().optional().default(10)
      .describe(`Maximum call-path traversal depth (${MIN_CONTEXT_PATH_DEPTH}-${MAX_CONTEXT_PATH_DEPTH})`),
    fileType: z.string().nullable().optional().describe("Filter by file extension"),
    directory: z.string().nullable().optional().describe("Filter by directory path"),
    tokenBudget: z.number().int().min(MIN_CONTEXT_PACK_TOKEN_BUDGET).max(MAX_CONTEXT_PACK_TOKEN_BUDGET)
      .nullable().optional().default(DEFAULT_CONTEXT_PACK_TOKEN_BUDGET)
      .describe(`Maximum response tokens (${MIN_CONTEXT_PACK_TOKEN_BUDGET}-${MAX_CONTEXT_PACK_TOKEN_BUDGET})`),
  },
  async execute(args, context) {
    return (await resolveCodebaseContext(context?.worktree, DEFAULT_HOST, args)).text;
  },
});

export const codebase_peek: ToolDefinition = tool({
  description:
    "Quick lookup of code locations by meaning. Returns only metadata (file, line, name, type) WITHOUT code content. Use this first to find WHERE code is, then use Read tool to examine specific files. Saves tokens by not returning full code blocks. Best for: discovery, navigation, finding multiple related locations.",
  args: {
    query: z.string().describe("Natural language description of what code you're looking for."),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(CHUNK_TYPE_VALUES).optional().describe("Filter by code chunk type"),
    blameAuthor: z.string().optional().describe("Filter by git blame author name or email"),
    blameSha: z.string().optional().describe("Filter by git blame commit SHA or prefix"),
    blameSince: z.string().optional().describe("Filter to chunks last changed on or after this date (e.g., 2025-01-01)"),
  },
  async execute(args, context) {
    const results = await searchCodebase(context?.worktree, DEFAULT_HOST, args.query, {
      limit: args.limit ?? 10,
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
      metadataOnly: true,
      blameAuthor: args.blameAuthor,
      blameSha: args.blameSha,
      blameSince: args.blameSince,
    });

    return formatCodebasePeek(results);
  },
});

export const index_codebase: ToolDefinition = tool({
  description:
    "Index the codebase for semantic search. Creates vector embeddings of code chunks. Incremental - only re-indexes changed files (~50ms when nothing changed). Run before first codebase_search.",
  args: {
    force: z.boolean().optional().default(false).describe("Force reindex even if already indexed"),
    estimateOnly: z.boolean().optional().default(false).describe("Only show cost estimate without indexing"),
    verbose: z.boolean().optional().default(false).describe("Show detailed info about skipped files and parsing failures"),
  },
  async execute(args, context) {
    const result = await runIndexCodebase(context?.worktree, DEFAULT_HOST, args, (title, metadata) => {
      context.metadata({ title, metadata });
    });

    if (result.kind === "estimate") return formatCostEstimate(result.estimate);
    if (result.kind === "busy") return result.text;
    return formatIndexStats(result.stats, args.verbose ?? false);
  },
});

export const index_status: ToolDefinition = tool({
  description:
    "Check the status of the codebase index. Shows whether the codebase is indexed, how many chunks are stored, and the embedding provider being used.",
  args: {},
  async execute(_args, context) {
    return formatStatus(await getIndexStatus(context?.worktree, DEFAULT_HOST));
  },
});

export const index_health_check: ToolDefinition = tool({
  description:
    "Check index health and remove stale entries from deleted files. Run this to clean up the index after files have been deleted.",
  args: {},
  async execute(_args, context) {
    const result = await runIndexHealthCheck(context?.worktree, DEFAULT_HOST);
    if (result.kind === "busy") return result.text;
    return formatHealthCheck(result.health);
  },
});

export const index_metrics: ToolDefinition = tool({
  description:
    "Get metrics and performance statistics for the codebase index. Shows indexing stats, search timings, cache hit rates, and API usage. Requires debug.enabled=true and debug.metrics=true in config.",
  args: {},
  async execute(_args, context) {
    return (await getIndexMetrics(context?.worktree, DEFAULT_HOST)).text;
  },
});

export const index_logs: ToolDefinition = tool({
  description:
    "Get recent debug logs from the codebase indexer. Shows timestamped log entries with level and category. Requires debug.enabled=true in config.",
  args: {
    limit: z.number().optional().default(20).describe("Maximum number of log entries to return"),
    category: z.enum(["search", "embedding", "cache", "gc", "branch", "general"]).optional().describe("Filter by log category"),
    level: z.enum(["error", "warn", "info", "debug"]).optional().describe("Filter by minimum log level"),
  },
  async execute(args, context) {
    return (await getIndexLogs(context?.worktree, DEFAULT_HOST, args)).text;
  },
});

export const find_similar: ToolDefinition = tool({
  description:
    "Find code similar to a given snippet. Use for duplicate detection, pattern discovery, or refactoring prep. Paste code and find semantically similar implementations elsewhere in the codebase.",
  args: {
    code: z.string().describe("The code snippet to find similar code for"),
    limit: z.number().optional().default(10).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(CHUNK_TYPE_VALUES).optional().describe("Filter by code chunk type"),
    excludeFile: z.string().optional().describe("Exclude results from this file path (useful when searching for duplicates of code from a specific file)"),
  },
  async execute(args, context) {
    const results = await findSimilarCode(context?.worktree, DEFAULT_HOST, args.code, {
      limit: args.limit,
      fileType: args.fileType,
      directory: args.directory,
      chunkType: args.chunkType,
      excludeFile: args.excludeFile,
    });

    if (results.length === 0) {
      return "No similar code found. Try a different snippet or run index_codebase first.";
    }

    return formatSearchResults(results);
  },
});

export const codebase_search: ToolDefinition = tool({
  description:
    "Search codebase by MEANING, not keywords. Returns full code content. Use when you need to see actual implementation. For just finding WHERE code is (saves ~90% tokens), use codebase_peek instead. For known identifiers like 'validateToken', use grep - it's faster.",
  args: {
    query: z.string().describe("Natural language description of what code you're looking for. Describe behavior, not syntax."),
    limit: z.number().optional().default(5).describe("Maximum number of results to return"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py', 'rs')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils', 'lib')"),
    chunkType: z.enum(CHUNK_TYPE_VALUES).optional().describe("Filter by code chunk type"),
    contextLines: z.number().optional().describe("Number of extra lines to include before/after each match (default: 0)"),
    blameAuthor: z.string().optional().describe("Filter by git blame author name or email"),
    blameSha: z.string().optional().describe("Filter by git blame commit SHA or prefix"),
    blameSince: z.string().optional().describe("Filter to chunks last changed on or after this date (e.g., 2025-01-01)"),
  },
  async execute(args, context) {
    const results = await searchCodebase(context?.worktree, DEFAULT_HOST, args.query, {
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
      return "No matching code found. Try a different query or run index_codebase first.";
    }

    return formatSearchResults(results, "score");
  },
});

export const implementation_lookup: ToolDefinition = tool({
  description:
    "Jump to symbol definition. Find WHERE something is defined. " +
    "Returns the authoritative source location(s) for a function, class, method, type, or variable. " +
    "Prefers real implementation files over tests, docs, examples, and fixtures. " +
    "Use when you need the definition site, not all usages.",
  args: {
    query: z.string().describe("Symbol name or natural language description (e.g., 'validateToken', 'where is the payment handler defined')"),
    limit: z.number().optional().default(5).describe("Maximum number of results"),
    fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts', 'py')"),
    directory: z.string().optional().describe("Filter by directory path (e.g., 'src/utils')"),
  },
  async execute(args, context) {
    const results = await implementationLookup(context?.worktree, DEFAULT_HOST, args.query, {
      limit: args.limit ?? 5,
      fileType: args.fileType,
      directory: args.directory,
    });
    return formatDefinitionLookup(results, args.query);
  },
});

export const call_graph: ToolDefinition = tool({
  description:
    "Query the call graph to find callers or callees of a function/method. Use to understand code flow and dependencies between functions."
    + " Supports relationship types: Call, MethodCall, Constructor, Import, Inherits, Implements.",
  args: {
    name: z.string().describe("Function or method name to query"),
    direction: z.enum(["callers", "callees"]).default("callers").describe("Direction: 'callers' finds who calls this function, 'callees' finds what this function calls"),
    symbolId: z.string().optional().describe("Symbol ID (required for 'callees' direction, returned by previous call_graph queries)"),
    relationshipType: z.enum(RELATIONSHIP_TYPE_VALUES).optional().describe("Filter by relationship type. Omit to show all."),
  },
  async execute(args, context) {
    if (args.direction === "callees") {
      if (!args.symbolId) {
        return "Error: 'symbolId' is required when direction is 'callees'. First use direction='callers' to find the symbol ID.";
      }
      const { callees } = await getCallGraphData(context?.worktree, DEFAULT_HOST, args);
      return formatCallGraphCallees(args.symbolId, callees, args.relationshipType);
    }

    const { callers } = await getCallGraphData(context?.worktree, DEFAULT_HOST, args);
    return formatCallGraphCallers(args.name, callers, args.relationshipType);
  },
});

export const call_graph_path: ToolDefinition = tool({
  description:
    "Find the shortest connection path between two symbols in the call graph. Given a source and target function/method name, returns the chain of calls connecting them.",
  args: {
    from: z.string().describe("Source function/method name (starting point)"),
    to: z.string().describe("Target function/method name (destination)"),
    maxDepth: z.number().optional().default(10).describe("Maximum traversal depth (default: 10)"),
  },
  async execute(args, context) {
    const path = await getCallGraphPath(context?.worktree, DEFAULT_HOST, args.from, args.to, args.maxDepth);
    return formatCallGraphPath(args.from, args.to, path);
  },
});

export const add_knowledge_base: ToolDefinition = tool({
  description:
    "Add a folder as a knowledge base to the semantic search index. " +
    "The folder will be indexed alongside the main project code. " +
    "Supports absolute paths or relative paths (relative to the project root).",
  args: {
    path: z.string().describe("Path to the folder to add as a knowledge base (absolute or relative to the project root)"),
  },
  async execute(args, context) {
    return addKnowledgeBase(context?.worktree, DEFAULT_HOST, args.path);
  },
});

export const list_knowledge_bases: ToolDefinition = tool({
  description:
    "List all configured knowledge base folders that are indexed alongside the main project.",
  args: {},
  async execute(_args, context) {
    return listKnowledgeBases(context?.worktree, DEFAULT_HOST);
  },
});

export const remove_knowledge_base: ToolDefinition = tool({
  description:
    "Remove a knowledge base folder from the semantic search index.",
  args: {
    path: z.string().describe("Path of the knowledge base to remove (must match the configured path exactly)"),
  },
  async execute(args, context) {
    return removeKnowledgeBase(context?.worktree, DEFAULT_HOST, args.path.trim());
  },
});

export { pr_impact };

export const index_visualize: ToolDefinition = tool({
  description:
    "Generate an interactive HTML visualization of recent code movement and the call graph. " +
    "Starts with temporal onboarding context from Git history, then supports module, symbol, hotspot, and cycle drill-down.",
  args: {
    directory: z.string().optional().describe("Filter to symbols in this directory (e.g., 'src/services')"),
    maxNodes: z.number().optional().default(5000).describe("Maximum nodes to include (default 5000)"),
    includeOrphans: z.boolean().optional().default(false).describe("Include symbols with no call relationships"),
  },
  async execute(args, context) {
    const projectRoot = context?.worktree ?? process.cwd();
    const indexer = getIndexerForProject(projectRoot);
    const rawData = await indexer.getVisualizationData({
      directory: args.directory,
    });

    if (rawData.symbols.length === 0) {
      return "No call graph data found. Run index_codebase first to build the call graph.";
    }

    const vizData = attachRecentActivity(transformForVisualization(rawData.symbols, rawData.edges, {
      includeOrphans: args.includeOrphans,
      directory: args.directory,
      maxNodes: args.maxNodes,
    }), projectRoot);

    if (vizData.nodes.length === 0) {
      return "No connected symbols found for visualization. Try including orphans with includeOrphans=true, or check that the call graph has resolved edges.";
    }

    const html = generateVisualizationHtml(vizData);
    const outputPath = path.join(os.tmpdir(), `call-graph-${Date.now()}.html`);
    writeFileSync(outputPath, html, "utf-8");

    let result = `Temporal call graph visualization generated: ${outputPath}\n\n`;
    result += `Nodes: ${vizData.nodes.length} | Edges: ${vizData.edges.length}\n`;
    result += `Recent change lenses: ${vizData.changes?.length ?? 0}\n`;
    result += `Files: ${new Set(vizData.nodes.map(n => n.filePath)).size}\n`;
    result += `Directories: ${new Set(vizData.nodes.map(n => n.directory)).size}`;
    if (vizData.metadata.truncated) {
      result += `\n\n\u26a0\ufe0f Graph truncated to ${args.maxNodes} most-connected nodes (total: ${rawData.symbols.length}).`;
    }

    return result;
  },
});
