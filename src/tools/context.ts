import type { HostMode } from "../config/host.js";
import type { SearchResult } from "../indexer/index.js";
import {
  getCallGraphData,
  getCallGraphPath,
  implementationLookup,
  recordToolEffectiveness,
  searchCodebase,
} from "./operations.js";
import { inferExactSymbolFromQuery } from "./symbol-inference.js";
import {
  buildContextPack,
  fitTextToContextBudget,
  formatCallGraphPathResult,
} from "./utils.js";

export interface CodebaseContextInput {
  query: string;
  from?: string | null;
  to?: string | null;
  fromFilePath?: string | null;
  toFilePath?: string | null;
  symbol?: string | null;
  limit?: number | null;
  maxDepth?: number | null;
  fileType?: string | null;
  directory?: string | null;
  tokenBudget?: number | null;
}

export const MIN_CONTEXT_RESULT_LIMIT = 1;
export const MAX_CONTEXT_RESULT_LIMIT = 100;
export const MIN_CONTEXT_PATH_DEPTH = 1;
export const MAX_CONTEXT_PATH_DEPTH = 100;

interface ContextLocation {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  chunkType: string;
  name?: string;
}

export interface CodebaseContextResult {
  text: string;
  details?: {
    route: "path" | "direct-edge" | "definition" | "conceptual";
    routedQuery?: string;
    tokenBudget: number;
    tokenEstimate: number;
    resultCount?: number;
    truncated?: boolean;
    candidateCount?: number;
    deduplicatedCount?: number;
    selectedCount?: number;
    omittedCount?: number;
    duplicateCount?: number;
    limitOmittedCount?: number;
    budgetOmittedCount?: number;
    recovery?: {
      attempts: Array<{
        kind: "definition" | "conceptual";
        scope: "scoped" | "unscoped";
        resultCount: number;
        relaxedFields: Array<"directory" | "fileType">;
      }>;
      successfulAttemptIndex?: number;
    };
    results?: ContextLocation[];
  };
}

function locations(results: SearchResult[]): ContextLocation[] {
  return results.map((result) => ({
    filePath: result.filePath,
    startLine: result.startLine,
    endLine: result.endLine,
    score: result.score,
    chunkType: result.chunkType,
    name: result.name,
  }));
}

function packedResult(
  route: "definition" | "conceptual",
  routedQuery: string,
  pack: ReturnType<typeof buildContextPack>,
): CodebaseContextResult {
  return {
    text: pack.text,
    details: {
      route,
      routedQuery,
      tokenBudget: pack.tokenBudget,
      tokenEstimate: pack.tokenEstimate,
      candidateCount: pack.candidateCount,
      deduplicatedCount: pack.deduplicatedCount,
      selectedCount: pack.selectedCount,
      omittedCount: pack.omittedCount,
      duplicateCount: pack.duplicateCount,
      limitOmittedCount: pack.limitOmittedCount,
      budgetOmittedCount: pack.budgetOmittedCount,
      results: locations(pack.results),
    },
  };
}

interface SearchContextOperations {
  lookup(symbol: string, limit: number, scope: SearchScope): Promise<SearchResult[]>;
  search(query: string, limit: number, scope: SearchScope): Promise<SearchResult[]>;
}

type RecoveryScope = "scoped" | "unscoped";

interface RecoveryAttempt {
  kind: "definition" | "conceptual";
  scope: RecoveryScope;
  resultCount: number;
  relaxedFields: Array<"directory" | "fileType">;
}

interface SearchScope {
  fileType?: string;
  directory?: string;
}

interface RecoveryDecisions {
  inferredDefinitionMiss: boolean;
  fallbackFromOriginalConceptualToInferred: boolean;
  relaxedFields: Array<"directory" | "fileType">;
}

function describeRecoveryDecision(decisions: RecoveryDecisions): string[] {
  const lines: string[] = [];

  if (decisions.inferredDefinitionMiss) {
    lines.push("inferred definition missed");
  }

  if (decisions.fallbackFromOriginalConceptualToInferred) {
    lines.push("inferred-symbol query tried");
  }

  if (decisions.relaxedFields.includes("directory")) {
    lines.push("directory filter removed");
  }

  if (decisions.relaxedFields.includes("fileType")) {
    lines.push("file-type filter removed");
  }

  return lines;
}

function buildPackHeading(route: "definition" | "conceptual", decisions: RecoveryDecisions): string {
  const base = route === "definition" ? "Definition evidence" : "Codebase evidence";
  const decisionsText = describeRecoveryDecision(decisions);
  if (decisionsText.length === 0) {
    return base;
  }

  return `${base}\nRecovery: ${decisionsText.join("; ")}.`;
}

function buildRecoveryFallbackText(
  attempts: RecoveryAttempt[],
  tokenBudget: number | undefined,
  heading: string,
): ReturnType<typeof fitTextToContextBudget> {
  const lines = [
    heading,
    attempts.length > 0
      ? `Attempted ${attempts.length} recovery attempt${attempts.length === 1 ? "" : "s"}:`
      : "No recovery attempts were executed.",
  ];

  return fitTextToContextBudget(
    `${lines.join("\n")}\n${attempts.map((attempt, index) => formatRecoveryAttemptLine(attempt, index)).join("\n")}`,
    tokenBudget,
  );
}

function describeScope(fileType?: string, directory?: string): RecoveryScope {
  return fileType || directory ? "scoped" : "unscoped";
}

function attemptKey(kind: "definition" | "conceptual", query: string, scope: SearchScope): string {
  return JSON.stringify({
    kind,
    query,
    fileType: scope.fileType ?? "",
    directory: scope.directory ?? "",
  });
}

function formatRecoveryAttemptLine(attempt: RecoveryAttempt, index: number): string {
  const scope = attempt.scope === "scoped"
    ? "scoped"
    : attempt.relaxedFields.length > 0
      ? `unscoped (after removing ${attempt.relaxedFields.join(" and ")})`
      : "unscoped";

  return `${index + 1}. ${attempt.kind} ${scope} search: ${attempt.resultCount} result${attempt.resultCount === 1 ? "" : "s"}`;
}

function findSuccessfulAttemptIndex(route: "definition" | "conceptual", attempts: RecoveryAttempt[]): number | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt.kind === route && attempt.resultCount > 0) {
      return index;
    }
  }
  return null;
}

function buildRecoveryDetails(attempts: RecoveryAttempt[], successIndex: number | null) {
  return successIndex === null
    ? {
      attempts,
    }
    : {
      attempts,
      successfulAttemptIndex: successIndex,
    };
}

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function normalizeFileType(value: string | null | undefined): string | undefined {
  const normalized = trimOrUndefined(value)?.toLowerCase().replace(/^\.+/, "");
  return normalized || undefined;
}

function normalizeDirectory(value: string | null | undefined): string | undefined {
  const normalized = trimOrUndefined(value)
    ?.replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");
  return normalized || undefined;
}

function relaxedHintFields(fileType?: string, directory?: string): Array<"directory" | "fileType"> {
  const fields: Array<"directory" | "fileType"> = [];
  if (directory) {
    fields.push("directory");
  }
  if (fileType) {
    fields.push("fileType");
  }
  return fields;
}

export async function resolveSearchContext(
  input: Pick<CodebaseContextInput, "query" | "symbol" | "limit" | "tokenBudget" | "fileType" | "directory">,
  operations: SearchContextOperations,
): Promise<CodebaseContextResult> {
  const query = trimOrUndefined(input.query);
  const tokenBudget = input.tokenBudget ?? undefined;
  const explicitSymbol = trimOrUndefined(input.symbol);
  const inferredSymbol = explicitSymbol || !query ? undefined : inferExactSymbolFromQuery(query);
  const definitionSymbol = explicitSymbol ?? inferredSymbol;
  const limit = input.limit ?? 10;
  const fileType = normalizeFileType(input.fileType);
  const directory = normalizeDirectory(input.directory);
  const scopedScope: SearchScope = { fileType, directory };
  const unscopedScope: SearchScope = {};
  const hasFilters = Boolean(fileType || directory);
  const relaxedFields = relaxedHintFields(fileType, directory);
  const attempts: RecoveryAttempt[] = [];
  const decisions: RecoveryDecisions = {
    inferredDefinitionMiss: false,
    fallbackFromOriginalConceptualToInferred: false,
    relaxedFields: [],
  };

  if (!query && !definitionSymbol) {
    const fallback = fitTextToContextBudget("Cannot resolve context for an empty query.", tokenBudget);
    return {
      text: fallback.text,
      details: {
        route: "conceptual",
        routedQuery: query,
        tokenBudget: fallback.tokenBudget,
        tokenEstimate: fallback.tokenEstimate,
        truncated: fallback.truncated,
        recovery: {
          attempts: [],
          successfulAttemptIndex: undefined,
        },
      },
    };
  }

  const seenAttempts = new Set<string>();
  const recordAttempt = async (
    kind: "definition" | "conceptual",
    attemptQuery: string,
    scope: SearchScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType">,
    runAttempt: () => Promise<SearchResult[]>,
  ): Promise<SearchResult[]> => {
    const key = attemptKey(kind, attemptQuery, scope);
    if (seenAttempts.has(key)) {
      return [];
    }

    const results = await runAttempt();
    seenAttempts.add(key);
    attempts.push({
      kind,
      scope: describeScope(scope.fileType, scope.directory),
      resultCount: results.length,
      relaxedFields: relaxedFieldsForAttempt,
    });

    for (const field of relaxedFieldsForAttempt) {
      if (!decisions.relaxedFields.includes(field)) {
        decisions.relaxedFields.push(field);
      }
    }

    return results;
  };

  const tryDefinitionLookup = async (
    symbol: string,
    scope: SearchScope = scopedScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType"> = [],
  ): Promise<SearchResult[]> => {
    return recordAttempt(
      "definition",
      symbol,
      scope,
      relaxedFieldsForAttempt,
      () => operations.lookup(symbol, MAX_CONTEXT_RESULT_LIMIT, scope),
    );
  };

  const tryConceptualSearch = async (
    searchQuery: string,
    scope: SearchScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType">,
  ): Promise<SearchResult[]> => {
    return recordAttempt(
      "conceptual",
      searchQuery,
      scope,
      relaxedFieldsForAttempt,
      () => operations.search(searchQuery, MAX_CONTEXT_RESULT_LIMIT, scope),
    );
  };

  const toResult = (
    route: "definition" | "conceptual",
    routedQuery: string,
    pack: ReturnType<typeof buildContextPack>,
  ): CodebaseContextResult => {
    const base = packedResult(route, routedQuery, pack);
    const baseDetails = base.details as NonNullable<CodebaseContextResult["details"]>;
    const successIndex = findSuccessfulAttemptIndex(route, attempts);
    return {
      text: base.text,
      details: {
        ...baseDetails,
        tokenBudget: baseDetails.tokenBudget,
        tokenEstimate: baseDetails.tokenEstimate,
        truncated: false,
        recovery: buildRecoveryDetails(attempts, successIndex),
      },
    };
  };

  if (definitionSymbol) {
    const scopedDefinitionResults = await tryDefinitionLookup(definitionSymbol);
    if (scopedDefinitionResults.length > 0) {
      const heading = buildPackHeading("definition", decisions);
      return toResult(
        "definition",
        definitionSymbol,
        buildContextPack(scopedDefinitionResults, {
          tokenBudget,
          maxResults: limit,
          heading,
        }),
      );
    }

    if (explicitSymbol) {
      if (hasFilters) {
        const unscopedDefinitionResults = await tryDefinitionLookup(
          definitionSymbol,
          unscopedScope,
          relaxedFields,
        );
        if (unscopedDefinitionResults.length > 0) {
          const heading = buildPackHeading("definition", decisions);
          return toResult(
            "definition",
            definitionSymbol,
            buildContextPack(unscopedDefinitionResults, {
              tokenBudget,
              maxResults: limit,
              heading,
            }),
          );
        }
      }

      const heading = buildRecoveryFallbackText(
        attempts,
        tokenBudget,
        `${buildPackHeading("definition", decisions)}\nNo definition found.\n` +
          "Explicit symbol lookup only; conceptual search was not attempted.",
      );
      return {
        text: heading.text,
        details: {
          route: "definition",
          routedQuery: definitionSymbol,
          tokenBudget: heading.tokenBudget,
          tokenEstimate: heading.tokenEstimate,
          truncated: heading.truncated,
          recovery: buildRecoveryDetails(attempts, null),
        },
      };
    }

    if (inferredSymbol) {
      decisions.inferredDefinitionMiss = true;
    }
  }

  const conceptualQueries: string[] = [];
  if (query) {
    conceptualQueries.push(query);
  }
  if (inferredSymbol && inferredSymbol !== query) {
    conceptualQueries.push(inferredSymbol);
  }

  const conceptualAttemptPlan: Array<{ queryText: string; scope: SearchScope; relaxed: Array<"directory" | "fileType"> }> = [];
  for (const conceptQuery of conceptualQueries) {
    conceptualAttemptPlan.push({ queryText: conceptQuery, scope: scopedScope, relaxed: [] });
  }
  if (hasFilters) {
    for (const conceptQuery of conceptualQueries) {
      conceptualAttemptPlan.push({ queryText: conceptQuery, scope: unscopedScope, relaxed: relaxedFields });
    }
  }

  for (const attempt of conceptualAttemptPlan) {
    if (inferredSymbol && attempt.queryText === inferredSymbol && attempt.queryText !== query) {
      decisions.fallbackFromOriginalConceptualToInferred = true;
    }
    const results = await tryConceptualSearch(attempt.queryText, attempt.scope, attempt.relaxed);
    if (results.length > 0) {
      const heading = buildPackHeading("conceptual", decisions);
      return toResult(
        "conceptual",
        attempt.queryText,
        buildContextPack(results, {
          tokenBudget,
          maxResults: limit,
          heading,
          includeExactSearchHandoff: true,
        }),
      );
    }
  }

  const fallbackText = buildRecoveryFallbackText(
    attempts,
    tokenBudget,
    "No matching code found. Try a different query or run index_codebase first.",
  );
  return {
    text: fallbackText.text,
    details: {
      route: "conceptual",
      tokenBudget: fallbackText.tokenBudget,
      tokenEstimate: fallbackText.tokenEstimate,
      truncated: fallbackText.truncated,
      recovery: buildRecoveryDetails(attempts, null),
    },
  };
}

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

  return resolveSearchContext({ query: input.query, symbol, limit, tokenBudget, fileType, directory }, {
    lookup: (lookupSymbol, retrievalLimit, scope) => implementationLookup(projectRoot, host, lookupSymbol, {
      limit: retrievalLimit,
      fileType: scope.fileType,
      directory: scope.directory,
    }),
    search: (queryText, retrievalLimit, scope) => searchCodebase(projectRoot, host, queryText, {
      limit: retrievalLimit,
      fileType: scope.fileType,
      directory: scope.directory,
      metadataOnly: true,
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
  const startedAt = performance.now();
  try {
    const result = await resolveCodebaseContextUnmeasured(projectRoot, host, input);
    const details = result.details;
    if (details) {
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
    throw error;
  }
}
