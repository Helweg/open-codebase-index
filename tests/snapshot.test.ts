import { describe, expect, it } from "vitest";

import type { FileSnapshotEntry, FileSnapshotMap } from "../src/watcher/snapshot.js";
import { diffFileSnapshots } from "../src/watcher/snapshot.js";

describe("watcher snapshot diff", () => {
  it("reports add, change, and unlink operations", () => {
    const previous: FileSnapshotMap = new Map<string, FileSnapshotEntry>([
      ["src/index.ts", { size: 8, mtimeMs: 100 }],
      ["src/old.ts", { size: 4, mtimeMs: 120 }],
    ]);

    const current: FileSnapshotMap = new Map<string, FileSnapshotEntry>([
      ["src/index.ts", { size: 12, mtimeMs: 100 }],
      ["src/new.ts", { size: 3, mtimeMs: 210 }],
      ["src/added-later.ts", { size: 1, mtimeMs: 220 }],
    ]);

    const changes = diffFileSnapshots(previous, current);

    expect(changes).toEqual([
      { path: "src/added-later.ts", type: "add" },
      { path: "src/index.ts", type: "change" },
      { path: "src/new.ts", type: "add" },
      { path: "src/old.ts", type: "unlink" },
    ]);
  });

  it("omits unchanged files", () => {
    const previous: FileSnapshotMap = new Map<string, FileSnapshotEntry>([
      ["src/common.ts", { size: 44, mtimeMs: 300 }],
      ["src/ignored.ts", { size: 12, mtimeMs: 500 }],
    ]);

    const current: FileSnapshotMap = new Map<string, FileSnapshotEntry>([
      ["src/ignored.ts", { size: 12, mtimeMs: 500 }],
      ["src/common.ts", { size: 44, mtimeMs: 300 }],
    ]);

    expect(diffFileSnapshots(previous, current)).toEqual([]);
  });

  it("returns deterministic ordering by path", () => {
    const previous: FileSnapshotMap = new Map<string, FileSnapshotEntry>([
      ["zeta.ts", { size: 10, mtimeMs: 1 }],
      ["alpha.ts", { size: 12, mtimeMs: 2 }],
      ["gamma.ts", { size: 3, mtimeMs: 3 }],
    ]);

    const current: FileSnapshotMap = new Map<string, FileSnapshotEntry>([
      ["beta.ts", { size: 9, mtimeMs: 4 }],
      ["alpha.ts", { size: 99, mtimeMs: 5 }],
      ["zeta.ts", { size: 10, mtimeMs: 1 }],
      ["delta.ts", { size: 8, mtimeMs: 6 }],
    ]);

    const changes = diffFileSnapshots(previous, current);

    expect(changes.map((change) => `${change.type}:${change.path}`)).toEqual([
      "change:alpha.ts",
      "add:beta.ts",
      "add:delta.ts",
      "unlink:gamma.ts",
    ]);
  });
});
