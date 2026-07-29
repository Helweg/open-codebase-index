import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { caseFold } from "unicode-case-folding";

export interface CanonicalPathComparisonOptions {
  isCaseInsensitive?: (existingAncestor: string) => boolean | undefined;
}

function alternateAsciiCase(value: string): string | null {
  const index = value.search(/[A-Za-z]/);
  if (index === -1) return null;

  const character = value[index];
  const alternate = character === character.toLowerCase()
    ? character.toUpperCase()
    : character.toLowerCase();
  return `${value.slice(0, index)}${alternate}${value.slice(index + 1)}`;
}

function probeEntryCaseSensitivity(entryPath: string): boolean | undefined {
  const alternateName = alternateAsciiCase(path.basename(entryPath));
  if (!alternateName) return undefined;

  try {
    const canonicalPath = fs.realpathSync.native(entryPath);
    const alternatePath = fs.realpathSync.native(path.join(path.dirname(entryPath), alternateName));
    return canonicalPath === alternatePath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return undefined;
  }
}

function probeEmptyWindowsDirectory(existingAncestor: string): boolean | undefined {
  const probePath = path.join(
    existingAncestor,
    `.codebase-index-case-probe-${crypto.randomBytes(8).toString("hex")}`,
  );
  let created = false;

  try {
    const descriptor = fs.openSync(probePath, "wx", 0o600);
    created = true;
    fs.closeSync(descriptor);
    return probeEntryCaseSensitivity(probePath);
  } catch {
    return undefined;
  } finally {
    if (created) fs.unlinkSync(probePath);
  }
}

function detectCaseInsensitiveFileSystem(existingAncestor: string): boolean | undefined {
  try {
    if (fs.statSync(existingAncestor).isDirectory()) {
      const directory = fs.opendirSync(existingAncestor);
      try {
        let entry = directory.readSync();
        while (entry) {
          if (!entry.isSymbolicLink() && alternateAsciiCase(entry.name)) {
            const result = probeEntryCaseSensitivity(path.join(existingAncestor, entry.name));
            if (result !== undefined) return result;
          }
          entry = directory.readSync();
        }
      } finally {
        directory.closeSync();
      }
    }
  } catch {
    return undefined;
  }

  if (process.platform === "darwin") {
    return probeEntryCaseSensitivity(existingAncestor);
  }

  if (process.platform === "win32") {
    return probeEmptyWindowsDirectory(existingAncestor);
  }

  return undefined;
}

function foldMissingPathComponent(component: string): string {
  return caseFold(component);
}

export function canonicalizePathForComparison(
  targetPath: string,
  options: CanonicalPathComparisonOptions = {},
): string {
  const resolved = path.resolve(targetPath);
  const missingParts: string[] = [];
  let candidate = resolved;

  while (true) {
    try {
      const existingAncestor = fs.realpathSync.native(candidate);
      const isCaseInsensitive = missingParts.length > 0
        ? (options.isCaseInsensitive ?? detectCaseInsensitiveFileSystem)(existingAncestor)
        : false;
      const suffix = isCaseInsensitive === true
        ? missingParts.map(foldMissingPathComponent)
        : missingParts;
      return path.join(existingAncestor, ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      missingParts.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}
