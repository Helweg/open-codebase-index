import { pathToFileURL } from "node:url";
import type * as HistoryCommandWorker from "../history-cli-worker.js";

export interface HistoryCliOutput {
  printStdout?: (text: string) => void;
  printStderr?: (text: string) => void;
}

export async function runHistoryCli(argv: string[], cwd: string, output: HistoryCliOutput = {}): Promise<number> {
  const stdout = output.printStdout ?? console.log;
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    stdout(`Usage: ocbi history <sync|search|status|clear> [query] [options]

Local-only, untrusted GitHub.com history evidence. Current code is authoritative.
Enable sources explicitly in this project's host config:
  repositoryHistory.repositories: [{repository: "owner/repo", enabled: true, initialSince: "2026-10-01"}]

Options:
  --project <path>       Project root (default: containing Git checkout or cwd)
  --host <mode>          opencode, codex, claude, pi, jcode (default: opencode)
  --repository <owner/repo>  Select one configured GitHub.com source
  --since <ISO date>     Initial override; later syncs retain the stored window
  --kind <issue|pull_request>  Search filter
  --state <open|closed|merged|draft>  Search filter
  --author <login>       Search discussion author
  --limit <1-100>        Maximum distinct entities (default: 10)
  --json                JSON output (also the default)

Sync is manual and read-only. Every cycle fully reconciles discovery/discussions;
quota/transport failures resume private staged fetches on the next manual sync.
Status and clear need no embedding provider or native runtime. Clear also works
with a disabled source when --repository is supplied. No code index is changed.`);
    return 0;
  }
  const moduleUrl = import.meta.url ?? pathToFileURL(__filename).href;
  const workerPath = moduleUrl.endsWith(".ts") ? "../history-cli-worker.ts" : "./history-cli-worker.js";
  const worker = await import(new URL(workerPath, moduleUrl).href) as typeof HistoryCommandWorker;
  return worker.runHistoryCommand(argv, cwd, output);
}
