import type { HostMode } from "../config/host.js";
import type { OperationControl } from "../utils/operation-control.js";
import * as path from "node:path";
import {
  isOperationInterruption,
  throwIfOperationAborted,
} from "../utils/operation-control.js";
import { getProjectRoot } from "./operation-runtime.js";
import type { SearchResult } from "../indexer/index.js";
import type { CallEdgeData } from "../native/index.js";
import { isJavaScriptRuntimeSourceFilePath } from "../indexer/local-module-resolution.js";
import type { TestDiscoveryResult, TestReferenceResult } from "./test-discovery.js";
import {
  DEFAULT_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MAX_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  MIN_CODEBASE_EDIT_CONTEXT_EDGE_LIMIT,
  type SharedCodebaseEditContextArgs,
} from "./contracts.js";
import {
  getCallGraphData,
  getApiImpactEvidence,
  getSymbolTestEvidence,
  implementationLookup,
  searchCodebase,
  type CallGraphDataResult,
  type CallGraphSymbolResolution,
} from "./operations.js";
import type { ApiImpactEvidence, ApiImpactTarget } from "./api-impact.js";
import type { BudgetedTextResult } from "./context-pack.js";
import {
  buildContextPack,
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  fitTextToContextBudget,
  countContextTokens,
  MIN_CONTEXT_PACK_TOKEN_BUDGET,
} from "./utils.js";

const MAX_TARGET_SOURCE_TOKENS = 512;

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
    testDiscovery?: CodebaseEditTestDiscovery;
  };
}

export type CodebaseEditTestReference = Pick<TestReferenceResult,
  "filePath" | "startLine" | "endLine" | "evidenceKind" | "referencedSymbol" | "referenceLine">;

export interface CodebaseEditTestDiscovery extends Omit<TestDiscoveryResult, "resolution" | "results"> {
  resolution: TestDiscoveryResult["resolution"] | "not_requested" | "unsupported" | "unavailable";
  results: CodebaseEditTestReference[];
  omittedReferenceCount: number;
}

interface PendingTestDiscovery extends Omit<CodebaseEditTestDiscovery, "results"> {
  results: TestReferenceResult[];
}

const TEST_REFERENCE_NOTICE = "Static source references; not runtime coverage.";

function emptyTestDiscovery(resolution: CodebaseEditTestDiscovery["resolution"]): PendingTestDiscovery {
  return {
    resolution, results: [], scannedFileCount: 0, candidateFileCount: 0,
    verifiedCallerCount: 0, capped: false, omittedReferenceCount: 0,
  };
}

export interface CodebaseEditContextEvidence {
  sources: SearchResult[];
  callers: CallEdgeData[];
  callees: CallEdgeData[];
  testReferences: CodebaseEditTestReference[];
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
    options?: Parameters<typeof implementationLookup>[3],
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
  getTestEvidence?: (
    target: ApiImpactTarget,
    control?: OperationControl,
  ) => Promise<TestDiscoveryResult>;
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

function targetSource(
  results: SearchResult[],
  resolution: Extract<CallGraphSymbolResolution, { status: "resolved" }>,
  projectRoot: string | undefined,
  signal?: AbortSignal,
): SearchResult | undefined {
  const targetPath = path.resolve(projectRoot ?? ".", resolution.filePath);
  const matches = results.filter((result) => {
    throwIfOperationAborted(signal);
    return path.resolve(projectRoot ?? ".", result.filePath) === targetPath
      && result.name === resolution.name
      && result.chunkType === resolution.kind
      && result.startLine === resolution.startLine
      && result.content.length > 0;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function targetSourceTokenBudget(tokenBudget: number): number {
  return Math.max(
    MIN_CONTEXT_PACK_TOKEN_BUDGET,
    Math.min(MAX_TARGET_SOURCE_TOKENS, Math.floor(tokenBudget * 0.6)),
  );
}

function fitSource(
  result: SearchResult,
  tokenBudget: number,
  onSource: (endOffset: number) => void,
  fitsOverall: (text: string) => boolean = () => true,
): BudgetedTextResult {
  const name = result.name ? ` ${result.name}` : "";
  const header = `## Target implementation\n${result.filePath}:${result.startLine}-${result.endLine} (${result.chunkType}${name})`;
  const lines = result.content.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (lines[0]) onSource(header.length + "\n```\n".length + lines[0].length);
  const full = [header, "```", lines.join("\n"), "```"].join("\n");
  const fitted = fitTextToContextBudget(full, tokenBudget);
  if (!fitted.truncated && fitsOverall(full)) return fitted;
  const render = (count: number): string =>
    [header, "```", lines.slice(0, count).join("\n"), "```", "...[truncated to context token budget]"].join("\n");
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countContextTokens(render(middle)) <= fitted.tokenBudget && fitsOverall(render(middle))) low = middle;
    else high = middle - 1;
  }
  if (low === 0) {
    return { ...fitTextToContextBudget(`${header}\nSource body omitted: token budget.`, tokenBudget), truncated: true, retainedLength: 0 };
  }
  const text = render(low);
  return { text, tokenBudget: fitted.tokenBudget, tokenEstimate: countContextTokens(text), truncated: true, retainedLength: text.length };
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

/** Fit atomic evidence rows; candidates that do not render never receive credit. */
function packTestContext(
  input: SharedCodebaseEditContextArgs,
  dependencies: CodebaseEditContextDependencies,
  header: string,
  source: SearchResult | undefined,
  callers: CallEdgeData[],
  callees: CallEdgeData[],
  sourceFilePath: string,
  discovery: PendingTestDiscovery,
  apiImpact?: ApiImpactEvidence,
): CodebaseEditContextResult {
  const tokenBudget = fitTextToContextBudget("", input.tokenBudget ?? undefined).tokenBudget;
  const notice = `## Source-linked tests\n${TEST_REFERENCE_NOTICE}\nDiscovery: ${discovery.resolution}${discovery.capped ? " (discovery limits reached)" : ""}.`;
  let truncated = false;
  if (countContextTokens(`${header}\n\n${notice}`) > tokenBudget) {
    header = "# Pre-edit context\nRisk: target identity exceeds the response budget.";
    truncated = true;
  }
  let sourceEnd = Infinity;
  const sourceFit = source ? fitSource(
    source,
    targetSourceTokenBudget(tokenBudget),
    (endOffset) => { sourceEnd = endOffset; },
    (text) => countContextTokens(`${header}\n\n${text}\n\n${notice}`) <= tokenBudget,
  ) : undefined;
  const sourceText = sourceFit?.text
    ?? `## Target implementation\nRisk: no implementation source matched the resolved target at ${sourceFilePath}.`;
  const sourceFits = countContextTokens(`${header}\n\n${sourceText}\n\n${notice}`) <= tokenBudget;
  let text = sourceFits
    ? `${header}\n\n${sourceText}\n\n${notice}`
    : `${header}\n\n${notice}`;
  truncated ||= sourceFit?.truncated === true || !sourceFits;
  const selected: CodebaseEditContextEvidence = {
    sources: source && sourceFits && sourceEnd <= (sourceFit?.retainedLength ?? 0) ? [source] : [],
    callers: [], callees: [], testReferences: [],
  };
  const append = (section: string): boolean => {
    const candidate = `${text}\n\n${section}`;
    if (countContextTokens(candidate) > tokenBudget) {
      truncated = true;
      return false;
    }
    text = candidate;
    return true;
  };
  const appendTests = (kind: TestReferenceResult["evidenceKind"], heading?: string): void => {
    let headingIncluded = false;
    for (const reference of discovery.results) {
      if (reference.evidenceKind !== kind) continue;
      const row = `- ${reference.filePath}:${reference.startLine}-${reference.endLine} [${reference.evidenceKind}] referencedSymbol=${reference.referencedSymbol} referenceLine=${reference.referenceLine}`;
      if (append(heading && !headingIncluded ? `${heading}\n${row}` : row)) {
        const { filePath, startLine, endLine, evidenceKind, referencedSymbol, referenceLine } = reference;
        selected.testReferences.push({ filePath, startLine, endLine, evidenceKind, referencedSymbol, referenceLine });
        headingIncluded = true;
      }
    }
  };
  appendTests("direct_target_test_reference");
  const appendEdges = (
    edges: CallEdgeData[],
    render: (edges: CallEdgeData[]) => string,
    retained: CallEdgeData[],
  ): void => {
    if (edges.length === 0) {
      append(render([]));
      return;
    }
    let headingIncluded = false;
    for (const edge of edges) {
      const section = render([edge]);
      const row = headingIncluded ? section.slice(section.indexOf("\n") + 1) : section;
      if (append(row)) {
        retained.push(edge);
        headingIncluded = true;
      }
    }
  };
  appendEdges(callers, formatCallers, selected.callers);
  appendEdges(callees, (edges) => formatCallees(edges, sourceFilePath), selected.callees);
  appendTests("related_caller_test_reference", "## Related caller-test references");
  const apiImpactIncluded = apiImpact ? append(apiImpact.text) : false;
  const testDiscovery: CodebaseEditTestDiscovery = {
    ...discovery,
    results: selected.testReferences,
    omittedReferenceCount: discovery.results.length - selected.testReferences.length,
  };
  dependencies.onSelectedEvidence?.(selected);
  return {
    text,
    details: {
      resolution: "resolved",
      tokenBudget,
      tokenEstimate: countContextTokens(text),
      truncated,
      sourceIncluded: selected.sources.length > 0,
      callerCount: selected.callers.length,
      calleeCount: selected.callees.length,
      testDiscovery,
      ...(apiImpact ? {
        apiImpactIncluded,
        apiImpactTruncated: apiImpact.truncated || !apiImpactIncluded,
      } : {}),
    },
  };
}

async function fallbackPack(
  dependencies: CodebaseEditContextDependencies,
  query: string,
  risk: string,
  resolution: CodebaseEditContextResult["details"]["resolution"],
  tokenBudget: number | null | undefined,
  candidateSource: SearchResult[] = [],
  control?: OperationControl,
  includeTests = false,
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
  const testDiscovery = includeTests ? emptyTestDiscovery(
    resolution === "ambiguous" || resolution === "not_found" ? resolution : "not_requested",
  ) : undefined;
  let prefix = risk;
  let riskTruncated = false;
  if (testDiscovery) {
    const notice = `## Source-linked tests\n${TEST_REFERENCE_NOTICE}\nDiscovery: ${testDiscovery.resolution}.`;
    const budget = fitTextToContextBudget("", tokenBudget ?? undefined).tokenBudget;
    const riskCharacters = Array.from(risk);
    let low = 0;
    let high = riskCharacters.length;
    const render = (length: number): string =>
      `${riskCharacters.slice(0, length).join("")}${length < riskCharacters.length ? "…" : ""}\n\n${notice}`;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (countContextTokens(`${render(middle)}\n\n...[truncated to context token budget]`) <= budget) low = middle;
      else high = middle - 1;
    }
    prefix = render(low);
    riskTruncated = low < riskCharacters.length;
  }
  const fitted = fitTextToContextBudget(`${prefix}\n\n${pack.text}`, tokenBudget ?? undefined);
  dependencies.onSelectedEvidence?.({
    sources: (selectedEvidence ?? [])
      .filter((entry) => prefix.length + 2 + entry.endOffset <= fitted.retainedLength)
      .map((entry) => entry.result),
    callers: [],
    callees: [],
    testReferences: [],
  });
  return {
    text: fitted.text,
    details: {
      resolution,
      tokenBudget: fitted.tokenBudget,
      tokenEstimate: fitted.tokenEstimate,
      truncated: fitted.truncated || riskTruncated,
      sourceIncluded: false,
      callerCount: 0,
      calleeCount: 0,
      ...(testDiscovery ? { testDiscovery } : {}),
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
      input.includeTests,
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
      input.includeTests,
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
      input.includeTests,
    );
  }

  const resolution = callersResult.resolution;
  const [definitionsResult, calleesResult] = await Promise.allSettled([
    dependencies.implementationLookup(resolution.symbolId, { limit: 1, exactSymbol: true }, control),
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

  const source = targetSource(definitionsResult.value, resolution, dependencies.projectRoot, control?.signal);
  const callers = callersResult.callers.slice(0, edgeLimit(input.callerLimit));
  const sourceBudget = targetSourceTokenBudget(input.tokenBudget ?? DEFAULT_CONTEXT_PACK_TOKEN_BUDGET);
  let sourceHeaderEnd = Infinity;
  const sourceFit = source && !input.includeTests
    ? fitSource(source, sourceBudget, (endOffset) => { sourceHeaderEnd = endOffset; })
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
  let testDiscovery: PendingTestDiscovery | undefined;
  if (input.includeTests) {
    testDiscovery = emptyTestDiscovery("unsupported");
    if (isJavaScriptRuntimeSourceFilePath(resolution.filePath)) {
      testDiscovery = emptyTestDiscovery("unavailable");
      if (dependencies.getTestEvidence) {
        try {
          const discovered = await dependencies.getTestEvidence({
            symbol: resolution.name, filePath: resolution.filePath, startLine: resolution.startLine,
          }, control);
          testDiscovery = { ...discovered, omittedReferenceCount: 0 };
        } catch (error) {
          if (isOperationInterruption(error)) throw error;
          throwIfOperationAborted(control?.signal);
        }
      }
    }
  }
  throwIfOperationAborted(control?.signal);
  const header = [`# Pre-edit context for ${resolution.name}`, graphRisk]
    .filter((section) => section !== undefined).join("\n\n");
  if (testDiscovery) {
    return packTestContext(input, dependencies, header, source, callers, callees, resolution.filePath, testDiscovery, apiImpact);
  }
  const sourceOffset = header.length + 2;
  const callerOffset = sourceOffset + sourceText.length + 2;
  const callerEnds: number[] = [];
  const callerText = formatCallers(callers, (endOffset) => { callerEnds.push(callerOffset + endOffset); });
  const calleeOffset = callerOffset + callerText.length + 2;
  const calleeEnds: number[] = [];
  const calleeText = formatCallees(callees, resolution.filePath, (endOffset) => { calleeEnds.push(calleeOffset + endOffset); });
  const precedingText = [header, sourceText, callerText, calleeText].join("\n\n");
  const completeText = apiImpact ? `${precedingText}\n\n${apiImpact.text}` : precedingText;
  const fitted = fitTextToContextBudget(completeText, input.tokenBudget ?? undefined);
  const selectedSources = source && sourceHeaderEnd <= (sourceFit?.retainedLength ?? 0)
    && sourceOffset + sourceHeaderEnd <= fitted.retainedLength ? [source] : [];
  const selectedCallers = callers.filter((_edge, index) => callerEnds[index] <= fitted.retainedLength);
  const selectedCallees = callees.filter((_edge, index) => calleeEnds[index] <= fitted.retainedLength);
  dependencies.onSelectedEvidence?.({
    sources: selectedSources, callers: selectedCallers, callees: selectedCallees, testReferences: [],
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
      truncated: fitted.truncated || sourceFit?.truncated === true,
      sourceIncluded: selectedSources.length > 0,
      callerCount: selectedCallers.length,
      calleeCount: selectedCallees.length,
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
  const root = getProjectRoot(projectRoot, host);
  return resolveCodebaseEditContextWithDependencies(input, {
    projectRoot: root,
    searchCodebase: (query, options, operationControl) => searchCodebase(
      root,
      host,
      query,
      options,
      operationControl,
    ),
    implementationLookup: (query, options, operationControl) => implementationLookup(
      root,
      host,
      query,
      options,
      operationControl,
    ),
    getCallGraphData: (params, operationControl) => getCallGraphData(
      root,
      host,
      params,
      operationControl,
    ),
    getApiImpactEvidence: (target, operationControl) => getApiImpactEvidence(
      root,
      host,
      target,
      operationControl,
    ),
    getTestEvidence: (target, operationControl) => getSymbolTestEvidence(
      root, host, target.symbol, { targetFilePath: target.filePath }, operationControl,
    ),
  }, control);
}
