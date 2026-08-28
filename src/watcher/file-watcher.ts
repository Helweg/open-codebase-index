import { existsSync, statSync } from "fs";
import { FSWatcher } from "chokidar";
import * as path from "path";

import type { HostMode } from "../config/host.js";
import type { CodebaseIndexConfig } from "../config/schema.js";
import { getProjectConfigCandidatePaths } from "../config/paths.js";
import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";
import { LocalModuleConfigTracker, shouldTrackLocalModuleConfigPath } from "./local-module-config.js";
import { NativeRecursiveWatcher } from "./native-recursive-watcher.js";
import { FileSnapshotReconciler, type SnapshotInvalidation } from "./snapshot-reconciler.js";

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
}

interface ConfigPathState {
  mtimeMs: number;
  size: number;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private config: CodebaseIndexConfig;
  private configPath: string | undefined;
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
    this.projectConfigPaths = options.configPath
      ? [options.configPath]
      : getProjectConfigCandidatePaths(projectRoot, host);
    this.localModuleConfigTracker = new LocalModuleConfigTracker(projectRoot, config);
  }

  start(handler: ChangeHandler): void {
    if (this.watcher || this.nativeWatcher || this.nativeStarting) {
      return;
    }

    this.onChanges = handler;
    this.localModuleConfigTracker.refresh();
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
  ): void {
    let reportedStartupReady = false;
    this.localModuleConfigTracker.refresh();
    this.configPathStates = this.getConfigPathStates();
    const ignoreFilter = createIgnoreFilter(this.projectRoot);
    const resolvedWatchTargets = watchTargets ?? this.getFullChokidarWatchTargets();

    const watcherOptions = {
      ignored: (filePath: string) => {
        const relativePath = path.relative(this.projectRoot, filePath);
        if (!relativePath) return false;

        if (this.isProjectConfigPathOrAncestor(relativePath)) {
          return false;
        }

        if (this.isOutsideProjectPath(relativePath)) {
          return true;
        }

        if (hasFilteredPathSegment(relativePath, path.sep)) {
          return true;
        }

        if (isRestrictedDirectory(relativePath, path.sep)) {
          return true;
        }

        if (ignoreFilter.ignores(relativePath)) {
          return true;
        }

        return false;
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
    watcher.on("ready", () => {
      if (this.watcher !== watcher) return;
      this.reconcileConfigPathStates();
      if (reportsStartupReady) {
        this.reportStartupReadySignal();
        reportedStartupReady = true;
      }
    });

    watcher.on("error", (error: unknown) => {
      const err = error instanceof Error ? (error as NodeJS.ErrnoException) : null;
      if (err?.code === "EPERM" || err?.code === "EACCES") {
        // Silently ignore permission errors — common on macOS restricted paths
        return;
      }

      if (
        err?.code === "EMFILE"
        && !watcher.options.usePolling
        && !this.pollingFallbackAttempted
        && this.watcher === watcher
      ) {
        this.pollingFallbackAttempted = true;
        console.warn("[codebase-index] File watcher exhausted open file handles; retrying with polling.");
        this.pendingClose = watcher.close().catch((closeError: unknown) => {
          console.error("[codebase-index] Failed to close exhausted file watcher:", closeError);
        });
        if (this.onChanges) {
          const replacementReportsStartupReady = reportsStartupReady || reportedStartupReady;
          if (!this.resolveReady) {
            this.resetReady();
          } else if (reportedStartupReady) {
            this.startupReadySignals += 1;
          }
          this.createWatcher(resolvedWatchTargets, true, replacementReportsStartupReady);
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
      this.config,
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

    if (
      filePath === null
      || filePath === path.join(this.projectRoot, ".gitignore")
      || (filePath !== null && (
        shouldTrackLocalModuleConfigPath(filePath, this.projectRoot)
        || this.localModuleConfigTracker.has(filePath)
      ))
    ) {
      this.localModuleConfigTracker.refresh();
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

    try {
      const reconciler = this.nativeReconciler;
      const changes = await reconciler.reconcile(invalidatedPaths);
      if (!this.isCurrentNativeSetup(generation) || this.nativeReconciler !== reconciler) return;

      this.recordChanges(changes);
    } catch (error) {
      await this.fallbackFromNativeWatcher(generation, error);
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

    if (this.isProjectConfigPath(filePath)) {
      this.updateConfigPathState(filePath);
      this.pendingChanges.set(filePath, type);
      this.scheduleFlush();
      return;
    }

    if (
      shouldTrackLocalModuleConfigPath(filePath, this.projectRoot)
      || this.localModuleConfigTracker.has(filePath)
    ) {
      this.localModuleConfigTracker.refresh();
      this.pendingChanges.set(filePath, type);
      this.scheduleFlush();
      return;
    }

    const includePatterns = [...this.config.include, ...(this.config.additionalInclude ?? [])];
    if (
      !shouldIncludeFile(
        filePath,
        this.projectRoot,
        includePatterns,
        this.config.exclude,
        createIgnoreFilter(this.projectRoot)
      )
    ) {
      return;
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

  private async flush(): Promise<void> {
    if (this.pendingChanges.size === 0 || !this.onChanges) {
      return;
    }

    const changes: FileChange[] = Array.from(this.pendingChanges.entries()).map(
      ([path, type]) => ({ path, type })
    );

    this.pendingChanges.clear();

    try {
      await this.onChanges(changes);
    } catch (error) {
      console.error("Error handling file changes:", error);
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
    await Promise.all([watcher?.close(), nativeWatcher?.stop(), pendingClose]);

    resolveReady?.();
  }

  isRunning(): boolean {
    return this.watcher !== null || this.nativeWatcher !== null || this.nativeStarting;
  }

  async waitUntilReady(): Promise<void> {
    await (this.readyPromise ?? Promise.resolve());
  }
}
