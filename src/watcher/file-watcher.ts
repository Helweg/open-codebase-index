import { existsSync } from "fs";
import { FSWatcher } from "chokidar";
import * as path from "path";

import type { HostMode } from "../config/host.js";
import type { CodebaseIndexConfig } from "../config/schema.js";
import { getProjectConfigCandidatePaths } from "../config/paths.js";
import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";
import { NativeRecursiveWatcher } from "./native-recursive-watcher.js";
import { FileSnapshotReconciler } from "./snapshot-reconciler.js";

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
  private nativeWatcher: NativeRecursiveWatcher | null = null;
  private nativeReconciler: FileSnapshotReconciler | null = null;
  private nativeSetupGeneration = 0;
  private nativeStarting = false;
  private nativeReconcileTimer: NodeJS.Timeout | null = null;

  constructor(projectRoot: string, config: CodebaseIndexConfig, host: HostMode, options: FileWatcherOptions = {}) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.backend = options.backend ?? "auto";
    this.configPath = options.configPath;
    this.projectConfigPaths = options.configPath
      ? [options.configPath]
      : getProjectConfigCandidatePaths(projectRoot, host);
  }

  start(handler: ChangeHandler): void {
    if (this.watcher || this.nativeWatcher || this.nativeStarting) {
      return;
    }

    this.onChanges = handler;
    this.pollingFallbackAttempted = false;
    this.resetReady();
    if (this.shouldUseNativeWatcher()) {
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
  }

  private createWatcher(usePolling = false): void {
    const ignoreFilter = createIgnoreFilter(this.projectRoot);
    let watchTargets: string | string[] = this.projectRoot;
    if (this.configPath) {
      watchTargets = [this.projectRoot, this.configPath];
    } else {
      const externalConfigTargets = this.projectConfigPaths
        .filter((projectConfigPath) => {
          const relativeConfigPath = path.relative(this.projectRoot, projectConfigPath);
          return this.isOutsideProjectPath(relativeConfigPath);
        })
        .map((projectConfigPath) => existsSync(projectConfigPath)
          ? projectConfigPath
          : this.getNearestExistingDirectory(path.dirname(projectConfigPath)));
      const uniqueExternalConfigTargets = [...new Set(externalConfigTargets)];
      if (uniqueExternalConfigTargets.length > 0) {
        watchTargets = [this.projectRoot, ...uniqueExternalConfigTargets];
      }
    }

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
    watcher.once("ready", () => {
      if (this.watcher !== watcher) return;
      this.resolveReady?.();
      this.resolveReady = null;
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
          if (!this.resolveReady) {
            this.resetReady();
          }
          this.createWatcher(true);
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
    watcher.add(watchTargets);
  }

  private shouldUseNativeWatcher(): boolean {
    if (this.backend === "chokidar") {
      return false;
    }

    return this.projectConfigPaths.every((configPath) => {
      const relativePath = path.relative(this.projectRoot, configPath);
      return !this.isOutsideProjectPath(relativePath);
    });
  }

  private async createNativeWatcher(): Promise<void> {
    const generation = ++this.nativeSetupGeneration;
    const reconciler = new FileSnapshotReconciler(this.projectRoot, this.config, this.projectConfigPaths);

    try {
      await reconciler.initialize();
      if (!this.isCurrentNativeSetup(generation)) return;

      const watcher = new NativeRecursiveWatcher(
        this.projectRoot,
        () => this.scheduleNativeReconciliation(generation),
        { onError: (error) => void this.fallbackFromNativeWatcher(generation, error) },
      );
      watcher.start();
      if (!this.isCurrentNativeSetup(generation)) {
        await watcher.stop();
        return;
      }

      this.nativeWatcher = watcher;
      this.nativeReconciler = reconciler;
      this.nativeStarting = false;
      const initialChanges = await reconciler.reconcile();
      if (!this.isCurrentNativeSetup(generation) || this.nativeWatcher !== watcher) return;

      this.recordChanges(initialChanges);
      this.resolveReady?.();
      this.resolveReady = null;
    } catch (error) {
      if (!this.isCurrentNativeSetup(generation)) return;
      if (this.nativeWatcher) {
        await this.fallbackFromNativeWatcher(generation, error);
        return;
      }

      this.nativeStarting = false;
      this.nativeReconciler = null;
      console.warn("[codebase-index] Native recursive watcher unavailable; using Chokidar fallback.", error);
      this.createWatcher();
    }
  }

  private isCurrentNativeSetup(generation: number): boolean {
    return this.nativeSetupGeneration === generation && this.onChanges !== null;
  }

  private scheduleNativeReconciliation(generation: number): void {
    if (!this.isCurrentNativeSetup(generation)) return;

    if (this.nativeReconcileTimer) {
      clearTimeout(this.nativeReconcileTimer);
    }
    this.nativeReconcileTimer = setTimeout(() => {
      this.nativeReconcileTimer = null;
      void this.reconcileNativeWatcher(generation);
    }, 100);
  }

  private async reconcileNativeWatcher(generation: number): Promise<void> {
    if (!this.isCurrentNativeSetup(generation) || !this.nativeReconciler) return;

    try {
      const reconciler = this.nativeReconciler;
      const changes = await reconciler.reconcile();
      if (!this.isCurrentNativeSetup(generation) || this.nativeReconciler !== reconciler) return;

      this.recordChanges(changes);
    } catch (error) {
      await this.fallbackFromNativeWatcher(generation, error);
    }
  }

  private async fallbackFromNativeWatcher(generation: number, error: unknown): Promise<void> {
    if (!this.isCurrentNativeSetup(generation)) return;

    const watcher = this.nativeWatcher;
    this.nativeWatcher = null;
    this.nativeReconciler = null;
    this.nativeStarting = false;
    this.nativeSetupGeneration += 1;
    if (this.nativeReconcileTimer) {
      clearTimeout(this.nativeReconcileTimer);
      this.nativeReconcileTimer = null;
    }

    console.warn("[codebase-index] Native recursive watcher failed; using Chokidar fallback.", error);
    await watcher?.stop();
    if (this.onChanges) {
      this.createWatcher();
    }
  }

  private handleChange(watcher: FSWatcher, type: FileChangeType, filePath: string): void {
    if (this.watcher !== watcher) {
      return;
    }

    if (this.isProjectConfigPath(filePath)) {
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

    const watcher = this.watcher;
    const nativeWatcher = this.nativeWatcher;
    const pendingClose = this.pendingClose;
    const resolveReady = this.resolveReady;
    this.watcher = null;
    this.nativeWatcher = null;
    this.nativeReconciler = null;
    this.nativeStarting = false;
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
