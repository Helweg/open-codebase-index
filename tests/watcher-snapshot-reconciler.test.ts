import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { FileSnapshotReconciler } from "../src/watcher/snapshot-reconciler.js";

describe("watcher snapshot reconciler", () => {
  let projectRoot: string;
  let cleanupPaths: string[];

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-reconciler-"));
    cleanupPaths = [];
  });

  const cleanup = (): void => {
    for (const cleanupPath of cleanupPaths) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }

    fs.rmSync(projectRoot, { recursive: true, force: true });
  };

  afterEach(() => {
    cleanup();
  });

  const reconcileConfig = parseConfig({
    include: ["**/*.ts"],
    additionalInclude: [],
    exclude: ["**/*.test.ts"],
  });

  it("diffs adds, changes, and unlinks after initialization", async () => {
    const trackedOne = path.join(projectRoot, "tracked-one.ts");
    const trackedTwo = path.join(projectRoot, "tracked-two.ts");
    const removed = path.join(projectRoot, "tracked-removed.ts");
    const added = path.join(projectRoot, "new.ts");

    fs.writeFileSync(trackedOne, "export const one = 1;");
    fs.writeFileSync(trackedTwo, "export const two = 2;");
    fs.writeFileSync(removed, "export const removed = 3;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.unlinkSync(removed);
    fs.writeFileSync(trackedOne, "export const one = 10;");
    fs.writeFileSync(added, "export const added = 4;");

    const changes = await reconciler.reconcile();
    expect(changes).toEqual([
      { path: added, type: "add" },
      { path: trackedOne, type: "change" },
      { path: removed, type: "unlink" },
    ]);
  });

  it("reports explicit config delete and recreate events", async () => {
    const externalConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-config-"));
    cleanupPaths.push(externalConfigDir);
    const externalConfig = path.join(externalConfigDir, "project.config.json");
    const internalConfig = path.join(projectRoot, ".internal.config.json");

    fs.writeFileSync(externalConfig, "{}\n");
    fs.writeFileSync(internalConfig, "{}\n");

    const trackedFile = path.join(projectRoot, "tracked.ts");
    fs.writeFileSync(trackedFile, "export const tracked = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, [internalConfig, externalConfig]);
    await reconciler.initialize();

    fs.rmSync(externalConfig);

    const afterDelete = await reconciler.reconcile();
    expect(afterDelete).toEqual([{ path: externalConfig, type: "unlink" }]);

    fs.writeFileSync(externalConfig, "{}\n");
    const afterRecreate = await reconciler.reconcile();
    expect(afterRecreate).toEqual([{ path: externalConfig, type: "add" }]);
  });

  it("serializes overlapping reconciliations without duplicate changes", async () => {
    const trackedFile = path.join(projectRoot, "tracked.ts");
    fs.writeFileSync(trackedFile, "export const version = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    // Different content length so the change is detected by size even when the
    // filesystem reports identical mtimeMs for two writes in the same millisecond.
    fs.writeFileSync(trackedFile, "export const version = 22;");
    const [first, second] = await Promise.all([reconciler.reconcile(), reconciler.reconcile()]);

    expect(first).toEqual([{ path: trackedFile, type: "change" }]);
    expect(second).toEqual([]);
  });

  it("throws before initialization", async () => {
    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await expect(reconciler.reconcile()).rejects.toThrow(
      "FileSnapshotReconciler is not initialized. Call initialize() before reconcile().",
    );
  });

  it("adds, unlinks, and renames nested directories via snapshot diff", async () => {
    const originalDir = path.join(projectRoot, "nested");
    const renamedDir = path.join(projectRoot, "renamed");
    const originalFiles = [path.join(originalDir, "one.ts"), path.join(originalDir, "two.ts")];
    const renamedFiles = [path.join(renamedDir, "one.ts"), path.join(renamedDir, "two.ts")];

    const sortByPath = (changes: Array<{ path: string; type: string }>): Array<{ path: string; type: string }> =>
      [...changes].sort((left, right) => {
        if (left.path < right.path) return -1;
        if (left.path > right.path) return 1;
        return 0;
      });

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    // (a) add a nested directory with files: one add per file
    fs.mkdirSync(originalDir, { recursive: true });
    fs.writeFileSync(originalFiles[0], "export const one = 1;");
    fs.writeFileSync(originalFiles[1], "export const two = 2;");

    let changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath(originalFiles.map((filePath) => ({ path: filePath, type: "add" }))),
    );

    // (b) delete the whole directory: one unlink per file
    fs.rmSync(originalDir, { recursive: true });

    changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath(originalFiles.map((filePath) => ({ path: filePath, type: "unlink" }))),
    );

    // (c) rename the directory: unlinks for old paths, adds for new paths
    fs.mkdirSync(originalDir, { recursive: true });
    fs.writeFileSync(originalFiles[0], "export const one = 1;");
    fs.writeFileSync(originalFiles[1], "export const two = 2;");
    await reconciler.reconcile();

    fs.renameSync(originalDir, renamedDir);

    changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath([
        ...renamedFiles.map((filePath) => ({ path: filePath, type: "add" })),
        ...originalFiles.map((filePath) => ({ path: filePath, type: "unlink" })),
      ]),
    );
  });

  it("reports a single change for mtime and size mutation of a tracked file", async () => {
    const trackedFile = path.join(projectRoot, "tracked.ts");
    fs.writeFileSync(trackedFile, "export const version = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.writeFileSync(trackedFile, "export const version = 10;");
    const futureMtime = new Date(Date.now() + 5_000);
    fs.utimesSync(trackedFile, futureMtime, futureMtime);

    const changes = await reconciler.reconcile();
    expect(changes).toEqual([{ path: trackedFile, type: "change" }]);
  });

  it("flips tracked-file eligibility when .gitignore rules change", async () => {
    const trackedFile = path.join(projectRoot, "tracked.ts");
    fs.writeFileSync(trackedFile, "export const tracked = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "tracked.ts\n");
    const afterIgnore = await reconciler.reconcile();
    expect(afterIgnore).toEqual([{ path: trackedFile, type: "unlink" }]);

    fs.rmSync(path.join(projectRoot, ".gitignore"));
    const afterUnignore = await reconciler.reconcile();
    expect(afterUnignore).toEqual([{ path: trackedFile, type: "add" }]);
  });

  it("tracks external and inherited config create, modify, delete, and recreate", async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-config-"));
    cleanupPaths.push(externalDir);
    const inheritedDir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-config-"));
    cleanupPaths.push(inheritedDir);

    const externalConfig = path.join(externalDir, "external.config.json");
    const inheritedConfig = path.join(inheritedDir, "inherited.config.json");

    const sortByPath = (changes: Array<{ path: string; type: string }>): Array<{ path: string; type: string }> =>
      [...changes].sort((left, right) => {
        if (left.path < right.path) return -1;
        if (left.path > right.path) return 1;
        return 0;
      });

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, [
      externalConfig,
      inheritedConfig,
    ]);
    await reconciler.initialize();

    // create both configs after initialize: one add per config path
    fs.writeFileSync(externalConfig, "{}\n");
    fs.writeFileSync(inheritedConfig, "{}\n");

    let changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath([
        { path: externalConfig, type: "add" },
        { path: inheritedConfig, type: "add" },
      ]),
    );

    // modify both: one change per config path
    fs.writeFileSync(externalConfig, "{ \"updated\": true }\n");
    fs.writeFileSync(inheritedConfig, "{ \"updated\": true }\n");

    changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath([
        { path: externalConfig, type: "change" },
        { path: inheritedConfig, type: "change" },
      ]),
    );

    // delete both: one unlink per config path
    fs.rmSync(externalConfig);
    fs.rmSync(inheritedConfig);

    changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath([
        { path: externalConfig, type: "unlink" },
        { path: inheritedConfig, type: "unlink" },
      ]),
    );

    // recreate both: one add per config path
    fs.writeFileSync(externalConfig, "{}\n");
    fs.writeFileSync(inheritedConfig, "{}\n");

    changes = await reconciler.reconcile();
    expect(changes).toEqual(
      sortByPath([
        { path: externalConfig, type: "add" },
        { path: inheritedConfig, type: "add" },
      ]),
    );
  });
});
