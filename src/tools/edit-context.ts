import type { HostMode } from "../config/host.js";
import type { OperationControl } from "../utils/operation-control.js";
import {
  isOperationInterruption,
  throwIfOperationAborted,
} from "../utils/operation-control.js";
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
  getApiImpactEvidence,
  implementationLookup,
  searchCodebase,
  type CallGraphDataResult,
  type CallGraphSymbolResolution,
} from "./operations.js";
import type { ApiImpactEvidence, ApiImpactTarget } from "./api-impact.js";
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
    apiImpactIncluded?: boolean;
    apiImpactTruncated?: boolean;
  };
}

export interface CodebaseEditContextEvidence {
  sources: SearchResult[];
  callers: CallEdgeData[];
  callees: CallEdgeData[];
}

export interface CodebaseEditContextDependencies {
  projectRoot: string | undefined;
  /** Observes only evidence retained after every response-budget fit. */
  onSelectedEvidence?: (evidence: CodebaseEditContextEvidence) => void;
  searchCodebase: (
    query: string,
    options?: { limit?: number },
    control?: OperationControl,
  ) => Promise<SearchResult[]>;
  implementationLookup: (
    query: string,
    options?: { limit?: number },
    control?: OperationControl,
  ) => Promise<SearchResult[]>;
  getCallGraphData: (params: {
    name: string;
    filePath?: string;
    direction: "callers" | "callees";
  }, control?: OperationControl) => Promise<CallGraphDataResult>;
  getApiImpactEvidence?: (
    target: ApiImpactTarget,
    control?: OperationControl,
  ) => Promise<ApiImpactEvidence>;
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
  signal?: AbortSignal,
): SearchResult | undefined {
  const containsLine = results.find((result) => {
    throwIfOperationAborted(signal);
    return pathsMatch(result.filePath, resolution.filePath)
      && result.startLine <= resolution.startLine
      && result.endLine >= resolution.startLine;
  });
  if (containsLine) return containsLine;
  return results.find((result) => {
    throwIfOperationAborted(signal);
    return pathsMatch(result.filePath, resolution.filePath) && result.name === resolution.name;
  });
}

function formatSource(result: SearchResult, onHeader?: (endOffset: number) => void): string {
  const name = result.name ? ` ${result.name}` : "";
  const header = `## Target implementation\n${result.filePath}:${result.startLine}-${result.endLine} (${result.chunkType}${name})`;
  onHeader?.(header.length);
  return [header, "```", result.content, "```"].join("\n");
}

function formatEdges(
  heading: string,
  edges: CallEdgeData[],
  format: (edge: CallEdgeData) => string,
  onEdge?: (endOffset: number) => void,
): string {
  if (edges.length === 0) return `${heading}\nNone found.`;
  let offset = heading.length + 1;
  const lines = edges.map((edge) => {
    const line = format(edge);
    if (onEdge) {
      offset += line.length;
      onEdge(offset);
      offset += 1;
    }
    return line;
  });
  return [heading, ...lines].join("\n");
}

function formatCallers(edges: CallEdgeData[], onEdge?: (endOffset: number) => void): string {
  return formatEdges("## Direct callers", edges, (edge) =>
    `- ${edge.fromSymbolName ?? "<unknown>"} at ${edge.fromSymbolFilePath ?? "<unknown file>"}:${edge.line} (${edge.callType}, ${edge.isResolved ? "resolved" : "unresolved"})`, onEdge);
}

function formatCallees(edges: CallEdgeData[], sourceFilePath: string, onEdge?: (endOffset: number) => void): string {
  return formatEdges("## Direct callees", edges, (edge) =>
    `- ${edge.targetName} from ${sourceFilePath}:${edge.line} (${edge.callType}, ${edge.isResolved ? "resolved" : "unresolved"})`, onEdge);
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
  dependencies: CodebaseEditContextDependencies,
  query: string,
  risk: string,
  resolution: CodebaseEditContextResult["details"]["resolution"],
  tokenBudget: number | null | undefined,
  candidateSource: SearchResult[] = [],
  control?: OperationControl,
): Promise<CodebaseEditContextResult> {
  throwIfOperationAborted(control?.signal);
  const conceptual = await dependencies.searchCodebase(query, { limit: 5 }, control);
  throwIfOperationAborted(control?.signal);
  let selectedEvidence: Array<{ result: SearchResult; endOffset: number }> | undefined;
  const pack = buildContextPack([...candidateSource, ...conceptual], {
    tokenBudget: tokenBudget ?? undefined,
    heading: "## Conceptual evidence",
    maxResults: 5,
    includeExactSearchHandoff: false,
    preferImplementationPaths: true,
    projectRoot: dependencies.projectRoot,
    onSelectedEvidence: dependencies.onSelectedEvidence ? (evidence) => { selectedEvidence = evidence; } : undefined,
  });
  const fitted = fitTextToContextBudget(`${risk}\n\n${pack.text}`, tokenBudget ?? undefined);
  dependencies.onSelectedEvidence?.({
    sources: (selectedEvidence ?? [])
      .filter((entry) => risk.length + 2 + entry.endOffset <= fitted.retainedLength)
      .map((entry) => entry.result),
    callers: [],
    callees: [],
  });
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

export async function resolveCodebaseEditContextWithDependencies(
  input: SharedCodebaseEditContextArgs,
  dependencies: CodebaseEditContextDependencies,
  control?: OperationControl,
): Promise<CodebaseEditContextResult> {
  throwIfOperationAborted(control?.signal);
  const symbol = input.symbol?.trim();
  if (!symbol) {
    return fallbackPack(
      dependencies,
      input.query,
      "Risk: no authoritative symbol was supplied. Review the conceptual evidence before editing.",
      "not_requested",
      input.tokenBudget,
      [],
      control,
    );
  }

  let callersResult: Awaited<ReturnType<typeof getCallGraphData>>;
  try {
    callersResult = await dependencies.getCallGraphData({
      name: symbol,
      filePath: input.filePath ?? undefined,
      direction: "callers",
    }, control);
  } catch (error) {
    if (isOperationInterruption(error)) throw error;
    throwIfOperationAborted(control?.signal);
    const candidates = await dependencies.implementationLookup(symbol, { limit: 5 }, control);
    throwIfOperationAborted(control?.signal);
    return fallbackPack(
      dependencies,
      input.query,
      "Risk: graph data is unavailable. Target and dependencies are not graph-verified.",
      "graph_unavailable",
      input.tokenBudget,
      candidates,
      control,
    );
  }

  if (callersResult.resolution.status !== "resolved") {
    return fallbackPack(
      dependencies,
      input.query,
      formatResolutionRisk(callersResult.resolution),
      callersResult.resolution.status,
      input.tokenBudget,
      [],
      control,
    );
  }

  const resolution = callersResult.resolution;
  const [definitionsResult, calleesResult] = await Promise.allSettled([
    dependencies.implementationLookup(symbol, { limit: 10 }, control),
    dependencies.getCallGraphData({
      name: symbol,
      filePath: input.filePath ?? resolution.filePath,
      direction: "callees",
    }, control),
  ]);
  throwIfOperationAborted(control?.signal);
  if (definitionsResult.status === "rejected") throw definitionsResult.reason;

  let graphRisk: string | undefined;
  let callees: CallEdgeData[] = [];
  if (calleesResult.status === "rejected") {
    if (isOperationInterruption(calleesResult.reason)) throw calleesResult.reason;
    throwIfOperationAborted(control?.signal);
    graphRisk = "Risk: callee graph data is unavailable. Dependency evidence is incomplete.";
  } else if (calleesResult.value.resolution.status !== "resolved") {
    graphRisk = "Risk: the target resolved for callers but not callees. Dependency evidence is incomplete.";
  } else {
    callees = calleesResult.value.callees.slice(0, edgeLimit(input.calleeLimit));
  }

  const source = targetSource(definitionsResult.value, resolution, control?.signal);
  const callers = callersResult.callers.slice(0, edgeLimit(input.callerLimit));
  const sourceBudget = Math.max(
    MIN_CONTEXT_PACK_TOKEN_BUDGET,
    Math.floor((input.tokenBudget ?? DEFAULT_CONTEXT_PACK_TOKEN_BUDGET) * 0.6),
  );
  let sourceHeaderEnd = Infinity;
  const sourceFit = source
    ? fitTextToContextBudget(formatSource(source, dependencies.onSelectedEvidence
      ? (endOffset) => { sourceHeaderEnd = endOffset; }
      : undefined), sourceBudget)
    : undefined;
  const sourceText = sourceFit?.text
    ?? `## Target implementation\nRisk: no implementation source matched the resolved target at ${resolution.filePath}:${resolution.startLine}.`;
  let apiImpact: ApiImpactEvidence | undefined;
  if (input.includeApiImpact && dependencies.getApiImpactEvidence) {
    try {
      apiImpact = await dependencies.getApiImpactEvidence({
        symbol: resolution.name,
        filePath: resolution.filePath,
        startLine: resolution.startLine,
      }, control);
    } catch (error) {
      if (isOperationInterruption(error)) throw error;
      apiImpact = {
        text: "## API impact evidence\nRisk: API evidence could not be collected from the bounded indexed-file scope.",
        scannedFileCount: 0,
        candidateFileCount: 0,
        routeCount: 0,
        consumerCount: 0,
        candidateTestCount: 0,
        truncated: false,
      };
    }
  }
  const header = [`# Pre-edit context for ${resolution.name}`, graphRisk]
    .filter((section) => section !== undefined).join("\n\n");
  const sourceOffset = header.length + 2;
  const callerOffset = sourceOffset + sourceText.length + 2;
  const callerEnds: number[] | undefined = dependencies.onSelectedEvidence ? [] : undefined;
  const callerText = formatCallers(callers, callerEnds
    ? (endOffset) => { callerEnds.push(callerOffset + endOffset); }
    : undefined);
  const calleeOffset = callerOffset + callerText.length + 2;
  const calleeEnds: number[] | undefined = dependencies.onSelectedEvidence ? [] : undefined;
  const calleeText = formatCallees(callees, resolution.filePath, calleeEnds
    ? (endOffset) => { calleeEnds.push(calleeOffset + endOffset); }
    : undefined);
  const precedingText = [header, sourceText, callerText, calleeText].join("\n\n");
  const completeText = apiImpact ? `${precedingText}\n\n${apiImpact.text}` : precedingText;
  const fitted = fitTextToContextBudget(completeText, input.tokenBudget ?? undefined);
  dependencies.onSelectedEvidence?.({
    sources: source && sourceHeaderEnd <= (sourceFit?.retainedLength ?? 0)
      && sourceOffset + sourceHeaderEnd <= fitted.retainedLength ? [source] : [],
    callers: callers.filter((_edge, index) => (callerEnds?.[index] ?? Infinity) <= fitted.retainedLength),
    callees: callees.filter((_edge, index) => (calleeEnds?.[index] ?? Infinity) <= fitted.retainedLength),
  });
  const apiImpactOffset = Array.from(`${precedingText}\n\n`).length;
  const renderedApiTail = Array.from(fitted.text).slice(apiImpactOffset).join("");
  const apiImpactRendered = apiImpact ? renderedApiTail.startsWith("## API impact evidence") : false;
  const apiImpactFullyRendered = apiImpact ? renderedApiTail.startsWith(apiImpact.text) : false;

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
      ...(apiImpact ? {
        apiImpactIncluded: apiImpactRendered,
        apiImpactTruncated: apiImpact.truncated || !apiImpactFullyRendered,
      } : {}),
    },
  };
}

export async function resolveCodebaseEditContext(
  projectRoot: string | undefined,
  host: HostMode,
  input: SharedCodebaseEditContextArgs,
  control?: OperationControl,
): Promise<CodebaseEditContextResult> {
  return resolveCodebaseEditContextWithDependencies(input, {
    projectRoot,
    searchCodebase: (query, options, operationControl) => searchCodebase(
      projectRoot,
      host,
      query,
      options,
      operationControl,
    ),
    implementationLookup: (query, options, operationControl) => implementationLookup(
      projectRoot,
      host,
      query,
      options,
      operationControl,
    ),
    getCallGraphData: (params, operationControl) => getCallGraphData(
      projectRoot,
      host,
      params,
      operationControl,
    ),
    getApiImpactEvidence: (target, operationControl) => getApiImpactEvidence(
      projectRoot,
      host,
      target,
      operationControl,
    ),
  }, control);
}
