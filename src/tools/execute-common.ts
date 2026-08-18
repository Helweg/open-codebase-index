import type { HostMode } from "../config/host.js";
import type {
  SharedCallGraphArgs,
  SharedCallGraphPathArgs,
  SharedCodebaseContextArgs,
  SharedCodebaseEditContextArgs,
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
  getIndexLogs,
  getIndexMetrics,
  getIndexStatus,
  implementationLookup,
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

export interface ExecutionResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export type IndexProgressCallback = (title: string, metadata: Record<string, unknown>) => void | Promise<void>;

export async function executeCodebaseContext(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCodebaseContextArgs,
): Promise<ExecutionResult> {
  const result = await resolveCodebaseContext(projectRoot, host, args);
  return { text: result.text, details: result.details };
}

export async function executeCodebaseEditContext(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCodebaseEditContextArgs,
): Promise<ExecutionResult> {
  return { text: (await resolveCodebaseEditContext(projectRoot, host, args)).text };
}

export async function executeIndexCodebase(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedIndexCodebaseArgs,
  onProgress?: IndexProgressCallback,
): Promise<ExecutionResult> {
  const result = await runIndexCodebase(projectRoot, host, args, onProgress);
  if (result.kind === "estimate") return { text: formatCostEstimate(result.estimate) };
  if (result.kind === "dryrun") return { text: formatDryRunEstimate(result.dryrun) };
  if (result.kind === "busy") return { text: result.text, isError: true };
  if (result.kind === "message") return { text: result.text };
  return { text: formatIndexStats(result.stats, args.verbose ?? false) };
}

export async function executeIndexStatus(
  projectRoot: string | undefined,
  host: HostMode,
): Promise<ExecutionResult> {
  return { text: formatStatus(await getIndexStatus(projectRoot, host)) };
}

export async function executeIndexHealthCheck(
  projectRoot: string | undefined,
  host: HostMode,
): Promise<ExecutionResult> {
  const result = await runIndexHealthCheck(projectRoot, host);
  if (result.kind === "busy") return { text: result.text, isError: true };
  return { text: formatHealthCheck(result.health) };
}

export async function executeIndexMetrics(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedIndexMetricsArgs,
): Promise<ExecutionResult> {
  return { text: (await getIndexMetrics(projectRoot, host, args)).text };
}

export async function executeIndexLogs(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedIndexLogsArgs,
): Promise<ExecutionResult> {
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
): Promise<ExecutionResult> {
  const results = await implementationLookup(projectRoot, host, args.query, {
    limit: args.limit,
    fileType: args.fileType,
    directory: args.directory,
  });
  return { text: formatDefinitionLookup(results, args.query) };
}

export async function executeCallGraph(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCallGraphArgs,
): Promise<ExecutionResult> {
  return { text: formatCallGraphResult(await getCallGraphData(projectRoot, host, args)) };
}

export async function executeCallGraphPath(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCallGraphPathArgs,
): Promise<ExecutionResult> {
  const path = await getCallGraphPath(
    projectRoot,
    host,
    args.from,
    args.to,
    args.maxDepth,
    args.fromFilePath,
    args.toFilePath,
  );
  return { text: formatCallGraphPathResult(path) };
}

export async function executeCodeCommunities(
  projectRoot: string | undefined,
  host: HostMode,
  args: SharedCodeCommunitiesArgs,
): Promise<ExecutionResult> {
  const result = await getCodeCommunities(projectRoot, host, args);
  return { text: formatCodeCommunities(result) };
}
