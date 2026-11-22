import type { ParsedCodebaseIndexConfig } from "../config/schema.js";
import type { ModuleSyntaxData } from "../native/types.js";
import type { FileBatchLimits } from "./file-batches.js";

import { promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";

import { hashContent } from "../native/parsing.js";
import { isPathWithinRoot } from "../utils/canonical-path.js";
import { isOperationInterruption, throwIfOperationAborted } from "../utils/operation-control.js";
import { iterateOrderedFileBatches } from "./file-batches.js";
import { isGoFilePath } from "./go-package-resolution.js";
import {
  affectedJavaScriptGraphFiles,
  readJavaScriptGraphDependencies,
  writeJavaScriptGraphDependencies,
  type JavaScriptGraphDependency,
  type PackageFormat,
} from "./javascript-graph-dependencies.js";
import {
  declaredPackageFormat,
  getLocalWorkspacePackageManifestPaths,
  getLocalWorkspacePackages,
  isJavaScriptFamilyFilePath,
  TsConfigPathAliasCache,
  type LocalModuleCallResolver,
  type LocalWorkspacePackage,
} from "./local-module-resolution.js";
import { isPythonFilePath } from "./python-import-resolution.js";

const PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024;

export function callGraphDependencyMetadataKey(branchKey: string): string {
  return `index.javaScriptGraphDependencies.${hashContent(branchKey).slice(0, 24)}`;
}

interface LocalModuleResolutionState {
  configHash: string;
  javaScriptGraphConfigHash?: string;
  pathAliasCache: TsConfigPathAliasCache;
  workspacePackages: readonly LocalWorkspacePackage[];
}

export function readLocalModuleResolutionState(
  root: string,
  files: readonly { path: string }[],
  trackJavaScriptDependencies = false,
): LocalModuleResolutionState {
  const loadFileText = (configPath: string): string | undefined => {
    try {
      return readFileSync(path.join(root, ...configPath.split("/")), "utf-8");
    } catch {
      return undefined;
    }
  };
  const pathAliasCache = new TsConfigPathAliasCache(loadFileText);
  const importerPaths = files.flatMap((file) => {
    if (!isPathWithinRoot(file.path, root)) return [];
    const relativePath = path.relative(root, file.path).split(path.sep).join("/");
    return isJavaScriptFamilyFilePath(relativePath) ? [relativePath] : [];
  });
  const workspaceManifestPaths = getLocalWorkspacePackageManifestPaths(importerPaths, loadFileText);
  const workspacePackages = getLocalWorkspacePackages(importerPaths, loadFileText);
  const tsconfig = pathAliasCache.getConfigState(importerPaths);
  const packageManifests = workspaceManifestPaths.map((manifestPath) => [
    manifestPath,
    loadFileText(manifestPath) ?? null,
  ] as const);
  const configHash = hashContent(JSON.stringify({ tsconfig, packageManifests }));
  // Discovery fingerprints absent configs for freshness. A new source directory
  // without a config does not invalidate dependency proof.
  const javaScriptGraphConfigHash = trackJavaScriptDependencies
    ? hashContent(JSON.stringify({
      tsconfig: tsconfig.filter(([, content]) => content !== null),
      packageManifests: packageManifests.filter(([, content]) => content !== null),
    }))
    : undefined;
  return { configHash, javaScriptGraphConfigHash, pathAliasCache, workspacePackages };
}

interface RefreshOptions {
  config: Pick<ParsedCodebaseIndexConfig, "scope" | "indexing">;
  materializedRoot: string;
  files: readonly { path: string }[];
  currentPaths: ReadonlySet<string>;
  previousHashes: ReadonlyMap<string, string>;
  toMaterializedPath: (file: string) => string;
  inScope?: (file: string) => boolean;
  readSnapshot: () => string | null;
  previousResolutionConfigHash: string | null;
  storageChanged: boolean;
  resolutionChanged: boolean;
  scipChanged: boolean;
  javaScriptParserChanged: boolean;
  fileBatchLimits?: FileBatchLimits;
  signal?: AbortSignal;
}

type SnapshotPublication = { action: "keep" } | { action: "replace"; value: string } | { action: "invalidate" };

interface CallGraphRefresh {
  resolution: LocalModuleResolutionState;
  moduleFormatForFile: (file: string) => Promise<PackageFormat>;
  recordSourceChange(file: string): void;
  cachedSourceNeedsRefresh(file: string, hasOtherLocalModuleEdges: (file: string) => boolean): boolean;
  selectAdditionalFiles<T>(
    available: ReadonlyMap<string, T>,
    scheduled: ReadonlySet<string>,
    checkpoint?: () => void | Promise<void>,
  ): Promise<T[]>;
  beginParseBatch(files: readonly { storedPath: string }[]): void;
  recordParsedSource(
    file: string,
    hash: string,
    parsed: { hash: string; moduleSyntax?: ModuleSyntaxData },
    resolver: Pick<LocalModuleCallResolver, "getModuleDependencyProbes">,
  ): Promise<void> | undefined;
  snapshotPublication(): SnapshotPublication;
}

/** One refresh: observe changes, select additional sources, then collect and publish proof. */
export async function prepareCallGraphRefresh(options: RefreshOptions): Promise<CallGraphRefresh> {
  const {
    config, materializedRoot, files, currentPaths, previousHashes, inScope,
    storageChanged, resolutionChanged, scipChanged, javaScriptParserChanged,
  } = options;
  const projectStructural = config.scope === "project" && config.indexing.mode === "structural";
  const trackJavaScript = projectStructural && !config.indexing.scipTypeScript.enabled;
  const resolution = readLocalModuleResolutionState(materializedRoot, files, trackJavaScript);
  const graphConfigHash = resolution.javaScriptGraphConfigHash;
  const formats = createPackageFormatLookup(options);
  const storedSnapshot = projectStructural ? options.readSnapshot() : null;
  let prior = graphConfigHash !== undefined && !storageChanged && !resolutionChanged && !scipChanged
    ? readJavaScriptGraphDependencies(storedSnapshot, graphConfigHash, previousHashes)
    : undefined;
  if (prior && !await formats.match(prior)) prior = undefined;

  const refreshAllJavaScript = trackJavaScript && !prior;
  const dependencies = trackJavaScript ? prior ?? new Map<string, JavaScriptGraphDependency>() : undefined;
  let dependenciesDirty = refreshAllJavaScript;
  let javaScriptChanged = false;
  let pythonChanged = false;
  const changedJavaScript = new Set<string>();
  const changedGoDirectories = new Set<string>();
  const versionOrScipChanged = resolutionChanged || scipChanged;
  const configChanged = options.previousResolutionConfigHash !== resolution.configHash;

  function recordSourceChange(file: string): void {
    if (isJavaScriptFamilyFilePath(file)) {
      javaScriptChanged = true;
      if (prior) changedJavaScript.add(file);
    } else if (isPythonFilePath(file)) {
      pythonChanged = true;
    } else if (isGoFilePath(file)) {
      changedGoDirectories.add(goDirectory(file));
    }
  }

  for (const file of previousHashes.keys()) {
    if (!currentPaths.has(file) && (!inScope || inScope(file))) recordSourceChange(file);
  }

  return {
    resolution,
    moduleFormatForFile: formats.forFile,
    recordSourceChange,
    cachedSourceNeedsRefresh(file, hasOtherLocalModuleEdges) {
      if (isJavaScriptFamilyFilePath(file)) {
        return javaScriptParserChanged || versionOrScipChanged || (configChanged && !trackJavaScript);
      }
      return (resolutionChanged && (isGoFilePath(file) || isPythonFilePath(file)))
        || ((versionOrScipChanged || configChanged) && hasOtherLocalModuleEdges(file));
    },
    async selectAdditionalFiles<T>(available: ReadonlyMap<string, T>, scheduled: ReadonlySet<string>, checkpoint?: () => void | Promise<void>) {
      // Missing descriptors include files that are still listed but could not be hashed.
      if (prior) {
        for (const file of prior.keys()) {
          if (!available.has(file)) changedJavaScript.add(file);
        }
      }
      let affectedJavaScript: Set<string> | undefined;
      if (prior && changedJavaScript.size > 0) {
        affectedJavaScript = affectedJavaScriptGraphFiles(changedJavaScript, prior);
        dependenciesDirty = true;
        for (const file of changedJavaScript) prior.delete(file);
      }

      const broadJavaScript = refreshAllJavaScript || (!trackJavaScript && javaScriptChanged);
      const scanGo = changedGoDirectories.size > 0;
      const selected: T[] = [];
      if (!broadJavaScript && !affectedJavaScript && !pythonChanged && !scanGo) return selected;

      // Keep JS/TS and Python ahead of Go in the indexing queue as before.
      const goFiles: T[] = [];
      let visited = 0;
      for (const [file, entry] of available) {
        if (checkpoint && visited > 0 && visited % 256 === 0) await checkpoint();
        visited += 1;
        if (scheduled.has(file)) continue;
        if ((broadJavaScript && isJavaScriptFamilyFilePath(file)) || affectedJavaScript?.has(file)
          || (pythonChanged && isPythonFilePath(file))) {
          selected.push(entry);
        } else if (scanGo && isGoFilePath(file) && changedGoDirectories.has(goDirectory(file))) {
          goFiles.push(entry);
        }
      }
      for (const entry of goFiles) selected.push(entry);
      return selected;
    },
    beginParseBatch(batch) {
      if (!dependencies) return;
      // Old proof was sufficient to select this run, but must not survive a failed read or parse.
      for (const { storedPath } of batch) {
        if (!isJavaScriptFamilyFilePath(storedPath)) continue;
        dependencies.delete(storedPath);
        dependenciesDirty = true;
      }
    },
    recordParsedSource(file, hash, parsed, resolver) {
      if (!dependencies || !isJavaScriptFamilyFilePath(file) || parsed.hash !== hash || !parsed.moduleSyntax?.valid) return;
      const { imports, reexports, usesPackageFormat } = resolver.getModuleDependencyProbes(file, parsed.moduleSyntax);
      if (usesPackageFormat) {
        return formats.forFile(file).then((format) => { dependencies.set(file, { hash, imports, reexports, format }); });
      }
      dependencies.set(file, { hash, imports, reexports });
    },
    snapshotPublication() {
      if (dependencies && !dependenciesDirty) return { action: "keep" };
      if (dependencies && graphConfigHash !== undefined) {
        let complete = true;
        for (const file of currentPaths) {
          if (isJavaScriptFamilyFilePath(file) && !dependencies.has(file)) {
            complete = false;
            break;
          }
        }
        if (complete) {
          return { action: "replace", value: writeJavaScriptGraphDependencies(graphConfigHash, dependencies) };
        }
      }
      return { action: storedSnapshot === null ? "keep" : "invalidate" };
    },
  };
}

function goDirectory(file: string): string {
  return path.posix.dirname(file.split(path.sep).join("/"));
}

function createPackageFormatLookup(options: RefreshOptions): {
  forFile(file: string): Promise<PackageFormat>;
  match(dependencies: ReadonlyMap<string, JavaScriptGraphDependency>): Promise<boolean>;
} {
  const { materializedRoot: root, toMaterializedPath, fileBatchLimits, signal } = options;
  // Scope format evidence to this refresh, including cached missing manifests.
  const formats = new Map<string, Promise<PackageFormat>>();
  function directoryForFile(file: string): string | undefined {
    const materializedPath = toMaterializedPath(file);
    return isPathWithinRoot(materializedPath, root) ? path.dirname(materializedPath) : undefined;
  }
  function forDirectory(directory: string | undefined): Promise<PackageFormat> {
    if (directory === undefined) return Promise.resolve("unknown");
    const cached = formats.get(directory);
    if (cached) return cached;
    const lookup = (async (): Promise<PackageFormat> => {
      throwIfOperationAborted(signal);
      const content = await readBoundedManifest(directory, root, signal);
      if (content === null) return "unknown";
      if (content !== undefined) return declaredPackageFormat(content);
      const parent = path.dirname(directory);
      if (parent === directory || !isPathWithinRoot(parent, root)) return "unknown";
      return forDirectory(parent);
    })();
    formats.set(directory, lookup);
    return lookup;
  }
  return {
    forFile: (file) => forDirectory(directoryForFile(file)),
    async match(dependencies) {
      const expectedFormats = new Map<string | undefined, PackageFormat>();
      for (const [file, { format }] of dependencies) {
        if (format === undefined) continue;
        const directory = directoryForFile(file);
        const expected = expectedFormats.get(directory);
        if (expected !== undefined && expected !== format) return false;
        expectedFormats.set(directory, format);
      }
      for (const batch of iterateOrderedFileBatches(expectedFormats, () => PACKAGE_MANIFEST_MAX_BYTES, fileBatchLimits)) {
        const matches = await Promise.all(batch.map(async ([directory, expected]) =>
          await forDirectory(directory) === expected
        ));
        if (matches.includes(false)) return false;
      }
      return true;
    },
  };
}

async function readBoundedManifest(directory: string, root: string, signal?: AbortSignal): Promise<string | undefined | null> {
  const manifestPath = path.join(directory, "package.json");
  let realManifest: string;
  try {
    const realDirectory = await fs.realpath(directory);
    if (!isPathWithinRoot(realDirectory, root)) return null;
    realManifest = await fs.realpath(manifestPath);
  } catch (error) {
    if (isOperationInterruption(error)) throw error;
    return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
      ? undefined
      : null;
  }
  if (!isPathWithinRoot(realManifest, root)) return null;
  const stats = await fs.lstat(realManifest).catch((error: unknown) => {
    if (isOperationInterruption(error)) throw error;
    return undefined;
  });
  if (!stats || !stats.isFile() || stats.size > PACKAGE_MANIFEST_MAX_BYTES) return null;
  const handle = await fs.open(realManifest, "r").catch((error: unknown) => {
    if (isOperationInterruption(error)) throw error;
    return undefined;
  });
  if (!handle) return null;
  let content: string | null = null;
  let interruption: unknown;
  try {
    const openedStats = await handle.stat();
    throwIfOperationAborted(signal);
    if (openedStats.isFile() && openedStats.size <= PACKAGE_MANIFEST_MAX_BYTES
      && openedStats.dev === stats.dev && openedStats.ino === stats.ino) {
      // One spare byte proves EOF and rejects growth beyond the observed size.
      const buffer = Buffer.alloc(openedStats.size + 1);
      let offset = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        throwIfOperationAborted(signal);
        if (bytesRead === 0) {
          content = buffer.subarray(0, offset).toString("utf8");
          break;
        }
        offset += bytesRead;
        if (offset > openedStats.size) break;
      }
    }
  } catch (error: unknown) {
    if (isOperationInterruption(error)) interruption = error;
  } finally {
    try {
      await handle.close();
    } catch (error: unknown) {
      if (interruption === undefined && isOperationInterruption(error)) interruption = error;
    }
  }
  if (interruption !== undefined) throw interruption;
  return content;
}
