import type { ParsedFile } from "../native/index.js";
import type { OperationControl } from "../utils/operation-control.js";
import type { LocalModuleData, LocalWorkspacePackage } from "../indexer/local-module-resolution.js";
import {
  LocalModuleCallResolver,
  TsConfigPathAliasCache,
  getLocalWorkspacePackages,
} from "../indexer/local-module-resolution.js";
import { parseFiles } from "../native/index.js";
import { throwIfOperationAborted } from "../utils/operation-control.js";

export const TEST_DISCOVERY_MAX_MODULE_FILES = 64;
export const TEST_DISCOVERY_MAX_CONFIG_FILES = 48;

export function testModuleData(filePath: string, content: string, parsed: ParsedFile): LocalModuleData {
  return {
    content,
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

class ConfigurationUncertainError extends Error {}

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
  let loadingRounds = 0;
  const requestConfiguration = (filePath: string): string | undefined => {
    requested.add(filePath);
    return configurations.get(filePath);
  };
  const loadImporters = async (filePaths: string[]): Promise<void> => {
    while (true) {
      getLocalWorkspacePackages(filePaths, requestConfiguration);
      new TsConfigPathAliasCache(requestConfiguration).getConfigState(filePaths);
      const missing = [...requested].filter((filePath) =>
        !configurations.has(filePath) && !unknownConfigurations.has(filePath));
      if (missing.length === 0) return;
      const capacity = TEST_DISCOVERY_MAX_CONFIG_FILES - configurations.size - unknownConfigurations.size;
      if (capacity <= 0 || loadingRounds >= 4) { markCapped(); return; }
      if (missing.length > capacity) markCapped();
      loadingRounds += 1;
      for (const filePath of missing.slice(0, capacity)) {
        throwIfOperationAborted(control?.signal);
        const state = await readConfiguration(filePath);
        if (state.content !== undefined || state.confirmedAbsent) {
          configurations.set(filePath, state.content);
        } else {
          unknownConfigurations.add(filePath);
          markCapped();
        }
      }
    }
  };
  await loadImporters(configurationImporters);
  const cachedConfiguration = (filePath: string): string | undefined => {
    if (!configurations.has(filePath)) throw new ConfigurationUncertainError(filePath);
    return configurations.get(filePath);
  };
  const aliases = new TsConfigPathAliasCache(cachedConfiguration);
  let workspacePackages: readonly LocalWorkspacePackage[];
  try {
    workspacePackages = getLocalWorkspacePackages(configurationImporters, cachedConfiguration);
  } catch (error: unknown) {
    if (!(error instanceof ConfigurationUncertainError)) throw error;
    markCapped();
    workspacePackages = [];
  }
  let moduleReads = 0;
  const moduleResolver = new LocalModuleCallResolver({
    filePaths: inventory,
    workspacePackages,
    pathAliasesForImporter: (filePath) => aliases.getPathAliasesForImporter(filePath),
    loadModule: async (filePath) => {
      throwIfOperationAborted(control?.signal);
      if (moduleReads >= TEST_DISCOVERY_MAX_MODULE_FILES) { markCapped(); return undefined; }
      moduleReads += 1;
      const content = await readFile(filePath);
      if (content === undefined) return undefined;
      await loadImporters([filePath]);
      const [parsed] = parseFiles([{ path: filePath, content }]);
      throwIfOperationAborted(control?.signal);
      if (!parsed || parsed.parseFailed) return undefined;
      await control?.heartbeat?.();
      return testModuleData(filePath, content, parsed);
    },
  });
  return {
    moduleResolver,
    loadImporters,
    resolveCallTarget: async (filePath, content, call) => {
      try {
        return await moduleResolver.resolveCallTarget(filePath, content, call);
      } catch (error: unknown) {
        if (!(error instanceof ConfigurationUncertainError)) throw error;
        markCapped();
        return undefined;
      }
    },
  };
}
