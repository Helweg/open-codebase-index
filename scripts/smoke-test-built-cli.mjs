import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);

function runCliCommand(args, { killAfterMs = null, action = null, actionDelayMs = 1_000 } = {}) {
  return new Promise((resolve, reject) => {
    const command = [cliPath, ...args];
    const child = spawn(process.execPath, command, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", reject);

    const cleanupTimer = killAfterMs
      ? setTimeout(() => {
        child.kill("SIGKILL");
      }, killAfterMs)
      : null;

    const actionTimer = action
      ? setTimeout(() => {
        action(child);
      }, actionDelayMs)
      : null;

    child.once("exit", (code, signal) => {
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer);
      }
      if (actionTimer !== null) {
        clearTimeout(actionTimer);
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const cliPath = process.argv[2] ?? "dist/cli.js";
const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-smoke-"));
try {
  const configPath = path.join(tempDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ indexing: { autoIndex: false, watchFiles: true, requireProjectMarker: false } }),
  );
  const projectArgs = ["--host", "jcode", "--project", tempDir, "--config", configPath];

  const mcpStartup = await runCliCommand(projectArgs, { killAfterMs: 2_000 });
  if (mcpStartup.signal === null && mcpStartup.code !== 0) {
    throw new Error(`Built ESM CLI failed in MCP startup mode with exit code ${mcpStartup.code}:\n${mcpStartup.stderr}`);
  }

  const indexHelp = await runCliCommand(["index", "--help"]);
  if (indexHelp.code !== 0 || !indexHelp.stderr.includes("Usage:")) {
    throw new Error(`Built ESM CLI failed in index mode:\n${indexHelp.stderr}`);
  }

  const cjsModule = require("../dist/index.cjs");
  if (typeof cjsModule.default !== "function") {
    throw new Error("Built CommonJS entry point is missing its default plugin export");
  }

  const shutdownScenarios = [
    { name: "stdin EOF", action: (child) => { child.stdin.end(); } },
  ];
  if (process.platform !== "win32") {
    shutdownScenarios.push(
      { name: "SIGINT", action: (child) => { child.kill("SIGINT"); } },
      { name: "SIGTERM", action: (child) => { child.kill("SIGTERM"); } },
      { name: "SIGHUP", action: (child) => { child.kill("SIGHUP"); } },
    );
  }
  for (const scenario of shutdownScenarios) {
    const result = await runCliCommand(projectArgs, { killAfterMs: 5_000, action: scenario.action });
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(
        `Built ESM CLI did not shut down cleanly on ${scenario.name} (code=${result.code}, signal=${result.signal}):\n${result.stderr}`,
      );
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
