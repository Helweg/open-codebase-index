import type { Indexer } from "../indexer/index.js";
import type { CallEdgeData, PathHopData, SymbolData } from "../native/index.js";

import { CASE_INSENSITIVE_LANGUAGES } from "../indexer/index.js";

export type CallGraphDirection = "callers" | "callees";
export type CallGraphRelationshipType = "Call" | "MethodCall" | "Constructor" | "Import" | "Inherits" | "Implements";

export interface CallGraphQuery {
  name: string;
  direction?: CallGraphDirection | null;
  file?: string | null;
  directory?: string | null;
  relationshipType?: CallGraphRelationshipType | null;
}

export interface CallGraphPathQuery {
  from: string;
  to: string;
  maxDepth?: number | null;
  fromFile?: string | null;
  fromDirectory?: string | null;
  toFile?: string | null;
  toDirectory?: string | null;
}

export interface PublicSymbolLocation {
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface PublicCallGraphEdge {
  name: string;
  filePath?: string;
  line: number;
  callType: string;
  confidence: string;
  resolved: boolean;
  target?: PublicSymbolLocation;
}

export interface CallGraphDetails {
  direction: CallGraphDirection;
  name: string;
  relationshipType?: CallGraphRelationshipType;
  file?: string;
  directory?: string;
  resolution: "resolved" | "unresolved-target" | "ambiguous" | "missing";
  symbol?: PublicSymbolLocation;
  candidates?: PublicSymbolLocation[];
  edges: PublicCallGraphEdge[];
  omittedEdgeCount?: number;
}

export interface CallGraphResult {
  text: string;
  details: CallGraphDetails;
}

export interface CallGraphPathResult {
  text: string;
  details: {
    from: string;
    to: string;
    maxDepth?: number;
    fromFile?: string;
    fromDirectory?: string;
    toFile?: string;
    toDirectory?: string;
    resolution: "resolved" | "ambiguous" | "missing" | "no-path";
    ambiguousEndpoint?: "from" | "to";
    candidates?: PublicSymbolLocation[];
    path: Array<{
      symbolName: string;
      filePath: string;
      line: number;
      callType: string;
    }>;
  };
}

const MAX_AMBIGUITY_CANDIDATES = 8;
const MAX_PUBLIC_EDGES = 100;

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function matchesFile(filePath: string, qualifier: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedQualifier = normalizePath(qualifier);
  return normalizedPath === normalizedQualifier || normalizedPath.endsWith(`/${normalizedQualifier}`);
}

function matchesDirectory(filePath: string, qualifier: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedQualifier = normalizePath(qualifier);
  return normalizedPath.startsWith(`${normalizedQualifier}/`)
    || normalizedPath.includes(`/${normalizedQualifier}/`);
}

function toLocation(symbol: SymbolData): PublicSymbolLocation {
  return {
    name: symbol.name,
    kind: symbol.kind,
    filePath: symbol.filePath,
    line: symbol.startLine,
  };
}

function sortSymbols(symbols: SymbolData[]): SymbolData[] {
  return [...symbols].sort((left, right) => (
    left.filePath.localeCompare(right.filePath)
    || left.startLine - right.startLine
    || left.kind.localeCompare(right.kind)
  ));
}

function exactNameCandidates(symbols: SymbolData[], name: string): SymbolData[] {
  return sortSymbols(symbols.filter((symbol) => (
    CASE_INSENSITIVE_LANGUAGES.has(symbol.language)
      ? symbol.name.toLowerCase() === name.toLowerCase()
      : symbol.name === name
  )));
}

function qualifiedCandidates(
  symbols: SymbolData[],
  file: string | undefined,
  directory: string | undefined,
): SymbolData[] {
  return symbols.filter((symbol) => {
    if (file && !matchesFile(symbol.filePath, file)) return false;
    if (directory && !matchesDirectory(symbol.filePath, directory)) return false;
    return true;
  });
}

function boundedLocations(symbols: SymbolData[]): PublicSymbolLocation[] {
  return symbols.slice(0, MAX_AMBIGUITY_CANDIDATES).map(toLocation);
}

function boundedEdges(edges: CallEdgeData[]): { edges: CallEdgeData[]; omittedCount: number } {
  return {
    edges: edges.slice(0, MAX_PUBLIC_EDGES),
    omittedCount: Math.max(0, edges.length - MAX_PUBLIC_EDGES),
  };
}

function omittedEdgesText(omittedCount: number): string {
  return omittedCount > 0 ? `\n... ${omittedCount} more edge(s) omitted.` : "";
}

function isResolvedEdge(edge: CallEdgeData): boolean {
  return edge.isResolved && Boolean(edge.toSymbolId);
}

function qualifierText(file: string | undefined, directory: string | undefined): string {
  const qualifiers = [
    file ? `file "${file}"` : null,
    directory ? `directory "${directory}"` : null,
  ].filter((value): value is string => value !== null);
  return qualifiers.length > 0 ? ` matching ${qualifiers.join(" and ")}` : "";
}

function relationshipText(relationshipType: CallGraphRelationshipType | undefined): string {
  return relationshipType ? ` with relationship type ${relationshipType}` : "";
}

function formatCandidateList(candidates: SymbolData[]): string {
  const bounded = candidates.slice(0, MAX_AMBIGUITY_CANDIDATES);
  const lines = bounded.map((candidate, index) => (
    `[${index + 1}] ${candidate.filePath}:${candidate.startLine} (${candidate.kind})`
  ));
  const omitted = candidates.length - bounded.length;
  if (omitted > 0) lines.push(`... ${omitted} more candidate(s) omitted.`);
  return lines.join("\n");
}

function formatAmbiguity(
  name: string,
  candidates: SymbolData[],
  file: string | undefined,
  directory: string | undefined,
): string {
  return `Multiple indexed symbols named "${name}"${qualifierText(file, directory)}:\n${formatCandidateList(candidates)}\nRe-run call_graph with file set to one listed file, or directory set to a unique containing directory.`;
}

function formatMissing(
  name: string,
  file: string | undefined,
  directory: string | undefined,
  unqualifiedCandidates: SymbolData[],
): string {
  const available = unqualifiedCandidates.length > 0
    ? `\nExact-name symbols exist at:\n${formatCandidateList(unqualifiedCandidates)}\nUse one of those locations as file or directory.`
    : "";
  return `No indexed symbol named "${name}"${qualifierText(file, directory)}.${available}\nCheck the exact symbol name with implementation_lookup or codebase_peek. Run index_status, then index_codebase if the index is missing or stale.`;
}

function formatCallers(
  name: string,
  symbol: SymbolData | undefined,
  callers: CallEdgeData[],
  relationshipType: CallGraphRelationshipType | undefined,
  unresolvedTarget: boolean,
  omittedCount: number = 0,
): string {
  if (callers.length === 0) {
    const location = symbol ? ` at ${symbol.filePath}:${symbol.startLine}` : "";
    return `No callers found for "${name}"${location}${relationshipText(relationshipType)}. It may not be called by any tracked function, or the index needs updating.`;
  }

  const formatted = callers.map((edge, index) => {
    const confidence = edge.confidence !== "Direct" ? ` [${edge.confidence.toLowerCase()}]` : "";
    const resolution = isResolvedEdge(edge) ? " [resolved]" : " [unresolved]";
    return `[${index + 1}] \u2190 from ${edge.fromSymbolName ?? "<unknown>"} in ${edge.fromSymbolFilePath ?? "<unknown file>"} (${edge.callType})${confidence} at line ${edge.line}${resolution}`;
  });

  if (unresolvedTarget) {
    return `No indexed definition named "${name}" was found, but ${callers.length + omittedCount} unresolved caller reference(s) remain${relationshipText(relationshipType)}:\n\n${formatted.join("\n")}${omittedEdgesText(omittedCount)}\nRun index_codebase to refresh resolution, or use implementation_lookup to verify the exact definition name.`;
  }

  return `"${name}" at ${symbol?.filePath}:${symbol?.startLine} is called by ${callers.length + omittedCount} function(s)${relationshipText(relationshipType)}:\n\n${formatted.join("\n")}${omittedEdgesText(omittedCount)}`;
}

function formatCallees(
  name: string,
  symbol: SymbolData,
  callees: CallEdgeData[],
  relationshipType: CallGraphRelationshipType | undefined,
  symbolsById: Map<string, SymbolData>,
  omittedCount: number = 0,
): string {
  if (callees.length === 0) {
    return `No callees found for "${name}" at ${symbol.filePath}:${symbol.startLine}${relationshipText(relationshipType)}. The function may not call any other tracked functions.`;
  }

  const formatted = callees.map((edge, index) => {
    const confidence = edge.confidence !== "Direct" ? ` [${edge.confidence.toLowerCase()}]` : "";
    const target = edge.toSymbolId ? symbolsById.get(edge.toSymbolId) : undefined;
    const resolution = target
      ? ` [resolved to ${target.filePath}:${target.startLine}]`
      : edge.isResolved ? " [resolved]" : " [unresolved]";
    return `[${index + 1}] \u2192 ${edge.targetName} (${edge.callType})${confidence} at line ${edge.line}${resolution}`;
  });

  return `"${name}" at ${symbol.filePath}:${symbol.startLine} calls ${callees.length + omittedCount} function(s)${relationshipText(relationshipType)}:\n\n${formatted.join("\n")}${omittedEdgesText(omittedCount)}`;
}

function publicCallerEdge(edge: CallEdgeData): PublicCallGraphEdge {
  return {
    name: edge.fromSymbolName ?? "<unknown>",
    filePath: edge.fromSymbolFilePath,
    line: edge.line,
    callType: edge.callType,
    confidence: edge.confidence,
    resolved: isResolvedEdge(edge),
  };
}

function publicCalleeEdge(edge: CallEdgeData, symbolsById: Map<string, SymbolData>): PublicCallGraphEdge {
  const target = edge.toSymbolId ? symbolsById.get(edge.toSymbolId) : undefined;
  return {
    name: edge.targetName,
    line: edge.line,
    callType: edge.callType,
    confidence: edge.confidence,
    resolved: edge.isResolved,
    target: target ? toLocation(target) : undefined,
  };
}

export async function queryCallGraph(indexer: Indexer, params: CallGraphQuery): Promise<CallGraphResult> {
  const direction = params.direction ?? "callers";
  const relationshipType = params.relationshipType ?? undefined;
  const file = params.file?.trim() || undefined;
  const directory = params.directory?.trim() || undefined;
  const name = params.name.trim();
  const symbols = await indexer.getSymbolsForBranch();
  const unqualified = exactNameCandidates(symbols, name);
  const candidates = qualifiedCandidates(unqualified, file, directory);
  const baseDetails = { direction, name, relationshipType, file, directory };

  if (candidates.length > 1) {
    return {
      text: formatAmbiguity(name, candidates, file, directory),
      details: {
        ...baseDetails,
        resolution: "ambiguous",
        candidates: boundedLocations(candidates),
        edges: [],
      },
    };
  }

  if (candidates.length === 0) {
    if (direction === "callers" && !file && !directory) {
      const unresolvedCallers = (await indexer.getCallers(name, relationshipType))
        .filter((edge) => !edge.isResolved || !edge.toSymbolId);
      if (unresolvedCallers.length > 0) {
        const bounded = boundedEdges(unresolvedCallers);
        return {
          text: formatCallers(name, undefined, bounded.edges, relationshipType, true, bounded.omittedCount),
          details: {
            ...baseDetails,
            resolution: "unresolved-target",
            edges: bounded.edges.map(publicCallerEdge),
            omittedEdgeCount: bounded.omittedCount || undefined,
          },
        };
      }
    }

    return {
      text: formatMissing(name, file, directory, unqualified),
      details: {
        ...baseDetails,
        resolution: "missing",
        candidates: boundedLocations(unqualified),
        edges: [],
      },
    };
  }

  const symbol = candidates[0];
  const symbolsById = new Map(symbols.map((candidate) => [candidate.id, candidate]));
  if (direction === "callees") {
    const callees = await indexer.getCallees(symbol.id, relationshipType);
    const bounded = boundedEdges(callees);
    return {
      text: formatCallees(name, symbol, bounded.edges, relationshipType, symbolsById, bounded.omittedCount),
      details: {
        ...baseDetails,
        resolution: "resolved",
        symbol: toLocation(symbol),
        edges: bounded.edges.map((edge) => publicCalleeEdge(edge, symbolsById)),
        omittedEdgeCount: bounded.omittedCount || undefined,
      },
    };
  }

  const callers = (await indexer.getCallers(name, relationshipType))
    .filter((edge) => (
      (edge.isResolved && edge.toSymbolId === symbol.id)
      || !edge.isResolved
      || !edge.toSymbolId
    ));
  const bounded = boundedEdges(callers);
  return {
    text: formatCallers(name, symbol, bounded.edges, relationshipType, false, bounded.omittedCount),
    details: {
      ...baseDetails,
      resolution: "resolved",
      symbol: toLocation(symbol),
      edges: bounded.edges.map(publicCallerEdge),
      omittedEdgeCount: bounded.omittedCount || undefined,
    },
  };
}

function formatPath(from: string, to: string, path: PathHopData[]): string {
  if (path.length === 0) {
    return `No path found between "${from}" and "${to}". They may be in disconnected components, or the call graph index needs updating.`;
  }

  const formatted = path.map((hop, index) => {
    const prefix = index === 0 ? "[start]" : `--${hop.callType}-->`;
    const location = hop.filePath ? ` (${hop.filePath}:${hop.line})` : "";
    return `${prefix} ${hop.symbolName}${location}`;
  });
  return `Path (${path.length} hops):\n${formatted.join("\n")}`;
}

function pathCandidateError(endpoint: "from" | "to", name: string, candidates: SymbolData[]): string {
  const prefix = endpoint === "from" ? "from" : "to";
  return `Cannot resolve call_graph_path ${endpoint} endpoint "${name}" unambiguously. Candidates:\n${formatCandidateList(candidates)}\nRe-run call_graph_path with ${prefix}File set to one listed file, or ${prefix}Directory set to a unique containing directory. Path traversal does not silently choose among same-name definitions.`;
}

export async function queryCallGraphPath(
  indexer: Indexer,
  params: CallGraphPathQuery,
): Promise<CallGraphPathResult> {
  const fromName = params.from.trim();
  const toName = params.to.trim();
  const maxDepth = params.maxDepth ?? undefined;
  const fromFile = params.fromFile?.trim() || undefined;
  const fromDirectory = params.fromDirectory?.trim() || undefined;
  const toFile = params.toFile?.trim() || undefined;
  const toDirectory = params.toDirectory?.trim() || undefined;
  const symbols = await indexer.getSymbolsForBranch();
  const unqualifiedFrom = exactNameCandidates(symbols, fromName);
  const unqualifiedTo = exactNameCandidates(symbols, toName);
  const fromCandidates = qualifiedCandidates(unqualifiedFrom, fromFile, fromDirectory);
  const toCandidates = qualifiedCandidates(unqualifiedTo, toFile, toDirectory);
  const baseDetails = {
    from: params.from,
    to: params.to,
    maxDepth,
    fromFile,
    fromDirectory,
    toFile,
    toDirectory,
  };

  if (fromCandidates.length > 1) {
    return {
      text: pathCandidateError("from", params.from, fromCandidates),
      details: {
        ...baseDetails,
        resolution: "ambiguous",
        ambiguousEndpoint: "from",
        candidates: boundedLocations(fromCandidates),
        path: [],
      },
    };
  }
  if (toCandidates.length > 1) {
    return {
      text: pathCandidateError("to", params.to, toCandidates),
      details: {
        ...baseDetails,
        resolution: "ambiguous",
        ambiguousEndpoint: "to",
        candidates: boundedLocations(toCandidates),
        path: [],
      },
    };
  }
  if (fromCandidates.length === 0 || toCandidates.length === 0) {
    const fromMissing = fromCandidates.length === 0;
    const endpoint = fromMissing ? "from" : "to";
    const name = fromMissing ? params.from : params.to;
    const file = fromMissing ? fromFile : toFile;
    const directory = fromMissing ? fromDirectory : toDirectory;
    const unqualified = fromMissing ? unqualifiedFrom : unqualifiedTo;
    return {
      text: `No indexed symbol found for the ${endpoint} endpoint "${name}"${qualifierText(file, directory)}.${unqualified.length > 0 ? `\nExact-name symbols exist at:\n${formatCandidateList(unqualified)}\nUse one of those locations as ${endpoint}File or ${endpoint}Directory.` : ""}\nCheck the exact name with implementation_lookup or codebase_peek, and run index_status then index_codebase if needed.`,
      details: {
        ...baseDetails,
        resolution: "missing",
        candidates: boundedLocations(unqualified),
        path: [],
      },
    };
  }

  const path = await indexer.findCallPathById(fromCandidates[0].id, toCandidates[0].id, maxDepth);
  return {
    text: formatPath(params.from, params.to, path),
    details: {
      ...baseDetails,
      resolution: path.length > 0 ? "resolved" : "no-path",
      path: path.map((hop) => ({
        symbolName: hop.symbolName,
        filePath: hop.filePath,
        line: hop.line,
        callType: hop.callType,
      })),
    },
  };
}
