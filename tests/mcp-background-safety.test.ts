import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { resolveProjectIndexPath } from "../src/config/paths.js";
import { attachMcpBackgroundWatcher, createMcpServer } from "../src/mcp-server.js";
import { refreshIndexerForDirectory } from "../src/tools/operations.js";
import { resetAutoIndexCoordinatorsForTests } from "../src/utils/auto-index.js";
import {
  configureBackgroundWorker,
  getBackgroundWorkerLeasePath,
  isBackgroundWorkerLeader,
  isBackgroundWorkerManaged,
  resetBackgroundWorkersForTests,
} from "../src/utils/background-worker.js";

const autoIndexMocks = vi.hoisted(() => ({
  startAutoIndexForBackgroundWorker: vi.fn(),
  stopAutoIndexForBackgroundWorker: vi.fn(async () => ({
    completed: true,
    completion: Promise.resolve(),
  })),
}));

vi.mock("../src/utils/auto-index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/auto-index.js")>("../src/utils/auto-index.js");
  return {
    ...actual,
    startAutoIndexForBackgroundWorker: autoIndexMocks.startAutoIndexForBackgroundWorker,
    stopAutoIndexForBackgroundWorker: autoIndexMocks.stopAutoIndexForBackgroundWorker,
  };
});

describe("MCP background worker safety", () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-background-safety-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    autoIndexMocks.startAutoIndexForBackgroundWorker.mockReset();
    autoIndexMocks.stopAutoIndexForBackgroundWorker.mockClear();
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    await resetBackgroundWorkersForTests();
    await resetAutoIndexCoordinatorsForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function expectNoBackgroundWorkerArtifacts(
    projectRoot: string,
    config: ReturnType<typeof parseConfig>,
  ): Promise<void> {
    const indexPath = resolveProjectIndexPath(projectRoot, config.scope, "codex");
    const leasePath = getBackgroundWorkerLeasePath(projectRoot, config, "codex");

    createMcpServer(projectRoot, config, "codex");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(isBackgroundWorkerManaged(projectRoot, "codex")).toBe(false);
    expect(existsSync(indexPath)).toBe(false);
    expect(existsSync(leasePath)).toBe(false);
  }

  it("does not create an index directory or lease for the home directory", async () => {
    const homeDir = path.join(tempDir, "home");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const config = parseConfig({
      indexing: {
        autoIndex: true,
        requireProjectMarker: false,
        watchFiles: false,
      },
    });

    await expectNoBackgroundWorkerArtifacts(homeDir, config);
  });

  it("does not create an index directory or lease when a project marker is missing", async () => {
    const projectRoot = path.join(tempDir, "without-marker");
    const config = parseConfig({
      indexing: {
        autoIndex: true,
        requireProjectMarker: true,
        watchFiles: false,
      },
    });

    await expectNoBackgroundWorkerArtifacts(projectRoot, config);
  });

  it("stops a worker when a watched project becomes marker-required", async () => {
    const projectRoot = path.join(tempDir, "refresh-without-marker");
    const safeConfig = parseConfig({
      indexing: {
        autoIndex: false,
        requireProjectMarker: false,
        watchFiles: true,
      },
    });
    const unsafeConfig = parseConfig({
      indexing: {
        autoIndex: false,
        requireProjectMarker: true,
        watchFiles: true,
      },
    });
    const watcher = { stop: vi.fn(async () => {}) };
    const server = createMcpServer(projectRoot, safeConfig, "codex");

    try {
      attachMcpBackgroundWatcher(projectRoot, safeConfig, "codex", () => watcher);
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));

      const leasePath = getBackgroundWorkerLeasePath(projectRoot, safeConfig, "codex");
      expect(existsSync(leasePath)).toBe(true);

      refreshIndexerForDirectory(projectRoot, "codex", unsafeConfig);

      await vi.waitFor(() => expect(isBackgroundWorkerManaged(projectRoot, "codex")).toBe(false));
      expect(watcher.stop).toHaveBeenCalledOnce();
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("does not let a joining MCP server disable an active worker", async () => {
    const projectRoot = path.join(tempDir, "shared-process-project");
    const leaderConfig = parseConfig({
      indexing: {
        autoIndex: true,
        requireProjectMarker: false,
        watchFiles: false,
      },
    });
    const followerConfig = parseConfig({
      indexing: {
        autoIndex: false,
        requireProjectMarker: false,
        watchFiles: false,
      },
    });
    const leader = createMcpServer(projectRoot, leaderConfig, "codex");
    const follower = createMcpServer(projectRoot, followerConfig, "codex");

    try {
      await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true));
      expect(autoIndexMocks.startAutoIndexForBackgroundWorker).toHaveBeenCalledOnce();

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(isBackgroundWorkerLeader(projectRoot, "codex")).toBe(true);
    } finally {
      await follower.close();
      await leader.close();
    }
  });

  it("does not let an unsafe MCP server stop a pre-existing non-MCP worker", async () => {
    const projectRoot = path.join(tempDir, "opencode-shared-worker");
    const config = parseConfig({
      indexing: {
        autoIndex: false,
        requireProjectMarker: false,
        watchFiles: true,
      },
    });
    const watcher = { stop: vi.fn(async () => {}) };
    configureBackgroundWorker(projectRoot, "opencode", config, {
      startAutoIndex: vi.fn(),
      stopAutoIndex: vi.fn(async () => ({ completed: true, completion: Promise.resolve() })),
      watcherFactory: () => watcher,
    });
    await vi.waitFor(() => expect(isBackgroundWorkerLeader(projectRoot, "opencode")).toBe(true));

    const unsafeMcpConfig = parseConfig({
      indexing: {
        autoIndex: false,
        requireProjectMarker: true,
        watchFiles: false,
      },
    });
    const server = createMcpServer(projectRoot, unsafeMcpConfig, "opencode");
    await server.close();

    expect(isBackgroundWorkerLeader(projectRoot, "opencode")).toBe(true);
    expect(watcher.stop).not.toHaveBeenCalled();
  });
});
