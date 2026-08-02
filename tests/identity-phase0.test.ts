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

interface CodexManifestMetadata {
  author?: { url?: string };
  homepage: string;
  repository: string;
  interface: {
    websiteURL: string;
    privacyPolicyURL: string;
    termsOfServiceURL: string;
  };
}

interface ClaudeManifestMetadata {
  homepage: string;
  repository: string;
  author?: { url?: string };
}

interface ClaudeMarketplaceMetadata {
  owner: {
    url: string;
  };
}

interface PackageLockMetadata {
  name: string;
  packages: Record<string, { name?: string; bin?: Record<string, string> }>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function prepareMetadata(packageName: string, outputDir: string, repositoryUrl?: string): void {
  const args = [
    "--package-name",
    packageName,
    "--project-root",
    process.cwd(),
    "--output-dir",
    outputDir,
  ];
  if (repositoryUrl) {
    args.push("--repository-url", repositoryUrl);
  }

  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "prepare-package-metadata.mjs"), ...args]);
}

describe("Phase 1 product identity compatibility", () => {
  it("uses the canonical repository in public metadata while retaining migration history", () => {
    const canonicalRepository = IDENTITY_CATALOG.product.future.repository;
    const legacyRepository = "https://github.com/Helweg/opencode-codebase-index";
    const publicUrlFiles = [
      "package.json",
      "README.md",
      "SECURITY.md",
      "TROUBLESHOOTING.md",
      "CHANGELOG.md",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".codex-plugin/plugin.json",
    ];

    expect(IDENTITY_CATALOG.product.current.repository).toBe(canonicalRepository);
    for (const filePath of publicUrlFiles) {
      const contents = readText(filePath);
      expect(contents, filePath).toContain(canonicalRepository);
      expect(contents, filePath).not.toContain(legacyRepository);
    }

    const installation = readText("docs/installation.md");
    expect(installation).toContain("Helweg/open-codebase-index");
    expect(installation).not.toContain("Helweg/opencode-codebase-index");

    expect(readText("docs/rename-to-open-codebase-index.md")).toContain("Helweg/opencode-codebase-index");
  });

  it("uses canonical user-facing defaults for docs, tool banners, and benchmark scaffolding", () => {
    const docsAndArtifacts = {
      agentGuidance: readText("AGENTS.md"),
      architecture: readText("ARCHITECTURE.md"),
      contributing: readText("CONTRIBUTING.md"),
      troubleshooting: readText("TROUBLESHOOTING.md"),
      benchmarkRun: readText("benchmarks/run.ts"),
      benchmarkShell: readText("scripts/benchmark.sh"),
      nativeManifest: readText("native/Cargo.toml"),
      tsupConfig: readText("tsup.config.ts"),
    };

    expect(docsAndArtifacts.agentGuidance).toContain("AI Agent Guidelines for open-codebase-index");
    expect(docsAndArtifacts.agentGuidance).toContain("opencode-codebase-index@0.22.2");
    expect(docsAndArtifacts.agentGuidance).not.toContain("AI Agent Guidelines for opencode-codebase-index");

    expect(docsAndArtifacts.architecture).toContain("open-codebase-index");
    expect(docsAndArtifacts.architecture).not.toContain("opencode-codebase-index");

    expect(docsAndArtifacts.contributing).toContain("Contributing to open-codebase-index");
    expect(docsAndArtifacts.contributing).not.toContain("Contributing to opencode-codebase-index");
    expect(docsAndArtifacts.contributing).toContain("github.com/YOUR_USERNAME/open-codebase-index.git");

    expect(docsAndArtifacts.troubleshooting).toContain("open-codebase-index");
    expect(docsAndArtifacts.troubleshooting).not.toContain("opencode-codebase-index");

    expect(docsAndArtifacts.benchmarkRun).toContain("Synthetic benchmark for open-codebase-index");
    expect(docsAndArtifacts.benchmarkRun).not.toContain("Synthetic benchmark for opencode-codebase-index");

    expect(docsAndArtifacts.benchmarkShell).toContain("Token Usage Benchmark Script for open-codebase-index");
    expect(docsAndArtifacts.benchmarkShell).toContain('"plugin": ["open-codebase-index"]');
    expect(docsAndArtifacts.benchmarkShell).toContain("opencode-codebase-index remains a legacy alias");

    expect(docsAndArtifacts.nativeManifest).toContain("Native Rust core for open-codebase-index");
    expect(docsAndArtifacts.nativeManifest).not.toContain("Native Rust core for opencode-codebase-index");

    expect(docsAndArtifacts.tsupConfig).toContain("// open-codebase-index - Semantic codebase indexing and search");
    expect(docsAndArtifacts.tsupConfig).not.toContain("// opencode-codebase-index - Semantic codebase search for OpenCode");
  });

  it("keeps the checked-in legacy package and host manifests unchanged", () => {
    const current = IDENTITY_CATALOG.product.current;
    const packageJson = readJson<PackageMetadata>("package.json");
    const packageLock = readJson<PackageLockMetadata>("package-lock.json");
    const mcpManifest = readJson<{
      mcpServers: Record<string, { command: string; args: string[] }>;
    }>(".mcp.json");
    const claudeManifest = readJson<ClaudeManifestMetadata & {
      mcpServers: Record<string, { command: string; args: string[] }>;
    }>(".claude-plugin/plugin.json");
    const claudeMarketplace = readJson<{ owner: { url: string } }>(".claude-plugin/marketplace.json");
    const codexManifest = readJson<CodexManifestMetadata>(".codex-plugin/plugin.json");

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
    expect(claudeManifest.author?.url).toBe(current.repository);
    expect(claudeMarketplace.owner.url).toBe(current.repository);
    expect(codexManifest.homepage).toBe(current.repository);
    expect(codexManifest.repository).toBe(current.repository);
    expect(codexManifest.interface.websiteURL).toBe(current.repository);
    expect(codexManifest.author?.url).toBe(current.repository);
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

      expect(readText(path.join(tempDir, "package.json"))).toBe(readText("package.json"));
      expect(readText(path.join(tempDir, "package-lock.json"))).toBe(readText("package-lock.json"));
      expect(readText(path.join(tempDir, ".mcp.json"))).toBe(readText(".mcp.json"));
      expect(readText(path.join(tempDir, ".claude-plugin", "plugin.json"))).toBe(
        readText(".claude-plugin/plugin.json"),
      );
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
      const stagedMcpManifest = readJson<{
        mcpServers: Record<string, { command: string; args: string[] }>;
      }>(path.join(tempDir, ".mcp.json"));
      const stagedClaudeManifest = readJson<ClaudeManifestMetadata & {
        mcpServers: Record<string, { command: string; args: string[] }>;
      }>(path.join(tempDir, ".claude-plugin", "plugin.json"));
      const stagedCodexManifest = readJson<CodexManifestMetadata>(
        path.join(tempDir, ".codex-plugin", "plugin.json"),
      );
      const stagedClaudeMarketplace = readJson<ClaudeMarketplaceMetadata>(
        path.join(tempDir, ".claude-plugin", "marketplace.json"),
      );
      const expectedBin = {
        [IDENTITY_CATALOG.product.future.mcpBinary]: "dist/cli.js",
        [IDENTITY_CATALOG.product.current.mcpBinary]: "dist/cli.js",
      };
      const expectedMcpArgs = [
        "-y",
        "--package",
        IDENTITY_CATALOG.product.future.packageName,
        IDENTITY_CATALOG.product.future.mcpBinary,
        "--host",
        "codex",
      ];
      const expectedClaudeArgs = [
        "-y",
        "--package",
        IDENTITY_CATALOG.product.future.packageName,
        IDENTITY_CATALOG.product.future.mcpBinary,
        "--host",
        "claude",
      ];

      expect(packageJson.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageJson.bin).toEqual(expectedBin);
      expect(packageJson.repository.url).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(packageLock.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageLock.packages[""]?.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageLock.packages[""]?.bin).toEqual(expectedBin);
      expect(stagedMcpManifest.mcpServers["codebase-index"]).toEqual({ command: "npx", args: expectedMcpArgs });
      expect(stagedClaudeManifest.mcpServers["codebase-index"]).toEqual({ command: "npx", args: expectedClaudeArgs });
      expect(stagedClaudeManifest.homepage).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedClaudeManifest.repository).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedClaudeManifest.author?.url).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedCodexManifest.homepage).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedCodexManifest.repository).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedCodexManifest.author?.url).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedCodexManifest.interface.websiteURL).toBe(IDENTITY_CATALOG.product.current.repository);
      expect(stagedClaudeMarketplace.owner.url).toBe(IDENTITY_CATALOG.product.current.repository);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stages metadata with an explicit repository override", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-repo-override-metadata-"));
    const repositoryUrl = "https://github.com/Helweg/open-codebase-index";
    try {
      prepareMetadata(IDENTITY_CATALOG.product.future.packageName, tempDir, repositoryUrl);
      const packageJson = readJson<PackageMetadata>(path.join(tempDir, "package.json"));
      const packageLock = readJson<PackageLockMetadata>(path.join(tempDir, "package-lock.json"));
      const stagedMcpManifest = readJson<{
        mcpServers: Record<string, { command: string; args: string[] }>;
      }>(path.join(tempDir, ".mcp.json"));
      const stagedClaudeManifest = readJson<ClaudeManifestMetadata & {
        mcpServers: Record<string, { command: string; args: string[] }>;
      }>(path.join(tempDir, ".claude-plugin", "plugin.json"));
      const stagedCodexManifest = readJson<CodexManifestMetadata>(
        path.join(tempDir, ".codex-plugin", "plugin.json"),
      );
      const stagedClaudeMarketplace = readJson<ClaudeMarketplaceMetadata>(
        path.join(tempDir, ".claude-plugin", "marketplace.json"),
      );

      expect(packageJson.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageJson.repository.url).toBe(repositoryUrl);
      expect(packageLock.name).toBe(IDENTITY_CATALOG.product.future.packageName);
      expect(packageJson.bin[IDENTITY_CATALOG.product.future.mcpBinary]).toBe("dist/cli.js");
      expect(packageJson.bin[IDENTITY_CATALOG.product.current.mcpBinary]).toBe("dist/cli.js");
      expect(stagedClaudeManifest.homepage).toBe(repositoryUrl);
      expect(stagedClaudeManifest.repository).toBe(repositoryUrl);
      expect(stagedClaudeManifest.author?.url).toBe(repositoryUrl);
      expect(stagedCodexManifest.homepage).toBe(repositoryUrl);
      expect(stagedCodexManifest.repository).toBe(repositoryUrl);
      expect(stagedCodexManifest.author?.url).toBe(repositoryUrl);
      expect(stagedCodexManifest.interface.websiteURL).toBe(repositoryUrl);
      expect(stagedCodexManifest.interface.privacyPolicyURL).toBe(`${repositoryUrl}/blob/main/SECURITY.md`);
      expect(stagedCodexManifest.interface.termsOfServiceURL).toBe(`${repositoryUrl}/blob/main/LICENSE`);
      expect(stagedClaudeMarketplace.owner.url).toBe(repositoryUrl);
      expect(stagedMcpManifest.mcpServers["codebase-index"].args[2]).toBe(IDENTITY_CATALOG.product.future.packageName);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects package identities outside the catalog", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "codebase-index-invalid-metadata-"));
    try {
      expect(() => prepareMetadata("unknown-codebase-index", tempDir)).toThrow();
      expect(() =>
        prepareMetadata(
          IDENTITY_CATALOG.product.current.packageName,
          tempDir,
          "https://invalid.example.com/opencode-codebase-index",
        ),
      ).toThrow();
      expect(() => prepareMetadata(IDENTITY_CATALOG.product.current.packageName, tempDir, "not-a-url")).toThrow();
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
    expect(workflow).not.toContain("inputs:");
    expect(workflow).toContain("for packageName in open-codebase-index opencode-codebase-index;");
    expect(workflow).toContain("if: github.event_name == 'release'");
    expect(workflow).toContain("npm publish --ignore-scripts --access public");
    expect(workflow).toContain("npm view \"${packageName}@${PACKAGE_VERSION}\" --json");
    expect(workflow).toContain("stagingDir=\"${RUNNER_TEMP}/package-metadata/${packageName}\"");
    expect(workflow).toContain("--repository-url \"https://github.com/${GITHUB_REPOSITORY}\"");

    const openFirst = workflow.indexOf("open-codebase-index");
    const legacyAfter = workflow.indexOf("opencode-codebase-index", openFirst + 1);
    expect(openFirst).toBeGreaterThan(-1);
    expect(legacyAfter).toBeGreaterThan(openFirst);
  });
});
