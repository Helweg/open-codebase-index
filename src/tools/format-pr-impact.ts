import type { PrImpactResult } from "../indexer/pr-impact-types.js";

export function formatPrImpact(result: PrImpactResult): string {
  const lines: string[] = [];

  const workingTree = result.workingTree;
  const partial = workingTree !== undefined
    && (workingTree.unassessed.length > 0 || workingTree.omittedFileCount > 0);
  if (workingTree) {
    lines.push("→ Working-tree impact: union of staged, unstaged, and untracked path changes.");
    lines.push("  Scope: current indexed files; static file-level graph analysis, not changed-line or staged-source analysis.");
    lines.push("  Consistency: bounded before/after checks, not an atomic filesystem snapshot.");
    lines.push(`  HEAD: ${workingTree.headCommit ?? "unborn repository"}`);
    if (workingTree.entries.length === 0 && workingTree.omittedFileCount === 0) {
      lines.push("No working-tree changes.");
      return lines.join("\n");
    }
    lines.push("→ Path provenance (XY: index/worktree status; space means unchanged):");
    for (const entry of workingTree.entries) {
      const origin = entry.previousPath === undefined ? "" : ` (from ${JSON.stringify(entry.previousPath)})`;
      lines.push(`  [${entry.indexStatus}${entry.worktreeStatus}] ${JSON.stringify(entry.path)}${origin}`);
    }
    if (workingTree.unassessed.length > 0) {
      const reasons: Record<(typeof workingTree.unassessed)[number]["reason"], string> = {
        deleted: "deleted; historical declarations not assessed",
        renamed_from: "rename source; historical declarations not assessed",
        not_indexed: "not indexed; source not assessed",
        no_symbols: "no indexed symbols; graph impact unknown",
        outside_project: "outside project; target not read",
        not_regular: "not a regular file; target not assessed",
      };
      lines.push("→ Unassessed paths (coverage unknown):");
      for (const entry of workingTree.unassessed) {
        lines.push(`  - ${JSON.stringify(entry.path)}: ${reasons[entry.reason]}`);
      }
    }
    lines.push(`→ Omitted paths: ${workingTree.omittedFileCount}${workingTree.omittedFileCount > 0 ? " (200-path cap; coverage unknown)" : ""}`);
    if (partial) lines.push("  Graph counts below are partial; missing coverage is not low risk.");
  }
  if (result.indexPreparation) {
    const status = result.indexPreparation.prepared ? "prepared automatically" : "already available";
    const commit = result.indexPreparation.commit ? ` at ${result.indexPreparation.commit.slice(0, 12)}` : "";
    lines.push(`→ Branch index: ${status} (${result.indexPreparation.branch}${commit})`);
  }

  lines.push(`→ Files changed: ${result.changedFiles.length}`);
  for (const file of result.changedFiles) {
    lines.push(`  - ${workingTree ? JSON.stringify(file) : file}`);
  }

  const directCount = result.directSymbols.length;
  const transitiveCount = result.transitiveCallers.length;
  const directionLabel = result.direction === 'callees' ? 'callees' : result.direction === 'both' ? 'reachable (callers + callees)' : 'callers';
  let symbolLabel = "Symbols affected";
  if (workingTree) {
    symbolLabel = partial ? "Current indexed graph symbols affected (partial)" : "Current indexed graph symbols affected";
  }
  lines.push(
    `\u2192 ${symbolLabel}: ${result.totalAffected} (${directCount} direct, ${transitiveCount} transitive ${directionLabel})`,
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

  lines.push(`→ Risk: ${result.riskLevel} — ${result.riskReason}${workingTree ? " (static, file-level current-graph heuristic; not runtime impact)" : ""}`);
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
