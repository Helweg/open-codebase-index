import { execFileSync } from "child_process";
import * as path from "path";

import type { VisualizationChange, VisualizationData, VisualizationNode } from "./types.js";
import { runGitRaw } from "../../git/branch-resolution.js";
import { isOperationInterruption, throwIfOperationAborted } from "../../utils/operation-control.js";

interface FileActivity {
  churn: number;
  commits: number;
  latestDate: string;
  latestHash: string;
  latestSubject: string;
}

interface ModuleActivity {
  moduleId: string;
  filePaths: Set<string>;
  churn: number;
  commits: number;
  latestDate: string;
  latestHash: string;
  latestSubject: string;
}

export function attachRecentActivity(data: VisualizationData, projectRoot: string): VisualizationData {
  const gitChanges = getRecentGitActivity(data, projectRoot);
  const changes = gitChanges.length > 0 ? gitChanges : buildGraphChanges(data);

  return {
    ...data,
    changes,
  };
}

export function getRecentGitActivity(data: VisualizationData, projectRoot: string): VisualizationChange[] {
  const activity = readGitActivity(projectRoot);
  return activity.size > 0 ? buildGitChanges(data, activity, projectRoot) : [];
}

export async function getRecentGitActivityAbortable(
  data: VisualizationData,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<VisualizationChange[]> {
  const activity = await readGitActivityAbortable(projectRoot, signal);
  return activity.size > 0 ? buildGitChanges(data, activity, projectRoot) : [];
}

function readGitActivity(projectRoot: string): Map<string, FileActivity> {
  try {
    const output = execFileSync(
      "git",
      ["-C", projectRoot, "log", "--since=90.days", "--numstat", "--date=short", "--pretty=format:__COMMIT__%x09%h%x09%ad%x09%s"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseGitActivity(output);
  } catch {
    return new Map();
  }
}

async function readGitActivityAbortable(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<Map<string, FileActivity>> {
  throwIfOperationAborted(signal);
  try {
    const output = await runGitRaw(projectRoot, [
      "log",
      "--since=90.days",
      "--numstat",
      "--date=short",
      "--pretty=format:__COMMIT__%x09%h%x09%ad%x09%s",
    ], { signal });
    throwIfOperationAborted(signal);
    return parseGitActivity(output);
  } catch (error) {
    if (isOperationInterruption(error)) throw error;
    throwIfOperationAborted(signal);
    return new Map();
  }
}

function parseGitActivity(output: string): Map<string, FileActivity> {
  const activity = new Map<string, FileActivity>();
  let latestHash = "";
  let latestDate = "";
  let latestSubject = "";

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("__COMMIT__\t")) {
      const [, hash = "", date = "", subject = ""] = line.split("\t");
      latestHash = hash;
      latestDate = date;
      latestSubject = subject;
      continue;
    }

    const [addedRaw, deletedRaw, filePath] = line.split("\t");
    if (!filePath || addedRaw === "-" || deletedRaw === "-") continue;

    const churn = Number(addedRaw) + Number(deletedRaw);
    if (!Number.isFinite(churn) || churn <= 0) continue;

    const normalizedPath = normalizePath(filePath);
    const previous = activity.get(normalizedPath);
    activity.set(normalizedPath, {
      churn: (previous?.churn ?? 0) + churn,
      commits: (previous?.commits ?? 0) + 1,
      latestDate: previous?.latestDate ?? latestDate,
      latestHash: previous?.latestHash ?? latestHash,
      latestSubject: previous?.latestSubject ?? latestSubject,
    });
  }

  return activity;
}

function buildGitChanges(data: VisualizationData, activity: Map<string, FileActivity>, projectRoot: string): VisualizationChange[] {
  const byModule = new Map<string, ModuleActivity>();

  for (const node of data.nodes) {
    const fileActivity = activity.get(toGitRelativePath(projectRoot, node.filePath));
    if (!fileActivity) continue;

    const current = byModule.get(node.moduleId) ?? {
      moduleId: node.moduleId,
      filePaths: new Set<string>(),
      churn: 0,
      commits: 0,
      latestDate: fileActivity.latestDate,
      latestHash: fileActivity.latestHash,
      latestSubject: fileActivity.latestSubject,
    };
    if (!current.filePaths.has(node.filePath)) {
      current.filePaths.add(node.filePath);
      current.churn += fileActivity.churn;
      current.commits += fileActivity.commits;
    }
    if (fileActivity.latestDate > current.latestDate) {
      current.latestDate = fileActivity.latestDate;
      current.latestHash = fileActivity.latestHash;
      current.latestSubject = fileActivity.latestSubject;
    }
    byModule.set(node.moduleId, current);
  }

  return [...byModule.values()]
    .sort((a, b) => scoreModule(data, b.moduleId, b.churn) - scoreModule(data, a.moduleId, a.churn))
    .slice(0, 12)
    .map((item, index) => toGitChange(data, item, index));
}

function buildGraphChanges(data: VisualizationData): VisualizationChange[] {
  return data.modules
    .map((module) => {
      const calls = moduleCallCount(data, module.id);
      const focusNode = strongestNode(data, module.id);
      const risk = riskFor(calls, module.symbolCount);
      return {
        id: `graph-${module.id}`,
        title: `${module.label} is structurally important`,
        kind: risk === "high" ? "risk" : "hot",
        when: "graph-derived",
        source: "call graph",
        intent: "load-bearing path",
        summary: `${module.symbolCount} symbols with ${calls} cross-module calls in this slice.`,
        why: "No recent Git history was available, so this highlights modules whose call relationships make them expensive to misunderstand during onboarding.",
        calls,
        churn: 0,
        risk,
        moduleId: module.id,
        focusNodeId: focusNode?.id,
        filePaths: [...new Set(data.nodes.filter((node) => node.moduleId === module.id).map((node) => node.filePath))].slice(0, 6),
      } satisfies VisualizationChange;
    })
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 8);
}

function toGitChange(data: VisualizationData, item: ModuleActivity, index: number): VisualizationChange {
  const module = data.modules.find((candidate) => candidate.id === item.moduleId);
  const label = module?.label ?? item.moduleId;
  const calls = moduleCallCount(data, item.moduleId);
  const focusNode = strongestNode(data, item.moduleId);
  const risk = riskFor(calls, item.churn);
  const intent = inferIntent(item.latestSubject);

  return {
    id: `git-${item.moduleId}-${index}`,
    title: `${label} moved recently`,
    kind: risk === "high" ? "risk" : "hot",
    when: item.latestDate || "recently",
    source: item.latestHash ? `commit ${item.latestHash}` : "git history",
    intent,
    summary: `${item.churn} changed lines across ${item.filePaths.size} indexed files. Latest: ${item.latestSubject || "no commit subject"}.`,
    why: `${label} is both changing and connected to ${calls} call edges. Start here to understand whether the current graph is new work, load-bearing behavior, or legacy surface area.`,
    calls,
    churn: item.churn,
    risk,
    moduleId: item.moduleId,
    focusNodeId: focusNode?.id,
    filePaths: [...item.filePaths].slice(0, 8),
  };
}

function scoreModule(data: VisualizationData, moduleId: string, churn: number): number {
  return churn + moduleCallCount(data, moduleId) * 4;
}

function moduleCallCount(data: VisualizationData, moduleId: string): number {
  const moduleEdgeCount = data.moduleEdges
    .filter((edge) => edge.source === moduleId || edge.target === moduleId)
    .reduce((total, edge) => total + edge.weight, 0);
  if (moduleEdgeCount > 0) return moduleEdgeCount;

  const nodeModules = new Map(data.nodes.map((node) => [node.id, node.moduleId]));
  return data.edges.filter((edge) => nodeModules.get(edge.source) === moduleId || nodeModules.get(edge.target) === moduleId).length;
}

function strongestNode(data: VisualizationData, moduleId: string): VisualizationNode | undefined {
  const degree = new Map<string, number>();
  for (const edge of data.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  return data.nodes
    .filter((node) => node.moduleId === moduleId)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))[0];
}

function riskFor(calls: number, churnOrSymbols: number): "low" | "medium" | "high" {
  if (calls >= 20 || churnOrSymbols >= 250) return "high";
  if (calls >= 8 || churnOrSymbols >= 80) return "medium";
  return "low";
}

function inferIntent(subject: string): string {
  const normalized = subject.toLowerCase();
  if (normalized.includes("fix")) return "stability";
  if (normalized.includes("test")) return "verification";
  if (normalized.includes("refactor")) return "refactor";
  if (normalized.includes("visual")) return "visualization";
  if (normalized.includes("call") || normalized.includes("graph")) return "call graph";
  if (normalized.includes("config")) return "configuration";
  return "recent work";
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function toGitRelativePath(projectRoot: string, filePath: string): string {
  const relativePath = path.isAbsolute(filePath) ? path.relative(projectRoot, filePath) : filePath;
  return normalizePath(relativePath);
}
