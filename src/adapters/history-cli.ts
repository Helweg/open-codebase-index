import * as path from "node:path";
import { parseHostMode } from "../config/host.js";
import type { HostMode } from "../config/host.js";
import { resolveDefaultProjectRoot } from "../git/index.js";
import { HistoryError } from "../history/config.js";
import { runRepositoryHistoryClear, runRepositoryHistorySearch, runRepositoryHistoryStatus, runRepositoryHistorySync } from "../tools/history-operations.js";
import type { SharedRepositoryHistorySearchArgs } from "../tools/contracts.js";
import type { RepositoryHistoryStatusResult } from "../history/types.js";

export interface HistoryCliOutput {
  printStdout?: (text: string) => void;
  printStderr?: (text: string) => void;
}

export async function runHistoryCli(argv: string[], cwd: string, output: HistoryCliOutput = {}): Promise<number> {
  const stdout = output.printStdout ?? console.log;
  const stderr = output.printStderr ?? console.error;
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    stdout(`Usage: ocbi history <sync|search|status|clear> [query] [options]

Local-only, untrusted GitHub.com history evidence. Current code is authoritative.
Enable sources explicitly in this project's host config:
  repositoryHistory.repositories: [{repository: "owner/repo", enabled: true, initialSince: "2026-10-01"}]

Options:
  --project <path>       Project root (default: containing Git checkout or cwd)
  --host <mode>          opencode, codex, claude, pi, jcode (default: opencode)
  --repository <owner/repo>  Select one configured GitHub.com source
  --since <ISO date>     Initial created-at window for sync; omitted means all history
  --kind <issue|pull_request>  Search filter
  --state <open|closed|merged|draft>  Search filter
  --author <login>       Search discussion author
  --limit <1-100>        Search result limit (default: 10)
  --json                JSON output (also the default)

Sync is manual and read-only. Every cycle fully reconciles discovery/discussions;
quota/transport failures resume private staged fetches on the next manual sync.
Status and clear need no embedding provider or native runtime. Clear also works
with a disabled source when --repository is supplied. No code index is changed.`);
    return 0;
  }
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
