import type { HostMode } from "../config/host.js";
import type {
  SharedCallGraphArgs,
  SharedCallGraphPathArgs,
  SharedCodebaseContextArgs,
  SharedCodebaseEditContextArgs,
  SharedArchitectureContextArgs,
  SharedCodeCommunitiesArgs,
  SharedIndexCodebaseArgs,
  SharedIndexLogsArgs,
  SharedIndexMetricsArgs,
  SharedImplementationLookupArgs,
} from "./contracts.js";
import {
  getCallGraphData,
  getCallGraphPath,
  getCodeCommunities,
  getArchitectureContext,
  getIndexLogs,
  getIndexMetrics,
  getIndexStatus,
  implementationLookup,
  isExactSymbolQuery,
  runIndexCodebase,
  runIndexHealthCheck,
} from "./operations.js";
import { formatCostEstimate, formatDryRunEstimate } from "../utils/cost.js";
import { resolveCodebaseEditContext } from "./edit-context.js";
import { resolveCodebaseContext } from "./context.js";
import {
  formatCallGraphPathResult,
  formatCallGraphResult,
  formatDefinitionLookup,
  formatHealthCheck,
  formatIndexStats,
  formatStatus,
} from "./utils.js";
import { formatCodeCommunities } from "./format-communities.js";
import type { OperationControl } from "../utils/operation-control.js";
import { runOperationPhase } from "../utils/operation-control.js";

export interface ExecutionResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
  error?: unknown;
}

export type IndexProgressCallback = (title: string, metadata: Record<string, unknown>) => void | Promise<void>;

export async function executeCodebaseContext(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCodebaseContextArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const result = await resolveCodebaseContext(projectRoot, host, args, control);
  return { text: result.text, details: result.details };
}

export async function executeCodebaseEditContext(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCodebaseEditContextArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  return { text: (await resolveCodebaseEditContext(projectRoot, host, args, control)).text };
}

export async function executeIndexCodebase(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedIndexCodebaseArgs,
  onProgress?: IndexProgressCallback,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const result = await runIndexCodebase(projectRoot, host, args, onProgress, control);
  if (result.kind === "estimate") return { text: formatCostEstimate(result.estimate) };
  if (result.kind === "dryrun") return { text: formatDryRunEstimate(result.dryrun) };
  if (result.kind === "busy") return { text: result.text, isError: true };
  if (result.kind === "message") return { text: result.text };
  return {
    text: formatIndexStats(result.stats, args.verbose ?? false),
    ...(result.providerError ? { error: result.providerError } : {}),
  };
}

export async function executeIndexStatus(
  projectRoot: string | undefined,
  host: HostMode,
  control?: OperationControl,
): Promise<ExecutionResult> {
  return { text: formatStatus(await getIndexStatus(projectRoot, host, control)) };
}

export async function executeIndexHealthCheck(
  projectRoot: string | undefined,
  host: HostMode,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const result = await runIndexHealthCheck(projectRoot, host, control);
  if (result.kind === "busy") return { text: result.text, isError: true };
  return { text: formatHealthCheck(result.health) };
}

export async function executeIndexMetrics(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedIndexMetricsArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  await runOperationPhase(control, "reading_metrics");
  return { text: (await getIndexMetrics(projectRoot, host, args)).text };
}

export async function executeIndexLogs(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedIndexLogsArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  await runOperationPhase(control, "reading_logs");
  return {
    text: (await getIndexLogs(projectRoot, host, {
      limit: args.limit,
      category: args.category ?? undefined,
      level: args.level ?? undefined,
    })).text,
  };
}

export async function executeImplementationLookup(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedImplementationLookupArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const results = await implementationLookup(projectRoot, host, args.query, {
    limit: args.limit,
    fileType: args.fileType,
    directory: args.directory,
    exactSymbol: isExactSymbolQuery(args.query),
  }, control);
  const exactSymbol = isExactSymbolQuery(args.query);
  return {
    text: formatDefinitionLookup(results, args.query),
    details: {
      resolution: exactSymbol
        ? (results.length === 0 ? "not_found" : results.length === 1 ? "resolved" : "ambiguous")
        : "resolved",
      matchKind: exactSymbol ? "exact_symbol" : "semantic",
      results,
    },
  };
}

export async function executeCallGraph(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCallGraphArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const result = await getCallGraphData(projectRoot, host, args, control);
  return { text: formatCallGraphResult(result), details: { resolution: result.resolution, matchKind: "exact_symbol" } };
}

export async function executeCallGraphPath(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCallGraphPathArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const path = await getCallGraphPath(
    projectRoot,
    host,
    args.from,
    args.to,
    args.maxDepth,
    args.fromFilePath,
    args.toFilePath,
    control,
  );
  return { text: formatCallGraphPathResult(path), details: { from: path.from, to: path.to, matchKind: "exact_symbol" } };
}

export async function executeCodeCommunities(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCodeCommunitiesArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const result = await getCodeCommunities(projectRoot, host, args, control);
  return { text: formatCodeCommunities(result) };
}

export async function executeArchitectureContext(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedArchitectureContextArgs,
  control?: OperationControl,
): Promise<ExecutionResult> {
  const result = await getArchitectureContext(projectRoot, host, args, control);
  return { text: result.text, details: result as unknown as Record<string, unknown> };
}
