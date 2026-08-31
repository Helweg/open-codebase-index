import ignore, { Ignore } from "ignore";
import { existsSync, readFileSync, promises as fsPromises } from "fs";
import * as path from "path";

import { hasFilteredPathSegment, isBuildPathSegment, isHiddenPathSegment } from "./paths.js";
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

export function createIgnoreFilter(projectRoot: string): Ignore {
  const ig = ignore();

  const defaultIgnores = [
    "node_modules",
    ".git",
    "dist",
    "build",
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
    "**/*build*/**",
  ];

  ig.add(defaultIgnores);

  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
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

export function isExcludedByPatterns(relativePath: string, excludePatterns: string[]): boolean {
  return matchesAnyGlob(relativePath, excludePatterns);
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

export function shouldIncludeFile(
  filePath: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore
): boolean {
  const relativePath = toPosixRelativePath(path.relative(projectRoot, filePath));

  if (hasFilteredPathSegment(relativePath, "/")) {
    return false;
  }

  if (ignoreFilter.ignores(relativePath)) {
    return false;
  }

  if (isExcludedByPatterns(relativePath, excludePatterns)) {
    return false;
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

export interface WalkOptions {
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

    if (isHiddenPathSegment(entry.name)) {
      if (entry.isDirectory()) {
        skipped.push({ path: relativePath, reason: "excluded" });
      }
      continue;
    }

    if (entry.isDirectory() && isBuildPathSegment(entry.name)) {
      skipped.push({ path: relativePath, reason: "excluded" });
      continue;
    }

    if (ignoreFilter.ignores(relativePath)) {
      if (entry.isFile()) {
        skipped.push({ path: relativePath, reason: "gitignore" });
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (isExcludedDirectory(relativePath, excludePatterns)) {
        skipped.push({ path: relativePath, reason: "excluded" });
        continue;
      }
      subdirs.push({ fullPath, relativePath });
    } else if (entry.isFile()) {
      const stat = await fsPromises.stat(fullPath);

      if (stat.size > maxFileSize) {
        skipped.push({ path: relativePath, reason: "too_large" });
        continue;
      }

      if (isExcludedByPatterns(relativePath, excludePatterns)) {
        skipped.push({ path: relativePath, reason: "excluded" });
        continue;
      }

      if (matchesAnyGlob(relativePath, includePatterns)) {
        filesInDir.push({ path: fullPath, size: stat.size });
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
  walkOptions?: WalkOptions
): Promise<CollectFilesResult> {
  const opts: WalkOptions = walkOptions ?? { maxDepth: 5, maxFilesPerDirectory: 100 };
  const ignoreFilter = createIgnoreFilter(projectRoot);
  const files: Array<{ path: string; size: number }> = [];
  const skipped: SkippedFile[] = [];

  for await (const file of walkDirectory(
    projectRoot,
    projectRoot,
    includePatterns,
    excludePatterns,
    ignoreFilter,
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
        for await (const file of walkDirectory(
          resolvedKbRoot,
          resolvedKbRoot,
          includePatterns,
          excludePatterns,
          kbIgnoreFilter,
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
