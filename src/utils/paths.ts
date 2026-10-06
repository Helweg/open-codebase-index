import * as path from "path";

// Bare directory patterns supported by both gitignore and the exclude glob matcher.
export const BUILD_DIRECTORY_PATTERNS = [
  "build",
  "build-*",
  "build_*",
  "*-build",
  "*_build",
  "*-build-*",
  "*-build_*",
  "*_build-*",
  "*_build_*",
] as const;

const BUILD_PATH_SEGMENT = /(?:^|[-_])build(?:$|[-_])/i;

export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

export function isHiddenPathSegment(part: string): boolean {
  return part.startsWith(".") && part !== "." && part !== "..";
}

export function isBuildPathSegment(part: string): boolean {
  return BUILD_PATH_SEGMENT.test(part);
}

export function hasFilteredPathSegment(
  relativePath: string,
  separator: string = path.sep,
): boolean {
  return relativePath.split(separator).some(
    (part) => isHiddenPathSegment(part) || isBuildPathSegment(part)
  );
}

/**
 * Directories that should never be watched when they appear as a top-level
 * segment of a relative path. These are OS-level directories that are either
 * permission-restricted or irrelevant to source code projects.
 *
 * macOS: Library, Applications, System, Volumes, private, cores
 * Linux: proc, sys, dev, run, snap
 * Windows: Windows, ProgramData, Program Files, $Recycle.Bin
 */
const RESTRICTED_DIRECTORIES = new Set([
  // macOS
  "library",
  "applications",
  "system",
  "volumes",
  "private",
  "cores",
  // Linux
  "proc",
  "sys",
  "dev",
  "run",
  "snap",
  // Windows
  "windows",
  "programdata",
  "program files",
  "program files (x86)",
  "$recycle.bin",
]);

/**
 * Returns true if the first path segment is a known OS-restricted directory.
 * This prevents the watcher from descending into paths like ~/Library/ on macOS.
 */
export function isRestrictedDirectory(relativePath: string, separator: string = path.sep): boolean {
  const firstSegment = relativePath.split(separator)[0];
  if (!firstSegment) return false;
  return RESTRICTED_DIRECTORIES.has(firstSegment.toLowerCase());
}
