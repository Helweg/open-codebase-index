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

// Real wall-clock delay: the 1000ms delivery debounce is platform behavior of the
// FileWatcher under test, and fake timers cannot drive the real FSEvents/chokidar
// pipeline, so absence of delivery can only be observed against the real clock.
async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe.each(["native", "chokidar"] as const)("real %s FileWatcher backend", (backend) => {
  let projectRoot: string;
  let watcher: FileWatcher | undefined;
  const externalDirs: string[] = [];

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `watcher-${backend}-`));
  });

  afterEach(async () => {
    await watcher?.stop();
    for (const dir of externalDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    externalDirs.length = 0;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("delivers add, change, and unlink across three rounds", async () => {
    const changes: FileChange[] = [];
    const filePath = path.join(projectRoot, "observed.ts");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    for (let round = 1; round <= 3; round += 1) {
      changes.length = 0;
      fs.writeFileSync(filePath, `export const version = ${round};\n`);
      await waitForChange(changes, filePath, "add");

      changes.length = 0;
      fs.writeFileSync(filePath, `export const version = ${round}00;\n`);
      await waitForChange(changes, filePath, "change");

      changes.length = 0;
      fs.rmSync(filePath);
      await waitForChange(changes, filePath, "unlink");
    }
  });

  it("reports rename and directory deletion", async () => {
    const changes: FileChange[] = [];
    const sourceDir = path.join(projectRoot, "src");
    const renamedDir = path.join(projectRoot, "src-renamed");
    const sourceFiles = [path.join(sourceDir, "a.ts"), path.join(sourceDir, "b.ts")];
    const renamedFiles = [path.join(renamedDir, "a.ts"), path.join(renamedDir, "b.ts")];
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceFiles[0], "export const a = 1;\n");
    fs.writeFileSync(sourceFiles[1], "export const b = 1;\n");
    await waitForChange(changes, sourceFiles[0], "add");
    await waitForChange(changes, sourceFiles[1], "add");

    changes.length = 0;
    fs.renameSync(sourceDir, renamedDir);
    await waitForChange(changes, sourceFiles[0], "unlink");
    await waitForChange(changes, sourceFiles[1], "unlink");
    await waitForChange(changes, renamedFiles[0], "add");
    await waitForChange(changes, renamedFiles[1], "add");

    changes.length = 0;
    fs.rmSync(renamedDir, { recursive: true });
    await waitForChange(changes, renamedFiles[0], "unlink");
    await waitForChange(changes, renamedFiles[1], "unlink");
  });

  it("delivers root file changes", async () => {
    const changes: FileChange[] = [];
    const filePath = path.join(projectRoot, "root.ts");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.writeFileSync(filePath, "export const root = 1;\n");
    await waitForChange(changes, filePath, "add");

    changes.length = 0;
    fs.writeFileSync(filePath, "export const root = 100;\n");
    await waitForChange(changes, filePath, "change");
  });

  it("ignores hidden paths and excluded paths without delivering changes", async () => {
    const changes: FileChange[] = [];
    const hiddenPath = path.join(projectRoot, ".hidden", "file.ts");
    const excludedPath = path.join(projectRoot, "excluded.test.ts");
    watcher = new FileWatcher(
      projectRoot,
      parseConfig({ include: ["**/*.ts"], exclude: ["**/*.test.ts"] }),
      "codex",
      { backend },
    );

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.mkdirSync(path.dirname(hiddenPath), { recursive: true });
    fs.writeFileSync(hiddenPath, "export const hidden = 1;\n");
    fs.writeFileSync(excludedPath, "export const excluded = 1;\n");
    await delay(1500);
    expect(changes.filter((change) => change.path === hiddenPath || change.path === excludedPath)).toEqual([]);

    fs.writeFileSync(hiddenPath, "export const hidden = 2;\n");
    fs.writeFileSync(excludedPath, "export const excluded = 2;\n");
    await delay(1500);
    expect(changes.filter((change) => change.path === hiddenPath || change.path === excludedPath)).toEqual([]);
  });

  it("reflects .gitignore rule add and removal", async () => {
    const changes: FileChange[] = [];
    const trackedPath = path.join(projectRoot, "tracked.ts");
    const gitignorePath = path.join(projectRoot, ".gitignore");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.writeFileSync(trackedPath, "export const tracked = 1;\n");
    await waitForChange(changes, trackedPath, "add");

    changes.length = 0;
    fs.writeFileSync(gitignorePath, "tracked.ts\n");
    await waitForChange(changes, trackedPath, "unlink");

    changes.length = 0;
    fs.rmSync(gitignorePath);
    await waitForChange(changes, trackedPath, "add");
  });

  it("survives stop and restart", async () => {
    const changes: FileChange[] = [];
    const firstPath = path.join(projectRoot, "a.ts");
    const secondPath = path.join(projectRoot, "b.ts");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.writeFileSync(firstPath, "export const a = 1;\n");
    await waitForChange(changes, firstPath, "add");

    await watcher.stop();
    watcher = undefined;

    const restarted = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });
    watcher = restarted;
    const baselineLength = changes.length;
    restarted.start(async (batch) => {
      changes.push(...batch);
    });
    await restarted.waitUntilReady();

    fs.writeFileSync(secondPath, "export const b = 1;\n");
    await waitForChange(changes, secondPath, "add");

    expect(changes.slice(baselineLength)).toEqual([{ type: "add", path: secondPath }]);
  });

  it("tracks external configuration create, update, delete, and recreate", async () => {
    const changes: FileChange[] = [];
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-external-config-"));
    externalDirs.push(externalDir);
    const configPath = path.join(externalDir, "config.json");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend, configPath });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    await waitForChange(changes, configPath, "add");

    changes.length = 0;
    fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts", "lib/**/*.ts"] }));
    await waitForChange(changes, configPath, "change");

    changes.length = 0;
    fs.rmSync(configPath);
    await waitForChange(changes, configPath, "unlink");

    changes.length = 0;
    fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    await waitForChange(changes, configPath, "add");
  });

  it("tracks hidden project configuration files outside source include patterns", async () => {
    const changes: FileChange[] = [];
    const configPath = path.join(projectRoot, ".codebase-index", "config.json");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend, configPath });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    await waitForChange(changes, configPath, "add");
  });
});
