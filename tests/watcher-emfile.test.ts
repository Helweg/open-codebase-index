import { FSWatcher } from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { FileWatcher } from "../src/watcher/file-watcher.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("FileWatcher EMFILE recovery", () => {
  it("falls back to polling without breaking readiness or asynchronous stop", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    let resolveNativeClose: (() => void) | null = null;
    const nativeClose = new Promise<void>((resolve) => {
      resolveNativeClose = resolve;
    });
    let resolvePollingClose: (() => void) | null = null;
    const pollingClose = new Promise<void>((resolve) => {
      resolvePollingClose = resolve;
    });
    let addCount = 0;
    const addSpy = vi.spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
      addCount += 1;
      if (addCount === 1) {
        this.emit("error", Object.assign(new Error("too many open files"), { code: "EMFILE" }));
      }
      return this;
    });
    const closeSpy = vi.spyOn(FSWatcher.prototype, "close").mockImplementation(function (this: FSWatcher) {
      return this === addSpy.mock.instances[0] ? nativeClose : pollingClose;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher("/tmp/project", parseConfig({ include: ["**/*.ts"] }));

    watcher.start(vi.fn());

    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy.mock.instances[0]).toBe(addSpy.mock.instances[0]);
    expect((addSpy.mock.instances[1] as FSWatcher).options.usePolling).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[codebase-index] File watcher exhausted open file handles; retrying with polling.",
    );
    expect(watcher.isRunning()).toBe(true);

    const readyPromise = watcher.waitUntilReady();
    let readySettled = false;
    void readyPromise.then(() => {
      readySettled = true;
    });
    (addSpy.mock.instances[0] as FSWatcher).emit("ready");
    await Promise.resolve();
    expect(readySettled).toBe(false);
    (addSpy.mock.instances[1] as FSWatcher).emit("ready");
    await expect(readyPromise).resolves.toBeUndefined();

    let stopSettled = false;
    const stopPromise = watcher.stop().then(() => {
      stopSettled = true;
    });
    expect(watcher.isRunning()).toBe(false);
    resolveNativeClose?.();
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    resolvePollingClose?.();
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(2);
    expect(closeSpy.mock.instances[1]).toBe(addSpy.mock.instances[1]);
  });

  it("waits for a polling replacement that starts after native readiness", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    const addSpy = vi.spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
      return this;
    });
    vi.spyOn(FSWatcher.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher("/tmp/project", parseConfig({ include: ["**/*.ts"] }));

    watcher.start(vi.fn());
    const nativeWatcher = addSpy.mock.instances[0] as FSWatcher;
    nativeWatcher.emit("ready");
    await watcher.waitUntilReady();
    nativeWatcher.emit("error", Object.assign(new Error("too many open files"), { code: "EMFILE" }));

    expect(addSpy).toHaveBeenCalledTimes(2);
    const pollingWatcher = addSpy.mock.instances[1] as FSWatcher;
    let replacementReady = false;
    const replacementReadyPromise = watcher.waitUntilReady().then(() => {
      replacementReady = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementReady).toBe(false);

    pollingWatcher.emit("ready");
    await replacementReadyPromise;
    expect(replacementReady).toBe(true);
    await watcher.stop();
  });

  it("preserves a new start while an older stop is still closing", async () => {
    vi.useFakeTimers();
    let resolveFirstClose: (() => void) | null = null;
    const firstClose = new Promise<void>((resolve) => {
      resolveFirstClose = resolve;
    });
    const addSpy = vi.spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
      return this;
    });
    vi.spyOn(FSWatcher.prototype, "close").mockImplementation(function (this: FSWatcher) {
      return this === addSpy.mock.instances[0] ? firstClose : Promise.resolve();
    });
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    const watcher = new FileWatcher("/tmp/project", parseConfig({ include: ["**/*.ts"] }));

    watcher.start(firstHandler);
    (addSpy.mock.instances[0] as FSWatcher).emit("ready");
    await watcher.waitUntilReady();
    const firstStop = watcher.stop();
    watcher.start(secondHandler);

    const firstWatcher = addSpy.mock.instances[0] as FSWatcher;
    const secondWatcher = addSpy.mock.instances[1] as FSWatcher;
    firstWatcher.emit("add", "/tmp/project/src/stale.ts");
    await vi.advanceTimersByTimeAsync(1000);
    expect(secondHandler).not.toHaveBeenCalled();

    let secondReady = false;
    const secondReadyPromise = watcher.waitUntilReady().then(() => {
      secondReady = true;
    });
    resolveFirstClose?.();
    await firstStop;
    await Promise.resolve();
    expect(secondReady).toBe(false);

    secondWatcher.emit("ready");
    await secondReadyPromise;
    secondWatcher.emit("add", "/tmp/project/src/restarted.ts");
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith([
      { type: "add", path: "/tmp/project/src/restarted.ts" },
    ]);
    await watcher.stop();
  });

  it("forces polling for recovery when the environment disables it", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    let addCount = 0;
    const addSpy = vi.spyOn(FSWatcher.prototype, "add").mockImplementation(function (this: FSWatcher) {
      addCount += 1;
      if (addCount === 1) {
        this.emit("error", Object.assign(new Error("too many open files"), { code: "EMFILE" }));
      }
      return this;
    });
    vi.spyOn(FSWatcher.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher("/tmp/project", parseConfig({ include: ["**/*.ts"] }));

    watcher.start(vi.fn());

    expect(addSpy).toHaveBeenCalledTimes(2);
    expect((addSpy.mock.instances[1] as FSWatcher).options.usePolling).toBe(true);
    expect(process.env.CHOKIDAR_USEPOLLING).toBe("false");
    await watcher.stop();
  });
});
