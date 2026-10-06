import * as path from "path";

import { describe, expect, it } from "vitest";

import {
  hasFilteredPathSegment,
  isBuildPathSegment,
  isHiddenPathSegment,
  isRestrictedDirectory,
  normalizePathSeparators,
} from "../src/utils/paths.js";

describe("path helpers", () => {
  it("normalizes Windows path separators", () => {
    expect(normalizePathSeparators("src\\indexer\\index.ts")).toBe("src/indexer/index.ts");
  });

  it("detects hidden path segments without flagging dot traversals", () => {
    expect(isHiddenPathSegment(".git")).toBe(true);
    expect(isHiddenPathSegment(".")).toBe(false);
    expect(isHiddenPathSegment("..")).toBe(false);
    expect(isHiddenPathSegment("src")).toBe(false);
  });

  it.each([
    "build", "build-debug", "build_debug", "app-build", "_build",
    "cmake-build-debug", "app-build_debug", "app_build-debug", "app_build_debug",
    "BUILD", "CMake-BUILD-Debug",
  ])("detects delimited build path segment %s", (segment) => {
    expect(isBuildPathSegment(segment)).toBe(true);
  });

  it.each([
    "src", "clap_builder", "builder", "rebuilding", "rebuild",
    "build.gradle", "build.rs", "rebuild.ts", "app.build", "buildcache", "AppBuild",
  ])("preserves non-build path segment %s", (segment) => {
    expect(isBuildPathSegment(segment)).toBe(false);
  });

  it("detects filtered segments across a relative path", () => {
    expect(hasFilteredPathSegment(`src${path.sep}.git${path.sep}config`)).toBe(true);
    expect(hasFilteredPathSegment(`src${path.sep}cmake-build-debug${path.sep}index.ts`)).toBe(true);
    expect(hasFilteredPathSegment(`src${path.sep}watcher${path.sep}index.ts`)).toBe(false);
    expect(hasFilteredPathSegment("clap_builder/src/build.rs", "/")).toBe(false);
    expect(hasFilteredPathSegment("rebuild/build.gradle", "/")).toBe(false);
  });

  it("detects restricted OS directories in first path segment", () => {
    expect(isRestrictedDirectory("Library/Containers/uuid", "/")).toBe(true);
    expect(isRestrictedDirectory("library/Preferences", "/")).toBe(true);
    expect(isRestrictedDirectory("Applications/App.app", "/")).toBe(true);
    expect(isRestrictedDirectory("System/Library", "/")).toBe(true);
    expect(isRestrictedDirectory("Volumes/Disk", "/")).toBe(true);
    expect(isRestrictedDirectory("private/var", "/")).toBe(true);
    expect(isRestrictedDirectory("cores/core.1234", "/")).toBe(true);
    // Linux
    expect(isRestrictedDirectory("proc/1/status", "/")).toBe(true);
    expect(isRestrictedDirectory("sys/class", "/")).toBe(true);
    // Windows
    expect(isRestrictedDirectory("Windows\\System32", "\\")).toBe(true);
    expect(isRestrictedDirectory("ProgramData\\App", "\\")).toBe(true);
    // Non-restricted paths
    expect(isRestrictedDirectory("src/Library/thing", "/")).toBe(false);
    expect(isRestrictedDirectory("node_modules/lib", "/")).toBe(false);
    expect(isRestrictedDirectory("dist/index.js", "/")).toBe(false);
    expect(isRestrictedDirectory("", "/")).toBe(false);
  });
});
