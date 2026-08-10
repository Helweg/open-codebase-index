import { FSWatcher } from "chokidar";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../../src/config/schema.js";
import { FileWatcher, type FileChange } from "../../src/watcher/file-watcher.js";
import { NativeRecursiveWatcher } from "../../src/watcher/native-recursive-watcher.js";
import { FileSnapshotReconciler } from "../../src/watcher/snapshot-reconciler.js";

type NativeFsWatchListener = (
  eventType: "rename" | "change",
  filename: string | Buffer | null | undefined,
) => void;
type NativeRecursiveWatcherFactory = (
  root: string,
  listener: NativeFsWatchListener,
  options: { recursive?: boolean; persistent?: boolean },
) => { close: () => void };

describe("NativeRecursiveWatcher", () => {
  it("passes recursive: true to fs.watch", async () => {
    let capturedOptions: { recursive?: boolean } | null = null;
    const watcherHandle = {
      close: vi.fn(),
    };
    const watchFactory: NativeRecursiveWatcherFactory = vi.fn((_root, listener, options) => {
      capturedOptions = options;
      return watcherHandle;
    });

    const root = path.join(os.tmpdir(), "codebase-index-root");
    const watcher = new NativeRecursiveWatcher(root, vi.fn(), { watchFactory });

    watcher.start();

    expect(watchFactory).toHaveBeenCalledOnce();
    expect(capturedOptions).toMatchObject({ recursive: true, persistent: true });
    await watcher.stop();
    expect(watcherHandle.close).toHaveBeenCalledOnce();
  });

  it("normalizes string, Buffer, and null filenames to absolute path or null", async () => {
    const root = path.join(os.tmpdir(), "codebase-index-root-2");
    const changes: Array<string | null> = [];
    let capturedListener: NativeFsWatchListener | null = null;
    const watchFactory: NativeRecursiveWatcherFactory = vi.fn((_root, listener) => {
      capturedListener = listener;
      return { close: vi.fn() };
    });

    const watcher = new NativeRecursiveWatcher(root, (nextPath) => {
      changes.push(nextPath);
    }, { watchFactory });

    watcher.start();
    expect(capturedListener).toBeTypeOf("function");

    capturedListener!("rename", "foo.txt");
    capturedListener!("change", Buffer.from("bar.txt"));
    capturedListener!("rename", null);
    capturedListener!("rename", "../outside.txt");

    expect(changes).toEqual([
      path.resolve(root, "foo.txt"),
      path.resolve(root, "bar.txt"),
      null,
      null,
    ]);

    await watcher.stop();
  });

  it("propagates watch startup failures", () => {
    const root = path.join(os.tmpdir(), "codebase-index-root-3");
    const expectedError = new Error("failed to start native watch");
    const watchFactory: NativeRecursiveWatcherFactory = vi.fn(() => {
      throw expectedError;
    });

    const watcher = new NativeRecursiveWatcher(root, vi.fn(), { watchFactory });

    expect(() => watcher.start()).toThrow(expectedError);
  });

  it("forwards current watcher errors and ignores stale error callbacks", async () => {
    const root = path.join(os.tmpdir(), "codebase-index-root-errors");
    let capturedErrorListener: ((error: Error) => void) | null = null;
    const watcherHandle = {
      close: vi.fn(),
      on: vi.fn((_event: "error", listener: (error: Error) => void) => {
        capturedErrorListener = listener;
      }),
    };
    const onError = vi.fn();
    const watchFactory: NativeRecursiveWatcherFactory = vi.fn(() => watcherHandle);
    const watcher = new NativeRecursiveWatcher(root, vi.fn(), { onError, watchFactory });

    watcher.start();
    capturedErrorListener!(new Error("current watcher error"));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "current watcher error" }));

    await watcher.stop();
    capturedErrorListener!(new Error("stale watcher error"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("suppresses callbacks after stop", async () => {
    const root = path.join(os.tmpdir(), "codebase-index-root-4");
    let capturedListener: NativeFsWatchListener | null = null;
    const watchFactory: NativeRecursiveWatcherFactory = vi.fn((_root, listener) => {
      capturedListener = listener;
      return { close: vi.fn() };
    });
    const onChange = vi.fn();

    const watcher = new NativeRecursiveWatcher(root, onChange, { watchFactory });
    watcher.start();

    await watcher.stop();
    capturedListener!("change", "stale.txt");

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("FileWatcher multi-root native watching", () => {
  let projectRoot: string;
  let watchers: FileWatcher[];
  let externalDirs: string[];

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-root-watcher-"));
    watchers = [];
    externalDirs = [];
  });

  afterEach(async () => {
    await Promise.all(watchers.map((watcher) => watcher.stop()));
    vi.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    for (const dir of externalDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("watches project root plus nearest existing directory of external configs", async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-root-external-"));
    externalDirs.push(externalDir);
    const originalStart = NativeRecursiveWatcher.prototype.start;
    const roots: string[] = [];
    vi.spyOn(NativeRecursiveWatcher.prototype, "start").mockImplementation(function (this: { root: string }) {
      roots.push(this.root);
      return originalStart.call(this);
    });

    const watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native", configPath: path.join(externalDir, "config.json") },
    );
    watchers.push(watcher);
    watcher.start(async () => undefined);
    await watcher.waitUntilReady();

    expect(roots).toHaveLength(2);
    expect(new Set(roots)).toEqual(new Set([projectRoot, externalDir]));

    await watcher.stop();
  });

  it("deduplicates config roots and drops contained roots", async () => {
    const originalStart = NativeRecursiveWatcher.prototype.start;
    const externalDirA = fs.mkdtempSync(path.join(os.tmpdir(), "multi-root-ext-a-"));
    const externalDirB = fs.mkdtempSync(path.join(externalDirA, "extB"));
    externalDirs.push(externalDirA);
    fs.mkdirSync(path.join(projectRoot, "nested"));

    // (a) A config path inside an existing nested external directory resolves
    // to that nearest existing directory; the outer directory is not watched.
    const rootsA: string[] = [];
    vi.spyOn(NativeRecursiveWatcher.prototype, "start").mockImplementation(function (this: { root: string }) {
      rootsA.push(this.root);
      return originalStart.call(this);
    });
    const watcherA = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native", configPath: path.join(externalDirB, "config.json") },
    );
    watchers.push(watcherA);
    watcherA.start(async () => undefined);
    await watcherA.waitUntilReady();

    expect(rootsA).toHaveLength(2);
    expect(new Set(rootsA)).toEqual(new Set([projectRoot, externalDirB]));
    expect(rootsA).not.toContain(externalDirA);

    // (a2) A config path under a missing directory walks up to the nearest
    // existing ancestor.
    const rootsA2: string[] = [];
    vi.spyOn(NativeRecursiveWatcher.prototype, "start").mockImplementation(function (this: { root: string }) {
      rootsA2.push(this.root);
      return originalStart.call(this);
    });
    const watcherA2 = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native", configPath: path.join(externalDirA, "missing", "config.json") },
    );
    watchers.push(watcherA2);
    watcherA2.start(async () => undefined);
    await watcherA2.waitUntilReady();

    expect(rootsA2).toHaveLength(2);
    expect(new Set(rootsA2)).toEqual(new Set([projectRoot, externalDirA]));

    // (b) A config path inside the project is not outside-project and adds no
    // external root at all.
    const rootsB: string[] = [];
    vi.spyOn(NativeRecursiveWatcher.prototype, "start").mockImplementation(function (this: { root: string }) {
      rootsB.push(this.root);
      return originalStart.call(this);
    });
    const watcherB = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native", configPath: path.join(projectRoot, "nested", "config.json") },
    );
    watchers.push(watcherB);
    watcherB.start(async () => undefined);
    await watcherB.waitUntilReady();

    expect(rootsB).toHaveLength(1);
    expect(new Set(rootsB)).toEqual(new Set([projectRoot]));

    // (c) Two inherited candidates inside the same main repo resolve to the
    // same deduplicated root; the contained worktree root is preserved.
    const mainRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-root-main-"));
    externalDirs.push(mainRepoDir);
    const worktreeDir = path.join(mainRepoDir, "feature-worktree");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const rootsC: string[] = [];
    vi.spyOn(NativeRecursiveWatcher.prototype, "start").mockImplementation(function (this: { root: string }) {
      rootsC.push(this.root);
      return originalStart.call(this);
    });
    const watcherC = new FileWatcher(worktreeDir, parseConfig({ include: ["**/*.ts"] }), "codex", {
      backend: "native",
    });
    watchers.push(watcherC);
    watcherC.start(async () => undefined);
    await watcherC.waitUntilReady();

    // Without deduplication the two main-repo candidates would create three
    // watchers; the contained worktree root is dropped then re-added, leaving
    // exactly two roots.
    expect(rootsC).toHaveLength(2);
    expect(new Set(rootsC)).toEqual(new Set([worktreeDir, mainRepoDir]));
  });

  it("closes every native watcher when one root fails to start", async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-root-fail-"));
    externalDirs.push(externalDir);
    const originalStart = NativeRecursiveWatcher.prototype.start;
    let startCallCount = 0;
    const startedInstances: unknown[] = [];
    const startSpy = vi.spyOn(NativeRecursiveWatcher.prototype, "start").mockImplementation(function (this: unknown) {
      startCallCount += 1;
      if (startCallCount === 2) {
        throw new Error("watch failed");
      }
      startedInstances.push(this);
      return originalStart.call(this);
    });
    const stopSpy = vi.spyOn(NativeRecursiveWatcher.prototype, "stop");
    const addSpy = vi.spyOn(FSWatcher.prototype, "add");

    const watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native", configPath: path.join(externalDir, "config.json") },
    );
    watchers.push(watcher);
    watcher.start(async () => undefined);
    await watcher.waitUntilReady();

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(addSpy).toHaveBeenCalled();
    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(stopSpy.mock.instances).toContain(startedInstances[0]);
    expect(watcher.isRunning()).toBe(true);
  });

  it("coalesces a burst of native notifications into a single reconciliation", async () => {
    const reconcileSpy = vi.spyOn(FileSnapshotReconciler.prototype, "reconcile");
    const batches: FileChange[][] = [];
    const allChanges: FileChange[] = [];
    const burstPaths = Array.from({ length: 5 }, (_, index) => path.join(projectRoot, `burst-${index}.ts`));
    const writeBurst = (content: string): void => {
      for (const filePath of burstPaths) {
        fs.writeFileSync(filePath, content);
      }
    };

    const watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", {
      backend: "native",
    });
    watchers.push(watcher);
    watcher.start(async (batch) => {
      batches.push(batch);
      allChanges.push(...batch);
    });
    await watcher.waitUntilReady();

    // Startup snapshot B is reconcile call #1.
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    // macOS FSEvents can silently drop the first notifications of a freshly
    // created recursive stream, so the burst is rewritten until the stream
    // delivers at least one notification. The snapshot diff still reports all
    // five files in a single reconciliation, so the coalescing contract is
    // unchanged; deterministic fake timers cannot model platform stream
    // activation, hence the real-time polling.
    writeBurst("export const value = 1;\n");
    const startedAt = Date.now();
    let attempt = 0;
    while (allChanges.length < 5 && Date.now() - startedAt < 10_000) {
      try {
        await vi.waitFor(() => {
          expect(allChanges).toHaveLength(5);
        }, { timeout: 2500, interval: 25 });
      } catch (error) {
        if (Date.now() - startedAt >= 10_000) {
          throw error;
        }
        attempt += 1;
        writeBurst(`export const value = ${attempt};\n`);
      }
    }

    // Startup plus one debounced burst reconciliation; the burst arrived as a
    // single handler batch.
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
    expect(batches).toHaveLength(1);
    expect(new Set(batches[0].map((change) => change.path))).toEqual(new Set(burstPaths));
    expect(batches[0].every((change) => change.type === "add")).toBe(true);
  });
});
