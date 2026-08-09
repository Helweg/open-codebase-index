#!/usr/bin/env node

import { mkdirSync, readdirSync, rmSync, copyFileSync, lstatSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXCLUDED_DIRS = new Set([
  ".git",
  ".codegraph",
  ".codebase-index",
  ".opencode",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
]);

const EXCLUDED_BENCHMARK_RESULTS = path.join("benchmarks", "results");

export interface CodeGraphResultNode {
  filePath: string;
  startLine: number;
  endLine: number;
  kind: string;
  name: string;
}

export interface CodeGraphResult {
  node: CodeGraphResultNode;
  score: number;
}

export interface IsolatedSourceCopy {
  isolatedRepoPath: string;
  cleanup: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isWithinRoot(repoRoot: string, targetPath: string): string {
  const normalizedRoot = path.resolve(repoRoot);
  const normalizedTarget = path.resolve(normalizedRoot, targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);

  if (relative === "" || relative === ".") {
    return normalizedTarget;
  }

  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.split(path.sep)[0] === ".."
  ) {
    throw new Error(`CodeGraph output path outside isolated repo: ${targetPath}`);
  }

  return normalizedTarget;
}

export function parseCodeGraphOutput(output: string, isolatedRepoPath: string): CodeGraphResult[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Malformed CodeGraph output: expected JSON array");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Malformed CodeGraph output: expected array");
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Malformed CodeGraph output at index ${index}: entry must be object`);
    }

    if (!("node" in entry) || !("score" in entry)) {
      throw new Error(`Malformed CodeGraph output at index ${index}: missing node or score`);
    }

    const { node, score } = entry;
    if (!isRecord(node)) {
      throw new Error(`Malformed CodeGraph output at index ${index}: node must be object`);
    }

    if (typeof node.filePath !== "string" || node.filePath.trim() === "") {
      throw new Error(`Malformed CodeGraph output at index ${index}: node.filePath must be a non-empty string`);
    }

    if (typeof node.kind !== "string" || node.kind.trim() === "") {
      throw new Error(`Malformed CodeGraph output at index ${index}: node.kind must be a non-empty string`);
    }

    if (typeof node.name !== "string" || node.name.trim() === "") {
      throw new Error(`Malformed CodeGraph output at index ${index}: node.name must be a non-empty string`);
    }

    if (!isFiniteInteger(node.startLine) || !isFiniteInteger(node.endLine)) {
      throw new Error(`Malformed CodeGraph output at index ${index}: startLine and endLine must be integers`);
    }

    if (!Number.isFinite(score as number) || typeof score !== "number") {
      throw new Error(`Malformed CodeGraph output at index ${index}: score must be a number`);
    }

    if (node.startLine < 1 || node.endLine < 1 || node.endLine < node.startLine) {
      throw new Error(`Malformed CodeGraph output at index ${index}: invalid line span`);
    }

    return {
      node: {
        filePath: isWithinRoot(isolatedRepoPath, node.filePath),
        startLine: node.startLine,
        endLine: node.endLine,
        kind: node.kind,
        name: node.name,
      },
      score,
    };
  });
}

function isExcludedPath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath).replace(/\\/g, "/");

  if (normalized === "") {
    return false;
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) {
    return true;
  }

  if (normalized === EXCLUDED_BENCHMARK_RESULTS || normalized.startsWith(`${EXCLUDED_BENCHMARK_RESULTS}/`)) {
    return true;
  }

  return segments.some(
    (segment, index) => segment === "benchmarks" && segments[index + 1] === "results",
  );
}

function copySourceTree(sourceRoot: string, sourceDir: string, isolatedRoot: string): void {
  const sourceEntries = readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of sourceEntries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(sourceRoot, sourcePath);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (isExcludedPath(relativePath)) {
      continue;
    }

    const targetPath = path.join(isolatedRoot, relativePath);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copySourceTree(sourceRoot, sourcePath, isolatedRoot);
      continue;
    }

    if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
      continue;
    }
  }
}

function assertSourceDirectory(sourceRepoPath: string): string {
  const normalizedSource = path.resolve(sourceRepoPath);
  const stats = lstatSync(normalizedSource);

  if (!stats.isDirectory()) {
    throw new Error(`Source path is not a directory: ${sourceRepoPath}`);
  }

  return normalizedSource;
}

export function createIsolatedSourceCopy(sourceRepoPath: string): IsolatedSourceCopy {
  const sourceRoot = assertSourceDirectory(sourceRepoPath);
  const isolatedRepoPath = mkdtempSync(path.join(os.tmpdir(), "codegraph-baseline-"));
  const cleanup = (): void => {
    rmSync(isolatedRepoPath, { recursive: true, force: true });
  };

  try {
    copySourceTree(sourceRoot, sourceRoot, isolatedRepoPath);
    return { isolatedRepoPath, cleanup };
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
}

export function withIsolatedSourceCopy<TResult>(
  sourceRepoPath: string,
  callback: (isolatedRepoPath: string) => TResult,
): TResult {
  const { isolatedRepoPath, cleanup } = createIsolatedSourceCopy(sourceRepoPath);
  try {
    return callback(isolatedRepoPath);
  } finally {
    cleanup();
  }
}
