import type { PrImpactResult } from "../indexer/pr-impact-types.js";

export function formatPrImpact(result: PrImpactResult): string {
  const lines: string[] = [];

  if (result.indexPreparation) {
    const status = result.indexPreparation.prepared ? "prepared automatically" : "already available";
    const commit = result.indexPreparation.commit ? ` at ${result.indexPreparation.commit.slice(0, 12)}` : "";
    lines.push(`→ Branch index: ${status} (${result.indexPreparation.branch}${commit})`);
  }

  lines.push(`→ Files changed: ${result.changedFiles.length}`);
  for (const file of result.changedFiles) {
    lines.push(`  - ${file}`);
  }

  const directCount = result.directSymbols.length;
  const transitiveCount = result.transitiveCallers.length;
  const directionLabel = result.direction === 'callees' ? 'callees' : result.direction === 'both' ? 'reachable (callers + callees)' : 'callers';
  lines.push(
    `\u2192 Symbols affected: ${result.totalAffected} (${directCount} direct, ${transitiveCount} transitive ${directionLabel})`,
  );

  if (directCount > 0) {
    lines.push(
      `  Direct: ${result.directSymbols.map((s) => `${s.name} (${s.kind})`).join(", ")}`,
    );
  }

  if (transitiveCount > 0) {
    lines.push(
      `  Transitive ${directionLabel}: ${result.transitiveCallers.map((s) => s.name).join(", ")}`,
    );
  }
  if (result.communities.length > 0) {
    lines.push(
      `→ Communities touched: ${result.communities.map((c) => c.label).join(", ")}`,
    );
    for (const community of result.communities) {
      lines.push(
        `  - ${community.label}: ${community.symbolCount} symbols`,
      );
    }
  } else {
    lines.push("→ Communities touched: none");
  }

  lines.push(`→ Risk: ${result.riskLevel} — ${result.riskReason}`);
  if (result.hubNodes.length > 0) {
    lines.push("  Hub nodes in change scope:");
    for (const hub of result.hubNodes) {
      lines.push(`    - ${hub.name} (${hub.callerCount} callers) at ${hub.filePath}`);
    }
  }

  if (result.conflictingPRs && result.conflictingPRs.length > 0) {
    const conflictList = result.conflictingPRs.map(
      (c) => `PR #${c.pr} (also touches ${c.overlappingCommunities.join(", ")} community)`,
    );
    lines.push(`→ Potential conflicts with: ${conflictList.join(", ")}`);
  }

  return lines.join("\n");
}
