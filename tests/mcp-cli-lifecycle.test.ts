import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleMocks = vi.hoisted(() => ({
  BackgroundWorkerStopError: class BackgroundWorkerStopError extends Error {
    constructor(
      readonly watcherError: unknown | undefined,
      readonly autoIndexError: unknown | undefined,
    ) {
      super("Failed to stop background worker");
    }
  },
  createMcpServer: vi.fn(),
  attachMcpBackgroundWatcher: vi.fn(),
  createWatcherWithIndexer: vi.fn(),
  isHomeDirectory: vi.fn(() => false),
  stopBackgroundWorker: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../src/mcp-server.js", () => ({
  createMcpServer: lifecycleMocks.createMcpServer,
  attachMcpBackgroundWatcher: lifecycleMocks.attachMcpBackgroundWatcher,
}));

vi.mock("../src/utils/auto-index.js", () => ({
  isHomeDirectory: lifecycleMocks.isHomeDirectory,
}));

vi.mock("../src/utils/background-worker.js", () => ({
  BackgroundWorkerStopError: lifecycleMocks.BackgroundWorkerStopError,
  stopBackgroundWorker: lifecycleMocks.stopBackgroundWorker,
}));

vi.mock("../src/watcher/index.js", () => ({
  createWatcherWithIndexer: lifecycleMocks.createWatcherWithIndexer,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

import { runMcpCli } from "../src/adapters/mcp/cli.js";

interface FakeMcpServer {
  close: () => Promise<void>;
  connect: (transport: unknown) => Promise<void>;
  server: {
    onclose?: () => void;
  };
}

interface FakeWatcher {
  stop: () => Promise<void>;
}

const processPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("MCP CLI shutdown lifecycle", () => {
  let events: string[];
  let server: FakeMcpServer;
  let tempDir: string;
  let watcher: FakeWatcher;
  let watcherAttached: boolean;

  beforeEach(() => {
    events = [];
    watcherAttached = false;
    tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-cli-lifecycle-"));
    writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({ indexing: { autoIndex: false, watchFiles: true, requireProjectMarker: false } }),
    );

    lifecycleMocks.createMcpServer.mockReset();
    lifecycleMocks.attachMcpBackgroundWatcher.mockReset();
    lifecycleMocks.createWatcherWithIndexer.mockReset();
    lifecycleMocks.stopBackgroundWorker.mockReset();
    lifecycleMocks.exit.mockReset();
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string) => {
      events.push(`exit:${String(code)}`);
      lifecycleMocks.exit(code);
    }) as never);

    watcher = {
      stop: vi.fn(async () => {
        events.push("watcher.stop");
      }),
    };
    lifecycleMocks.stopBackgroundWorker.mockImplementation(async () => {
      if (watcherAttached) await watcher.stop();
      events.push("backgroundWorker.stop");
    });
    server = {
      close: vi.fn(async () => {
        events.push("server.close");
      }),
      connect: vi.fn(async () => {}),
      server: {
        onclose: () => {
          events.push("server.onclose");
        },
      },
    };
    lifecycleMocks.createMcpServer.mockReturnValue(server);
    lifecycleMocks.createWatcherWithIndexer.mockReturnValue(watcher);
    lifecycleMocks.stopBackgroundWorker.mockImplementation(async () => {
      if (watcherAttached) {
        try {
          await watcher.stop();
        } catch (error) {
          throw new lifecycleMocks.BackgroundWorkerStopError(error, undefined);
        }
      }
      events.push("backgroundWorker.stop");
    });
    lifecycleMocks.attachMcpBackgroundWatcher.mockImplementation((_project, _config, _host, factory) => {
      watcherAttached = true;
      factory?.();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (processPlatformDescriptor) {
      Object.defineProperty(process, "platform", processPlatformDescriptor);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startCli(): Promise<void> {
    await runMcpCli([
      "node",
      "dist/cli.js",
      "--host",
      "jcode",
      "--project",
      tempDir,
      "--config",
      path.join(tempDir, "config.json"),
    ]);
  }

  async function expectSuccessfulShutdown(): Promise<void> {
    await vi.waitFor(() => {
      expect(lifecycleMocks.exit).toHaveBeenCalledWith(0);
    });
    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(lifecycleMocks.stopBackgroundWorker).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  }

  it("runs teardown once when stdin emits end and close", async () => {
    const stopGate = createDeferred<void>();
    watcher.stop = vi.fn(() => {
      events.push("watcher.stop");
      return stopGate.promise;
    });
    lifecycleMocks.createWatcherWithIndexer.mockReturnValue(watcher);
    await startCli();

    process.stdin.emit("end");
    process.stdin.emit("close");
    await Promise.resolve();

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(server.close).not.toHaveBeenCalled();

    stopGate.resolve();
    await expectSuccessfulShutdown();
    expect(events).toEqual(["watcher.stop", "backgroundWorker.stop", "server.close", "exit:0"]);
  });

  it("runs teardown when stdin closes without an end event", async () => {
    await startCli();

    process.stdin.emit("close");

    await expectSuccessfulShutdown();
    expect(events).toEqual(["watcher.stop", "backgroundWorker.stop", "server.close", "exit:0"]);
  });

  it("waits for background watcher startup before connecting the transport", async () => {
    const watcherStarted = createDeferred<void>();
    lifecycleMocks.attachMcpBackgroundWatcher.mockImplementation((_project, _config, _host, factory) => {
      watcherAttached = true;
      factory?.();
      return watcherStarted.promise;
    });

    const starting = startCli();
    await vi.waitFor(() => expect(lifecycleMocks.attachMcpBackgroundWatcher).toHaveBeenCalledOnce());
    expect(server.connect).not.toHaveBeenCalled();

    watcherStarted.resolve();
    await starting;
    expect(server.connect).toHaveBeenCalledOnce();

    process.stdin.emit("close");
    await expectSuccessfulShutdown();
  });

  it("still closes the server when watcher teardown fails", async () => {
    const stopError = new Error("watcher stop failed");
    watcher.stop = vi.fn(async () => {
      events.push("watcher.stop");
      throw stopError;
    });
    lifecycleMocks.createWatcherWithIndexer.mockReturnValue(watcher);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await startCli();

    process.stdin.emit("close");

    await vi.waitFor(() => {
      expect(lifecycleMocks.exit).toHaveBeenCalledWith(1);
    });
    expect(server.close).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Failed to stop MCP file watcher cleanly:", stopError);
    expect(events).toEqual(["watcher.stop", "server.close", "exit:1"]);
  });

  it("still closes the server when background worker shutdown fails", async () => {
    const stopError = new Error("background worker stop failed");
    lifecycleMocks.stopBackgroundWorker.mockImplementation(async () => {
      events.push("backgroundWorker.stop");
      throw stopError;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await startCli();

    process.stdin.emit("close");

    await vi.waitFor(() => {
      expect(lifecycleMocks.exit).toHaveBeenCalledWith(1);
    });
    expect(lifecycleMocks.stopBackgroundWorker).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Failed to stop automatic indexing cleanly:", stopError);
    expect(events).toEqual(["backgroundWorker.stop", "server.close", "exit:1"]);
  });

  it("handles SIGINT while MCP transport startup is still pending", async () => {
    const connectGate = createDeferred<void>();
    server.connect = vi.fn(() => connectGate.promise);
    lifecycleMocks.createMcpServer.mockReturnValue(server);

    const cliPromise = runMcpCli([
      "node",
      "dist/cli.js",
      "--host",
      "jcode",
      "--project",
      tempDir,
      "--config",
      path.join(tempDir, "config.json"),
    ]);
    await Promise.resolve();

    process.emit("SIGINT");
    connectGate.resolve();
    await cliPromise;

    await vi.waitFor(() => {
      expect(lifecycleMocks.exit).toHaveBeenCalledWith(0);
    });
    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(lifecycleMocks.stopBackgroundWorker).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("runs teardown when the MCP server closes", async () => {
    await startCli();

    server.server.onclose?.();

    await expectSuccessfulShutdown();
    expect(events).toEqual(["server.onclose", "watcher.stop", "backgroundWorker.stop", "server.close", "exit:0"]);
  });

  if (process.platform !== "win32") {
    it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("runs teardown for %s", async (signal) => {
      await startCli();

      process.emit(signal);

      await expectSuccessfulShutdown();
      expect(events).toEqual(["watcher.stop", "backgroundWorker.stop", "server.close", "exit:0"]);
    });
  }

  it("uses SIGINT but not POSIX-only shutdown signals on Windows", async () => {
    if (!processPlatformDescriptor) {
      throw new Error("Unable to override process.platform for this lifecycle test.");
    }
    Object.defineProperty(process, "platform", { ...processPlatformDescriptor, value: "win32" });
    await startCli();

    process.emit("SIGTERM");
    process.emit("SIGHUP");
    await Promise.resolve();

    expect(watcher.stop).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();

    process.emit("SIGINT");
    await expectSuccessfulShutdown();
  });
});
