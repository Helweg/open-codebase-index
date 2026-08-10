import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { FileWatcher, type FileChange } from "../src/watcher/file-watcher.js";

type FakeFSWatcherEntry = {
  options: Record<string, unknown>;
  addTargets: string[];
  callbacks: {
    once: Record<string, () => void>;
    on: Record<string, (arg?: unknown) => void>;
  };
  close: Mock;
};

type FakeNativeWatcherEntry = {
  onChange: (absolutePath?: string | null) => void;
  onError: ((error: Error) => void) | undefined;
  start: Mock;
  stop: Mock;
};

const fakes = vi.hoisted(() => {
  const fswatchers: FakeFSWatcherEntry[] = [];
  const nativeWatchers: FakeNativeWatcherEntry[] = [];
  return { fswatchers, nativeWatchers, failNextNativeStart: false };
});

vi.mock("chokidar", () => {
  class FakeFSWatcher {
    options: Record<string, unknown>;
    callbacks: {
      once: Record<string, () => void>;
      on: Record<string, (arg?: unknown) => void>;
    } = { once: {}, on: {} };
    addTargets: string[] = [];
    close = vi.fn().mockResolvedValue(undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      fakes.fswatchers.push(this);
    }

    once(event: string, cb: () => void): this {
      this.callbacks.once[event] = cb;
      this.callbacks.on[event] = cb;
      return this;
    }

    on(event: string, cb: (arg?: unknown) => void): this {
      this.callbacks.on[event] = cb;
      return this;
    }

    add(targets: string | string[]): this {
      this.addTargets.push(...(Array.isArray(targets) ? targets : [targets]));
      return this;
    }
  }
  return { FSWatcher: FakeFSWatcher };
});

vi.mock("../src/watcher/native-recursive-watcher.js", () => {
  class FakeNativeRecursiveWatcher {
    onChange: (absolutePath?: string | null) => void;
    onError: ((error: Error) => void) | undefined;
    start = vi.fn(() => {
      if (fakes.failNextNativeStart) {
        throw new Error("EMFILE: too many open files");
      }
    });
    stop = vi.fn().mockResolvedValue(undefined);

    constructor(
      _root: string,
      onChange: (absolutePath?: string | null) => void,
      options: { onError?: (error: Error) => void } = {},
    ) {
      this.onChange = onChange;
      this.onError = options.onError;
      fakes.nativeWatchers.push(this);
    }
  }
  return { NativeRecursiveWatcher: FakeNativeRecursiveWatcher };
});

describe("FileWatcher native-to-chokidar handoff", () => {
  let projectRoot: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    fakes.fswatchers.length = 0;
    fakes.nativeWatchers.length = 0;
    fakes.failNextNativeStart = false;
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-handoff-"));
  });

  afterEach(async () => {
    await watcher?.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("handoff delivers an in-flight mutation exactly once after a delayed chokidar ready", async () => {
    const changes: FileChange[] = [];
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    // Native backend is live; no Chokidar fallback watcher exists yet.
    expect(fakes.nativeWatchers.length).toBeGreaterThanOrEqual(1);
    expect(fakes.fswatchers.length).toBe(0);

    // The mutation lands on disk while the native backend is still active but
    // delivers no notification (the simulated runtime error kills it first).
    const mutationPath = path.join(projectRoot, "mutation.ts");
    fs.writeFileSync(mutationPath, "export const mutation = 1;\n");

    fakes.nativeWatchers[0].onError?.(new Error("native watcher exploded"));
    await vi.waitFor(() => {
      expect(fakes.fswatchers.length).toBe(1);
    });

    // Fallback engaged but Chokidar ready not fired yet: the handoff
    // reconciliation has not run, so the in-flight mutation is not delivered.
    expect(changes).not.toContainEqual({ type: "add", path: mutationPath });

    fakes.fswatchers[0].callbacks.on["ready"]();
    await vi.waitFor(
      () => {
        expect(changes).toContainEqual({ type: "add", path: mutationPath });
      },
      { timeout: 10_000 },
    );

    // Quiescence window longer than the 1000ms delivery flush: any second
    // delivery scheduled by a stray invalidation would have surfaced by now.
    // Real-time wait is deliberate: the flush debounce is a wall-clock timer
    // owned by the code under test, so fake timers would not exercise it.
    // Promise.withResolvers is unavailable under the repo's ES2022 lib target,
    // hence the executor form.
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    expect(changes.filter((change) => change.path === mutationPath)).toEqual([
      { type: "add", path: mutationPath },
    ]);

    // Every native watcher was closed by the fallback.
    for (const native of fakes.nativeWatchers) {
      expect(native.stop).toHaveBeenCalled();
    }

    await watcher.stop();
    expect(fakes.fswatchers[0].close).toHaveBeenCalled();
  });

  it("falls back to chokidar when native startup fails and still delivers events", async () => {
    fakes.failNextNativeStart = true;
    const changes: FileChange[] = [];
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });

    // The failed native start triggers the fallback: exactly one Chokidar
    // watcher is created, sharing the already-initialized reconciler.
    await vi.waitFor(() => {
      expect(fakes.fswatchers.length).toBe(1);
    });
    expect(fakes.nativeWatchers[0].stop).toHaveBeenCalled();

    // Complete the fallback startup; the handoff reconciliation finishes and
    // waitUntilReady resolves.
    fakes.fswatchers[0].callbacks.on["ready"]();
    await watcher.waitUntilReady();
    expect(fakes.fswatchers.length).toBe(1);

    const aPath = path.join(projectRoot, "a.ts");
    fs.writeFileSync(aPath, "export const a = 1;\n");
    fakes.fswatchers[0].callbacks.on["add"](aPath);
    await vi.waitFor(
      () => {
        expect(changes).toContainEqual({ type: "add", path: aPath });
      },
      { timeout: 10_000 },
    );

    await watcher.stop();
  });

  it("stop closes both backends after a handoff", async () => {
    const changes: FileChange[] = [];
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fakes.nativeWatchers[0].onError?.(new Error("native watcher exploded"));
    await vi.waitFor(() => {
      expect(fakes.fswatchers.length).toBe(1);
    });
    fakes.fswatchers[0].callbacks.on["ready"]();
    await watcher.waitUntilReady();

    await watcher.stop();
    for (const native of fakes.nativeWatchers) {
      expect(native.stop).toHaveBeenCalled();
    }
    expect(fakes.fswatchers[0].close).toHaveBeenCalled();
  });
});
