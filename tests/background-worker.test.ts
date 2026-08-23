import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  beforeRename: null as (() => void) | null,
  originalRenameSync: null as typeof import("node:fs").renameSync | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  fsMocks.originalRenameSync = fs.renameSync;
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>): void => {
      const beforeRename = fsMocks.beforeRename;
      fsMocks.beforeRename = null;
      beforeRename?.();
      fs.renameSync(...args);
    },
  };
});

import { parseConfig } from "../src/config/schema.js";
import {
  configureBackgroundWorker,
  getBackgroundWorkerLeasePath,
  isBackgroundWorkerLeader,
  isBackgroundWorkerManaged,
  resetBackgroundWorkersForTests,
  stopBackgroundWorker,
  tryAcquireBackgroundWorkerLease,
  updateBackgroundWorkerConfig,
  type BackgroundWorkerLeaseOwner,
} from "../src/utils/background-worker.js";

function config(
  indexing: Record<string, unknown> = {},
  rootOverrides: Record<string, unknown> = {},
) {
  return parseConfig({
    ...rootOverrides,
    embeddingProvider: "custom",
    customProvider: {
      baseUrl: "http://127.0.0.1:9999/v1",
      model: "test",
      dimensions: 8,
    },
    indexing: {
      autoIndex: true,
      watchFiles: false,
      requireProjectMarker: false,
      ...indexing,
    },
  });
}

function readOwner(leasePath: string): BackgroundWorkerLeaseOwner {
  return JSON.parse(readFileSync(path.join(leasePath, "owner.json"), "utf-8")) as BackgroundWorkerLeaseOwner;
}

function writeOwner(leasePath: string, owner: BackgroundWorkerLeaseOwner): void {
  writeFileSync(path.join(leasePath, "owner.json"), JSON.stringify(owner), "utf-8");
}

function writeHeartbeat(leasePath: string, owner: BackgroundWorkerLeaseOwner, heartbeatAt: string): void {
  writeFileSync(path.join(leasePath, `heartbeat.${owner.token}.json`), JSON.stringify({
    version: 1,
    token: owner.token,
    heartbeatAt,
  }), "utf-8");
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function completedAutoIndexStop(): { completed: true; completion: Promise<void> } {
  return { completed: true, completion: Promise.resolve() };
}

describe("background worker lease", () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "background-worker-"));
    projectRoot = path.join(tempDir, "project");
  });

  afterEach(async () => {
    await resetBackgroundWorkersForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses one deterministic lease path for a project and a distinct path for another root", () => {
    const parsed = config();
    const first = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
    const repeated = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
    const second = getBackgroundWorkerLeasePath(path.join(tempDir, "second-project"), parsed, "codex");

    expect(repeated).toBe(first);
    expect(second).not.toBe(first);
  });

  it.each(["opencode", "codex", "claude", "pi", "jcode"] as const)("acquires and releases a lease for %s", (host) => {
    const lease = tryAcquireBackgroundWorkerLease(projectRoot, config(), host);
    expect(lease).not.toBeNull();
    expect(lease?.release()).toBe(true);
  });

  it("does not evict a live local owner with an old heartbeat", () => {
    const parsed = config();
    const first = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    if (!first) throw new Error("Expected the first lease acquisition to succeed");

    const owner = readOwner(first.leasePath);
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    writeOwner(first.leasePath, {
      ...owner,
      heartbeatAt: staleHeartbeat,
    });
    writeHeartbeat(first.leasePath, owner, staleHeartbeat);

    expect(tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex")).toBeNull();
    expect(first.release()).toBe(true);
  });

  it("keeps a live leader active when another process sees its old heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const parsed = config({ watchFiles: true });
      const watcher = { stop: vi.fn(async () => {}) };
      configureBackgroundWorker(projectRoot, "codex", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: () => watcher,
      });
      await vi.advanceTimersByTimeAsync(0);
      const leasePath = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
      const owner = readOwner(leasePath);
      const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
      writeOwner(leasePath, {
        ...owner,
        heartbeatAt: staleHeartbeat,
      });
      writeHeartbeat(leasePath, owner, staleHeartbeat);

      expect(tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex")).toBeNull();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true);
      expect(watcher.stop).not.toHaveBeenCalled();

      await stopBackgroundWorker(projectRoot, "codex");
      expect(watcher.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims a dead local owner after its heartbeat expires", () => {
    const parsed = config();
    const first = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    if (!first) throw new Error("Expected the first lease acquisition to succeed");

    const owner = readOwner(first.leasePath);
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    writeOwner(first.leasePath, {
      ...owner,
      pid: 999_999_999,
      heartbeatAt: staleHeartbeat,
    });
    writeHeartbeat(first.leasePath, owner, staleHeartbeat);

    const recovered = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    expect(recovered).not.toBeNull();
    expect(recovered?.owner.pid).toBe(process.pid);
    expect(recovered?.release()).toBe(true);
  });

  it("reclaims an expired remote owner", () => {
    const parsed = config();
    const first = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    if (!first) throw new Error("Expected the first lease acquisition to succeed");

    const owner = readOwner(first.leasePath);
    const staleOwner = {
      ...owner,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      hostname: "remote-host",
    };
    writeOwner(first.leasePath, staleOwner);
    writeHeartbeat(first.leasePath, staleOwner, staleOwner.heartbeatAt);

    const recovered = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    expect(recovered).not.toBeNull();
    expect(recovered?.owner.pid).toBe(process.pid);
    expect(recovered?.owner.token).not.toBe(owner.token);
    expect(recovered?.release()).toBe(true);
  });

  it("does not evict an ambiguous local owner with an expired heartbeat", () => {
    const parsed = config();
    const first = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    if (!first) throw new Error("Expected the first lease acquisition to succeed");

    const owner = readOwner(first.leasePath);
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    writeOwner(first.leasePath, {
      ...owner,
      heartbeatAt: staleHeartbeat,
    });
    writeHeartbeat(first.leasePath, owner, staleHeartbeat);
    const originalKill = process.kill;
    const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === owner.pid && signal === 0) {
        throw Object.assign(new Error("liveness unavailable"), { code: "EIO" });
      }
      return originalKill(pid, signal);
    }) as typeof process.kill);

    try {
      expect(tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex")).toBeNull();
    } finally {
      kill.mockRestore();
    }
    expect(first.release()).toBe(true);
  });

  it("does not release a lease after its token changed", () => {
    const parsed = config();
    const lease = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    if (!lease) throw new Error("Expected the first lease acquisition to succeed");

    const owner = readOwner(lease.leasePath);
    writeOwner(lease.leasePath, { ...owner, token: randomUUID() });

    expect(lease.release()).toBe(false);
  });

  it("does not remove a successor lease replaced during release", () => {
    const parsed = config();
    const lease = tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex");
    if (!lease || !fsMocks.originalRenameSync) throw new Error("Expected the first lease acquisition to succeed");

    const successor = {
      ...readOwner(lease.leasePath),
      heartbeatAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      token: randomUUID(),
    };
    fsMocks.beforeRename = () => {
      const incumbentPath = `${lease.leasePath}.incumbent`;
      const successorPath = `${lease.leasePath}.successor`;
      fsMocks.originalRenameSync?.(lease.leasePath, incumbentPath);
      mkdirSync(successorPath);
      writeFileSync(path.join(successorPath, "owner.json"), JSON.stringify(successor), "utf-8");
      fsMocks.originalRenameSync?.(successorPath, lease.leasePath);
    };

    expect(lease.release()).toBe(false);
    expect(existsSync(lease.leasePath)).toBe(true);
    expect(readOwner(lease.leasePath)).toMatchObject({ token: successor.token });
  });

  it("starts and stops watcher and auto-index work only while leader", async () => {
    const startAutoIndex = vi.fn();
    const stopAutoIndex = vi.fn(async () => completedAutoIndexStop());
    const watcher = { stop: vi.fn(async () => {}) };
    configureBackgroundWorker(projectRoot, "codex", config(), {
      startAutoIndex,
      stopAutoIndex,
      watcherFactory: () => watcher,
    });

    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
    expect(startAutoIndex).toHaveBeenCalledOnce();
    expect(watcher.stop).not.toHaveBeenCalled();

    await Promise.all([
      stopBackgroundWorker(projectRoot, "codex"),
      stopBackgroundWorker(projectRoot, "codex"),
    ]);
    expect(watcher.stop).toHaveBeenCalledOnce();
    expect(stopAutoIndex).toHaveBeenCalledOnce();
  });

  it("restarts automatic indexing when a watched project re-enables it", async () => {
    const startAutoIndex = vi.fn();
    const watcher = { stop: vi.fn(async () => {}) };
    const hooks = {
      startAutoIndex,
      stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
      watcherFactory: () => watcher,
    };
    configureBackgroundWorker(projectRoot, "codex", config({ watchFiles: true }), hooks);
    await vi.waitFor(() => expect(startAutoIndex).toHaveBeenCalledTimes(1));

    configureBackgroundWorker(projectRoot, "codex", config({ autoIndex: false, watchFiles: true }), hooks);
    configureBackgroundWorker(projectRoot, "codex", config({ watchFiles: true }), hooks);

    await vi.waitFor(() => expect(startAutoIndex).toHaveBeenCalledTimes(2));
  });

  it("restarts automatic indexing after an enabled configuration refresh", async () => {
    const startAutoIndex = vi.fn();
    const initialConfig = config();
    configureBackgroundWorker(projectRoot, "codex", initialConfig, {
      startAutoIndex,
      stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
    });
    await vi.waitFor(() => expect(startAutoIndex).toHaveBeenCalledTimes(1));

    updateBackgroundWorkerConfig(projectRoot, "codex", config({ autoIndexWaitMs: 75 }));

    await vi.waitFor(() => expect(startAutoIndex).toHaveBeenCalledTimes(2));
  });

  it("rebuilds its watcher from the refreshed index configuration", async () => {
    const previousHome = process.env.HOME;
    const homeDir = path.join(tempDir, "home");
    mkdirSync(homeDir);
    process.env.HOME = homeDir;
    const localConfig = config({ autoIndex: false, watchFiles: true });
    const globalConfig = config({ autoIndex: false, watchFiles: true }, { scope: "global" });
    const firstWatcher = { stop: vi.fn(async () => {}) };
    const secondWatcher = { stop: vi.fn(async () => {}) };
    const startedScopes: string[] = [];
    const watcherFactoryForConfig = vi.fn((refreshedConfig: ReturnType<typeof config>) => () => {
      startedScopes.push(refreshedConfig.scope);
      return refreshedConfig.scope === "global" ? secondWatcher : firstWatcher;
    });

    try {
      configureBackgroundWorker(projectRoot, "codex", localConfig, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: watcherFactoryForConfig(localConfig),
        watcherFactoryForConfig,
      });
      await vi.waitFor(() => expect(startedScopes).toEqual(["project"]));

      updateBackgroundWorkerConfig(projectRoot, "codex", globalConfig);

      await vi.waitFor(() => expect(startedScopes).toEqual(["project", "global"]));
      expect(firstWatcher.stop).toHaveBeenCalledOnce();
      expect(existsSync(getBackgroundWorkerLeasePath(projectRoot, localConfig, "codex"))).toBe(false);
      expect(existsSync(getBackgroundWorkerLeasePath(projectRoot, globalConfig, "codex"))).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("does not replace a watcher when its shutdown fails", async () => {
    const stopError = new Error("watcher shutdown failed");
    let failStop = true;
    const firstWatcher = {
      stop: vi.fn(async () => {
        if (failStop) throw stopError;
      }),
    };
    const secondWatcher = { stop: vi.fn(async () => {}) };
    const watcherFactory = vi.fn()
      .mockReturnValueOnce(firstWatcher)
      .mockReturnValue(secondWatcher);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const parsed = config({ watchFiles: true });

    try {
      configureBackgroundWorker(projectRoot, "opencode", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory,
        replaceWatcher: true,
      });
      await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalledTimes(1));

      configureBackgroundWorker(projectRoot, "opencode", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory,
        replaceWatcher: true,
      });
      await vi.waitFor(() => expect(firstWatcher.stop).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(watcherFactory).toHaveBeenCalledTimes(1);
      expect(isBackgroundWorkerLeader(projectRoot, "opencode")).toBe(true);

      failStop = false;
      configureBackgroundWorker(projectRoot, "opencode", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory,
        replaceWatcher: true,
      });
      await vi.waitFor(() => expect(secondWatcher.stop).not.toHaveBeenCalled());
      await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalledTimes(2));
      expect(firstWatcher.stop).toHaveBeenCalledTimes(2);
    } finally {
      logError.mockRestore();
    }
  });

  it("keeps a lease alive and retries teardown after a watcher shutdown failure", async () => {
    vi.useFakeTimers();
    const stopError = new Error("watcher shutdown failed");
    let failStop = true;
    const watcher = {
      stop: vi.fn(async () => {
        if (failStop) throw stopError;
      }),
    };
    const parsed = config({ watchFiles: true });
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      configureBackgroundWorker(projectRoot, "codex", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: () => watcher,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
      const leasePath = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");

      await expect(stopBackgroundWorker(projectRoot, "codex")).rejects.toThrow("Failed to stop background worker");
      expect(existsSync(leasePath)).toBe(true);
      expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(false);

      failStop = false;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(existsSync(leasePath)).toBe(false));
      expect(watcher.stop).toHaveBeenCalledTimes(2);
    } finally {
      logError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("handles a detached teardown failure when automatic work is disabled", async () => {
    const stopError = new Error("watcher shutdown failed");
    let failStop = true;
    const watcher = {
      stop: vi.fn(async () => {
        if (failStop) throw stopError;
      }),
    };
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    try {
      configureBackgroundWorker(projectRoot, "codex", config({ watchFiles: true }), {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: () => watcher,
      });
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));

      configureBackgroundWorker(projectRoot, "codex", config({ autoIndex: false, watchFiles: false }), {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: null,
      });

      await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
        "[codebase-index] Failed to stop background worker after disabling automatic work:",
        expect.any(Error),
      ));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();

      failStop = false;
      await stopBackgroundWorker(projectRoot, "codex");
    } finally {
      process.removeListener("unhandledRejection", unhandledRejection);
      logError.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("keeps the lease managed and retries when lease release fails", async () => {
    vi.useFakeTimers();
    const parsed = config({ watchFiles: true });
    const watcher = { stop: vi.fn(async () => {}) };
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    let indexPath: string | null = null;

    try {
      configureBackgroundWorker(projectRoot, "codex", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: () => watcher,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
      const leasePath = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
      indexPath = path.dirname(leasePath);
      chmodSync(indexPath, 0o500);

      await expect(stopBackgroundWorker(projectRoot, "codex")).rejects.toThrow();
      expect(existsSync(leasePath)).toBe(true);
      expect(isBackgroundWorkerManaged(projectRoot, "codex")).toBe(true);

      chmodSync(indexPath, 0o700);
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(existsSync(leasePath)).toBe(false));
      expect(isBackgroundWorkerManaged(projectRoot, "codex")).toBe(false);
    } finally {
      if (indexPath) chmodSync(indexPath, 0o700);
      logError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("restarts after a failed teardown when a new server configures the worker", async () => {
    vi.useFakeTimers();
    let failStop = true;
    const firstWatcher = {
      stop: vi.fn(async () => {
        if (failStop) throw new Error("watcher shutdown failed");
      }),
    };
    const secondWatcher = { stop: vi.fn(async () => {}) };
    const firstFactory = vi.fn(() => firstWatcher);
    const secondFactory = vi.fn(() => secondWatcher);
    const parsed = config({ watchFiles: true });
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      configureBackgroundWorker(projectRoot, "codex", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: firstFactory,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));

      await expect(stopBackgroundWorker(projectRoot, "codex")).rejects.toThrow("Failed to stop background worker");
      configureBackgroundWorker(projectRoot, "codex", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: secondFactory,
      });

      failStop = false;
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
      expect(firstWatcher.stop).toHaveBeenCalledTimes(2);
      expect(secondFactory).toHaveBeenCalledOnce();
    } finally {
      logError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a successful restart registered when reconfigured during teardown", async () => {
    const firstWatcherStop = createDeferred();
    const firstWatcher = {
      stop: vi.fn(async () => firstWatcherStop.promise),
    };
    const secondWatcher = { stop: vi.fn(async () => {}) };
    const firstFactory = vi.fn(() => firstWatcher);
    const secondFactory = vi.fn(() => secondWatcher);
    const parsed = config({ watchFiles: true });
    const hooks = {
      startAutoIndex: vi.fn(),
      stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
    };

    configureBackgroundWorker(projectRoot, "codex", parsed, {
      ...hooks,
      watcherFactory: firstFactory,
    });
    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));

    const stopping = stopBackgroundWorker(projectRoot, "codex");
    await vi.waitFor(() => expect(firstWatcher.stop).toHaveBeenCalledOnce());
    configureBackgroundWorker(projectRoot, "codex", parsed, {
      ...hooks,
      watcherFactory: secondFactory,
    });
    firstWatcherStop.resolve();
    await stopping;

    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
    expect(isBackgroundWorkerManaged(projectRoot, "codex")).toBe(true);
    expect(secondFactory).toHaveBeenCalledOnce();

    await stopBackgroundWorker(projectRoot, "codex");
    expect(isBackgroundWorkerManaged(projectRoot, "codex")).toBe(false);
    expect(secondWatcher.stop).toHaveBeenCalledOnce();
  });

  it("retains the lease until an unfinished automatic index has drained", async () => {
    const autoIndexCompletion = createDeferred();
    const parsed = config();
    configureBackgroundWorker(projectRoot, "codex", parsed, {
      startAutoIndex: vi.fn(),
      stopAutoIndex: vi.fn(async () => ({ completed: false, completion: autoIndexCompletion.promise })),
    });

    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
    const leasePath = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
    await Promise.all([
      stopBackgroundWorker(projectRoot, "codex"),
      stopBackgroundWorker(projectRoot, "codex"),
    ]);

    expect(existsSync(leasePath)).toBe(true);
    autoIndexCompletion.resolve();
    await vi.waitFor(() => expect(existsSync(leasePath)).toBe(false));
  });

  it("retains a watcher-only lease until watcher-triggered indexing has drained", async () => {
    const autoIndexCompletion = createDeferred();
    const parsed = config({ autoIndex: false, watchFiles: true });
    const stopAutoIndex = vi.fn(async () => ({
      completed: false,
      completion: autoIndexCompletion.promise,
    }));
    configureBackgroundWorker(projectRoot, "codex", parsed, {
      startAutoIndex: vi.fn(),
      stopAutoIndex,
      watcherFactory: () => ({ stop: vi.fn(async () => {}) }),
    });

    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
    const leasePath = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
    await stopBackgroundWorker(projectRoot, "codex");

    expect(stopAutoIndex).toHaveBeenCalledOnce();
    expect(existsSync(leasePath)).toBe(true);
    autoIndexCompletion.resolve();
    await vi.waitFor(() => expect(existsSync(leasePath)).toBe(false));
  });

  it("keeps host-local controllers behind a shared filesystem lease", async () => {
    const parsed = config();
    configureBackgroundWorker(projectRoot, "codex", parsed, {
      startAutoIndex: vi.fn(),
      stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
    });
    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));

    configureBackgroundWorker(projectRoot, "jcode", parsed, {
      startAutoIndex: vi.fn(),
      stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true);
    expect(isBackgroundWorkerLeader(projectRoot, "jcode")).toBe(false);
  });

  it("stops a local worker when its owner token is replaced", async () => {
    vi.useFakeTimers();
    try {
      const parsed = config({ watchFiles: true });
      const watcher = { stop: vi.fn(async () => {}) };
      configureBackgroundWorker(projectRoot, "codex", parsed, {
        startAutoIndex: vi.fn(),
        stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
        watcherFactory: () => watcher,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true);

      const leasePath = getBackgroundWorkerLeasePath(projectRoot, parsed, "codex");
      const owner = readOwner(leasePath);
      writeOwner(leasePath, {
        ...owner,
        hostname: "remote-host",
        heartbeatAt: owner.heartbeatAt,
      });
      expect(tryAcquireBackgroundWorkerLease(projectRoot, parsed, "codex")).toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(false);
      expect(watcher.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not acquire a lease when automatic work and watching are disabled", async () => {
    const parsed = config({ autoIndex: false, watchFiles: false });
    configureBackgroundWorker(projectRoot, "codex", parsed, {
      startAutoIndex: vi.fn(),
      stopAutoIndex: vi.fn(async () => completedAutoIndexStop()),
      watcherFactory: null,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(false);
    expect(() => readFileSync(getBackgroundWorkerLeasePath(projectRoot, parsed, "codex"))).toThrow();
  });
});
