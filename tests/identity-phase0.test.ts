import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { IDENTITY_CATALOG } from "../src/identity-catalog.js";
import { getNativeBindingFilename, resolveNativeBindingPath } from "../src/native/binding.js";

interface PackageMetadata {
  name: string;
  bin: Record<string, string>;
  repository: { url: string };
  napi: { binaryName: string };
}

interface PackageLockMetadata {
  name: string;
  packages: Record<string, { name?: string; bin?: Record<string, string> }>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function prepareMetadata(packageName: string, outputDir: string): void {
  execFileSync(process.execPath, [
    path.join(process.cwd(), "scripts", "prepare-package-metadata.mjs"),
    "--package-name",
    packageName,
    "--project-root",
    process.cwd(),
    "--output-dir",
    outputDir,
  ]);
}

describe("Phase 0 product identity compatibility", () => {
  it("keeps the checked-in legacy package and host manifests unchanged", () => {
    const current = IDENTITY_CATALOG.product.current;
    const packageJson = readJson<PackageMetadata>("package.json");
    const packageLock = readJson<PackageLockMetadata>("package-lock.json");
    const mcpManifest = readJson<{
      mcpServers: Record<string, { command: string; args: string[] }>;
    }>(".mcp.json");
    const claudeManifest = readJson<{
      homepage: string;
      repository: string;
      mcpServers: Record<string, { command: string; args: string[] }>;
    }>(".claude-plugin/plugin.json");
    const claudeMarketplace = readJson<{ owner: { url: string } }>(".claude-plugin/marketplace.json");
    const codexManifest = readJson<{
      homepage: string;
      repository: string;
      mcpServers: string;
      interface: { websiteURL: string };
    }>(".codex-plugin/plugin.json");

    const expectedBin = { [current.mcpBinary]: "dist/cli.js" };
    expect(packageJson.name).toBe(current.packageName);
    expect(packageJson.bin).toEqual(expectedBin);
    expect(packageJson.repository.url).toBe(current.repository);
    expect(packageLock.name).toBe(current.packageName);
    expect(packageLock.packages[""]?.name).toBe(current.packageName);
    expect(packageLock.packages[""]?.bin).toEqual(expectedBin);
    expect(packageJson.napi.binaryName).toBe(IDENTITY_CATALOG.native.binaryName);

    const codexMcpManifest = readJson<{
      mcpServers: Record<string, { command: string; args: string[] }>;
    }>(codexManifest.mcpServers);
    const expectedCodexArgs = ["-y", "--package", current.packageName, current.mcpBinary, "--host", "codex"];
    const expectedClaudeArgs = ["-y", "--package", current.packageName, current.mcpBinary, "--host", "claude"];

    expect(mcpManifest.mcpServers["codebase-index"]).toEqual({ command: "npx", args: expectedCodexArgs });
    expect(codexMcpManifest.mcpServers["codebase-index"]).toEqual({ command: "npx", args: expectedCodexArgs });
    expect(claudeManifest.mcpServers["codebase-index"]).toEqual({ command: "npx", args: expectedClaudeArgs });
    expect(claudeManifest.homepage).toBe(current.repository);
    expect(claudeManifest.repository).toBe(current.repository);
    expect(claudeMarketplace.owner.url).toBe(current.repository);
    expect(codexManifest.homepage).toBe(current.repository);
    expect(codexManifest.repository).toBe(current.repository);
    expect(codexManifest.interface.websiteURL).toBe(current.repository);
  });

  it("stages current metadata with only the legacy binary", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-current-metadata-"));
    try {
      prepareMetadata(IDENTITY_CATALOG.product.current.packageName, tempDir);
      const packageJson = readJson<PackageMetadata>(path.join(tempDir, "package.json"));
      const packageLock = readJson<PackageLockMetadata>(path.join(tempDir, "package-lock.json"));
      const checkedInPackageJson = readJson<PackageMetadata>("package.json");
      const checkedInPackageLock = readJson<PackageLockMetadata>("package-lock.json");
      const expectedBin = { [IDENTITY_CATALOG.product.current.mcpBinary]: "dist/cli.js" };

      expect(packageJson.name).toBe(IDENTITY_CATALOG.product.current.packageName);
      expect(packageJson.bin).toEqual(expectedBin);
      expect(packageLock.name).toBe(IDENTITY_CATALOG.product.current.packageName);
      expect(packageLock.packages[""]?.bin).toEqual(expectedBin);

      expect(readFileSync(path.join(tempDir, "package.json"), "utf-8")).toBe(readFileSync("package.json", "utf-8"));
      expect(readFileSync(path.join(tempDir, "package-lock.json"), "utf-8")).toBe(readFileSync("package-lock.json", "utf-8"));
      expect(packageJson).toEqual(checkedInPackageJson);
      expect(packageLock).toEqual(checkedInPackageLock);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stages future metadata with both MCP binary aliases", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-future-metadata-"));
    try {
      prepareMetadata(IDENTITY_CATALOG.product.future.packageName, tempDir);
      const packageJson = readJson<PackageMetadata>(path.join(tempDir, "package.json"));
      const packageLock = readJson<PackageLockMetadata>(path.join(tempDir, "package-lock.json"));
      const expectedBin = {
        [IDENTITY_CATALOG.product.future.mcpBinary]: "dist/cli.js",
        [IDENTITY_CATALOG.product.current.mcpBinary]: "dist/cli.js",
      };

      expect(packageJson.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageJson.bin).toEqual(expectedBin);
      expect(packageLock.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageLock.packages[""]?.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageLock.packages[""]?.bin).toEqual(expectedBin);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects package identities outside the catalog", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-invalid-metadata-"));
    try {
      expect(() => prepareMetadata("unknown-codebase-index", tempDir)).toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps native artifact names stable and independent of the package directory name", () => {
    expect(getNativeBindingFilename("darwin", "arm64")).toBe("codebase-index-native.darwin-arm64.node");
    expect(getNativeBindingFilename("darwin", "x64")).toBe("codebase-index-native.darwin-x64.node");
    expect(getNativeBindingFilename("linux", "x64")).toBe("codebase-index-native.linux-x64-gnu.node");
    expect(getNativeBindingFilename("linux", "arm64")).toBe("codebase-index-native.linux-arm64-gnu.node");
    expect(getNativeBindingFilename("win32", "x64")).toBe("codebase-index-native.win32-x64-msvc.node");

    for (const packageName of [
      IDENTITY_CATALOG.product.current.packageName,
      IDENTITY_CATALOG.product.future.packageName,
    ]) {
      const packageRoot = path.join("/packages", packageName);
      expect(resolveNativeBindingPath(packageRoot, "linux", "x64")).toBe(
        path.join(packageRoot, "native", "codebase-index-native.linux-x64-gnu.node"),
      );
    }
  });

  it("keeps publication release-gated while accepting an explicit known package identity", () => {
    const workflow = readFileSync(".github/workflows/build.yml", "utf-8");
    expect(workflow).toContain("package_name:");
    expect(workflow).toContain("inputs.package_name || vars.NPM_PACKAGE_NAME || 'opencode-codebase-index'");
    expect(workflow).toContain("if: github.event_name == 'release'");
    expect(workflow).toContain("node scripts/prepare-package-metadata.mjs --package-name");
  });
});
