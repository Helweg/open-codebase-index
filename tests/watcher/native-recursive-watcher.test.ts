import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { NativeRecursiveWatcher } from "../../src/watcher/native-recursive-watcher.js";

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
