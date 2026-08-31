import type { CallGraphCoverage } from "../indexer/call-graph-coverage.js";
import type {
  CentralityData,
  CommunityCouplingData,
  CommunityData,
  SymbolData,
} from "../native/index.js";
import type { VisualizationNode } from "./visualize/types.js";

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { estimateTokens } from "../utils/cost.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";
import { formatCallGraphCoverage } from "../indexer/call-graph-coverage.js";
import { deriveModules } from "./visualize/modules.js";

export const ARCHITECTURE_CONTEXT_DEFAULT_DEPTH = 2;
export const ARCHITECTURE_CONTEXT_MAX_DEPTH = 3;
export const ARCHITECTURE_CONTEXT_DEFAULT_TOKEN_BUDGET = 1200;
export const ARCHITECTURE_CONTEXT_MIN_TOKEN_BUDGET = 128;
export const ARCHITECTURE_CONTEXT_MAX_TOKEN_BUDGET = 4000;

export interface ArchitectureContextInput {
  query?: string | null;
  directory?: string | null;
  depth?: number;
  includeRecentActivity?: boolean;
  tokenBudget?: number;
}

export interface ArchitectureSearchEvidence {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  name?: string;
}

export interface ArchitectureSourceEvidence {
  symbolId: string;
  symbol: string;
  filePath: string;
  line: number;
  excerpt?: string;
}

export interface ArchitectureRecentActivity {
  title: string;
  date: string;
  commit: string;
  summary: string;
  filePaths: string[];
}

export interface ArchitectureContextSources {
  projectRoot?: string;
  sourceSymbols?: SymbolData[];
  focusedSymbols?: SymbolData[];
  graphCoverage?: CallGraphCoverage;
  recentActivity?: ArchitectureRecentActivity[];
}

export interface ArchitectureContextModule {
  id: string;
  label: string;
  symbolCount: number;
  source: "community" | "directory";
  evidence: ArchitectureSourceEvidence[];
}

export interface ArchitectureContextResult {
  modules: ArchitectureContextModule[];
  boundaries: Array<{
    fromModule: string;
    toModule: string;
    connections: number;
    evidence: Array<{
      fromSymbol: string;
      fromFilePath: string;
      toSymbol: string;
      toFilePath: string;
    }>;
  }>;
  hubs: Array<{ symbol: string; filePath: string; connections: number }>;
  recentActivity: ArchitectureRecentActivity[];
  coverage: {
    symbols: number;
    communities: number;
    scoped: boolean;
    graphSparse: boolean;
    sourceFallback: boolean;
    graph?: CallGraphCoverage;
    note: string;
  };
  recommendations: string[];
  tokenBudget: number;
  tokenEstimate: number;
  omitted: { modules: number; boundaries: number; hubs: number; recentActivity: number };
  text: string;
}

interface ArchitectureModuleCandidate extends ArchitectureContextModule {
  communityId?: number;
}

type ArchitectureBoundaryCandidate = ArchitectureContextResult["boundaries"][number] & {
  fromId: string;
  toId: string;
};

function compare(left: string, right: string): number {
  return left.localeCompare(right);
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function displayPath(filePath: string, projectRoot?: string): string {
  const normalizedFilePath = normalizePath(filePath);
  if (!projectRoot) return normalizedFilePath;
  const normalizedRoot = normalizePath(path.resolve(projectRoot));
  if (normalizedFilePath === normalizedRoot) return ".";
  if (normalizedFilePath.startsWith(`${normalizedRoot}/`)) {
    return normalizedFilePath.slice(normalizedRoot.length + 1);
  }
  return normalizedFilePath;
}

export function isArchitecturePathInDirectory(
  filePath: string,
  directory?: string | null,
  projectRoot?: string,
): boolean {
  const requested = normalizePath(directory ?? "");
  if (!requested || requested === ".") return true;

  const candidate = normalizePath(filePath);
  if (candidate === requested || candidate.startsWith(`${requested}/`)) return true;

  if (projectRoot) {
    const absoluteDirectory = normalizePath(path.resolve(projectRoot, requested));
    if (candidate === absoluteDirectory || candidate.startsWith(`${absoluteDirectory}/`)) return true;
  }

  return candidate.endsWith(`/${requested}`) || candidate.includes(`/${requested}/`);
}

function sameFile(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.endsWith(`/${normalizedRight}`)
    || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function spansOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function selectArchitectureFocusedSymbols(
  results: ArchitectureSearchEvidence[],
  symbols: SymbolData[],
  depth = ARCHITECTURE_CONTEXT_DEFAULT_DEPTH,
  signal?: AbortSignal,
): SymbolData[] {
  const normalizedDepth = Math.max(1, Math.min(ARCHITECTURE_CONTEXT_MAX_DEPTH, Math.floor(depth)));
  const topScore = results[0]?.score ?? 0;
  const selected: SymbolData[] = [];
  const selectedIds = new Set<string>();

  for (const [index, result] of results.entries()) {
    throwIfOperationAborted(signal);
    if (index >= normalizedDepth * 3) break;
    if (index >= 2 && topScore > 0 && result.score < topScore * 0.55) continue;

    const fileSymbols = symbols.filter((symbol) => {
      throwIfOperationAborted(signal);
      return sameFile(symbol.filePath, result.filePath);
    });
    const ranked = fileSymbols.slice().sort((left, right) => {
      const leftNameMatch = result.name !== undefined && left.name === result.name ? 1 : 0;
      const rightNameMatch = result.name !== undefined && right.name === result.name ? 1 : 0;
      if (leftNameMatch !== rightNameMatch) return rightNameMatch - leftNameMatch;

      const leftOverlap = spansOverlap(left.startLine, left.endLine, result.startLine, result.endLine) ? 1 : 0;
      const rightOverlap = spansOverlap(right.startLine, right.endLine, result.startLine, result.endLine) ? 1 : 0;
      if (leftOverlap !== rightOverlap) return rightOverlap - leftOverlap;

      const leftDistance = Math.abs(left.startLine - result.startLine);
      const rightDistance = Math.abs(right.startLine - result.startLine);
      return leftDistance - rightDistance
        || (left.endLine - left.startLine) - (right.endLine - right.startLine)
        || compare(left.id, right.id);
    });

    const best = ranked[0];
    if (best && !selectedIds.has(best.id)) {
      selected.push(best);
      selectedIds.add(best.id);
    }
  }

  return selected;
}

function cleanComment(lines: string[]): string | undefined {
  const text = lines
    .map((line) => line.trim()
      .replace(/^\/\*\*?\s?/, "")
      .replace(/^\/\/[/!]?[ ]?/, "")
      .replace(/^#\s?/, "")
      .replace(/^\*\s?/, "")
      .replace(/\*\/$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.startsWith("@")) return undefined;
  return text.slice(0, 220);
}

function leadingComment(lines: string[], startIndex: number): string | undefined {
  const previousIndex = startIndex - 1;
  if (previousIndex < 0 || lines[previousIndex]?.trim() === "") return undefined;
  const previous = lines[previousIndex]?.trim() ?? "";

  if (/^(\/\/[/!]?|#)/.test(previous)) {
    const comments: string[] = [];
    for (let index = previousIndex; index >= Math.max(0, previousIndex - 5); index -= 1) {
      const line = lines[index]?.trim() ?? "";
      if (!/^(\/\/[/!]?|#)/.test(line)) break;
      comments.unshift(line);
    }
    return cleanComment(comments);
  }

  if (previous.endsWith("*/")) {
    const comments: string[] = [];
    for (let index = previousIndex; index >= Math.max(0, previousIndex - 7); index -= 1) {
      const line = lines[index]?.trim() ?? "";
      comments.unshift(line);
      if (line.startsWith("/*")) break;
    }
    if (comments[0]?.startsWith("/*")) return cleanComment(comments);
  }

  return undefined;
}

function declarationExcerpt(lines: string[], symbol: SymbolData): string | undefined {
  const startIndex = Math.max(0, symbol.startLine - 1);
  const declaration = lines
    .slice(startIndex, Math.min(lines.length, startIndex + 3, symbol.endLine))
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!declaration) return undefined;
  const openingBrace = declaration.indexOf("{");
  const concise = openingBrace >= 0 ? declaration.slice(0, openingBrace + 1) : declaration;
  return concise.slice(0, 220);
}

function sourceEvidence(
  symbol: SymbolData,
  projectRoot: string | undefined,
  fileCache: Map<string, string[] | null>,
): ArchitectureSourceEvidence {
  let lines = fileCache.get(symbol.filePath);
  if (lines === undefined) {
    try {
      const sourcePath = projectRoot && !path.isAbsolute(symbol.filePath)
        ? path.resolve(projectRoot, symbol.filePath)
        : symbol.filePath;
      lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
    } catch {
      lines = null;
    }
    fileCache.set(symbol.filePath, lines);
  }

  const startIndex = Math.max(0, symbol.startLine - 1);
  const excerpt = lines
    ? leadingComment(lines, startIndex) ?? declarationExcerpt(lines, symbol)
    : undefined;
  return {
    symbolId: symbol.id,
    symbol: symbol.name,
    filePath: displayPath(symbol.filePath, projectRoot),
    line: symbol.startLine,
    ...(excerpt ? { excerpt } : {}),
  };
}

function evidenceForCommunityMember(
  member: CommunityData,
  symbolById: Map<string, SymbolData>,
  projectRoot: string | undefined,
  fileCache: Map<string, string[] | null>,
): ArchitectureSourceEvidence {
  const symbol = symbolById.get(member.symbolId);
  if (symbol) return sourceEvidence(symbol, projectRoot, fileCache);
  return {
    symbolId: member.symbolId,
    symbol: member.symbolName,
    filePath: displayPath(member.filePath, projectRoot),
    line: 0,
  };
}

function buildCommunityModules(
  communities: CommunityData[],
  focusedSymbols: SymbolData[],
  sourceSymbols: SymbolData[],
  input: ArchitectureContextInput,
  depth: number,
  projectRoot: string | undefined,
  fileCache: Map<string, string[] | null>,
): { modules: ArchitectureModuleCandidate[]; scopedMembers: CommunityData[] } {
  const queryRequested = Boolean(input.query?.trim());
  const focusIds = new Set(focusedSymbols.map((symbol) => symbol.id));
  const focusRanks = new Map(focusedSymbols.map((symbol, index) => [symbol.id, index]));
  const focusedCommunityIds = new Set(
    communities.filter((member) => focusIds.has(member.symbolId)).map((member) => member.communityId),
  );
  const scopedMembers = communities.filter((member) =>
    isArchitecturePathInDirectory(member.filePath, input.directory, projectRoot)
    && (!queryRequested || focusedCommunityIds.has(member.communityId))
  );
  const labels = new Map(communities.map((member) => [member.communityId, member.communityLabel]));
  const symbolById = new Map(sourceSymbols.map((symbol) => [symbol.id, symbol]));
  const byCommunity = new Map<number, CommunityData[]>();
  for (const member of scopedMembers) {
    const members = byCommunity.get(member.communityId) ?? [];
    members.push(member);
    byCommunity.set(member.communityId, members);
  }

  const modules = [...byCommunity.entries()].map(([communityId, members]) => {
    const ordered = members.slice().sort((left, right) => {
      const leftRank = focusRanks.get(left.symbolId) ?? Number.POSITIVE_INFINITY;
      const rightRank = focusRanks.get(right.symbolId) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank
        || right.crossCommunityConnections - left.crossCommunityConnections
        || compare(left.symbolName, right.symbolName)
        || compare(left.symbolId, right.symbolId);
    });
    return {
      id: `community-${communityId}`,
      communityId,
      label: labels.get(communityId) ?? `Community ${communityId}`,
      symbolCount: members.length,
      source: "community" as const,
      evidence: ordered.slice(0, depth + 1).map((member) =>
        evidenceForCommunityMember(member, symbolById, projectRoot, fileCache)
      ),
      focusRank: Math.min(...members.map((member) => focusRanks.get(member.symbolId) ?? Number.POSITIVE_INFINITY)),
    };
  }).sort((left, right) => {
    if (queryRequested && left.focusRank !== right.focusRank) return left.focusRank - right.focusRank;
    return right.symbolCount - left.symbolCount || compare(left.label, right.label) || compare(left.id, right.id);
  }).slice(0, 12).map(({ focusRank: _focusRank, ...module }) => module);

  return { modules, scopedMembers };
}

function buildDirectoryModules(
  sourceSymbols: SymbolData[],
  focusedSymbols: SymbolData[],
  input: ArchitectureContextInput,
  depth: number,
  projectRoot: string | undefined,
  fileCache: Map<string, string[] | null>,
): ArchitectureModuleCandidate[] {
  const queryRequested = Boolean(input.query?.trim());
  const candidates = (queryRequested ? focusedSymbols : sourceSymbols).filter((symbol) =>
    isArchitecturePathInDirectory(symbol.filePath, input.directory, projectRoot)
  );
  const focusRanks = new Map(focusedSymbols.map((symbol, index) => [symbol.id, index]));
  const nodes: VisualizationNode[] = candidates.map((symbol) => ({
    id: symbol.id,
    name: symbol.name,
    filePath: symbol.filePath,
    kind: symbol.kind,
    line: symbol.startLine,
    directory: path.dirname(symbol.filePath),
    moduleId: "",
    moduleLabel: "",
  }));
  const symbolsById = new Map(candidates.map((symbol) => [symbol.id, symbol]));

  return deriveModules(nodes).map((module) => {
    const members = module.symbols
      .map((symbolId) => symbolsById.get(symbolId))
      .filter((symbol): symbol is SymbolData => symbol !== undefined)
      .sort((left, right) => {
        const leftRank = focusRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
        const rightRank = focusRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
        return leftRank - rightRank || compare(left.name, right.name) || compare(left.id, right.id);
      });
    return {
      id: module.id,
      label: module.label,
      symbolCount: members.length,
      source: "directory" as const,
      evidence: members.slice(0, depth + 1).map((symbol) => sourceEvidence(symbol, projectRoot, fileCache)),
      focusRank: Math.min(...members.map((symbol) => focusRanks.get(symbol.id) ?? Number.POSITIVE_INFINITY)),
    };
  }).sort((left, right) => {
    if (queryRequested && left.focusRank !== right.focusRank) return left.focusRank - right.focusRank;
    return right.symbolCount - left.symbolCount || compare(left.label, right.label) || compare(left.id, right.id);
  }).slice(0, 12).map(({ focusRank: _focusRank, ...module }) => module);
}

function sourceCitation(evidence: ArchitectureSourceEvidence): string {
  return evidence.line > 0 ? `${evidence.filePath}:${evidence.line}` : evidence.filePath;
}

function renderArchitectureText(
  input: ArchitectureContextInput,
  modules: ArchitectureContextModule[],
  boundaries: ArchitectureContextResult["boundaries"],
  hubs: ArchitectureContextResult["hubs"],
  recentActivity: ArchitectureRecentActivity[],
  coverage: ArchitectureContextResult["coverage"],
  recommendations: string[],
  recentActivityUnavailable: boolean,
): string {
  const lines = ["→ Architecture context"];
  const minimumBudget = (input.tokenBudget ?? ARCHITECTURE_CONTEXT_DEFAULT_TOKEN_BUDGET) <= 160;
  if (input.query?.trim()) lines.push(`Focus: ${compactText(input.query, minimumBudget ? 32 : 64)}`);
  lines.push(
    `Coverage: ${coverage.symbols} scoped symbols across ${coverage.communities} modules${input.directory ? ` in ${compactText(normalizePath(input.directory), minimumBudget ? 24 : 48)}` : ""}.`,
    `Uncertainty: ${coverage.note}`,
  );

  for (const module of modules) {
    const sourceLabel = module.source === "community" ? "graph community" : "source directory fallback";
    lines.push(`\nModule: ${module.label} (${module.symbolCount} scoped symbols, ${sourceLabel})`);
    const responsibility = module.evidence.find((evidence) => evidence.excerpt);
    if (responsibility?.excerpt) {
      lines.push(`- Source-backed responsibility: ${responsibility.excerpt} [${responsibility.symbol} at ${sourceCitation(responsibility)}]`);
    } else {
      lines.push("- Source-backed responsibility unavailable; no responsibility is inferred.");
    }
    for (const evidence of module.evidence) {
      lines.push(`- Evidence: ${evidence.symbol} (${sourceCitation(evidence)})`);
    }
  }

  if (boundaries.length > 0) {
    lines.push("\nBoundaries:");
    for (const boundary of boundaries) {
      lines.push(`- ${boundary.fromModule} ↔ ${boundary.toModule}: ${boundary.connections} resolved connections`);
      for (const edge of boundary.evidence) {
        lines.push(`  - ${edge.fromSymbol} (${edge.fromFilePath}) -> ${edge.toSymbol} (${edge.toFilePath})`);
      }
    }
  }

  if (hubs.length > 0) {
    lines.push("\nEntry points and hubs:");
    for (const hub of hubs) {
      lines.push(`- ${hub.symbol} (${hub.filePath}), ${hub.connections} graph connections`);
    }
  }

  if (input.includeRecentActivity) {
    lines.push("\nRecent activity:");
    if (recentActivityUnavailable) {
      lines.push("- No matching Git activity was found in the last 90 days.");
    } else {
      for (const activity of recentActivity) {
        const files = activity.filePaths.length > 0 ? ` Files: ${activity.filePaths.join(", ")}.` : "";
        lines.push(`- ${activity.title} [commit ${activity.commit}, ${activity.date}]: ${activity.summary}${files}`);
      }
    }
  }

  lines.push("\nRecommended next steps:", ...recommendations.map((item) => `- ${item}`));
  return lines.join("\n");
}

function recommendationsFor(
  input: ArchitectureContextInput,
  modules: ArchitectureModuleCandidate[],
  graphSparse: boolean,
): string[] {
  const evidence = modules[0]?.evidence[0];
  const maxArgumentLength = (input.tokenBudget ?? ARCHITECTURE_CONTEXT_DEFAULT_TOKEN_BUDGET) <= 160 ? 24 : 160;
  const directory = input.directory?.trim()
    ? compactText(input.directory, maxArgumentLength)
    : undefined;
  const recommendations: string[] = [];
  if (evidence) {
    recommendations.push(`implementation_lookup ${JSON.stringify({
      query: compactText(evidence.symbol, maxArgumentLength),
      directory: compactText(path.posix.dirname(evidence.filePath), maxArgumentLength),
    })}`);
    if (!graphSparse) {
      recommendations.push(`call_graph ${JSON.stringify({
        name: compactText(evidence.symbol, maxArgumentLength),
        filePath: compactText(evidence.filePath, maxArgumentLength),
        direction: "callees",
      })}`);
    }
  }
  recommendations.push(`codebase_context ${JSON.stringify({
    query: compactText(
      input.query?.trim() || (evidence ? `Understand ${evidence.symbol} and its module` : "Locate the repository subsystem to inspect"),
      maxArgumentLength,
    ),
    ...(directory ? { directory } : {}),
    tokenBudget: Math.min(1200, input.tokenBudget ?? ARCHITECTURE_CONTEXT_DEFAULT_TOKEN_BUDGET),
  })}`);
  return recommendations;
}

export function buildArchitectureContext(
  input: ArchitectureContextInput,
  communities: CommunityData[],
  centrality: CentralityData[],
  couplings: CommunityCouplingData[],
  sources: ArchitectureContextSources = {},
): ArchitectureContextResult {
  const depth = Math.max(
    1,
    Math.min(ARCHITECTURE_CONTEXT_MAX_DEPTH, Math.floor(input.depth ?? ARCHITECTURE_CONTEXT_DEFAULT_DEPTH)),
  );
  const tokenBudget = Math.max(
    ARCHITECTURE_CONTEXT_MIN_TOKEN_BUDGET,
    Math.min(
      ARCHITECTURE_CONTEXT_MAX_TOKEN_BUDGET,
      Math.floor(input.tokenBudget ?? ARCHITECTURE_CONTEXT_DEFAULT_TOKEN_BUDGET),
    ),
  );
  const projectRoot = sources.projectRoot;
  const sourceSymbols = sources.sourceSymbols ?? [];
  const focusedSymbols = sources.focusedSymbols ?? [];
  const graphCoverage = sources.graphCoverage;
  const fileCache = new Map<string, string[] | null>();
  const queryRequested = Boolean(input.query?.trim());

  const communityResult = buildCommunityModules(
    communities,
    focusedSymbols,
    sourceSymbols,
    input,
    depth,
    projectRoot,
    fileCache,
  );
  const sourceFallback = communityResult.modules.length === 0
    && (!queryRequested || focusedSymbols.length > 0);
  const moduleCandidates = sourceFallback
    ? buildDirectoryModules(sourceSymbols, focusedSymbols, input, depth, projectRoot, fileCache)
    : communityResult.modules;
  const graphModuleIds = new Map(
    communityResult.modules
      .filter((module) => module.communityId !== undefined)
      .map((module) => [module.communityId as number, module.id]),
  );
  const labels = new Map(communities.map((member) => [member.communityId, member.communityLabel]));
  const selectedCommunityIds = new Set(
    communityResult.modules
      .map((module) => module.communityId)
      .filter((communityId): communityId is number => communityId !== undefined),
  );

  const boundaryCandidates: ArchitectureBoundaryCandidate[] = couplings.flatMap((coupling) => {
    if (!selectedCommunityIds.has(coupling.communityA) || !selectedCommunityIds.has(coupling.communityB)) return [];
    const relationships = (coupling.relationships ?? coupling.representativeRelationships ?? [])
      .filter((edge) =>
        isArchitecturePathInDirectory(edge.fromFilePath, input.directory, projectRoot)
        && isArchitecturePathInDirectory(edge.toFilePath, input.directory, projectRoot)
      )
      .slice()
      .sort((left, right) => compare(left.fromSymbolId, right.fromSymbolId) || compare(left.toSymbolId, right.toSymbolId));
    if (relationships.length === 0) return [];
    return [{
      fromId: graphModuleIds.get(coupling.communityA) ?? `community-${coupling.communityA}`,
      toId: graphModuleIds.get(coupling.communityB) ?? `community-${coupling.communityB}`,
      fromModule: labels.get(coupling.communityA) ?? `Community ${coupling.communityA}`,
      toModule: labels.get(coupling.communityB) ?? `Community ${coupling.communityB}`,
      connections: input.directory ? relationships.length : coupling.count,
      evidence: relationships.slice(0, depth).map((edge) => ({
        fromSymbol: edge.fromSymbolName,
        fromFilePath: displayPath(edge.fromFilePath, projectRoot),
        toSymbol: edge.toSymbolName,
        toFilePath: displayPath(edge.toFilePath, projectRoot),
      })),
    }];
  }).sort((left, right) =>
    right.connections - left.connections
    || compare(left.fromModule, right.fromModule)
    || compare(left.toModule, right.toModule)
  ).slice(0, depth * 2);

  const communityBySymbolId = new Map(communities.map((member) => [member.symbolId, member.communityId]));
  const hubCandidates = centrality
    .filter((item) =>
      isArchitecturePathInDirectory(item.filePath, input.directory, projectRoot)
      && (!queryRequested || selectedCommunityIds.has(communityBySymbolId.get(item.symbolId) ?? -1))
    )
    .slice()
    .sort((left, right) => right.totalConnections - left.totalConnections || compare(left.symbolId, right.symbolId))
    .slice(0, depth * 2)
    .map((item) => ({
      symbol: item.symbolName,
      filePath: displayPath(item.filePath, projectRoot),
      connections: item.totalConnections,
    }));

  const scopedSymbolCount = sourceFallback
    ? (queryRequested ? focusedSymbols : sourceSymbols).filter((symbol) =>
      isArchitecturePathInDirectory(symbol.filePath, input.directory, projectRoot)
    ).length
    : communityResult.scopedMembers.length;
  const graphSparse = sourceFallback || boundaryCandidates.length === 0;
  const resolutionNote = graphCoverage
    ? ` ${formatCallGraphCoverage(graphCoverage)}`
    : "";
  const note = queryRequested && focusedSymbols.length === 0
    ? "No indexed symbols matched the requested query and scope. No global architecture is substituted."
    : moduleCandidates.length === 0
      ? "No graph or readable source symbols matched the requested scope. No architectural relationship is inferred."
      : sourceFallback
        ? `Community graph data was unavailable in this scope. Modules are grouped only by source directory, and no relationship is inferred.${resolutionNote}`
        : graphSparse
          ? `No resolved cross-module coupling was available in this scope. Treat module boundaries as incomplete.${resolutionNote}`
          : `Module relationships are grounded in resolved representative call relationships.${resolutionNote}`;
  const coverage: ArchitectureContextResult["coverage"] = {
    symbols: scopedSymbolCount,
    communities: moduleCandidates.length,
    scoped: Boolean(input.directory || input.query),
    graphSparse,
    sourceFallback,
    graph: graphCoverage,
    note,
  };
  const recommendationCandidates = recommendationsFor(input, moduleCandidates, graphSparse);
  const recentActivityCandidates = (sources.recentActivity ?? []).map((activity) => ({
    ...activity,
    filePaths: activity.filePaths.map((filePath) => displayPath(filePath, projectRoot)),
  }));
  const recentActivityUnavailable = input.includeRecentActivity === true && recentActivityCandidates.length === 0;

  const modules: ArchitectureContextModule[] = [];
  const boundaries: ArchitectureContextResult["boundaries"] = [];
  const hubs: ArchitectureContextResult["hubs"] = [];
  const recentActivity: ArchitectureRecentActivity[] = [];
  const recommendations = [recommendationCandidates[0] ?? "codebase_context with a narrower query or directory"];
  const render = (): string => renderArchitectureText(
    input,
    modules,
    boundaries,
    hubs,
    recentActivity,
    coverage,
    recommendations,
    recentActivityUnavailable,
  );
  const fits = (): boolean => estimateTokens(render()) <= tokenBudget;

  for (const candidate of moduleCandidates) {
    const selected: ArchitectureContextModule = { ...candidate, evidence: [] };
    modules.push(selected);
    for (const evidence of candidate.evidence) {
      selected.evidence.push(evidence);
      if (!fits()) selected.evidence.pop();
    }
    if (selected.evidence.length === 0 || !fits()) modules.pop();
  }

  const renderedModuleIds = new Set(modules.map((module) => module.id));
  for (const candidate of boundaryCandidates) {
    if (!renderedModuleIds.has(candidate.fromId) || !renderedModuleIds.has(candidate.toId)) continue;
    const boundary: ArchitectureContextResult["boundaries"][number] = {
      fromModule: candidate.fromModule,
      toModule: candidate.toModule,
      connections: candidate.connections,
      evidence: candidate.evidence,
    };
    boundaries.push(boundary);
    if (!fits()) boundaries.pop();
  }
  for (const hub of hubCandidates) {
    hubs.push(hub);
    if (!fits()) hubs.pop();
  }
  for (const activity of recentActivityCandidates) {
    recentActivity.push(activity);
    if (!fits()) recentActivity.pop();
  }
  for (const recommendation of recommendationCandidates.slice(1)) {
    recommendations.push(recommendation);
    if (!fits()) recommendations.pop();
  }

  const text = render();
  return {
    modules,
    boundaries,
    hubs,
    recentActivity,
    coverage,
    recommendations,
    tokenBudget,
    tokenEstimate: estimateTokens(text),
    omitted: {
      modules: moduleCandidates.length - modules.length,
      boundaries: boundaryCandidates.length - boundaries.length,
      hubs: hubCandidates.length - hubs.length,
      recentActivity: recentActivityCandidates.length - recentActivity.length,
    },
    text,
  };
}
