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

vi.mock("../src/git/index.js", () => ({
  isGitRepo: vi.fn(() => false),
  resolveWorktreeMainRepoRoot: vi.fn(() => null),
}));

import { parseConfig } from "../src/config/schema.js";
import { createWatcherWithIndexer } from "../src/watcher/index.js";

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
    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      tempDir,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    mkdirSync(path.join(tempDir, ".codebase-index"), { recursive: true });
    writeFileSync(path.join(tempDir, ".codebase-index", "config.json"), JSON.stringify({ include: ["src/**/*.ts"] }));

    await vi.waitFor(() => {
      expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "codex", undefined);
      expect(indexer.index).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

    await watcher.stop();
  });

  it("refreshes the jcode indexer cache before reindexing when jcode config changes", async () => {
    const indexer = {
      index: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = createWatcherWithIndexer(
      () => indexer,
      tempDir,
      parseConfig({ include: ["**/*.ts"] }),
      "jcode",
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    mkdirSync(path.join(tempDir, ".codebase-index"), { recursive: true });
    writeFileSync(path.join(tempDir, ".codebase-index", "config.json"), JSON.stringify({ include: ["src/**/*.ts"] }));

    await vi.waitFor(() => {
      expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "jcode", undefined);
      expect(indexer.index).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

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

    await new Promise((resolve) => setTimeout(resolve, 100));

    mkdirSync(path.join(tempDir, ".opencode", "index"), { recursive: true });
    writeFileSync(path.join(tempDir, ".opencode", "codebase-index.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    writeFileSync(path.join(tempDir, ".opencode", "index", "codebase.db"), "index");

    await vi.waitFor(() => {
      expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "codex", undefined);
      expect(indexer.index).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

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

    await new Promise((resolve) => setTimeout(resolve, 100));

    mkdirSync(path.join(tempDir, ".opencode", "index"), { recursive: true });
    writeFileSync(path.join(tempDir, ".opencode", "codebase-index.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    writeFileSync(path.join(tempDir, ".opencode", "index", "codebase.db"), "index");

    await vi.waitFor(() => {
      expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(tempDir, "jcode", undefined);
      expect(indexer.index).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

    await watcher.stop();
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

    await new Promise((resolve) => setTimeout(resolve, 100));

    writeFileSync(configPath, JSON.stringify({ include: ["custom/**/*.ts"] }));

    await vi.waitFor(() => {
      expect(operationMocks.refreshIndexerForDirectory).toHaveBeenCalledWith(
        projectRoot,
        "codex",
        expect.objectContaining({ include: ["custom/**/*.ts"] }),
      );
      expect(indexer.index).toHaveBeenCalledTimes(1);
    }, { timeout: 2500 });

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

    await new Promise((resolve) => setTimeout(resolve, 100));
    operationMocks.refreshIndexerForDirectory.mockClear();
    indexer.index.mockClear();

    writeFileSync(path.join(projectRoot, ".codebase-index", "config.json"), JSON.stringify({ include: ["project/**/*.ts"] }));
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(operationMocks.refreshIndexerForDirectory).not.toHaveBeenCalled();
    expect(indexer.index).not.toHaveBeenCalled();

    await watcher.stop();
  });
});
