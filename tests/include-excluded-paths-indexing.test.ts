import type * as FsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import { parseConfig, type ParsedCodebaseIndexConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { FileWatcher, type FileChange, type FileWatcherBackend, type FileWatcherOptions } from "../src/watcher/file-watcher.js";

// Controlled filesystem boundaries only; successful reads always use the real filesystem.
const snapshotFaults = vi.hoisted(() => ({
  beforeRead: undefined as ((directory: string) => Promise<void>) | undefined,
  afterStat: undefined as ((filePath: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof FsPromises>("node:fs/promises");
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await snapshotFaults.beforeRead?.(String(args[0]));
      return actual.readdir(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      await snapshotFaults.afterStat?.(String(args[0]));
      return result;
    },
  };
});

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
  maxDepth?: number;
}

function structuralConfig(options: StructuralConfigOptions = {}): ParsedCodebaseIndexConfig {
  const indexing: Record<string, unknown> = {
    mode: "structural",
    autoGc: true,
    watchFiles: false,
    requireProjectMarker: false,
    maxDepth: options.maxDepth ?? -1,
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
      snapshotFaults.beforeRead = undefined;
      snapshotFaults.afterStat = undefined;
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

  it("indexes partial-wildcard parents without broadening final file selection", async () => {
    const selectedSources = [
      [path.join(projectDir, "build-tools", "src", "selected.ts"), "partialBuildDefinition"],
      [path.join(projectDir, ".github", "scripts", "selected.ts"), "partialGithubDefinition"],
      [
        path.join(projectDir, "packages", "release", "build-x", "src", "selected.ts"),
        "partialNestedDefinition",
      ],
      [path.join(projectDir, "vendor", "exact.ts"), "partialExactDefinition"],
    ] as const;
    const unselectedSources = [
      [path.join(projectDir, "build-tools", "lib", "sibling.ts"), "partialBuildSiblingDefinition"],
      [path.join(projectDir, "build-tools", "src", "blocked.ts"), "partialExplicitExcludeDefinition"],
      [path.join(projectDir, ".github", "workflows", "sibling.ts"), "partialGithubSiblingDefinition"],
      [path.join(projectDir, ".git", "scripts", "protected.ts"), "partialGitProtectedDefinition"],
      [
        path.join(projectDir, "packages", "release", "build-long", "src", "sibling.ts"),
        "partialQuestionSiblingDefinition",
      ],
      [path.join(projectDir, "vendor", "sibling.ts"), "partialExactSiblingDefinition"],
    ] as const;
    for (const [filePath, definitionName] of [...selectedSources, ...unselectedSources]) {
      writeSource(filePath, definitionName);
    }

    const indexer = createIndexer(structuralConfig({
      exclude: ["build-*/src/blocked.ts"],
      includeExcluded: [
        "build-*/src/*.ts",
        ".g*/scripts/*.ts",
        "packages/release/build-?/src/*.ts",
        "vendor/exact.ts",
      ],
    }));
    await indexer.index();

    for (const [filePath, definitionName] of selectedSources) {
      expect(await hasDefinition(indexer, definitionName, filePath)).toBe(true);
    }
    for (const [filePath, definitionName] of unselectedSources) {
      expect(await hasDefinition(indexer, definitionName, filePath)).toBe(false);
    }
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
      exclude: ["build-*/src/blocked.ts"],
      includeExcluded: [
        "build-*/src/*.ts",
        "build-helper.ts",
        "vendor/int*/watched.ts",
        ".g*/scripts/*.ts",
        ".hidden-root.ts",
        "packages/BUILD-*/added.ts",
      ],
    });
    const selectedSources = [
      {
        filePath: path.join(projectDir, "build-tools", "src", "watched.ts"),
        independentDefinition: `${backend}IndependentBuildDefinition`,
        originalDefinition: `${backend}OriginalBuildDefinition`,
        burstDefinition: `${backend}BurstBuildDefinition`,
      },
      {
        filePath: path.join(projectDir, "build-helper.ts"),
        independentDefinition: `${backend}IndependentBuildHelperDefinition`,
        originalDefinition: `${backend}OriginalBuildHelperDefinition`,
        burstDefinition: `${backend}BurstBuildHelperDefinition`,
      },
      {
        filePath: path.join(projectDir, "vendor", "internal", "watched.ts"),
        independentDefinition: `${backend}IndependentVendorDefinition`,
        originalDefinition: `${backend}OriginalVendorDefinition`,
        burstDefinition: `${backend}BurstVendorDefinition`,
      },
      {
        filePath: path.join(projectDir, ".github", "scripts", "watched.ts"),
        independentDefinition: `${backend}IndependentGithubDefinition`,
        originalDefinition: `${backend}OriginalGithubDefinition`,
        burstDefinition: `${backend}BurstGithubDefinition`,
      },
      {
        filePath: path.join(projectDir, ".hidden-root.ts"),
        independentDefinition: `${backend}IndependentHiddenDefinition`,
        originalDefinition: `${backend}OriginalHiddenDefinition`,
        burstDefinition: `${backend}BurstHiddenDefinition`,
      },
    ];
    const negativeSources = [
      [path.join(projectDir, "vendor", "public", "sibling.ts"), `${backend}VendorSiblingDefinition`],
      [path.join(projectDir, "vendor", "internal", "sibling.ts"), `${backend}VendorExactSiblingDefinition`],
      [path.join(projectDir, "packages", "BUILD-CACHE", "sibling.ts"), `${backend}UppercaseSiblingDefinition`],
      [path.join(projectDir, ".github", "workflows", "sibling.ts"), `${backend}GithubSiblingDefinition`],
      [path.join(projectDir, ".hidden-sibling.ts"), `${backend}HiddenSiblingDefinition`],
      [path.join(projectDir, "build-tools", "src", "blocked.ts"), `${backend}ExplicitlyExcludedDefinition`],
      [path.join(projectDir, "build-tools", "src", "git-ignored.ts"), `${backend}GitIgnoredDefinition`],
    ] as const;
    const addedPath = path.join(projectDir, "packages", "BUILD-CACHE", "added.ts");
    const addedDefinition = `${backend}AddedDefinition`;
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "build-tools/src/git-ignored.ts\n");
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

    // Isolate every selected path so another callback and full reindex cannot mask a traversal or filter miss.
    for (const source of selectedSources) {
      const observedStart = observedPaths.length;
      writeSource(source.filePath, source.independentDefinition);
      await vi.waitFor(async () => {
        expect(observedPaths.slice(observedStart)).toContain(source.filePath);
        expect(await hasDefinition(indexer, source.independentDefinition, source.filePath)).toBe(true);
        expect(await hasDefinition(indexer, source.originalDefinition, source.filePath)).toBe(false);
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    }

    // Real hosts request a full index for any batch, so keep simultaneous burst reconciliation as a separate contract.
    const burstObservedStart = observedPaths.length;
    for (const source of selectedSources) {
      writeSource(source.filePath, source.burstDefinition);
    }
    for (const [filePath, definitionName] of negativeSources) {
      writeSource(filePath, `${definitionName}Updated`);
    }
    await vi.waitFor(async () => {
      expect(observedPaths.slice(burstObservedStart).some(
        (observedPath) => selectedSources.some((source) => source.filePath === observedPath),
      )).toBe(true);
      for (const source of selectedSources) {
        expect(await hasDefinition(indexer, source.burstDefinition, source.filePath)).toBe(true);
        expect(await hasDefinition(indexer, source.independentDefinition, source.filePath)).toBe(false);
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

  it("indexes a change made right after waitUntilReady when EMFILE falls back to polling during the first ready", async () => {
    const config = structuralConfig();
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    writeSource(ordinaryPath, "emfileOriginalOrdinaryDefinition");

    const indexer = createIndexer(config);
    await indexer.index();

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher(projectDir, config, "jcode", { backend: "chokidar" });
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

    // Fault boundary only: emit EMFILE on the real first watcher in the same ready emission as the
    // application's ready listener, so the polling replacement is created before waiters resume.
    const readWatcher = (): FSWatcher => (watcher as unknown as { watcher: FSWatcher }).watcher;
    const first = readWatcher();
    expect(first.options.usePolling).toBeFalsy();
    let replacementReady = false;
    first.on("ready", () => {
      first.emit("error", Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" }));
      const replacement = readWatcher();
      expect(replacement).not.toBe(first);
      expect(replacement.options.usePolling).toBe(true);
      replacement.on("ready", () => {
        replacementReady = true;
      });
    });

    await watcher.waitUntilReady();
    expect(replacementReady).toBe(true);

    const updatedDefinition = "emfileUpdatedOrdinaryDefinition";
    writeSource(ordinaryPath, updatedDefinition);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, updatedDefinition, ordinaryPath)).toBe(true);
      expect(observedPaths).toContain(ordinaryPath);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
  });

  function startRecoveryConsumer(
    config: ParsedCodebaseIndexConfig,
    indexer: Indexer,
    options: FileWatcherOptions = {},
  ): { watcher: FileWatcher; observed: FileChange[] } {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watcher = new FileWatcher(projectDir, config, "jcode", { backend: "chokidar", ...options });
    watchers.push(watcher);
    const observed: FileChange[] = [];
    let handlerTail = Promise.resolve();
    watcher.start(async (changes) => {
      observed.push(...changes);
      handlerTail = handlerTail.then(async () => { await indexer.index(); });
      handlerTails.push(handlerTail);
      await handlerTail;
    });
    return { watcher, observed };
  }

  async function prepareReadyWatcherReplacement(watcher: FileWatcher): Promise<() => FSWatcher> {
    // Access only the controlled error boundary; both backends and all consumer work are real.
    const internals = watcher as unknown as { watcher: FSWatcher };
    await watcher.waitUntilReady();
    const first = internals.watcher;
    expect(first.options.usePolling).toBeFalsy();
    return () => {
      first.emit("error", Object.assign(new Error("CONTROLLED EMFILE injection"), { code: "EMFILE" }));
      const replacement = internals.watcher;
      expect(replacement).not.toBe(first);
      expect(replacement.options.usePolling).toBe(true);
      return replacement;
    };
  }

  it.each(["change", "add", "unlink"] as const)(
    "indexes an isolated %s during post-ready EMFILE polling replacement without another readiness wait",
    async (mutation) => {
      const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
      const ordinaryPath = path.join(projectDir, mutation === "change" ? "src" : "build-tools", "ordinary.ts");
      if (mutation !== "add") writeSource(ordinaryPath, "postReadyOriginalOrdinaryDefinition");
      const indexer = createIndexer(config);
      await indexer.index();
      const { watcher, observed } = startRecoveryConsumer(config, indexer);
      const replace = await prepareReadyWatcherReplacement(watcher);
      const replacement = replace();
      let replacementReady = false;
      replacement.on("ready", () => { replacementReady = true; });
      expect(replacementReady).toBe(false);
      if (mutation === "unlink") fs.rmSync(ordinaryPath);
      else writeSource(ordinaryPath, "postReadyUpdatedOrdinaryDefinition");

      await vi.waitFor(async () => {
        if (mutation === "unlink") {
          expect(await hasDefinition(indexer, "postReadyOriginalOrdinaryDefinition", ordinaryPath)).toBe(false);
        } else {
          expect(await hasDefinition(indexer, "postReadyUpdatedOrdinaryDefinition", ordinaryPath)).toBe(true);
        }
        expect(observed).toContainEqual({ path: ordinaryPath, type: mutation });
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

      // Ongoing delivery must survive the snapshot-to-live handoff as well.
      expect(replacementReady).toBe(true);
      writeSource(ordinaryPath, "postReadyOngoingOrdinaryDefinition");
      await vi.waitFor(async () => {
        expect(await hasDefinition(indexer, "postReadyOngoingOrdinaryDefinition", ordinaryPath)).toBe(true);
        expect(await hasDefinition(indexer, "postReadyUpdatedOrdinaryDefinition", ordinaryPath)).toBe(false);
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    },
  );

  it("preserves opt-in, ignore, root-build and protected path policy during post-ready EMFILE catch-up", async () => {
    const config = structuralConfig({
      includeExcluded: ["build-tools/**", ".github/**", "vendor/**", ".git/**", "private-index/**"],
      exclude: ["build-tools/blocked.ts"],
    });
    const selectedPath = path.join(projectDir, "build-tools", "selected.ts");
    const negativePaths = [
      path.join(projectDir, "build-tools", "blocked.ts"),
      path.join(projectDir, "vendor", "ignored.ts"),
      path.join(projectDir, ".git", "protected.ts"),
      path.join(projectDir, "private-index", "protected.ts"),
      path.join(projectDir, "build-helper.ts"),
      path.join(projectDir, ".hidden-sibling.ts"),
    ];
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "vendor/ignored.ts\n");
    writeSource(selectedPath, "policyOriginalSelectedDefinition");
    for (const filePath of negativePaths) writeSource(filePath, "policyOriginalNegativeDefinition");
    const indexer = createIndexer(config, { indexPath: path.join(projectDir, "private-index") });
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer, { indexPath: path.join(projectDir, "private-index") });
    const replace = await prepareReadyWatcherReplacement(watcher);
    replace();
    writeSource(selectedPath, "policyUpdatedSelectedDefinition");
    for (const filePath of negativePaths) writeSource(filePath, "policyUpdatedNegativeDefinition");
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, "policyUpdatedSelectedDefinition", selectedPath)).toBe(true);
      expect(observed).toContainEqual({ path: selectedPath, type: "change" });
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    for (const filePath of negativePaths) expect(observed.some((change) => change.path === filePath)).toBe(false);
    expect(observed.every((change) => !fs.existsSync(change.path) || fs.statSync(change.path).isFile())).toBe(true);
  });

  it.each(["change", "unlink"] as const)(
    "retains project and local-module config %s during post-ready EMFILE catch-up",
    async (mutation) => {
      const config = structuralConfig();
      const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
      const configPath = path.join(projectDir, ".codebase-index", "config.json");
      const moduleConfigPath = path.join(projectDir, "tsconfig.json");
      writeSource(ordinaryPath, "configOriginalOrdinaryDefinition");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, "{}");
      fs.writeFileSync(moduleConfigPath, "{}");
      const indexer = createIndexer(config);
      await indexer.index();
      const { watcher, observed } = startRecoveryConsumer(config, indexer, { configPath });
      const replace = await prepareReadyWatcherReplacement(watcher);
      replace();
      for (const filePath of [configPath, moduleConfigPath]) {
        if (mutation === "unlink") fs.rmSync(filePath);
        else fs.writeFileSync(filePath, '{"compilerOptions":{}}');
      }
      // The ordinary change proves the real callback's awaited index completed.
      writeSource(ordinaryPath, "configUpdatedOrdinaryDefinition");
      await vi.waitFor(async () => {
        expect(await hasDefinition(indexer, "configUpdatedOrdinaryDefinition", ordinaryPath)).toBe(true);
        for (const filePath of [configPath, moduleConfigPath]) {
          expect(observed).toContainEqual({ path: filePath, type: mutation });
        }
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    },
  );

  it("preserves unreadable paths instead of fabricating deletes during EMFILE catch-up", async () => {
    const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
    const selectedPath = path.join(projectDir, "build-tools", "selected.ts");
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    writeSource(selectedPath, "unreadableSelectedDefinition");
    writeSource(ordinaryPath, "unreadableOriginalDefinition");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer);
    const replace = await prepareReadyWatcherReplacement(watcher);
    let denied = false;
    snapshotFaults.beforeRead = async (directory) => {
      if (directory !== path.dirname(selectedPath)) return;
      snapshotFaults.beforeRead = undefined;
      denied = true;
      throw Object.assign(new Error("CONTROLLED scan EACCES"), { code: "EACCES" });
    };
    replace();
    writeSource(ordinaryPath, "unreadableUpdatedDefinition");
    await vi.waitFor(async () => {
      expect(denied).toBe(true);
      expect(await hasDefinition(indexer, "unreadableUpdatedDefinition", ordinaryPath)).toBe(true);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    expect(observed).not.toContainEqual({ path: selectedPath, type: "unlink" });
    expect(await hasDefinition(indexer, "unreadableSelectedDefinition", selectedPath)).toBe(true);
  });

  it("merges real polling unlinks newer than an in-flight catch-up scan", async () => {
    const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
    const selectedPath = path.join(projectDir, "build-tools", "selected.ts");
    writeSource(selectedPath, "handoffSelectedDefinition");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer);
    const replace = await prepareReadyWatcherReplacement(watcher);
    const { promise: scanGate, resolve: releaseScan } = Promise.withResolvers<void>();
    let scanPaused = false;
    snapshotFaults.afterStat = async (filePath) => {
      if (filePath !== selectedPath) return;
      snapshotFaults.afterStat = undefined;
      scanPaused = true;
      await scanGate;
    };
    try {
      const replacement = replace();
      await vi.waitFor(() => expect(scanPaused).toBe(true), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      let realUnlink = false;
      replacement.on("unlink", (filePath) => { if (filePath === selectedPath) realUnlink = true; });
      fs.rmSync(selectedPath);
      await vi.waitFor(() => expect(realUnlink).toBe(true), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      releaseScan();
      await vi.waitFor(async () => {
        expect(await hasDefinition(indexer, "handoffSelectedDefinition", selectedPath)).toBe(false);
        expect(observed).toContainEqual({ path: selectedPath, type: "unlink" });
        expect(observed).not.toContainEqual({ path: selectedPath, type: "change" });
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    } finally {
      releaseScan();
    }
  });

  it("drains stale catch-up work without delivering it to a restarted consumer", async () => {
    const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
    const selectedPath = path.join(projectDir, "build-tools", "selected.ts");
    writeSource(selectedPath, "restartOriginalDefinition");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer);
    const replace = await prepareReadyWatcherReplacement(watcher);
    const { promise: scanGate, resolve: releaseScan } = Promise.withResolvers<void>();
    let scanPaused = false;
    snapshotFaults.afterStat = async (filePath) => {
      if (filePath !== selectedPath) return;
      snapshotFaults.afterStat = undefined;
      scanPaused = true;
      await scanGate;
    };
    try {
      replace();
      await vi.waitFor(() => expect(scanPaused).toBe(true), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      const stopped = watcher.stop();
      const restarted: FileChange[] = [];
      watcher.start(async (changes) => {
        restarted.push(...changes);
        const indexed = indexer.index().then(() => undefined);
        handlerTails.push(indexed);
        await indexed;
      });
      await watcher.waitUntilReady();
      releaseScan();
      await stopped;
      writeSource(selectedPath, "restartUpdatedDefinition");
      await vi.waitFor(async () => {
        expect(await hasDefinition(indexer, "restartUpdatedDefinition", selectedPath)).toBe(true);
        expect(restarted).toContainEqual({ path: selectedPath, type: "change" });
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      expect(observed).toEqual([]);
    } finally {
      releaseScan();
    }
  });

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "keeps external-config EMFILE recovery separate from the live native source watcher",
    async () => {
      const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
      const selectedPath = path.join(projectDir, "build-tools", "selected.ts");
      const configPath = path.join(indexRoot, "external-config.json");
      writeSource(selectedPath, "externalConfigSelectedDefinition");
      fs.writeFileSync(configPath, "{}");
      const indexer = createIndexer(config);
      await indexer.index();
      const { watcher, observed } = startRecoveryConsumer(config, indexer, { backend: "native", configPath });
      const replace = await prepareReadyWatcherReplacement(watcher);
      replace();
      fs.rmSync(configPath);
      await vi.waitFor(() => {
        expect(observed).toContainEqual({ path: configPath, type: "unlink" });
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      expect(observed.some((change) => change.path === selectedPath)).toBe(false);
      expect(await hasDefinition(indexer, "externalConfigSelectedDefinition", selectedPath)).toBe(true);
    },
  );

  it("does not classify still-present selected files outside snapshot depth as deleted during EMFILE recovery", async () => {
    const config = structuralConfig({ maxDepth: 0, includeExcluded: ["build-tools/**"] });
    const nestedPath = path.join(projectDir, "build-tools", "selected.ts");
    const ordinaryPath = path.join(projectDir, "ordinary.ts");
    writeSource(nestedPath, "depthSelectedDefinition");
    writeSource(ordinaryPath, "depthOriginalDefinition");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer);
    const replace = await prepareReadyWatcherReplacement(watcher);
    replace();
    writeSource(ordinaryPath, "depthUpdatedDefinition");
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, "depthUpdatedDefinition", ordinaryPath)).toBe(true);
      expect(observed).toContainEqual({ path: nestedPath, type: "change" });
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    expect(fs.statSync(nestedPath).isFile()).toBe(true);
    expect(observed).not.toContainEqual({ path: nestedPath, type: "unlink" });
  });

  it("coalesces project config and new module dependencies with live events during a slow EMFILE scan", async () => {
    const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
    const ordinaryPath = path.join(projectDir, "build-tools", "ordinary.ts");
    const configPath = path.join(projectDir, ".codebase-index", "config.json");
    const moduleConfigPath = path.join(projectDir, "tsconfig.json");
    const dependencyPath = path.join(projectDir, "settings", "paths.json");
    writeSource(ordinaryPath, "slowConfigOriginalDefinition");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");
    fs.writeFileSync(moduleConfigPath, "{}");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer, { configPath });
    const replace = await prepareReadyWatcherReplacement(watcher);
    const { promise: scanGate, resolve: releaseScan } = Promise.withResolvers<void>();
    let scanPaused = false;
    snapshotFaults.afterStat = async (filePath) => {
      if (filePath !== ordinaryPath) return;
      snapshotFaults.afterStat = undefined;
      scanPaused = true;
      await scanGate;
    };
    try {
      const replacement = replace();
      fs.writeFileSync(configPath, '{"search":{"minScore":0}}');
      writeSource(ordinaryPath, "slowConfigUpdatedDefinition");
      await vi.waitFor(() => expect(scanPaused).toBe(true), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      let liveConfigUnlink = false;
      let liveDependencyAdd = false;
      replacement.on("unlink", (filePath) => { if (filePath === configPath) liveConfigUnlink = true; });
      replacement.on("add", (filePath) => { if (filePath === dependencyPath) liveDependencyAdd = true; });
      fs.rmSync(configPath);
      fs.writeFileSync(moduleConfigPath, '{"extends":"./settings/paths.json"}');
      fs.writeFileSync(dependencyPath, '{"compilerOptions":{"baseUrl":".."}}');
      await vi.waitFor(() => {
        expect(liveConfigUnlink).toBe(true);
        expect(liveDependencyAdd).toBe(true);
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      // Real polling and debounce share platform time; fake timers would replace the handoff being tested.
      // Hold the scan past the normal debounce so an early config batch cannot escape unnoticed.
      const { promise: debounceElapsed, resolve: elapsed } = Promise.withResolvers<void>();
      setTimeout(elapsed, 1100);
      await debounceElapsed;
      expect(observed).toEqual([]);
      releaseScan();
      await vi.waitFor(async () => {
        expect(await hasDefinition(indexer, "slowConfigUpdatedDefinition", ordinaryPath)).toBe(true);
        expect(observed).toContainEqual({ path: configPath, type: "unlink" });
        expect(observed).toContainEqual({ path: dependencyPath, type: "add" });
        expect(observed).not.toContainEqual({ path: configPath, type: "change" });
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    } finally {
      releaseScan();
    }
  });

  it("does not manufacture config deletes or reindex a root-build-only project during EMFILE recovery", async () => {
    const config = structuralConfig();
    const buildPath = path.join(projectDir, "build-helper.ts");
    writeSource(buildPath, "rootBuildOriginalDefinition");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer);
    const replace = await prepareReadyWatcherReplacement(watcher);
    replace();
    writeSource(buildPath, "rootBuildUpdatedDefinition");
    await vi.waitFor(() => expect(watcher.isBusy()).toBe(false), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    expect(observed).toEqual([]);
    expect(await hasDefinition(indexer, "rootBuildOriginalDefinition", buildPath)).toBe(true);
    expect(await hasDefinition(indexer, "rootBuildUpdatedDefinition", buildPath)).toBe(false);
  });

  it("does not turn an unreadable project config into an EMFILE recovery delete", async () => {
    const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
    const ordinaryPath = path.join(projectDir, "build-tools", "ordinary.ts");
    const configPath = path.join(projectDir, ".codebase-index", "config.json");
    writeSource(ordinaryPath, "permissionOriginalDefinition");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{}");
    const indexer = createIndexer(config);
    await indexer.index();
    const { watcher, observed } = startRecoveryConsumer(config, indexer, { configPath });
    const replace = await prepareReadyWatcherReplacement(watcher);
    let denied = false;
    snapshotFaults.afterStat = async (filePath) => {
      if (filePath !== configPath) return;
      snapshotFaults.afterStat = undefined;
      denied = true;
      throw Object.assign(new Error("CONTROLLED config EACCES"), { code: "EACCES" });
    };
    replace();
    writeSource(ordinaryPath, "permissionUpdatedDefinition");
    await vi.waitFor(async () => {
      expect(denied).toBe(true);
      expect(await hasDefinition(indexer, "permissionUpdatedDefinition", ordinaryPath)).toBe(true);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
    expect(observed).not.toContainEqual({ path: configPath, type: "unlink" });
    expect(fs.statSync(configPath).isFile()).toBe(true);
  });

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "preserves an unreadable auxiliary config while native source delivery stays live",
    async () => {
      const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
      const ordinaryPath = path.join(projectDir, "build-tools", "ordinary.ts");
      const configPath = path.join(indexRoot, "external-config.json");
      writeSource(ordinaryPath, "auxiliaryOriginalDefinition");
      fs.writeFileSync(configPath, "{}");
      const indexer = createIndexer(config);
      await indexer.index();
      const { watcher, observed } = startRecoveryConsumer(config, indexer, { backend: "native", configPath });
      const replace = await prepareReadyWatcherReplacement(watcher);
      let denied = false;
      snapshotFaults.afterStat = async (filePath) => {
        if (filePath !== configPath) return;
        snapshotFaults.afterStat = undefined;
        denied = true;
        throw Object.assign(new Error("CONTROLLED auxiliary config EACCES"), { code: "EACCES" });
      };
      replace();
      await vi.waitFor(() => {
        expect(denied).toBe(true);
        expect(watcher.isBusy()).toBe(false);
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      expect(observed).toEqual([]);
      writeSource(ordinaryPath, "auxiliaryUpdatedDefinition");
      await vi.waitFor(async () => {
        expect(await hasDefinition(indexer, "auxiliaryUpdatedDefinition", ordinaryPath)).toBe(true);
      }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      expect(observed).not.toContainEqual({ path: configPath, type: "unlink" });
    },
  );

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "hands auxiliary recovery ownership to a real full fallback after a native error",
    async () => {
      const config = structuralConfig({ includeExcluded: ["build-tools/**"] });
      const ordinaryPath = path.join(projectDir, "build-tools", "ordinary.ts");
      const configPath = path.join(indexRoot, "external-config.json");
      writeSource(ordinaryPath, "ownershipOriginalDefinition");
      fs.writeFileSync(configPath, "{}");
      const indexer = createIndexer(config);
      await indexer.index();
      const { watcher, observed } = startRecoveryConsumer(config, indexer, { backend: "native", configPath });
      const replace = await prepareReadyWatcherReplacement(watcher);
      const { promise: scanGate, resolve: releaseScan } = Promise.withResolvers<void>();
      let scanPaused = false;
      snapshotFaults.afterStat = async (filePath) => {
        if (filePath !== configPath) return;
        snapshotFaults.afterStat = undefined;
        scanPaused = true;
        await scanGate;
      };
      try {
        const auxiliary = replace();
        await vi.waitFor(() => expect(scanPaused).toBe(true), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
        let configUnlinked = false;
        auxiliary.on("unlink", (filePath) => { if (filePath === configPath) configUnlinked = true; });
        fs.rmSync(configPath);
        await vi.waitFor(() => expect(configUnlinked).toBe(true), { timeout: WATCH_TIMEOUT_MS, interval: 50 });

        // Observe actual ready emissions without replacing backend creation or event delivery.
        const emit = FSWatcher.prototype.emit;
        let fullReady: FSWatcher | undefined;
        vi.spyOn(FSWatcher.prototype, "emit").mockImplementation(function (this: FSWatcher, event, ...args) {
          if (event === "ready" && this !== auxiliary) fullReady = this;
          return emit.call(this, event, ...args);
        });
        const internals = watcher as unknown as { nativeWatcher: { watcher: fs.FSWatcher } };
        internals.nativeWatcher.watcher.emit("error", new Error("CONTROLLED native watcher failure"));
        await vi.waitFor(() => expect(fullReady).toBeDefined(), { timeout: WATCH_TIMEOUT_MS, interval: 50 });
        writeSource(ordinaryPath, "ownershipUpdatedDefinition");
        releaseScan();
        await vi.waitFor(async () => {
          expect(await hasDefinition(indexer, "ownershipUpdatedDefinition", ordinaryPath)).toBe(true);
          expect(observed).toContainEqual({ path: configPath, type: "unlink" });
          expect(watcher.isBusy()).toBe(false);
        }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });
      } finally {
        releaseScan();
      }
    },
  );

  it("reindexes partial-wildcard parent changes through the Chokidar FileWatcher", async () => {
    await exerciseWatcherBackend("chokidar");
  });

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "reindexes partial-wildcard parent changes through the native FileWatcher without fallback",
    async () => {
      await exerciseWatcherBackend("native");
    },
  );
});
