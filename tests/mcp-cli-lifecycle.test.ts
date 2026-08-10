import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleMocks = vi.hoisted(() => ({
  createMcpServer: vi.fn(),
  createWatcherWithIndexer: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../src/mcp-server.js", () => ({
  createMcpServer: lifecycleMocks.createMcpServer,
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

  beforeEach(() => {
    events = [];
    tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-cli-lifecycle-"));
    writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify({ indexing: { autoIndex: false, watchFiles: true, requireProjectMarker: false } }),
    );

    lifecycleMocks.createMcpServer.mockReset();
    lifecycleMocks.createWatcherWithIndexer.mockReset();
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
    expect(events).toEqual(["watcher.stop", "server.close", "exit:0"]);
  });

  it("runs teardown when stdin closes without an end event", async () => {
    await startCli();

    process.stdin.emit("close");

    await expectSuccessfulShutdown();
    expect(events).toEqual(["watcher.stop", "server.close", "exit:0"]);
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

  it("runs teardown when the MCP server closes", async () => {
    await startCli();

    server.server.onclose?.();

    await expectSuccessfulShutdown();
    expect(events).toEqual(["server.onclose", "watcher.stop", "server.close", "exit:0"]);
  });

  if (process.platform !== "win32") {
    it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("runs teardown for %s", async (signal) => {
      await startCli();

      process.emit(signal);

      await expectSuccessfulShutdown();
      expect(events).toEqual(["watcher.stop", "server.close", "exit:0"]);
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
