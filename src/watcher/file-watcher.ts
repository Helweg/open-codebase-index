import chokidar, { FSWatcher } from "chokidar";
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
    const ignoreFilter = createIgnoreFilter(this.projectRoot);
    const watchTargets = this.configPath ? [this.projectRoot, this.configPath] : this.projectRoot;

    this.watcher = chokidar.watch(watchTargets, {
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
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    this.watcher.once("ready", () => {
      this.resolveReady?.();
      this.resolveReady = null;
    });

    this.watcher.on("error", (error: unknown) => {
      const err = error instanceof Error ? (error as NodeJS.ErrnoException) : null;
      if (err?.code === "EPERM" || err?.code === "EACCES") {
        // Silently ignore permission errors — common on macOS restricted paths
        return;
      }
      console.error("[codebase-index] Watcher error:", err?.message ?? error);
    });

    this.watcher.on("add", (filePath) => this.handleChange("add", filePath));
    this.watcher.on("change", (filePath) => this.handleChange("change", filePath));
    this.watcher.on("unlink", (filePath) => this.handleChange("unlink", filePath));
  }

  private handleChange(type: FileChangeType, filePath: string): void {
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

    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.close();
    }

    this.resolveReady?.();
    this.resolveReady = null;
    this.readyPromise = null;

    this.pendingChanges.clear();
    this.onChanges = null;
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }

  async waitUntilReady(): Promise<void> {
    await (this.readyPromise ?? Promise.resolve());
  }
}
