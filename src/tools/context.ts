import type { HostMode } from "../config/host.js";
import type { SearchResult } from "../indexer/index.js";
import {
  getCallGraphData,
  getCallGraphPath,
  implementationLookup,
  searchCodebase,
} from "./operations.js";
import { inferExactSymbolFromQuery } from "./symbol-inference.js";
import {
  buildContextPack,
  fitTextToContextBudget,
  formatCallGraphPath,
  formatDefinitionLookup,
} from "./utils.js";

export interface CodebaseContextInput {
  query: string;
  from?: string | null;
  to?: string | null;
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
  lookup(symbol: string, limit: number): Promise<SearchResult[]>;
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

function formatRecoveryText(
  attempts: RecoveryAttempt[],
  tokenBudget: number | undefined,
  fallbackLabel: string,
): ReturnType<typeof fitTextToContextBudget> {
  const lines = [
    `${fallbackLabel}`,
    attempts.length > 0
      ? `Attempted ${attempts.length} recovery attempt${attempts.length === 1 ? "" : "s"}:`
      : "No recovery attempts were executed.",
    ...attempts.map(formatRecoveryAttemptLine),
  ];

  return fitTextToContextBudget(lines.join("\n"), tokenBudget);
}

function recoveryPrefix(attempts: RecoveryAttempt[], successIndex: number | null): string | undefined {
  if (successIndex === null) return undefined;

  const successfulAttempt = attempts[successIndex];

  if (successfulAttempt.scope === "unscoped" && successfulAttempt.relaxedFields.length > 0) {
    return "Recovery: requested filters had no matches. Showing unscoped results.";
  }

  if (attempts.slice(0, successIndex).some((attempt) => attempt.kind === "conceptual" && attempt.resultCount === 0)) {
    return "Recovery: the original query had no matches. Showing inferred-symbol results.";
  }

  return undefined;
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
  if (!query) {
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

  const explicitSymbol = trimOrUndefined(input.symbol);
  const limit = input.limit ?? 10;
  const fileType = trimOrUndefined(input.fileType);
  const directory = trimOrUndefined(input.directory);
  const inferredSymbol = explicitSymbol ? undefined : inferExactSymbolFromQuery(query);
  const lookupSymbol = explicitSymbol ?? inferredSymbol;
  const scopedScope: SearchScope = {
    fileType,
    directory,
  };
  const hasFilters = Boolean(fileType || directory);
  const relaxedFields = relaxedHintFields(fileType, directory);
  const attempts: RecoveryAttempt[] = [];
  const seenAttempts = new Set<string>();

  const recordAttempt = async (
    kind: "definition" | "conceptual",
    query: string,
    scope: SearchScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType">,
    runAttempt: () => Promise<SearchResult[]>,
  ): Promise<SearchResult[]> => {
    const lookupFileType = scope.fileType;
    const lookupDirectory = scope.directory;
    const key = attemptKey(kind, query, scope);
    if (seenAttempts.has(key)) {
      return [];
    }

    const results = await runAttempt();
    seenAttempts.add(key);
    attempts.push({
      kind,
      scope: describeScope(lookupFileType, lookupDirectory),
      relaxedFields: relaxedFieldsForAttempt,
      resultCount: results.length,
    });

    return results;
  };

  const tryDefinitionLookup = async (symbol: string): Promise<SearchResult[]> => {
    return recordAttempt(
      "definition",
      symbol,
      scopedScope,
      [],
      () => operations.lookup(symbol, MAX_CONTEXT_RESULT_LIMIT),
    );
  };

  const tryConceptualSearch = async (
    queryText: string,
    scope: SearchScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType">,
  ): Promise<SearchResult[]> => {
    return recordAttempt(
      "conceptual",
      queryText,
      scope,
      relaxedFieldsForAttempt,
      () => operations.search(queryText, MAX_CONTEXT_RESULT_LIMIT, scope),
    );
  };

  const tryConceptualWithFallbackScope = async (queryText: string): Promise<SearchResult[]> => {
    const scopedResults = await tryConceptualSearch(queryText, scopedScope, []);
    if (scopedResults.length > 0) {
      return scopedResults;
    }

    if (!hasFilters) {
      return scopedResults;
    }

    return tryConceptualSearch(queryText, {}, relaxedFields);
  };

  const toResult = (
    route: "definition" | "conceptual",
    routedQuery: string,
    pack: ReturnType<typeof buildContextPack>,
  ): CodebaseContextResult => {
    const base = packedResult(route, routedQuery, pack);
    const baseDetails = base.details as NonNullable<CodebaseContextResult["details"]>;
    const successIndex = findSuccessfulAttemptIndex(route, attempts);
    const note = recoveryPrefix(attempts, successIndex);
    const fitted = fitTextToContextBudget(note ? `${note}\n\n${base.text}` : base.text, tokenBudget);
    return {
      text: fitted.text,
      details: {
        ...baseDetails,
        tokenBudget: fitted.tokenBudget,
        tokenEstimate: fitted.tokenEstimate,
        truncated: fitted.truncated,
        recovery: buildRecoveryDetails(attempts, successIndex),
      },
    };
  };

  if (lookupSymbol) {
    const definitions = await tryDefinitionLookup(lookupSymbol);
    if (definitions.length > 0) {
      const pack = buildContextPack(definitions, {
        tokenBudget,
        maxResults: limit,
        heading: `Definition evidence for ${JSON.stringify(lookupSymbol)}`,
      });
      return toResult("definition", lookupSymbol, pack);
    }

    if (explicitSymbol) {
      const fittedFallback = formatRecoveryText(
        attempts,
        tokenBudget,
        `${formatDefinitionLookup(definitions, lookupSymbol)}\nExplicit symbol lookup only; conceptual search was not attempted.`,
      );
      return {
        text: fittedFallback.text,
        details: {
          route: "definition",
          routedQuery: lookupSymbol,
          tokenBudget: fittedFallback.tokenBudget,
          tokenEstimate: fittedFallback.tokenEstimate,
          truncated: fittedFallback.truncated,
          recovery: buildRecoveryDetails(attempts, null),
        },
      };
    }
  }

  const conceptualQueries = [query];
  if (inferredSymbol && inferredSymbol !== query) {
    conceptualQueries.push(inferredSymbol);
  }

  const [primaryConceptualQuery, inferredConceptualQuery] = conceptualQueries;

  if (primaryConceptualQuery) {
    const results = await tryConceptualWithFallbackScope(primaryConceptualQuery);
    if (results.length > 0) {
      const pack = buildContextPack(results, {
        tokenBudget,
        maxResults: limit,
        heading: `Codebase evidence for ${JSON.stringify(primaryConceptualQuery)}`,
      });
      return toResult("conceptual", primaryConceptualQuery, pack);
    }
  }

  if (inferredConceptualQuery && inferredConceptualQuery !== query) {
    const inferredResults = await tryConceptualSearch(inferredConceptualQuery, {}, relaxedFields);
    if (inferredResults.length > 0) {
      const pack = buildContextPack(inferredResults, {
        tokenBudget,
        maxResults: limit,
        heading: `Codebase evidence for ${JSON.stringify(inferredConceptualQuery)}`,
      });
      return toResult("conceptual", inferredConceptualQuery, pack);
    }
  }

  const fallbackText = formatRecoveryText(
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
): NonNullable<CodebaseContextResult["details"]> {
  return {
    route,
    tokenBudget: fitted.tokenBudget,
    tokenEstimate: fitted.tokenEstimate,
    truncated: fitted.truncated,
  };
}

export async function resolveCodebaseContext(
  projectRoot: string | undefined,
  host: HostMode,
  input: CodebaseContextInput,
): Promise<CodebaseContextResult> {
  const from = input.from ?? undefined;
  const to = input.to ?? undefined;
  const symbol = input.symbol ?? undefined;
  const limit = input.limit ?? 10;
  const maxDepth = input.maxDepth ?? 10;
  const fileType = input.fileType ?? undefined;
  const directory = input.directory ?? undefined;
  const tokenBudget = input.tokenBudget ?? undefined;
  if (from && to) {
    const path = await getCallGraphPath(projectRoot, host, from, to, maxDepth);
    if (path.length > 0) {
      const fitted = fitTextToContextBudget(
        formatCallGraphPath(from, to, path),
        tokenBudget,
      );
      return {
        text: fitted.text,
        details: fittedDetails("path", fitted),
      };
    }

    const { callers } = await getCallGraphData(projectRoot, host, {
      name: to,
      direction: "callers",
    });
    const directEdge = callers.find((edge) => edge.fromSymbolName === from);
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
        details: fittedDetails("direct-edge", fitted),
      };
    }

    const fitted = fitTextToContextBudget(
      formatCallGraphPath(from, to, path),
      tokenBudget,
    );
    return {
      text: fitted.text,
      details: fittedDetails("path", fitted),
    };
  }

  return resolveSearchContext({ query: input.query, symbol, limit, tokenBudget, fileType, directory }, {
    lookup: (lookupSymbol, retrievalLimit) => implementationLookup(projectRoot, host, lookupSymbol, {
      limit: retrievalLimit,
      fileType,
      directory,
    }),
    search: (queryText, retrievalLimit, scope) => searchCodebase(projectRoot, host, queryText, {
      limit: retrievalLimit,
      fileType: scope.fileType,
      directory: scope.directory,
      metadataOnly: true,
    }),
  });
}
