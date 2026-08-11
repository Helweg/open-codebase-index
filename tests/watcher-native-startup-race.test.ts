import { FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { FileSnapshotReconciler, type SnapshotInvalidation } from "../src/watcher/snapshot-reconciler.js";
import { FileWatcher } from "../src/watcher/file-watcher.js";

interface FakeNativeWatcherState {
  onChange: (filePath: string | null) => void;
  onError?: (error: Error) => void;
  stop: () => Promise<void>;
}

const nativeWatcherStates: FakeNativeWatcherState[] = [];

vi.mock("../src/watcher/native-recursive-watcher.js", () => {
  return {
    NativeRecursiveWatcher: class {
      public onChange: (filePath: string | null) => void;
      public onError: ((error: Error) => void) | undefined;

      constructor(_projectRoot: string, onChange: (filePath: string | null) => void, options: { onError?: (error: Error) => void } = {}) {
        this.onChange = onChange;
        this.onError = options.onError;
        nativeWatcherStates.push(this);
      }

      start(): void {
        return;
      }

      async stop(): Promise<void> {
        return;
      }
    },
  };
});

describe("native FileWatcher startup buffering", () => {
  let projectRoot: string;
  let watcher: FileWatcher | undefined;
  let resolveInitialize: (() => void) | null = null;
  const reconciliationCalls: SnapshotInvalidation[][] = [];

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-startup-race-"));
    reconciliationCalls.length = 0;
    resolveInitialize = null;
    nativeWatcherStates.length = 0;

    vi.spyOn(FileSnapshotReconciler.prototype, "initialize").mockImplementation(function () {
      return new Promise<void>((resolve) => {
        resolveInitialize = resolve;
      });
    });

    vi.spyOn(FileSnapshotReconciler.prototype, "reconcile").mockImplementation(async (invalidations: readonly SnapshotInvalidation[]) => {
      reconciliationCalls.push([...invalidations]);
      return [];
    });
  });

  afterEach(async () => {
    await watcher?.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    nativeWatcherStates.length = 0;
  });

  it("buffers invalidations raised during snapshot initialization and reconciles only those entries", async () => {
    const observedFile = path.join(projectRoot, "observed.ts");

    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );
    watcher.start(vi.fn());

    const nativeWatcher = nativeWatcherStates.at(-1);
    expect(nativeWatcher).toBeDefined();
    nativeWatcher?.onChange(observedFile);

    expect(reconciliationCalls).toHaveLength(0);

    resolveInitialize?.();
    await watcher.waitUntilReady();

    expect(reconciliationCalls).toHaveLength(1);
    expect(reconciliationCalls[0]).toEqual([{ path: observedFile, forceChange: true }]);
  });

  it("does not run a startup full reconcile when no buffered changes exist", async () => {
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );
    watcher.start(vi.fn());

    resolveInitialize?.();
    await watcher.waitUntilReady();

    expect(reconciliationCalls).toHaveLength(0);
  });

  it("waits for native initialization when its external config watcher recovers", async () => {
    const externalConfigPath = path.join(path.dirname(projectRoot), "external-config.json");
    const addSpy = vi.spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
      return this;
    });
    vi.spyOn(FSWatcher.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { configPath: externalConfigPath },
    );
    watcher.start(vi.fn());

    const firstExternalWatcher = addSpy.mock.instances[0] as FSWatcher;
    firstExternalWatcher.emit("ready");
    firstExternalWatcher.emit("error", Object.assign(new Error("too many open files"), { code: "EMFILE" }));
    const pollingExternalWatcher = addSpy.mock.instances[1] as FSWatcher;
    pollingExternalWatcher.emit("ready");

    let readySettled = false;
    const readyPromise = watcher.waitUntilReady().then(() => {
      readySettled = true;
    });
    await Promise.resolve();
    expect(readySettled).toBe(false);

    resolveInitialize?.();
    await readyPromise;
    expect(readySettled).toBe(true);
  });

  it("preserves .gitignore semantics with full-scope invalidation during startup", async () => {
    const ignoredPath = path.join(projectRoot, ".gitignore");

    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );
    watcher.start(vi.fn());

    const nativeWatcher = nativeWatcherStates.at(-1);
    expect(nativeWatcher).toBeDefined();
    nativeWatcher?.onChange(ignoredPath);

    resolveInitialize?.();
    await watcher.waitUntilReady();

    expect(reconciliationCalls).toHaveLength(1);
    expect(reconciliationCalls[0]).toEqual([{ path: null, forceChange: false }]);
  });
});
