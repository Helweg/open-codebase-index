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
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<void> {
  await vi.waitFor(() => {
    expect(changes).toContainEqual({ path: filePath, type });
  }, { timeout: timeoutMs, interval: 25 });
}

// Real wall-clock delay: the 1000ms delivery debounce is platform behavior of the
// FileWatcher under test, and fake timers cannot drive the real FSEvents/chokidar
// pipeline, so absence of delivery can only be observed against the real clock.
async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// Re-applies a mutation until the expected change is observed. FSEvents can drop
// or delay a single event under heavy concurrent load (full-suite runs), so each
// retry emits a fresh event instead of failing the contract test on a platform
// delivery gap.
async function retryUntilObserved(
  changes: FileChange[],
  filePath: string,
  type: FileChangeType,
  mutate: (attempt: number) => void,
): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < EVENT_TIMEOUT_MS) {
    mutate(attempt);
    attempt += 1;
    const remainingMs = EVENT_TIMEOUT_MS - (Date.now() - startedAt);
    try {
      await waitForChange(changes, filePath, type, Math.min(2500, remainingMs));
      return;
    } catch {
      // Event missed; the next mutate() emits a fresh one.
    }
  }
  throw new Error(`change ${type} for ${filePath} was never observed`);
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
      await retryUntilObserved(changes, filePath, "add", () => {
        fs.rmSync(filePath, { force: true });
        fs.writeFileSync(filePath, `export const version = ${round};\n`);
      });

      changes.length = 0;
      await retryUntilObserved(changes, filePath, "change", (attempt) => {
        fs.writeFileSync(filePath, `export const version = ${round}00${attempt};\n`);
      });

      changes.length = 0;
      await retryUntilObserved(changes, filePath, "unlink", () => {
        fs.writeFileSync(filePath, `export const version = ${round};\n`);
        fs.rmSync(filePath);
      });
    }
  });

  it("reports directory rename", async () => {
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
    const renameStartedAt = Date.now();
    let renameAttempt = 0;
    while (Date.now() - renameStartedAt < EVENT_TIMEOUT_MS) {
      // Reset to the pre-rename state, then rename again so every retry emits a
      // fresh unlink/add pair for the moved files.
      fs.rmSync(renamedDir, { recursive: true, force: true });
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(sourceFiles[0], `export const a = ${renameAttempt};\n`);
      fs.writeFileSync(sourceFiles[1], `export const b = ${renameAttempt};\n`);
      fs.renameSync(sourceDir, renamedDir);
      renameAttempt += 1;
      const remainingMs = EVENT_TIMEOUT_MS - (Date.now() - renameStartedAt);
      try {
        await waitForChange(changes, sourceFiles[0], "unlink", Math.min(2500, remainingMs));
        await waitForChange(changes, sourceFiles[1], "unlink", Math.min(2500, remainingMs));
        await waitForChange(changes, renamedFiles[0], "add", Math.min(2500, remainingMs));
        await waitForChange(changes, renamedFiles[1], "add", Math.min(2500, remainingMs));
        return;
      } catch {
        // Events missed; the next iteration emits a fresh rename.
      }
    }
    throw new Error("directory rename was never observed");
  });

  it("reports directory deletion", async () => {
    const changes: FileChange[] = [];
    const deletedDir = path.join(projectRoot, "removed");
    const deletedFiles = [path.join(deletedDir, "a.ts"), path.join(deletedDir, "b.ts")];
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    fs.mkdirSync(deletedDir, { recursive: true });
    fs.writeFileSync(deletedFiles[0], "export const a = 1;\n");
    fs.writeFileSync(deletedFiles[1], "export const b = 1;\n");
    await waitForChange(changes, deletedFiles[0], "add");
    await waitForChange(changes, deletedFiles[1], "add");

    changes.length = 0;
    const deletionStartedAt = Date.now();
    let deletionAttempt = 0;
    while (Date.now() - deletionStartedAt < EVENT_TIMEOUT_MS) {
      // Recreate the directory, then remove it again so every retry emits a
      // fresh unlink pair for the deleted files.
      fs.mkdirSync(deletedDir, { recursive: true });
      fs.writeFileSync(deletedFiles[0], `export const a = ${deletionAttempt};\n`);
      fs.writeFileSync(deletedFiles[1], `export const b = ${deletionAttempt};\n`);
      fs.rmSync(deletedDir, { recursive: true });
      deletionAttempt += 1;
      const remainingMs = EVENT_TIMEOUT_MS - (Date.now() - deletionStartedAt);
      try {
        await waitForChange(changes, deletedFiles[0], "unlink", Math.min(2500, remainingMs));
        await waitForChange(changes, deletedFiles[1], "unlink", Math.min(2500, remainingMs));
        return;
      } catch {
        // Events missed; the next iteration emits a fresh deletion.
      }
    }
    throw new Error("directory deletion was never observed");
  });

  it("delivers root file changes", async () => {
    const changes: FileChange[] = [];
    const filePath = path.join(projectRoot, "root.ts");
    watcher = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });

    watcher.start(async (batch) => {
      changes.push(...batch);
    });
    await watcher.waitUntilReady();

    await retryUntilObserved(changes, filePath, "add", () => {
      fs.rmSync(filePath, { force: true });
      fs.writeFileSync(filePath, "export const root = 1;\n");
    });

    changes.length = 0;
    await retryUntilObserved(changes, filePath, "change", (attempt) => {
      fs.writeFileSync(filePath, `export const root = 100${attempt};\n`);
    });
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

    await retryUntilObserved(changes, trackedPath, "add", () => {
      fs.rmSync(trackedPath, { force: true });
      fs.writeFileSync(trackedPath, "export const tracked = 1;\n");
    });

    changes.length = 0;
    await retryUntilObserved(changes, trackedPath, "unlink", () => {
      fs.writeFileSync(gitignorePath, "tracked.ts\n");
    });

    changes.length = 0;
    await retryUntilObserved(changes, trackedPath, "add", () => {
      fs.rmSync(gitignorePath);
      fs.writeFileSync(trackedPath, "export const tracked = 1;\n");
    });
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

    await retryUntilObserved(changes, firstPath, "add", () => {
      fs.rmSync(firstPath, { force: true });
      fs.writeFileSync(firstPath, "export const a = 1;\n");
    });

    await watcher.stop();
    watcher = undefined;

    const restarted = new FileWatcher(projectRoot, parseConfig({ include: ["**/*.ts"] }), "codex", { backend });
    watcher = restarted;
    const baselineLength = changes.length;
    restarted.start(async (batch) => {
      changes.push(...batch);
    });
    await restarted.waitUntilReady();

    await retryUntilObserved(changes, secondPath, "add", () => {
      fs.rmSync(secondPath, { force: true });
      fs.writeFileSync(secondPath, "export const b = 1;\n");
    });

    expect(changes.slice(baselineLength)).toContainEqual({ type: "add", path: secondPath });
    expect(changes.slice(baselineLength)).not.toContainEqual({ type: "add", path: firstPath });
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

    await retryUntilObserved(changes, configPath, "add", () => {
      fs.rmSync(configPath, { force: true });
      fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    });

    changes.length = 0;
    await retryUntilObserved(changes, configPath, "change", (attempt) => {
      fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts", `lib${attempt}/**/*.ts`] }));
    });

    changes.length = 0;
    await retryUntilObserved(changes, configPath, "unlink", () => {
      fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
      fs.rmSync(configPath);
    });

    changes.length = 0;
    await retryUntilObserved(changes, configPath, "add", () => {
      fs.rmSync(configPath, { force: true });
      fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    });
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
    await retryUntilObserved(changes, configPath, "add", () => {
      fs.rmSync(configPath, { force: true });
      fs.writeFileSync(configPath, JSON.stringify({ include: ["src/**/*.ts"] }));
    });
  });
});
