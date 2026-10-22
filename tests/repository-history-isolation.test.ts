import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectFiles, createGitIgnoreFilter, createIgnoreFilter, shouldIncludeFile, shouldTraverseDirectory } from "../src/utils/files.js";
import { createDefaultExcludePatterns } from "../src/config/exclusions.js";
import { buildFileSnapshot } from "../src/watcher/snapshot.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("reserved history cache isolation from code ingestion", () => {
  it.each(["**/*", ".opencode/history/**", ".codebase-index/history/**", ".claude/history/**"])("never collects private history under explicit selection %s, including canonical/symlink aliases", async (selection) => {
    const base = mkdtempSync(path.join(os.tmpdir(), "ocbi-new-history-code-boundary-"));
    roots.push(base);
    const root = path.join(base, "project");
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, ".notes"));
    writeFileSync(path.join(root, "src/keep.ts"), "export const ordinarySource = true;");
    writeFileSync(path.join(root, ".notes/selected.json"), '{"ordinarySelectedSource":true}');
    writeFileSync(path.join(root, ".gitignore"), ".opencode/\n.codebase-index/\n.claude/\n.notes/\n");
    const privateFiles: string[] = [];
    for (const host of [".opencode", ".codebase-index", ".claude"]) {
      const history = path.join(root, host, "history", "source");
      mkdirSync(path.join(history, "fetch-staging"), { recursive: true });
      for (const relative of ["snapshot.json", "fetch-staging/private-body.json"]) {
        const file = path.join(history, relative);
        writeFileSync(file, '{"body":"PRIVATE_HISTORY_ONLY_NEVER_CODE_OR_EMBEDDINGS"}');
        privateFiles.push(file);
      }
    }
    const rootAlias = path.join(base, "project-alias");
    symlinkSync(root, rootAlias, "dir");
    symlinkSync(path.join(root, ".claude/history"), path.join(root, "visible-history-alias"), "dir");
    symlinkSync(privateFiles[0], path.join(root, "visible-private-body.json"));
    const exclude = createDefaultExcludePatterns();
    const selected = [selection, ".notes/**"];
    for (const project of [root, rootAlias]) {
      const options = { purpose: "index" as const, includeExcluded: selected, maxDepth: -1, maxFilesPerDirectory: 1000 };
      const result = await collectFiles(project, ["**/*"], exclude, 1024 * 1024, undefined, options, ["**/*"]);
      const relative = result.files.map((file) => path.relative(project, file.path).split(path.sep).join("/"));
      expect(relative).toContain("src/keep.ts");
      expect(relative).toContain(".notes/selected.json");
      for (const file of result.files) expect(readFileSync(file.path, "utf8")).not.toContain("PRIVATE_HISTORY_ONLY_NEVER_CODE_OR_EMBEDDINGS");
      const ignore = createIgnoreFilter(project);
      const gitIgnore = createGitIgnoreFilter(project);
      for (const host of [".opencode", ".codebase-index", ".claude"]) {
        const history = path.join(project, host, "history");
        expect(shouldTraverseDirectory(history, project, exclude, ignore, ["**/*"], gitIgnore, options)).toBe(false);
        expect(shouldIncludeFile(path.join(history, "source/snapshot.json"), project, ["**/*"], exclude, ignore, ["**/*"], gitIgnore, options)).toBe(false);
      }
      expect(shouldIncludeFile(path.join(project, "visible-private-body.json"), project, ["**/*"], exclude, ignore, ["**/*"], gitIgnore, options)).toBe(false);
      const snapshot = await buildFileSnapshot(project, { include: ["**/*"], additionalInclude: [], exclude, indexing: { includeExcluded: selected, includeIgnored: ["**/*"] } });
      expect(snapshot.has(path.join(project, "src/keep.ts"))).toBe(true);
      for (const file of snapshot.keys()) expect(readFileSync(file, "utf8")).not.toContain("PRIVATE_HISTORY_ONLY_NEVER_CODE_OR_EMBEDDINGS");
    }
    const aliasedCache = await collectFiles(path.join(root, "visible-history-alias"), ["**/*"], [], 1024 * 1024, undefined, { purpose: "index", includeExcluded: ["**/*"], maxDepth: -1, maxFilesPerDirectory: 1000 }, ["**/*"]);
    expect(aliasedCache.files).toEqual([]);
  });
});
