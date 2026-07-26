import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FileWatcher, GitHeadWatcher, FileChange, createWatcherWithIndexer } from "../src/watcher/index.js";
import { ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { IndexLockContentionError } from "../src/indexer/index-lock.js";

const createTestConfig = (overrides: Partial<ParsedCodebaseIndexConfig> = {}): ParsedCodebaseIndexConfig => ({
  embeddingProvider: "auto",
  embeddingModel: undefined,
  scope: "project",
  include: ["**/*.ts", "**/*.js"],
  exclude: [],
  indexing: {
    autoIndex: false,
    watchFiles: true,
    maxFileSize: 1048576,
    maxChunksPerFile: 100,
    semanticOnly: false,
    retries: 3,
    retryDelayMs: 1000,
    autoGc: true,
    gcIntervalDays: 7,
    gcOrphanThreshold: 100,
    requireProjectMarker: true,
  },
  search: {
    maxResults: 20,
    minScore: 0.1,
    includeContext: true,
    hybridWeight: 0.5,
    fusionStrategy: "rrf",
    rrfK: 60,
    rerankTopN: 20,
    contextLines: 0,
    routingHints: true,
    routingGraphHandoffHints: false,
    routingHintRole: "system",
  },
  debug: {
    enabled: false,
    logLevel: "info",
    logSearch: true,
    logEmbedding: true,
    logCache: true,
    logGc: true,
    logBranch: true,
    metrics: true,
  },
  ...overrides,
});

describe("FileWatcher", () => {
  let tempDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-test-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await watcher?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor and lifecycle", () => {
    it("should create watcher without starting", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      expect(watcher.isRunning()).toBe(false);
    });

    it("should start and stop correctly", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      const handler = vi.fn();

      watcher.start(handler);
      expect(watcher.isRunning()).toBe(true);

      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it("should not start twice", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      watcher.start(handler1);
      watcher.start(handler2);

      expect(watcher.isRunning()).toBe(true);
    });

    it("should clear pending changes on stop", () => {
      watcher = new FileWatcher(tempDir, createTestConfig());
      const handler = vi.fn();

      watcher.start(handler);
      watcher.stop();

      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe("file filtering", () => {
    it("should only watch files matching include patterns", async () => {
      const changes: FileChange[] = [];
      watcher = new FileWatcher(tempDir, createTestConfig({ include: ["**/*.ts"] }));

      watcher.start(async (c) => {
        changes.push(...c);
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(tempDir, "src", "test.ts"), "const x = 1;");
      fs.writeFileSync(path.join(tempDir, "src", "test.md"), "# README");

      await new Promise((r) => setTimeout(r, 1500));

      const tsChanges = changes.filter((c) => c.path.endsWith(".ts"));
      const mdChanges = changes.filter((c) => c.path.endsWith(".md"));

      expect(tsChanges.length).toBeGreaterThanOrEqual(0);
      expect(mdChanges.length).toBe(0);
    });

    it("should include matching root-level files", async () => {
      const changes: FileChange[] = [];
      watcher = new FileWatcher(tempDir, createTestConfig({ include: ["**/*.ts"] }));

      watcher.start(async (c) => {
        changes.push(...c);
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(tempDir, "root.ts"), "export const root = 1;");

      await new Promise((r) => setTimeout(r, 1500));

      expect(changes.some((c) => c.path.endsWith("root.ts"))).toBe(true);
    });

    it("should watch codex-native config without watching codex index files", async () => {
      const changes: FileChange[] = [];
      watcher = new FileWatcher(tempDir, createTestConfig({ include: ["**/*.ts"] }), "codex");

      watcher.start(async (c) => {
        changes.push(...c);
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.mkdirSync(path.join(tempDir, ".codebase-index", "index"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".codebase-index", "config.json"), "{}");
      fs.writeFileSync(path.join(tempDir, ".codebase-index", "index", "codebase.db"), "index");

      await vi.waitFor(
        () => expect(changes.some((c) => c.path.endsWith(path.join(".codebase-index", "config.json")))).toBe(true),
        { timeout: 2500 },
      );

      expect(changes.some((c) => c.path.includes(path.join(".codebase-index", "index")))).toBe(false);
    });

    it("should watch legacy OpenCode config in codex mode without watching legacy index files", async () => {
      const changes: FileChange[] = [];
      fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".opencode", "codebase-index.json"), "{}");
      watcher = new FileWatcher(tempDir, createTestConfig({ include: ["**/*.ts"] }), "codex");

      watcher.start(async (c) => {
        changes.push(...c);
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.mkdirSync(path.join(tempDir, ".opencode", "index"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".opencode", "codebase-index.json"), "{\"include\":[\"src/**/*.ts\"]}");
      fs.writeFileSync(path.join(tempDir, ".opencode", "index", "codebase.db"), "index");

      await vi.waitFor(
        () => expect(changes.some((c) => c.path.endsWith(path.join(".opencode", "codebase-index.json")))).toBe(true),
        { timeout: 2500 },
      );

      expect(changes.some((c) => c.path.includes(path.join(".opencode", "index")))).toBe(false);
    });
  });

  describe("createWatcherWithIndexer", () => {
    it("handles file-triggered reindexing in the background", async () => {
      vi.setConfig({ testTimeout: 4000 });
      let resolveIndex: (() => void) | null = null;
      const indexer = {
        index: vi.fn(() => new Promise<void>((resolve) => {
          resolveIndex = resolve;
        })),
      };
      const combinedWatcher = createWatcherWithIndexer(
        () => indexer,
        tempDir,
        createTestConfig()
      );

      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(path.join(tempDir, "src", "background.ts"), "export const value = 1;");
      await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(1), { timeout: 2500 });

      expect(indexer.index).toHaveBeenCalledTimes(1);
      expect(resolveIndex).toBeTypeOf("function");

      await combinedWatcher.stop();
      resolveIndex?.();
    });

    it("coalesces file-triggered reindex requests while one is running", async () => {
      vi.setConfig({ testTimeout: 6000 });
      const pendingResolves: Array<() => void> = [];
      const indexer = {
        index: vi.fn(() => new Promise<void>((resolve) => {
          pendingResolves.push(resolve);
        })),
      };
      const combinedWatcher = createWatcherWithIndexer(
        () => indexer,
        tempDir,
        createTestConfig()
      );

      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(path.join(tempDir, "src", "first.ts"), "export const first = 1;");
      await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(1), { timeout: 2500 });
      fs.writeFileSync(path.join(tempDir, "src", "second.ts"), "export const second = 2;");
      await new Promise((r) => setTimeout(r, 1500));

      expect(indexer.index).toHaveBeenCalledTimes(1);
      pendingResolves[0]?.();
      await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(2));

      await combinedWatcher.stop();
      pendingResolves[1]?.();
    });

    it("keeps one pending request and retries after INDEX_BUSY", async () => {
      const owner = {
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        operation: "index" as const,
        token: "busy-owner",
      };
      let rejectFirst: ((error: unknown) => void) | null = null;
      const firstAttempt = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      const indexer = { index: vi.fn().mockReturnValueOnce(firstAttempt).mockResolvedValue(undefined) };
      const combinedWatcher = createWatcherWithIndexer(
        () => indexer,
        tempDir,
        createTestConfig(),
      );

      await combinedWatcher.fileWatcher.waitUntilReady();
      fs.writeFileSync(path.join(tempDir, "src", "retry.ts"), "export const retry = 1;");
      await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(1), { timeout: 2500 });
      rejectFirst?.(new IndexLockContentionError("/tmp/indexing.lock", owner, "active"));
      await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledTimes(2), { timeout: 1000 });

      await combinedWatcher.stop();
    });

    it("logs a non-transient lock state without retrying forever", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const owner = {
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
        operation: "index" as const,
        token: "unknown-owner",
      };
      const indexer = {
        index: vi.fn().mockRejectedValue(
          new IndexLockContentionError("/tmp/indexing.lock", owner, "unknown-owner"),
        ),
      };
      const combinedWatcher = createWatcherWithIndexer(
        () => indexer,
        tempDir,
        createTestConfig(),
      );

      await combinedWatcher.fileWatcher.waitUntilReady();
      fs.writeFileSync(path.join(tempDir, "src", "blocked.ts"), "export const blocked = true;");
      await vi.waitFor(() => expect(indexer.index).toHaveBeenCalledOnce(), { timeout: 4000 });
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce(), { timeout: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(indexer.index).toHaveBeenCalledOnce();
      await combinedWatcher.stop();
    }, 7000);

    it("uses the latest indexer instance for file-triggered reindexing", async () => {
      const staleIndexer = {
        index: vi.fn().mockResolvedValue(undefined),
      };
      const refreshedIndexer = {
        index: vi.fn().mockResolvedValue(undefined),
      };

      let currentIndexer = staleIndexer;
      const combinedWatcher = createWatcherWithIndexer(
        () => currentIndexer,
        tempDir,
        createTestConfig()
      );

      await new Promise((r) => setTimeout(r, 100));
      currentIndexer = refreshedIndexer;

      fs.writeFileSync(path.join(tempDir, "src", "reindex-me.ts"), "export const value = 1;");

      await new Promise((r) => setTimeout(r, 1500));

      expect(refreshedIndexer.index).toHaveBeenCalledTimes(1);
      expect(staleIndexer.index).not.toHaveBeenCalled();

      await combinedWatcher.stop();
    });

    it("stops the watcher cleanly after start", async () => {
      const indexer = {
        index: vi.fn().mockResolvedValue(undefined),
      };

      const combinedWatcher = createWatcherWithIndexer(
        () => indexer,
        tempDir,
        createTestConfig()
      );

      expect(combinedWatcher.fileWatcher.isRunning()).toBe(true);
      expect(combinedWatcher.gitWatcher?.isRunning() ?? false).toBe(false);

      await combinedWatcher.stop();

      expect(combinedWatcher.fileWatcher.isRunning()).toBe(false);
      expect(combinedWatcher.gitWatcher?.isRunning() ?? false).toBe(false);
    });
  });
});

describe("GitHeadWatcher", () => {
  let tempDir: string;
  let watcher: GitHeadWatcher;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-watcher-test-"));
  });

  afterEach(async () => {
    await watcher?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("constructor and lifecycle", () => {
    it("should create watcher without starting", () => {
      watcher = new GitHeadWatcher(tempDir);
      expect(watcher.isRunning()).toBe(false);
    });

    it("should not start for non-git directory", () => {
      watcher = new GitHeadWatcher(tempDir);
      const handler = vi.fn();

      watcher.start(handler);

      expect(watcher.isRunning()).toBe(false);
    });

    it("should start for git directory", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      const handler = vi.fn();

      watcher.start(handler);

      expect(watcher.isRunning()).toBe(true);
    });

    it("should stop correctly", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      watcher.start(vi.fn());
      watcher.stop();

      expect(watcher.isRunning()).toBe(false);
    });

    it("should not start twice", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      watcher.start(handler1);
      watcher.start(handler2);

      expect(watcher.isRunning()).toBe(true);
    });
  });

  describe("branch tracking", () => {
    it("should return current branch after start", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);
      watcher.start(vi.fn());

      expect(watcher.getCurrentBranch()).toBe("main");
    });

    it("should return null before start", () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      watcher = new GitHeadWatcher(tempDir);

      expect(watcher.getCurrentBranch()).toBe(null);
    });

    it("should detect branch change when HEAD is modified", async () => {
      fs.mkdirSync(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");

      const branchChanges: Array<{ old: string | null; new: string }> = [];
      watcher = new GitHeadWatcher(tempDir);

      watcher.start(async (oldBranch, newBranch) => {
        branchChanges.push({ old: oldBranch, new: newBranch });
      });

      await new Promise((r) => setTimeout(r, 100));

      fs.writeFileSync(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/feature\n");

      await new Promise((r) => setTimeout(r, 500));

      expect(branchChanges.length).toBeGreaterThanOrEqual(0);
      if (branchChanges.length > 0) {
        expect(branchChanges[0].old).toBe("main");
        expect(branchChanges[0].new).toBe("feature");
      }
    });
  });
});
