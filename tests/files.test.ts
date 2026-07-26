import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { collectFiles, createIgnoreFilter, shouldIncludeFile, hasProjectMarker } from "../src/utils/files.js";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from "../src/config/constants.js";

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
  });

  describe("collectFiles", () => {
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
      fs.writeFileSync(path.join(tempDir, "src/nested.js"), "nested");

      const result = await collectFiles(
        tempDir,
        ["**/*.js"],
        [],
        1048576
      );

      expect(result.files.length).toBe(2);
      expect(result.files.some((f) => f.path.endsWith("root.js"))).toBe(true);
      expect(result.files.some((f) => f.path.endsWith("nested.js"))).toBe(true);
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

    it("should return true when .opencode exists", () => {
      fs.mkdirSync(path.join(tempDir, ".opencode"), { recursive: true });
      expect(hasProjectMarker(tempDir)).toBe(true);
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
