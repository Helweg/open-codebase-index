import * as path from "node:path";

import { isJavaScriptFamilyFilePath } from "./local-module-resolution.js";

const VERSION = 1;

export type PackageFormat = "module" | "commonjs" | "unknown";

export interface JavaScriptGraphDependency {
  hash: string;
  imports: string[];
  reexports: string[];
  format?: PackageFormat;
}

/** Reuse only a complete snapshot of the file hashes that backed the published graph. */
export function readJavaScriptGraphDependencies(
  raw: string | null,
  configHash: string,
  previousHashes: ReadonlyMap<string, string>,
): Map<string, JavaScriptGraphDependency> | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== VERSION
    || value[1] !== configHash || !Array.isArray(value[2])) {
    return undefined;
  }
  const rows = new Map<string, JavaScriptGraphDependency>();
  for (const entry of value[2]) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [file, row]: [unknown, unknown] = [entry[0], entry[1]];
    if (typeof file !== "string" || !isJavaScriptFamilyFilePath(file) || rows.has(file)
      || !isDependency(row) || previousHashes.get(file) !== row.hash) return undefined;
    rows.set(file, row);
  }
  for (const file of previousHashes.keys()) {
    if (isJavaScriptFamilyFilePath(file) && !rows.has(file)) return undefined;
  }
  return rows;
}

function isDependency(row: unknown): row is JavaScriptGraphDependency {
  return typeof row === "object" && row !== null
    && "hash" in row && typeof row.hash === "string"
    && "imports" in row && isPathList(row.imports)
    && "reexports" in row && isPathList(row.reexports)
    && (!("format" in row) || row.format === "module" || row.format === "commonjs" || row.format === "unknown");
}

function isPathList(paths: unknown): paths is string[] {
  return Array.isArray(paths) && paths.every((file) => typeof file === "string" && file.length > 0);
}

export function writeJavaScriptGraphDependencies(
  configHash: string,
  rows: ReadonlyMap<string, JavaScriptGraphDependency>,
): string {
  return JSON.stringify([VERSION, configHash, [...rows]]);
}

/** A source edit propagates through re-export chains; an import alone doesn't change its owner's exports. */
export function affectedJavaScriptGraphFiles(
  changed: ReadonlySet<string>,
  rows: ReadonlyMap<string, JavaScriptGraphDependency>,
): Set<string> {
  const importers = new Map<string, string[]>();
  const exporters = new Map<string, string[]>();
  for (const [file, row] of rows) {
    addDependents(importers, row.imports, file);
    addDependents(exporters, row.reexports, file);
  }
  const affected = new Set(changed);
  const changedExports = new Set([...changed].map(normalizeJavaScriptGraphPath));
  for (const probe of changedExports) {
    for (const importer of importers.get(probe) ?? []) affected.add(importer);
    for (const exporter of exporters.get(probe) ?? []) {
      affected.add(exporter);
      changedExports.add(normalizeJavaScriptGraphPath(exporter));
    }
  }
  return affected;
}

function addDependents(reverse: Map<string, string[]>, probes: string[], file: string): void {
  for (const probe of probes) {
    const users = reverse.get(probe);
    if (users) users.push(file);
    else reverse.set(probe, [file]);
  }
}

function normalizeJavaScriptGraphPath(file: string): string {
  return path.posix.normalize(file.replaceAll("\\", "/"));
}
