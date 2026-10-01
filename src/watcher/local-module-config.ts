import type { Dirent } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import {
  getLocalWorkspacePackageManifestPaths,
  getTsConfigModuleResolutionConfigDependencyPaths,
  isJavaScriptFamilyFilePath,
  isLocalWorkspacePackageManifestPath,
  TsConfigPathAliasCache,
} from "../indexer/local-module-resolution.js";
import {
  createGitIgnoreFilter,
  createIgnoreFilter,
  shouldIncludeFile,
  shouldTraverseDirectory,
  type PathFilterOptions,
} from "../utils/files.js";

const LOCAL_MODULE_CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
const LOCAL_MODULE_PACKAGE_MANIFEST_NAME = "package.json";
type IgnoreFilter = ReturnType<typeof createIgnoreFilter>;
export interface LocalModuleConfigTrackerOptions {
  include?: string[];
  additionalInclude?: string[];
  exclude?: string[];
  indexing?: { maxDepth?: number; includeIgnored?: string[]; includeExcluded?: string[] };
  protectedPaths?: string[];
}

export type LocalModuleConfigFilterOptions = Pick<LocalModuleConfigTrackerOptions, "exclude" | "indexing" | "protectedPaths">;

/**
 * Whether a config file can affect local JavaScript/TypeScript module resolution.
 *
 * These files are tracked by watchers only. They remain outside the normal source
 * file include patterns and are not added to the index as source documents.
 */
export function shouldTrackLocalModuleConfigPath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter | undefined = undefined,
  options: LocalModuleConfigFilterOptions = {},
): boolean {
  const resolvedIgnoreFilter = ignoreFilter ?? createIgnoreFilter(projectRoot);
  return (
    LOCAL_MODULE_CONFIG_NAMES.has(path.basename(filePath).toLowerCase())
    && shouldTrackProjectLocalJsonConfigPath(filePath, projectRoot, resolvedIgnoreFilter, options)
  );
}

/** Whether a project-local package manifest can affect workspace import resolution. */
export function shouldTrackLocalModulePackagePath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter | undefined = undefined,
  options: LocalModuleConfigFilterOptions = {},
): boolean {
  const resolvedIgnoreFilter = ignoreFilter ?? createIgnoreFilter(projectRoot);
  return (
    path.basename(filePath).toLowerCase() === LOCAL_MODULE_PACKAGE_MANIFEST_NAME
    && shouldTrackProjectLocalJsonConfigPath(filePath, projectRoot, resolvedIgnoreFilter, options)
  );
}

function shouldTrackProjectLocalJsonConfigPath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter,
  options: LocalModuleConfigFilterOptions,
): boolean {
  const relativePath = path.relative(projectRoot, filePath);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
    || path.extname(filePath).toLowerCase() !== ".json"
  ) {
    return false;
  }

  const excludePatterns = options.exclude ?? [];
  const includeIgnored = options.indexing?.includeIgnored ?? [];
  const filterOptions: PathFilterOptions = {
    includeExcluded: options.indexing?.includeExcluded ?? [],
    protectedPaths: options.protectedPaths ?? [],
    purpose: "watch",
  };
  const gitIgnoreFilter = createGitIgnoreFilter(projectRoot);
  return shouldIncludeFile(
    filePath,
    projectRoot,
    ["**/*.json"],
    excludePatterns,
    ignoreFilter,
    includeIgnored,
    gitIgnoreFilter,
    filterOptions,
  );
}

/**
 * Tracks conventional configs, safe local `extends` dependencies, and workspace
 * manifests derived only from included JavaScript/TypeScript source ancestors.
 */
export class LocalModuleConfigTracker {
  private importerPaths = new Set<string>();
  private trackedPaths = new Set<string>();
  private trackedPathAncestors = new Set<string>();
  private rootPackageManifestText: string | undefined;

  constructor(
    private readonly projectRoot: string,
    private readonly options: LocalModuleConfigTrackerOptions,
  ) {}

  refresh(): void {
    const root = path.resolve(this.projectRoot);
    const ignoreFilter = createIgnoreFilter(root);
    const gitIgnoreFilter = createGitIgnoreFilter(root);
    const roots: string[] = [];
    const importerPaths: string[] = [];
    const nextPaths = new Set<string>();
    const maxDepth = this.options.indexing?.maxDepth ?? -1;
    const includePatterns = [...(this.options.include ?? []), ...(this.options.additionalInclude ?? [])];
    const excludePatterns = this.options.exclude ?? [];
    const includeIgnored = this.options.indexing?.includeIgnored ?? [];
    const filterOptions: PathFilterOptions = {
      includeExcluded: this.options.indexing?.includeExcluded ?? [],
      protectedPaths: this.options.protectedPaths ?? [],
      purpose: "watch",
    };
    const readConfig = (relativePath: string): string | undefined => {
      try {
        return readFileSync(path.join(root, ...relativePath.split("/")), "utf-8");
      } catch {
        return undefined;
      }
    };
    const rootPackageManifestText = readConfig(LOCAL_MODULE_PACKAGE_MANIFEST_NAME);
    const resolveTrackableConfigDependency = (candidatePath: string, allowAutomaticExcluded: boolean): {
      filePath: string;
      relativePath: string;
    } | undefined => {
      const normalizedCandidate = path.posix.normalize(candidatePath.replaceAll("\\", "/"));
      if (
        path.posix.isAbsolute(normalizedCandidate)
        || /^[A-Za-z]:\//u.test(normalizedCandidate)
        || normalizedCandidate === ".."
        || normalizedCandidate.startsWith("../")
        || path.posix.extname(normalizedCandidate).toLowerCase() !== ".json"
      ) {
        return undefined;
      }

      const filePath = path.resolve(root, ...normalizedCandidate.split("/"));
      const relativePath = path.relative(root, filePath);
      if (
        relativePath === ".."
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)
      ) {
        return undefined;
      }

      const normalizedRelativePath = relativePath.split(path.sep).join("/");
      const parentSegments = path.posix.dirname(normalizedRelativePath).split("/").filter((segment) => segment !== ".");
      if (maxDepth !== -1 && parentSegments.length > maxDepth) {
        return undefined;
      }

      const dependencyFilterOptions: PathFilterOptions = {
        ...filterOptions,
        includeExcluded: allowAutomaticExcluded
          ? [normalizedRelativePath]
          : filterOptions.includeExcluded,
      };
      let ancestorPath = root;
      for (const segment of parentSegments) {
        ancestorPath = path.join(ancestorPath, segment);
        if (!shouldTraverseDirectory(
          ancestorPath,
          root,
          excludePatterns,
          ignoreFilter,
          includeIgnored,
          gitIgnoreFilter,
          dependencyFilterOptions,
        )) {
          return undefined;
        }
      }

      if (!shouldIncludeFile(
        filePath,
        root,
        ["**/*.json"],
        excludePatterns,
        ignoreFilter,
        includeIgnored,
        gitIgnoreFilter,
        dependencyFilterOptions,
      )) {
        return undefined;
      }

      return { filePath, relativePath: normalizedRelativePath };
    };
    const readTrackableConfigDependency = (
      relativePath: string,
      allowAutomaticExcluded: boolean,
    ): string | undefined => {
      const dependency = resolveTrackableConfigDependency(relativePath, allowAutomaticExcluded);
      return dependency ? readConfig(dependency.relativePath) : undefined;
    };
    const addTrackableConfigDependency = (relativePath: string, allowAutomaticExcluded: boolean): void => {
      const dependency = resolveTrackableConfigDependency(relativePath, allowAutomaticExcluded);
      if (dependency) nextPaths.add(dependency.filePath);
    };

    const walk = (directoryPath: string, depth: number): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(directoryPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const filePath = path.join(directoryPath, entry.name);
        const relativePath = path.relative(root, filePath);
        if (entry.isDirectory()) {
          if (!shouldTraverseDirectory(filePath, root, excludePatterns, ignoreFilter, includeIgnored, gitIgnoreFilter, filterOptions)) continue;
          if (maxDepth === -1 || depth < maxDepth) walk(filePath, depth + 1);
          continue;
        }

        if (entry.isFile()) {
          if (shouldTrackLocalModuleConfigPath(filePath, root, ignoreFilter, this.options)) {
            roots.push(relativePath.split(path.sep).join("/"));
          }
          if (
            includePatterns.length > 0
            && isJavaScriptFamilyFilePath(relativePath)
            && shouldIncludeFile(filePath, root, includePatterns, excludePatterns, ignoreFilter, includeIgnored, gitIgnoreFilter, filterOptions)
          ) {
            importerPaths.push(relativePath.split(path.sep).join("/"));
          }
        }
      }
    };

    walk(root, 0);

    for (const manifestPath of getLocalWorkspacePackageManifestPaths(importerPaths, readConfig)) {
      addTrackableConfigDependency(manifestPath, true);
    }

    const pathAliasCache = new TsConfigPathAliasCache((relativePath) =>
      readTrackableConfigDependency(relativePath, true)
    );
    for (const [dependencyPath] of pathAliasCache.getConfigState(importerPaths)) {
      addTrackableConfigDependency(dependencyPath, true);
    }

    for (const rootConfig of roots) {
      for (const dependency of getTsConfigModuleResolutionConfigDependencyPaths(
        rootConfig,
        (relativePath) => readTrackableConfigDependency(relativePath, false),
      )) {
        addTrackableConfigDependency(dependency, false);
      }
    }
    this.rootPackageManifestText = rootPackageManifestText;
    this.importerPaths = new Set(importerPaths.map((importerPath) => path.resolve(root, ...importerPath.split("/"))));
    this.trackedPaths = nextPaths;
    this.trackedPathAncestors = this.getTrackedPathAncestors(root, nextPaths);
  }

  shouldTrackPackagePath(filePath: string): boolean {
    const root = path.resolve(this.projectRoot);
    const ignoreFilter = createIgnoreFilter(root);
    if (!shouldTrackLocalModulePackagePath(filePath, root, ignoreFilter, this.options)) return false;

    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    return isLocalWorkspacePackageManifestPath(relativePath, this.rootPackageManifestText);
  }

  has(filePath: string): boolean {
    return this.trackedPaths.has(path.resolve(filePath));
  }

  hasImporterPath(filePath: string): boolean {
    return this.importerPaths.has(path.resolve(filePath));
  }

  hasPathOrAncestor(filePath: string): boolean {
    const resolvedPath = path.resolve(filePath);
    return this.trackedPaths.has(resolvedPath) || this.trackedPathAncestors.has(resolvedPath);
  }

  getPaths(): readonly string[] {
    return [...this.trackedPaths];
  }

  getWatchPaths(): readonly string[] {
    return [...this.trackedPathAncestors, ...this.trackedPaths]
      .sort((left, right) => left.length - right.length || left.localeCompare(right));
  }

  private getTrackedPathAncestors(root: string, trackedPaths: ReadonlySet<string>): Set<string> {
    const ancestors = new Set<string>();
    for (const trackedPath of trackedPaths) {
      let ancestorPath = path.dirname(trackedPath);
      while (ancestorPath !== root) {
        const relativePath = path.relative(root, ancestorPath);
        if (
          relativePath === ".."
          || relativePath.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativePath)
        ) {
          break;
        }
        ancestors.add(ancestorPath);
        const parentPath = path.dirname(ancestorPath);
        if (parentPath === ancestorPath) break;
        ancestorPath = parentPath;
      }
    }
    return ancestors;
  }
}
