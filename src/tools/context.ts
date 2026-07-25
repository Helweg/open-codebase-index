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
  from?: string;
  to?: string;
  symbol?: string;
  limit?: number;
  maxDepth?: number;
  fileType?: string;
  directory?: string;
  tokenBudget?: number;
}

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
  if (input.from && input.to) {
    const path = await getCallGraphPath(projectRoot, host, input.from, input.to, input.maxDepth);
    if (path.length > 0) {
      const fitted = fitTextToContextBudget(
        formatCallGraphPath(input.from, input.to, path),
        input.tokenBudget,
      );
      return {
        text: fitted.text,
        details: fittedDetails("path", fitted),
      };
    }

    const { callers } = await getCallGraphData(projectRoot, host, {
      name: input.to,
      direction: "callers",
    });
    const directEdge = callers.find((edge) => edge.fromSymbolName === input.from);
    if (directEdge) {
      const location = directEdge.fromSymbolFilePath
        ? ` at ${directEdge.fromSymbolFilePath}:${directEdge.line}`
        : "";
      const fitted = fitTextToContextBudget(
        `Direct path: ${input.from} --${directEdge.callType}--> ${input.to}${location} ` +
          `(edge is ${directEdge.isResolved ? "resolved" : "unresolved"}).`,
        input.tokenBudget,
      );
      return {
        text: fitted.text,
        details: fittedDetails("direct-edge", fitted),
      };
    }

    const fitted = fitTextToContextBudget(
      formatCallGraphPath(input.from, input.to, path),
      input.tokenBudget,
    );
    return {
      text: fitted.text,
      details: fittedDetails("path", fitted),
    };
  }

  const lookupSymbol = input.symbol ?? inferExactSymbolFromQuery(input.query);
  if (lookupSymbol) {
    const definitions = await implementationLookup(projectRoot, host, lookupSymbol, {
      limit: input.limit ?? 10,
      fileType: input.fileType,
      directory: input.directory,
    });
    if (definitions.length > 0) {
      return packedResult("definition", buildContextPack(definitions, {
        tokenBudget: input.tokenBudget,
        maxResults: input.limit ?? 10,
        heading: `Definition evidence for ${JSON.stringify(lookupSymbol)}`,
      }));
    }
    if (input.symbol) {
      const fitted = fitTextToContextBudget(
        formatDefinitionLookup(definitions, lookupSymbol),
        input.tokenBudget,
      );
      return { text: fitted.text };
    }
  }

  const results = await searchCodebase(projectRoot, host, input.query, {
    limit: input.limit ?? 10,
    fileType: input.fileType,
    directory: input.directory,
    metadataOnly: true,
  });
  if (results.length === 0) {
    const fitted = fitTextToContextBudget(
      "No matching code found. Try a different query or run index_codebase first.",
      input.tokenBudget,
    );
    return { text: fitted.text };
  }

  return packedResult("conceptual", buildContextPack(results, {
    tokenBudget: input.tokenBudget,
    maxResults: input.limit ?? 10,
    heading: `Codebase evidence for ${JSON.stringify(input.query)}`,
  }));
}
