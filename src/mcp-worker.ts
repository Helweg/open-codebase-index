#!/usr/bin/env node
export { runMcpCli, handleMainError } from "./adapters/mcp/cli.js";
import { runMcpCli, handleMainError } from "./adapters/mcp/cli.js";
import { isCliEntrypoint } from "./adapters/mcp/cli-options.js";
import { pathToFileURL } from "node:url";
const moduleUrl = import.meta.url ?? pathToFileURL(__filename).href;
if (isCliEntrypoint(moduleUrl, process.argv[1])) {
  runMcpCli(process.argv).catch(handleMainError);
}
