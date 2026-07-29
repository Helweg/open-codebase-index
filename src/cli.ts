#!/usr/bin/env node

export type { CliArgs } from "./adapters/mcp/cli.js";
export { isCliEntrypoint, loadCliRawConfig, parseArgs } from "./adapters/mcp/cli.js";

import { handleMainError, isCliEntrypoint, runMcpCli } from "./adapters/mcp/cli.js";

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  runMcpCli(process.argv).catch(handleMainError);
}
