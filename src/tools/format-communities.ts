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

/**
 * Compute cross-community connections for each symbol.
 * A cross-community connection is a call edge between two symbols in different communities.
 */
function computeCrossCommunityConnections(
  communities: CommunityData[],
  centrality: CentralityData[],
): Map<string, number> {
  // Map symbolId -> communityId
  const symbolToCommunity = new Map<string, number>();
  for (const c of communities) {
    symbolToCommunity.set(c.symbolId, c.communityId);
  }

  // For each symbol, count how many of its connected symbols are in a different community.
  // We approximate this using caller_count + callee_count as the total edge set,
  // then subtract edges within the same community using the community membership.
  // Since we don't have the raw edges here, we use centrality data: a hub connecting
  // multiple communities has high total_connections relative to its own community size.
  //
  // A simpler and more useful metric: count how many distinct communities a symbol's
  // neighbors belong to. We can derive this from the community assignments and
  // centrality degree, but without the edge list we use a proxy:
  // crossCommunityConnections = total_connections - (community_size - 1)
  // (in-community connections are at most community_size - 1 for a single node).
  // This is a lower bound, which is fine for ranking hub nodes.

  const communitySizes = new Map<number, number>();
  for (const c of communities) {
    communitySizes.set(c.communityId, (communitySizes.get(c.communityId) ?? 0) + 1);
  }

  const result = new Map<string, number>();
  for (const cent of centrality) {
    const commId = symbolToCommunity.get(cent.symbolId);
    if (commId === undefined) {
      result.set(cent.symbolId, cent.totalConnections);
      continue;
    }
    const ownCommunitySize = communitySizes.get(commId) ?? 1;
    // In-community connections are at most (ownCommunitySize - 1) in each direction,
    // so at most 2 * (ownCommunitySize - 1) total (caller + callee).
    const maxInCommunity = 2 * (ownCommunitySize - 1);
    const crossCommunity = Math.max(0, cent.totalConnections - maxInCommunity);
    result.set(cent.symbolId, crossCommunity);
  }

  return result;
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
        .sort((a, b) => a.symbolName.localeCompare(b.symbolName) || a.symbolId.localeCompare(b.symbolId)),
    }))
    .filter((c) => c.symbolCount >= minSize)
    .sort((a, b) => b.symbolCount - a.symbolCount || a.label.localeCompare(b.label))
    .slice(0, limit);

  // Compute cross-community connections for hub detection
  const crossCommunityMap = computeCrossCommunityConnections(communities, centrality);

  // Hub nodes: symbols with cross-community connections >= hubThreshold
  const hubNodes = centrality
    .map((c) => ({
      symbolId: c.symbolId,
      symbolName: c.symbolName,
      filePath: c.filePath,
      callerCount: c.callerCount,
      calleeCount: c.calleeCount,
      totalConnections: c.totalConnections,
      crossCommunityConnections: crossCommunityMap.get(c.symbolId) ?? 0,
    }))
    .filter((h) => h.crossCommunityConnections >= hubThreshold)
    .sort((a, b) =>
      b.crossCommunityConnections - a.crossCommunityConnections
      || b.totalConnections - a.totalConnections
      || a.symbolId.localeCompare(b.symbolId)
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