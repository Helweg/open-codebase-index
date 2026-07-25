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
  pack: ReturnType<typeof buildContextPack>,
): CodebaseContextResult {
  return {
    text: pack.text,
    details: {
      route,
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

  const lookupSymbol = symbol ?? inferExactSymbolFromQuery(input.query);
  if (lookupSymbol) {
    const definitions = await implementationLookup(projectRoot, host, lookupSymbol, {
      limit,
      fileType,
      directory,
    });
    if (definitions.length > 0) {
      return packedResult("definition", buildContextPack(definitions, {
        tokenBudget,
        maxResults: limit,
        heading: `Definition evidence for ${JSON.stringify(lookupSymbol)}`,
      }));
    }
    if (symbol) {
      const fitted = fitTextToContextBudget(
        formatDefinitionLookup(definitions, lookupSymbol),
        tokenBudget,
      );
      return { text: fitted.text };
    }
  }

  const results = await searchCodebase(projectRoot, host, input.query, {
    limit,
    fileType,
    directory,
    metadataOnly: true,
  });
  if (results.length === 0) {
    const fitted = fitTextToContextBudget(
      "No matching code found. Try a different query or run index_codebase first.",
      tokenBudget,
    );
    return { text: fitted.text };
  }

  return packedResult("conceptual", buildContextPack(results, {
    tokenBudget,
    maxResults: limit,
    heading: `Codebase evidence for ${JSON.stringify(input.query)}`,
  }));
}
