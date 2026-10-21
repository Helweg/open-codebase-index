import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);

function runCliCommand(args, {
  killAfterMs = null,
  action = null,
  actionDelayMs = 1_000,
  actionAfterStdout = null,
  stdinText = null,
  cliPathOverride = null,
  cwd = process.cwd(),
} = {}) {
  return new Promise((resolve, reject) => {
    const commandPath = cliPathOverride ?? cliPath;
    const command = [commandPath, ...args];
    const child = spawn(process.execPath, command, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let actionPerformed = false;
    const performAction = () => {
      if (actionPerformed || !action) return;
      actionPerformed = true;
      action(child);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (actionAfterStdout && stdout.includes(actionAfterStdout)) performAction();
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

    const actionTimer = action && !actionAfterStdout
      ? setTimeout(() => {
        performAction();
      }, actionDelayMs)
      : null;

    if (stdinText !== null) child.stdin.write(stdinText);

    child.once("close", (code, signal) => {
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

function withTimeout(promise, timeoutMs, description) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs} ms`)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function runMcpHandshake(args, { commandPath = cliPath, resume = false, cwd = process.cwd() } = {}) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [commandPath, ...args, ...(resume ? ["--mcp-idle-timeout", "1"] : [])],
    cwd,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "built-cli-smoke", version: "1.0.0" });
  try {
    await withTimeout(client.connect(transport), 5_000, "MCP initialize");
    const listed = await withTimeout(client.listTools(), 5_000, "MCP tools/list");
    for (const name of ["index_status", "codebase_context"]) {
      if (!listed.tools.some((tool) => tool.name === name)) throw new Error(`MCP tools/list missing ${name}`);
    }
    if (resume) {
      const first = await withTimeout(client.callTool({ name: "index_status", arguments: {} }), 5_000, "MCP status");
      if (first.isError) throw new Error("MCP status failed before idle shutdown.");
      await withTimeout((async () => {
        const deadline = Date.now() + 4500;
        while (!stderr.join("").includes("MCP engine sleeping")) {
          if (Date.now() > deadline) throw new Error("MCP engine did not become idle.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(), 5_000, "MCP idle shutdown");
      const next = await withTimeout(client.callTool({ name: "index_status", arguments: {} }), 5_000, "MCP resumed status");
      if (next.isError || !stderr.join("").includes("MCP engine resuming")) {
        throw new Error("MCP engine did not resume in the same connection.");
      }
    }
    await withTimeout(client.close(), 5_000, "MCP shutdown");
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`Built Codex MCP handshake failed (${commandPath}):\n${stderr.join("")}`, { cause: error });
  }
}

const cliPath = process.argv[2] ?? "dist/cli.js";
const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-smoke-"));
try {
  const configPath = path.join(tempDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://127.0.0.1:9/v1", model: "smoke-test", dimensions: 8 },
      indexing: { autoIndex: false, watchFiles: true, requireProjectMarker: false },
    }),
  );
  const projectArgs = ["--host", "codex", "--project", tempDir, "--config", configPath];

  const invalidConfigPath = path.join(tempDir, "invalid.json");
  writeFileSync(invalidConfigPath, JSON.stringify({ embeddingProvider: "invalid-help-provider" }));
  // Only the lightweight facade is available: no worker, native addon, or providers.
  const facadeRoot = path.join(tempDir, "facade-only");
  mkdirSync(facadeRoot);
  writeFileSync(path.join(facadeRoot, "package.json"), '{"type":"module"}');
  for (const extension of ["js", "cjs"]) {
    const builtPath = path.resolve(path.dirname(cliPath), `cli.${extension}`);
    const isolatedPath = path.join(facadeRoot, `cli.${extension}`);
    copyFileSync(builtPath, isolatedPath);
    for (const commandPath of [builtPath, isolatedPath]) {
      for (const flag of ["--help", "-h"]) {
        for (const options of [
          ["--config", path.join(tempDir, "missing.json"), "--host", "invalid-host", "--mcp-idle-timeout", "invalid"],
          ["--config", invalidConfigPath, "--host", "codex", "--mcp-idle-timeout", "1"],
        ]) {
          const help = await runCliCommand([...options, flag], {
            cliPathOverride: commandPath, cwd: facadeRoot, killAfterMs: 5_000,
          });
          if (help.code !== 0 || help.signal !== null || help.stderr !== ""
            || !["Usage:", "open-codebase-index-mcp", "opencode-codebase-index-mcp", "--project", "--config",
              "--host", "--mcp-idle-timeout", "index", "eval", "visualize"].every((text) => help.stdout.includes(text))) {
            throw new Error(`Root help failed (${commandPath} ${flag}): ${JSON.stringify(help)}`);
          }
        }
      }
    }
  }

  mkdirSync(path.join(tempDir, ".opencode"));
  copyFileSync(configPath, path.join(tempDir, ".opencode", "codebase-index.json"));
  await runMcpHandshake([], { commandPath: path.resolve(cliPath), cwd: tempDir });

  const cbiHelp = await runCliCommand(["--help"], { cliPathOverride: "dist/cbi.js" });
  if (cbiHelp.code !== 0 || !cbiHelp.stdout.includes("Usage: ocbi")) {
    throw new Error(`Built OCBI CLI failed on --help (code=${cbiHelp.code}):\nstdout=${cbiHelp.stdout}\nstderr=${cbiHelp.stderr}`);
  }

  await Promise.all([
    runMcpHandshake(projectArgs),
    runMcpHandshake(projectArgs),
    runMcpHandshake(projectArgs, { commandPath: path.join(path.dirname(cliPath), "cli.cjs"), resume: true }),
  ]);

  const indexHelp = await runCliCommand(["index", "--help"]);
  if (indexHelp.code !== 0 || !indexHelp.stderr.includes("Usage:")) {
    throw new Error(`Built ESM CLI failed in index mode:\n${indexHelp.stderr}`);
  }
  const evalHelp = await runCliCommand(["eval", "--help"], { killAfterMs: 5_000 });
  if (evalHelp.code !== 0 || !evalHelp.stdout.includes("eval run")) {
    throw new Error(`Built CLI failed in eval help mode: ${JSON.stringify(evalHelp)}`);
  }
  const visualize = await runCliCommand(["visualize", "--help", "--project", tempDir, "--max", "0"], { killAfterMs: 5_000 });
  if (visualize.code !== 1 || !visualize.stderr.includes("Failed to generate visualization") || visualize.stdout !== "") {
    throw new Error(`Built CLI intercepted visualization routing: ${JSON.stringify(visualize)}`);
  }

  const cjsModule = require("../dist/index.cjs");
  const pluginExport = cjsModule.default;
  if (!pluginExport || typeof pluginExport !== "object" || typeof pluginExport.server !== "function" || typeof pluginExport.setup !== "function") {
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
  const initializeRequest = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "built-cli-signal-smoke", version: "1.0.0" },
    },
  })}\n`;
  for (const scenario of shutdownScenarios) {
    const requiresProtocolReadiness = scenario.name !== "stdin EOF";
    const result = await runCliCommand(projectArgs, {
      killAfterMs: 5_000,
      action: scenario.action,
      actionAfterStdout: requiresProtocolReadiness ? '"id":1' : null,
      stdinText: requiresProtocolReadiness ? initializeRequest : null,
    });
    if (result.code !== 0 || result.signal !== null) {
      throw new Error(
        `Built ESM CLI did not shut down cleanly on ${scenario.name} (code=${result.code}, signal=${result.signal}):\n${result.stderr}`,
      );
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
