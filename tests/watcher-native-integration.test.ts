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

async function writeUntilChangeObserved(
  write: (attempt: number) => void,
  assertion: () => void,
): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() - startedAt < EVENT_TIMEOUT_MS) {
    write(attempt++);
    try {
      await vi.waitFor(assertion, { timeout: 2_500, interval: 25 });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

describe("native FileWatcher", () => {
  let projectRoot: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-file-watcher-"));
  });

  afterEach(async () => {
    await watcher?.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("reconciles native notifications into add, change, and unlink events", async () => {
    const changes: FileChange[] = [];
    const filePath = path.join(projectRoot, "observed.ts");
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

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
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    await writeUntilChangeObserved(
      (attempt) => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"], attempt }));
      },
      () => expect(changes).toContainEqual({ path: configPath, type: "add" }),
    );
  });

  it("tracks nested tsconfig changes outside source include patterns", async () => {
    const changes: FileChange[] = [];
    const configPath = path.join(projectRoot, "packages", "app", "tsconfig.json");
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    await writeUntilChangeObserved(
      (attempt) => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ compilerOptions: { baseUrl: `./src-${attempt}` } }));
      },
      () => expect(changes).toContainEqual({ path: configPath, type: "add" }),
    );
  });

  it("tracks the lifecycle of a missing arbitrary local extends target", async () => {
    const changes: FileChange[] = [];
    const appConfig = path.join(projectRoot, "packages", "app", "tsconfig.json");
    const baseConfig = path.join(projectRoot, "packages", "config", "base.json");
    fs.mkdirSync(path.dirname(appConfig), { recursive: true });
    fs.writeFileSync(appConfig, JSON.stringify({ extends: "../config/base" }));
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      "codex",
      { backend: "native" },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    await writeUntilChangeObserved(
      (attempt) => {
        fs.mkdirSync(path.dirname(baseConfig), { recursive: true });
        fs.writeFileSync(baseConfig, JSON.stringify({ compilerOptions: { baseUrl: `./src-${attempt}` } }));
      },
      () => expect(changes).toContainEqual({ path: baseConfig, type: "add" }),
    );

    changes.length = 0;
    fs.rmSync(baseConfig);
    await waitForChange(changes, baseConfig, "unlink");
  });
});
