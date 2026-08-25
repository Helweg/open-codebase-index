import type { CentralityData, CommunityCouplingData, CommunityData, SymbolData } from "../native/index.js";

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

export interface ArchitectureContextResult {
  modules: Array<{ id: number; label: string; symbolCount: number; evidence: Array<{ symbol: string; filePath: string }> }>;
  boundaries: Array<{ fromModule: string; toModule: string; connections: number; evidence: Array<{ fromSymbol: string; fromFilePath: string; toSymbol: string; toFilePath: string }> }>;
  hubs: Array<{ symbol: string; filePath: string; connections: number }>;
  coverage: { symbols: number; communities: number; scoped: boolean; graphSparse: boolean; note: string };
  recommendations: string[];
  text: string;
}

function compare(left: string, right: string): number { return left.localeCompare(right); }
function inDirectory(filePath: string, directory?: string): boolean {
  if (!directory) return true;
  const normalized = directory.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const candidate = filePath.replace(/\\/g, "/");
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

export function buildArchitectureContext(
  input: ArchitectureContextInput,
  communities: CommunityData[],
  centrality: CentralityData[],
  couplings: CommunityCouplingData[],
  focusedSymbols: SymbolData[] = [],
): ArchitectureContextResult {
  const depth = Math.max(1, Math.min(ARCHITECTURE_CONTEXT_MAX_DEPTH, Math.floor(input.depth ?? ARCHITECTURE_CONTEXT_DEFAULT_DEPTH)));
  const focusIds = new Set(focusedSymbols.map((symbol) => symbol.id));
  const hasFocus = focusIds.size > 0;
  const scopedMembers = communities.filter((member) => inDirectory(member.filePath, input.directory ?? undefined) && (!hasFocus || focusIds.has(member.symbolId)));
  const labels = new Map(communities.map((member) => [member.communityId, member.communityLabel]));
  const byCommunity = new Map<number, CommunityData[]>();
  for (const member of scopedMembers) {
    const list = byCommunity.get(member.communityId) ?? [];
    list.push(member);
    byCommunity.set(member.communityId, list);
  }
  const moduleLimit = Math.max(1, Math.min(12, Math.floor((input.tokenBudget ?? ARCHITECTURE_CONTEXT_DEFAULT_TOKEN_BUDGET) / 180)));
  const modules = [...byCommunity.entries()]
    .map(([id, members]) => ({
      id,
      label: labels.get(id) ?? `Community ${id}`,
      symbolCount: members.length,
      evidence: members.slice().sort((a, b) => compare(a.symbolName, b.symbolName) || compare(a.symbolId, b.symbolId)).slice(0, depth + 1).map((member) => ({ symbol: member.symbolName, filePath: member.filePath })),
    }))
    .sort((a, b) => b.symbolCount - a.symbolCount || compare(a.label, b.label) || a.id - b.id)
    .slice(0, moduleLimit);
  const selectedIds = new Set(modules.map((module) => module.id));
  const boundaries = couplings
    .filter((coupling) => selectedIds.has(coupling.communityA) && selectedIds.has(coupling.communityB))
    .map((coupling) => ({
      fromModule: labels.get(coupling.communityA) ?? `Community ${coupling.communityA}`,
      toModule: labels.get(coupling.communityB) ?? `Community ${coupling.communityB}`,
      connections: coupling.count,
      evidence: (coupling.relationships ?? coupling.representativeRelationships ?? []).slice().sort((a, b) => compare(a.fromSymbolId, b.fromSymbolId) || compare(a.toSymbolId, b.toSymbolId)).slice(0, depth).map((edge) => ({ fromSymbol: edge.fromSymbolName, fromFilePath: edge.fromFilePath, toSymbol: edge.toSymbolName, toFilePath: edge.toFilePath })),
    }))
    .sort((a, b) => b.connections - a.connections || compare(a.fromModule, b.fromModule) || compare(a.toModule, b.toModule))
    .slice(0, depth * 2);
  const hubs = centrality
    .filter((item) => inDirectory(item.filePath, input.directory ?? undefined) && (!hasFocus || focusIds.has(item.symbolId)))
    .slice().sort((a, b) => b.totalConnections - a.totalConnections || compare(a.symbolId, b.symbolId))
    .slice(0, depth * 2)
    .map((item) => ({ symbol: item.symbolName, filePath: item.filePath, connections: item.totalConnections }));
  const graphSparse = scopedMembers.length === 0 || boundaries.length === 0;
  const note = scopedMembers.length === 0
    ? "No graph symbols matched the requested scope. No architectural relationship is inferred."
    : graphSparse
      ? "No resolved cross-module coupling was available in this scope. Treat module boundaries as incomplete."
      : "Module relationships are grounded in resolved representative call relationships.";
  const recommendations = modules[0]?.evidence[0]
    ? [`implementation_lookup for ${modules[0].evidence[0].symbol} in ${modules[0].evidence[0].filePath}`, `call_graph for ${modules[0].evidence[0].symbol}`]
    : ["codebase_context with a narrower query or directory"];
  const lines = ["→ Architecture context", `Coverage: ${scopedMembers.length} graph symbols across ${byCommunity.size} communities${input.directory ? ` in ${input.directory}` : ""}.`, `Uncertainty: ${note}`];
  for (const module of modules) {
    lines.push(`\nModule: ${module.label} (${module.symbolCount} scoped symbols)`);
    for (const evidence of module.evidence) lines.push(`- ${evidence.symbol} (${evidence.filePath})`);
  }
  if (boundaries.length > 0) {
    lines.push("\nBoundaries:");
    for (const boundary of boundaries) {
      lines.push(`- ${boundary.fromModule} ↔ ${boundary.toModule}: ${boundary.connections} connections`);
      for (const edge of boundary.evidence) lines.push(`  - ${edge.fromSymbol} (${edge.fromFilePath}) -> ${edge.toSymbol} (${edge.toFilePath})`);
    }
  }
  if (hubs.length > 0) {
    lines.push("\nEntry points and hubs:");
    for (const hub of hubs) lines.push(`- ${hub.symbol} (${hub.filePath}), ${hub.connections} graph connections`);
  }
  lines.push("\nRecommended next steps:", ...recommendations.map((item) => `- ${item}`));
  return { modules, boundaries, hubs, coverage: { symbols: scopedMembers.length, communities: byCommunity.size, scoped: Boolean(input.directory || input.query), graphSparse, note }, recommendations, text: lines.join("\n") };
}
