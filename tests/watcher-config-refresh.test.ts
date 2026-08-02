import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const operationMocks = vi.hoisted(() => ({
  refreshIndexerForDirectory: vi.fn(),
}));

vi.mock("../src/tools/operations.js", () => ({
  refreshIndexerForDirectory: operationMocks.refreshIndexerForDirectory,
}));

vi.mock("../src/git/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/git/index.js")>()),
  isGitRepo: vi.fn(() => false),
}));

import { parseConfig } from "../src/config/schema.js";
import { createWatcherWithIndexer } from "../src/watcher/index.js";

const WATCH_EVENT_TIMEOUT_MS = 10000;

function createLinkedWorktree(root: string, writeMainConfig = true): {
  configPath: string;
  worktreeDir: string;
} {
  const mainRepoDir = path.join(root, "main-repo");
  const worktreeDir = path.join(root, "feature-worktree");
  const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");
  const configPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
  mkdirSync(worktreeGitDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
  writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
  if (writeMainConfig) {
    writeFileSync(configPath, JSON.stringify({ include: ["**/*.ts"] }));
  }
  return { configPath, worktreeDir };
}

function createLinkedWorktreeWatcher(root: string, writeMainConfig = true) {
  const { configPath, worktreeDir } = createLinkedWorktree(root, writeMainConfig);
  const indexer = {
    index: vi.fn().mockResolvedValue(undefined),
  };
  const watcher = createWatcherWithIndexer(
    () => indexer,
    worktreeDir,
    parseConfig({ include: ["**/*.ts"] }),
    "opencode",
  );
  return { configPath, indexer, watcher, worktreeDir };
}

const writeUntilObserved = async (
  write: (attempt: number) => void,
  assertion: () => void,
  timeoutMs = 10000,
): Promise<void> => {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    write(attempt++);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    try {
      await vi.waitFor(assertion, { timeout: Math.min(2500, remainingMs), interval: 50 });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

describe("watcher config refresh", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "watcher-config-refresh-"));
    operationMocks.refreshIndexerForDirectory.mockClear();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("refreshes the codex indexer cache before reindexing when codex config changes", async () => {
    mkdirSync(path.join(tempDir, ".codebase-index"), { recursive: true });
    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      tempDir,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
    );

    await watcher.whenReady();

    await writeUntilObserved(
      (attempt) => writeFileSync(
        path.join(tempDir, ".codebase-index", "config.json"),
        JSON.stringify({ include: ["src/**/*.ts"], attempt }),
      ),
      () => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "codex", undefined);
        expect(indexer.index).toHaveBeenCalledTimes(1);
      },
    );

    await watcher.stop();
  });

  it("refreshes the jcode indexer cache before reindexing when jcode config changes", async () => {
    mkdirSync(path.join(tempDir, ".codebase-index"), { recursive: true });
    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      tempDir,
      parseConfig({ include: ["**/*.ts"] }),
      "jcode",
    );

    await watcher.whenReady();

    await writeUntilObserved(
      (attempt) => writeFileSync(
        path.join(tempDir, ".codebase-index", "config.json"),
        JSON.stringify({ include: ["src/**/*.ts"], attempt }),
      ),
      () => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "jcode", undefined);
        expect(indexer.index).toHaveBeenCalledTimes(1);
      },
    );

    await watcher.stop();
  });

  it("refreshes the codex indexer cache before reindexing when legacy OpenCode config changes", async () => {
    mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
    writeFileSync(path.join(tempDir, ".opencode", "codebase-index.json"), JSON.stringify({ include: ["**/*.ts"] }));

    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      tempDir,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
    );

    await watcher.whenReady();

    mkdirSync(path.join(tempDir, ".opencode", "index"), { recursive: true });
    writeFileSync(path.join(tempDir, ".opencode", "index", "codebase.db"), "index");
    await writeUntilObserved(
      (attempt) => writeFileSync(
        path.join(tempDir, ".opencode", "codebase-index.json"),
        JSON.stringify({ include: ["src/**/*.ts"], attempt }),
      ),
      () => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "codex", undefined);
        expect(indexer.index).toHaveBeenCalledTimes(1);
      },
    );

    await watcher.stop();
  });

  it("refreshes the jcode indexer cache before reindexing when legacy OpenCode config changes", async () => {
    mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
    writeFileSync(path.join(tempDir, ".opencode", "codebase-index.json"), JSON.stringify({ include: ["**/*.ts"] }));

    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      tempDir,
      parseConfig({ include: ["**/*.ts"] }),
      "jcode",
    );

    await watcher.whenReady();

    mkdirSync(path.join(tempDir, ".opencode", "index"), { recursive: true });
    writeFileSync(path.join(tempDir, ".opencode", "index", "codebase.db"), "index");
    await writeUntilObserved(
      (attempt) => writeFileSync(
        path.join(tempDir, ".opencode", "codebase-index.json"),
        JSON.stringify({ include: ["src/**/*.ts"], attempt }),
      ),
      () => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "jcode", undefined);
        expect(indexer.index).toHaveBeenCalledTimes(1);
      },
    );

    await watcher.stop();
  });

  it("refreshes a linked worktree when its inherited project config changes", async () => {
    const { configPath, indexer, watcher, worktreeDir } = createLinkedWorktreeWatcher(tempDir);

    try {
      await watcher.whenReady();
      await writeUntilObserved(
        (attempt) => writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"], attempt })),
        () => {
          expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(
            worktreeDir,
            "opencode",
            undefined,
          );
          expect(indexer.index).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      await watcher.stop();
    }
  });

  it("refreshes a linked worktree when its inherited project config is removed", async () => {
    const { configPath, indexer, watcher, worktreeDir } = createLinkedWorktreeWatcher(tempDir);

    try {
      await watcher.whenReady();
      rmSync(configPath);

      await vi.waitFor(() => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(
          worktreeDir,
          "opencode",
          undefined,
        );
        expect(indexer.index).toHaveBeenCalledTimes(1);
      }, { timeout: WATCH_EVENT_TIMEOUT_MS });
    } finally {
      await watcher.stop();
    }
  });

  it("refreshes a linked worktree when a local project override file appears after watcher ready", async () => {
    const { indexer, watcher, worktreeDir } = createLinkedWorktreeWatcher(tempDir);
    const localConfigPath = path.join(worktreeDir, ".opencode", "codebase-index.json");

    try {
      await watcher.whenReady();
      mkdirSync(path.dirname(localConfigPath), { recursive: true });
      await writeUntilObserved(
        (attempt) => writeFileSync(
          localConfigPath,
          JSON.stringify({ include: ["feature/**/*.ts"], attempt }),
        ),
        () => {
          expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(
            worktreeDir,
            "opencode",
            undefined,
          );
          expect(indexer.index).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      await watcher.stop();
    }
  });

  it("refreshes a linked worktree across inherited config creation, deletion, and recreation", async () => {
    const { configPath, indexer, watcher, worktreeDir } = createLinkedWorktreeWatcher(tempDir, false);

    try {
      await watcher.whenReady();
      mkdirSync(path.dirname(configPath), { recursive: true });
      await writeUntilObserved(
        (attempt) => writeFileSync(
          configPath,
          JSON.stringify({ include: ["created/**/*.ts"], attempt }),
        ),
        () => {
          expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(
            worktreeDir,
            "opencode",
            undefined,
          );
          expect(indexer.index).toHaveBeenCalledTimes(1);
        },
      );

      rmSync(configPath);
      await vi.waitFor(() => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledTimes(2);
        expect(indexer.index).toHaveBeenCalledTimes(2);
      }, { timeout: WATCH_EVENT_TIMEOUT_MS });

      await writeUntilObserved(
        (attempt) => writeFileSync(
          configPath,
          JSON.stringify({ include: ["recreated/**/*.ts"], attempt }),
        ),
        () => {
          expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledTimes(3);
          expect(indexer.index).toHaveBeenCalledTimes(3);
        },
      );
    } finally {
      await watcher.stop();
    }
  });

  it("refreshes from explicit config path when configured", async () => {
    const projectRoot = path.join(tempDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    const configPath = path.join(tempDir, "custom-config.json");
    writeFileSync(configPath, JSON.stringify({ include: ["**/*.ts"] }));

    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { configPath },
    );

    await watcher.whenReady();

    await writeUntilObserved(
      (attempt) => writeFileSync(configPath, JSON.stringify({ include: ["custom/**/*.ts"], attempt })),
      () => {
        expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(
          projectRoot,
          "codex",
          expect.objectContaining({ include: ["custom/**/*.ts"] }),
        );
        expect(indexer.index).toHaveBeenCalledTimes(1);
      },
    );

    await watcher.stop();
  });

  it("does not refresh from project config when explicit config path is configured", async () => {
    const projectRoot = path.join(tempDir, "project");
    mkdirSync(projectRoot, { recursive: true });
    const configPath = path.join(tempDir, "custom-config.json");
    writeFileSync(configPath, JSON.stringify({ include: ["**/*.ts"] }));
    mkdirSync(path.join(projectRoot, ".codebase-index"), { recursive: true });

    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { configPath },
    );

    await watcher.whenReady();
    operationMocks.refreshIndexerForDirectory.mockClear();
    indexer.index.mockClear();

    writeFileSync(path.join(projectRoot, ".codebase-index", "config.json"), JSON.stringify({ include: ["project/**/*.ts"] }));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(operationMocks.refreshIndexerForDirectory).not.toHaveBeenCalled();
    expect(indexer.index).not.toHaveBeenCalled();

    await watcher.stop();
  });
});
