import { accessSync, constants, existsSync, lstatSync, statSync, type Stats } from "fs";
import { stat } from "node:fs/promises";
import { FSWatcher } from "chokidar";
import * as path from "path";

import type { HostMode } from "../config/host.js";
import type { CodebaseIndexConfig } from "../config/schema.js";
import { getProjectConfigCandidatePaths, resolveProjectIndexPath } from "../config/paths.js";
import { isJavaScriptFamilyFilePath } from "../indexer/local-module-resolution.js";
import {
  createGitIgnoreFilter,
  createIgnoreFilter,
  shouldIncludeFile,
  shouldTraverseDirectory,
  type PathFilterOptions,
} from "../utils/files.js";
import {
  LocalModuleConfigTracker,
  shouldTrackLocalModuleConfigPath,
} from "./local-module-config.js";
import { NativeRecursiveWatcher } from "./native-recursive-watcher.js";
import { FileSnapshotReconciler, type SnapshotInvalidation } from "./snapshot-reconciler.js";
import { buildFileSnapshotScan, isWithinPath, type FileSnapshotScan } from "./snapshot.js";

export type FileChangeType = "add" | "change" | "unlink";

export interface FileChange {
  type: FileChangeType;
  path: string;
}

export type ChangeHandler = (changes: FileChange[]) => Promise<void>;
export type FileWatcherBackend = "auto" | "chokidar" | "native";

export interface FileWatcherOptions {
  backend?: FileWatcherBackend;
  configPath?: string;
  indexPath?: string;
}

interface ConfigPathState {
  mtimeMs: number;
  size: number;
}

interface ChokidarRecovery {
  watcher: FSWatcher;
  previousPaths: ReadonlySet<string>;
  liveChanges: Map<string, FileChangeType>;
  configOnly: boolean;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private activeCallbacks = 0;
  private projectRoot: string;
  private config: CodebaseIndexConfig;
  private configPath: string | undefined;
  private indexPath: string;
  private backend: FileWatcherBackend;
  private projectConfigPaths: string[];
  private pendingChanges: Map<string, FileChangeType> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 1000;
  private onChanges: ChangeHandler | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private pollingFallbackAttempted = false;
  private pendingClose: Promise<void> | null = null;
  private chokidarRecovery: ChokidarRecovery | null = null;
  private recoveryTask: Promise<void> | null = null;
  private startupReadySignals = 1;
  private nativeWatcher: NativeRecursiveWatcher | null = null;
  private nativeReconciler: FileSnapshotReconciler | null = null;
  private nativeSetupGeneration = 0;
  private nativeStarting = false;
  private nativeInitializing = false;
  private nativeReconcileTimer: NodeJS.Timeout | null = null;
  private nativeInvalidatedPaths: Map<string | null, boolean> = new Map();
  private configPathStates: Map<string, ConfigPathState> = new Map();
  private localModuleConfigTracker: LocalModuleConfigTracker;

  constructor(projectRoot: string, config: CodebaseIndexConfig, host: HostMode, options: FileWatcherOptions = {}) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.backend = options.backend ?? "auto";
    this.configPath = options.configPath;
    this.indexPath = path.resolve(options.indexPath ?? resolveProjectIndexPath(projectRoot, config.scope, host));
    this.projectConfigPaths = options.configPath
      ? [options.configPath]
      : getProjectConfigCandidatePaths(projectRoot, host);
    this.localModuleConfigTracker = new LocalModuleConfigTracker(projectRoot, this.getSnapshotConfig());
  }

  start(handler: ChangeHandler): void {
    if (this.watcher || this.nativeWatcher || this.nativeStarting) {
      return;
    }

    this.onChanges = handler;
    this.refreshLocalModuleConfigTracker();
    this.pollingFallbackAttempted = false;
    this.resetReady();
    if (this.shouldUseNativeWatcher()) {
      if (this.hasExternalConfigWatchTarget()) {
        this.setStartupReadySignals(2);
        this.startExternalConfigWatcher();
      }
      this.nativeStarting = true;
      void this.createNativeWatcher();
      return;
    }
    this.createWatcher();
  }

  private resetReady(): void {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.startupReadySignals = 1;
  }

  private setStartupReadySignals(expectedSignals: number): void {
    if (!this.readyPromise) {
      return;
    }

    this.startupReadySignals = Math.max(0, expectedSignals);
  }

  private reportStartupReadySignal(): void {
    if (!this.readyPromise || !this.resolveReady) {
      return;
    }

    if (this.startupReadySignals <= 0) {
      return;
    }

    this.startupReadySignals -= 1;
    if (this.startupReadySignals !== 0) {
      return;
    }

    this.resolveReady();
    this.resolveReady = null;
  }

  private createWatcher(
    watchTargets?: string | string[],
    usePolling = false,
    reportsStartupReady = true,
    recoveryPaths?: ReadonlySet<string>,
  ): void {
    let reportedStartupReady = false;
    // Backend cutover invalidates the old scan owner, but not its already-observed changes.
    const previousRecovery = this.chokidarRecovery;
    this.chokidarRecovery = null;
    if (previousRecovery) {
      const selected = this.getChokidarRecoveryPathFilter();
      this.recordChanges([...previousRecovery.liveChanges]
        .filter(([filePath]) => previousRecovery.configOnly
          ? this.isProjectConfigPath(filePath)
          : previousRecovery.previousPaths.has(filePath) || selected(filePath))
        .map(([filePath, type]) => ({ path: filePath, type })));
    }
    this.refreshLocalModuleConfigTracker();
    if (!usePolling && !previousRecovery) this.configPathStates = this.getConfigPathStates();
    const ignoreFilter = createIgnoreFilter(this.projectRoot);
    const gitIgnoreFilter = createGitIgnoreFilter(this.projectRoot);
    const includeIgnored = this.config.indexing?.includeIgnored ?? [];
    const filterOptions = this.getPathFilterOptions();
    const resolvedWatchTargets = watchTargets ?? this.getFullChokidarWatchTargets();

    const watcherOptions = {
      ignored: (filePath: string, stats?: Stats) => {
        const relativePath = path.relative(this.projectRoot, filePath);
        if (!relativePath) return false;

        if (this.isProjectConfigPathOrAncestor(relativePath)) {
          return false;
        }

        if (this.isOutsideProjectPath(relativePath)) {
          return true;
        }

        if (this.localModuleConfigTracker.hasPathOrAncestor(filePath)) {
          return false;
        }

        if (stats?.isFile() || (!stats && this.isExistingFile(filePath))) {
          return false;
        }

        return !shouldTraverseDirectory(
          filePath,
          this.projectRoot,
          this.config.exclude,
          ignoreFilter,
          includeIgnored,
          gitIgnoreFilter,
          filterOptions,
        );
      },
      persistent: true,
      ignoreInitial: true,
      ...(usePolling ? { usePolling: true } : {}),
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    };
    let watcher: FSWatcher;
    if (usePolling) {
      const previousUsePolling = process.env.CHOKIDAR_USEPOLLING;
      process.env.CHOKIDAR_USEPOLLING = "true";
      try {
        watcher = new FSWatcher(watcherOptions);
      } finally {
        if (previousUsePolling === undefined) {
          delete process.env.CHOKIDAR_USEPOLLING;
        } else {
          process.env.CHOKIDAR_USEPOLLING = previousUsePolling;
        }
      }
    } else {
      watcher = new FSWatcher(watcherOptions);
    }
    this.watcher = watcher;
    if (recoveryPaths) {
      this.chokidarRecovery = {
        watcher, previousPaths: recoveryPaths, liveChanges: new Map(),
        configOnly: this.nativeWatcher !== null || this.nativeStarting,
      };
    }
    watcher.on("ready", () => {
      if (this.watcher !== watcher) return;
      const recovery = this.chokidarRecovery;
      if (recovery?.watcher === watcher) {
        this.recoveryTask = this.reconcileChokidarRecovery(recovery);
      } else {
        this.reconcileConfigPathStates();
      }
      if (reportsStartupReady) {
        this.reportStartupReadySignal();
        reportedStartupReady = true;
      }
    });

    watcher.on("error", (error: unknown) => {
      const err = error instanceof Error ? (error as NodeJS.ErrnoException) : null;
      let recoverablePermissionError = false;
      if (err?.code === "EPERM" || err?.code === "EACCES") {
        if (
          this.watcher !== watcher
          || watcher.options.usePolling
          || this.pollingFallbackAttempted
          || !this.canRecoverSourceWatchPermissionError(err)
        ) {
          // Restricted, unreadable, unselected, and unidentified targets remain ignored.
          return;
        }
        recoverablePermissionError = true;
      }

      if (
        (err?.code === "EMFILE" || recoverablePermissionError)
        && !watcher.options.usePolling
        && !this.pollingFallbackAttempted
        && this.watcher === watcher
      ) {
        this.pollingFallbackAttempted = true;
        console.warn(recoverablePermissionError
          ? "[codebase-index] File watcher could not watch a readable selected source; retrying with polling."
          : "[codebase-index] File watcher exhausted open file handles; retrying with polling.");
        // Capture before close clears Chokidar's inventory, including files deleted during replacement.
        const recoveryPaths = this.nativeWatcher || this.nativeStarting
          ? new Set(this.configPathStates.keys())
          : this.getChokidarRecoveryPaths(watcher);
        this.pendingClose = watcher.close().catch((closeError: unknown) => {
          console.error("[codebase-index] Failed to close file watcher before polling recovery:", closeError);
        });
        if (this.onChanges) {
          const replacementReportsStartupReady = reportsStartupReady || reportedStartupReady;
          if (!this.resolveReady) {
            this.resetReady();
          } else if (reportedStartupReady) {
            this.startupReadySignals += 1;
          }
          this.createWatcher(resolvedWatchTargets, true, replacementReportsStartupReady, recoveryPaths);
        } else {
          this.watcher = null;
        }
        return;
      }

      console.error("[codebase-index] Watcher error:", err?.message ?? error);
    });

    watcher.on("add", (filePath) => this.handleChange(watcher, "add", filePath));
    watcher.on("change", (filePath) => this.handleChange(watcher, "change", filePath));
    watcher.on("unlink", (filePath) => this.handleChange(watcher, "unlink", filePath));
    watcher.add(resolvedWatchTargets);
  }

  private canRecoverSourceWatchPermissionError(error: NodeJS.ErrnoException): boolean {
    if (error.syscall !== "watch" || typeof error.path !== "string" || !path.isAbsolute(error.path)) return false;

    const projectRoot = path.resolve(this.projectRoot);
    const filePath = path.resolve(error.path);
    const relativePath = path.relative(projectRoot, filePath);
    if (!relativePath || this.isOutsideProjectPath(relativePath)) return false;

    const ignoreFilter = createIgnoreFilter(projectRoot);
    const gitIgnoreFilter = createGitIgnoreFilter(projectRoot);
    const includeIgnored = this.config.indexing?.includeIgnored ?? [];
    const filterOptions = this.getPathFilterOptions();
    if (
      this.isProjectConfigPath(filePath)
      || this.localModuleConfigTracker.has(filePath)
      || shouldTrackLocalModuleConfigPath(filePath, projectRoot, ignoreFilter, this.getSnapshotConfig())
      || (path.basename(filePath).toLowerCase() === "package.json"
        && this.localModuleConfigTracker.shouldTrackPackagePath(filePath))
      || !shouldIncludeFile(
        filePath, projectRoot, [...this.config.include, ...(this.config.additionalInclude ?? [])],
        this.config.exclude, ignoreFilter, includeIgnored, gitIgnoreFilter, filterOptions,
      )
    ) return false;

    try {
      if (!lstatSync(filePath).isFile()) return false;
      accessSync(filePath, constants.R_OK);
      let directory = path.dirname(filePath);
      for (;;) {
        if (!shouldTraverseDirectory(
          directory, projectRoot, this.config.exclude, ignoreFilter, includeIgnored, gitIgnoreFilter, filterOptions,
        ) || !lstatSync(directory).isDirectory()) return false;
        accessSync(directory, constants.R_OK | constants.X_OK);
        if (path.relative(projectRoot, directory) === "") return true;
        const parent = path.dirname(directory);
        if (parent === directory) return false;
        directory = parent;
      }
    } catch {
      return false;
    }
  }

  private getChokidarRecoveryPathFilter(): (filePath: string) => boolean {
    const ignoreFilter = createIgnoreFilter(this.projectRoot);
    const gitIgnoreFilter = createGitIgnoreFilter(this.projectRoot);
    const includePatterns = [...this.config.include, ...(this.config.additionalInclude ?? [])];
    const includeIgnored = this.config.indexing?.includeIgnored ?? [];
    const options = this.getPathFilterOptions();
    const snapshotConfig = this.getSnapshotConfig();
    return (filePath) => {
      if (this.isProjectConfigPath(filePath) || this.localModuleConfigTracker.has(filePath)) return true;
      if (this.isOutsideProjectPath(path.relative(this.projectRoot, filePath))) return false;
      return (path.extname(filePath).toLowerCase() === ".json" && (
        shouldTrackLocalModuleConfigPath(filePath, this.projectRoot, ignoreFilter, snapshotConfig)
        || (path.basename(filePath) === "package.json" && this.localModuleConfigTracker.shouldTrackPackagePath(filePath))
      )) || shouldIncludeFile(
        filePath, this.projectRoot, includePatterns, this.config.exclude,
        ignoreFilter, includeIgnored, gitIgnoreFilter, options,
      );
    };
  }

  private getChokidarRecoveryPaths(watcher: FSWatcher): ReadonlySet<string> {
    const watched = watcher.getWatched();
    const directories = new Set(Object.keys(watched));
    const selected = this.getChokidarRecoveryPathFilter();
    const paths = new Set([
      ...this.configPathStates.keys(),
      ...this.localModuleConfigTracker.getPaths().filter((filePath) => this.isExistingFile(filePath)),
    ]);
    for (const [directory, names] of Object.entries(watched)) {
      for (const name of names) {
        const filePath = path.join(directory, name);
        if (!directories.has(filePath) && selected(filePath) && !this.isExistingDirectory(filePath)) {
          paths.add(filePath);
        }
      }
    }
    return paths;
  }

  private async getRecoveryFileState(filePath: string): Promise<ConfigPathState | "missing" | "unreadable"> {
    try {
      const state = await stat(filePath);
      return state.isFile() ? { size: state.size, mtimeMs: state.mtimeMs } : "missing";
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return "missing";
        if (error.code === "EACCES" || error.code === "EPERM") return "unreadable";
      }
      throw error;
    }
  }

  private async scanChokidarRecovery(recovery: ChokidarRecovery): Promise<FileSnapshotScan> {
    if (!recovery.configOnly) {
      return buildFileSnapshotScan(
        this.projectRoot, this.getSnapshotConfig(),
        [...this.projectConfigPaths, ...this.localModuleConfigTracker.getPaths()],
      );
    }
    const entries = new Map<string, ConfigPathState>();
    const unreadablePrefixes = new Set<string>();
    for (const filePath of this.projectConfigPaths) {
      const state = await this.getRecoveryFileState(filePath);
      if (state === "unreadable") unreadablePrefixes.add(filePath);
      else if (state !== "missing") entries.set(filePath, state);
    }
    return { entries, unreadablePrefixes };
  }

  private async reconcileChokidarRecovery(recovery: ChokidarRecovery): Promise<void> {
    try {
      const scan = await this.scanChokidarRecovery(recovery);
      if (this.chokidarRecovery !== recovery || this.watcher !== recovery.watcher) return;
      const changes = new Map<string, FileChangeType>();
      for (const filePath of scan.entries.keys()) {
        changes.set(filePath, recovery.previousPaths.has(filePath) ? "change" : "add");
      }
      const unreadablePrefixes = [...scan.unreadablePrefixes];
      const recoveredConfigStates = new Map<string, ConfigPathState>();
      for (const filePath of recovery.previousPaths) {
        if (scan.entries.has(filePath) || unreadablePrefixes.some((prefix) => isWithinPath(prefix, filePath))) continue;
        // A filtered snapshot omission is not evidence of deletion (depth, traversal, symlinks).
        const state = await this.getRecoveryFileState(filePath);
        if (this.chokidarRecovery !== recovery || this.watcher !== recovery.watcher) return;
        if (state === "missing") changes.set(filePath, "unlink");
        else if (state !== "unreadable") {
          changes.set(filePath, "change");
          if (this.isProjectConfigPath(filePath)) recoveredConfigStates.set(filePath, state);
        }
      }
      if (this.chokidarRecovery !== recovery || this.watcher !== recovery.watcher) return;

      // Refresh once for new importers/dependencies before filtering buffered events.
      if (!recovery.configOnly) this.refreshLocalModuleConfigTracker(recovery.watcher);
      const selected = this.getChokidarRecoveryPathFilter();
      for (const [filePath, type] of recovery.liveChanges) {
        if ((recovery.configOnly && this.isProjectConfigPath(filePath))
          || (!recovery.configOnly && (recovery.previousPaths.has(filePath) || selected(filePath)))) {
          changes.set(filePath, type);
        }
      }
      for (const filePath of this.projectConfigPaths) {
        // Buffered config events already updated the state; don't replace it with older scan metadata.
        if (recovery.liveChanges.has(filePath)) continue;
        const state = scan.entries.get(filePath) ?? recoveredConfigStates.get(filePath);
        if (state) this.configPathStates.set(filePath, state);
        else if (changes.get(filePath) === "unlink") this.configPathStates.delete(filePath);
      }
      // No async gap between overlaying newer events and handing delivery back to the live watcher.
      this.chokidarRecovery = null;
      this.recordChanges([...changes].map(([filePath, type]) => ({ path: filePath, type })));
      if (this.pendingChanges.size > 0) this.scheduleFlush();
    } catch (error) {
      if (this.chokidarRecovery !== recovery) return;
      console.error("[codebase-index] Failed to reconcile polling watcher replacement:", error);
      this.chokidarRecovery = null;
      for (const [filePath, type] of recovery.liveChanges) this.handleChange(recovery.watcher, type, filePath);
      if (this.pendingChanges.size > 0) this.scheduleFlush();
    }
  }

  private shouldUseNativeWatcher(): boolean {
    if (this.backend === "chokidar") {
      return false;
    }

    return true;
  }

  private getFullChokidarWatchTargets(): string | string[] {
    if (this.configPath) {
      return [this.projectRoot, this.configPath];
    }

    const externalConfigTargets = this.getExternalConfigWatchTargets();
    if (externalConfigTargets.length === 0) {
      return this.projectRoot;
    }

    return [this.projectRoot, ...externalConfigTargets];
  }

  private getExternalConfigWatchTargets(): string[] {
    return [...new Set(this.projectConfigPaths
      .filter((projectConfigPath) => {
        const relativeConfigPath = path.relative(this.projectRoot, projectConfigPath);
        return this.isOutsideProjectPath(relativeConfigPath);
      })
      .map((projectConfigPath) => {
        if (existsSync(projectConfigPath)) {
          return projectConfigPath;
        }

        return this.getNearestExistingDirectory(path.dirname(projectConfigPath));
      }),
    )];
  }

  private hasExternalConfigWatchTarget(): boolean {
    return this.getExternalConfigWatchTargets().length > 0;
  }

  private startExternalConfigWatcher(usePolling = false): void {
    const externalTargets = this.getExternalConfigWatchTargets();
    if (externalTargets.length === 0) {
      return;
    }

    this.createWatcher(externalTargets, usePolling);
  }

  private async createNativeWatcher(): Promise<void> {
    const generation = ++this.nativeSetupGeneration;
    const reconciler = new FileSnapshotReconciler(
      this.projectRoot,
      this.getSnapshotConfig(),
      () => [...this.projectConfigPaths, ...this.localModuleConfigTracker.getPaths()],
    );
    const watcher = new NativeRecursiveWatcher(
      this.projectRoot,
      (filePath) => this.scheduleNativeReconciliation(generation, filePath),
      { onError: (error) => void this.fallbackFromNativeWatcher(generation, error) },
    );

    this.nativeReconciler = reconciler;
    this.nativeWatcher = watcher;
    this.nativeInitializing = true;

    try {
      watcher.start();
      if (!this.isCurrentNativeSetup(generation)) {
        await watcher.stop();
        return;
      }

      await reconciler.initialize();
      if (!this.isCurrentNativeSetup(generation) || this.nativeWatcher !== watcher) {
        await watcher.stop();
        return;
      }

      this.nativeStarting = false;
      this.nativeInitializing = false;
      await this.reconcileNativeWatcherWithPendingInvalidations(generation);
      this.reportStartupReadySignal();
    } catch (error) {
      if (!this.isCurrentNativeSetup(generation)) return;
      this.nativeInitializing = false;
      if (this.nativeWatcher) {
        await this.fallbackFromNativeWatcher(generation, error);
        return;
      }

      this.nativeStarting = false;
      const externalWatcher = this.watcher;
      this.watcher = null;
      this.nativeReconciler = null;
      await externalWatcher?.close();
      console.warn("[codebase-index] Native recursive watcher unavailable; using Chokidar fallback.", error);
      this.setStartupReadySignals(1);
      this.createWatcher();
    }
  }

  private isCurrentNativeSetup(generation: number): boolean {
    return this.nativeSetupGeneration === generation && this.onChanges !== null;
  }

  private scheduleNativeReconciliation(generation: number, filePath: string | null): void {
    if (!this.isCurrentNativeSetup(generation)) return;

    if (filePath !== null && filePath !== path.join(this.projectRoot, ".gitignore")) {
      const relativePath = path.relative(this.projectRoot, filePath);
      const traversalPath = this.isExistingDirectory(filePath) ? filePath : path.dirname(filePath);
      const traversalRelativePath = path.relative(this.projectRoot, traversalPath);
      // Match snapshot filtering before scheduling work: internal lease heartbeats
      // must not count as watcher activity and keep an idle MCP engine alive.
      if (!this.isProjectConfigPathOrAncestor(relativePath)
        && traversalRelativePath !== ""
        && !shouldTraverseDirectory(
          traversalPath,
          this.projectRoot,
          this.config.exclude,
          createIgnoreFilter(this.projectRoot),
          this.config.indexing?.includeIgnored ?? [],
          createGitIgnoreFilter(this.projectRoot),
          this.getPathFilterOptions(),
        )
        && !this.localModuleConfigTracker.hasPathOrAncestor(filePath)) return;
    }

    if (
      filePath === null
      || filePath === path.join(this.projectRoot, ".gitignore")
      || (filePath !== null && (
        shouldTrackLocalModuleConfigPath(
          filePath,
          this.projectRoot,
          createIgnoreFilter(this.projectRoot),
          this.getSnapshotConfig(),
        )
        || this.localModuleConfigTracker.shouldTrackPackagePath(filePath)
        || this.localModuleConfigTracker.has(filePath)
      ))
    ) {
      this.refreshLocalModuleConfigTracker();
    }

    const requiresFullReconciliation = filePath === path.join(this.projectRoot, ".gitignore");
    const invalidatedPath = requiresFullReconciliation ? null : filePath;
    this.nativeInvalidatedPaths.set(invalidatedPath, invalidatedPath !== null);

    if (this.nativeReconcileTimer) {
      clearTimeout(this.nativeReconcileTimer);
    }
    this.nativeReconcileTimer = setTimeout(() => {
      this.nativeReconcileTimer = null;
      void this.reconcileNativeWatcherFromQueue(generation);
    }, 100);
  }

  private reconcileNativeWatcherFromQueue(generation: number): void {
    if (!this.isCurrentNativeSetup(generation) || this.nativeInitializing) return;

    const invalidatedPaths = this.popNativeInvalidations();
    if (invalidatedPaths.length === 0) return;

    void this.reconcileNativeWatcher(generation, invalidatedPaths);
  }

  private async reconcileNativeWatcher(generation: number, invalidatedPaths: readonly SnapshotInvalidation[]): Promise<void> {
    if (!this.isCurrentNativeSetup(generation) || !this.nativeReconciler) return;

    this.activeCallbacks += 1;
    try {
      const reconciler = this.nativeReconciler;
      const changes = await reconciler.reconcile(invalidatedPaths);
      if (!this.isCurrentNativeSetup(generation) || this.nativeReconciler !== reconciler) return;

      const ignoreFilter = createIgnoreFilter(this.projectRoot);
      const hasLocalModuleDependencyChange = changes.some((change) => (
        shouldTrackLocalModuleConfigPath(
          change.path,
          this.projectRoot,
          ignoreFilter,
          this.getSnapshotConfig(),
        )
        || this.localModuleConfigTracker.shouldTrackPackagePath(change.path)
        || this.localModuleConfigTracker.has(change.path)
      ));
      const hasSelectedImporterSetChange = changes.some((change) => (
        this.isSelectedJavaScriptPath(change.path)
        && (
          change.type === "add"
          || change.type === "unlink"
          || !this.localModuleConfigTracker.hasImporterPath(change.path)
        )
      ));
      if (hasLocalModuleDependencyChange || hasSelectedImporterSetChange) {
        this.refreshLocalModuleConfigTracker();
      }
      this.recordChanges(changes);
    } catch (error) {
      await this.fallbackFromNativeWatcher(generation, error);
    } finally {
      this.activeCallbacks -= 1;
    }
  }

  private async reconcileNativeWatcherWithPendingInvalidations(generation: number): Promise<void> {
    const invalidatedPaths = this.popNativeInvalidations();
    if (invalidatedPaths.length === 0) return;

    await this.reconcileNativeWatcher(generation, invalidatedPaths);
  }

  private popNativeInvalidations(): SnapshotInvalidation[] {
    if (this.nativeInvalidatedPaths.size === 0) return [];

    const invalidations = [...this.nativeInvalidatedPaths].map(([invalidatedPath, forceChange]) => ({
      path: invalidatedPath,
      forceChange,
    }));
    this.nativeInvalidatedPaths.clear();
    return invalidations;
  }

  private async fallbackFromNativeWatcher(generation: number, error: unknown): Promise<void> {
    if (!this.isCurrentNativeSetup(generation)) return;

    const watcher = this.nativeWatcher;
    const externalWatcher = this.watcher;
    this.nativeWatcher = null;
    this.watcher = null;
    this.nativeReconciler = null;
    this.nativeStarting = false;
    this.nativeInitializing = false;
    this.nativeSetupGeneration += 1;
    if (this.nativeReconcileTimer) {
      clearTimeout(this.nativeReconcileTimer);
      this.nativeReconcileTimer = null;
    }
    this.nativeInvalidatedPaths.clear();
    this.setStartupReadySignals(1);

    console.warn("[codebase-index] Native recursive watcher failed; using Chokidar fallback.", error);
    await watcher?.stop();
    await externalWatcher?.close();
    if (this.onChanges) {
      this.createWatcher();
    }
  }

  private handleChange(watcher: FSWatcher, type: FileChangeType, filePath: string): void {
    if (this.watcher !== watcher) {
      return;
    }

    if (this.chokidarRecovery?.watcher === watcher) {
      this.chokidarRecovery.liveChanges.set(filePath, type);
      if (this.isProjectConfigPath(filePath)) {
        if (type === "unlink") this.configPathStates.delete(filePath);
        else {
          const state = this.getConfigPathState(filePath);
          if (state) this.configPathStates.set(filePath, state);
        }
      }
      return;
    }

    if (this.isProjectConfigPath(filePath)) {
      this.updateConfigPathState(filePath);
      this.pendingChanges.set(filePath, type);
      this.scheduleFlush();
      return;
    }

    if (
      shouldTrackLocalModuleConfigPath(
        filePath,
        this.projectRoot,
        createIgnoreFilter(this.projectRoot),
        this.getSnapshotConfig(),
      )
      || this.localModuleConfigTracker.shouldTrackPackagePath(filePath)
      || this.localModuleConfigTracker.has(filePath)
    ) {
      this.refreshLocalModuleConfigTracker(watcher);
      this.pendingChanges.set(filePath, type);
      this.scheduleFlush();
      return;
    }

    if (!this.isSelectedSourcePath(filePath)) {
      return;
    }

    if (
      isJavaScriptFamilyFilePath(filePath)
      && (type === "add" || type === "unlink" || !this.localModuleConfigTracker.hasImporterPath(filePath))
    ) {
      this.refreshLocalModuleConfigTracker(watcher);
    }

    this.recordChanges([{ path: filePath, type }]);
  }

  private recordChanges(changes: FileChange[]): void {
    if (changes.length === 0) return;

    for (const change of changes) {
      this.pendingChanges.set(change.path, change.type);
    }
    this.scheduleFlush();
  }

  private getPathFilterOptions(): PathFilterOptions {
    return {
      includeExcluded: this.config.indexing?.includeExcluded ?? [],
      protectedPaths: [this.indexPath],
      purpose: "watch",
    };
  }

  private isSelectedSourcePath(filePath: string): boolean {
    const includePatterns = [...this.config.include, ...(this.config.additionalInclude ?? [])];
    return shouldIncludeFile(
      filePath,
      this.projectRoot,
      includePatterns,
      this.config.exclude,
      createIgnoreFilter(this.projectRoot),
      this.config.indexing?.includeIgnored ?? [],
      createGitIgnoreFilter(this.projectRoot),
      this.getPathFilterOptions(),
    );
  }

  private isSelectedJavaScriptPath(filePath: string): boolean {
    return isJavaScriptFamilyFilePath(filePath) && this.isSelectedSourcePath(filePath);
  }

  private refreshLocalModuleConfigTracker(watcher?: FSWatcher): void {
    const previousPaths = new Set(this.localModuleConfigTracker.getPaths());
    this.localModuleConfigTracker.refresh();
    const nextPaths = this.localModuleConfigTracker.getPaths();
    const changed = previousPaths.size !== nextPaths.length
      || nextPaths.some((trackedPath) => !previousPaths.has(trackedPath));
    if (changed && watcher && this.watcher === watcher) {
      const watchPaths = this.localModuleConfigTracker.getWatchPaths();
      if (watchPaths.length > 0) watcher.add([...watchPaths]);
    }
  }

  private isExistingFile(filePath: string): boolean {
    try {
      return statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  private isExistingDirectory(filePath: string): boolean {
    try {
      return statSync(filePath).isDirectory();
    } catch {
      return false;
    }
  }

  private getSnapshotConfig(): CodebaseIndexConfig & { protectedPaths: string[] } {
    return { ...this.config, protectedPaths: [this.indexPath] };
  }

  private isProjectConfigPath(filePath: string): boolean {
    const relativePath = path.relative(this.projectRoot, filePath);
    const normalizedRelativePath = path.normalize(relativePath);
    return this.getProjectConfigRelativePaths().some((configPath) => configPath === normalizedRelativePath);
  }

  private isProjectConfigPathOrAncestor(relativePath: string): boolean {
    const normalizedRelativePath = path.normalize(relativePath);
    return this.getProjectConfigRelativePaths().some(
      (configPath) => configPath === normalizedRelativePath || configPath.startsWith(`${normalizedRelativePath}${path.sep}`),
    );
  }

  private isOutsideProjectPath(relativePath: string): boolean {
    return relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath);
  }

  private getNearestExistingDirectory(directoryPath: string): string {
    let candidate = directoryPath;
    while (!existsSync(candidate)) {
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    return candidate;
  }

  private getProjectConfigRelativePaths(): string[] {
    return this.projectConfigPaths.map(
      (configPath) => path.normalize(path.relative(this.projectRoot, configPath)),
    );
  }

  private getConfigPathStates(): Map<string, ConfigPathState> {
    const states = new Map<string, ConfigPathState>();
    for (const configPath of this.projectConfigPaths) {
      const state = this.getConfigPathState(configPath);
      if (state) states.set(configPath, state);
    }
    return states;
  }

  private getConfigPathState(configPath: string): ConfigPathState | undefined {
    try {
      const stats = statSync(configPath);
      return stats.isFile() ? { mtimeMs: stats.mtimeMs, size: stats.size } : undefined;
    } catch (error: unknown) {
      // A config file may disappear between the watch event and this stat.
      void error;
      return undefined;
    }
  }

  private updateConfigPathState(configPath: string): void {
    const state = this.getConfigPathState(configPath);
    if (state) {
      this.configPathStates.set(configPath, state);
    } else {
      this.configPathStates.delete(configPath);
    }
  }

  private reconcileConfigPathStates(): void {
    const nextStates = this.getConfigPathStates();
    const changes: FileChange[] = [];
    for (const configPath of this.projectConfigPaths) {
      const previous = this.configPathStates.get(configPath);
      const next = nextStates.get(configPath);
      if (!previous && next) {
        changes.push({ path: configPath, type: "add" });
      } else if (previous && !next) {
        changes.push({ path: configPath, type: "unlink" });
      } else if (previous && next && (previous.size !== next.size || previous.mtimeMs !== next.mtimeMs)) {
        changes.push({ path: configPath, type: "change" });
      }
    }
    this.configPathStates = nextStates;
    this.recordChanges(changes);
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  isBusy(): boolean {
    return this.activeCallbacks > 0 || this.resolveReady !== null || this.nativeStarting
      || this.nativeInitializing || this.nativeInvalidatedPaths.size > 0
      || this.chokidarRecovery !== null
      || this.nativeReconcileTimer !== null || this.pendingChanges.size > 0;
  }

  private async flush(): Promise<void> {
    if (this.pendingChanges.size === 0 || !this.onChanges || this.chokidarRecovery !== null) {
      return;
    }

    const changes: FileChange[] = Array.from(this.pendingChanges.entries()).map(
      ([path, type]) => ({ path, type })
    );

    this.pendingChanges.clear();

    try {
      this.activeCallbacks += 1;
      await this.onChanges(changes);
    } catch (error) {
      console.error("Error handling file changes:", error);
    } finally {
      this.activeCallbacks -= 1;
    }
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.nativeReconcileTimer) {
      clearTimeout(this.nativeReconcileTimer);
      this.nativeReconcileTimer = null;
    }
    this.nativeInvalidatedPaths.clear();

    const watcher = this.watcher;
    const nativeWatcher = this.nativeWatcher;
    const pendingClose = this.pendingClose;
    const recoveryTask = this.recoveryTask;
    this.chokidarRecovery = null;
    this.recoveryTask = null;
    const resolveReady = this.resolveReady;
    this.watcher = null;
    this.nativeWatcher = null;
    this.nativeReconciler = null;
    this.nativeStarting = false;
    this.nativeInitializing = false;
    this.nativeSetupGeneration += 1;
    this.pendingClose = null;
    this.resolveReady = null;
    this.readyPromise = null;
    this.pendingChanges.clear();
    this.onChanges = null;
    await Promise.all([watcher?.close(), nativeWatcher?.stop(), pendingClose, recoveryTask]);

    resolveReady?.();
  }

  isRunning(): boolean {
    return this.watcher !== null || this.nativeWatcher !== null || this.nativeStarting;
  }

  async waitUntilReady(): Promise<void> {
    let ready = this.readyPromise;
    while (ready) {
      await ready;
      // An EMFILE polling fallback replaces the promise while the first ready is still resolving.
      if (this.readyPromise === ready) return;
      ready = this.readyPromise;
    }
  }
}
