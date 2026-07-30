import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const catalog = JSON.parse(readFileSync(path.join(repositoryRoot, "src", "identity-catalog.json"), "utf-8"));
const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "packed-cli-smoke-"));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function binaryPath(installRoot, binaryName) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return path.join(installRoot, "node_modules", ".bin", `${binaryName}${suffix}`);
}

function smokeIdentity(identity, expectedBinaries) {
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
  ], repositoryRoot);

  const packOutput = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json"], stageRoot));
  const tarballPath = path.join(stageRoot, packOutput[0].filename);

  writeFileSync(path.join(scratchRoot, `pack-${identity.packageName}.json`), JSON.stringify(packOutput, null, 2));
  writeFileSync(path.join(installRoot, "package.json"), "{\"private\":true}\n", { flag: "wx" });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], installRoot);

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
  }));

  for (const binaryName of expectedBinaries) {
    const executable = binaryPath(installRoot, binaryName);
    if (!existsSync(executable)) {
      throw new Error(`Packed package ${identity.packageName} is missing binary ${binaryName}`);
    }

    const result = spawnSync(executable, [
      "index",
      "--project",
      projectRoot,
      "--host",
      "jcode",
      "--config",
      configPath,
      "--estimate-only",
    ], { cwd: projectRoot, encoding: "utf8" });

    if (result.status !== 0 || !result.stdout.includes("Indexing Estimate")) {
      throw new Error([
        `Packed CLI smoke failed for ${identity.packageName}/${binaryName} with exit ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ].join("\n"));
    }
  }
}

try {
  smokeIdentity(catalog.product.current, [catalog.product.current.mcpBinary]);
  smokeIdentity(catalog.product.future, [catalog.product.future.mcpBinary, catalog.product.current.mcpBinary]);
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}
