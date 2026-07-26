import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMergedConfig } from "../src/config/merger.js";
import {
  resolveGlobalConfigPath,
  resolveGlobalIndexPath,
  resolveProjectConfigPath,
  resolveProjectIndexPath,
  resolveWritableProjectConfigPath,
} from "../src/config/paths.js";

describe("host-aware path resolution", () => {
  let tempDir: string;
  let homeDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let worktreeGitDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-mode-paths-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-mode-home-"));
    mainRepoDir = path.join(tempDir, "main-repo");
    worktreeDir = path.join(tempDir, "worktree-feature");
    worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x"), { recursive: true });
    fs.mkdirSync(mainRepoDir, { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".git"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x", "y"), "2222222222222222222222222222222222222222\n");

    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature/x/y\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses host-specific writable config paths", () => {
    expect(resolveWritableProjectConfigPath(mainRepoDir, "opencode")).toBe(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
    );
    expect(resolveWritableProjectConfigPath(mainRepoDir, "codex")).toBe(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
    );
    expect(resolveWritableProjectConfigPath(mainRepoDir, "pi")).toBe(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
    );
    expect(resolveWritableProjectConfigPath(mainRepoDir, "jcode")).toBe(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
    );
  });

  it("reads legacy OpenCode config for pi host when pi-native config is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "pi");
    const loaded = loadMergedConfig(mainRepoDir, "pi") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.knowledgeBases).toEqual(["legacy-docs"]);
  });

  it("reads legacy OpenCode config for codex host when codex-native config is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "codex");
    const loaded = loadMergedConfig(mainRepoDir, "codex") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.knowledgeBases).toEqual(["legacy-docs"]);
  });

  it("reads legacy OpenCode config for jcode host when jcode-native config is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "jcode");
    const loaded = loadMergedConfig(mainRepoDir, "jcode") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.knowledgeBases).toEqual(["legacy-docs"]);
  });

  it("prefers codex-native config for codex host when present", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index"), { recursive: true });

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
      JSON.stringify({ knowledgeBases: ["codex-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "codex");
    const loaded = loadMergedConfig(mainRepoDir, "codex") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".codebase-index", "config.json"));
    expect(loaded.knowledgeBases).toEqual(["codex-docs"]);
  });

  it("prefers jcode-native config for jcode host when present", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index"), { recursive: true });

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
      JSON.stringify({ knowledgeBases: ["jcode-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveProjectConfigPath(mainRepoDir, "jcode");
    const loaded = loadMergedConfig(mainRepoDir, "jcode") as Record<string, unknown>;

    expect(resolved).toBe(path.join(mainRepoDir, ".codebase-index", "config.json"));
    expect(loaded.knowledgeBases).toEqual(["jcode-docs"]);
  });

  it("falls back to legacy global config for codex host when codex-native global config is absent", () => {
    fs.mkdirSync(path.join(homeDir, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".config", "opencode", "codebase-index.json"),
      JSON.stringify({ scope: "global", knowledgeBases: ["legacy-global-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveGlobalConfigPath("codex");
    const loaded = loadMergedConfig(mainRepoDir, "codex") as Record<string, unknown>;

    expect(resolved).toBe(path.join(homeDir, ".config", "opencode", "codebase-index.json"));
    expect(loaded.scope).toBe("global");
    expect(loaded.knowledgeBases).toEqual(["legacy-global-docs"]);
  });

  it("falls back to legacy global config for jcode host when jcode-native global config is absent", () => {
    fs.mkdirSync(path.join(homeDir, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".config", "opencode", "codebase-index.json"),
      JSON.stringify({ scope: "global", knowledgeBases: ["legacy-global-docs"] }, null, 2),
      "utf-8",
    );

    const resolved = resolveGlobalConfigPath("jcode");
    const loaded = loadMergedConfig(mainRepoDir, "jcode") as Record<string, unknown>;

    expect(resolved).toBe(path.join(homeDir, ".config", "opencode", "codebase-index.json"));
    expect(loaded.scope).toBe("global");
    expect(loaded.knowledgeBases).toEqual(["legacy-global-docs"]);
  });

  it("falls back to legacy worktree index when codex index is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(worktreeDir, "project", "codex")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });

  it("falls back to legacy worktree index when jcode index is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(worktreeDir, "project", "jcode")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });

  it("falls back to local legacy project index when codex host has only OpenCode project state", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectIndexPath(mainRepoDir, "project", "codex")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });

  it("falls back to local legacy project index when jcode host has only OpenCode project state", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectIndexPath(mainRepoDir, "project", "jcode")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });

  it("uses codex project index when codex-native config exists next to a legacy index", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
      JSON.stringify({ knowledgeBases: ["codex-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectIndexPath(mainRepoDir, "project", "codex")).toBe(
      path.join(mainRepoDir, ".codebase-index", "index"),
    );
  });

  it("uses jcode project index when jcode-native config exists next to a legacy index", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".codebase-index", "config.json"),
      JSON.stringify({ knowledgeBases: ["jcode-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectIndexPath(mainRepoDir, "project", "jcode")).toBe(
      path.join(mainRepoDir, ".codebase-index", "index"),
    );
  });

  it("prefers codex-index inheritance before legacy when both exist", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(worktreeDir, "project", "codex")).toBe(
      path.join(mainRepoDir, ".codebase-index", "index"),
    );
  });

  it("prefers jcode-index inheritance before legacy when both exist", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".codebase-index", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(worktreeDir, "project", "jcode")).toBe(
      path.join(mainRepoDir, ".codebase-index", "index"),
    );
  });

  it("falls back to legacy global index for codex host when codex-native global index is absent", () => {
    fs.mkdirSync(path.join(homeDir, ".opencode", "global-index"), { recursive: true });

    expect(resolveGlobalIndexPath("codex")).toBe(path.join(homeDir, ".opencode", "global-index"));
    expect(resolveProjectIndexPath(mainRepoDir, "global", "codex")).toBe(
      path.join(homeDir, ".opencode", "global-index"),
    );
  });

  it("falls back to legacy global index for jcode host when jcode-native global index is absent", () => {
    fs.mkdirSync(path.join(homeDir, ".opencode", "global-index"), { recursive: true });

    expect(resolveGlobalIndexPath("jcode")).toBe(path.join(homeDir, ".opencode", "global-index"));
    expect(resolveProjectIndexPath(mainRepoDir, "global", "jcode")).toBe(
      path.join(homeDir, ".opencode", "global-index"),
    );
  });

  it("prefers jcode native global index when jcode global config exists even if index is not present", () => {
    fs.mkdirSync(path.join(homeDir, ".config", "codebase-index"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".config", "codebase-index", "config.json"),
      JSON.stringify({ scope: "global" }, null, 2),
      "utf-8",
    );
    fs.mkdirSync(path.join(homeDir, ".opencode", "global-index"), { recursive: true });

    expect(resolveGlobalIndexPath("jcode")).toBe(path.join(homeDir, ".codebase-index", "global-index"));
    expect(resolveProjectIndexPath(mainRepoDir, "global", "jcode")).toBe(
      path.join(homeDir, ".codebase-index", "global-index"),
    );
  });

  it("uses claude-native writable config path", () => {
    expect(resolveWritableProjectConfigPath(mainRepoDir, "claude")).toBe(
      path.join(mainRepoDir, ".claude", "codebase-index.json"),
    );
  });

  it("uses claude-native global paths", () => {
    expect(resolveGlobalConfigPath("claude")).toBe(path.join(homeDir, ".claude", "codebase-index.json"));
    expect(resolveGlobalIndexPath("claude")).toBe(path.join(homeDir, ".claude", "global-index"));
  });

  it("reads legacy OpenCode config for claude host when claude-native config is absent", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectConfigPath(mainRepoDir, "claude")).toBe(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
    );
    const loaded = loadMergedConfig(mainRepoDir, "claude") as Record<string, unknown>;
    expect(loaded.knowledgeBases).toEqual(["legacy-docs"]);
  });

  it("prefers claude-native config for claude host when present", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["legacy-docs"] }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(mainRepoDir, ".claude", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["claude-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectConfigPath(mainRepoDir, "claude")).toBe(
      path.join(mainRepoDir, ".claude", "codebase-index.json"),
    );
    const loaded = loadMergedConfig(mainRepoDir, "claude") as Record<string, unknown>;
    expect(loaded.knowledgeBases).toEqual(["claude-docs"]);
  });

  it("uses claude project index when claude-native config exists next to a legacy index", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(mainRepoDir, ".claude", "codebase-index.json"),
      JSON.stringify({ knowledgeBases: ["claude-docs"] }, null, 2),
      "utf-8",
    );

    expect(resolveProjectIndexPath(mainRepoDir, "project", "claude")).toBe(
      path.join(mainRepoDir, ".claude", "index"),
    );
  });

  it("keeps OpenCode project index path unchanged", () => {
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });

    expect(resolveProjectIndexPath(mainRepoDir, "project", "opencode")).toBe(
      path.join(mainRepoDir, ".opencode", "index"),
    );
  });
});
