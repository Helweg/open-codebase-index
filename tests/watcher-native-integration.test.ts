import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { FileWatcher, type FileChange, type FileChangeType } from "../src/watcher/file-watcher.js";

const EVENT_TIMEOUT_MS = 10_000;

async function waitForChange(
  changes: FileChange[],
  filePath: string,
  type: FileChangeType,
): Promise<void> {
  await vi.waitFor(() => {
    expect(changes).toContainEqual({ path: filePath, type });
  }, { timeout: EVENT_TIMEOUT_MS, interval: 25 });
}

describe.runIf(process.platform === "darwin")("experimental native FileWatcher", () => {
  let projectRoot: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-file-watcher-"));
    vi.stubEnv("CODEBASE_INDEX_EXPERIMENTAL_NATIVE_WATCHER", "true");
  });

  afterEach(async () => {
    await watcher?.stop();
    vi.unstubAllEnvs();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("reconciles native notifications into add, change, and unlink events", async () => {
    const changes: FileChange[] = [];
    const filePath = path.join(projectRoot, "observed.ts");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex");

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.writeFileSync(filePath, "export const version = 1;\n");
    await waitForChange(changes, filePath, "add");

    changes.length = 0;
    fs.writeFileSync(filePath, "export const version = 200;\n");
    await waitForChange(changes, filePath, "change");

    changes.length = 0;
    fs.rmSync(filePath);
    await waitForChange(changes, filePath, "unlink");
  });

  it("tracks hidden project configuration files outside source include patterns", async () => {
    const changes: FileChange[] = [];
    const configPath = path.join(projectRoot, ".codebase-index", "config.json");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex");

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    await waitForChange(changes, configPath, "add");
  });
});
