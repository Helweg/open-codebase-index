import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSnapshotReconciler } from "../src/watcher/snapshot-reconciler.js";

const readdirPermissionOverrides = new Map<string, string>();

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

  return {
    ...actual,
    readdir: async (directoryPath: string | URL, options: any) => {
      const resolvedPath = path.resolve(String(directoryPath));
      const permissionCode = readdirPermissionOverrides.get(resolvedPath);
      if (permissionCode) {
        const permissionError = new Error("Permission denied") as NodeJS.ErrnoException;
        permissionError.code = permissionCode;
        throw permissionError;
      }

      return actual.readdir(directoryPath, options);
    },
  };
});

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

  it("reconciles only the invalidated file path", async () => {
    const observedFile = path.join(projectRoot, "observed.ts");
    const unrelatedFile = path.join(projectRoot, "unrelated.ts");
    fs.writeFileSync(observedFile, "export const observed = 1;");
    fs.writeFileSync(unrelatedFile, "export const unrelated = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.writeFileSync(observedFile, "export const observed = 2;");
    fs.writeFileSync(unrelatedFile, "export const unrelated = 2;");

    expect(await reconciler.reconcile([observedFile])).toEqual([
      { path: observedFile, type: "change" },
    ]);
    expect(await reconciler.reconcile()).toEqual([
      { path: unrelatedFile, type: "change" },
    ]);
  });

  it("removes every tracked descendant when an invalidated directory was deleted", async () => {
    const removedDirectory = path.join(projectRoot, "removed");
    const firstFile = path.join(removedDirectory, "first.ts");
    const secondFile = path.join(removedDirectory, "nested", "second.ts");
    fs.mkdirSync(path.dirname(secondFile), { recursive: true });
    fs.writeFileSync(firstFile, "export const first = 1;");
    fs.writeFileSync(secondFile, "export const second = 2;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.rmSync(removedDirectory, { recursive: true });

    expect(await reconciler.reconcile([removedDirectory])).toEqual([
      { path: firstFile, type: "unlink" },
      { path: secondFile, type: "unlink" },
    ]);
  });

  it("uses a full reconciliation when native watcher supplies no path hint", async () => {
    const trackedFile = path.join(projectRoot, "tracked.ts");
    fs.writeFileSync(trackedFile, "export const tracked = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.writeFileSync(trackedFile, "export const tracked = 2;");

    expect(await reconciler.reconcile([null])).toEqual([
      { path: trackedFile, type: "change" },
    ]);
  });

  it("throws before initialization", async () => {
    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await expect(reconciler.reconcile()).rejects.toThrow(
      "FileSnapshotReconciler is not initialized. Call initialize() before reconcile().",
    );
  });

  it("preserves tracked files under unreadable directories during full reconciliation", async () => {
    const visibleFile = path.join(projectRoot, "visible.ts");
    const unreadableDirectory = path.join(projectRoot, "private");
    const unreadableFile = path.join(unreadableDirectory, "secret.ts");

    fs.writeFileSync(visibleFile, "export const visible = 1;");
    fs.mkdirSync(unreadableDirectory, { recursive: true });
    fs.writeFileSync(unreadableFile, "export const secret = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    fs.unlinkSync(visibleFile);

    readdirPermissionOverrides.set(unreadableDirectory, "EACCES");
    try {
      const changes = await reconciler.reconcile();
      expect(changes).toEqual([{ path: visibleFile, type: "unlink" }]);
    } finally {
      readdirPermissionOverrides.delete(unreadableDirectory);
    }
  });

  it("keeps scope-limited reconciliations scoped and preserves unreadable scope roots", async () => {
    const scopeDirectory = path.join(projectRoot, "private");
    const visibleFile = path.join(projectRoot, "visible.ts");
    const unreadableFile = path.join(scopeDirectory, "secret.ts");

    fs.mkdirSync(scopeDirectory, { recursive: true });
    fs.writeFileSync(visibleFile, "export const visible = 1;");
    fs.writeFileSync(unreadableFile, "export const secret = 1;");

    const reconciler = new FileSnapshotReconciler(projectRoot, reconcileConfig, []);
    await reconciler.initialize();

    readdirPermissionOverrides.set(scopeDirectory, "EPERM");
    fs.writeFileSync(visibleFile, "export const visible = 2;");
    try {
      const scopedChanges = await reconciler.reconcile([scopeDirectory]);
      expect(scopedChanges).toEqual([]);
    } finally {
      readdirPermissionOverrides.delete(scopeDirectory);
    }
  });
});
