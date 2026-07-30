import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function runCliCommand(args, { killAfterMs = null } = {}) {
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
        child.kill("SIGTERM");
      }, killAfterMs)
      : null;

    child.once("exit", (code, signal) => {
      if (cleanupTimer !== null) {
        clearTimeout(cleanupTimer);
      }
      resolve({ code, signal, stdout, stderr, survived: signal === "SIGTERM" });
    });
  });
}

const cliPath = process.argv[2] ?? "dist/cli.js";

const mcpStartup = await runCliCommand(["--host", "jcode"], { killAfterMs: 2_000 });
if (!mcpStartup.survived && mcpStartup.code !== 0) {
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
