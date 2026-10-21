#!/usr/bin/env node
export type { CliArgs } from "./adapters/mcp/cli-options.js";
export { isCliEntrypoint, loadCliRawConfig, parseArgs } from "./adapters/mcp/cli-options.js";
import { pathToFileURL } from "node:url";
import { isCliEntrypoint, parseArgs } from "./adapters/mcp/cli-options.js";
import { runIdleSupervisor } from "./adapters/mcp/idle-supervisor.js";

const moduleUrl = import.meta.url ?? pathToFileURL(__filename).href;
if (isCliEntrypoint(moduleUrl, process.argv[1])) {
  void (async () => {
    const command = process.argv[2];
    const isCommand = ["index", "eval", "visualize"].includes(command);
    if (!isCommand && (process.argv.includes("--help", 2) || process.argv.includes("-h", 2))) {
      console.log(`Usage:
  open-codebase-index-mcp [options]
  opencode-codebase-index-mcp [options]
  open-codebase-index-mcp <command> [options]

Start an MCP server over stdio when no command is given.

Options:
  --project <path>          Project root (default: containing Git checkout or cwd)
  --config <path>           Explicit JSON configuration file
  --host <mode>             opencode, codex, claude, pi, or jcode (default: opencode)
  --mcp-idle-timeout <secs>  Idle engine timeout; 0 disables (default: 900 for codex, 0 otherwise)
  --help, -h                Show this help and exit

Commands:
  index                    Index the project or estimate indexing cost
  eval                     Run or compare retrieval evaluations
  visualize                Export an interactive call-graph visualization

Use 'index --help' or 'eval --help' for command-specific usage.

Example:
  open-codebase-index-mcp --host codex --project /path/to/repo`);
      return;
    }
    const args = isCommand ? undefined : parseArgs(process.argv);
    const timeout = args?.mcpIdleTimeout ?? (args?.host === "codex" ? 900 : 0);
    // Both packaged CLI formats use the ESM engine, whose metadata uses import.meta.url.
    const workerExtension = moduleUrl.endsWith(".ts") ? "ts" : "js";
    const workerUrl = new URL(`./mcp-worker.${workerExtension}`, moduleUrl);
    if (!isCommand && timeout > 0) {
      await runIdleSupervisor(workerUrl, process.argv.slice(2), timeout * 1000);
    } else {
      const worker = await import(workerUrl.href) as typeof import("./mcp-worker.js");
      await worker.runMcpCli(process.argv);
    }
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Failed to start MCP server.");
    process.exitCode = 1;
  });
}
