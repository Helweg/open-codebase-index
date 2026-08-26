import type { CallEdgeData, SymbolData } from "../native/types.js";

export interface CallGraphLanguageCoverage {
  language: string;
  totalEdges: number;
  resolvedEdges: number;
  unresolvedEdges: number;
  resolutionRate: number;
}

export interface CallGraphCoverage {
  totalEdges: number;
  resolvedEdges: number;
  unresolvedEdges: number;
  resolutionRate: number;
  languages: CallGraphLanguageCoverage[];
}

function resolutionRate(resolvedEdges: number, totalEdges: number): number {
  return totalEdges === 0 ? 0 : resolvedEdges / totalEdges;
}

export function emptyCallGraphCoverage(): CallGraphCoverage {
  return {
    totalEdges: 0,
    resolvedEdges: 0,
    unresolvedEdges: 0,
    resolutionRate: 0,
    languages: [],
  };
}

export function summarizeCallGraphCoverage(
  symbols: readonly SymbolData[],
  edges: readonly CallEdgeData[],
): CallGraphCoverage {
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const languageCounts = new Map<string, { totalEdges: number; resolvedEdges: number }>();
  let totalEdges = 0;
  let resolvedEdges = 0;

  const orderedEdges = edges.slice().sort((left, right) =>
    left.fromSymbolId.localeCompare(right.fromSymbolId)
    || left.line - right.line
    || left.col - right.col
    || left.id.localeCompare(right.id)
  );
  for (const edge of orderedEdges) {
    const source = symbolsById.get(edge.fromSymbolId);
    if (!source) continue;

    const resolved = edge.isResolved
      && edge.toSymbolId !== undefined
      && symbolsById.has(edge.toSymbolId);
    totalEdges += 1;
    if (resolved) resolvedEdges += 1;

    const counts = languageCounts.get(source.language) ?? { totalEdges: 0, resolvedEdges: 0 };
    counts.totalEdges += 1;
    if (resolved) counts.resolvedEdges += 1;
    languageCounts.set(source.language, counts);
  }

  return {
    totalEdges,
    resolvedEdges,
    unresolvedEdges: totalEdges - resolvedEdges,
    resolutionRate: resolutionRate(resolvedEdges, totalEdges),
    languages: [...languageCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, counts]) => ({
        language,
        totalEdges: counts.totalEdges,
        resolvedEdges: counts.resolvedEdges,
        unresolvedEdges: counts.totalEdges - counts.resolvedEdges,
        resolutionRate: resolutionRate(counts.resolvedEdges, counts.totalEdges),
      })),
  };
}

export function formatCallGraphCoverage(coverage: CallGraphCoverage): string {
  if (coverage.totalEdges === 0) {
    return "No call edges were observed in scope.";
  }

  const languageSummary = coverage.languages
    .map((entry) => `${entry.language} ${entry.resolvedEdges}/${entry.totalEdges}`)
    .join(", ");
  const unresolved = coverage.unresolvedEdges === 0
    ? "all observed edges resolved"
    : `${coverage.unresolvedEdges} unresolved`;
  return `${coverage.resolvedEdges}/${coverage.totalEdges} observed call edges resolved (${unresolved})${
    languageSummary ? `; by language: ${languageSummary}` : ""
  }.`;
}
