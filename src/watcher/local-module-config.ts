import * as path from "node:path";

import { createIgnoreFilter } from "../utils/files.js";
import { hasFilteredPathSegment, isRestrictedDirectory } from "../utils/paths.js";

const LOCAL_MODULE_CONFIG_NAMES = new Set(["tsconfig.json", "jsconfig.json"]);
type IgnoreFilter = ReturnType<typeof createIgnoreFilter>;

/**
 * Whether a config file can affect local JavaScript/TypeScript module resolution.
 *
 * These files are tracked by watchers only. They remain outside the normal source
 * file include patterns and are not added to the index as source documents.
 */
export function shouldTrackLocalModuleConfigPath(
  filePath: string,
  projectRoot: string,
  ignoreFilter: IgnoreFilter = createIgnoreFilter(projectRoot),
): boolean {
  const relativePath = path.relative(projectRoot, filePath);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
    || !LOCAL_MODULE_CONFIG_NAMES.has(path.basename(filePath).toLowerCase())
  ) {
    return false;
  }

  if (hasFilteredPathSegment(relativePath, path.sep) || isRestrictedDirectory(relativePath, path.sep)) {
    return false;
  }

  return !ignoreFilter.ignores(relativePath);
}
