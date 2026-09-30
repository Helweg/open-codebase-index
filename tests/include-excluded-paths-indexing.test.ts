import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { parseConfig, type ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { FileWatcher, type FileWatcherBackend } from "../src/watcher/file-watcher.js";

const WATCH_TIMEOUT_MS = 20_000;
const NODE_MAJOR_VERSION = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const SUPPORTS_NATIVE_RECURSIVE_WATCH = process.platform === "darwin"
  || process.platform === "win32"
  || (NODE_MAJOR_VERSION >= 19 && ["aix", "ibmi", "linux"].includes(process.platform));

interface StructuralConfigOptions {
  additionalInclude?: string[];
  exclude?: string[];
  include?: string[];
  includeExcluded?: string[];
  includeIgnored?: string[];
}

function structuralConfig(options: StructuralConfigOptions = {}): ParsedCodebaseIndexConfig {
  const indexing: Record<string, unknown> = {
    mode: "structural",
    autoGc: true,
    watchFiles: false,
    requireProjectMarker: false,
    maxDepth: -1,
    maxFilesPerDirectory: 1000,
  };
  if (options.includeExcluded !== undefined) {
    indexing.includeExcluded = options.includeExcluded;
  }
  if (options.includeIgnored !== undefined) {
    indexing.includeIgnored = options.includeIgnored;
  }

  const rawConfig: Record<string, unknown> = {
    indexing,
    include: options.include ?? ["**/*.ts"],
    additionalInclude: options.additionalInclude ?? [],
    search: { minScore: 0 },
  };
  if (options.exclude !== undefined) {
    rawConfig.exclude = options.exclude;
  }
  return parseConfig(rawConfig);
}

function writeSource(filePath: string, definitionName: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `export function ${definitionName}() { return "${definitionName}"; }\n`);
}

async function hasDefinition(indexer: Indexer, definitionName: string, filePath: string): Promise<boolean> {
  const results = await indexer.search(definitionName, 20, { definitionIntent: true });
  return results.some((result) => result.name === definitionName && result.filePath === filePath);
}

describe("include-excluded path indexing acceptance", () => {
  let projectDir: string;
  let indexRoot: string;
  let indexers: Indexer[];
  let watchers: FileWatcher[];
  let handlerTails: Promise<void>[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const createIndexer = (
    config: ParsedCodebaseIndexConfig,
    options: { host?: HostMode; indexPath?: string; useHostIndexPath?: boolean } = {},
  ): Indexer => {
    const indexer = new Indexer(
      projectDir,
      config,
      options.host ?? "jcode",
      options.useHostIndexPath ? {} : { indexPath: options.indexPath ?? indexRoot },
    );
    indexers.push(indexer);
    return indexer;
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-include-excluded-project-"));
    indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-include-excluded-index-"));
    indexers = [];
    watchers = [];
    handlerTails = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access is forbidden in this suite"));
  });

  afterEach(async () => {
    try {
      const stopResults = await Promise.allSettled(watchers.map((watcher) => watcher.stop()));
      const handlerResults = await Promise.allSettled(handlerTails);
      const closeResults = await Promise.allSettled(indexers.map((indexer) => indexer.close()));
      const failures = [...stopResults, ...handlerResults, ...closeResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      expect(fetchSpy).not.toHaveBeenCalled();
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to close include-excluded acceptance test resources");
      }
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(indexRoot, { recursive: true, force: true });
    }
  });

  it("keeps automatic exclusions unchanged when includeExcluded is omitted", async () => {
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    const rootBuildHelperPath = path.join(projectDir, "build-helper.ts");
    const excludedSources = [
      [path.join(projectDir, "build-tools", "default.ts"), "defaultBuildDefinition"],
      [path.join(projectDir, "packages", "BUILD-CACHE", "default.ts"), "defaultUppercaseBuildDefinition"],
      [path.join(projectDir, "vendor", "internal", "default.ts"), "defaultVendorDefinition"],
      [path.join(projectDir, ".github", "workflow.ts"), "defaultGithubDefinition"],
      [path.join(projectDir, ".hidden-root.ts"), "defaultHiddenDefinition"],
    ] as const;
    writeSource(ordinaryPath, "ordinaryDefinition");
    writeSource(rootBuildHelperPath, "defaultBuildHelperDefinition");
    for (const [filePath, definitionName] of excludedSources) {
      writeSource(filePath, definitionName);
    }

    const config = structuralConfig();
    expect(config.indexing.includeExcluded).toEqual([]);
    const indexer = createIndexer(config);
    await indexer.index();

    expect(await hasDefinition(indexer, "ordinaryDefinition", ordinaryPath)).toBe(true);
    expect(await hasDefinition(indexer, "defaultBuildHelperDefinition", rootBuildHelperPath)).toBe(true);
    for (const [filePath, definitionName] of excludedSources) {
      expect(await hasDefinition(indexer, definitionName, filePath)).toBe(false);
    }
  });

  it("indexes only opted-in automatically excluded paths selected by normal include rules", async () => {
    const selectedSources = [
      [path.join(projectDir, "build-tools", "source.ts"), "buildToolsDefinition"],
      [path.join(projectDir, "packages", "BUILD-CACHE", "nested.ts"), "uppercaseBuildDefinition"],
      [path.join(projectDir, "build-helper.ts"), "buildHelperDefinition"],
      [path.join(projectDir, "vendor", "internal", "source.ts"), "vendorInternalDefinition"],
      [path.join(projectDir, ".github", "workflow.ts"), "githubDefinition"],
      [path.join(projectDir, ".hidden-root.ts"), "hiddenRootDefinition"],
      [path.join(projectDir, "build-tools", "component.tsx"), "additionalIncludeDefinition"],
    ] as const;
    const unselectedSources = [
      [path.join(projectDir, "other-build", "sibling.ts"), "unselectedBuildSiblingDefinition"],
      [path.join(projectDir, "packages", "BUILD-CACHE", "sibling.ts"), "unselectedUppercaseSiblingDefinition"],
      [path.join(projectDir, "vendor", "public", "sibling.ts"), "unselectedVendorSiblingDefinition"],
      [path.join(projectDir, ".hidden-sibling.ts"), "unselectedHiddenSiblingDefinition"],
    ] as const;
    const includeMissPath = path.join(projectDir, "build-tools", "notes.md");
    for (const [filePath, definitionName] of [...selectedSources, ...unselectedSources]) {
      writeSource(filePath, definitionName);
    }
    writeSource(includeMissPath, "includeMissDefinition");

    const indexer = createIndexer(structuralConfig({
      additionalInclude: ["**/*.tsx"],
      includeExcluded: [
        "build-tools/**",
        "packages/BUILD-CACHE/nested.ts",
        "build-helper.ts",
        "vendor/internal/**",
        ".github/**",
        ".hidden-root.ts",
      ],
    }));
    await indexer.index();

    for (const [filePath, definitionName] of selectedSources) {
      expect(await hasDefinition(indexer, definitionName, filePath)).toBe(true);
    }
    for (const [filePath, definitionName] of unselectedSources) {
      expect(await hasDefinition(indexer, definitionName, filePath)).toBe(false);
    }
    expect(await hasDefinition(indexer, "includeMissDefinition", includeMissPath)).toBe(false);
  });

  it("lets explicit exclusions win over overlapping includeExcluded patterns", async () => {
    const selectedPath = path.join(projectDir, "build-tools", "source.ts");
    const overlappingPath = path.join(projectDir, "build-tools", "excluded", "blocked.ts");
    const identicalAutomaticPatternPath = path.join(projectDir, "vendor", "internal", "blocked.ts");
    writeSource(selectedPath, "selectedBuildDefinition");
    writeSource(overlappingPath, "overlappingExcludedDefinition");
    writeSource(identicalAutomaticPatternPath, "identicalAutomaticPatternDefinition");

    const indexer = createIndexer(structuralConfig({
      exclude: ["build-tools/excluded/**", "**/vendor/**"],
      includeExcluded: ["build-tools/**", "**/vendor/**"],
    }));
    await indexer.index();

    expect(await hasDefinition(indexer, "selectedBuildDefinition", selectedPath)).toBe(true);
    expect(await hasDefinition(indexer, "overlappingExcludedDefinition", overlappingPath)).toBe(false);
    expect(await hasDefinition(indexer, "identicalAutomaticPatternDefinition", identicalAutomaticPatternPath)).toBe(false);
  });

  it("does not let legacy includeIgnored bypass automatic exclusions", async () => {
    const ignoredBuildPath = path.join(projectDir, "build-tools", "ignored.ts");
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "build-tools/\n");
    writeSource(ignoredBuildPath, "legacyIncludeIgnoredDefinition");

    const indexer = createIndexer(structuralConfig({ includeIgnored: ["build-tools/**"] }));
    await indexer.index();

    expect(await hasDefinition(indexer, "legacyIncludeIgnoredDefinition", ignoredBuildPath)).toBe(false);
  });

  it("requires both Git and automatic exclusion opt-ins for paths excluded by both", async () => {
    const selectedPath = path.join(projectDir, "build-tools", "selected.ts");
    const gitUnselectedPath = path.join(projectDir, "other-build", "unselected.ts");
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "build-tools/\nother-build/\n");
    writeSource(selectedPath, "dualOptInDefinition");
    writeSource(gitUnselectedPath, "gitUnselectedDefinition");

    const indexer = createIndexer(structuralConfig({
      includeExcluded: ["build-tools/**", "other-build/**"],
      includeIgnored: ["build-tools/**"],
    }));
    await indexer.index();

    expect(await hasDefinition(indexer, "dualOptInDefinition", selectedPath)).toBe(true);
    expect(await hasDefinition(indexer, "gitUnselectedDefinition", gitUnselectedPath)).toBe(false);
  });

  it.each([
    { host: "jcode" as const, storagePath: path.join(".codebase-index", "index") },
    { host: "opencode" as const, storagePath: path.join(".opencode", "index") },
    { host: "claude" as const, storagePath: path.join(".claude", "index") },
  ])("protects Git metadata and $storagePath for the $host host under a broad opt-in", async ({ host, storagePath }) => {
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    const gitMetadataPath = path.join(projectDir, ".git", "metadata.ts");
    const indexStoragePath = path.join(projectDir, storagePath, "protected.ts");
    writeSource(ordinaryPath, `${host}OrdinaryDefinition`);
    writeSource(gitMetadataPath, `${host}GitMetadataDefinition`);
    writeSource(indexStoragePath, `${host}IndexStorageDefinition`);

    const indexer = createIndexer(
      structuralConfig({ includeExcluded: ["**"] }),
      { host, useHostIndexPath: true },
    );
    await indexer.index();

    expect(await hasDefinition(indexer, `${host}OrdinaryDefinition`, ordinaryPath)).toBe(true);
    expect(await hasDefinition(indexer, `${host}GitMetadataDefinition`, gitMetadataPath)).toBe(false);
    expect(await hasDefinition(indexer, `${host}IndexStorageDefinition`, indexStoragePath)).toBe(false);
  });

  it("protects a runtime index storage override inside the project under a broad opt-in", async () => {
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    const runtimeIndexPath = path.join(projectDir, "custom-index-storage");
    const indexStoragePath = path.join(runtimeIndexPath, "protected.ts");
    writeSource(ordinaryPath, "runtimeOverrideOrdinaryDefinition");
    writeSource(indexStoragePath, "runtimeOverrideStorageDefinition");

    const indexer = createIndexer(
      structuralConfig({ includeExcluded: ["**"] }),
      { indexPath: runtimeIndexPath },
    );
    await indexer.index();

    expect(await hasDefinition(indexer, "runtimeOverrideOrdinaryDefinition", ordinaryPath)).toBe(true);
    expect(await hasDefinition(indexer, "runtimeOverrideStorageDefinition", indexStoragePath)).toBe(false);
  });

  async function exerciseWatcherBackend(backend: Exclude<FileWatcherBackend, "auto">): Promise<void> {
    const config = structuralConfig({
      exclude: ["build-tools/excluded/**"],
      includeExcluded: [
        "build-tools/**",
        "build-helper.ts",
        "vendor/internal/**",
        ".hidden-root.ts",
        "packages/BUILD-CACHE/added.ts",
      ],
    });
    const selectedSources = [
      {
        filePath: path.join(projectDir, "build-tools", "watched.ts"),
        originalDefinition: `${backend}OriginalBuildDefinition`,
        updatedDefinition: `${backend}UpdatedBuildDefinition`,
      },
      {
        filePath: path.join(projectDir, "build-helper.ts"),
        originalDefinition: `${backend}OriginalBuildHelperDefinition`,
        updatedDefinition: `${backend}UpdatedBuildHelperDefinition`,
      },
      {
        filePath: path.join(projectDir, "vendor", "internal", "watched.ts"),
        originalDefinition: `${backend}OriginalVendorDefinition`,
        updatedDefinition: `${backend}UpdatedVendorDefinition`,
      },
      {
        filePath: path.join(projectDir, ".hidden-root.ts"),
        originalDefinition: `${backend}OriginalHiddenDefinition`,
        updatedDefinition: `${backend}UpdatedHiddenDefinition`,
      },
    ];
    const negativeSources = [
      [path.join(projectDir, "vendor", "public", "sibling.ts"), `${backend}VendorSiblingDefinition`],
      [path.join(projectDir, "packages", "BUILD-CACHE", "sibling.ts"), `${backend}UppercaseSiblingDefinition`],
      [path.join(projectDir, ".hidden-sibling.ts"), `${backend}HiddenSiblingDefinition`],
      [path.join(projectDir, "build-tools", "excluded", "blocked.ts"), `${backend}ExplicitlyExcludedDefinition`],
      [path.join(projectDir, "build-tools", "git-ignored.ts"), `${backend}GitIgnoredDefinition`],
    ] as const;
    const addedPath = path.join(projectDir, "packages", "BUILD-CACHE", "added.ts");
    const addedDefinition = `${backend}AddedDefinition`;
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "build-tools/git-ignored.ts\n");
    for (const source of selectedSources) {
      writeSource(source.filePath, source.originalDefinition);
    }
    for (const [filePath, definitionName] of negativeSources) {
      writeSource(filePath, definitionName);
    }

    const indexer = createIndexer(config);
    await indexer.index();
    for (const source of selectedSources) {
      expect(await hasDefinition(indexer, source.originalDefinition, source.filePath)).toBe(true);
    }
    for (const [filePath, definitionName] of negativeSources) {
      expect(await hasDefinition(indexer, definitionName, filePath)).toBe(false);
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher(projectDir, config, "jcode", { backend });
    watchers.push(watcher);
    const observedPaths: string[] = [];
    let handlerTail = Promise.resolve();
    watcher.start(async (changes) => {
      observedPaths.push(...changes.map((change) => change.path));
      handlerTail = handlerTail.then(async () => {
        await indexer.index();
      });
      handlerTails.push(handlerTail);
      await handlerTail;
    });
    await watcher.waitUntilReady();

    for (const source of selectedSources) {
      writeSource(source.filePath, source.updatedDefinition);
    }
    for (const [filePath, definitionName] of negativeSources) {
      writeSource(filePath, `${definitionName}Updated`);
    }
    await vi.waitFor(async () => {
      for (const source of selectedSources) {
        expect(await hasDefinition(indexer, source.updatedDefinition, source.filePath)).toBe(true);
        expect(await hasDefinition(indexer, source.originalDefinition, source.filePath)).toBe(false);
      }
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    writeSource(addedPath, addedDefinition);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, addedDefinition, addedPath)).toBe(true);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    fs.rmSync(addedPath);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, addedDefinition, addedPath)).toBe(false);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    await vi.waitFor(() => {
      expect(observedPaths).toEqual(expect.arrayContaining([
        ...selectedSources.map((source) => source.filePath),
        addedPath,
      ]));
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    for (const [filePath, definitionName] of negativeSources) {
      expect(observedPaths).not.toContain(filePath);
      expect(await hasDefinition(indexer, `${definitionName}Updated`, filePath)).toBe(false);
    }
    if (backend === "native") {
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("Chokidar fallback"))).toBe(false);
    }
  }

  async function exerciseDefaultRootBuildWatcherRejection(
    backend: Exclude<FileWatcherBackend, "auto">,
  ): Promise<void> {
    const config = structuralConfig();
    const rootBuildHelperPath = path.join(projectDir, "build-helper.ts");
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    const originalBuildDefinition = `${backend}DefaultOriginalBuildHelperDefinition`;
    const updatedBuildDefinition = `${backend}DefaultUpdatedBuildHelperDefinition`;
    const originalOrdinaryDefinition = `${backend}DefaultOriginalOrdinaryDefinition`;
    const updatedOrdinaryDefinition = `${backend}DefaultUpdatedOrdinaryDefinition`;
    writeSource(rootBuildHelperPath, originalBuildDefinition);
    writeSource(ordinaryPath, originalOrdinaryDefinition);

    const indexer = createIndexer(config);
    await indexer.index();
    expect(await hasDefinition(indexer, originalBuildDefinition, rootBuildHelperPath)).toBe(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher(projectDir, config, "jcode", { backend });
    watchers.push(watcher);
    const observedPaths: string[] = [];
    let handlerTail = Promise.resolve();
    watcher.start(async (changes) => {
      observedPaths.push(...changes.map((change) => change.path));
      handlerTail = handlerTail.then(async () => {
        await indexer.index();
      });
      handlerTails.push(handlerTail);
      await handlerTail;
    });
    await watcher.waitUntilReady();

    writeSource(rootBuildHelperPath, updatedBuildDefinition);
    writeSource(ordinaryPath, updatedOrdinaryDefinition);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, updatedOrdinaryDefinition, ordinaryPath)).toBe(true);
      expect(observedPaths).toContain(ordinaryPath);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    expect(observedPaths).not.toContain(rootBuildHelperPath);
    expect(await hasDefinition(indexer, updatedBuildDefinition, rootBuildHelperPath)).toBe(true);
    if (backend === "native") {
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("Chokidar fallback"))).toBe(false);
    }
  }

  it("preserves the default Chokidar rejection of root build-named file changes", async () => {
    await exerciseDefaultRootBuildWatcherRejection("chokidar");
  });

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "preserves the default native watcher rejection of root build-named file changes",
    async () => {
      await exerciseDefaultRootBuildWatcherRejection("native");
    },
  );

  it("propagates opted-in excluded-path changes through the Chokidar FileWatcher", async () => {
    await exerciseWatcherBackend("chokidar");
  });

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "propagates opted-in excluded-path changes through the native FileWatcher without fallback",
    async () => {
      await exerciseWatcherBackend("native");
    },
  );
});
