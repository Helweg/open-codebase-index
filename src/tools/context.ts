import type { HostMode } from "../config/host.js";
import {
  getCallGraphData,
  getCallGraphPath,
  implementationLookup,
  isToolEffectivenessEnabled,
  recordToolEffectiveness,
  searchCodebase,
} from "./operations.js";
import {
  fitTextToContextBudget,
  formatCallGraphPathResult,
} from "./utils.js";
import {
  resolveSearchContext,
  trimOrUndefined,
  type CodebaseContextInput,
  type CodebaseContextResult,
} from "./context-search.js";

export type { CodebaseContextInput, CodebaseContextResult } from "./context-search.js";
export {
  MIN_CONTEXT_RESULT_LIMIT,
  MAX_CONTEXT_RESULT_LIMIT,
  MIN_CONTEXT_PATH_DEPTH,
  MAX_CONTEXT_PATH_DEPTH,
  resolveSearchContext,
} from "./context-search.js";

function fittedDetails(
  route: "path" | "direct-edge",
  fitted: ReturnType<typeof fitTextToContextBudget>,
  resultCount: number,
): NonNullable<CodebaseContextResult["details"]> {
  return {
    route,
    tokenBudget: fitted.tokenBudget,
    tokenEstimate: fitted.tokenEstimate,
    truncated: fitted.truncated,
    resultCount,
  };
}

async function resolveCodebaseContextUnmeasured(
  projectRoot: string | undefined,
  host: HostMode,
  input: CodebaseContextInput,
): Promise<CodebaseContextResult> {
  const from = trimOrUndefined(input.from);
  const to = trimOrUndefined(input.to);
  const fromFilePath = trimOrUndefined(input.fromFilePath);
  const toFilePath = trimOrUndefined(input.toFilePath);
  const symbol = input.symbol ?? undefined;
  const limit = input.limit ?? 10;
  const maxDepth = input.maxDepth ?? 10;
  const fileType = input.fileType ?? undefined;
  const directory = input.directory ?? undefined;
  const tokenBudget = input.tokenBudget ?? undefined;
  if (from && to) {
    const path = await getCallGraphPath(
      projectRoot,
      host,
      from,
      to,
      maxDepth,
      fromFilePath,
      toFilePath,
    );
    const pathText = formatCallGraphPathResult(path);
    if (path.path.length > 0) {
      const fitted = fitTextToContextBudget(
        pathText,
        tokenBudget,
      );
      return {
        text: fitted.text,
        details: fittedDetails("path", fitted, path.path.length),
      };
    }

    if (path.from.status !== "resolved" || path.to.status !== "resolved") {
      const fitted = fitTextToContextBudget(pathText, tokenBudget);
      return {
        text: fitted.text,
        details: fittedDetails("path", fitted, 0),
      };
    }
    const resolvedFrom = path.from;

    const { callers } = await getCallGraphData(projectRoot, host, {
      name: to,
      direction: "callers",
      filePath: toFilePath,
    });
    const directEdge = callers.find((edge) => edge.fromSymbolId === resolvedFrom.symbolId);
    if (directEdge) {
      const location = directEdge.fromSymbolFilePath
        ? ` at ${directEdge.fromSymbolFilePath}:${directEdge.line}`
        : "";
      const fitted = fitTextToContextBudget(
        `Direct path: ${from} --${directEdge.callType}--> ${to}${location} ` +
          `(edge is ${directEdge.isResolved ? "resolved" : "unresolved"}).`,
        tokenBudget,
      );
      return {
        text: fitted.text,
        details: fittedDetails("direct-edge", fitted, 1),
      };
    }

    const fitted = fitTextToContextBudget(
      pathText,
      tokenBudget,
    );
    return {
      text: fitted.text,
      details: fittedDetails("path", fitted, 0),
    };
  }

  return resolveSearchContext({
    query: input.query,
    symbol,
    limit,
    tokenBudget,
    fileType,
    directory,
    diagnostic: input.diagnostic,
  }, {
    lookup: (lookupSymbol, retrievalLimit, scope, exactSymbol, trace) => implementationLookup(projectRoot, host, lookupSymbol, {
      limit: retrievalLimit,
      fileType: scope.fileType,
      directory: scope.directory,
      exactSymbol,
      trace,
    }),
    search: (queryText, retrievalLimit, scope, trace, searchOptions) => searchCodebase(projectRoot, host, queryText, {
      limit: retrievalLimit,
      fileType: scope.fileType,
      directory: scope.directory,
      metadataOnly: true,
      trace,
      prioritizeSourcePaths: searchOptions?.prioritizeSourcePaths,
    }),
  });
}

function contextRoute(
  route: NonNullable<CodebaseContextResult["details"]>["route"],
): "context-conceptual" | "context-definition" | "context-path" | "context-direct-edge" {
  return `context-${route}`;
}

function contextScopeRelaxation(
  details: NonNullable<CodebaseContextResult["details"]>,
): "none" | "directory" | "file-type" | "both" {
  const fields = new Set(details.recovery?.attempts.flatMap((attempt) => attempt.relaxedFields) ?? []);
  if (fields.has("directory") && fields.has("fileType")) return "both";
  if (fields.has("directory")) return "directory";
  if (fields.has("fileType")) return "file-type";
  return "none";
}

function contextResultCount(details: NonNullable<CodebaseContextResult["details"]>): number {
  return details.selectedCount ?? details.resultCount ?? 0;
}

function contextRecoveryUsed(details: NonNullable<CodebaseContextResult["details"]>): boolean {
  const attempts = details.recovery?.attempts ?? [];
  return attempts.length > 1 || attempts.some((attempt) => attempt.relaxedFields.length > 0);
}

function expectedContextRoute(input: CodebaseContextInput): "context-conceptual" | "context-definition" | "context-path" {
  if (trimOrUndefined(input.from) && trimOrUndefined(input.to)) return "context-path";
  if (trimOrUndefined(input.symbol)) return "context-definition";
  return "context-conceptual";
}

export async function resolveCodebaseContext(
  projectRoot: string | undefined,
  host: HostMode,
  input: CodebaseContextInput,
): Promise<CodebaseContextResult> {
  const metricsEnabled = isToolEffectivenessEnabled(projectRoot, host);
  const startedAt = metricsEnabled ? performance.now() : 0;
  try {
    const result = await resolveCodebaseContextUnmeasured(projectRoot, host, input);
    const details = result.details;
    if (metricsEnabled && details) {
      const resultCount = contextResultCount(details);
      recordToolEffectiveness(projectRoot, host, {
        route: contextRoute(details.route),
        host,
        outcome: resultCount > 0 ? "success" : "no-result",
        recoveryUsed: contextRecoveryUsed(details),
        resultCount,
        latencyMs: performance.now() - startedAt,
        tokenBudget: details.tokenBudget,
        returnedTokenEstimate: details.tokenEstimate,
        exactHandoffEmitted: result.text.includes("Exact-search handoff:"),
        scopeRelaxation: contextScopeRelaxation(details),
      });
    }
    return result;
  } catch (error) {
    if (metricsEnabled) {
      recordToolEffectiveness(projectRoot, host, {
        route: expectedContextRoute(input),
        host,
        outcome: "error",
        resultCount: 0,
        latencyMs: performance.now() - startedAt,
        tokenBudget: input.tokenBudget ?? undefined,
        returnedTokenEstimate: 0,
        scopeRelaxation: "none",
      });
    }
    throw error;
  }
}
