import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as path from "node:path";
import { fileURLToPath } from "url";

/**
 * @typedef {{
 *   product: {
 *     current: { packageName: string, mcpBinary: string },
 *     future: { packageName: string, mcpBinary: string }
 *   }
 * }} IdentityCatalog
 */

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(arg, next);
      i += 1;
    } else {
      args.set(arg, "");
    }
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @type {IdentityCatalog} */
const catalog = JSON.parse(readFileSync(path.join(repositoryRoot, "src", "identity-catalog.json"), "utf-8"));
const args = parseArgs(process.argv.slice(2));
const packageName = args.get("--package-name");

if (!packageName) {
  fail("Usage: node scripts/prepare-package-metadata.mjs --package-name <known-name> [--project-root <path>] [--output-dir <path>]");
}

const selectedIdentity = [catalog.product.current, catalog.product.future]
  .find((identity) => identity.packageName === packageName);
if (!selectedIdentity) {
  fail(`Unknown package name: ${packageName}`);
}

const projectRoot = path.resolve(args.get("--project-root") || process.cwd());
const outputDir = path.resolve(args.get("--output-dir") || projectRoot);
const packageJsonPath = path.join(projectRoot, "package.json");
const packageLockPath = path.join(projectRoot, "package-lock.json");

if (!existsSync(packageJsonPath)) fail(`Missing package.json at ${packageJsonPath}`);
if (!existsSync(packageLockPath)) fail(`Missing package-lock.json at ${packageLockPath}`);

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
const packageLock = JSON.parse(readFileSync(packageLockPath, "utf-8"));
const cliTarget = packageJson.bin?.[catalog.product.current.mcpBinary];
if (typeof cliTarget !== "string") {
  fail(`Missing current MCP binary entry: ${catalog.product.current.mcpBinary}`);
}

function copyProject() {
  if (outputDir === projectRoot) return;
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(projectRoot, outputDir, {
    recursive: true,
    force: true,
    filter: (currentPath) => {
      const relative = path.relative(projectRoot, currentPath);
      if (relative === "") return true;
      const segments = relative.split(path.sep);
      const firstSegment = segments[0];
      if (firstSegment === ".git" || firstSegment === "node_modules") return false;
      return !(firstSegment === "native" && segments[1] === "target");
    },
  });
}

if (!isCurrentIdentity() && outputDir === projectRoot) {
  fail("Future identity staging requires --output-dir because this operation preserves checked-in metadata.");
}

function isCurrentIdentity() {
  return selectedIdentity.packageName === catalog.product.current.packageName;
}

function prepareManifest(manifestPath, host) {
  if (!existsSync(manifestPath)) fail(`Missing host manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const server = manifest.mcpServers?.["codebase-index"];
  if (!server?.command || !Array.isArray(server.args)) {
    fail(`Missing codebase-index MCP server in ${manifestPath}`);
  }
  server.args = ["-y", "--package", selectedIdentity.packageName, selectedIdentity.mcpBinary, "--host", host];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

const preparedBins = isCurrentIdentity()
  ? { [catalog.product.current.mcpBinary]: cliTarget }
  : {
      [catalog.product.future.mcpBinary]: cliTarget,
      [catalog.product.current.mcpBinary]: cliTarget,
    };

const targetPackageJsonPath = path.join(outputDir, "package.json");
const targetPackageLockPath = path.join(outputDir, "package-lock.json");

copyProject();

if (!isCurrentIdentity()) {
  packageJson.name = selectedIdentity.packageName;
  packageJson.bin = preparedBins;
  packageLock.name = selectedIdentity.packageName;
  if (!packageLock.packages?.[""]) {
    fail("package-lock.json is missing the root package entry");
  }
  packageLock.packages[""].name = selectedIdentity.packageName;
  packageLock.packages[""].bin = preparedBins;

  writeFileSync(targetPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");
  writeFileSync(targetPackageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf-8");

  prepareManifest(path.join(outputDir, ".mcp.json"), "codex");
  prepareManifest(path.join(outputDir, ".claude-plugin", "plugin.json"), "claude");
}

console.log(`Prepared metadata for ${selectedIdentity.packageName}`);
