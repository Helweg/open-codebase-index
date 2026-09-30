import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  excludeBuildPaths?: boolean;
}

function structuralConfig(options: StructuralConfigOptions = {}): ParsedCodebaseIndexConfig {
  const rawConfig: Record<string, unknown> = {
    indexing: {
      mode: "structural",
      autoGc: true,
      watchFiles: false,
      requireProjectMarker: false,
      maxDepth: -1,
      maxFilesPerDirectory: 1000,
    },
    include: ["**/*.ts"],
    additionalInclude: options.additionalInclude ?? [],
    search: { minScore: 0 },
  };
  if (options.exclude !== undefined) {
    rawConfig.exclude = options.exclude;
  }
  if (options.excludeBuildPaths !== undefined) {
    rawConfig.excludeBuildPaths = options.excludeBuildPaths;
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

describe("build-path indexing acceptance", () => {
  let projectDir: string;
  let indexRoot: string;
  let indexers: Indexer[];
  let watchers: FileWatcher[];
  let handlerTails: Promise<void>[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const createIndexer = (config: ParsedCodebaseIndexConfig): Indexer => {
    const indexer = new Indexer(projectDir, config, "jcode", { indexPath: indexRoot });
    indexers.push(indexer);
    return indexer;
  };

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-build-paths-project-"));
    indexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocbi-build-paths-index-"));
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
        throw new AggregateError(failures, "Failed to close build-path acceptance test resources");
      }
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(indexRoot, { recursive: true, force: true });
    }
  });

  it("keeps build directories excluded by default", async () => {
    const ordinaryPath = path.join(projectDir, "src", "ordinary.ts");
    const buildDirectoryPath = path.join(projectDir, "src", "build-tools", "default-build-source.ts");
    const uppercaseBuildDirectoryPath = path.join(projectDir, "src", "BUILD-CACHE", "uppercase-build-source.ts");
    writeSource(ordinaryPath, "ordinaryDefinition");
    writeSource(buildDirectoryPath, "defaultBuildDefinition");
    writeSource(uppercaseBuildDirectoryPath, "uppercaseDefaultBuildDefinition");

    const indexer = createIndexer(structuralConfig());
    await indexer.index();

    expect(await hasDefinition(indexer, "ordinaryDefinition", ordinaryPath)).toBe(true);
    expect(await hasDefinition(indexer, "defaultBuildDefinition", buildDirectoryPath)).toBe(false);
    expect(await hasDefinition(indexer, "uppercaseDefaultBuildDefinition", uppercaseBuildDirectoryPath)).toBe(false);
  });

  it("indexes build-named sources when disabled while preserving other filters", async () => {
    const buildToolsPath = path.join(projectDir, "build-tools", "source.ts");
    const uppercaseBuildPath = path.join(projectDir, "packages", "BUILD-CACHE", "nested.ts");
    const rootBuildFilePath = path.join(projectDir, "build-helper.ts");
    const additionalIncludePath = path.join(projectDir, "build-tools", "component.tsx");
    const explicitBuildOutputPath = path.join(projectDir, "generated", "build", "output.ts");
    const gitIgnoredBuildPath = path.join(projectDir, "ignored-build", "ignored.ts");
    const includeMissPath = path.join(projectDir, "build-tools", "notes.md");
    const hiddenPath = path.join(projectDir, ".hidden-build", "secret.ts");
    const dependencyPath = path.join(projectDir, "node_modules", "build-library", "dependency.ts");
    const outputPath = path.join(projectDir, "dist", "build-tools", "bundle.ts");

    fs.writeFileSync(path.join(projectDir, ".gitignore"), "ignored-build/\n");
    writeSource(buildToolsPath, "buildToolsDefinition");
    writeSource(uppercaseBuildPath, "uppercaseBuildDefinition");
    writeSource(rootBuildFilePath, "rootBuildHelperDefinition");
    writeSource(additionalIncludePath, "additionalBuildDefinition");
    writeSource(explicitBuildOutputPath, "explicitBuildOutputDefinition");
    writeSource(gitIgnoredBuildPath, "gitIgnoredBuildDefinition");
    writeSource(includeMissPath, "includeMissDefinition");
    writeSource(hiddenPath, "hiddenBuildDefinition");
    writeSource(dependencyPath, "dependencyBuildDefinition");
    writeSource(outputPath, "outputBuildDefinition");

    const indexer = createIndexer(structuralConfig({
      additionalInclude: ["**/*.tsx"],
      exclude: ["**/build/**"],
      excludeBuildPaths: false,
    }));
    await indexer.index();

    expect(await hasDefinition(indexer, "buildToolsDefinition", buildToolsPath)).toBe(true);
    expect(await hasDefinition(indexer, "uppercaseBuildDefinition", uppercaseBuildPath)).toBe(true);
    expect(await hasDefinition(indexer, "rootBuildHelperDefinition", rootBuildFilePath)).toBe(true);
    expect(await hasDefinition(indexer, "additionalBuildDefinition", additionalIncludePath)).toBe(true);
    expect(await hasDefinition(indexer, "explicitBuildOutputDefinition", explicitBuildOutputPath)).toBe(false);
    expect(await hasDefinition(indexer, "gitIgnoredBuildDefinition", gitIgnoredBuildPath)).toBe(false);
    expect(await hasDefinition(indexer, "includeMissDefinition", includeMissPath)).toBe(false);
    expect(await hasDefinition(indexer, "hiddenBuildDefinition", hiddenPath)).toBe(false);
    expect(await hasDefinition(indexer, "dependencyBuildDefinition", dependencyPath)).toBe(false);
    expect(await hasDefinition(indexer, "outputBuildDefinition", outputPath)).toBe(false);
  });

  async function exerciseWatcherBackend(backend: Exclude<FileWatcherBackend, "auto">): Promise<void> {
    const config = structuralConfig({ exclude: ["**/build/**"], excludeBuildPaths: false });
    const directorySourcePath = path.join(projectDir, "build-tools", "watched.ts");
    const rootSourcePath = path.join(projectDir, "build-helper.ts");
    const addedPath = path.join(projectDir, "nested", "BUILD-CACHE", "added.ts");
    const ignoredPath = path.join(projectDir, "ignored-build", "ignored.ts");
    const explicitlyExcludedPath = path.join(projectDir, "generated", "build", "output.ts");
    const directoryDefinition = `${backend}DirectoryBuildDefinition`;
    const originalRootDefinition = `${backend}OriginalRootBuildDefinition`;
    const updatedRootDefinition = `${backend}UpdatedRootBuildDefinition`;
    const addedDefinition = `${backend}AddedBuildDefinition`;
    const ignoredDefinition = `${backend}IgnoredBuildDefinition`;
    const explicitlyExcludedDefinition = `${backend}ExplicitlyExcludedBuildDefinition`;
    fs.writeFileSync(path.join(projectDir, ".gitignore"), "ignored-build/\n");
    writeSource(directorySourcePath, directoryDefinition);
    writeSource(rootSourcePath, originalRootDefinition);
    writeSource(ignoredPath, ignoredDefinition);
    writeSource(explicitlyExcludedPath, explicitlyExcludedDefinition);

    const indexer = createIndexer(config);
    await indexer.index();
    expect(await hasDefinition(indexer, directoryDefinition, directorySourcePath)).toBe(true);
    expect(await hasDefinition(indexer, originalRootDefinition, rootSourcePath)).toBe(true);
    expect(await hasDefinition(indexer, ignoredDefinition, ignoredPath)).toBe(false);
    expect(await hasDefinition(indexer, explicitlyExcludedDefinition, explicitlyExcludedPath)).toBe(false);

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

    writeSource(rootSourcePath, updatedRootDefinition);
    writeSource(ignoredPath, `${ignoredDefinition}Updated`);
    writeSource(explicitlyExcludedPath, `${explicitlyExcludedDefinition}Updated`);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, updatedRootDefinition, rootSourcePath)).toBe(true);
      expect(await hasDefinition(indexer, originalRootDefinition, rootSourcePath)).toBe(false);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    writeSource(addedPath, addedDefinition);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, addedDefinition, addedPath)).toBe(true);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    fs.rmSync(addedPath);
    await vi.waitFor(async () => {
      expect(await hasDefinition(indexer, addedDefinition, addedPath)).toBe(false);
    }, { timeout: WATCH_TIMEOUT_MS, interval: 50 });

    expect(observedPaths).not.toContain(ignoredPath);
    expect(observedPaths).not.toContain(explicitlyExcludedPath);
    expect(await hasDefinition(indexer, `${ignoredDefinition}Updated`, ignoredPath)).toBe(false);
    expect(await hasDefinition(indexer, `${explicitlyExcludedDefinition}Updated`, explicitlyExcludedPath)).toBe(false);
    if (backend === "native") {
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes("Chokidar fallback"))).toBe(false);
    }
  }

  it("propagates build-path updates through the Chokidar FileWatcher", async () => {
    await exerciseWatcherBackend("chokidar");
  });

  it.runIf(SUPPORTS_NATIVE_RECURSIVE_WATCH)(
    "propagates build-path updates through the native FileWatcher without fallback",
    async () => {
      await exerciseWatcherBackend("native");
    },
  );
});
