import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostMode } from "../src/config/host.js";
import {
  getHostProjectConfigRelativePath,
  getHostProjectIndexRelativePath,
  resolveProjectConfigPath,
  resolveProjectIndexPath,
} from "../src/config/paths.js";

const gitMocks = vi.hoisted(() => ({
  resolveWorktreeMainRepoRoot: vi.fn<() => string | null>(() => null),
}));

vi.mock("../src/git/index.js", () => gitMocks);

describe("host path conformance", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-paths-"));
    gitMocks.resolveWorktreeMainRepoRoot.mockReset();
    gitMocks.resolveWorktreeMainRepoRoot.mockReturnValue(null);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses host-native project config and index paths", () => {
    const cases: ReadonlyArray<{
      readonly host: HostMode;
      readonly configPath: string;
      readonly indexPath: string;
    }> = [
      { host: "opencode", configPath: path.join(".opencode", "codebase-index.json"), indexPath: path.join(".opencode", "index") },
      { host: "claude", configPath: path.join(".claude", "codebase-index.json"), indexPath: path.join(".claude", "index") },
      { host: "codex", configPath: path.join(".codebase-index", "config.json"), indexPath: path.join(".codebase-index", "index") },
      { host: "pi", configPath: path.join(".codebase-index", "config.json"), indexPath: path.join(".codebase-index", "index") },
      { host: "jcode", configPath: path.join(".codebase-index", "config.json"), indexPath: path.join(".codebase-index", "index") },
    ];

    for (const entry of cases) {
      expect(getHostProjectConfigRelativePath(entry.host)).toBe(entry.configPath);
      expect(getHostProjectIndexRelativePath(entry.host)).toBe(entry.indexPath);
      expect(resolveProjectConfigPath(tempDir, entry.host)).toBe(path.join(tempDir, entry.configPath));
      expect(resolveProjectIndexPath(tempDir, "project", entry.host)).toBe(path.join(tempDir, entry.indexPath));
    }
  });

  it("lets non-OpenCode hosts reuse legacy OpenCode state until host config exists", () => {
    const legacyConfig = path.join(tempDir, ".opencode", "codebase-index.json");
    const legacyIndex = path.join(tempDir, ".opencode", "index");
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.mkdirSync(legacyIndex, { recursive: true });
    fs.writeFileSync(legacyConfig, "{}", "utf-8");

    expect(resolveProjectConfigPath(tempDir, "codex")).toBe(legacyConfig);
    expect(resolveProjectIndexPath(tempDir, "project", "codex")).toBe(legacyIndex);

    expect(resolveProjectConfigPath(tempDir, "jcode")).toBe(legacyConfig);
    expect(resolveProjectIndexPath(tempDir, "project", "jcode")).toBe(legacyIndex);

    const codexConfig = path.join(tempDir, ".codebase-index", "config.json");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, "{}", "utf-8");

    expect(resolveProjectConfigPath(tempDir, "codex")).toBe(codexConfig);
    expect(resolveProjectIndexPath(tempDir, "project", "codex")).toBe(path.join(tempDir, ".codebase-index", "index"));

    expect(resolveProjectConfigPath(tempDir, "jcode")).toBe(path.join(tempDir, ".codebase-index", "config.json"));
    expect(resolveProjectIndexPath(tempDir, "project", "jcode")).toBe(path.join(tempDir, ".codebase-index", "index"));
  });
});
