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

function normalizeRepositoryUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

function parseRepositoryUrlOverride(catalog, value, rawArg) {
  if (value === null || value === undefined) return null;
  try {
    const candidate = normalizeRepositoryUrl(value);
    const catalogUrls = [catalog.product.current.repository, catalog.product.future.repository]
      .map((it) => normalizeRepositoryUrl(it));

    if (!catalogUrls.includes(candidate)) {
      fail(`Unsupported repository URL: ${rawArg}`);
    }

    return candidate;
  } catch {
    fail(`Invalid repository URL: ${rawArg}`);
    return null;
  }
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
const repositoryUrlArg = args.has("--repository-url") ? args.get("--repository-url") : null;
const repositoryUrl = parseRepositoryUrlOverride(
  catalog,
  repositoryUrlArg,
  repositoryUrlArg || "",
);

if (!packageName) {
  fail(
    "Usage: node scripts/prepare-package-metadata.mjs --package-name <known-name> [--project-root <path>] [--output-dir <path>] [--repository-url <url>]",
  );
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

if (repositoryUrl && outputDir === projectRoot) {
  fail("Repository override staging requires --output-dir because this operation preserves checked-in metadata.");
}

if (!isCurrentIdentity() && outputDir === projectRoot) {
  fail("Future identity staging requires --output-dir because this operation preserves checked-in metadata.");
}

const appliedRepositoryUrl = repositoryUrl || catalog.product.current.repository;

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
  if (manifest.author?.url) {
    manifest.author.url = appliedRepositoryUrl;
  }
  if (manifest.homepage) {
    manifest.homepage = appliedRepositoryUrl;
  }
  if (manifest.repository) {
    manifest.repository = appliedRepositoryUrl;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function prepareClaudePluginManifest(manifestPath) {
  if (!existsSync(manifestPath)) fail(`Missing Claude plugin manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const server = manifest.mcpServers?.["codebase-index"];
  if (!server?.command || !Array.isArray(server.args)) {
    fail(`Missing codebase-index MCP server in ${manifestPath}`);
  }
  server.args = ["-y", "--package", selectedIdentity.packageName, selectedIdentity.mcpBinary, "--host", "claude"];

  if (manifest.homepage) {
    manifest.homepage = appliedRepositoryUrl;
  }
  if (manifest.repository) {
    manifest.repository = appliedRepositoryUrl;
  }
  if (manifest.author?.url) {
    manifest.author.url = appliedRepositoryUrl;
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function prepareCodexManifest(manifestPath) {
  if (!existsSync(manifestPath)) fail(`Missing Codex manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (manifest.homepage) {
    manifest.homepage = appliedRepositoryUrl;
  }
  if (manifest.repository) {
    manifest.repository = appliedRepositoryUrl;
  }
  if (manifest.author?.url) {
    manifest.author.url = appliedRepositoryUrl;
  }
  if (manifest.interface?.websiteURL) {
    manifest.interface.websiteURL = appliedRepositoryUrl;
  }
  if (manifest.interface?.privacyPolicyURL) {
    manifest.interface.privacyPolicyURL = `${appliedRepositoryUrl}/blob/main/SECURITY.md`;
  }
  if (manifest.interface?.termsOfServiceURL) {
    manifest.interface.termsOfServiceURL = `${appliedRepositoryUrl}/blob/main/LICENSE`;
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

function prepareClaudeMarketplace(manifestPath) {
  if (!existsSync(manifestPath)) fail(`Missing marketplace manifest at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!manifest.owner?.url) {
    fail(`Missing marketplace owner URL in ${manifestPath}`);
  }
  if (typeof manifest.name !== "string") {
    fail(`Invalid marketplace manifest at ${manifestPath}`);
  }
  manifest.owner.url = appliedRepositoryUrl;
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
}

const shouldWritePackageJson = !isCurrentIdentity() || !!repositoryUrl;
const shouldWritePackageLock = !isCurrentIdentity();

if (shouldWritePackageJson || shouldWritePackageLock) {
  if (repositoryUrl) {
    packageJson.repository = {
      ...packageJson.repository,
      url: appliedRepositoryUrl,
    };
  }

  if (shouldWritePackageJson) {
    writeFileSync(targetPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");
  }

  if (shouldWritePackageLock) {
    writeFileSync(targetPackageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, "utf-8");
  }
}

if (!isCurrentIdentity() || repositoryUrl) {
  prepareManifest(path.join(outputDir, ".mcp.json"), "codex");
  prepareClaudePluginManifest(path.join(outputDir, ".claude-plugin", "plugin.json"));
  prepareCodexManifest(path.join(outputDir, ".codex-plugin", "plugin.json"));
  prepareClaudeMarketplace(path.join(outputDir, ".claude-plugin", "marketplace.json"));
}

console.log(`Prepared metadata for ${selectedIdentity.packageName}`);
