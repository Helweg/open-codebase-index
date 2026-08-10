import { existsSync } from "fs";
import { FSWatcher } from "chokidar";
import * as path from "path";
import type { Ignore } from "ignore";

import type { HostMode } from "../config/host.js";
import type { CodebaseIndexConfig } from "../config/schema.js";
import { getProjectConfigCandidatePaths } from "../config/paths.js";
import { createIgnoreFilter } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";
import { NativeRecursiveWatcher } from "./native-recursive-watcher.js";
import { FileSnapshotReconciler } from "./snapshot-reconciler.js";

export type FileChangeType = "add" | "change" | "unlink";

export interface FileChange {
  type: FileChangeType;
  path: string;
}

export type ChangeHandler = (changes: FileChange[]) => Promise<void>;
export type FileWatcherBackendMode = "auto" | "native" | "chokidar" | "polling";

export interface FileWatcherOptions {
  backend?: FileWatcherBackendMode;
  configPath?: string;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private config: CodebaseIndexConfig;
  private configPath: string | undefined;
  private backend: FileWatcherBackendMode;
  private projectConfigPaths: string[];
  private pendingChanges: Map<string, FileChangeType> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 1000;
  private onChanges: ChangeHandler | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private pollingFallbackAttempted = false;
  private pendingClose: Promise<void> | null = null;
  private nativeWatchers: NativeRecursiveWatcher[] | null = null;
  private reconciler: FileSnapshotReconciler | null = null;
  private reconcilerInitialized = false;
  private reconcilerInitialize: Promise<void> | null = null;
  private ignoreFilter: Ignore;
  private nativeSetupGeneration = 0;
  private nativeStarting = false;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(projectRoot: string, config: CodebaseIndexConfig, host: HostMode, options: FileWatcherOptions = {}) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.backend = options.backend ?? "auto";
    this.configPath = options.configPath;
    this.projectConfigPaths = options.configPath
      ? [options.configPath]
      : getProjectConfigCandidatePaths(projectRoot, host);
    this.ignoreFilter = createIgnoreFilter(projectRoot);
  }

  start(handler: ChangeHandler): void {
    if (this.watcher || this.nativeWatchers || this.nativeStarting) {
      return;
    }

    this.onChanges = handler;
    this.pollingFallbackAttempted = false;
    this.resetReady();
    if (this.backend === "polling") {
      this.createWatcher(true);
      return;
    }
    if (this.backend === "chokidar") {
      this.createWatcher(false);
      return;
    }
    this.nativeStarting = true;
    void this.createNativeWatcher();
  }

  private resetReady(): void {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  private createWatcher(usePolling = false, sharedReconciler?: FileSnapshotReconciler): void {
    this.ignoreFilter = createIgnoreFilter(this.projectRoot);
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

    const reconciler = sharedReconciler ?? new FileSnapshotReconciler(this.projectRoot, this.config, this.projectConfigPaths);
    this.reconciler = reconciler;
    if (sharedReconciler) {
      this.reconcilerInitialized = true;
      this.reconcilerInitialize = null;
    } else {
      this.reconcilerInitialized = false;
      this.reconcilerInitialize = reconciler.initialize()
        .then(() => {
          if (this.reconciler === reconciler) {
            this.reconcilerInitialized = true;
          }
        })
        .catch((error: unknown) => {
          if (this.reconciler !== reconciler) return;
          console.warn("[codebase-index] Watcher snapshot initialization failed; reindexing project root.", error);
          this.reconcilerInitialized = true;
        });
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

        if (relativePath === ".gitignore") {
          return false;
        }

        if (hasFilteredPathSegment(relativePath, path.sep)) {
          return true;
        }

        if (isRestrictedDirectory(relativePath, path.sep)) {
          return true;
        }

        if (this.ignoreFilter.ignores(relativePath)) {
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
      void (async () => {
        await this.waitForReconcilerInitialized(reconciler);
        if (this.watcher !== watcher || this.reconciler !== reconciler) return;
        try {
          const changes = await reconciler.reconcile();
          if (this.watcher !== watcher || this.reconciler !== reconciler) return;
          this.recordChanges(changes);
        } catch (error) {
          if (this.watcher !== watcher || this.reconciler !== reconciler) return;
          console.warn("[codebase-index] Watcher startup reconciliation failed; reindexing project root.", error);
          this.recordChanges([{ type: "change", path: this.projectRoot }]);
        }
        this.resolveReady?.();
        this.resolveReady = null;
      })();
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

    watcher.on("add", (filePath) => this.handleInvalidation(watcher, filePath));
    watcher.on("change", (filePath) => this.handleInvalidation(watcher, filePath));
    watcher.on("unlink", (filePath) => this.handleInvalidation(watcher, filePath));
    watcher.add(watchTargets);
  }

  private async waitForReconcilerInitialized(reconciler: FileSnapshotReconciler): Promise<void> {
    const initialize = this.reconcilerInitialize;
    if (initialize && this.reconciler === reconciler) {
      await initialize;
    }
  }

  private async createNativeWatcher(): Promise<void> {
    const generation = ++this.nativeSetupGeneration;
    const reconciler = new FileSnapshotReconciler(this.projectRoot, this.config, this.projectConfigPaths);

    try {
      await reconciler.initialize();
      if (!this.isCurrentNativeSetup(generation)) return;

      this.reconciler = reconciler;
      this.reconcilerInitialized = true;

      const roots = this.resolveNativeWatchRoots();
      const watchers: NativeRecursiveWatcher[] = [];
      for (const root of roots) {
        const watcher = new NativeRecursiveWatcher(
          root,
          () => this.scheduleReconciliation(),
          { onError: (error) => void this.fallbackFromNativeWatcher(generation, error) },
        );
        watchers.push(watcher);
        this.nativeWatchers = [...(this.nativeWatchers ?? []), watcher];
        watcher.start();
      }
      if (!this.isCurrentNativeSetup(generation)) {
        await Promise.all(watchers.map((watcher) => watcher.stop()));
        return;
      }

      this.nativeStarting = false;
      const initialChanges = await reconciler.reconcile();
      if (!this.isCurrentNativeSetup(generation)) return;

      this.recordChanges(initialChanges);
      this.resolveReady?.();
      this.resolveReady = null;
    } catch (error) {
      if (!this.isCurrentNativeSetup(generation)) return;
      this.nativeStarting = false;
      await this.fallbackFromNativeWatcher(generation, error);
    }
  }

  private isCurrentNativeSetup(generation: number): boolean {
    return this.nativeSetupGeneration === generation && this.onChanges !== null;
  }

  private resolveNativeWatchRoots(): string[] {
    const projectRoot = path.resolve(this.projectRoot);
    const roots = [projectRoot];
    for (const configPath of this.projectConfigPaths) {
      const relativeConfigPath = path.relative(this.projectRoot, configPath);
      if (this.isOutsideProjectPath(relativeConfigPath)) {
        roots.push(path.resolve(this.getNearestExistingDirectory(path.dirname(configPath))));
      }
    }

    roots.sort();
    const unique: string[] = [];
    for (const root of roots) {
      if (unique.some((existing) => root === existing || root.startsWith(existing + path.sep))) {
        continue;
      }
      unique.push(root);
    }
    if (!unique.includes(projectRoot)) {
      unique.push(projectRoot);
    }
    return unique;
  }

  private scheduleReconciliation(): void {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
    }
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.runReconciliation();
    }, 100);
  }

  private async runReconciliation(): Promise<void> {
    const reconciler = this.reconciler;
    if (!reconciler || !this.onChanges || !this.reconcilerInitialized) return;

    try {
      const changes = await reconciler.reconcile();
      if (this.reconciler !== reconciler || !this.onChanges) return;
      this.recordChanges(changes);
    } catch (error) {
      if (this.reconciler !== reconciler) return;
      console.warn("[codebase-index] Watcher reconciliation failed; reindexing project root.", error);
      this.recordChanges([{ type: "change", path: this.projectRoot }]);
    }
  }

  private async fallbackFromNativeWatcher(generation: number, error: unknown): Promise<void> {
    if (!this.isCurrentNativeSetup(generation)) return;

    const watchers = this.nativeWatchers;
    this.nativeWatchers = null;
    this.nativeStarting = false;
    this.nativeSetupGeneration += 1;
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    console.warn("[codebase-index] Native recursive watcher failed; using Chokidar fallback.", error);
    await Promise.all((watchers ?? []).map((watcher) => watcher.stop()));
    if (this.onChanges) {
      this.createWatcher(false, this.reconciler ?? undefined);
    }
  }

  private handleInvalidation(watcher: FSWatcher, filePath: string): void {
    if (this.watcher !== watcher) {
      return;
    }

    if (path.resolve(filePath) === path.join(this.projectRoot, ".gitignore")) {
      this.ignoreFilter = createIgnoreFilter(this.projectRoot);
    }

    this.scheduleReconciliation();
  }

  private recordChanges(changes: FileChange[]): void {
    if (changes.length === 0) return;

    for (const change of changes) {
      this.pendingChanges.set(change.path, change.type);
    }
    this.scheduleFlush();
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
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    const watcher = this.watcher;
    const nativeWatchers = this.nativeWatchers;
    const pendingClose = this.pendingClose;
    const resolveReady = this.resolveReady;
    this.watcher = null;
    this.nativeWatchers = null;
    this.reconciler = null;
    this.reconcilerInitialized = false;
    this.reconcilerInitialize = null;
    this.nativeStarting = false;
    this.nativeSetupGeneration += 1;
    this.pendingClose = null;
    this.resolveReady = null;
    this.readyPromise = null;
    this.pendingChanges.clear();
    this.onChanges = null;
    await Promise.all([watcher?.close(), ...(nativeWatchers ?? []).map((w) => w.stop()), pendingClose]);

    resolveReady?.();
  }

  isRunning(): boolean {
    return this.watcher !== null || this.nativeWatchers !== null || this.nativeStarting;
  }

  async waitUntilReady(): Promise<void> {
    await (this.readyPromise ?? Promise.resolve());
  }
}
