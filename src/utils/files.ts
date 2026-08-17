import ignore, { Ignore } from "ignore";
import { existsSync, readFileSync, promises as fsPromises } from "fs";
import * as path from "path";

import { hasFilteredPathSegment, isBuildPathSegment, isHiddenPathSegment } from "./paths.js";

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

export function shouldIncludeFile(
  filePath: string,
  projectRoot: string,
  includePatterns: string[],
  excludePatterns: string[],
  ignoreFilter: Ignore
): boolean {
  const relativePath = path.relative(projectRoot, filePath);

  if (hasFilteredPathSegment(relativePath, path.sep)) {
    return false;
  }

  if (ignoreFilter.ignores(relativePath)) {
    return false;
  }

  for (const pattern of excludePatterns) {
    if (matchGlob(relativePath, pattern)) {
      return false;
    }
  }

  for (const pattern of includePatterns) {
    if (matchGlob(relativePath, pattern)) {
      return true;
    }
  }

  return false;
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
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });

  const filesInDir: Array<{ path: string; size: number }> = [];
  const subdirs: Array<{ fullPath: string; relativePath: string }> = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(projectRoot, fullPath);

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
      subdirs.push({ fullPath, relativePath });
    } else if (entry.isFile()) {
      const stat = await fsPromises.stat(fullPath);

      if (stat.size > maxFileSize) {
        skipped.push({ path: relativePath, reason: "too_large" });
        continue;
      }

      for (const pattern of excludePatterns) {
        if (matchGlob(relativePath, pattern)) {
          skipped.push({ path: relativePath, reason: "excluded" });
          continue;
        }
      }

      let matched = false;
      for (const pattern of includePatterns) {
        if (matchGlob(relativePath, pattern)) {
          matched = true;
          break;
        }
      }

      if (matched) {
        filesInDir.push({ path: fullPath, size: stat.size });
      }
    }
  }

  filesInDir.sort((a, b) => a.size - b.size);
  const limitedFiles = filesInDir.slice(0, options.maxFilesPerDirectory);
  for (const f of limitedFiles) {
    yield f;
  }
  for (let i = options.maxFilesPerDirectory; i < filesInDir.length; i++) {
    skipped.push({ path: path.relative(projectRoot, filesInDir[i].path), reason: "excluded" });
  }

  const canRecurse = options.maxDepth === -1 || currentDepth < options.maxDepth;
  if (canRecurse) {
    for (const sub of subdirs) {
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
    files.push(file);
  }

  if (additionalRoots && additionalRoots.length > 0) {
    const normalizedRoots = new Set<string>();
    for (const kbRoot of additionalRoots) {
      const resolved = path.normalize(
        path.isAbsolute(kbRoot) ? kbRoot : path.resolve(projectRoot, kbRoot)
      );
      normalizedRoots.add(resolved);
    }

    for (const resolvedKbRoot of normalizedRoots) {
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
          files.push(file);
        }
      } catch {
        skipped.push({ path: resolvedKbRoot, reason: "excluded" });
      }
    }
  }

  return { files, skipped };
}
