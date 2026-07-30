import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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

const preparedBins = selectedIdentity.packageName === catalog.product.current.packageName
  ? { [catalog.product.current.mcpBinary]: cliTarget }
  : {
      [catalog.product.future.mcpBinary]: cliTarget,
      [catalog.product.current.mcpBinary]: cliTarget,
    };

packageJson.name = selectedIdentity.packageName;
packageJson.bin = preparedBins;
packageLock.name = selectedIdentity.packageName;
if (!packageLock.packages?.[""]) {
  fail("package-lock.json is missing the root package entry");
}
packageLock.packages[""].name = selectedIdentity.packageName;
packageLock.packages[""].bin = preparedBins;

mkdirSync(outputDir, { recursive: true });
writeFileSync(path.join(outputDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");
writeFileSync(path.join(outputDir, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`, "utf-8");

console.log(`Prepared metadata for ${selectedIdentity.packageName}`);
