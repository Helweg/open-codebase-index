import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadMergedConfig } from "../src/config/merger.js";
import { parseConfig } from "../src/config/schema.js";
import { resolveProjectConfigPath, resolveProjectIndexPath, resolveWritableProjectConfigPath } from "../src/config/paths.js";
import { Indexer } from "../src/indexer/index.js";
import { Database } from "../src/native/index.js";

function snapshotProjectIndex(indexPath: string): {
  stats: ReturnType<Database["getStats"]>;
  branches: Array<{ branch: string; chunks: Array<ReturnType<Database["getChunk"]>> }>;
  fileHashes: string;
} {
  const database = new Database(path.join(indexPath, "codebase.db"));
  try {
    const branches = database.getAllBranches().sort().map((branch) => ({
      branch,
      chunks: database.getBranchChunkIds(branch).sort().map((chunkId) => database.getChunk(chunkId)),
    }));

    return {
      stats: database.getStats(),
      branches,
      fileHashes: fs.readFileSync(path.join(indexPath, "file-hashes.json"), "utf-8"),
    };
  } finally {
    database.close();
  }
}

describe("worktree fallback (issue #60)", () => {
  let tempDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let worktreeGitDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-"));
    mainRepoDir = path.join(tempDir, "main-repo");
    worktreeDir = path.join(tempDir, "worktree-feature");
    worktreeGitDir = path.join(mainRepoDir, ".git", "worktrees", "feature");

    fs.mkdirSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x"), { recursive: true });
    fs.mkdirSync(path.join(mainRepoDir, ".opencode", "index"), { recursive: true });
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    fs.writeFileSync(path.join(mainRepoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "main"), "1111111111111111111111111111111111111111\n");
    fs.writeFileSync(path.join(mainRepoDir, ".git", "refs", "heads", "feature", "x", "y"), "2222222222222222222222222222222222222222\n");
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);
    fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature/x/y\n");
    fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          scope: "project",
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: ["docs/reference"],
        },
        null,
        2
      ),
      "utf-8"
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads project config from the main repo when the worktree has no local config", () => {
    const configPath = resolveProjectConfigPath(worktreeDir);
    const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

    expect(configPath).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(loaded.scope).toBe("project");
    expect(loaded.additionalInclude).toEqual(["docs/**/*.md"]);
    expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("throws a file-specific error when the inherited project config is malformed", () => {
    const configPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(configPath, '{"embeddingProvider":"custom",', "utf-8");

    expect(() => loadMergedConfig(worktreeDir)).toThrow(
      new RegExp(`Failed to load config file ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  });

  it("throws a file-specific error when the inherited project config has an invalid shape", () => {
    const configPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
    fs.writeFileSync(configPath, JSON.stringify({ knowledgeBases: "docs/reference" }, null, 2), "utf-8");

    expect(() => loadMergedConfig(worktreeDir)).toThrow(/field 'knowledgeBases' must be an array of strings/);
  });

  it("throws a file-specific error when the global config is malformed", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-home-"));

    try {
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("USERPROFILE", homeDir);
      const globalConfigPath = path.join(homeDir, ".config", "opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, '{"debug":', "utf-8");

      const repoConfigPath = path.join(mainRepoDir, ".opencode", "codebase-index.json");
      fs.rmSync(repoConfigPath, { force: true });

      expect(() => loadMergedConfig(worktreeDir)).toThrow(
        new RegExp(`Failed to load config file ${globalConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to project config when the global config is malformed", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-fallback-home-"));

    try {
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("USERPROFILE", homeDir);
      const globalConfigPath = path.join(homeDir, ".config", "opencode", "codebase-index.json");
      fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
      fs.writeFileSync(globalConfigPath, '{"debug":', "utf-8");

      const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

      expect(loaded.scope).toBe("project");
      expect(loaded.additionalInclude).toEqual(["docs/**/*.md"]);
      expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps project object overrides as wholesale replacements instead of deep-merging", () => {
    vi.stubEnv("HOME", tempDir);
    vi.stubEnv("USERPROFILE", tempDir);
    const globalConfigPath = path.join(tempDir, ".config", "opencode", "codebase-index.json");

    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify(
        {
          indexing: {
            autoIndex: true,
            maxFileSize: 12345,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          indexing: {
            watchFiles: false,
          },
        },
        null,
        2,
      ),
      "utf-8"
    );

    const loaded = loadMergedConfig(worktreeDir) as {
      indexing?: Record<string, unknown>;
    };

    expect(loaded.indexing).toEqual({ watchFiles: false });
  });

  it("rebases inherited absolute repo-local knowledge bases onto the worktree", () => {
    const absoluteRepoLocalKb = path.join(mainRepoDir, "docs", "reference");

    fs.writeFileSync(
      path.join(mainRepoDir, ".opencode", "codebase-index.json"),
      JSON.stringify(
        {
          embeddingProvider: "custom",
          customProvider: {
            baseUrl: "http://localhost:11434/v1",
            model: "mock-model",
            dimensions: 8,
          },
          scope: "project",
          indexing: {
            watchFiles: false,
          },
          additionalInclude: ["docs/**/*.md"],
          knowledgeBases: [absoluteRepoLocalKb],
        },
        null,
        2
      ),
      "utf-8"
    );

    const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

    expect(loaded.knowledgeBases).toEqual(["docs/reference"]);
  });

  it("keeps the project index local when the worktree inherits its config", async () => {
    const config = parseConfig(loadMergedConfig(worktreeDir));
    const indexer = new Indexer(worktreeDir, config);
    try {
      const status = await indexer.getStatus();

      expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(path.join(worktreeDir, ".opencode", "index"));
      expect(status.indexPath).toBe(path.join(worktreeDir, ".opencode", "index"));
      expect(status.currentBranch).toBe("feature/x/y");
    } finally {
      await indexer.close();
    }
  });

  it("does not mutate the main index when indexing and searching from a worktree", async () => {
    const homeDir = path.join(tempDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("USERPROFILE", homeDir);

    const sourceContent = "export function worktreeIsolationMarker() { return 'isolated-worktree-index'; }\n";
    const mainSourcePath = path.join(mainRepoDir, "src", "worktree-marker.ts");
    const worktreeSourcePath = path.join(worktreeDir, "src", "worktree-marker.ts");
    fs.mkdirSync(path.dirname(mainSourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(worktreeSourcePath), { recursive: true });
    fs.writeFileSync(mainSourcePath, sourceContent, "utf-8");
    fs.writeFileSync(worktreeSourcePath, sourceContent, "utf-8");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const texts = Array.isArray(body.input) ? body.input : [];
      const data = texts.map((text) => {
        const seed = Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0);
        return {
          embedding: Array.from({ length: 8 }, (_, index) => ((seed + index * 17) % 997) / 997),
        };
      });

      return new Response(JSON.stringify({
        data,
        usage: { total_tokens: Math.max(1, texts.length * 8) },
      }), { status: 200 });
    });

    const mainConfig = parseConfig(loadMergedConfig(mainRepoDir));
    const worktreeConfig = parseConfig(loadMergedConfig(worktreeDir));
    const mainIndexer = new Indexer(mainRepoDir, mainConfig);
    const worktreeIndexer = new Indexer(worktreeDir, worktreeConfig);
    const indexers = [mainIndexer, worktreeIndexer];

    try {
      await mainIndexer.index();
      await mainIndexer.close();

      const mainIndexPath = path.join(mainRepoDir, ".opencode", "index");
      const mainSnapshotBefore = snapshotProjectIndex(mainIndexPath);

      await worktreeIndexer.index();
      await worktreeIndexer.close();

      const worktreeIndexPath = path.join(worktreeDir, ".opencode", "index");
      expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(worktreeIndexPath);
      expect(snapshotProjectIndex(mainIndexPath)).toEqual(mainSnapshotBefore);

      const worktreeSnapshot = snapshotProjectIndex(worktreeIndexPath);
      const worktreeChunks = worktreeSnapshot.branches.flatMap((entry) => entry.chunks);
      expect(worktreeChunks.length).toBeGreaterThan(0);
      expect(worktreeChunks.every((chunk) =>
        chunk !== null && chunk.filePath.startsWith(`${path.resolve(worktreeDir)}${path.sep}`)
      )).toBe(true);

      const mainReader = new Indexer(mainRepoDir, mainConfig);
      const worktreeReader = new Indexer(worktreeDir, worktreeConfig);
      indexers.push(mainReader, worktreeReader);
      const [mainResults, worktreeResults] = await Promise.all([
        mainReader.search("worktreeIsolationMarker", 5, { metadataOnly: true, filterByBranch: false }),
        worktreeReader.search("worktreeIsolationMarker", 5, { metadataOnly: true, filterByBranch: false }),
      ]);

      expect(mainResults[0]?.filePath).toBe(mainSourcePath);
      expect(worktreeResults[0]?.filePath).toBe(worktreeSourcePath);
    } finally {
      await Promise.all(indexers.map((indexer) => indexer.close()));
      fetchSpy.mockRestore();
    }
  });

  it("keeps explicit worktree-local config and index when they exist", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, ".opencode", "codebase-index.json"),
      JSON.stringify({ scope: "project", knowledgeBases: ["worktree-only"] }, null, 2),
      "utf-8"
    );

    const configPath = resolveProjectConfigPath(worktreeDir);
    const indexPath = resolveProjectIndexPath(worktreeDir, "project");
    const loaded = loadMergedConfig(worktreeDir) as Record<string, unknown>;

    expect(configPath).toBe(path.join(worktreeDir, ".opencode", "codebase-index.json"));
    expect(indexPath).toBe(path.join(worktreeDir, ".opencode", "index"));
    expect(loaded.knowledgeBases).toEqual(["worktree-only"]);
  });

  it("keeps a worktree-local config on a local worktree index boundary", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });

    expect(resolveWritableProjectConfigPath(worktreeDir)).toBe(path.join(worktreeDir, ".opencode", "codebase-index.json"));
    expect(resolveProjectConfigPath(worktreeDir)).toBe(path.join(mainRepoDir, ".opencode", "codebase-index.json"));
    expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(path.join(worktreeDir, ".opencode", "index"));
  });

  it("keeps explicit worktree-local config and index when they exist", () => {
    fs.mkdirSync(path.join(worktreeDir, ".opencode", "index"), { recursive: true });

    fs.writeFileSync(
      path.join(worktreeDir, ".opencode", "codebase-index.json"),
      JSON.stringify({
        embeddingProvider: "custom",
        customProvider: {
          baseUrl: "http://localhost:11434/v1",
          model: "worktree-model",
          dimensions: 16,
        },
        scope: "project",
      }, null, 2),
      "utf-8"
    );

    expect(resolveProjectIndexPath(worktreeDir, "project")).toBe(path.join(worktreeDir, ".opencode", "index"));
  });
});
