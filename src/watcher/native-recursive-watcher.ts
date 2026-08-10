import { watch, type WatchEventType, type WatchOptions } from "node:fs";
import * as path from "node:path";

export type NativeRecursiveWatcherChangeHandler = (absolutePath: string | null) => void | Promise<void>;

export type NativeFsWatchListener = (
  eventType: WatchEventType,
  filename: string | Buffer | null | undefined,
) => void;

type NativeFsWatcherHandle = {
  close(): void | Promise<void>;
};

export type NativeRecursiveWatcherFactory = (
  root: string,
  listener: NativeFsWatchListener,
  options: WatchOptions,
) => NativeFsWatcherHandle;

export interface NativeRecursiveWatcherOptions {
  watchFactory?: NativeRecursiveWatcherFactory;
}

export class NativeRecursiveWatcher {
  private watcher: NativeFsWatcherHandle | null = null;
  private listenerToken = 0;

  private readonly watchFactory: NativeRecursiveWatcherFactory;

  constructor(
    private readonly root: string,
    private readonly onChange: NativeRecursiveWatcherChangeHandler,
    options: NativeRecursiveWatcherOptions = {},
  ) {
    this.watchFactory = options.watchFactory ?? this.defaultWatchFactory;
  }

  start(): void {
    if (this.watcher) return;

    const token = ++this.listenerToken;
    const listener: NativeFsWatchListener = (_eventType, filename) => {
      if (this.watcher === null || this.listenerToken !== token) return;

      const absolutePath = this.toAbsolutePath(filename);
      const nextResult = this.onChange(absolutePath);

      if (nextResult instanceof Promise) {
        void nextResult.catch((error: unknown) => {
          console.error("[codebase-index] Error handling native watcher event:", error);
        });
      }
    };

    this.watcher = this.watchFactory(this.root, listener, {
      persistent: true,
      recursive: true,
    });
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    this.listenerToken += 1;

    if (!watcher) return;

    await watcher.close();
  }

  private toAbsolutePath(filename: string | Buffer | null | undefined): string | null {
    if (filename == null) return null;

    const normalizedFilename = typeof filename === "string" ? filename : filename.toString();
    const absolutePath = path.resolve(this.root, normalizedFilename);
    const relativePath = path.relative(this.root, absolutePath);
    const outsideRoot = relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath);
    return outsideRoot ? null : absolutePath;
  }

  private defaultWatchFactory: NativeRecursiveWatcherFactory = (
    root,
    listener,
    options,
  ) => watch(root, options, listener);
}
