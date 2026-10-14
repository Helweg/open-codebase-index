import type { ParsedFile } from "../native/index.js";
import type { OperationControl } from "../utils/operation-control.js";
import type { LocalModuleData, LocalWorkspacePackage } from "../indexer/local-module-resolution.js";

import * as path from "node:path";

import {
  LocalModuleCallResolver,
  TsConfigPathAliasCache,
  declaredPackageFormat,
  getLocalWorkspacePackages,
} from "../indexer/local-module-resolution.js";
import { parseFiles } from "../native/index.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";

export const TEST_DISCOVERY_MAX_MODULE_FILES = 64;
export const TEST_DISCOVERY_MAX_CONFIG_FILES = 48;

export function testModuleData(filePath: string, content: string, parsed: ParsedFile): LocalModuleData {
  return {
    content,
    moduleSyntax: parsed.moduleSyntax,
    symbols: parsed.symbols.map((symbol) => ({
      ...symbol, filePath,
      id: `${filePath}:${symbol.kind}:${symbol.name}:${symbol.startLine}:${symbol.startCol}`,
    })),
  };
}

interface TestBindingResolver {
  moduleResolver: LocalModuleCallResolver;
  loadImporters(filePaths: string[]): Promise<void>;
  resolveCallTarget: LocalModuleCallResolver["resolveCallTarget"];
}

class ConfigurationUncertainError extends Error {
  constructor(filePath: string, readonly bounded = true) {
    super(filePath);
  }
}

/** Reuses indexing's resolver; uncertain nearer configuration fails linkage closed. */
export async function createTestBindingResolver(
  inventory: string[],
  configurationImporters: string[],
  readFile: (filePath: string) => Promise<string | undefined>,
  readConfiguration: (filePath: string) => Promise<{ content?: string; confirmedAbsent: boolean }>,
  markCapped: () => void,
  control?: OperationControl,
): Promise<TestBindingResolver> {
  const configurations = new Map<string, string | undefined>();
  const unknownConfigurations = new Set<string>();
  const requested = new Set<string>();
  const importers = new Set<string>();
  let loadingRounds = 0;
  let workspacePackages: readonly LocalWorkspacePackage[] = [];
  let packageKey: string | undefined;
  let packageGeneration = 0;
  const configurationReads = new Map<string, Promise<void>>();
  const loadConfiguration = async (filePath: string): Promise<void> => {
    if (configurations.has(filePath) || unknownConfigurations.has(filePath)) return;
    const pending = configurationReads.get(filePath);
    if (pending) return pending;
    if (configurations.size + unknownConfigurations.size + configurationReads.size >= TEST_DISCOVERY_MAX_CONFIG_FILES) {
      markCapped();
      return;
    }
    const loading = Promise.resolve().then(async () => {
      try {
        throwIfOperationAborted(control?.signal);
        const state = await readConfiguration(filePath);
        throwIfOperationAborted(control?.signal);
        if (state.content !== undefined || state.confirmedAbsent) {
          configurations.set(filePath, state.content);
        } else {
          unknownConfigurations.add(filePath);
          markCapped();
        }
      } finally {
        configurationReads.delete(filePath);
      }
    });
    configurationReads.set(filePath, loading);
    return loading;
  };
  const requestConfiguration = (filePath: string): string | undefined => {
    requested.add(filePath);
    return configurations.get(filePath);
  };
  const cachedConfiguration = (filePath: string): string | undefined => {
    if (!configurations.has(filePath)) throw new ConfigurationUncertainError(filePath);
    return configurations.get(filePath);
  };
  const refreshPackages = (): void => {
    try {
      workspacePackages = getLocalWorkspacePackages([...importers], cachedConfiguration);
    } catch (error: unknown) {
      if (!(error instanceof ConfigurationUncertainError)) throw error;
      markCapped();
      workspacePackages = [];
    }
    const nextKey = workspacePackages.map((item) => `${item.name}\0${item.rootPath}`).sort().join("\n");
    if (nextKey !== packageKey) {
      packageKey = nextKey;
      packageGeneration += 1;
      resolver.setWorkspacePackages(workspacePackages);
    }
  };
  const loadImporters = async (filePaths: string[]): Promise<void> => {
    let changed = false;
    for (const filePath of filePaths) {
      if (!importers.has(filePath)) {
        importers.add(filePath);
        changed = true;
      }
    }
    while (true) {
      getLocalWorkspacePackages(filePaths, requestConfiguration);
      new TsConfigPathAliasCache(requestConfiguration).getConfigState(filePaths);
      const missing = [...requested].filter((filePath) =>
        !configurations.has(filePath) && !unknownConfigurations.has(filePath));
      if (missing.length === 0) break;
      if (loadingRounds >= 4) { markCapped(); break; }
      loadingRounds += 1;
      changed = true;
      for (const filePath of missing) {
        await loadConfiguration(filePath);
      }
    }
    if (changed) refreshPackages();
  };
  const aliases = new TsConfigPathAliasCache(cachedConfiguration);
  let moduleReads = 0;
  const packageFormats = new Map<string, Promise<"module" | "commonjs" | "unknown">>();
  const moduleFormatForFile = async (filePath: string): Promise<"module" | "commonjs" | "unknown"> => {
    const cached = packageFormats.get(filePath);
    if (cached) return cached;
    const lookup = (async () => {
      let directory = path.posix.dirname(filePath.replace(/\\/gu, "/"));
      while (true) {
        throwIfOperationAborted(control?.signal);
        const manifest = directory === "." || directory === "" ? "package.json" : `${directory}/package.json`;
        await loadConfiguration(manifest);
        if (!configurations.has(manifest)) return "unknown" as const;
        const content = configurations.get(manifest);
        if (content !== undefined) return declaredPackageFormat(content);
        const parent = path.posix.dirname(directory);
        if (directory === "." || directory === "" || parent === directory) return "unknown" as const;
        directory = parent;
      }
    })();
    packageFormats.set(filePath, lookup);
    return lookup;
  };
  const resolver = new LocalModuleCallResolver({
    filePaths: inventory,
    moduleFormatForFile,
    workspacePackages,
    pathAliasesForImporter: (filePath) => {
      const state = aliases.getPathAliasStateForImporter(filePath);
      if (!state.resolved) throw new ConfigurationUncertainError(filePath, false);
      return state.aliases;
    },
    loadModule: async (filePath) => {
      throwIfOperationAborted(control?.signal);
      if (moduleReads >= TEST_DISCOVERY_MAX_MODULE_FILES) { markCapped(); return undefined; }
      moduleReads += 1;
      const content = await readFile(filePath);
      if (content === undefined) return undefined;
      await loadImporters([filePath]);
      const [parsed] = parseFiles([{ path: filePath, content }], undefined, undefined, false, true);
      throwIfOperationAborted(control?.signal);
      if (!parsed || parsed.parseFailed) return undefined;
      await control?.heartbeat?.();
      return testModuleData(filePath, content, parsed);
    },
  });
  await loadImporters(configurationImporters);
  return {
    moduleResolver: resolver,
    loadImporters,
    resolveCallTarget: async (filePath, content, call) => {
      const generation = packageGeneration;
      try {
        const result = await resolver.resolveCallTarget(filePath, content, call);
        return generation === packageGeneration ? result : undefined;
      } catch (error: unknown) {
        if (!(error instanceof ConfigurationUncertainError)) throw error;
        if (error.bounded) markCapped();
        return undefined;
      }
    },
  };
}
