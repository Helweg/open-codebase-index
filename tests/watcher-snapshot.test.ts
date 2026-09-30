import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createDefaultExcludePatterns } from "../src/config/exclusions.js";
import { buildFileSnapshot, buildFileSnapshotForPath } from "../src/watcher/snapshot.js";
import {
  LocalModuleConfigTracker,
  shouldTrackLocalModuleConfigPath,
  shouldTrackLocalModulePackagePath,
} from "../src/watcher/local-module-config.js";

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

  it("tracks nested TypeScript and JavaScript configs while honoring ignored paths", async () => {
    const tsConfig = path.join(projectRoot, "packages", "app", "tsconfig.json");
    const jsConfig = path.join(projectRoot, "packages", "web", "jsconfig.json");
    const ignoredConfig = path.join(projectRoot, "generated", "tsconfig.json");
    fs.mkdirSync(path.dirname(tsConfig), { recursive: true });
    fs.mkdirSync(path.dirname(jsConfig), { recursive: true });
    fs.mkdirSync(path.dirname(ignoredConfig), { recursive: true });
    fs.writeFileSync(tsConfig, "{}");
    fs.writeFileSync(jsConfig, "{}");
    fs.writeFileSync(ignoredConfig, "{}");
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "generated/\n");

    const snapshot = await buildFileSnapshot(
      projectRoot,
      { include: ["**/*.ts"], additionalInclude: [], exclude: [] },
      [],
    );

    expect(snapshot.has(tsConfig)).toBe(true);
    expect(snapshot.has(jsConfig)).toBe(true);
    expect(snapshot.has(ignoredConfig)).toBe(false);
  });

  it("tracks existing and missing local extends targets with arbitrary JSON names", () => {
    const appConfig = path.join(projectRoot, "packages", "app", "tsconfig.json");
    const baseConfig = path.join(projectRoot, "packages", "config", "base.json");
    const missingConfig = path.join(projectRoot, "packages", "config", "missing.json");
    fs.mkdirSync(path.dirname(appConfig), { recursive: true });
    fs.mkdirSync(path.dirname(baseConfig), { recursive: true });
    fs.writeFileSync(appConfig, JSON.stringify({ extends: "../config/base" }));
    fs.writeFileSync(baseConfig, JSON.stringify({ extends: "./missing" }));

    const tracker = new LocalModuleConfigTracker(projectRoot, {});
    tracker.refresh();

    expect(tracker.has(appConfig)).toBe(true);
    expect(tracker.has(baseConfig)).toBe(true);
    expect(tracker.has(missingConfig)).toBe(true);
  });

  it("does not track a local extends target hidden by gitignore", () => {
    const appConfig = path.join(projectRoot, "packages", "app", "tsconfig.json");
    const ignoredConfig = path.join(projectRoot, "generated", "base.json");
    fs.mkdirSync(path.dirname(appConfig), { recursive: true });
    fs.mkdirSync(path.dirname(ignoredConfig), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "generated/\n");
    fs.writeFileSync(appConfig, JSON.stringify({ extends: "../../generated/base" }));
    fs.writeFileSync(ignoredConfig, "{}");

    const tracker = new LocalModuleConfigTracker(projectRoot, {});
    tracker.refresh();

    expect(tracker.has(appConfig)).toBe(true);
    expect(tracker.has(ignoredConfig)).toBe(false);
  });

  it("tracks only workspace manifests selected by included source ancestors", () => {
    const rootManifest = path.join(projectRoot, "package.json");
    const packageManifest = path.join(projectRoot, "packages", "shared", "package.json");
    const excludedManifest = path.join(projectRoot, "packages", "private", "package.json");
    const unrelatedManifest = path.join(projectRoot, "tools", "unrelated", "package.json");
    for (const manifestPath of [packageManifest, excludedManifest, unrelatedManifest]) {
      fs.mkdirSync(path.join(path.dirname(manifestPath), "src"), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(manifestPath), "src", "index.ts"), "export const value = 1;");
      fs.writeFileSync(manifestPath, JSON.stringify({ name: path.basename(path.dirname(manifestPath)) }));
    }
    fs.writeFileSync(rootManifest, JSON.stringify({
      workspaces: ["packages/*", "!packages/private"],
    }));

    const tracker = new LocalModuleConfigTracker(projectRoot, {
      include: ["**/*.ts"],
      additionalInclude: [],
      exclude: [],
    });
    tracker.refresh();

    expect(tracker.has(rootManifest)).toBe(true);
    expect(tracker.has(packageManifest)).toBe(true);
    expect(tracker.has(excludedManifest)).toBe(false);
    expect(tracker.has(unrelatedManifest)).toBe(false);
  });

  it("tracks configs and workspace manifests under selected build source paths", () => {
    const rootManifest = path.join(projectRoot, "package.json");
    const packageRoot = path.join(projectRoot, "packages", "app-build");
    const packageManifest = path.join(packageRoot, "package.json");
    const appConfig = path.join(packageRoot, "tsconfig.json");
    const baseConfig = path.join(packageRoot, "config", "base.json");
    const sourceFile = path.join(packageRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(baseConfig), { recursive: true });
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(rootManifest, JSON.stringify({ workspaces: ["packages/*"] }));
    fs.writeFileSync(packageManifest, JSON.stringify({ name: "app-build" }));
    fs.writeFileSync(appConfig, JSON.stringify({ extends: "./config/base" }));
    fs.writeFileSync(baseConfig, "{}");
    fs.writeFileSync(sourceFile, "export const value = 1;");

    const options = {
      exclude: createDefaultExcludePatterns(),
      indexing: { includeExcluded: ["packages/app-build/**"] },
    };
    expect(shouldTrackLocalModuleConfigPath(appConfig, projectRoot, undefined, options)).toBe(true);
    expect(shouldTrackLocalModulePackagePath(packageManifest, projectRoot, undefined, options)).toBe(true);

    const tracker = new LocalModuleConfigTracker(projectRoot, {
      include: ["**/*.ts"],
      ...options,
    });
    tracker.refresh();

    expect(tracker.has(packageManifest)).toBe(true);
    expect(tracker.has(appConfig)).toBe(true);
    expect(tracker.has(baseConfig)).toBe(true);
  });

  it("keeps the local config helper default argument filtered", () => {
    const buildConfig = path.join(projectRoot, "app-build", "tsconfig.json");
    fs.mkdirSync(path.dirname(buildConfig), { recursive: true });
    fs.writeFileSync(buildConfig, "{}");

    expect(shouldTrackLocalModuleConfigPath(buildConfig, projectRoot, undefined)).toBe(false);
  });

  it.each([".hidden-app", "vendor/app"])("tracks local configs under a selected %s ancestor", (relativeRoot) => {
    const configPath = path.join(projectRoot, relativeRoot, "tsconfig.json");
    const sourcePath = path.join(projectRoot, relativeRoot, "src", "index.ts");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(configPath, "{}");
    fs.writeFileSync(sourcePath, "export const value = 1;");
    const options = {
      include: ["**/*.ts"],
      exclude: createDefaultExcludePatterns(),
      indexing: { includeExcluded: [`${relativeRoot}/**`] },
    };

    expect(shouldTrackLocalModuleConfigPath(configPath, projectRoot, undefined, options)).toBe(true);
    const tracker = new LocalModuleConfigTracker(projectRoot, options);
    tracker.refresh();
    expect(tracker.has(configPath)).toBe(true);
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

  it("applies includeIgnored identically to full and path snapshots", async () => {
    const selected = path.join(projectRoot, "generated", "nested", "selected.ts");
    const wrongExtension = path.join(projectRoot, "generated", "nested", "selected.js");
    const excluded = path.join(projectRoot, "generated", "nested", "excluded.ts");
    const unrelated = path.join(projectRoot, "other-generated", "unrelated.ts");
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "generated/\nother-generated/\n");
    for (const filePath of [selected, wrongExtension, excluded, unrelated]) fs.writeFileSync(filePath, "source");

    const config = {
      include: ["**/*.ts"],
      additionalInclude: [],
      exclude: ["**/excluded.ts"],
      indexing: { includeIgnored: ["generated/nested/**"] },
    };
    const full = await buildFileSnapshot(projectRoot, config, []);
    const partial = await buildFileSnapshotForPath(projectRoot, config, [], path.join(projectRoot, "generated"));

    expect(Array.from(full.keys())).toEqual([selected]);
    expect(Array.from(partial.keys())).toEqual([selected]);
  });

  it("applies narrow automatic-exclusion opt-ins identically to full and scoped snapshots", async () => {
    const buildRoot = path.join(projectRoot, "BUILD-source");
    const siblingBuildRoot = path.join(projectRoot, "BUILD-sibling");
    const sourceFile = path.join(buildRoot, "nested", "index.ts");
    const additionalFile = path.join(buildRoot, "nested", "schema.custom");
    const excludedFile = path.join(buildRoot, "excluded", "skip.ts");
    const siblingFile = path.join(siblingBuildRoot, "nested", "index.ts");
    const hiddenFile = path.join(projectRoot, ".hidden-build", "index.ts");
    const dependencyFile = path.join(projectRoot, "node_modules", "build-package", "index.ts");
    for (const filePath of [sourceFile, additionalFile, excludedFile, siblingFile, hiddenFile, dependencyFile]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "source");
    }

    const config = {
      include: ["**/*.ts"],
      additionalInclude: ["**/*.custom"],
      exclude: ["**/BUILD-source/excluded/**"],
      indexing: { includeExcluded: ["BUILD-source/**"] },
    };
    const full = await buildFileSnapshot(projectRoot, config, []);
    const partial = await buildFileSnapshotForPath(projectRoot, config, [], buildRoot);

    expect(Array.from(full.keys()).sort()).toEqual([sourceFile, additionalFile].sort());
    expect(Array.from(partial.keys()).sort()).toEqual([sourceFile, additionalFile].sort());

    const defaultSnapshot = await buildFileSnapshot(projectRoot, { ...config, indexing: { includeExcluded: [] } }, []);
    expect(defaultSnapshot.size).toBe(0);
  });

  it("does not let scoped scans bypass denied ancestors, explicit excludes, or maxDepth", async () => {
    const deniedRoot = path.join(projectRoot, "vendor", "selected");
    const deniedFile = path.join(deniedRoot, "nested", "index.ts");
    fs.mkdirSync(path.dirname(deniedFile), { recursive: true });
    fs.writeFileSync(deniedFile, "source");

    const explicitlyDenied = {
      include: ["**/*.ts"],
      additionalInclude: [],
      exclude: ["vendor/**"],
      indexing: { includeExcluded: ["vendor/selected/**"] },
    };
    expect((await buildFileSnapshot(projectRoot, explicitlyDenied, [])).size).toBe(0);
    expect((await buildFileSnapshotForPath(projectRoot, explicitlyDenied, [], deniedRoot)).size).toBe(0);

    const depthLimited = {
      ...explicitlyDenied,
      exclude: createDefaultExcludePatterns(),
      indexing: { includeExcluded: ["vendor/selected/**"], maxDepth: 1 },
    };
    expect((await buildFileSnapshot(projectRoot, depthLimited, [])).size).toBe(0);
    expect((await buildFileSnapshotForPath(projectRoot, depthLimited, [], deniedRoot)).size).toBe(0);
  });

  it("protects storage paths from full and scoped snapshots despite opt-in", async () => {
    const protectedRoot = path.join(projectRoot, "custom-index");
    const protectedFile = path.join(protectedRoot, "nested", "index.ts");
    const siblingFile = path.join(projectRoot, "src", "index.ts");
    for (const filePath of [protectedFile, siblingFile]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "source");
    }
    const config = {
      include: ["**/*.ts"],
      additionalInclude: [],
      exclude: createDefaultExcludePatterns(),
      indexing: { includeExcluded: ["custom-index/**"] },
      protectedPaths: [protectedRoot],
    };

    expect(Array.from((await buildFileSnapshot(projectRoot, config, [])).keys())).toEqual([siblingFile]);
    expect((await buildFileSnapshotForPath(projectRoot, config, [], protectedRoot)).size).toBe(0);
  });
});
