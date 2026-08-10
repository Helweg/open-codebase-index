import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

  const reconcileConfig = {
    include: ["**/*.ts"],
    additionalInclude: [],
    exclude: ["**/*.test.ts"],
  };

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

    fs.writeFileSync(trackedFile, "export const version = 2;");
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
});
