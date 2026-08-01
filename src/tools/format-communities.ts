import type {
  CentralityData,
  CommunityCouplingData,
  CommunityData,
  CommunityRelationshipData,
} from "../native/index.js";

export interface CodeCommunitiesResult {
  communities: Array<{
    id: number;
    label: string;
    symbolCount: number;
    members: Array<{
      symbolId: string;
      symbolName: string;
      filePath: string;
    }>;
  }>;
  hubNodes: Array<{
    symbolId: string;
    symbolName: string;
    filePath: string;
    callerCount: number;
    calleeCount: number;
    totalConnections: number;
    crossCommunityConnections: number;
  }>;
  totalSymbols: number;
  totalCommunities: number;
  couplings: Array<{
    communityA: number;
    communityB: number;
    communityAName: string;
    communityBName: string;
    distinctConnections: number;
    representativeRelationships: CommunityRelationshipData[];
  }>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildCodeCommunitiesResult(
  communities: CommunityData[],
  centrality: CentralityData[],
  couplings: CommunityCouplingData[] = [],
  options: {
    minSize?: number;
    limit?: number;
    hubThreshold?: number;
    minCoupling?: number;
    couplingLimit?: number;
  } = {},
): CodeCommunitiesResult {
  const minSize = options.minSize ?? 1;
  const limit = options.limit ?? 20;
  const hubThreshold = options.hubThreshold ?? 5;

  const minCoupling = options.minCoupling ?? 1;
  const couplingLimit = options.couplingLimit ?? 20;

  // Group community members
  const communityMap = new Map<number, { label: string; members: CommunityData[] }>();
  for (const c of communities) {
    let entry = communityMap.get(c.communityId);
    if (!entry) {
      entry = { label: c.communityLabel, members: [] };
      communityMap.set(c.communityId, entry);
    }
    entry.members.push(c);
  }

  // Filter by min size, sort by size descending, limit
  const sortedCommunities = Array.from(communityMap.entries())
    .map(([id, entry]) => ({
      id,
      label: entry.label,
      symbolCount: entry.members.length,
      members: entry.members
        .map((m) => ({
          symbolId: m.symbolId,
          symbolName: m.symbolName,
          filePath: m.filePath,
        }))
        .sort((a, b) => compareText(a.symbolName, b.symbolName) || compareText(a.symbolId, b.symbolId)),
    }))
    .filter((c) => c.symbolCount >= minSize)
    .sort((a, b) => b.symbolCount - a.symbolCount || compareText(a.label, b.label) || a.id - b.id)
    .slice(0, limit);

  const communityBySymbol = new Map(communities.map((community) => [community.symbolId, community]));
  const communityLabelById = new Map<number, string>(communities.map((community) => [community.communityId, community.communityLabel]));

  // Hub nodes: symbols with cross-community connections >= hubThreshold
  const hubNodes = centrality
    .map((c) => ({
      symbolId: c.symbolId,
      symbolName: c.symbolName,
      filePath: c.filePath,
      callerCount: c.callerCount,
      calleeCount: c.calleeCount,
      totalConnections: c.totalConnections,
      crossCommunityConnections: communityBySymbol.get(c.symbolId)?.crossCommunityConnections ?? 0,
    }))
    .filter((h) => h.crossCommunityConnections >= hubThreshold)
    .sort((a, b) =>
      b.crossCommunityConnections - a.crossCommunityConnections
      || b.totalConnections - a.totalConnections
      || compareText(a.symbolId, b.symbolId)
    )
    .slice(0, limit);

  const canonicalCoupling = (value: number): number => Math.trunc(value);

  const couplingItems = couplings
    .map((entry) => {
      const relationships = entry.relationships ?? entry.representativeRelationships ?? [];
      const normalizedRelationships = relationships
        .map((relationship) => ({
          fromSymbolId: relationship.fromSymbolId,
          fromSymbolName: relationship.fromSymbolName,
          fromFilePath: relationship.fromFilePath,
          toSymbolId: relationship.toSymbolId,
          toSymbolName: relationship.toSymbolName,
          toFilePath: relationship.toFilePath,
        }))
        .sort((left, right) =>
          compareText(left.fromSymbolName, right.fromSymbolName)
            || compareText(left.fromSymbolId, right.fromSymbolId)
            || compareText(left.toSymbolName, right.toSymbolName)
            || compareText(left.toSymbolId, right.toSymbolId)
            || compareText(left.fromFilePath, right.fromFilePath)
            || compareText(left.toFilePath, right.toFilePath)
        )
        .slice(0, 5);

      const communityA = canonicalCoupling(Math.min(entry.communityA, entry.communityB));
      const communityB = canonicalCoupling(Math.max(entry.communityA, entry.communityB));
      return {
        communityA,
        communityB,
        communityAName: communityLabelById.get(communityA) ?? `Community ${communityA}`,
        communityBName: communityLabelById.get(communityB) ?? `Community ${communityB}`,
        distinctConnections: canonicalCoupling(entry.count),
        representativeRelationships: normalizedRelationships,
      };
    })
    .filter((entry) => entry.distinctConnections >= minCoupling)
    .sort((left, right) =>
      right.distinctConnections - left.distinctConnections
      || compareText(left.communityAName, right.communityAName)
      || compareText(left.communityBName, right.communityBName)
      || compareText(left.communityAName + left.communityBName, right.communityAName + right.communityBName)
      || left.communityA - right.communityA
      || left.communityB - right.communityB
    )
    .slice(0, Math.max(1, Math.floor(couplingLimit)));

  return {
    communities: sortedCommunities,
    hubNodes,
    totalSymbols: communities.length,
    totalCommunities: communityMap.size,
    couplings: couplingItems,
  };
}

export function formatCodeCommunities(result: CodeCommunitiesResult): string {
  const lines: string[] = [];

  lines.push(`→ Communities: ${result.totalCommunities} (${result.communities.length} shown, ${result.totalSymbols} symbols total)`);

  for (const community of result.communities) {
    lines.push(`  Community ${community.id} (${community.label}): ${community.symbolCount} symbols`);
    // Show top members (up to 8 for compactness)
    const shownMembers = community.members.slice(0, 8);
    for (const m of shownMembers) {
      lines.push(`    - ${m.symbolName} (${m.filePath})`);
    }
    if (community.members.length > 8) {
      lines.push(`    ... and ${community.members.length - 8} more`);
    }
  }

  if (result.hubNodes.length > 0) {
    lines.push(`→ Hub nodes (${result.hubNodes.length} shown, cross-community connections):`);
    for (const hub of result.hubNodes) {
      lines.push(
        `  - ${hub.symbolName} (${hub.crossCommunityConnections} cross-community, ${hub.callerCount} callers, ${hub.calleeCount} callees) at ${hub.filePath}`,
      );
    }
  } else {
    lines.push("→ Hub nodes: none with significant cross-community connections");
  }

  if (result.couplings.length > 0) {
    lines.push(`→ Community couplings: ${result.couplings.length} shown`);
    for (const coupling of result.couplings) {
      lines.push(`  - ${coupling.communityAName} ↔ ${coupling.communityBName}: ${coupling.distinctConnections} distinct connections`);
      for (const relationship of coupling.representativeRelationships) {
        lines.push(`    - ${relationship.fromSymbolName} (${relationship.fromFilePath}) -> ${relationship.toSymbolName} (${relationship.toFilePath})`);
      }
    }
  } else {
    lines.push("→ Community couplings: none above minCoupling threshold");
  }

  return lines.join("\n");
}
