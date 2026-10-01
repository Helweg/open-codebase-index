import ignore, { type Ignore } from "ignore";
import { existsSync, readFileSync, realpathSync, promises as fsPromises } from "fs";
import * as path from "path";

import { isDefaultExcludePatterns } from "../config/exclusions.js";
import { hasFilteredPathSegment, isBuildPathSegment, isHiddenPathSegment, isRestrictedDirectory } from "./paths.js";
import {
  isOperationInterruption,
  throwIfOperationAborted,
} from "./operation-control.js";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "CMakeLists.txt",
  "Makefile",
];

export function hasProjectMarker(projectRoot: string): boolean {
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(path.join(projectRoot, marker))) {
      return true;
    }
  }
  return false;
}

export interface SkippedFile {
  path: string;
  reason: "too_large" | "excluded" | "gitignore" | "no_match" | "unreadable";
}

export interface CollectFilesResult {
  files: Array<{ path: string; size: number }>;
  skipped: SkippedFile[];
}

const DEFAULT_IGNORES = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "**/*build*/**",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    "target",
    "vendor",
    ".opencode",
    ".codebase-index",
    ".*",
    "**/.*",
    "**/.*/**",
];

const DEFAULT_IGNORE_FILTER = ignore().add(DEFAULT_IGNORES);

export function createGitIgnoreFilter(projectRoot: string): Ignore {
  const ig = ignore();
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }
  return ig;
}

export function createIgnoreFilter(projectRoot: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }
  return ig;
}

function toPosixRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  const normalized = toPosixRelativePath(filePath);
  return patterns.some((pattern) => matchGlob(normalized, pattern));
}

export function matchesIncludeIgnored(relativePath: string, includeIgnored: string[]): boolean {
  const normalized = toPosixRelativePath(relativePath);
  return includeIgnored.some((pattern) => matchGlob(normalized, pattern.replace(/^\.\//, "")));
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export function canContainIncludeIgnored(relativePath: string, includeIgnored: string[]): boolean {
  return canContainPattern(relativePath, includeIgnored);
}

function canContainPattern(relativePath: string, patterns: readonly string[]): boolean {
  const normalizedDirectory = trimTrailingSlashes(toPosixRelativePath(relativePath));
  if (!normalizedDirectory) return patterns.length > 0;
  if (patterns.some((pattern) => matchGlob(normalizedDirectory, pattern.replace(/^\.\//, "")))) return true;

  const probe = `${normalizedDirectory}/__include_ignored_probe__`;
  return patterns.some((pattern) => {
    const normalizedPattern = toPosixRelativePath(pattern).replace(/^\.\//, "");
    const wildcardIndex = normalizedPattern.search(/[?*{]/);
    // Text before a wildcard in the same component is not a literal directory prefix.
    const literalPrefixEnd = wildcardIndex === -1
      ? normalizedPattern.length
      : normalizedPattern.lastIndexOf("/", wildcardIndex) + 1;
    const literalPrefix = trimTrailingSlashes(normalizedPattern.slice(0, literalPrefixEnd));
    return !literalPrefix
      || literalPrefix === normalizedDirectory
      || literalPrefix.startsWith(`${normalizedDirectory}/`)
      || normalizedDirectory.startsWith(`${literalPrefix}/`)
      || matchGlob(probe, normalizedPattern);
  });
}

export function isAlwaysFilteredPath(relativePath: string): boolean {
  const normalized = toPosixRelativePath(relativePath);
  return hasFilteredPathSegment(normalized, "/") || DEFAULT_IGNORE_FILTER.ignores(normalized);
}

export function isIgnoredPathIncluded(
  relativePath: string,
  includeIgnored: string[],
  ignoreFilter: Ignore,
  gitIgnoreFilter: Ignore,
): boolean {
  const normalized = toPosixRelativePath(relativePath);
  return includeIgnored.length > 0
    && !isAlwaysFilteredPath(normalized)
    && !isRestrictedDirectory(normalized, "/")
    && ignoreFilter.ignores(normalized)
    && gitIgnoreFilter.ignores(normalized)
    && matchesIncludeIgnored(normalized, includeIgnored);
}

export interface PathFilterOptions {
  includeExcluded?: string[];
  protectedPaths?: string[];
  purpose?: "index" | "watch";
}

export function isExcludedByPatterns(
  relativePath: string,
  excludePatterns: string[],
  options: PathFilterOptions = {},
): boolean {
  if (!matchesAnyGlob(relativePath, excludePatterns)) return false;
  return !(isDefaultExcludePatterns(excludePatterns)
    && matchesAnyGlob(relativePath, options.includeExcluded ?? []));
}

function isExcludedDirectory(relativePath: string, excludePatterns: string[]): boolean {
  const normalized = toPosixRelativePath(relativePath);
  if (matchesAnyGlob(normalized, excludePatterns)) {
    return true;
  }

  for (const pattern of excludePatterns) {
    const posixPattern = toPosixRelativePath(pattern).replace(/\/+$/, "");
    if (!posixPattern.endsWith("/**")) {
      continue;
    }
    const directoryPattern = posixPattern.slice(0, -3);
    if (directoryPattern && matchesAnyGlob(normalized, [directoryPattern])) {
      return true;
    }
  }

  return false;
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonicalPath(parent), path.basename(resolved));
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function hasProtectedMetadataSegments(relativePath: string): boolean {
  const segments = toPosixRelativePath(relativePath)
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (segments.includes(".git")) return true;
  for (let index = 0; index < segments.length - 1; index++) {
    if (
      (segments[index] === ".codebase-index"
        || segments[index] === ".opencode"
        || segments[index] === ".claude")
      && segments[index + 1] === "index"
    ) {
      return true;
    }
  }
  return false;
}

function isProtectedPath(candidatePath: string, projectRoot: string, protectedPaths: readonly string[]): boolean {
  if (!path.isAbsolute(candidatePath)) return true;
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalCandidate = path.resolve(candidatePath);
  if (!isWithinPath(lexicalRoot, lexicalCandidate)) return true;
  if (hasProtectedMetadataSegments(lexicalRoot)) return true;
  if (hasProtectedMetadataSegments(lexicalCandidate)) return true;
  if (hasProtectedMetadataSegments(path.relative(lexicalRoot, lexicalCandidate))) return true;

  const canonicalRoot = canonicalPath(projectRoot);
  const canonicalCandidate = canonicalPath(candidatePath);
  if (!isWithinPath(canonicalRoot, canonicalCandidate)) return true;
  if (hasProtectedMetadataSegments(canonicalRoot)) return true;
  if (hasProtectedMetadataSegments(canonicalCandidate)) return true;
  if (hasProtectedMetadataSegments(path.relative(canonicalRoot, canonicalCandidate))) return true;

  return protectedPaths.some((protectedPath) => {
    if (!path.isAbsolute(protectedPath)) return false;
    const canonicalProtected = canonicalPath(protectedPath);
    return isWithinPath(canonicalProtected, canonicalCandidate);
  });
}

function matchesAutomaticSelection(
  relativePath: string,
  options: PathFilterOptions,
): boolean {
  return matchesAnyGlob(relativePath, options.includeExcluded ?? []);
}

function canContainAutomaticSelection(
  relativePath: string,
  options: PathFilterOptions,
): boolean {
  return canContainPattern(relativePath, options.includeExcluded ?? []);
}

function isIndexFilteredFile(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.some((segment, index) => (
    isHiddenPathSegment(segment) || (index < segments.length - 1 && isBuildPathSegment(segment))
  ));
}

export function shouldTraverseDirectory(
  directoryPath: string,
  projectRoot: string,
  excludePatterns: string[],
  ignoreFilter: Ignore,
  includeIgnored: string[] = [],
  gitIgnoreFilter: Ignore = ignore(),
  options: PathFilterOptions = {},
): boolean {
  if (isProtectedPath(directoryPath, projectRoot, options.protectedPaths ?? [])) return false;

  const relativePath = toPosixRelativePath(path.relative(projectRoot, directoryPath));
  if (!relativePath) return true;
  const purpose = options.purpose ?? "watch";
  const canContainSelected = canContainAutomaticSelection(relativePath, options);
  const defaultExcludes = isDefaultExcludePatterns(excludePatterns);
  if (isExcludedDirectory(relativePath, excludePatterns)
    && !(defaultExcludes && canContainSelected)) {
    return false;
  }

  if (purpose === "watch" && isRestrictedDirectory(relativePath, "/")) return false;
  const automaticallyFiltered = purpose === "index"
    ? relativePath.split("/").some((segment) => isHiddenPathSegment(segment) || isBuildPathSegment(segment))
    : isAlwaysFilteredPath(relativePath);
  if (automaticallyFiltered && !canContainSelected) return false;

  const gitIgnored = gitIgnoreFilter.ignores(relativePath);
  const canContainGitSelection = canContainIncludeIgnored(relativePath, includeIgnored);
  if (gitIgnored && !canContainGitSelection) return false;
  const traversableGitIgnoredDirectory = !isAlwaysFilteredPath(relativePath)
    && !isRestrictedDirectory(relativePath, "/")
    && gitIgnored
    && canContainGitSelection;
  if (ignoreFilter.ignores(relativePath)
    && !canContainSelected
    && !traversableGitIgnoredDirectory) {
    return false;
  }
  return true;
}

export function shouldIncludeFile(
  filePath: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore,
  includeIgnored: string[] = [],
  gitIgnoreFilter: Ignore = ignore(),
  options: PathFilterOptions = {},
): boolean {
  if (isProtectedPath(filePath, projectRoot, options.protectedPaths ?? [])) return false;
  const relativePath = toPosixRelativePath(path.relative(projectRoot, filePath));
  const selectedAutomaticPath = matchesAutomaticSelection(relativePath, options);
  const purpose = options.purpose ?? "watch";

  if (isExcludedByPatterns(relativePath, excludePatterns, options)) {
    return false;
  }

  const automaticallyFiltered = purpose === "index"
    ? isIndexFilteredFile(relativePath)
    : isAlwaysFilteredPath(relativePath);
  if (automaticallyFiltered && !selectedAutomaticPath) {
    return false;
  }

  const gitIgnored = gitIgnoreFilter.ignores(relativePath);
  if (gitIgnored && !matchesIncludeIgnored(relativePath, includeIgnored)) {
    return false;
  }
  if (ignoreFilter.ignores(relativePath) && !selectedAutomaticPath) {
    if (!isIgnoredPathIncluded(relativePath, includeIgnored, ignoreFilter, gitIgnoreFilter)) {
      return false;
    }
  }

  return matchesAnyGlob(relativePath, includePatterns);
}

function matchGlob(filePath: string, pattern: string): boolean {
  if (pattern.startsWith("**/")) {
    const withoutPrefix = pattern.slice(3);
    if (withoutPrefix && matchGlob(filePath, withoutPrefix)) {
      return true;
    }
  }

  const escapedPattern = pattern.replace(/[.+^$()|[\]\\]/g, "\\$&");

  let regexPattern = escapedPattern
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\{([^}]+)\}/g, (_, p1) => `(${p1.split(",").join("|")})`);

  // **/*.js → matches both root "file.js" and nested "dir/file.js"
  if (regexPattern.startsWith(".*/")) {
    regexPattern = `(.*\\/)?${regexPattern.slice(3)}`;
  }

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

export interface WalkOptions extends PathFilterOptions {
  maxDepth: number;
  maxFilesPerDirectory: number;
  signal?: AbortSignal;
  heartbeat?: () => void | Promise<void>;
}

export async function* walkDirectory(
  dir: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore,
  gitIgnoreFilter: Ignore,
  includeIgnored: string[],
  maxFileSize: number,
  skipped: SkippedFile[],
  options: WalkOptions,
  currentDepth: number = 0
): AsyncGenerator<{ path: string; size: number }> {
  throwIfOperationAborted(options.signal);
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  throwIfOperationAborted(options.signal);

  const filesInDir: Array<{ path: string; size: number }> = [];
  const subdirs: Array<{ fullPath: string; relativePath: string }> = [];

  for (const entry of entries) {
    throwIfOperationAborted(options.signal);
    await options.heartbeat?.();
    const fullPath = path.join(dir, entry.name);
    const relativePath = toPosixRelativePath(path.relative(projectRoot, fullPath));

    if (entry.isDirectory()) {
      const traversable = shouldTraverseDirectory(
        fullPath,
        projectRoot,
        excludePatterns,
        ignoreFilter,
        includeIgnored,
        gitIgnoreFilter,
        options,
      );
      if (!traversable) {
        const canContainSelected = canContainAutomaticSelection(relativePath, options);
        const hardFilteredDirectory = relativePath.split("/").some(
          (segment) => isHiddenPathSegment(segment) || isBuildPathSegment(segment),
        );
        if (hardFilteredDirectory && !canContainSelected) {
          skipped.push({ path: relativePath, reason: "excluded" });
          continue;
        }

        const gitIgnored = gitIgnoreFilter.ignores(relativePath);
        const canContainGitSelection = canContainIncludeIgnored(relativePath, includeIgnored);
        const automaticBypass = canContainSelected && (!gitIgnored || canContainGitSelection);
        const legacyGitTraversal = !isAlwaysFilteredPath(relativePath)
          && !isRestrictedDirectory(relativePath, "/")
          && gitIgnored
          && canContainGitSelection;
        if (ignoreFilter.ignores(relativePath) && !automaticBypass && !legacyGitTraversal) {
          continue;
        }

        skipped.push({ path: relativePath, reason: "excluded" });
        continue;
      }
      subdirs.push({ fullPath, relativePath });
    } else if (entry.isFile()) {
      const included = shouldIncludeFile(
        fullPath,
        projectRoot,
        includePatterns,
        excludePatterns,
        ignoreFilter,
        includeIgnored,
        gitIgnoreFilter,
        options,
      );
      const selectedAutomaticPath = matchesAutomaticSelection(relativePath, options);
      if (!included && isIndexFilteredFile(relativePath) && !selectedAutomaticPath) {
        continue;
      }

      const gitIgnored = gitIgnoreFilter.ignores(relativePath);
      if (!included && gitIgnored && !matchesIncludeIgnored(relativePath, includeIgnored)) {
        skipped.push({ path: relativePath, reason: "gitignore" });
        continue;
      }
      if (!included
        && ignoreFilter.ignores(relativePath)
        && !selectedAutomaticPath
        && !isIgnoredPathIncluded(relativePath, includeIgnored, ignoreFilter, gitIgnoreFilter)) {
        skipped.push({ path: relativePath, reason: "gitignore" });
        continue;
      }

      const stat = await fsPromises.stat(fullPath);
      if (stat.size > maxFileSize) {
        skipped.push({ path: relativePath, reason: "too_large" });
        continue;
      }

      if (included) {
        filesInDir.push({ path: fullPath, size: stat.size });
      } else if (isExcludedByPatterns(relativePath, excludePatterns, options)
        || isProtectedPath(fullPath, projectRoot, options.protectedPaths ?? [])) {
        skipped.push({ path: relativePath, reason: "excluded" });
      }
    }
  }

  filesInDir.sort((a, b) => a.size - b.size);
  const limitedFiles = filesInDir.slice(0, options.maxFilesPerDirectory);
  for (const f of limitedFiles) {
    throwIfOperationAborted(options.signal);
    await options.heartbeat?.();
    yield f;
  }
  for (let i = options.maxFilesPerDirectory; i < filesInDir.length; i++) {
    skipped.push({ path: toPosixRelativePath(path.relative(projectRoot, filesInDir[i].path)), reason: "excluded" });
  }

  const canRecurse = options.maxDepth === -1 || currentDepth < options.maxDepth;
  if (canRecurse) {
    for (const sub of subdirs) {
      throwIfOperationAborted(options.signal);
      yield* walkDirectory(
        sub.fullPath,
        projectRoot,
        includePatterns,
        excludePatterns,
        ignoreFilter,
        gitIgnoreFilter,
        includeIgnored,
        maxFileSize,
        skipped,
        options,
        currentDepth + 1
      );
    }
  }
}

export async function collectFiles(
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  maxFileSize: number,
  additionalRoots?: string[],
  walkOptions?: WalkOptions,
  includeIgnored: string[] = [],
): Promise<CollectFilesResult> {
  const opts: WalkOptions = {
    maxDepth: -1,
    maxFilesPerDirectory: 100,
    ...walkOptions,
    purpose: "index",
  };
  const ignoreFilter = createIgnoreFilter(projectRoot);
  const gitIgnoreFilter = createGitIgnoreFilter(projectRoot);
  const files: Array<{ path: string; size: number }> = [];
  const skipped: SkippedFile[] = [];

  for await (const file of walkDirectory(
    projectRoot,
    projectRoot,
    includePatterns,
    excludePatterns,
    ignoreFilter,
    gitIgnoreFilter,
    includeIgnored,
    maxFileSize,
    skipped,
    opts,
    0
  )) {
    throwIfOperationAborted(opts.signal);
    await opts.heartbeat?.();
    files.push(file);
  }

  if (additionalRoots && additionalRoots.length > 0) {
    const normalizedRoots = new Set<string>();
    for (const kbRoot of additionalRoots) {
      throwIfOperationAborted(opts.signal);
      const resolved = path.normalize(
        path.isAbsolute(kbRoot) ? kbRoot : path.resolve(projectRoot, kbRoot)
      );
      normalizedRoots.add(resolved);
    }

    for (const resolvedKbRoot of normalizedRoots) {
      throwIfOperationAborted(opts.signal);
      try {
        const stat = await fsPromises.stat(resolvedKbRoot);
        if (!stat.isDirectory()) {
          skipped.push({ path: resolvedKbRoot, reason: "excluded" });
          continue;
        }
        const kbIgnoreFilter = createIgnoreFilter(resolvedKbRoot);
        const kbGitIgnoreFilter = createGitIgnoreFilter(resolvedKbRoot);
        for await (const file of walkDirectory(
          resolvedKbRoot,
          resolvedKbRoot,
          includePatterns,
          excludePatterns,
          kbIgnoreFilter,
          kbGitIgnoreFilter,
          [],
          maxFileSize,
          skipped,
          opts,
          0
        )) {
          throwIfOperationAborted(opts.signal);
          await opts.heartbeat?.();
          files.push(file);
        }
      } catch (error) {
        if (isOperationInterruption(error)) throw error;
        throwIfOperationAborted(opts.signal);
        skipped.push({ path: resolvedKbRoot, reason: "excluded" });
      }
    }
  }

  return { files, skipped };
}
