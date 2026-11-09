import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isProjectIndexPathOwnedByProject, resolveProjectIndexPath } from "../src/config/paths.js";
import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";

describe("indexPath config option", () => {
  it("keeps an absolute path and expands ~/", () => {
    const absolute = path.join(os.tmpdir(), "configured-index");
    expect(parseConfig({ indexPath: absolute }).indexPath).toBe(absolute);
    expect(parseConfig({ indexPath: "~/indexes/repo" }).indexPath).toBe(path.join(os.homedir(), "indexes", "repo"));
    expect(parseConfig({}).indexPath).toBeUndefined();
    expect(parseConfig({ indexPath: "" }).indexPath).toBeUndefined();
  });

  it("rejects a relative path", () => {
    expect(() => parseConfig({ indexPath: "indexes/repo" })).toThrow("indexPath must be an absolute path");
  });
});

describe("configured index path", () => {
  let tempDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let indexPath: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "configured-index-path-")));
    mainRepoDir = path.join(tempDir, "main-repo");
    worktreeDir = path.join(tempDir, "worktree-feature");
    indexPath = path.join(tempDir, "outside", "index");
    const worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("replaces the default location for the main checkout and its worktrees", () => {
    for (const root of [mainRepoDir, worktreeDir]) {
      expect(resolveProjectIndexPath(root, "project", "claude", indexPath)).toBe(indexPath);
      expect(resolveProjectIndexPath(root, "global", "claude", indexPath)).toBe(indexPath);
    }
  });

  it("is owned by the main checkout and inherited by worktrees", () => {
    expect(isProjectIndexPathOwnedByProject(mainRepoDir, indexPath, "claude", indexPath)).toBe(true);
    expect(isProjectIndexPathOwnedByProject(worktreeDir, indexPath, "claude", indexPath)).toBe(false);
  });

  it("indexes into the configured directory, writes nothing in the checkout, and shares it with worktrees", async () => {
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);

    const source = "export function configuredIndexMarker() { return 'outside'; }\n";
    for (const root of [mainRepoDir, worktreeDir]) {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "marker.ts"), source, "utf-8");
    }

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        const seed = Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0);
        return { embedding: Array.from({ length: 8 }, (_, index) => ((seed + index * 17) % 997) / 997) };
      });
      return new Response(JSON.stringify({ data, usage: { total_tokens: Math.max(1, texts.length * 8) } }), { status: 200 });
    });

    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: { baseUrl: "http://localhost:11434/v1", model: "mock-model", dimensions: 8 },
      scope: "project",
      indexPath,
      indexing: { watchFiles: false, requireProjectMarker: false },
    });
    const mainIndexer = new Indexer(mainRepoDir, config, "claude");
    const worktreeIndexer = new Indexer(worktreeDir, config, "claude");

    try {
      const mainStats = await mainIndexer.index();
      const requestsAfterMain = fetchSpy.mock.calls.length;
      const worktreeStats = await worktreeIndexer.index();

      expect(mainStats.indexedChunks).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(indexPath, "codebase.db"))).toBe(true);
      expect(fs.existsSync(path.join(mainRepoDir, ".claude"))).toBe(false);
      expect(fs.existsSync(path.join(worktreeDir, ".claude"))).toBe(false);
      expect(worktreeStats.tokensUsed).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(requestsAfterMain);
      expect((await worktreeIndexer.getStatus()).indexPath).toBe(indexPath);

      const results = await worktreeIndexer.search("configuredIndexMarker", 5, { metadataOnly: true });
      expect(results.find((result) => result.name === "configuredIndexMarker")?.filePath)
        .toBe(path.join(worktreeDir, "src", "marker.ts"));
    } finally {
      await Promise.all([mainIndexer.close(), worktreeIndexer.close()]);
      fetchSpy.mockRestore();
    }
  });
});
