import type { CommunityData, CentralityData } from "../native/index.js";

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
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildCodeCommunitiesResult(
  communities: CommunityData[],
  centrality: CentralityData[],
  options: { minSize?: number; limit?: number; hubThreshold?: number } = {},
): CodeCommunitiesResult {
  const minSize = options.minSize ?? 1;
  const limit = options.limit ?? 20;
  const hubThreshold = options.hubThreshold ?? 5;

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

  return {
    communities: sortedCommunities,
    hubNodes,
    totalSymbols: communities.length,
    totalCommunities: communityMap.size,
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

  return lines.join("\n");
}
