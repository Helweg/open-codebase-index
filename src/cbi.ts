#!/usr/bin/env node

export { isCbiEntrypoint, runCbiCli } from "./adapters/cbi.js";

import { isCbiEntrypoint, runCbiCli } from "./adapters/cbi.js";

function handleCbiMainError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Invalid host mode")) {
    console.error(message);
    process.exit(1);
  }

  console.error("Failed to start CBI CLI. Check your command and configuration.");
  if (message) {
    console.error(message);
  }
  process.exit(1);
}

if (isCbiEntrypoint(import.meta.url, process.argv[1])) {
  runCbiCli(process.argv, process.cwd()).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(handleCbiMainError);
}
