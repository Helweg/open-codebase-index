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
