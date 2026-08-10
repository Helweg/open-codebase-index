import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFileSnapshot } from "../src/watcher/snapshot.js";

describe("watcher snapshot builder", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-snapshot-"));
  });

  afterEach(() => {
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

    const snapshot = await buildFileSnapshot(
      projectRoot,
      {
        include: ["**/*.{ts,md}"],
        additionalInclude: [],
        exclude: ["**/*.test.ts"],
      },
      [],
    );

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
      const snapshot = await buildFileSnapshot(
        projectRoot,
        {
          include: ["**/*.ts"],
          additionalInclude: [],
          exclude: ["**/*.test.ts"],
        },
        [insideHiddenConfig, outsideConfig],
      );

      expect(snapshot.has(path.join(projectRoot, "index.ts"))).toBe(true);
      expect(snapshot.has(insideHiddenConfig)).toBe(true);
      expect(snapshot.has(outsideConfig)).toBe(true);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("limits traversal depth using config.indexing.maxDepth", async () => {
    const rootFile = path.join(projectRoot, "root.ts");
    const nestedLevelOne = path.join(projectRoot, "level-one", "nested.ts");
    const nestedLevelTwo = path.join(projectRoot, "level-one", "level-two", "deeper.ts");

    fs.mkdirSync(path.dirname(nestedLevelOne), { recursive: true });
    fs.mkdirSync(path.dirname(nestedLevelTwo), { recursive: true });
    fs.writeFileSync(rootFile, "export const root = 1;");
    fs.writeFileSync(nestedLevelOne, "export const one = 1;");
    fs.writeFileSync(nestedLevelTwo, "export const two = 1;");

    const limitedDepth = await buildFileSnapshot(
      projectRoot,
      {
        include: ["**/*.ts"],
        additionalInclude: [],
        exclude: [],
        indexing: {
          maxDepth: 1,
        },
      },
      [],
    );

    expect(Array.from(limitedDepth.keys()).sort()).toEqual([rootFile, nestedLevelOne].sort());
  });

  it("preserves unlimited traversal when indexing.maxDepth is absent", async () => {
    const rootFile = path.join(projectRoot, "root.ts");
    const nestedLevelOne = path.join(projectRoot, "level-one", "nested.ts");
    const nestedLevelTwo = path.join(projectRoot, "level-one", "level-two", "deeper.ts");

    fs.mkdirSync(path.dirname(nestedLevelOne), { recursive: true });
    fs.mkdirSync(path.dirname(nestedLevelTwo), { recursive: true });
    fs.writeFileSync(rootFile, "export const root = 1;");
    fs.writeFileSync(nestedLevelOne, "export const one = 1;");
    fs.writeFileSync(nestedLevelTwo, "export const two = 1;");

    const unlimitedDepth = await buildFileSnapshot(
      projectRoot,
      {
        include: ["**/*.ts"],
        additionalInclude: [],
        exclude: [],
      },
      [],
    );

    expect(Array.from(unlimitedDepth.keys()).sort()).toEqual([rootFile, nestedLevelOne, nestedLevelTwo].sort());
  });
});
