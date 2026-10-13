import type { ParsedFile } from "../native/index.js";
import type { OperationControl } from "../utils/operation-control.js";
import type { LocalModuleData } from "../indexer/local-module-resolution.js";
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

/** Reuses indexing's resolver; only configured ancestors and demanded indexed imports are read. */
export async function createTestBindingResolver(
  inventory: string[],
  configurationImporters: string[],
  readFile: (filePath: string) => Promise<string | undefined>,
  markCapped: () => void,
  control?: OperationControl,
): Promise<LocalModuleCallResolver> {
  const configurations = new Map<string, string | undefined>();
  const requested = new Set<string>();
  const loadConfiguration = (filePath: string): string | undefined => {
    requested.add(filePath);
    return configurations.get(filePath);
  };
  // Existing helpers are synchronous. Bounded demand-loading rounds cover local extends chains.
  for (let round = 0; round < 4; round += 1) {
    getLocalWorkspacePackages(configurationImporters, loadConfiguration);
    new TsConfigPathAliasCache(loadConfiguration).getConfigState(configurationImporters);
    const missing = [...requested].filter((filePath) => !configurations.has(filePath))
      .map((filePath) => ({ filePath, depth: filePath.split("/").length }))
      .sort((left, right) => left.depth - right.depth || left.filePath.localeCompare(right.filePath))
      .map(({ filePath }) => filePath);
    if (missing.length === 0) break;
    const capacity = TEST_DISCOVERY_MAX_CONFIG_FILES - configurations.size;
    if (missing.length > capacity) markCapped();
    // Reserve later rounds for newly discovered local extends, rather than exhausting reads on missing deep ancestors.
    for (const filePath of missing.slice(0, Math.min(capacity, 12))) {
      throwIfOperationAborted(control?.signal);
      configurations.set(filePath, await readFile(filePath));
    }
    if (round === 3) markCapped();
  }
  const cachedConfiguration = (filePath: string): string | undefined => configurations.get(filePath);
  const aliases = new TsConfigPathAliasCache(cachedConfiguration);
  let moduleReads = 0;
  return new LocalModuleCallResolver({
    filePaths: inventory,
    workspacePackages: getLocalWorkspacePackages(configurationImporters, cachedConfiguration),
    pathAliasesForImporter: (filePath) => aliases.getPathAliasesForImporter(filePath),
    loadModule: async (filePath) => {
      throwIfOperationAborted(control?.signal);
      if (moduleReads >= TEST_DISCOVERY_MAX_MODULE_FILES) { markCapped(); return undefined; }
      moduleReads += 1;
      const content = await readFile(filePath);
      if (content === undefined) return undefined;
      const [parsed] = parseFiles([{ path: filePath, content }]);
      throwIfOperationAborted(control?.signal);
      if (!parsed || parsed.parseFailed) return undefined;
      await control?.heartbeat?.();
      return testModuleData(filePath, content, parsed);
    },
  });
}
