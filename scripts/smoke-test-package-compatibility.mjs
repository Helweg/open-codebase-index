import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Published bytes are the comparator; no git-tag/source equivalence is implied.
const baselines = [
  {
    name: "open-codebase-index", version: "0.38.2",
    url: "https://registry.npmjs.org/open-codebase-index/-/open-codebase-index-0.38.2.tgz",
    integrity: "sha512-ieUhyWTj9LGaQGlCGzkKVimvjy5bGExQXEOyeS1KU7OiaMAK/WHCz3O1JYmQyN4iSYQ07MuMvFRoNjFiKIvvqQ==",
  },
  {
    name: "opencode-codebase-index", version: "0.38.2",
    url: "https://registry.npmjs.org/opencode-codebase-index/-/opencode-codebase-index-0.38.2.tgz",
    integrity: "sha512-QPyTcDDSq8YgC/RQP4k932jnWj4Oro+LIMjF2XrdOIhNdnWacVuLIz0tEXQ5DY9Vq1YL2gqJIEFP0ldD/d/FUA==",
  },
];
const args = process.argv.slice(2);
assert.ok(args.length === 4 && args[0] === "--packages" && path.isAbsolute(args[1]) && args[2] === "--output-dir",
  "Usage: node scripts/smoke-test-package-compatibility.mjs --packages <absolute validated-packages.json> --output-dir <new-directory>");
const outputDir = path.resolve(args[3]);
mkdirSync(outputDir, { mode: 0o700 });
const report = {
  schemaVersion: 1, comparison: "published-artifact-to-candidate-artifact-replacement",
  platform: process.platform, arch: process.arch, node: process.version, passed: false, packages: [],
};
const reportPath = path.join(outputDir, "report.json");
const saveReport = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function withTimeout(promise, timeoutMs, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} timed out (${timeoutMs}ms)`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function run(command, commandArgs, cwd, env) {
  const result = spawnSync(command, commandArgs, {
    cwd, env, encoding: null, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${JSON.stringify({
      status: result.status, signal: result.signal, error: result.error?.message,
      stdout: result.stdout?.toString().slice(-8000), stderr: result.stderr?.toString().slice(-8000),
    })}`);
  }
  return result.stdout;
}

function childEnvironment(root) {
  const home = path.join(root, "home");
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"),
    TMPDIR: path.join(root, "tmp"), LANG: "en_US.UTF-8", CI: "true",
    NODE_PATH: "", NODE_OPTIONS: "", npm_config_userconfig: path.join(home, "npmrc"),
    npm_config_globalconfig: path.join(home, "global-npmrc"), npm_config_cache: path.join(home, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_update_notifier: "false",
  };
  for (const directory of [home, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.TMPDIR]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const file of [env.npm_config_userconfig, env.npm_config_globalconfig]) writeFileSync(file, "", { flag: "wx" });
  return env;
}

function dependencies(lock, packageName) {
  return Object.fromEntries(Object.entries(lock.packages)
    .filter(([key]) => key !== "" && key !== `node_modules/${packageName}`)
    .map(([key, value]) => [key, { version: value.version, resolved: value.resolved, integrity: value.integrity }]));
}

function installArtifact(artifact, consumer, env) {
  assert.equal(integrity(readFileSync(artifact.tarball)), artifact.integrity, `Archive changed: ${artifact.name}`);
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", artifact.tarball], consumer, env);
  const lock = JSON.parse(readFileSync(path.join(consumer, "package-lock.json"), "utf8"));
  const entry = lock.packages[`node_modules/${artifact.name}`];
  assert.equal(entry.version, artifact.version);
  assert.equal(entry.integrity, artifact.integrity, "npm did not install the requested artifact integrity");
  assert.equal(new URL(entry.resolved, pathToFileURL(`${consumer}${path.sep}`)).href, pathToFileURL(artifact.tarball).href,
    "npm did not resolve the requested local tarball");
  const installedRoot = path.join(consumer, "node_modules", artifact.name);
  const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  const packed = JSON.parse(run("tar", ["-xOf", artifact.tarball, "package/package.json"], consumer, env).toString());
  assert.equal(installed.name, artifact.name);
  assert.equal(installed.version, artifact.version);
  assert.deepEqual(installed, packed, "Installed manifest differs from the archive");
  const entries = run("tar", ["-tzf", artifact.tarball], consumer, env).toString().trim().split("\n");
  const runtimeEntries = entries.filter((entryPath) => /^package\/dist\/.*\.(?:js|cjs)$/.test(entryPath)
    || (entryPath.startsWith("package/native/") && entryPath.endsWith(".node")
      && entryPath.includes(`${process.platform}-${process.arch}`)));
  assert.ok(runtimeEntries.some((entryPath) => entryPath.endsWith(".node")), "Archive lacks this platform's native addon");
  const runtimeHashes = {};
  const archiveRoot = mkdtempSync(path.join(path.dirname(consumer), "archive-"));
  try {
    run("tar", ["-xzf", artifact.tarball, "-C", archiveRoot, ...runtimeEntries], consumer, env);
    for (const entryPath of runtimeEntries) {
      const relative = entryPath.slice("package/".length);
      const installedPath = path.join(installedRoot, relative);
      assert.ok(lstatSync(installedPath).isFile());
      assert.ok(realpathSync(installedPath).startsWith(`${realpathSync(installedRoot)}${path.sep}`));
      const expectedHash = digest(readFileSync(path.join(archiveRoot, entryPath)));
      assert.equal(digest(readFileSync(installedPath)), expectedHash, `Installed runtime differs: ${relative}`);
      runtimeHashes[relative] = expectedHash;
    }
  } finally {
    rmSync(archiveRoot, { recursive: true, force: true });
  }
  const binaryName = `${artifact.name}-mcp`;
  const binary = path.join(consumer, "node_modules", ".bin", binaryName);
  assert.equal(realpathSync(binary), realpathSync(path.join(installedRoot, installed.bin[binaryName])));
  assert.ok(runtimeHashes[installed.bin[binaryName].replace(/^\.\//, "")], "MCP entrypoint was not byte-verified");
  return {
    binary, lock,
    evidence: { name: installed.name, version: installed.version, tarball: artifact.tarball, integrity: artifact.integrity,
      registryUrl: artifact.url, lockResolved: entry.resolved, runtimeHashes },
  };
}

async function startProvider() {
  const state = { requests: 0, sourceInputs: 0, allowSourceInputs: true };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, "compatibility-fixture-32");
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        const sourceInputs = inputs.filter((input) => input.includes("export function")).length;
        state.requests += 1;
        state.sourceInputs += sourceInputs;
        // A read-only reopen must not conceal automatic fixture reindexing.
        assert.ok(state.allowSourceInputs || sourceInputs === 0, "Unexpected source embedding before explicit indexing");
        const data = inputs.map((input, index) => {
          const seed = createHash("sha256").update(input).digest();
          const vector = Array.from(seed, (value) => (value + 1) / 256);
          const norm = Math.hypot(...vector);
          return { object: "embedding", index, embedding: vector.map((value) => value / norm) };
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ object: "list", model: parsed.model, data, usage: { total_tokens: inputs.reduce((sum, input) => sum + Math.ceil(input.length / 4), 0) } }));
      } catch (error) {
        state.error = error.message;
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function session(binary, project, config, env, evidence, action) {
  const transport = new StdioClientTransport({
    command: binary, args: ["--project", project, "--config", config, "--host", "jcode"],
    cwd: project, env, stderr: "pipe",
  });
  const client = new Client({ name: "artifact-replacement-compatibility", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  evidence.tools = [];
  const call = async (name, toolArgs = {}) => {
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 60_000 });
    const text = result.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    evidence.tools.push({ name, arguments: toolArgs, isError: result.isError === true, text });
    saveReport();
    assert.ok(!result.isError, `${name} failed: ${text}`);
    return text;
  };
  try {
    await withTimeout(client.connect(transport), 20_000, "MCP initialize");
    evidence.server = client.getServerVersion();
    await action(call);
  } finally {
    try {
      await withTimeout(client.close(), 10_000, "MCP close");
      evidence.closed = true;
    } finally {
      evidence.stderr = stderr;
      saveReport();
    }
  }
}

async function findFixture(call, symbol, file, marker) {
  const text = await call("codebase_search", { query: symbol, fileType: "ts", limit: 10 });
  // Match a returned citation plus source, not the query echoed in the introduction.
  const result = text.split(/(?=\[\d+\] )/).find((block) => block.includes(`"${symbol}"`)
    && block.includes(`${file}:1-3`) && block.includes(`export function ${symbol}(`) && block.includes(marker));
  assert.ok(result, `Missing persisted ${symbol} at ${file}:1-3 with ${marker}:\n${text}`);
  return { symbol, file, startLine: 1, endLine: 3, marker };
}

async function checkIdentity(baseline, candidate, root, evidence) {
  const consumer = path.join(root, "consumer");
  const project = path.join(root, "project");
  mkdirSync(consumer);
  mkdirSync(project);
  const env = childEnvironment(root);
  writeFileSync(path.join(consumer, "package.json"), '{"private":true}\n', { flag: "wx" });
  const baselinePath = path.join(root, "published.tgz");
  const response = await fetch(baseline.url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok, `Published download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(integrity(bytes), baseline.integrity, "Published tarball does not match the pinned registry SRI");
  writeFileSync(baselinePath, bytes, { flag: "wx", mode: 0o600 });
  const published = installArtifact({ ...baseline, tarball: baselinePath }, consumer, env);
  evidence.baseline = published.evidence;
  saveReport();
  const retainedFile = path.join(project, "retained.ts");
  const source = (symbol, marker) => `export function ${symbol}(value: string): string {\n  return ${JSON.stringify(marker)} + value;\n}\n`;
  writeFileSync(retainedFile, source("compatibilityRetainedSymbol", "baseline-v1"), { flag: "wx" });
  const provider = await startProvider();
  evidence.provider = provider.state;
  try {
    const config = path.join(root, "config.json");
    writeFileSync(config, JSON.stringify({
      embeddingProvider: "custom", scope: "project", include: ["**/*.ts"], embeddingFallback: false,
      customProvider: { baseUrl: provider.baseUrl, model: "compatibility-fixture-32", dimensions: 32, timeoutMs: 10_000 },
      indexing: { autoIndex: false, watchFiles: false, autoGc: false, requireProjectMarker: false, retries: 0 },
      reranker: { enabled: false },
    }));
    evidence.baselineIndex = {};
    await session(published.binary, project, config, env, evidence.baselineIndex, async (call) => {
      await call("index_status");
      await call("index_codebase");
    });
    assert.ok(provider.state.sourceInputs > 0, "Baseline did not embed the fixture source");
    provider.state.allowSourceInputs = false;
    evidence.baselineReopen = {};
    await session(published.binary, project, config, env, evidence.baselineReopen, async (call) => {
      evidence.baselineReopen.match = await findFixture(call, "compatibilityRetainedSymbol", "retained.ts", "baseline-v1");
    });
    const replacement = installArtifact(candidate, consumer, env);
    evidence.candidate = replacement.evidence;
    assert.notEqual(candidate.integrity, baseline.integrity, "Candidate equals the published artifact; no replacement occurred");
    const beforeDependencies = dependencies(published.lock, baseline.name);
    const afterDependencies = dependencies(replacement.lock, baseline.name);
    evidence.dependencyChanges = [];
    for (const name of new Set([...Object.keys(beforeDependencies), ...Object.keys(afterDependencies)])) {
      if (JSON.stringify(beforeDependencies[name]) !== JSON.stringify(afterDependencies[name])) {
        evidence.dependencyChanges.push({
          path: name, before: beforeDependencies[name], after: afterDependencies[name],
        });
      }
    }
    evidence.candidateBeforeIndex = {};
    const sourceInputsBeforeRead = provider.state.sourceInputs;
    await session(replacement.binary, project, config, env, evidence.candidateBeforeIndex, async (call) => {
      evidence.candidateBeforeIndex.match = await findFixture(call, "compatibilityRetainedSymbol", "retained.ts", "baseline-v1");
    });
    assert.equal(provider.state.sourceInputs, sourceInputsBeforeRead, "Candidate re-embedded source before persisted-index read");
    assert.equal(provider.state.error, undefined);
    evidence.candidateBeforeIndex.noSourceReembedding = true;
    saveReport();
    writeFileSync(retainedFile, source("compatibilityRetainedSymbol", "candidate-v2"));
    writeFileSync(path.join(project, "added.ts"), source("compatibilityAddedSymbol", "candidate-added"), { flag: "wx" });
    provider.state.allowSourceInputs = true;
    evidence.candidateUpdate = {};
    await session(replacement.binary, project, config, env, evidence.candidateUpdate, async (call) => {
      await call("index_codebase");
      evidence.candidateUpdate.retained = await findFixture(call, "compatibilityRetainedSymbol", "retained.ts", "candidate-v2");
      evidence.candidateUpdate.added = await findFixture(call, "compatibilityAddedSymbol", "added.ts", "candidate-added");
    });
    assert.ok(provider.state.sourceInputs > sourceInputsBeforeRead, "Candidate did not embed the updated fixture");
    provider.state.allowSourceInputs = false;
    const sourceInputsBeforeReopen = provider.state.sourceInputs;
    evidence.candidateReopen = {};
    await session(replacement.binary, project, config, env, evidence.candidateReopen, async (call) => {
      evidence.candidateReopen.retained = await findFixture(call, "compatibilityRetainedSymbol", "retained.ts", "candidate-v2");
      evidence.candidateReopen.added = await findFixture(call, "compatibilityAddedSymbol", "added.ts", "candidate-added");
    });
    assert.equal(provider.state.sourceInputs, sourceInputsBeforeReopen, "Candidate reopen reindexed fixture source");
    assert.equal(provider.state.error, undefined);
    evidence.passed = true;
  } finally {
    provider.server.closeAllConnections();
    await new Promise((resolve, reject) => provider.server.close((error) => error ? reject(error) : resolve()));
    saveReport();
  }
}

let scratch;
try {
  const manifest = JSON.parse(readFileSync(args[1], "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  report.baselineVersion = baselines[0].version;
  report.candidateVersion = manifest.version;
  report.sameVersion = manifest.version === report.baselineVersion;
  assert.deepEqual(manifest.packages.map((entry) => entry.name).sort(), baselines.map((entry) => entry.name).sort());
  const artifactRoot = realpathSync(path.dirname(args[1]));
  // Check both supplied archives before any registry access or installation.
  for (const candidate of manifest.packages) {
    assert.equal(candidate.version, manifest.version);
    assert.equal(candidate.validation.runtime, true);
    assert.ok(path.isAbsolute(candidate.tarball) && lstatSync(candidate.tarball).isFile());
    assert.ok(realpathSync(candidate.tarball).startsWith(`${artifactRoot}${path.sep}`));
    assert.equal(integrity(readFileSync(candidate.tarball)), candidate.integrity, `Candidate changed: ${candidate.name}`);
  }
  scratch = mkdtempSync(path.join(os.tmpdir(), "package-compatibility-"));
  for (const baseline of baselines) {
    const evidence = { name: baseline.name, passed: false };
    report.packages.push(evidence);
    const root = path.join(scratch, baseline.name);
    mkdirSync(root);
    await checkIdentity(baseline, manifest.packages.find((entry) => entry.name === baseline.name), root, evidence);
    saveReport();
  }
  report.passed = true;
  console.log(`Published ${report.baselineVersion} to candidate ${manifest.version} artifact replacement passed for both identities: ${reportPath}`);
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(`Artifact replacement compatibility failed: ${error.message}\nReport: ${reportPath}`);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  saveReport();
}
