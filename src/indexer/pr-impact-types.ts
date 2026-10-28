import type { WorkingTreeChanges } from "../tools/changed-files.js";

export interface PrImpactResult {
  indexPreparation?: {
    prepared: boolean;
    branch: string;
    commit?: string;
    source?: "local" | "remote-fetch" | "pull-ref" | "gh";
  };
  workingTree?: {
    headCommit: string | null;
    scope: "current_indexed_files";
    entries: WorkingTreeChanges["entries"];
    omittedFileCount: number;
    unassessed: Array<{
      path: string;
      reason: "deleted" | "renamed_from" | "not_indexed" | "no_symbols" | "outside_project" | "not_regular";
    }>;
  };
  changedFiles: string[];
  directSymbols: Array<{
    id: string;
    name: string;
    kind: string;
    filePath: string;
  }>;
  transitiveCallers: Array<{
    id: string;
    name: string;
    filePath: string;
    depth: number;
  }>;
  totalAffected: number;
  communities: Array<{
    label: string;
    symbolCount: number;
    directSymbols: string[];
  }>;
  hubNodes: Array<{
    id: string;
    name: string;
    callerCount: number;
    filePath: string;
  }>;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  riskReason: string;
  conflictingPRs?: Array<{
    pr: number;
    branch: string;
    overlappingCommunities: string[];
  }>;
  direction?: "callers" | "callees" | "both";
}
