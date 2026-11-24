import type { SearchResult } from "../indexer/index.js";
import type { SearchTrace } from "../indexer/index.js";
import { analyzeQueryIntent } from "../indexer/intent-aware-ranking.js";
import { inferExactSymbolFromQuery, inferTestSymbolFromQuery } from "./symbol-inference.js";
import { buildContextPack, fitTextToContextBudget } from "./utils.js";
import type { ContextPackOptions, ContextPackTrace } from "./context-pack.js";
import type { TestDiscoveryResult, TestEvidenceKind, TestReferenceResult } from "./test-discovery.js";

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
  allowUnscopedRecovery?: boolean;
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
  evidenceKind?: TestEvidenceKind;
  referencedSymbol?: string;
  referenceLine?: number;
}

export interface CodebaseContextResult {
  text: string;
  details?: {
    route: "path" | "direct-edge" | "definition" | "conceptual";
    resolution?: "resolved" | "ambiguous" | "not_found";
    matchKind?: "exact_symbol" | "lexical" | "semantic" | "graph_neighbor";
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
    testDiscovery?: Omit<TestDiscoveryResult, "results">;
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
    ...("evidenceKind" in result ? {
      evidenceKind: (result as TestReferenceResult).evidenceKind,
      referencedSymbol: (result as TestReferenceResult).referencedSymbol,
      referenceLine: (result as TestReferenceResult).referenceLine,
    } : {}),
  }));
}

function testDiscoveryMetadata(discovery: TestDiscoveryResult): Omit<TestDiscoveryResult, "results"> {
  return {
    resolution: discovery.resolution,
    scannedFileCount: discovery.scannedFileCount,
    candidateFileCount: discovery.candidateFileCount,
    verifiedCallerCount: discovery.verifiedCallerCount,
    capped: discovery.capped,
  };
}

interface SearchContextOperations {
  lookup(
    symbol: string,
    limit: number,
    scope: SearchScope,
    exactSymbol: boolean,
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
  discoverTests?(symbol: string, scope: SearchScope): Promise<TestDiscoveryResult>;
}

type RecoveryScope = "scoped" | "unscoped";

interface RecoveryAttempt {
  kind: "definition" | "conceptual";
  scope: RecoveryScope;
  resultCount: number;
  relaxedFields: Array<"directory" | "fileType">;
}

interface SearchAttempt extends RecoveryAttempt {
  index: number;
  results: SearchResult[];
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
  attempts: SearchAttempt[],
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
    `${lines.join("\n")}\n${attempts.map(formatRecoveryAttemptLine).join("\n")}`,
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

function formatRecoveryAttemptLine(attempt: SearchAttempt): string {
  const scope = attempt.scope === "scoped"
    ? "scoped"
    : attempt.relaxedFields.length > 0
      ? `unscoped (after removing ${attempt.relaxedFields.join(" and ")})`
      : "unscoped";

  return `${attempt.index + 1}. ${attempt.kind} ${scope} search: ${attempt.resultCount} result${attempt.resultCount === 1 ? "" : "s"}`;
}

function buildRecoveryDetails(attempts: SearchAttempt[], successfulAttempt?: SearchAttempt) {
  return {
    attempts: attempts.map(({ kind, scope, resultCount, relaxedFields }) => ({
      kind,
      scope,
      resultCount,
      relaxedFields,
    })),
    ...(successfulAttempt && { successfulAttemptIndex: successfulAttempt.index }),
  };
}

function buildSearchDiagnostic(attempt: SearchAttempt | undefined): SearchDiagnostic | undefined {
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
  input: Pick<
    CodebaseContextInput,
    "query" | "symbol" | "limit" | "tokenBudget" | "fileType" | "directory" | "diagnostic" | "allowUnscopedRecovery"
  >,
  operations: SearchContextOperations,
  origins?: Array<{ root: string; label: string }>,
): Promise<CodebaseContextResult> {
  const query = trimOrUndefined(input.query);
  const tokenBudget = input.tokenBudget ?? undefined;
  const explicitSymbol = trimOrUndefined(input.symbol);
  const inferredSymbol = explicitSymbol || !query ? undefined : inferExactSymbolFromQuery(query);
  const testSymbol = explicitSymbol || !query ? undefined : inferTestSymbolFromQuery(query);
  const definitionSymbol = explicitSymbol ?? inferredSymbol;
  const limit = input.limit ?? 10;
  const fileType = normalizeFileType(input.fileType);
  const directory = normalizeDirectory(input.directory);
  const scopedScope: SearchScope = { fileType, directory };
  const unscopedScope: SearchScope = {};
  const hasFilters = Boolean(fileType || directory);
  const relaxedFields = relaxedHintFields(fileType, directory);
  const attempts: SearchAttempt[] = [];
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
    lane: "search" | "test-discovery" = "search",
  ): Promise<SearchAttempt | undefined> => {
    const key = `${lane}:${attemptKey(kind, attemptQuery, scope)}`;
    if (seenAttempts.has(key)) {
      return undefined;
    }

    let searchTrace: SearchTrace | undefined;
    const attemptScope = describeScope(scope.fileType, scope.directory);
    const results = await runAttempt(input.diagnostic ? (trace) => {
      searchTrace = trace;
    } : undefined);
    const attempt: SearchAttempt = {
      index: attempts.length,
      kind,
      scope: attemptScope,
      resultCount: results.length,
      results,
      relaxedFields: [...relaxedFieldsForAttempt],
      query: attemptQuery,
      scopeFilter: scope,
      searchTrace,
    };
    seenAttempts.add(key);
    attempts.push(attempt);

    for (const field of relaxedFieldsForAttempt) {
      if (!decisions.relaxedFields.includes(field)) {
        decisions.relaxedFields.push(field);
      }
    }

    return attempt;
  };

  const tryDefinitionLookup = (
    symbol: string,
    exactSymbol: boolean,
    scope: SearchScope = scopedScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType"> = [],
  ): Promise<SearchAttempt | undefined> => {
    return recordAttempt(
      "definition",
      symbol,
      scope,
      relaxedFieldsForAttempt,
      (trace) => operations.lookup(symbol, MAX_CONTEXT_RESULT_LIMIT, scope, exactSymbol, trace),
    );
  };

  const tryConceptualSearch = (
    searchQuery: string,
    scope: SearchScope,
    relaxedFieldsForAttempt: Array<"directory" | "fileType">,
    prioritizeSourcePaths: boolean,
  ): Promise<SearchAttempt | undefined> => {
    return recordAttempt(
      "conceptual",
      searchQuery,
      scope,
      relaxedFieldsForAttempt,
      (trace) => operations.search(
        searchQuery,
        MAX_CONTEXT_RESULT_LIMIT,
        scope,
        trace,
        { prioritizeSourcePaths },
      ),
    );
  };

  let discovery: TestDiscoveryResult | undefined;
  const toResult = (
    attempt: SearchAttempt,
    options: Omit<ContextPackOptions, "trace">,
  ): CodebaseContextResult => {
    const pack = buildContextPack(attempt.results, {
      ...options,
      trace: input.diagnostic ? (trace) => {
        attempt.contextPackTrace = trace;
      } : undefined,
    });
    return {
      text: pack.text,
      details: {
        route: attempt.kind,
        routedQuery: attempt.query,
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
        truncated: false,
        recovery: buildRecoveryDetails(attempts, attempt),
        ...(discovery ? { testDiscovery: testDiscoveryMetadata(discovery) } : undefined),
        ...(input.diagnostic && {
          diagnostic: buildSearchDiagnostic(attempt),
        }),
      },
    };
  };

  const tryTestDiscovery = testSymbol && operations.discoverTests
    ? async (scope: SearchScope, relaxed: Array<"directory" | "fileType">): Promise<CodebaseContextResult | undefined> => {
        const attempt = await recordAttempt("conceptual", query!, scope, relaxed, async () => {
          discovery = await operations.discoverTests!(testSymbol, scope);
          return discovery.results;
        }, "test-discovery");
        if (!attempt || attempt.resultCount === 0) return undefined;
        const resolved = toResult(attempt, {
          tokenBudget, maxResults: limit, preserveInputOrder: true,
          heading: `Bounded test references; not invariant coverage.${discovery!.capped ? " Source caps reached." : ""}\n${buildPackHeading("conceptual", decisions)}`,
          evidenceLabel: (result) => (result as TestReferenceResult).evidenceKind === "direct_target_test_reference"
            ? "Direct target test reference" : "Related caller test; not direct target coverage",
        });
        return {
          ...resolved,
          details: {
            ...resolved.details!, resolution: discovery!.resolution,
            testDiscovery: testDiscoveryMetadata(discovery!),
          },
        };
      }
    : undefined;

  if (definitionSymbol) {
    const scopedDefinition = await tryDefinitionLookup(definitionSymbol, Boolean(explicitSymbol));
    if (scopedDefinition && scopedDefinition.resultCount > 0) {
      return toResult(scopedDefinition, {
        tokenBudget,
        maxResults: limit,
        heading: buildPackHeading("definition", decisions),
        preserveInputOrder: true,
      });
    }

    if (explicitSymbol && hasFilters && input.allowUnscopedRecovery === true) {
      const relaxedDefinition = await tryDefinitionLookup(
        definitionSymbol,
        Boolean(explicitSymbol),
        unscopedScope,
        relaxedFields,
      );
      if (relaxedDefinition && relaxedDefinition.resultCount > 0) {
        return toResult(relaxedDefinition, {
          tokenBudget,
          maxResults: limit,
          heading: buildPackHeading("definition", decisions),
          preserveInputOrder: true,
        });
      }
    }

    if (explicitSymbol) {
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
          recovery: buildRecoveryDetails(attempts),
          ...(input.diagnostic && {
            diagnostic: buildSearchDiagnostic(attempts.at(-1)),
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

  const conceptualScopes: Array<{ scope: SearchScope; relaxed: Array<"directory" | "fileType"> }> = [
    { scope: scopedScope, relaxed: [] },
  ];
  if (hasFilters && input.allowUnscopedRecovery === true) {
    conceptualScopes.push({ scope: unscopedScope, relaxed: relaxedFields });
  }

  for (const attempt of conceptualScopes) {
    const linked = await tryTestDiscovery?.(attempt.scope, attempt.relaxed);
    if (linked) return linked;
    for (const conceptQuery of conceptualQueries) {
      const attemptIntent = analyzeQueryIntent(conceptQuery);
      const prioritizeSourcePaths = attemptIntent.primary !== "docs" && attemptIntent.primary !== "test";
      if (inferredSymbol && conceptQuery === inferredSymbol && conceptQuery !== query) {
        decisions.fallbackFromOriginalConceptualToInferred = true;
      }
      const conceptual = await tryConceptualSearch(conceptQuery, attempt.scope, attempt.relaxed, prioritizeSourcePaths);
      if (conceptual && conceptual.resultCount > 0) {
        const heading = `${buildPackHeading("conceptual", decisions)}${discovery?.capped ? "\nTest discovery source caps reached; ordinary retrieval fallback." : ""}`;
        const intent = analyzeQueryIntent(conceptQuery);
        return toResult(conceptual, {
          origins,
          tokenBudget,
          maxResults: limit,
          heading,
          includeExactSearchHandoff: true,
          preferImplementationPaths:
            intent.preferSourcePaths || (intent.primary !== "docs" && intent.primary !== "test"),
        });
      }
    }
  }

  const fallbackText = buildRecoveryFallbackText(
    attempts,
    tokenBudget,
    "No matching code found. Try a different query or run index_codebase first." +
      (discovery?.capped ? " Test discovery source caps reached." : ""),
  );
  return {
    text: fallbackText.text,
    details: {
      route: "conceptual",
      tokenBudget: fallbackText.tokenBudget,
      tokenEstimate: fallbackText.tokenEstimate,
      truncated: fallbackText.truncated,
      recovery: buildRecoveryDetails(attempts),
      ...(discovery ? { testDiscovery: testDiscoveryMetadata(discovery) } : undefined),
      ...(input.diagnostic && {
        diagnostic: buildSearchDiagnostic(attempts.at(-1)),
      }),
    },
  };
}
