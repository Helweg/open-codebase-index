import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { HistoryError } from "./config.js";

/** History opt-in/cache never follows host-directory symlinks into global or unrelated storage. */
export function assertHistoryProjectPath(projectRoot: string, target: string): void {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new HistoryError("HISTORY_STORAGE", "history path escapes the explicit project");
  let current: string;
  try { current = realpathSync.native(root); }
  catch { throw new HistoryError("HISTORY_STORAGE", "history project root must exist"); }
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new HistoryError("HISTORY_STORAGE", "history configuration/storage must not follow project-relative symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (error instanceof HistoryError) throw error;
      throw new HistoryError("HISTORY_STORAGE", "cannot inspect project-local history path");
    }
  }
}
