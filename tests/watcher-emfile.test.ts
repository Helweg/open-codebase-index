import { FSWatcher } from "chokidar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { FileWatcher } from "../src/watcher/file-watcher.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FileWatcher EMFILE recovery", () => {
  it("falls back to polling without breaking readiness or asynchronous stop", async () => {
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
});
