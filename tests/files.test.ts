import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  collectFiles,
  createGitIgnoreFilter,
  createIgnoreFilter,
  hasProjectMarker,
  shouldIncludeFile,
  shouldTraverseDirectory,
} from "../src/utils/files.js";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from "../src/config/constants.js";
import { createDefaultExcludePatterns } from "../src/config/exclusions.js";

describe("files utilities", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createIgnoreFilter", () => {
    it("should ignore node_modules by default", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(filter.ignores("node_modules/package/index.js")).toBe(true);
      expect(filter.ignores("src/index.ts")).toBe(false);
    });

    it("should read .gitignore file", () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "*.log\nbuild/\n");
      const filter = createIgnoreFilter(tempDir);

      expect(filter.ignores("debug.log")).toBe(true);
      expect(filter.ignores("build/output.js")).toBe(true);
      expect(filter.ignores("src/main.ts")).toBe(false);
    });

  });

  describe("shouldIncludeFile", () => {
    it("should include files matching include patterns", () => {
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts", "**/*.js"];
      const excludePatterns = ["**/node_modules/**"];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "src/index.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(true);
      expect(shouldIncludeFile(
        path.join(tempDir, "rebuild.ts"),
        tempDir,
        includePatterns,
        excludePatterns,
        filter,
      )).toBe(true);
    });

    it("should exclude files matching exclude patterns", () => {
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts"];
      const excludePatterns = ["**/*.test.ts"];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "src/index.test.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(false);
    });

    it("should exclude files under a directory glob even when include matches", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(
        shouldIncludeFile(
          path.join(tempDir, "toms_common", "huge.sql"),
          tempDir,
          ["**/*.sql"],
          ["**/toms_common/**"],
          filter
        )
      ).toBe(false);
    });

    it("should respect gitignore", () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "ignored/\n");
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts"];
      const excludePatterns: string[] = [];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "ignored/file.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(false);
    });

    it("should include root-level files with dots in their names", () => {
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.{ts,tsx,js,jsx,mjs,cjs}"];
      const excludePatterns = ["**/.*"];

      expect(
        shouldIncludeFile(
          path.join(tempDir, "watcher.probe.ts"),
          tempDir,
          includePatterns,
          excludePatterns,
          filter
        )
      ).toBe(true);
    });

    it("should include Metal shader files by default", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(
        shouldIncludeFile(
          path.join(tempDir, "shaders", "compute.metal"),
          tempDir,
          DEFAULT_INCLUDE,
          DEFAULT_EXCLUDE,
          filter
        )
      ).toBe(true);
    });

    it("should NOT include MATLAB .m files by default (opt-in required)", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(
        shouldIncludeFile(
          path.join(tempDir, "src", "calculateSignal.m"),
          tempDir,
          DEFAULT_INCLUDE,
          DEFAULT_EXCLUDE,
          filter
        )
      ).toBe(false);
    });

    it("should keep XML and SVG opt-in through additionalInclude", () => {
      const filter = createIgnoreFilter(tempDir);
      const xmlFile = path.join(tempDir, "config", "service.xml");
      const svgFile = path.join(tempDir, "assets", "diagram.svg");

      for (const filePath of [xmlFile, svgFile]) {
        expect(
          shouldIncludeFile(filePath, tempDir, DEFAULT_INCLUDE, DEFAULT_EXCLUDE, filter),
        ).toBe(false);
      }
      expect(
        shouldIncludeFile(
          xmlFile,
          tempDir,
          [...DEFAULT_INCLUDE, "**/*.xml", "**/*.svg"],
          DEFAULT_EXCLUDE,
          filter,
        ),
      ).toBe(true);
      expect(
        shouldIncludeFile(
          svgFile,
          tempDir,
          [...DEFAULT_INCLUDE, "**/*.xml", "**/*.svg"],
          DEFAULT_EXCLUDE,
          filter,
        ),
      ).toBe(true);
    });

    it("should include MATLAB .m files when opted in via additionalInclude", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(
        shouldIncludeFile(
          path.join(tempDir, "src", "calculateSignal.m"),
          tempDir,
          [...DEFAULT_INCLUDE, "**/*.m"],
          DEFAULT_EXCLUDE,
          filter
        )
      ).toBe(true);
    });

    it("should include Swift files by default", () => {
      const filter = createIgnoreFilter(tempDir);

      expect(
        shouldIncludeFile(
          path.join(tempDir, "Sources", "App.swift"),
          tempDir,
          DEFAULT_INCLUDE,
          DEFAULT_EXCLUDE,
          filter
        )
      ).toBe(true);
    });

    it("includes only selected automatic exclusions while explicit equal defaults win", () => {
      const filter = createIgnoreFilter(tempDir);
      const includePatterns = ["**/*.ts"];
      const derivedDefaults = createDefaultExcludePatterns();
      const options = { includeExcluded: ["BUILD-source/index.ts"], purpose: "watch" as const };

      expect(shouldIncludeFile(
        path.join(tempDir, "BUILD-source", "index.ts"),
        tempDir,
        includePatterns,
        derivedDefaults,
        filter,
        [],
        undefined,
        options,
      )).toBe(true);
      expect(shouldIncludeFile(
        path.join(tempDir, "BUILD-source", "sibling.ts"),
        tempDir,
        includePatterns,
        derivedDefaults,
        filter,
        [],
        undefined,
        options,
      )).toBe(false);
      expect(shouldIncludeFile(
        path.join(tempDir, "vendor", "index.ts"),
        tempDir,
        includePatterns,
        [...DEFAULT_EXCLUDE],
        filter,
        [],
        undefined,
        { includeExcluded: ["vendor/index.ts"] },
      )).toBe(false);

      for (const explicitExcludes of [[], ["unrelated/**"]]) {
        expect(shouldIncludeFile(
          path.join(tempDir, "BUILD-source", "index.ts"),
          tempDir,
          includePatterns,
          explicitExcludes,
          filter,
          [],
          undefined,
          options,
        )).toBe(true);
      }
    });

    it("requires the independent Git opt-in when a selected automatic path is gitignored", () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "vendor/\n");
      const filter = createIgnoreFilter(tempDir);
      const gitFilter = createGitIgnoreFilter(tempDir);
      const filePath = path.join(tempDir, "vendor", "selected.ts");
      const options = { includeExcluded: ["vendor/selected.ts"] };

      expect(shouldIncludeFile(
        filePath, tempDir, ["**/*.ts"], createDefaultExcludePatterns(), filter, [], gitFilter, options,
      )).toBe(false);
      expect(shouldIncludeFile(
        filePath,
        tempDir,
        ["**/*.ts"],
        createDefaultExcludePatterns(),
        filter,
        ["vendor/selected.ts"],
        gitFilter,
        options,
      )).toBe(true);
    });

    it("rejects uppercase and symlink-aliased protected metadata paths", () => {
      const derivedDefaults = createDefaultExcludePatterns();
      const options = { includeExcluded: ["**/*.ts"] };
      const filter = createIgnoreFilter(tempDir);
      const uppercaseGitFile = path.join(tempDir, ".GIT", "selected.ts");
      fs.mkdirSync(path.dirname(uppercaseGitFile), { recursive: true });
      fs.writeFileSync(uppercaseGitFile, "metadata");

      const indexRoot = path.join(tempDir, ".opencode", "index");
      fs.mkdirSync(indexRoot, { recursive: true });
      fs.writeFileSync(path.join(indexRoot, "selected.ts"), "index");
      const aliasRoot = path.join(tempDir, "index-alias");
      fs.symlinkSync(indexRoot, aliasRoot, "dir");

      for (const filePath of [uppercaseGitFile, path.join(aliasRoot, "selected.ts")]) {
        expect(shouldIncludeFile(
          filePath,
          tempDir,
          ["**/*.ts"],
          derivedDefaults,
          filter,
          [],
          undefined,
          options,
        )).toBe(false);
      }
    });
  });

  describe("collectFiles", () => {
    it("preserves builder and rebuild sources under defaults without admitting generated or ignored directories", async () => {
      const sources = [
        "build.rs",
        "build.gradle",
        "clap_builder/src/lib.rs",
        "packages/clap_builder/src/build.rs",
        "builder/index.ts",
        "rebuilding/index.ts",
        "rebuild/index.ts",
        "packages/rebuild/index.ts",
      ];
      const blockedDirectories = [
        "build", "build-debug", "build_debug", "app-build", "_build",
        "cmake-build-debug", "app-build_debug", "app_build-debug", "app_build_debug",
        "packages/build", "packages/cmake-build-debug", "packages/BUILD_debug",
        "node_modules/pkg", "vendor/pkg", "target", "dist", "coverage",
        "__pycache__", ".next", ".hidden", "packages/.cache",
      ];
      const ignoredSource = "clap_builder/ignored-production/index.ts";
      for (const relativePath of [
        ...sources,
        ...blockedDirectories.map((directory) => `${directory}/nested/output.ts`),
        ignoredSource,
      ]) {
        const filePath = path.join(tempDir, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "source");
      }
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "clap_builder/ignored-production/\n");
      const includePatterns = [...DEFAULT_INCLUDE, "**/*.gradle"];

      const result = await collectFiles(tempDir, includePatterns, DEFAULT_EXCLUDE, 1048576);
      expect(result.files.map((file) => path.relative(tempDir, file.path)).sort()).toEqual(
        sources.map((relativePath) => path.normalize(relativePath)).sort(),
      );

      const includeIgnoredResult = await collectFiles(
        tempDir, includePatterns, DEFAULT_EXCLUDE, 1048576,
        undefined, undefined, blockedDirectories.map((directory) => `${directory}/**`),
      );
      expect(includeIgnoredResult.files.map((file) => path.relative(tempDir, file.path)).sort()).toEqual(
        sources.map((relativePath) => path.normalize(relativePath)).sort(),
      );
    });

    it("shares builder and generated-directory eligibility between indexing and watching", () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "clap_builder/ignored-production/\n");
      const filter = createIgnoreFilter(tempDir);
      const gitFilter = createGitIgnoreFilter(tempDir);
      for (const purpose of ["index", "watch"] as const) {
        for (const directory of ["clap_builder/src", "packages/builder", "rebuilding", "rebuild"]) {
          expect(shouldTraverseDirectory(
            path.join(tempDir, directory), tempDir, DEFAULT_EXCLUDE, filter, [], gitFilter, { purpose },
          )).toBe(true);
          expect(shouldIncludeFile(
            path.join(tempDir, directory, "build.rs"), tempDir, DEFAULT_INCLUDE,
            DEFAULT_EXCLUDE, filter, [], gitFilter, { purpose },
          )).toBe(true);
        }
        for (const directory of [
          "build", "build_debug", "app-build", "packages/cmake-build-debug",
          "packages/app-build_debug", "packages/app_build-debug", "packages/app_build_debug",
          "packages/BUILD_debug", "node_modules/pkg", "vendor/pkg", ".hidden", "packages/.cache",
        ]) {
          expect(shouldTraverseDirectory(
            path.join(tempDir, directory), tempDir, DEFAULT_EXCLUDE, filter, ["**"], gitFilter, { purpose },
          )).toBe(false);
          expect(shouldIncludeFile(
            path.join(tempDir, directory, "index.ts"), tempDir, DEFAULT_INCLUDE,
            DEFAULT_EXCLUDE, filter, ["**"], gitFilter, { purpose },
          )).toBe(false);
        }
        expect(shouldIncludeFile(
          path.join(tempDir, "clap_builder/ignored-production/index.ts"), tempDir,
          DEFAULT_INCLUDE, DEFAULT_EXCLUDE, filter, [], gitFilter, { purpose },
        )).toBe(false);
        expect(shouldIncludeFile(
          path.join(tempDir, "rebuild/index.ts"), tempDir, DEFAULT_INCLUDE,
          [...DEFAULT_EXCLUDE, "**/rebuild/**"], filter, ["**"], gitFilter, { purpose },
        )).toBe(false);
      }
    });

    it("should discover root and nested reStructuredText files by default without weakening filters", async () => {
      fs.mkdirSync(path.join(tempDir, "docs", "nested"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "docs", "drafts"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "ignored"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "node_modules", "package"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "ignored/\n");
      fs.writeFileSync(path.join(tempDir, "index.rst"), "Project documentation");
      fs.writeFileSync(path.join(tempDir, "docs", "nested", "guide.rst"), "Nested guide");
      fs.writeFileSync(path.join(tempDir, "docs", "drafts", "proposal.rst"), "Draft proposal");
      fs.writeFileSync(path.join(tempDir, "ignored", "hidden.rst"), "Ignored guide");
      fs.writeFileSync(path.join(tempDir, "node_modules", "package", "README.rst"), "Dependency docs");

      const result = await collectFiles(
        tempDir,
        DEFAULT_INCLUDE,
        [...DEFAULT_EXCLUDE, "**/drafts/**"],
        1048576
      );

      expect(result.files.map((file) => path.relative(tempDir, file.path)).sort()).toEqual([
        path.join("docs", "nested", "guide.rst"),
        "index.rst",
      ]);
    });

    it("should respect custom includes", async () => {
      fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "docs", "guide.rst"), "Guide");
      fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const value = 1;");

      const result = await collectFiles(tempDir, ["**/*.ts"], DEFAULT_EXCLUDE, 1048576);

      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("src", "index.ts"),
      ]);
    });

    it("should collect matching files", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(tempDir, "src/util.ts"), "export const y = 2;");
      fs.writeFileSync(path.join(tempDir, "readme.md"), "# README");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        1048576
      );

      expect(result.files.length).toBe(2);
      expect(result.files.some((f) => f.path.endsWith("index.ts"))).toBe(true);
      expect(result.files.some((f) => f.path.endsWith("util.ts"))).toBe(true);
    });

    it("should collect parser-backed source extensions by default", async () => {
      const fileNames = ["module.mts", "module.cts", "widget.cxx", "widget.hxx", "Service.cs"];
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      for (const fileName of fileNames) {
        fs.writeFileSync(path.join(tempDir, "src", fileName), "source");
      }

      const result = await collectFiles(
        tempDir,
        DEFAULT_INCLUDE,
        DEFAULT_EXCLUDE,
        1048576
      );

      expect(result.files.map((file) => path.basename(file.path)).sort()).toEqual(
        [...fileNames].sort()
      );
    });

    it("should skip files exceeding max size", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/small.ts"), "x");
      fs.writeFileSync(path.join(tempDir, "src/large.ts"), "x".repeat(1000));

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        500
      );

      expect(result.files.length).toBe(1);
      expect(result.files[0].path.endsWith("small.ts")).toBe(true);
      expect(result.skipped.some((s) => s.reason === "too_large")).toBe(true);
    });

    it("preserves legacy skipped diagnostics and ignore-before-size precedence", async () => {
      for (const directory of ["ignored-dir", "build-dir", ".hidden-dir", "vendor"]) {
        fs.mkdirSync(path.join(tempDir, directory), { recursive: true });
      }
      fs.writeFileSync(
        path.join(tempDir, ".gitignore"),
        "ignored-dir\nignored-large.ts\ngit-opted-excluded.ts\n",
      );
      fs.writeFileSync(path.join(tempDir, "notes.md"), "miss");
      fs.writeFileSync(path.join(tempDir, ".hidden.ts"), "hidden root");
      fs.writeFileSync(path.join(tempDir, "ignored-dir", "nested.ts"), "ignored directory");
      fs.writeFileSync(path.join(tempDir, "build-dir", "nested.ts"), "build directory");
      fs.writeFileSync(path.join(tempDir, ".hidden-dir", "nested.ts"), "hidden directory");
      fs.writeFileSync(path.join(tempDir, "ignored-large.ts"), "x".repeat(100));
      fs.writeFileSync(path.join(tempDir, "large.ts"), "x".repeat(100));
      fs.writeFileSync(path.join(tempDir, "excluded.ts"), "excluded");
      fs.writeFileSync(path.join(tempDir, "git-opted-excluded.ts"), "excluded");
      fs.writeFileSync(path.join(tempDir, "vendor", "selected.ts"), "selected");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        ["excluded.ts", "git-opted-excluded.ts"],
        10,
        undefined,
        {
          maxDepth: -1,
          maxFilesPerDirectory: 100,
          includeExcluded: ["vendor/selected.ts"],
        },
        ["git-opted-excluded.ts"],
      );

      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("vendor", "selected.ts"),
      ]);
      expect(new Map(result.skipped.map((entry) => [entry.path, entry.reason]))).toEqual(new Map([
        [".hidden-dir", "excluded"],
        ["build-dir", "excluded"],
        ["excluded.ts", "excluded"],
        ["git-opted-excluded.ts", "excluded"],
        ["ignored-large.ts", "gitignore"],
        ["large.ts", "too_large"],
      ]));
    });

    it("should handle empty directory", async () => {
      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        1048576
      );

      expect(result.files.length).toBe(0);
      expect(result.skipped.length).toBe(0);
    });

    it("should handle multiple include patterns", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src/index.ts"), "ts");
      fs.writeFileSync(path.join(tempDir, "src/util.js"), "js");
      fs.writeFileSync(path.join(tempDir, "src/style.css"), "css");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.js"],
        [],
        1048576
      );

      expect(result.files.length).toBe(2);
      expect(result.files.some((f) => f.path.endsWith(".css"))).toBe(false);
    });

    it("should collect root-level files with **/*.ext pattern", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "root.js"), "root");
      fs.writeFileSync(path.join(tempDir, "build-helper.js"), "build helper");
      fs.writeFileSync(path.join(tempDir, "src/nested.js"), "nested");

      const result = await collectFiles(
        tempDir,
        ["**/*.js"],
        [],
        1048576
      );

      expect(result.files.length).toBe(3);
      expect(result.files.some((f) => f.path.endsWith("root.js"))).toBe(true);
      expect(result.files.some((f) => f.path.endsWith("build-helper.js"))).toBe(true);
      expect(result.files.some((f) => f.path.endsWith("nested.js"))).toBe(true);
    });

    it("should omit files that match exclude even when they also match include", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "toms_common"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(tempDir, "toms_common", "huge.sql"), "SELECT 1;");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.sql"],
        ["**/toms_common/**"],
        1048576
      );

      expect(result.files.map((file) => path.basename(file.path))).toEqual(["index.ts"]);
      expect(result.files.some((file) => file.path.includes("toms_common"))).toBe(false);
      expect(result.skipped.some((entry) => (
        entry.reason === "excluded" && entry.path.replace(/\\/g, "/").includes("toms_common")
      ))).toBe(true);
    });

    it("should omit exclude matches after a non-matching earlier exclude pattern", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "common", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "keep.ts"), "export const keep = true;");
      fs.writeFileSync(path.join(tempDir, "common", "scripts", "bulk.sql"), "SELECT 1;");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.sql"],
        ["**/generated/**", "**/common/scripts/**"],
        1048576
      );

      expect(result.files.map((file) => path.basename(file.path))).toEqual(["keep.ts"]);
      expect(result.files.some((file) => file.path.endsWith("bulk.sql"))).toBe(false);
    });

    it("should skip walking a directory covered by a /** exclude glob", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "toms_common", "nested"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(tempDir, "toms_common", "nested", "deep.sql"), "SELECT 1;");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.sql"],
        ["**/toms_common/**"],
        1048576
      );

      expect(result.files.map((file) => path.basename(file.path))).toEqual(["index.ts"]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "toms_common", reason: "excluded" }),
        ])
      );
      expect(result.skipped.some((entry) => entry.path.includes("deep.sql"))).toBe(false);
    });

    it("should still walk directories when exclude matches only files", async () => {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "index.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(tempDir, "src", "seed.sql"), "SELECT 1;");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.sql"],
        ["**/*.sql"],
        1048576
      );

      expect(result.files.map((file) => path.basename(file.path))).toEqual(["index.ts"]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "src/seed.sql", reason: "excluded" }),
        ])
      );
    });

    it("selectively includes matching files below ignored parents without weakening other filters", async () => {
      for (const directory of ["generated/nested", "ignored-other", "node_modules/pkg", ".hidden", "app-build"]) {
        fs.mkdirSync(path.join(tempDir, directory), { recursive: true });
      }
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "generated/\nignored-other/\n");
      fs.writeFileSync(path.join(tempDir, "generated/nested/keep.ts"), "export const keep = true;");
      fs.writeFileSync(path.join(tempDir, "generated/nested/skip.js"), "export const skip = true;");
      fs.writeFileSync(path.join(tempDir, "generated/nested/excluded.ts"), "export const excluded = true;");
      fs.writeFileSync(path.join(tempDir, "ignored-other/unrelated.ts"), "export const unrelated = true;");
      fs.writeFileSync(path.join(tempDir, "node_modules/pkg/index.ts"), "export const dependency = true;");
      fs.writeFileSync(path.join(tempDir, ".hidden/index.ts"), "export const hidden = true;");
      fs.writeFileSync(path.join(tempDir, "app-build/index.ts"), "export const build = true;");

      const defaultResult = await collectFiles(tempDir, ["**/*.ts"], [], 1048576);
      expect(defaultResult.files).toHaveLength(0);

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        ["**/excluded.ts"],
        1048576,
        undefined,
        undefined,
        ["generated/nested/**", "ignored-other/not-this.ts", "node_modules/**", ".hidden/**", "app-build/**"],
      );

      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("generated", "nested", "keep.ts"),
      ]);

      const wildcardResult = await collectFiles(
        tempDir, ["**/*.ts"], ["**/excluded.ts"], 1048576,
        undefined, undefined, ["**/nested/**"],
      );
      expect(wildcardResult.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("generated", "nested", "keep.ts"),
      ]);

      const dotPrefixedResult = await collectFiles(
        tempDir, ["**/*.ts"], ["**/excluded.ts"], 1048576,
        undefined, undefined, ["./generated/nested/*.ts"],
      );
      expect(dotPrefixedResult.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("generated", "nested", "keep.ts"),
      ]);
    });

    it("collects selected build, vendor, hidden, and minified paths without their siblings", async () => {
      for (const directory of ["App-Build/src", "vendor", ".hidden"]) {
        fs.mkdirSync(path.join(tempDir, directory), { recursive: true });
      }
      const selected = [
        "App-Build/src/selected.ts",
        "vendor/selected.ts",
        ".hidden/selected.ts",
        "selected.min.js",
      ];
      for (const relativePath of selected) {
        fs.writeFileSync(path.join(tempDir, relativePath), "selected");
      }
      for (const relativePath of [
        "App-Build/src/sibling.ts",
        "vendor/sibling.ts",
        ".hidden/sibling.ts",
        "sibling.min.js",
      ]) {
        fs.writeFileSync(path.join(tempDir, relativePath), "sibling");
      }

      const result = await collectFiles(
        tempDir,
        ["**/*.ts", "**/*.js"],
        createDefaultExcludePatterns(),
        1048576,
        undefined,
        { maxDepth: -1, maxFilesPerDirectory: 100, includeExcluded: selected },
      );

      expect(result.files.map((file) => path.relative(tempDir, file.path)).sort()).toEqual(
        selected.map((relativePath) => path.normalize(relativePath)).sort(),
      );
    });

    it("traverses partial-wildcard parents while keeping final selection strict", async () => {
      const selected = [
        "build-tools/src/selected.ts",
        ".github/scripts/selected.ts",
        "packages/release/build-x/src/selected.ts",
        "build-cache/src/selected.ts",
        "build-output/src/selected.ts",
        "vendor/exact.ts",
      ];
      const unselected = [
        "build-tools/lib/unselected.ts",
        "build-tools/src/nested/unselected.ts",
        "build-tools/src/blocked.ts",
        ".github/workflows/unselected.ts",
        ".git/scripts/protected.ts",
        "packages/release/build-long/src/unselected.ts",
        "vendor/sibling.ts",
      ];
      for (const relativePath of [...selected, ...unselected]) {
        fs.mkdirSync(path.dirname(path.join(tempDir, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(tempDir, relativePath), relativePath);
      }

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        ["build-*/src/blocked.ts"],
        1048576,
        undefined,
        {
          maxDepth: -1,
          maxFilesPerDirectory: 100,
          includeExcluded: [
            "build-*/src/*.ts",
            ".g*/scripts/*.ts",
            "packages/release/build-?/src/*.ts",
            "build-{cache,output}/src/*.ts",
            "vendor/exact.ts",
          ],
        },
      );

      expect(result.files.map((file) => path.relative(tempDir, file.path)).sort()).toEqual(
        selected.map((relativePath) => path.normalize(relativePath)).sort(),
      );
      expect(result.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "build-tools/src/blocked.ts", reason: "excluded" }),
        expect.objectContaining({ path: ".git", reason: "excluded" }),
      ]));
    });

    it("traverses gitignored partial-wildcard parents without selecting nonmatching files", async () => {
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "generated-tools/\ngenerated-cache/\n");
      for (const relativePath of [
        "generated-tools/src/selected.ts",
        "generated-tools/src/nested/unselected.ts",
        "generated-cache/lib/unselected.ts",
      ]) {
        fs.mkdirSync(path.dirname(path.join(tempDir, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(tempDir, relativePath), relativePath);
      }

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        [],
        1048576,
        undefined,
        undefined,
        ["generated-*/src/*.ts"],
      );

      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("generated-tools", "src", "selected.ts"),
      ]);
    });

    it("traverses selected ancestors but never protected storage or supplied paths", async () => {
      for (const directory of [
        "vendor/nested",
        ".git/objects",
        ".codebase-index/index",
        ".opencode/index",
        ".claude/index",
        "protected",
      ]) {
        fs.mkdirSync(path.join(tempDir, directory), { recursive: true });
        fs.writeFileSync(path.join(tempDir, directory, "selected.ts"), "selected");
      }
      const includeExcluded = ["**/selected.ts"];
      const protectedPath = path.join(tempDir, "protected");
      const options = {
        maxDepth: -1,
        maxFilesPerDirectory: 100,
        includeExcluded,
        protectedPaths: [protectedPath],
      };

      expect(shouldTraverseDirectory(
        tempDir,
        tempDir,
        createDefaultExcludePatterns(),
        createIgnoreFilter(tempDir),
        [],
        undefined,
        { ...options, purpose: "index" },
      )).toBe(true);

      expect(shouldTraverseDirectory(
        path.join(tempDir, "vendor"),
        tempDir,
        createDefaultExcludePatterns(),
        createIgnoreFilter(tempDir),
        [],
        undefined,
        { ...options, purpose: "index" },
      )).toBe(true);

      const result = await collectFiles(
        tempDir, ["**/*.ts"], createDefaultExcludePatterns(), 1048576, undefined, options,
      );
      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("vendor", "nested", "selected.ts"),
      ]);
    });

    it("protects metadata knowledge-base roots and storage ancestors outside that root", async () => {
      const gitKnowledgeBase = path.join(tempDir, ".git");
      fs.mkdirSync(gitKnowledgeBase, { recursive: true });
      fs.writeFileSync(path.join(gitKnowledgeBase, "canary.ts"), "metadata");

      const metadataResult = await collectFiles(
        tempDir,
        ["**/*.ts"],
        createDefaultExcludePatterns(),
        1048576,
        [gitKnowledgeBase],
        { maxDepth: -1, maxFilesPerDirectory: 100, includeExcluded: ["**"] },
      );
      expect(metadataResult.files).toEqual([]);

      const storageAncestor = fs.mkdtempSync(path.join(os.tmpdir(), "files-protected-storage-"));
      try {
        const knowledgeBaseRoot = path.join(storageAncestor, "knowledge-base");
        const filePath = path.join(knowledgeBaseRoot, "canary.ts");
        fs.mkdirSync(knowledgeBaseRoot, { recursive: true });
        fs.writeFileSync(filePath, "storage");
        expect(shouldIncludeFile(
          filePath,
          knowledgeBaseRoot,
          ["**/*.ts"],
          createDefaultExcludePatterns(),
          createIgnoreFilter(knowledgeBaseRoot),
          [],
          undefined,
          { includeExcluded: ["**"], purpose: "index", protectedPaths: [storageAncestor] },
        )).toBe(false);
      } finally {
        fs.rmSync(storageAncestor, { recursive: true, force: true });
      }
    });

    it("keeps max depth, size, and per-directory limits for selected exclusions", async () => {
      fs.mkdirSync(path.join(tempDir, "vendor", "nested"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "vendor", "a.ts"), "a");
      fs.writeFileSync(path.join(tempDir, "vendor", "b.ts"), "bb");
      fs.writeFileSync(path.join(tempDir, "vendor", "large.ts"), "x".repeat(100));
      fs.writeFileSync(path.join(tempDir, "vendor", "nested", "deep.ts"), "deep");

      const result = await collectFiles(
        tempDir,
        ["**/*.ts"],
        createDefaultExcludePatterns(),
        10,
        undefined,
        {
          maxDepth: 1,
          maxFilesPerDirectory: 1,
          includeExcluded: ["vendor/**"],
        },
      );
      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("vendor", "a.ts"),
      ]);
      expect(result.skipped.some((entry) => entry.reason === "too_large")).toBe(true);
    });

    it("preserves bare Git negations for default-ignored directories with explicit empty excludes", async () => {
      fs.mkdirSync(path.join(tempDir, "vendor"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "!vendor\n!vendor/selected.ts\n");
      fs.writeFileSync(path.join(tempDir, "vendor", "selected.ts"), "selected");

      const result = await collectFiles(tempDir, ["**/*.ts"], [], 1048576);
      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("vendor", "selected.ts"),
      ]);
    });

    it("retains ordinary project sources under a private directory", async () => {
      fs.mkdirSync(path.join(tempDir, "private", "scope"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "private", "scope", "allowed.ts"), "export const allowed = true;");

      const result = await collectFiles(tempDir, ["**/*.ts"], [], 1048576);
      expect(result.files.map((file) => path.relative(tempDir, file.path))).toEqual([
        path.join("private", "scope", "allowed.ts"),
      ]);
    });
  });

  describe("hasProjectMarker", () => {
    it("should return true when .git exists", () => {
      fs.mkdirSync(path.join(tempDir, ".git"), { recursive: true });
      expect(hasProjectMarker(tempDir)).toBe(true);
    });

    it("should return true when package.json exists", () => {
      fs.writeFileSync(path.join(tempDir, "package.json"), "{}");
      expect(hasProjectMarker(tempDir)).toBe(true);
    });

    it("should return true when Cargo.toml exists", () => {
      fs.writeFileSync(path.join(tempDir, "Cargo.toml"), "[package]");
      expect(hasProjectMarker(tempDir)).toBe(true);
    });

    it("should return true when go.mod exists", () => {
      fs.writeFileSync(path.join(tempDir, "go.mod"), "module test");
      expect(hasProjectMarker(tempDir)).toBe(true);
    });

    it("should return true when pyproject.toml exists", () => {
      fs.writeFileSync(path.join(tempDir, "pyproject.toml"), "[project]");
      expect(hasProjectMarker(tempDir)).toBe(true);
    });

    it("should return true when Makefile exists", () => {
      fs.writeFileSync(path.join(tempDir, "Makefile"), "all:\n");
      expect(hasProjectMarker(tempDir)).toBe(true);
    });

    it("should return false when only .opencode exists", () => {
      fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
      expect(hasProjectMarker(tempDir)).toBe(false);
    });

    it("should return false when only .codebase-index exists", () => {
      fs.mkdirSync(path.join(tempDir, ".codebase-index"), { recursive: true });
      expect(hasProjectMarker(tempDir)).toBe(false);
    });

    it("should return false for empty directory", () => {
      expect(hasProjectMarker(tempDir)).toBe(false);
    });

    it("should return false for directory with only regular files", () => {
      fs.writeFileSync(path.join(tempDir, "readme.txt"), "hello");
      fs.writeFileSync(path.join(tempDir, "data.json"), "{}");
      expect(hasProjectMarker(tempDir)).toBe(false);
    });
  });
});
