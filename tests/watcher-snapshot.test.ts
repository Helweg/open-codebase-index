import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseConfig } from "../src/config/schema.js";
import { buildFileSnapshot, completeFileSnapshot, diffFileSnapshots } from "../src/watcher/snapshot.js";
import type { FileSnapshotMap } from "../src/watcher/snapshot.js";

describe("watcher snapshot builder", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("includes only indexable in-project files and skips ignored/restricted paths", async () => {
    const includeRoot = path.join(projectRoot, "src");
    fs.mkdirSync(includeRoot, { recursive: true });
    fs.writeFileSync(path.join(includeRoot, "index.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(includeRoot, "index.test.ts"), "export const y = 2;");
    fs.writeFileSync(path.join(projectRoot, "README.md"), "# README");

    const nodeModulesDir = path.join(projectRoot, "node_modules");
    fs.mkdirSync(path.join(nodeModulesDir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, "pkg", "ignored.ts"), "export const ignored = true;");

    const hiddenDir = path.join(projectRoot, ".hidden");
    fs.mkdirSync(path.join(hiddenDir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, "nested", "ignored.ts"), "export const hidden = true;");

    const restrictedDir = path.join(projectRoot, "Library");
    fs.mkdirSync(path.join(restrictedDir, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(restrictedDir, "runtime", "ignored.ts"), "export const restricted = true;");

    const scan = await buildFileSnapshot(
      projectRoot,
      parseConfig({
        include: ["**/*.{ts,md}"],
        additionalInclude: [],
        exclude: ["**/*.test.ts"],
      }),
      [],
    );
    const snapshot = scan.entries;

    const expectedPaths = new Set([
      path.join(includeRoot, "index.ts"),
      path.join(projectRoot, "README.md"),
    ]);

    for (const entryPath of Array.from(snapshot.keys())) {
      expect(path.isAbsolute(entryPath)).toBe(true);
    }

    expect(Array.from(snapshot.keys()).sort()).toEqual(Array.from(expectedPaths).sort());
    expect(snapshot.has(path.join(includeRoot, "index.test.ts"))).toBe(false);
    expect(snapshot.has(path.join(nodeModulesDir, "pkg", "ignored.ts"))).toBe(false);
    expect(snapshot.has(path.join(hiddenDir, "nested", "ignored.ts"))).toBe(false);
    expect(snapshot.has(path.join(restrictedDir, "runtime", "ignored.ts"))).toBe(false);
  });

  it("includes explicit hidden and external config files outside the project", async () => {
    const insideHiddenConfig = path.join(projectRoot, ".config", "watcher.config");
    fs.mkdirSync(path.join(projectRoot, ".config"), { recursive: true });
    fs.writeFileSync(insideHiddenConfig, "{}");

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-config-"));
    const outsideConfig = path.join(outsideRoot, ".external-config");
    fs.writeFileSync(outsideConfig, "{}");

    const trackedFile = path.join(projectRoot, "index.ts");
    fs.writeFileSync(trackedFile, "export const x = 1;");

    try {
      const scan = await buildFileSnapshot(
        projectRoot,
        parseConfig({
          include: ["**/*.ts"],
          additionalInclude: [],
          exclude: ["**/*.test.ts"],
        }),
        [insideHiddenConfig, outsideConfig],
      );
      const snapshot = scan.entries;

      expect(snapshot.has(path.join(projectRoot, "index.ts"))).toBe(true);
      expect(snapshot.has(insideHiddenConfig)).toBe(true);
      expect(snapshot.has(outsideConfig)).toBe(true);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("honors indexing.maxDepth during recursion", async () => {
    const rootTs = path.join(projectRoot, "root.ts");
    const nestedA = path.join(projectRoot, "a", "a.ts");
    const nestedB = path.join(projectRoot, "a", "b", "b.ts");

    fs.mkdirSync(path.join(projectRoot, "a", "b"), { recursive: true });
    fs.writeFileSync(rootTs, "export const root = 0;");
    fs.writeFileSync(nestedA, "export const a = 1;");
    fs.writeFileSync(nestedB, "export const b = 2;");

    const cases: Array<{ maxDepth: number; expected: string[] }> = [
      { maxDepth: -1, expected: [rootTs, nestedA, nestedB] },
      { maxDepth: 0, expected: [rootTs] },
      { maxDepth: 1, expected: [rootTs, nestedA] },
    ];

    for (const { maxDepth, expected } of cases) {
      const scan = await buildFileSnapshot(
        projectRoot,
        parseConfig({ include: ["**/*.ts"], indexing: { maxDepth } }),
        [],
      );

      expect(Array.from(scan.entries.keys()).sort()).toEqual([...expected].sort());
    }
  });

  it("flips tracked-file eligibility when .gitignore rules change", async () => {
    const trackedFile = path.join(projectRoot, "src", "tracked.ts");
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(trackedFile, "export const tracked = 1;");

    const config = parseConfig({ include: ["**/*.ts"] });
    const snapshotPaths = async (): Promise<string[]> =>
      Array.from((await buildFileSnapshot(projectRoot, config, [])).entries.keys());

    expect(await snapshotPaths()).toContain(trackedFile);

    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "src/tracked.ts\n");
    expect(await snapshotPaths()).not.toContain(trackedFile);

    fs.rmSync(path.join(projectRoot, ".gitignore"));
    expect(await snapshotPaths()).toContain(trackedFile);
  });

  it("records unreadable prefixes on EACCES and ignores ENOENT/ENOTDIR silently", async () => {
    const rootFile = path.join(projectRoot, "root.ts");
    const readableFile = path.join(projectRoot, "ok", "ok.ts");
    const blockedDirectory = path.join(projectRoot, "blocked");
    const blockedFile = path.join(blockedDirectory, "blocked.ts");
    const missingDirectory = path.join(projectRoot, "gone");
    const notDirectory = path.join(projectRoot, "notdir");
    const rootBlockedFile = path.join(projectRoot, "root-blocked.ts");
    const rootMissingFile = path.join(projectRoot, "root-gone.ts");
    const rootNotDirFile = path.join(projectRoot, "root-notdir.ts");

    fs.mkdirSync(path.join(projectRoot, "ok"), { recursive: true });
    fs.mkdirSync(blockedDirectory, { recursive: true });
    fs.mkdirSync(missingDirectory, { recursive: true });
    fs.mkdirSync(notDirectory, { recursive: true });
    fs.writeFileSync(rootFile, "export const root = 0;");
    fs.writeFileSync(readableFile, "export const ok = 1;");
    fs.writeFileSync(blockedFile, "export const blocked = 2;");
    fs.writeFileSync(rootBlockedFile, "export const rootBlocked = 3;");
    fs.writeFileSync(rootMissingFile, "export const rootGone = 4;");
    fs.writeFileSync(rootNotDirFile, "export const rootNotDir = 5;");

    const createFsError = (code: string, target: string): NodeJS.ErrnoException =>
      Object.assign(new Error(`${code}: ${target}`), { code });

    const originalReaddir = fsPromises.readdir;
    vi.spyOn(fsPromises, "readdir").mockImplementation(
      ((directoryPath: fs.PathLike, options?: fs.ReaddirOptions | null) => {
        const resolved = path.resolve(String(directoryPath));
        if (resolved === blockedDirectory) {
          return Promise.reject(createFsError("EACCES", resolved));
        }
        if (resolved === missingDirectory) {
          return Promise.reject(createFsError("ENOENT", resolved));
        }
        if (resolved === notDirectory) {
          return Promise.reject(createFsError("ENOTDIR", resolved));
        }
        return originalReaddir(directoryPath, options);
      }) as unknown as typeof fsPromises.readdir,
    );

    const originalStat = fsPromises.stat;
    vi.spyOn(fsPromises, "stat").mockImplementation(
      ((filePath: fs.PathLike, options?: fs.StatOptions | null) => {
        const resolved = path.resolve(String(filePath));
        if (resolved === rootBlockedFile) {
          return Promise.reject(createFsError("EACCES", resolved));
        }
        if (resolved === rootMissingFile) {
          return Promise.reject(createFsError("ENOENT", resolved));
        }
        if (resolved === rootNotDirFile) {
          return Promise.reject(createFsError("ENOTDIR", resolved));
        }
        return originalStat(filePath, options);
      }) as unknown as typeof fsPromises.stat,
    );

    const scan = await buildFileSnapshot(
      projectRoot,
      parseConfig({ include: ["**/*.ts"] }),
      [],
    );

    expect(Array.from(scan.entries.keys()).sort()).toEqual([rootFile, readableFile].sort());
    expect(scan.entries.has(blockedFile)).toBe(false);
    expect(scan.entries.has(rootBlockedFile)).toBe(false);

    expect(scan.unreadablePrefixes).toEqual(new Set([blockedDirectory, rootBlockedFile]));
    expect(scan.unreadablePrefixes.has(missingDirectory)).toBe(false);
    expect(scan.unreadablePrefixes.has(notDirectory)).toBe(false);
    expect(scan.unreadablePrefixes.has(rootMissingFile)).toBe(false);
    expect(scan.unreadablePrefixes.has(rootNotDirFile)).toBe(false);

    const previous: FileSnapshotMap = new Map(scan.entries);
    previous.set(blockedFile, { size: 2, mtimeMs: 5 });
    const completed = completeFileSnapshot(previous, scan);
    expect(completed.get(blockedFile)).toEqual({ size: 2, mtimeMs: 5 });
    expect(diffFileSnapshots(previous, completed)).toEqual([]);
  });
});
