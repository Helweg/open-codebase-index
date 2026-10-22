import * as path from "node:path";
import { parseHostMode } from "./config/host.js";
import type { HostMode } from "./config/host.js";
import { resolveDefaultProjectRoot } from "./git/index.js";
import { HistoryError } from "./history/config.js";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "./tools/history-operations.js";
import type { SharedRepositoryHistorySearchArgs } from "./tools/contracts.js";
import type { RepositoryHistoryStatusResult } from "./history/types.js";
import type { HistoryCliOutput } from "./adapters/history-cli.js";

/** Actual command execution is isolated from dependency-free root/history help. */
export async function runHistoryCommand(argv: string[], cwd: string, output: HistoryCliOutput = {}): Promise<number> {
  const stdout = output.printStdout ?? console.log;
  const stderr = output.printStderr ?? console.error;
  try {
    const command = argv[0];
    if (!["sync", "search", "status", "clear"].includes(command)) throw new HistoryError("HISTORY_ARGS", "expected sync, search, status, or clear");
    let project: string | undefined;
    let host: HostMode = "opencode";
    let repository: string | undefined;
    let since: string | undefined;
    const search: Partial<SharedRepositoryHistorySearchArgs> = {};
    const positionals: string[] = [];
    for (let index = 1; index < argv.length; index++) {
      const argument = argv[index];
      if (argument === "--json") continue;
      if (!argument.startsWith("--")) { positionals.push(argument); continue; }
      const [option, inline] = argument.split(/=(.*)/s, 2);
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) throw new HistoryError("HISTORY_ARGS", `${option} requires a value`);
      switch (option) {
        case "--project": project = path.resolve(cwd, value); break;
        case "--host": host = parseHostMode(value); break;
        case "--repository": repository = value; break;
        case "--since": if (command !== "sync") throw new HistoryError("HISTORY_ARGS", "--since only applies to sync"); since = value; break;
        case "--kind": search.kind = value as SharedRepositoryHistorySearchArgs["kind"]; break;
        case "--state": search.state = value as SharedRepositoryHistorySearchArgs["state"]; break;
        case "--author": search.author = value; break;
        case "--limit": search.limit = Number(value); break;
        default: throw new HistoryError("HISTORY_ARGS", `unknown history option ${option}`);
      }
    }
    const root = project ?? resolveDefaultProjectRoot(cwd);
    if (command !== "search" && (positionals.length || Object.keys(search).length)) throw new HistoryError("HISTORY_ARGS", "query/filter options only apply to search");
    let result: RepositoryHistoryStatusResult;
    if (command === "sync") result = await runRepositoryHistorySync({ repository, since }, root, host);
    else if (command === "search") result = await runRepositoryHistorySearch({ ...search, repository, query: positionals.join(" ") }, root, host);
    else if (command === "clear") result = await runRepositoryHistoryClear({ repository }, root, host);
    else result = await runRepositoryHistoryStatus({ repository }, root, host);
    stdout(JSON.stringify(result, null, 2));
    return command === "sync" && !result.enabled ? 1 : 0;
  } catch (error) {
    stderr(error instanceof HistoryError ? error.message : "HISTORY_ERROR: invalid configuration or local history operation failed");
    return 1;
  }
}
