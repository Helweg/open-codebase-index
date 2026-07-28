import { FSWatcher } from "chokidar";
import * as path from "path";

import type { HostMode } from "../config/host.js";
import type { CodebaseIndexConfig } from "../config/schema.js";
import { resolveProjectConfigPath, resolveWritableProjectConfigPath } from "../config/paths.js";
import { createIgnoreFilter, shouldIncludeFile } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";

export type FileChangeType = "add" | "change" | "unlink";

export interface FileChange {
  type: FileChangeType;
  path: string;
}

export type ChangeHandler = (changes: FileChange[]) => Promise<void>;

export interface FileWatcherOptions {
  configPath?: string;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private projectRoot: string;
  private config: CodebaseIndexConfig;
  private host: HostMode;
  private configPath: string | undefined;
  private pendingChanges: Map<string, FileChangeType> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 1000;
  private onChanges: ChangeHandler | null = null;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private pollingFallbackAttempted = false;
  private pendingClose: Promise<void> | null = null;

  constructor(projectRoot: string, config: CodebaseIndexConfig, host: HostMode = "opencode", options: FileWatcherOptions = {}) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.host = host;
    this.configPath = options.configPath;
  }

  start(handler: ChangeHandler): void {
    if (this.watcher) {
      return;
    }

    this.onChanges = handler;
    this.pollingFallbackAttempted = false;
    this.resetReady();
    this.createWatcher();
  }

  private resetReady(): void {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  private createWatcher(usePolling = false): void {
    const ignoreFilter = createIgnoreFilter(this.projectRoot);
    const watchTargets = this.configPath ? [this.projectRoot, this.configPath] : this.projectRoot;

    const watcherOptions = {
      ignored: (filePath: string) => {
        const relativePath = path.relative(this.projectRoot, filePath);
        if (!relativePath) return false;

        if (this.isProjectConfigPathOrAncestor(relativePath)) {
          return false;
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

    this.pendingChanges.set(filePath, type);
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

  private getProjectConfigRelativePaths(): string[] {
    if (this.configPath) {
      return [path.normalize(path.relative(this.projectRoot, this.configPath))];
    }

    return [
      resolveProjectConfigPath(this.projectRoot, this.host),
      resolveWritableProjectConfigPath(this.projectRoot, this.host),
    ].map((configPath) => path.normalize(path.relative(this.projectRoot, configPath)));
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

    const watcher = this.watcher;
    const pendingClose = this.pendingClose;
    const resolveReady = this.resolveReady;
    this.watcher = null;
    this.pendingClose = null;
    this.resolveReady = null;
    this.readyPromise = null;
    this.pendingChanges.clear();
    this.onChanges = null;
    await Promise.all([watcher?.close(), pendingClose]);

    resolveReady?.();
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }

  async waitUntilReady(): Promise<void> {
    await (this.readyPromise ?? Promise.resolve());
  }
}
