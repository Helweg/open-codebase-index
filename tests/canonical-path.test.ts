import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalizePathForComparison } from "../src/utils/canonical-path.js";

describe("canonical path comparison", () => {
  let tempDir: string;
  let existingRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-path-test-"));
    existingRoot = path.join(tempDir, "ExistingRoot");
    fs.mkdirSync(existingRoot);
    fs.writeFileSync(path.join(existingRoot, "CaseProbe"), "probe");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("folds missing suffix casing only for confirmed case-insensitive filesystems", () => {
    const upperPath = path.join(existingRoot, "Missing", "File.ts");
    const lowerPath = path.join(existingRoot, "missing", "file.ts");

    expect(canonicalizePathForComparison(upperPath, {
      isCaseInsensitive: () => true,
    })).toBe(canonicalizePathForComparison(lowerPath, {
      isCaseInsensitive: () => true,
    }));

    expect(canonicalizePathForComparison(upperPath, {
      isCaseInsensitive: () => false,
    })).not.toBe(canonicalizePathForComparison(lowerPath, {
      isCaseInsensitive: () => false,
    }));

    expect(canonicalizePathForComparison(upperPath, {
      isCaseInsensitive: () => undefined,
    })).not.toBe(canonicalizePathForComparison(lowerPath, {
      isCaseInsensitive: () => undefined,
    }));
  });

  it("matches the host filesystem semantics for missing suffix casing", () => {
    const probePath = path.join(existingRoot, "CaseProbe");
    const alternateProbePath = path.join(existingRoot, "caseProbe");
    const hostIsCaseInsensitive = fs.existsSync(alternateProbePath)
      && fs.realpathSync.native(alternateProbePath) === fs.realpathSync.native(probePath);
    const upperPath = path.join(existingRoot, "Missing", "File.ts");
    const lowerPath = path.join(existingRoot, "missing", "file.ts");

    expect(
      canonicalizePathForComparison(upperPath) === canonicalizePathForComparison(lowerPath),
    ).toBe(hostIsCaseInsensitive);
  });

  it("matches the host filesystem semantics below an empty existing directory", () => {
    const emptyRoot = path.join(tempDir, "EmptyRoot");
    fs.mkdirSync(emptyRoot);
    const probePath = path.join(emptyRoot, "CaseProbe");
    const alternateProbePath = path.join(emptyRoot, "caseProbe");
    fs.writeFileSync(probePath, "probe");
    const hostIsCaseInsensitive = fs.existsSync(alternateProbePath)
      && fs.realpathSync.native(alternateProbePath) === fs.realpathSync.native(probePath);
    fs.unlinkSync(probePath);

    const upperPath = path.join(emptyRoot, "Missing", "File.ts");
    const lowerPath = path.join(emptyRoot, "missing", "file.ts");

    expect(
      canonicalizePathForComparison(upperPath) === canonicalizePathForComparison(lowerPath),
    ).toBe(hostIsCaseInsensitive);
    expect(fs.readdirSync(emptyRoot)).toEqual([]);
  });
});
