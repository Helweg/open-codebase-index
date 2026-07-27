/* global process, console */
import * as path from "node:path";

import plugin from "../dist/index.js";

const projectRoot = process.argv[2];
const scenario = process.argv[3];

if (!projectRoot) {
  console.error("Missing projectRoot argument for startup regression harness.");
  process.exit(1);
}

if (scenario !== "empty" && scenario !== "runtime-state-only" && scenario !== "package-marked") {
  console.error(`Invalid scenario argument: ${scenario}`);
  process.exit(2);
}

try {
  const worktree = path.parse(projectRoot).root;
  const runtime = await plugin({ directory: projectRoot, worktree });
  if (!runtime || typeof runtime !== "object") {
    throw new Error("Plugin returned an invalid runtime object");
  }

  process.stdout.write("PLUGIN_STARTUP_READY\n");
  process.exit(0);
} catch {
  console.error("Failed to initialize plugin.");
  process.exit(1);
}
