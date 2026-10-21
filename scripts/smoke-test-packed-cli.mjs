import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkPackedTypes } from "./check-packed-types.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const catalog = JSON.parse(readFileSync(path.join(repositoryRoot, "src", "identity-catalog.json"), "utf-8"));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--output-dir"),
  "Usage: node scripts/smoke-test-packed-cli.mjs [--output-dir <new-directory>]");
const scratchRoot = args.length === 0
  ? mkdtempSync(path.join(os.tmpdir(), "packed-cli-smoke-"))
  : path.resolve(args[1]);
if (args.length !== 0) mkdirSync(scratchRoot, { mode: 0o700 });
const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
let commandNumber = 0;
console.log(`Packed smoke evidence: ${scratchRoot}`);

function run(command, args, cwd) {
  const started = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
  });
  writeFileSync(path.join(scratchRoot, `command-${++commandNumber}.json`), JSON.stringify({
    command, args, cwd, started, finished: new Date().toISOString(),
    pid: result.pid, status: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
  }, null, 2), { flag: "wx", mode: 0o600 });
  assert.equal(result.status, 0, `Packed command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function smokeMcpBinary(executable, projectRoot, configPath) {
  for (const flag of ["--help", "-h"]) {
    for (const options of [
      [],
      ["--config", path.join(projectRoot, "missing.json"), "--host", "invalid-host", "--mcp-idle-timeout", "invalid"],
      ["--config", path.join(projectRoot, "invalid.json"), "--host", "codex", "--mcp-idle-timeout", "1"],
    ]) {
      const args = [...options, flag];
      const started = Date.now();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
          cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        // Deliberately leave stdin open: help must not wait for an MCP client.
        child.once("close", (status, signal) => {
          clearTimeout(timer);
          resolve({ status, signal, stdout, stderr, pid: child.pid });
        });
      });
      writeFileSync(path.join(scratchRoot, `command-${++commandNumber}.json`), JSON.stringify({
        command: executable, args, cwd: projectRoot, elapsedMs: Date.now() - started, stdinHeldOpen: true, ...result,
      }, null, 2), { flag: "wx", mode: 0o600 });
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      for (const text of ["Usage:", "open-codebase-index-mcp", "opencode-codebase-index-mcp",
        "--project", "--config", "--host", "--mcp-idle-timeout", "index", "eval", "visualize"]) {
        assert.ok(result.stdout.includes(text), `Missing ${text} in ${executable} ${flag}`);
      }
    }
  }

  const transport = new StdioClientTransport({
    command: executable, args: ["--project", projectRoot, "--config", configPath, "--host", "jcode"],
    cwd: projectRoot, stderr: "pipe",
  });
  const client = new Client({ name: "packed-cli-smoke", version: "1.0.0" });
  const timer = setTimeout(() => { void transport.close(); }, 10_000);
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ["index_status", "codebase_context"]) {
      assert.ok(listed.tools.some((tool) => tool.name === name), `Missing MCP tool ${name}`);
    }
    writeFileSync(path.join(scratchRoot, `command-${++commandNumber}.json`), JSON.stringify({
      command: executable, initialize: client.getServerVersion(), tools: listed.tools.map((tool) => tool.name),
    }, null, 2), { flag: "wx", mode: 0o600 });
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

function binaryPath(installRoot, binaryName) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return path.join(installRoot, "node_modules", ".bin", `${binaryName}${suffix}`);
}

async function smokeIdentity(identity, expectedBinaries) {
  const stageRoot = path.join(scratchRoot, `stage-${identity.packageName}`);
  const installRoot = path.join(scratchRoot, `install-${identity.packageName}`);
  const projectRoot = path.join(scratchRoot, `project-${identity.packageName}`);

  mkdirSync(installRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  run(process.execPath, [
    path.join(repositoryRoot, "scripts", "prepare-package-metadata.mjs"),
    "--package-name",
    identity.packageName,
    "--project-root",
    repositoryRoot,
    "--output-dir",
    stageRoot,
    ...(process.env.GITHUB_REPOSITORY
      ? ["--repository-url", `https://github.com/${process.env.GITHUB_REPOSITORY}`]
      : []),
  ], repositoryRoot);

  const packOutput = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json"], stageRoot));
  assert.ok(Array.isArray(packOutput) && packOutput.length === 1, "Expected one packed identity");
  const packed = packOutput.find((entry) => entry.name === identity.packageName && entry.version === manifest.version);
  assert.ok(packed, "Pack result identity/version does not match the staged package");
  assert.equal(path.basename(packed.filename), packed.filename, "Pack filename must stay in its stage");
  const tarballPath = path.join(stageRoot, packed.filename);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
  assert.equal(integrity, packed.integrity);

  writeFileSync(path.join(scratchRoot, `pack-${identity.packageName}.json`), JSON.stringify(packOutput, null, 2),
    { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(installRoot, "package.json"), "{\"private\":true}\n", { flag: "wx", mode: 0o600 });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarballPath,
    `typescript@${lock.packages["node_modules/typescript"].version}`,
    `@types/node@${lock.packages["node_modules/@types/node"].version}`], installRoot);
  const installedRoot = path.join(installRoot, "node_modules", identity.packageName);
  const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installed.name, packed.name);
  assert.equal(installed.version, packed.version);
  for (const mode of ["import", "require"]) {
    for (const target of Object.values(installed.exports["."][mode])) {
      assert.ok(typeof target === "string" && target.startsWith("./"));
      const relative = target.slice(2);
      assert.ok(packed.files.some((file) => file.path === relative), `Export not packed: ${target}`);
      const actual = path.join(installedRoot, relative);
      assert.ok(lstatSync(actual).isFile(), `Export is not a regular file: ${target}`);
      assert.ok(realpathSync(actual).startsWith(`${realpathSync(installedRoot)}${path.sep}`));
    }
  }
  const types = checkPackedTypes(installRoot, identity.packageName);
  for (const [mode, expression] of [
    ["module", `import plugin from ${JSON.stringify(identity.packageName)};`],
    ["commonjs", `const plugin = require(${JSON.stringify(identity.packageName)}).default;`],
  ]) {
    run(process.execPath, ["--input-type", mode, "-e", `${expression}
      if (plugin.id !== "codebase-index" || typeof plugin.setup !== "function" || typeof plugin.server !== "function") {
        throw new Error("Packed root runtime contract failed");
      }`], installRoot);
  }

  writeFileSync(path.join(projectRoot, "notes.txt"), "packed CLI smoke test\n", { flag: "wx" });
  const configPath = path.join(projectRoot, "config.json");
  writeFileSync(configPath, JSON.stringify({
    embeddingProvider: "custom",
    include: ["**/*.txt"],
    customProvider: {
      baseUrl: "http://127.0.0.1/v1",
      model: "smoke-test-embed",
      dimensions: 1024,
    },
    indexing: { autoIndex: false, watchFiles: false, requireProjectMarker: false },
  }));
  writeFileSync(path.join(projectRoot, "invalid.json"), JSON.stringify({ embeddingProvider: "invalid-help-provider" }));

  for (const binaryName of expectedBinaries) {
    const executable = binaryPath(installRoot, binaryName);
    if (!existsSync(executable)) {
      throw new Error(`Packed package ${identity.packageName} is missing binary ${binaryName}`);
    }

    if (binaryName === "ocbi" || binaryName === "cbi") {
      const help = run(executable, ["--help"], projectRoot);
      assert.ok(help.includes("Usage: ocbi"), `Missing CLI help for ${binaryName}`);
    } else {
      await smokeMcpBinary(executable, projectRoot, configPath);
    }

    const result = run(executable, [
      "index",
      "--project",
      projectRoot,
      "--host",
      "jcode",
      "--config",
      configPath,
      "--estimate-only",
    ], projectRoot);
    assert.ok(result.includes("Indexing Estimate"), `Missing indexing estimate for ${binaryName}`);
  }
  return {
    name: packed.name, version: packed.version, tarball: tarballPath, integrity,
    validation: { types, runtime: true, cliAliases: expectedBinaries },
  };
}

const packages = [
  await smokeIdentity(catalog.product.current, [catalog.product.current.mcpBinary, "ocbi", "cbi"]),
  await smokeIdentity(catalog.product.future, [catalog.product.future.mcpBinary, catalog.product.current.mcpBinary, "ocbi", "cbi"]),
];
writeFileSync(path.join(scratchRoot, "validated-packages.json"), JSON.stringify({
  schemaVersion: 1, version: manifest.version, packages,
}, null, 2), { flag: "wx", mode: 0o600 });
console.log(`Validated BOTH package identities: ${path.join(scratchRoot, "validated-packages.json")}`);
