import type { PrImpactResult } from "../../indexer/pr-impact-types.js";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getIndexerForProject } from "./tools.js";
import { formatPrImpact } from "../../tools/format-pr-impact.js";
import { calculatePercentage, formatProgressTitle } from "../../tools/utils.js";

const z = tool.schema;
const AUTOMATIC_PREPARATION_POLICY =
  "Uses configured maxFileSize, maxChunksPerFile, maxDepth, and maxFilesPerDirectory guards. "
  + "No separate aggregate token or cost ceiling is configured; maxDepth=-1 remains unlimited.";

export const pr_impact: ToolDefinition = tool({
  description:
    "Analyze the impact of a pull request or branch by examining changed files, " +
    "affected symbols, transitive callers, communities touched, hub nodes, and risk level. " +
    "Use to understand blast radius before merging.",
  args: {
    pr: z.number().optional().describe("Pull request number to analyze"),
    branch: z.string().optional().describe("Branch name to analyze (defaults to current branch)"),
    maxDepth: z.number().optional().default(5).describe("Maximum traversal depth for transitive callers (default: 5)"),
    hubThreshold: z.number().optional().default(10).describe("Minimum caller count to flag a symbol as a hub node (default: 10)"),
    checkConflicts: z.boolean().optional().default(false).describe("Check for conflicting open PRs touching the same communities (default: false)"),
    direction: z.enum(["callers", "callees", "both"]).optional().default("both").describe("Call-graph traversal direction: 'callers' for upstream, 'callees' for downstream, 'both' for union (default: both)"),
  },
  async execute(args, context) {
    const indexer = getIndexerForProject(context?.worktree);
    try {
      context.metadata?.({
        title: "Preparing impact analysis: resolving authoritative branch head",
        metadata: {
          phase: "resolving-head",
          preparationPolicy: AUTOMATIC_PREPARATION_POLICY,
        },
      });
      const result: PrImpactResult = await indexer.getPrImpact({
        pr: args.pr,
        branch: args.branch,
        maxDepth: args.maxDepth,
        hubThreshold: args.hubThreshold,
        checkConflicts: args.checkConflicts,
        direction: args.direction,
      }, (progress) => {
        context.metadata?.({
          title: `Preparing branch index: ${formatProgressTitle(progress)}`,
          metadata: {
            phase: progress.phase,
            filesProcessed: progress.filesProcessed,
            totalFiles: progress.totalFiles,
            chunksProcessed: progress.chunksProcessed,
            totalChunks: progress.totalChunks,
            percentage: calculatePercentage(progress),
            preparationPolicy: AUTOMATIC_PREPARATION_POLICY,
          },
        });
      });
      return formatPrImpact(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error analyzing PR impact: ${message}`;
    }
  },
});
