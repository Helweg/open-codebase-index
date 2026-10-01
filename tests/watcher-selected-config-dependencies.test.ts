import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import {
  FileWatcher,
  type FileChange,
  type FileChangeType,
  type FileWatcherBackend,
} from "../src/watcher/file-watcher.js";

const EVENT_TIMEOUT_MS = 15_000;
type ConcreteWatcherBackend = Exclude<FileWatcherBackend, "auto">;

async function waitForAssertion(assertion: () => void | Promise<void>, timeoutMs = EVENT_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }

  throw lastError ?? new Error("Timed out waiting for watcher assertion.");
}

async function writeUntilObserved(
  write: (attempt: number) => void,
  assertion: () => void | Promise<void>,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    write(attempt++);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    try {
      await waitForAssertion(assertion, Math.min(2_500, remainingMs));
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Timed out waiting for watcher write.");
}

async function waitForChange(
  changes: readonly FileChange[],
  filePath: string,
  type: FileChangeType | readonly FileChangeType[],
): Promise<void> {
  const expectedTypes = typeof type === "string" ? [type] : type;
  await waitForAssertion(() => {
    expect(changes.some((change) => (
      change.path === filePath && expectedTypes.includes(change.type)
    ))).toBe(true);
  });
}

function writeAliasConfig(filePath: string, targetName: string, attempt = 0): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    compilerOptions: {
      baseUrl: "../..",
      paths: { "@target": [`src/${targetName}.ts`] },
    },
    attempt,
  }));
}

async function resolvedTargetPath(indexer: Indexer, projectRoot: string): Promise<string | null> {
  const symbols = await indexer.getSymbolsForBranch();
  const caller = symbols.find((symbol) => symbol.name === "selectedCaller");
  if (!caller) throw new Error("Selected importer was not indexed.");

  const edge = (await indexer.getCallees(caller.id)).find((candidate) => candidate.targetName === "target");
  if (!edge?.isResolved || !edge.toSymbolId) return null;

  const destination = symbols.find((symbol) => symbol.id === edge.toSymbolId);
  return destination ? path.relative(projectRoot, destination.filePath) : null;
}

function hasNativeFallbackWarning(warnSpy: ReturnType<typeof vi.spyOn>): boolean {
  return warnSpy.mock.calls.some((args) => String(args[0]).includes("Chokidar fallback"));
}

function expectRequestedBackend(watcher: FileWatcher, backend: ConcreteWatcherBackend): void {
  if (backend !== "native") return;
  const internals = watcher as unknown as {
    nativeWatcher: unknown;
    nativeReconciler: unknown;
  };
  expect(internals.nativeWatcher).not.toBeNull();
  expect(internals.nativeReconciler).not.toBeNull();
}

describe("selected local module config dependencies", () => {
  const cleanupPaths = new Set<string>();

  afterEach(() => {
    for (const cleanupPath of cleanupPaths) {
      fs.rmSync(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    vi.restoreAllMocks();
  });

  it.each([
    ["chokidar", "vendor/app/src/*.ts"],
    ["chokidar", "vendor/app/src/main.ts"],
    ["native", "vendor/app/src/*.ts"],
    ["native", "vendor/app/src/main.ts"],
  ] as const)(
    "refreshes the structural alias graph for %s with includeExcluded %s",
    async (backend, includeExcluded) => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-selected-config-"));
      cleanupPaths.add(fixtureRoot);
      const projectRoot = path.join(fixtureRoot, "project");
      const indexPath = path.join(fixtureRoot, "index");
      const importerPath = path.join(projectRoot, "vendor", "app", "src", "main.ts");
      const appConfigPath = path.join(projectRoot, "vendor", "app", "tsconfig.json");
      const baseConfigPath = path.join(projectRoot, "vendor", "shared", "base.json");
      const unrelatedSourcePath = path.join(projectRoot, "vendor", "shared", "unrelated.ts");
      const onePath = path.join(projectRoot, "src", "one.ts");
      const twoPath = path.join(projectRoot, "src", "two.ts");
      fs.mkdirSync(path.dirname(importerPath), { recursive: true });
      fs.mkdirSync(path.dirname(onePath), { recursive: true });
      fs.mkdirSync(path.dirname(baseConfigPath), { recursive: true });
      fs.writeFileSync(
        importerPath,
        'import { target } from "@target";\nexport function selectedCaller() { return target(); }\n',
      );
      fs.writeFileSync(onePath, "export function target() { return 1; }\n");
      fs.writeFileSync(twoPath, "export function target() { return 2; }\n");
      fs.writeFileSync(unrelatedSourcePath, "export function excludedSibling() { return 3; }\n");
      fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../shared/base" }));
      writeAliasConfig(baseConfigPath, "one");

      const config = parseConfig({
        include: ["**/*.ts"],
        indexing: {
          mode: "structural",
          autoGc: false,
          requireProjectMarker: false,
          includeExcluded: [includeExcluded],
        },
      });
      const indexer = new Indexer(projectRoot, config, "jcode", { indexPath });
      const watcher = new FileWatcher(projectRoot, config, "jcode", { backend, indexPath });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const observedChanges: FileChange[] = [];
      let handlerFailure: unknown;
      let indexingTail: Promise<void> = Promise.resolve();

      try {
        await indexer.index();
        expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "one.ts"));
        const initialSymbols = await indexer.getSymbolsForBranch();
        expect(initialSymbols.some((symbol) => symbol.name === "excludedSibling")).toBe(false);
        expect(initialSymbols.some((symbol) => (
          symbol.filePath === appConfigPath || symbol.filePath === baseConfigPath
        ))).toBe(false);

        watcher.start(async (changes) => {
          observedChanges.push(...changes);
          const indexing = indexingTail.then(() => indexer.index());
          indexingTail = indexing.catch((error: unknown) => {
            handlerFailure ??= error;
          });
          await indexing;
        });
        await watcher.waitUntilReady();
        expectRequestedBackend(watcher, backend);

        writeAliasConfig(baseConfigPath, "two", 1);
        await waitForAssertion(async () => {
          if (handlerFailure) throw handlerFailure;
          expect(observedChanges).toContainEqual({ path: baseConfigPath, type: "change" });
          await indexingTail;
          if (handlerFailure) throw handlerFailure;
          expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "two.ts"));
          await expect(indexer.getIndexFreshness()).resolves.toMatchObject({
            readable: true,
            current: true,
            reason: "current",
          });
        });

        expect(hasNativeFallbackWarning(warnSpy)).toBe(false);
      } finally {
        await watcher.stop();
        await indexingTail;
        await indexer.close();
      }
    },
  );

  it.each(["chokidar", "native"] as const)(
    "tracks config dependencies when an exact-file importer is created after %s is ready",
    async (backend: ConcreteWatcherBackend) => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-created-importer-"));
      cleanupPaths.add(fixtureRoot);
      const projectRoot = path.join(fixtureRoot, "project");
      const indexPath = path.join(fixtureRoot, "index");
      const importerPath = path.join(projectRoot, "vendor", "app", "src", "main.ts");
      const appConfigPath = path.join(projectRoot, "vendor", "app", "tsconfig.json");
      const baseConfigPath = path.join(projectRoot, "vendor", "shared", "base.json");
      const onePath = path.join(projectRoot, "src", "one.ts");
      const twoPath = path.join(projectRoot, "src", "two.ts");
      fs.mkdirSync(path.dirname(importerPath), { recursive: true });
      fs.mkdirSync(path.dirname(baseConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(onePath), { recursive: true });
      fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../shared/base" }));
      writeAliasConfig(baseConfigPath, "one");
      fs.writeFileSync(onePath, "export function target() { return 1; }\n");
      fs.writeFileSync(twoPath, "export function target() { return 2; }\n");

      const config = parseConfig({
        include: ["**/*.ts"],
        indexing: {
          mode: "structural",
          autoGc: false,
          requireProjectMarker: false,
          includeExcluded: ["vendor/app/src/main.ts"],
        },
      });
      const indexer = new Indexer(projectRoot, config, "jcode", { indexPath });
      const watcher = new FileWatcher(projectRoot, config, "jcode", { backend, indexPath });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const observedChanges: FileChange[] = [];
      let handlerFailure: unknown;
      let indexingTail: Promise<void> = Promise.resolve();

      try {
        await indexer.index();
        expect((await indexer.getSymbolsForBranch()).some((symbol) => symbol.name === "selectedCaller")).toBe(false);

        watcher.start(async (changes) => {
          observedChanges.push(...changes);
          const indexing = indexingTail.then(() => indexer.index());
          indexingTail = indexing.catch((error: unknown) => {
            handlerFailure ??= error;
          });
          await indexing;
        });
        await watcher.waitUntilReady();
        expectRequestedBackend(watcher, backend);

        await writeUntilObserved(
          (attempt) => fs.writeFileSync(
            importerPath,
            `import { target } from "@target";\nexport const importerRevision = ${attempt};\nexport function selectedCaller() { return target(); }\n`,
          ),
          async () => {
            if (handlerFailure) throw handlerFailure;
            expect(observedChanges.some((change) => (
              change.path === importerPath && (change.type === "add" || change.type === "change")
            ))).toBe(true);
            await indexingTail;
            if (handlerFailure) throw handlerFailure;
            expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "one.ts"));
          },
        );

        observedChanges.length = 0;
        writeAliasConfig(baseConfigPath, "two", 2);
        await waitForAssertion(async () => {
          if (handlerFailure) throw handlerFailure;
          expect(observedChanges.some((change) => (
            change.path === baseConfigPath && (change.type === "add" || change.type === "change")
          ))).toBe(true);
          await indexingTail;
          if (handlerFailure) throw handlerFailure;
          expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "two.ts"));
          await expect(indexer.getIndexFreshness()).resolves.toMatchObject({ current: true, reason: "current" });
        });

        expect(hasNativeFallbackWarning(warnSpy)).toBe(false);
      } finally {
        await watcher.stop();
        await indexingTail;
        await indexer.close();
      }
    },
  );

  it("refreshes native dependency registrations after injected directory-scope config invalidations", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-native-directory-config-"));
    cleanupPaths.add(fixtureRoot);
    const projectRoot = path.join(fixtureRoot, "project");
    const indexPath = path.join(fixtureRoot, "index");
    const importerPath = path.join(projectRoot, "vendor", "app", "src", "main.ts");
    const appConfigPath = path.join(projectRoot, "vendor", "app", "tsconfig.json");
    const sharedConfigPath = path.join(projectRoot, "vendor", "shared", "base.json");
    const otherConfigPath = path.join(projectRoot, "vendor", "other", "base.json");
    const onePath = path.join(projectRoot, "src", "one.ts");
    const twoPath = path.join(projectRoot, "src", "two.ts");
    fs.mkdirSync(path.dirname(importerPath), { recursive: true });
    fs.mkdirSync(path.dirname(sharedConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(otherConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(onePath), { recursive: true });
    fs.writeFileSync(
      importerPath,
      'import { target } from "@target";\nexport function selectedCaller() { return target(); }\n',
    );
    fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../shared/base" }));
    writeAliasConfig(sharedConfigPath, "one");
    writeAliasConfig(otherConfigPath, "two");
    fs.writeFileSync(onePath, "export function target() { return 1; }\n");
    fs.writeFileSync(twoPath, "export function target() { return 2; }\n");

    const config = parseConfig({
      include: ["**/*.ts"],
      indexing: {
        mode: "structural",
        autoGc: false,
        requireProjectMarker: false,
        includeExcluded: ["vendor/app/src/main.ts"],
      },
    });
    const indexer = new Indexer(projectRoot, config, "jcode", { indexPath });
    const watcher = new FileWatcher(projectRoot, config, "jcode", { backend: "native", indexPath });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const observedChanges: FileChange[] = [];
    let handlerFailure: unknown;
    let indexingTail: Promise<void> = Promise.resolve();

    try {
      await indexer.index();
      expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "one.ts"));

      watcher.start(async (changes) => {
        observedChanges.push(...changes);
        const indexing = indexingTail.then(() => indexer.index());
        indexingTail = indexing.catch((error: unknown) => {
          handlerFailure ??= error;
        });
        await indexing;
      });
      await watcher.waitUntilReady();
      expectRequestedBackend(watcher, "native");

      const internals = watcher as unknown as {
        nativeSetupGeneration: number;
        nativeWatcher: { stop(): Promise<void> } | null;
        scheduleNativeReconciliation(generation: number, filePath: string | null): void;
      };
      await internals.nativeWatcher?.stop();
      const injectDirectoryInvalidation = (directoryPath: string): void => {
        // Model a coalesced directory-scope fs.watch callback without claiming the host emitted this shape.
        internals.scheduleNativeReconciliation(internals.nativeSetupGeneration, directoryPath);
      };

      fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../other/base", revision: 1 }));
      injectDirectoryInvalidation(path.dirname(appConfigPath));
      await waitForAssertion(async () => {
        if (handlerFailure) throw handlerFailure;
        expect(observedChanges).toContainEqual({ path: appConfigPath, type: "change" });
        await indexingTail;
        if (handlerFailure) throw handlerFailure;
        expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "two.ts"));
      });

      observedChanges.length = 0;
      writeAliasConfig(otherConfigPath, "one", 22);
      injectDirectoryInvalidation(path.dirname(otherConfigPath));
      await waitForAssertion(async () => {
        if (handlerFailure) throw handlerFailure;
        expect(observedChanges.some((change) => (
          change.path === otherConfigPath && (change.type === "add" || change.type === "change")
        ))).toBe(true);
        await indexingTail;
        if (handlerFailure) throw handlerFailure;
        expect(await resolvedTargetPath(indexer, projectRoot)).toBe(path.join("src", "one.ts"));
        await expect(indexer.getIndexFreshness()).resolves.toMatchObject({ current: true, reason: "current" });
      });

      expect(hasNativeFallbackWarning(warnSpy)).toBe(false);
    } finally {
      await watcher.stop();
      await indexingTail;
      await indexer.close();
    }
  });

  it.each(["chokidar", "native"] as const)(
    "updates registrations for retargeted and missing extends dependencies with %s",
    async (backend: ConcreteWatcherBackend) => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-selected-config-lifecycle-"));
      cleanupPaths.add(projectRoot);
      const importerPath = path.join(projectRoot, "vendor", "app", "src", "main.ts");
      const appConfigPath = path.join(projectRoot, "vendor", "app", "tsconfig.json");
      const sharedConfigPath = path.join(projectRoot, "vendor", "shared", "base.json");
      const otherConfigPath = path.join(projectRoot, "vendor", "other", "base.json");
      const futureConfigPath = path.join(projectRoot, "vendor", "future", "base.json");
      fs.mkdirSync(path.dirname(importerPath), { recursive: true });
      fs.mkdirSync(path.dirname(sharedConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(otherConfigPath), { recursive: true });
      fs.writeFileSync(importerPath, "export const selected = true;\n");
      fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../shared/base" }));
      fs.writeFileSync(sharedConfigPath, "{}");
      fs.writeFileSync(otherConfigPath, JSON.stringify({ compilerOptions: { baseUrl: "../.." } }));

      const config = parseConfig({
        include: ["**/*.ts"],
        indexing: {
          requireProjectMarker: false,
          includeExcluded: ["vendor/app/src/main.ts"],
        },
      });
      const watcher = new FileWatcher(projectRoot, config, "jcode", { backend });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const changes: FileChange[] = [];

      try {
        watcher.start(async (batch) => {
          changes.push(...batch);
        });
        await watcher.waitUntilReady();
        expectRequestedBackend(watcher, backend);

        fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../other/base", revision: 1 }));
        await waitForChange(changes, appConfigPath, "change");

        changes.length = 0;
        fs.writeFileSync(otherConfigPath, JSON.stringify({ compilerOptions: { baseUrl: "../.." }, revision: 2 }));
        await waitForChange(changes, otherConfigPath, ["add", "change"]);

        changes.length = 0;
        fs.writeFileSync(appConfigPath, JSON.stringify({ extends: "../future/base", revision: 3 }));
        await waitForChange(changes, appConfigPath, "change");

        changes.length = 0;
        fs.mkdirSync(path.dirname(futureConfigPath), { recursive: true });
        fs.writeFileSync(futureConfigPath, "{");
        await waitForChange(changes, futureConfigPath, "add");

        changes.length = 0;
        fs.writeFileSync(futureConfigPath, JSON.stringify({ compilerOptions: { baseUrl: "../.." }, revision: 4 }));
        await waitForChange(changes, futureConfigPath, "change");

        changes.length = 0;
        fs.rmSync(futureConfigPath);
        await waitForChange(changes, futureConfigPath, "unlink");

        expect(hasNativeFallbackWarning(warnSpy)).toBe(false);
      } finally {
        await watcher.stop();
      }
    },
  );
});
