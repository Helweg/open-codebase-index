import type { Dirent } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import {
  getLocalWorkspacePackageManifestPaths,
  getTsConfigModuleResolutionConfigDependencyPaths,
  isJavaScriptFamilyFilePath,
  isLocalWorkspacePackageManifestPath,
} from "../indexer/local-module-resolution.js";
import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";

const LOCAL_MODULE_CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
const LOCAL_MODULE_PACKAGE_MANIFEST_NAME = "package.json";
type IgnoreFilter = ReturnType<typeof createIgnoreFilter>;
export interface LocalModuleConfigTrackerOptions {
  include?: string[];
  additionalInclude?: string[];
  exclude?: string[];
  indexing?: { maxDepth?: number };
}

/**
 * Whether a config file can affect local JavaScript/TypeScript module resolution.
 *
 * These files are tracked by watchers only. They remain outside the normal source
 * file include patterns and are not added to the index as source documents.
 */
export function shouldTrackLocalModuleConfigPath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter = createIgnoreFilter(projectRoot),
): boolean {
  return (
    LOCAL_MODULE_CONFIG_NAMES.has(path.basename(filePath).toLowerCase())
    && shouldTrackProjectLocalJsonConfigPath(filePath, projectRoot, ignoreFilter)
  );
}

/** Whether a project-local package manifest can affect workspace import resolution. */
export function shouldTrackLocalModulePackagePath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter = createIgnoreFilter(projectRoot),
): boolean {
  return (
    path.basename(filePath).toLowerCase() === LOCAL_MODULE_PACKAGE_MANIFEST_NAME
    && shouldTrackProjectLocalJsonConfigPath(filePath, projectRoot, ignoreFilter)
  );
}

function shouldTrackProjectLocalJsonConfigPath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter,
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

  if (hasFilteredPathSegment(relativePath, path.sep) || isRestrictedDirectory(relativePath, path.sep)) {
    return false;
  }

  return !ignoreFilter.ignores(relativePath);
}

/**
 * Tracks conventional configs, safe local `extends` dependencies, and workspace
 * manifests derived only from included JavaScript/TypeScript source ancestors.
 */
export class LocalModuleConfigTracker {
  private trackedPaths = new Set<string>();
  private rootPackageManifestText: string | undefined;

  constructor(
    private readonly projectRoot: string,
    private readonly options: LocalModuleConfigTrackerOptions,
  ) {}

  refresh(): void {
    const root = path.resolve(this.projectRoot);
    const ignoreFilter = createIgnoreFilter(root);
    const roots: string[] = [];
    const importerPaths: string[] = [];
    const nextPaths = new Set<string>();
    const maxDepth = this.options.indexing?.maxDepth ?? -1;
    const includePatterns = [...(this.options.include ?? []), ...(this.options.additionalInclude ?? [])];
    const excludePatterns = this.options.exclude ?? [];
    const readConfig = (relativePath: string): string | undefined => {
      try {
        return readFileSync(path.join(root, ...relativePath.split("/")), "utf-8");
      } catch {
        return undefined;
      }
    };
    const rootPackageManifestText = readConfig(LOCAL_MODULE_PACKAGE_MANIFEST_NAME);

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
          if (hasFilteredPathSegment(relativePath, path.sep) || isRestrictedDirectory(relativePath, path.sep)) continue;
          if (ignoreFilter.ignores(relativePath)) continue;
          if (maxDepth === -1 || depth < maxDepth) walk(filePath, depth + 1);
          continue;
        }

        if (entry.isFile()) {
          if (shouldTrackLocalModuleConfigPath(filePath, root, ignoreFilter)) {
            roots.push(relativePath.split(path.sep).join("/"));
          }
          if (
            includePatterns.length > 0
            && isJavaScriptFamilyFilePath(relativePath)
            && shouldIncludeFile(filePath, root, includePatterns, excludePatterns, ignoreFilter)
          ) {
            importerPaths.push(relativePath.split(path.sep).join("/"));
          }
        }
      }
    };

    walk(root, 0);

    for (const manifestPath of getLocalWorkspacePackageManifestPaths(importerPaths, readConfig)) {
      nextPaths.add(path.resolve(root, ...manifestPath.split("/")));
    }

    for (const rootConfig of roots) {
      for (const dependency of getTsConfigModuleResolutionConfigDependencyPaths(rootConfig, readConfig)) {
        const dependencyPath = path.resolve(root, ...dependency.split("/"));
        if (shouldTrackProjectLocalJsonConfigPath(dependencyPath, root, ignoreFilter)) {
          nextPaths.add(dependencyPath);
        }
      }
    }
    this.rootPackageManifestText = rootPackageManifestText;
    this.trackedPaths = nextPaths;
  }

  shouldTrackPackagePath(filePath: string): boolean {
    const root = path.resolve(this.projectRoot);
    const ignoreFilter = createIgnoreFilter(root);
    if (!shouldTrackLocalModulePackagePath(filePath, root, ignoreFilter)) return false;

    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    return isLocalWorkspacePackageManifestPath(relativePath, this.rootPackageManifestText);
  }

  has(filePath: string): boolean {
    return this.trackedPaths.has(path.resolve(filePath));
  }

  getPaths(): readonly string[] {
    return [...this.trackedPaths];
  }
}
