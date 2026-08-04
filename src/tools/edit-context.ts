import type { HostMode } from "../config/host.js";
import type { SearchResult } from "../indexer/index.js";
import type { CallEdgeData } from "../native/index.js";
import {
  DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  type SharedCodebaseEditContextArgs,
} from "./contracts.js";
import {
  getCallGraphData,
  implementationLookup,
  searchCodebase,
  type CallGraphSymbolResolution,
} from "./operations.js";
import {
  buildContextPack,
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  fitTextToContextBudget,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
} from "./utils.js";

export interface CodebaseEditContextResult {
  text: string;
  details: {
    resolution: CallGraphSymbolResolution["status"] | "not_requested" | "graph_unavailable";
    tokenBudget: number;
    tokenEstimate: number;
    truncated: boolean;
    sourceIncluded: boolean;
    callerCount: number;
    calleeCount: number;
  };
}

function edgeLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT;
  }
  return Math.min(
    MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
    Math.max(MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT, Math.floor(value)),
  );
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizedPath(left);
  const normalizedRight = normalizedPath(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function targetSource(
  results: SearchResult[],
  resolution: Extract<CallGraphSymbolResolution, { status: "resolved" }>,
): SearchResult | undefined {
  return results.find((result) => pathsMatch(result.filePath, resolution.filePath)
    && result.startLine <= resolution.startLine
    && result.endLine >= resolution.startLine)
    ?? results.find((result) => pathsMatch(result.filePath, resolution.filePath) && result.name === resolution.name);
}

function formatSource(result: SearchResult): string {
  const name = result.name ? ` ${result.name}` : "";
  return [
    "## Target implementation",
    `${result.filePath}:${result.startLine}-${result.endLine} (${result.chunkType}${name})`,
    "```",
    result.content,
    "```",
  ].join("\n");
}

function formatCallers(edges: CallEdgeData[]): string {
  if (edges.length === 0) return "## Direct callers\nNone found.";
  return [
    "## Direct callers",
    ...edges.map((edge) =>
      `- ${edge.fromSymbolName ?? "<unknown>"} at ${edge.fromSymbolFilePath ?? "<unknown file>"}:${edge.line} (${edge.callType}, ${edge.isResolved ? "resolved" : "unresolved"})`),
  ].join("\n");
}

function formatCallees(edges: CallEdgeData[], sourceFilePath: string): string {
  if (edges.length === 0) return "## Direct callees\nNone found.";
  return [
    "## Direct callees",
    ...edges.map((edge) =>
      `- ${edge.targetName} from ${sourceFilePath}:${edge.line} (${edge.callType}, ${edge.isResolved ? "resolved" : "unresolved"})`),
  ].join("\n");
}

function formatResolutionRisk(resolution: Exclude<CallGraphSymbolResolution, { status: "resolved" }>): string {
  if (resolution.status === "ambiguous") {
    const candidates = resolution.candidates
      .map((candidate) => `${candidate.filePath}:${candidate.startLine}`)
      .join(", ");
    return `Risk: symbol "${resolution.name}" is ambiguous. Pass filePath to select a target.${candidates ? ` Candidates: ${candidates}.` : ""}`;
  }
  if (resolution.filePath && resolution.totalCandidates > 0) {
    return `Risk: symbol "${resolution.name}" did not resolve at filePath="${resolution.filePath}". Review the conceptual evidence before editing.`;
  }
  return `Risk: symbol "${resolution.name}" could not be resolved. Review the conceptual evidence before editing.`;
}

async function fallbackPack(
  projectRoot: string | undefined,
  host: HostMode,
  query: string,
  risk: string,
  resolution: CodebaseEditContextResult["details"]["resolution"],
  tokenBudget: number | null | undefined,
  candidateSource: SearchResult[] = [],
): Promise<CodebaseEditContextResult> {
  const conceptual = await searchCodebase(projectRoot, host, query, { limit: 5 });
  const pack = buildContextPack([...candidateSource, ...conceptual], {
    tokenBudget: tokenBudget ?? undefined,
    heading: "## Conceptual evidence",
    maxResults: 5,
    includeExactSearchHandoff: false,
    preferImplementationPaths: true,
  });
  const fitted = fitTextToContextBudget(`${risk}\n\n${pack.text}`, tokenBudget ?? undefined);
  return {
    text: fitted.text,
    details: {
      resolution,
      tokenBudget: fitted.tokenBudget,
      tokenEstimate: fitted.tokenEstimate,
      truncated: fitted.truncated,
      sourceIncluded: candidateSource.length > 0,
      callerCount: 0,
      calleeCount: 0,
    },
  };
}

export async function resolveCodebaseEditContext(
  projectRoot: string | undefined,
  host: HostMode,
  input: SharedCodebaseEditContextArgs,
): Promise<CodebaseEditContextResult> {
  const symbol = input.symbol?.trim();
  if (!symbol) {
    return fallbackPack(
      projectRoot,
      host,
      input.query,
      "Risk: no authoritative symbol was supplied. Review the conceptual evidence before editing.",
      "not_requested",
      input.tokenBudget,
    );
  }

  let callersResult: Awaited<ReturnType<typeof getCallGraphData>>;
  try {
    callersResult = await getCallGraphData(projectRoot, host, {
      name: symbol,
      filePath: input.filePath ?? undefined,
      direction: "callers",
    });
  } catch (error) {
    const candidates = await implementationLookup(projectRoot, host, symbol, { limit: 5 });
    const message = error instanceof Error ? error.message : String(error);
    return fallbackPack(
      projectRoot,
      host,
      input.query,
      `Risk: graph data is unavailable (${message}). Target and dependencies are not graph-verified.`,
      "graph_unavailable",
      input.tokenBudget,
      candidates,
    );
  }

  if (callersResult.resolution.status !== "resolved") {
    return fallbackPack(
      projectRoot,
      host,
      input.query,
      formatResolutionRisk(callersResult.resolution),
      callersResult.resolution.status,
      input.tokenBudget,
    );
  }

  const resolution = callersResult.resolution;
  const [definitionsResult, calleesResult] = await Promise.allSettled([
    implementationLookup(projectRoot, host, symbol, { limit: 10 }),
    getCallGraphData(projectRoot, host, {
      name: symbol,
      filePath: input.filePath ?? resolution.filePath,
      direction: "callees",
    }),
  ]);
  if (definitionsResult.status === "rejected") throw definitionsResult.reason;

  let graphRisk: string | undefined;
  let callees: CallEdgeData[] = [];
  if (calleesResult.status === "rejected") {
    const message = calleesResult.reason instanceof Error ? calleesResult.reason.message : String(calleesResult.reason);
    graphRisk = `Risk: callee graph data is unavailable (${message}). Dependency evidence is incomplete.`;
  } else if (calleesResult.value.resolution.status !== "resolved") {
    graphRisk = "Risk: the target resolved for callers but not callees. Dependency evidence is incomplete.";
  } else {
    callees = calleesResult.value.callees.slice(0, edgeLimit(input.calleeLimit));
  }

  const source = targetSource(definitionsResult.value, resolution);
  const callers = callersResult.callers.slice(0, edgeLimit(input.callerLimit));
  const sourceBudget = Math.max(
    MIN_CONTEXT_PACK_TOKEN_BUDGET,
    Math.floor((input.tokenBudget ?? DEFAULT_CONTEXT_PACK_TOKEN_BUDGET) * 0.6),
  );
  const sourceText = source
    ? fitTextToContextBudget(formatSource(source), sourceBudget).text
    : `## Target implementation\nRisk: no implementation source matched the resolved target at ${resolution.filePath}:${resolution.startLine}.`;
  const fitted = fitTextToContextBudget([
    `# Pre-edit context for ${resolution.name}`,
    graphRisk,
    sourceText,
    formatCallers(callers),
    formatCallees(callees, resolution.filePath),
  ].filter((section) => section !== undefined).join("\n\n"), input.tokenBudget ?? undefined);

  return {
    text: fitted.text,
    details: {
      resolution: "resolved",
      tokenBudget: fitted.tokenBudget,
      tokenEstimate: fitted.tokenEstimate,
      truncated: fitted.truncated,
      sourceIncluded: source !== undefined,
      callerCount: callers.length,
      calleeCount: callees.length,
    },
  };
}
