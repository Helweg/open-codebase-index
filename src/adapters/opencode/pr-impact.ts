import type { PrImpactResult } from "../../indexer/pr-impact-types.js";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { getIndexerForProject } from "./tools.js";
import { formatPrImpact } from "../../tools/format-pr-impact.js";
import { getPrImpact } from "../../tools/operations.js";
import { calculatePercentage, formatProgressTitle } from "../../tools/utils.js";
import { isOperationInterruption, throwIfOperationAborted } from "../../utils/operation-control.js";

const z = tool.schema;
const AUTOMATIC_PREPARATION_POLICY =
  "Uses configured maxFileSize, maxChunksPerFile, maxDepth, and maxFilesPerDirectory guards. "
  + "No separate aggregate token or cost ceiling is configured; maxDepth=-1 remains unlimited.";

export const pr_impact: ToolDefinition = tool({
  description:
    "Analyze a pull request, branch, or working tree through changed files, " +
    "current indexed symbols, transitive callers, communities, hubs, and risk. " +
    "Working-tree mode inspects staged, unstaged, and untracked paths without refreshing the index.",
  args: {
    pr: z.number().optional().describe("Pull request number to analyze"),
    branch: z.string().optional().describe("Branch name to analyze (defaults to current branch)"),
    workingTree: z.boolean().optional().default(false).describe("Inspect current indexed file contents for staged, unstaged, and untracked paths; cannot combine with pr, branch, or checkConflicts"),
    maxDepth: z.number().optional().default(5).describe("Maximum traversal depth for transitive callers (default: 5)"),
    hubThreshold: z.number().optional().default(10).describe("Minimum caller count to flag a symbol as a hub node (default: 10)"),
    checkConflicts: z.boolean().optional().default(false).describe("Check for conflicting open PRs touching the same communities (default: false)"),
    direction: z.enum(["callers", "callees", "both"]).optional().default("both").describe("Call-graph traversal direction: 'callers' for upstream, 'callees' for downstream, 'both' for union (default: both)"),
  },
  async execute(args, context) {
    throwIfOperationAborted(context?.abort);
    try {
      if (args.workingTree) {
        const result = await getPrImpact(context?.worktree, "opencode", args, {
          signal: context?.abort,
          setPhase: (phase) => {
            context.metadata?.({
              title: "Inspecting current indexed working-tree files",
              metadata: { phase },
            });
          },
        });
        return formatPrImpact(result);
      }
      const indexer = getIndexerForProject(context?.worktree);
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
      }, { signal: context?.abort });
      return formatPrImpact(result);
    } catch (error) {
      if (isOperationInterruption(error)) throw error;
      throwIfOperationAborted(context?.abort);
      const message = error instanceof Error ? error.message : String(error);
      return `Error analyzing PR impact: ${message}`;
    }
  },
});
