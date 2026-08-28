import type { Dirent } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import { getTsConfigModuleResolutionConfigDependencyPaths } from "../indexer/local-module-resolution.js";
import { createIgnoreFilter } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";

const LOCAL_MODULE_CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
type IgnoreFilter = ReturnType<typeof createIgnoreFilter>;
export interface LocalModuleConfigTrackerOptions {
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

/** Tracks conventional configs and their safe local relative `extends` dependencies. */
export class LocalModuleConfigTracker {
  private trackedPaths = new Set<string>();

  constructor(
    private readonly projectRoot: string,
    private readonly options: LocalModuleConfigTrackerOptions,
  ) {}

  refresh(): void {
    const root = path.resolve(this.projectRoot);
    const ignoreFilter = createIgnoreFilter(root);
    const roots: string[] = [];
    const maxDepth = this.options.indexing?.maxDepth ?? -1;

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

        if (entry.isFile() && shouldTrackLocalModuleConfigPath(filePath, root, ignoreFilter)) {
          roots.push(relativePath.split(path.sep).join("/"));
        }
      }
    };

    walk(root, 0);
    const nextPaths = new Set<string>();
    const readConfig = (relativePath: string): string | undefined => {
      try {
        return readFileSync(path.join(root, ...relativePath.split("/")), "utf-8");
      } catch {
        return undefined;
      }
    };

    for (const rootConfig of roots) {
      for (const dependency of getTsConfigModuleResolutionConfigDependencyPaths(rootConfig, readConfig)) {
        const dependencyPath = path.resolve(root, ...dependency.split("/"));
        if (shouldTrackProjectLocalJsonConfigPath(dependencyPath, root, ignoreFilter)) {
          nextPaths.add(dependencyPath);
        }
      }
    }
    this.trackedPaths = nextPaths;
  }

  has(filePath: string): boolean {
    return this.trackedPaths.has(path.resolve(filePath));
  }

  getPaths(): readonly string[] {
    return [...this.trackedPaths];
  }
}
