import { existsSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import type { HostMode } from "../config/host.js";
import type { StatusResult } from "../indexer/index.js";

import { resolveProjectIndexPath } from "../config/paths.js";
import { parseConfig } from "../config/schema.js";
import { getCurrentBranch, getCurrentCommit, isGitRepo } from "../git/index.js";
import { Indexer } from "../indexer/index.js";
import { loadRuntimeConfig } from "./config-state.js";
import { createWorkspaceDatabaseSnapshot } from "./workspace-status-snapshot.js";

export const MAX_WORKSPACE_REPOS = 20;

export interface WorkspaceRepoSpec {
  name: string;
  root: string;
}

export interface WorkspaceStatusEntry {
  name: string;
  root: string;
  host: HostMode;
  available: boolean;
  ready: boolean;
  freshness: "not_checked";
  actualBranch: string | null;
  actualHead: string | null;
  indexedBranch: string | null;
  branchMismatch: boolean;
  indexed: boolean;
  chunkCount: number;
  activeChunkCount: number | null;
  mode: "hybrid" | "structural" | null;
  branchReadiness: StatusResult["branchReadiness"] | null;
  compatibility: "compatible" | "incompatible" | "unknown";
  error?: string;
}

export interface WorkspaceStatusResult {
  host: HostMode;
  ready: boolean;
  repositories: WorkspaceStatusEntry[];
}

export interface WorkspaceStatusDeps {
  readStatus?: (root: string, host: HostMode) => Promise<StatusResult>;
}

export function parseWorkspaceRepoSpecs(values: string[], cwd: string): WorkspaceRepoSpec[] {
  if (values.length === 0) throw new Error("workspace status requires at least one --repo NAME=PATH.");
  if (values.length > MAX_WORKSPACE_REPOS) throw new Error(`workspace status accepts at most ${MAX_WORKSPACE_REPOS} repositories.`);

  const names = new Set<string>();
  const roots = new Map<string, string>();
  return values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`Malformed --repo specification: ${value}. Expected NAME=PATH.`);
    }
    const name = value.slice(0, separator).trim();
    const rawRoot = value.slice(separator + 1);
    if (!name || !rawRoot.trim()) throw new Error(`Malformed --repo specification: ${value}. Expected NAME=PATH.`);
    if (names.has(name)) throw new Error(`Duplicate repository name: ${name}.`);
    names.add(name);

    const resolved = path.resolve(cwd, rawRoot);
    let canonical = resolved;
    try {
      canonical = realpathSync(resolved);
    } catch {
      // Preserve the resolved path so missing repositories can be reported per entry.
    }
    const previousName = roots.get(canonical);
    if (previousName) throw new Error(`Repositories ${previousName} and ${name} resolve to the same root: ${canonical}.`);
    roots.set(canonical, name);
    return { name, root: canonical };
  });
}

function safeUnavailableError(error: unknown): string {
  if (error instanceof Error && /provider/i.test(error.message)) return "Embedding provider status is unavailable.";
  return "Index status is unavailable or unreadable.";
}

function compatibilityState(status: StatusResult): WorkspaceStatusEntry["compatibility"] {
  if (!status.compatibility) return "unknown";
  return status.compatibility.compatible ? "compatible" : "incompatible";
}

function isReady(status: StatusResult, branchMismatch: boolean): boolean {
  const branchReady = !status.branchReadiness
    || status.branchReadiness.state === "ready"
    || status.branchReadiness.state === "legacy";
  const chunkCount = status.indexedChunkCount ?? status.vectorCount;
  const compatibilityReady = status.mode === "structural" || status.compatibility?.compatible === true;
  return status.indexed
    && chunkCount > 0
    && compatibilityReady
    && status.failedBatchesCount === 0
    && branchReady
    && !branchMismatch;
}

async function readWorkspaceIndexStatus(root: string, host: HostMode): Promise<StatusResult> {
  const config = parseConfig(loadRuntimeConfig(root, host));
  const baseIndexPath = resolveProjectIndexPath(root, config.scope, host);
  const indexPath = config.indexing.mode === "structural" ? path.join(baseIndexPath, "structural") : baseIndexPath;
  const sourceDatabasePath = path.join(indexPath, "codebase.db");
  const snapshot = existsSync(sourceDatabasePath)
    ? await createWorkspaceDatabaseSnapshot(sourceDatabasePath)
    : null;
  let indexer: Indexer | undefined;
  try {
    indexer = new Indexer(root, config, host, snapshot ? { readOnlyDatabasePath: snapshot.databasePath } : {});
    return await indexer.getStatus();
  } finally {
    try {
      await indexer?.close();
    } finally {
      await snapshot?.close();
    }
  }
}

async function inspectRepository(
  spec: WorkspaceRepoSpec,
  host: HostMode,
  readStatus: NonNullable<WorkspaceStatusDeps["readStatus"]>,
): Promise<WorkspaceStatusEntry> {
  const base = {
    name: spec.name,
    root: spec.root,
    host,
    freshness: "not_checked" as const,
    actualBranch: null,
    actualHead: null,
    indexedBranch: null,
    branchMismatch: false,
    indexed: false,
    chunkCount: 0,
    activeChunkCount: null,
    mode: null,
    branchReadiness: null,
    compatibility: "unknown" as const,
  };
  try {
    if (!statSync(spec.root).isDirectory()) {
      return { ...base, available: false, ready: false, error: "Repository path is not a directory." };
    }
  } catch {
    return { ...base, available: false, ready: false, error: "Repository path is missing or unreadable." };
  }
  if (!isGitRepo(spec.root)) {
    return { ...base, available: false, ready: false, error: "Path is not a readable Git repository." };
  }

  const actualBranch = getCurrentBranch(spec.root);
  const actualHead = getCurrentCommit(spec.root);
  try {
    const status = await readStatus(spec.root, host);
    const indexedBranch = status.currentBranch === "default" ? null : status.currentBranch;
    const branchMismatch = actualBranch !== null && indexedBranch !== null && actualBranch !== indexedBranch;
    return {
      ...base,
      available: true,
      ready: isReady(status, branchMismatch),
      actualBranch,
      actualHead,
      indexedBranch,
      branchMismatch,
      indexed: status.indexed,
      chunkCount: status.indexedChunkCount ?? status.vectorCount,
      activeChunkCount: status.branchReadiness?.activeCatalogChunkCount ?? null,
      mode: status.mode ?? null,
      branchReadiness: status.branchReadiness ?? null,
      compatibility: compatibilityState(status),
    };
  } catch (error) {
    return { ...base, available: false, ready: false, actualBranch, actualHead, error: safeUnavailableError(error) };
  }
}

export async function getWorkspaceStatus(
  repositories: WorkspaceRepoSpec[],
  host: HostMode,
  deps: WorkspaceStatusDeps = {},
): Promise<WorkspaceStatusResult> {
  const readStatus = deps.readStatus ?? readWorkspaceIndexStatus;
  const entries = await Promise.all(repositories.map((repo) => inspectRepository(repo, host, readStatus)));
  return { host, ready: entries.every((entry) => entry.ready), repositories: entries };
}

export function formatWorkspaceStatus(result: WorkspaceStatusResult): string {
  return result.repositories.map((repo) => {
    const lines = [
      `${repo.name}: ${repo.ready ? "ready" : "not ready"}`,
      `  Root: ${repo.root}`,
      `  Checkout: branch=${repo.actualBranch ?? "unknown"} head=${repo.actualHead ?? "unknown"}`,
      "  Freshness: not checked",
    ];
    if (repo.error) {
      lines.push(`  Error: ${repo.error}`);
      return lines.join("\n");
    }
    lines.push(
      `  Index: branch=${repo.indexedBranch ?? "unknown"} storedChunks=${repo.chunkCount.toLocaleString()} activeChunks=${repo.activeChunkCount?.toLocaleString() ?? "unknown"} mode=${repo.mode ?? "unknown"}`,
      `  Branch readiness: ${repo.branchReadiness?.state ?? "unknown"}`,
      `  Compatibility: ${repo.compatibility}`,
    );
    if (repo.branchMismatch) lines.push("  MISMATCH: checkout branch differs from the indexed runtime branch.");
    return lines.join("\n");
  }).join("\n\n");
}
