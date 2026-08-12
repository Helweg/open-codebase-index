import type { SearchResult } from "../indexer/index.js";
import type { SearchTrace } from "../indexer/index.js";
import { analyzeQueryIntent } from "../indexer/intent-aware-ranking.js";
import { inferExactSymbolFromQuery } from "./symbol-inference.js";
import { buildContextPack, fitTextToContextBudget } from "./utils.js";
import type { ContextPackTrace } from "./context-pack.js";

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
  diagnostic?: boolean;
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
    diagnostic?: {
      route: "definition" | "conceptual";
      routedQuery: string;
      searchQuery: string;
      searchScope: {
        fileType?: string;
        directory?: string;
      };
      searchTrace?: SearchTrace;
      contextPackTrace?: ContextPackTrace;
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
  lookup(
    symbol: string,
    limit: number,
    scope: SearchScope,
    trace?: (trace: SearchTrace) => void,
  ): Promise<SearchResult[]>;
  search(
    query: string,
    limit: number,
    scope: SearchScope,
    trace?: (trace: SearchTrace) => void,
    searchOptions?: {
      prioritizeSourcePaths?: boolean;
    },
  ): Promise<SearchResult[]>;
}

type RecoveryScope = "scoped" | "unscoped";

interface RecoveryAttempt {
  kind: "definition" | "conceptual";
  scope: RecoveryScope;
  resultCount: number;
  relaxedFields: Array<"directory" | "fileType">;
}

interface SearchAttemptState extends RecoveryAttempt {
  query: string;
  scopeFilter: SearchScope;
  searchTrace?: SearchTrace;
  contextPackTrace?: ContextPackTrace;
}

type SearchDiagnostic = NonNullable<NonNullable<CodebaseContextResult["details"]>["diagnostic"]>;

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

function serializeAttempts(attempts: SearchAttemptState[]): RecoveryAttempt[] {
  return attempts.map((attempt) => ({
    kind: attempt.kind,
    scope: attempt.scope,
    resultCount: attempt.resultCount,
    relaxedFields: attempt.relaxedFields,
  }));
}

function buildSearchDiagnostic(attempt: SearchAttemptState | undefined): SearchDiagnostic | undefined {
  if (!attempt) {
    return undefined;
  }

  return {
    route: attempt.kind,
    routedQuery: attempt.query,
    searchQuery: attempt.query,
    searchScope: attempt.scopeFilter,
    searchTrace: attempt.searchTrace,
    contextPackTrace: attempt.contextPackTrace,
  };
}

export function trimOrUndefined(value: string | null | undefined): string | undefined {
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
  input: Pick<CodebaseContextInput, "query" | "symbol" | "limit" | "tokenBudget" | "fileType" | "directory" | "diagnostic">,
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
  const attemptStates: SearchAttemptState[] = [];
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
    runAttempt: (trace?: (trace: SearchTrace) => void) => Promise<SearchResult[]>,
  ): Promise<SearchResult[]> => {
    const key = attemptKey(kind, attemptQuery, scope);
    if (seenAttempts.has(key)) {
      return [];
    }

    const attemptState: SearchAttemptState = {
      kind,
      scope: describeScope(scope.fileType, scope.directory),
      resultCount: 0,
      relaxedFields: [...relaxedFieldsForAttempt],
      query: attemptQuery,
      scopeFilter: scope,
    };
    const results = await runAttempt((trace) => {
      attemptState.searchTrace = trace;
    });
    attemptState.resultCount = results.length;
    seenAttempts.add(key);
    attemptStates.push(attemptState);
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
      (trace) => operations.lookup(symbol, MAX_CONTEXT_RESULT_LIMIT, scope, input.diagnostic ? trace : undefined),
    );
  };

  const tryConceptualSearch = async (
    searchQuery: string,
    scope: SearchScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType">,
    prioritizeSourcePaths: boolean,
  ): Promise<SearchResult[]> => {
    return recordAttempt(
      "conceptual",
      searchQuery,
      scope,
      relaxedFieldsForAttempt,
      (trace) => operations.search(
        searchQuery,
        MAX_CONTEXT_RESULT_LIMIT,
        scope,
        input.diagnostic ? trace : undefined,
        { prioritizeSourcePaths },
      ),
    );
  };

  const findSuccessfulAttemptState = (
    route: "definition" | "conceptual",
  ): SearchAttemptState | undefined => {
    for (let index = attemptStates.length - 1; index >= 0; index -= 1) {
      const attempt = attemptStates[index];
      if (attempt.kind === route && attempt.resultCount > 0) {
        return attempt;
      }
    }

    return undefined;
  };

  const toResult = (
    route: "definition" | "conceptual",
    routedQuery: string,
    pack: ReturnType<typeof buildContextPack>,
    successfulAttempt?: SearchAttemptState,
  ): CodebaseContextResult => {
    const base = packedResult(route, routedQuery, pack);
    const baseDetails = base.details as NonNullable<CodebaseContextResult["details"]>;
    const successIndex = findSuccessfulAttemptIndex(route, attempts);
    const successState = successfulAttempt ?? findSuccessfulAttemptState(route);
    return {
      text: base.text,
      details: {
        ...baseDetails,
        tokenBudget: baseDetails.tokenBudget,
        tokenEstimate: baseDetails.tokenEstimate,
        truncated: false,
        recovery: buildRecoveryDetails(serializeAttempts(attemptStates), successIndex),
        ...(input.diagnostic && {
          diagnostic: buildSearchDiagnostic(successState),
        }),
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
          preserveInputOrder: true,
          ...(input.diagnostic ? {
            trace: (trace) => {
              const attemptState = findSuccessfulAttemptState("definition");
              if (attemptState) {
                attemptState.contextPackTrace = trace;
              }
            },
          } : undefined),
        }),
        findSuccessfulAttemptState("definition"),
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
              preserveInputOrder: true,
              ...(input.diagnostic ? {
                trace: (trace) => {
                  const attemptState = findSuccessfulAttemptState("definition");
                  if (attemptState) {
                    attemptState.contextPackTrace = trace;
                  }
                },
              } : undefined),
            }),
            findSuccessfulAttemptState("definition"),
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
          recovery: buildRecoveryDetails(serializeAttempts(attemptStates), null),
          ...(input.diagnostic && {
            diagnostic: buildSearchDiagnostic(attemptStates[attemptStates.length - 1]),
          }),
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
    const attemptIntent = analyzeQueryIntent(attempt.queryText);
    const prioritizeSourcePaths = attemptIntent.primary !== "docs" && attemptIntent.primary !== "test";
    if (inferredSymbol && attempt.queryText === inferredSymbol && attempt.queryText !== query) {
      decisions.fallbackFromOriginalConceptualToInferred = true;
    }
    const results = await tryConceptualSearch(attempt.queryText, attempt.scope, attempt.relaxed, prioritizeSourcePaths);
    if (results.length > 0) {
      const heading = buildPackHeading("conceptual", decisions);
      const intent = analyzeQueryIntent(attempt.queryText);
      return toResult(
        "conceptual",
        attempt.queryText,
        buildContextPack(results, {
          tokenBudget,
          maxResults: limit,
          heading,
          includeExactSearchHandoff: true,
          preferImplementationPaths:
            intent.preferSourcePaths || (intent.primary !== "docs" && intent.primary !== "test"),
          ...(input.diagnostic ? {
            trace: (trace) => {
              const attemptState = findSuccessfulAttemptState("conceptual");
              if (attemptState) {
                attemptState.contextPackTrace = trace;
              }
            },
          } : undefined),
        }),
        findSuccessfulAttemptState("conceptual"),
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
      recovery: buildRecoveryDetails(serializeAttempts(attemptStates), null),
      ...(input.diagnostic && {
        diagnostic: buildSearchDiagnostic(attemptStates[attemptStates.length - 1]),
      }),
    },
  };
}
